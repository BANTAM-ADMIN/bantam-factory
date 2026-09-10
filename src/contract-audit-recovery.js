// An independent model review supplies hypotheses, never an execution proof.
// Ordinary turn checks predating the review cannot discharge it. The explicit
// controller station can execute after a new review on the same turn; only its
// nested receipts establish that ordering, never an unrelated turn-level pass.
import { parse } from "acorn";
import crypto from "node:crypto";
import path from "node:path";
import { splitShellWords, shellSegments } from "./shell-lex.js";
import { verificationShellStatusRisk } from "./verification-evidence.js";
import { projectProbeEvidence } from "./probe-evidence.js";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { parseAssertionSpec, buildAssertionProbe } from "./contract-assertion-spec.js";

const HASH = /^[a-f0-9]{64}$/;
const SOURCES = new Set(["shell", "automatic", "scoped", "landing", "completion"]);
export const VERIFICATION_RECEIPTS_SCHEMA = "bantam.verification-receipts.v1";
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const badFlags = value => ["blocked", "invalidated", "interrupted", "aborted", "timedOut", "bufferExceeded", "error", "signal", "uncertainty"].some(key => Boolean(value?.[key]));

import { recordedCommandText, sameRecordedCommand, canonicalAuditCommand, sameAuditCommand,
  wordsForDirectCommand, sameCommand, sameConfiguredExecution, isConfiguredAuditCommand } from "./verification-command.js";
export { canonicalAuditCommand, sameAuditCommand, isConfiguredAuditCommand } from "./verification-command.js";

// Recognition only: never rewrite or re-execute a shell program. A successful
// `cd EXACT_WORKSPACE && DIRECT` has the direct child's status, but only if the
// controller's actual cwd and complete execution receipt bind that workspace.
// No relative paths, substitutions, setup programs, extra operators or masks.
export function workspacePrefixedCommand(command, workspace, cwd) {
  command = recordedCommandText(command);
  if (typeof workspace !== "string" || !path.posix.isAbsolute(workspace)
      || path.posix.normalize(workspace) !== workspace || cwd !== workspace
      || typeof command !== "string" || !/^cd[ \t]+/.test(command)) return null;
  let quote = null, separator = -1;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "&" && command[i + 1] === "&") { separator = i; break; }
  }
  if (separator < 0) return null;
  const prefix = command.slice(0, separator), direct = recordedCommandText(command.slice(separator + 2));
  if (/[\\$`\r\n\0*?\[\]{}]/.test(prefix)) return null;
  const words = wordsForDirectCommand(prefix);
  if (!words || words[0] !== "cd") return null;
  const target = words.length === 2 ? words[1] : words.length === 3 && words[1] === "--" ? words[2] : null;
  return target === workspace && wordsForDirectCommand(direct) ? direct : null;
}

function commandForAuditReceipt(proof, shell, workspace) {
  const receipt = proof ?? shell;
  const command = receipt.statusCommand ?? receipt.executedCommand ?? receipt.command;
  const executed = receipt.executedCommand ?? receipt.command;
  // A claimed whole-execution status cannot silently select a different command.
  if (proof?.statusScope === "execution" && command !== executed) return null;
  if (wordsForDirectCommand(command)) return command;
  if (!shell || (proof && (proof.statusScope !== "execution" || proof.source !== "shell"
      || !sameRecordedCommand(proof.command, shell.command) || proof.executedCommand !== shell.executedCommand
      || (proof.cwd != null && proof.cwd !== shell.cwd)))
      || command !== shell.executedCommand) return null;
  return workspacePrefixedCommand(command, workspace, shell.cwd);
}

function nodeTestTargets(args) {
  const targets = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    // The executor injects a timeout; Node's own name filter selects a focused
    // case, unlike an output pipe which can hide its status. Require a concrete
    // test file as well, and execution-backed nonzero counts below.
    if (/^--test-timeout=\d+$/.test(arg)) continue;
    if (/^--test-name-pattern=.+$/.test(arg)) continue;
    if (arg === "--test-name-pattern") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) return [];
      index++;
      continue;
    }
    targets.push(arg);
  }
  return targets;
}

// This is an execution-shape gate, not proof that a test asserts the right
// contract. Inline JavaScript must contain an actual assertion call bound to
// node:assert; a log string saying "assert" is not enough. No code is executed.
function inlineNodeAssertion(source) {
  if (typeof source !== "string" || source.length > 16000) return false;
  let tree;
  try { tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }); }
  catch { return false; }
  const bindings = new Set(), awaitedNamespaces = new Set(), calls = [];
  const synchronousMethods = new Set(["ok", "equal", "notEqual", "strictEqual", "notStrictEqual", "deepEqual", "notDeepEqual",
    "deepStrictEqual", "notDeepStrictEqual", "throws", "doesNotThrow", "ifError", "match", "doesNotMatch", "fail"]);
  let nodes = 0, incomplete = false;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object") return;
    if (++nodes > 4096 || depth > 64) { incomplete = true; return; }
    if (node.type === "ImportDeclaration" && /^(?:node:)?assert(?:\/strict)?$/.test(node.source.value)) {
      for (const spec of node.specifiers) if (spec.local?.name) bindings.add(spec.local.name);
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
        && node.init?.type === "CallExpression" && node.init.callee?.name === "require"
        && /^(?:node:)?assert(?:\/strict)?$/.test(node.init.arguments[0]?.value ?? "")) bindings.add(node.id.name);
    // Await the literal builtin import before binding its namespace. A Promise,
    // computed module name, or a string mentioning assert is not that binding.
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
        && node.init?.type === "AwaitExpression" && node.init.argument?.type === "ImportExpression"
        && node.init.argument.source?.type === "Literal"
        && /^(?:node:)?assert(?:\/strict)?$/.test(node.init.argument.source.value ?? "")) awaitedNamespaces.add(node.id.name);
    if (node.type === "CallExpression") calls.push(node.callee);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, depth + 1));
      else if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(tree);
  return !incomplete && calls.some(callee => callee?.type === "Identifier" ? bindings.has(callee.name)
    : callee?.type === "MemberExpression" && (bindings.has(callee.object?.name)
      || (awaitedNamespaces.has(callee.object?.name) && synchronousMethods.has(callee.computed
        ? callee.property?.type === "Literal" ? callee.property.value : null : callee.property?.name))));
}

export function isFocusedAuditCommand(command, configured = null) {
  if (configured && sameConfiguredExecution(command, configured)) return false;
  const words = wordsForDirectCommand(command);
  if (!words) return false;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  if (!words.length) return false;
  const executable = words[0].split("/").at(-1), args = words.slice(1);
  if (args.some(arg => /^(?:--help|--version|-h|-V|--list-tests|--collect-only|--check|--print|-p|-c)$/.test(arg))
      && !/^python(?:3(?:\.\d+)?)?$/.test(executable)) return false;
  // A file path, not a directory/glob or a broad package-script invocation.
  const concreteFile = arg => !/[$*?\[\]{}]/.test(arg) && /\.(?:[cm]?js|ts|py|rb)$/.test(arg);
  if (/^(?:node|nodejs)$/.test(executable)) {
    const inline = args.findIndex(arg => arg === "-e" || arg === "--eval");
    if (inline >= 0) return typeof args[inline + 1] === "string" && inlineNodeAssertion(args[inline + 1]);
    if (args[0] === "--test") {
      const targets = nodeTestTargets(args);
      return targets.length > 0 && targets.every(concreteFile);
    }
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(executable) && args[0] === "-c") {
    // Deliberately bounded to ordinary assertion statements, not eval/print.
    return /(?:^|\n|;)\s*assert\s+[^\s]/.test(args[1] ?? "");
  }
  if (/^(?:pytest|py\.test)$/.test(executable)) return args.some(arg => concreteFile(arg.split("::")[0]));
  if (/^(?:node|nodejs|python(?:3(?:\.\d+)?)?|ruby)$/.test(executable)) {
    const script = args[0];
    return Boolean(script && concreteFile(script)
      && /(?:^|[\/_.-])(?:tests?|checks?|verify|verification|witness|probe|assert|regress(?:ion)?|edges?|boundary)(?:[\/_.-]|$)/i.test(script));
  }
  return false;
}

function validReceipt(receipt, generation, { verification = false } = {}) {
  return record(receipt) && Number.isSafeInteger(generation) && generation >= 0
    && receipt.generation === generation && receipt.exitCode === 0 && !badFlags(receipt)
    && HASH.test(receipt.outputSha256 ?? "")
    && (!verification || (receipt.schema === 1 && SOURCES.has(receipt.source) && receipt.status === "pass"
      && !(receipt.counts?.failed > 0) && receipt.counts?.total !== 0));
}

const digest = value => crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex");
const probeDigest = value => `sha256:${digest(value)}`;
function sourcePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\\\0:]/.test(value) && !path.posix.isAbsolute(value) && value !== "."
    && path.posix.normalize(value) === value && !value.startsWith("../");
}
function sourceMap(sources) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 16) return null;
  const map = new Map();
  for (const source of sources) {
    if (!record(source) || !sourcePath(source.path) || !HASH.test(source.sha256 ?? "") || map.has(source.path)) return null;
    map.set(source.path, source.sha256);
  }
  return map;
}

// This validates controller-owned receipt linkage, not the authenticity of a
// foreign log or the semantic completeness of a model-designed assertion.
function validContractAssertion(station, audit, generation) {
  try {
    if (!record(station) || station.schema !== "bantam.contract-assertion.v1"
        || station.status !== "assertion_passed" || badFlags(station)
        || !Number.isSafeInteger(generation) || generation < 0
        || station.generation !== generation || audit.generation !== generation
        || !HASH.test(station.auditPromptSha256 ?? "") || station.auditPromptSha256 !== audit.promptSha256
        || !HASH.test(station.promptSha256 ?? "") || !HASH.test(station.taskSha256 ?? "")
        || station.taskSha256 !== audit.taskSha256) return false;
    const sources = sourceMap(station.sources), audited = sourceMap(audit.sources);
    if (!sources || !audited || sources.size !== audited.size
        || [...sources].some(([file, hash]) => audited.get(file) !== hash)) return false;
    const spec = parseAssertionSpec(JSON.stringify(station.spec), { sourcePaths: [...sources.keys()] });
    if (!spec || !sources.has(spec.module) || digest(spec) !== station.specSha256) return false;
    const inputs = station.inputs;
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) return false;
    const seen = new Map();
    let bytes = 0;
    for (const input of inputs) {
      if (!record(input) || !sourcePath(input.p) || seen.has(input.p) || !HASH.test(input.sha256 ?? "")
          || !Number.isSafeInteger(input.size) || input.size < 0
          || !Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 511) return false;
      seen.set(input.p, input.sha256); bytes += input.size;
    }
    if (bytes > 2 * 1024 * 1024 || [...sources].some(([file, hash]) => seen.get(file) !== hash)) return false;
    const inputDigest = probeDigest(inputs);
    if (station.inputDigest !== inputDigest || typeof station.question !== "string"
        || !station.question.trim() || station.question.length > 2000) return false;
    const action = buildAssertionProbe(spec, { inputs: inputs.map(({ p }) => ({ p })), question: station.question });
    const specification = probeDigest(action), probe = station.probeEvidence;
    if (station.probeSpecDigest !== specification || !record(probe)
        || probe.specDigest !== specification || probe.question !== station.question
        || probe.sourceDigest !== inputDigest || probe.sourceAfterDigest !== inputDigest || probe.sourceAfterError != null
        || canonicalEncode(probe.inputs) !== canonicalEncode(inputs)
        || !Array.isArray(probe.stages) || probe.stages.length !== 3) return false;
    for (const [index, phase] of ["setup", "witness", "check"].entries()) {
      const stage = probe.stages[index];
      if (!record(stage) || stage.stage !== phase || stage.command !== action[phase]
          || stage.commandDigest !== probeDigest(action[phase])
          || typeof stage.stdout !== "string" || stage.stdout.length > 262144
          || typeof stage.stderr !== "string" || stage.stderr.length > 262144
          || stage.stdoutDigest !== probeDigest(stage.stdout) || stage.stderrDigest !== probeDigest(stage.stderr)) return false;
    }
    return projectProbeEvidence(probe).status === "assertion_passed";
  } catch { return false; }
}

function validStationProject(proof, generation, configured, workspaceReadOnly) {
  if (!configured || !validReceipt(proof, generation, { verification: true })
      || proof.statusScope !== "execution" || !sameCommand(proof.command, configured)
      || !sameConfiguredExecution(proof.executedCommand, configured) || proof.statusCommand !== proof.executedCommand
      || (typeof workspaceReadOnly === "boolean" && proof.workspaceReadOnly !== workspaceReadOnly)) return false;
  if (proof.counts != null && (!record(proof.counts)
      || !["passed", "failed", "total"].every(key => Number.isSafeInteger(proof.counts[key]) && proof.counts[key] >= 0)
      || proof.counts.total < 1 || proof.counts.failed !== 0 || proof.counts.passed !== proof.counts.total)) return false;
  return true;
}

// This envelope is written only by the controller at actual execution
// completion, never reconstructed from action text, cached proofs or model
// claims. Its sequence is local to the recorded turn. It is not authentication
// of an arbitrary foreign log. Bare arrays/legacy aliases establish no order.
function orderedTurnReceipts(turn, index) {
  const envelope = turn.verificationReceipts;
  if (!record(envelope) || envelope.schema !== VERIFICATION_RECEIPTS_SCHEMA
      || envelope.authority !== "controller-execution-order" || envelope.turn !== index
      || !Array.isArray(envelope.entries) || envelope.entries.length < 1 || envelope.entries.length > 16) return null;
  const entries = envelope.entries;
  if (entries.some((entry, sequence) => !record(entry) || entry.sequence !== sequence
      || !Object.hasOwn(entry, "verificationEvidence") || !Object.hasOwn(entry, "shellExecution")
      || (entry.verificationEvidence !== null && !record(entry.verificationEvidence))
      || (entry.shellExecution !== null && !record(entry.shellExecution))
      || (!entry.verificationEvidence && !entry.shellExecution))) return null;
  // Old readers still use these aliases. A contradictory alias (including an
  // invalidation/failure) must not disappear merely because an envelope exists.
  try {
    for (const key of ["verificationEvidence", "shellExecution"]) {
      if (turn[key] != null && !entries.some(entry => entry[key] != null
          && canonicalEncode(entry[key]) === canonicalEncode(turn[key]))) return null;
    }
  } catch { return null; }
  return entries;
}

function orderedReceiptCommand(proof, shell, { generation, workspace }) {
  if ((proof && !validReceipt(proof, generation, { verification: true }))
      || (shell && !validReceipt(shell, generation))) return null;
  if (proof && (proof.statusScope !== "execution" || proof.statusCommand !== proof.executedCommand)) return null;
  if (proof?.source === "shell" && !shell) return null;
  if (proof && shell && (!sameRecordedCommand(proof.command, shell.command)
      || ["executedCommand", "generation", "exitCode", "cwd", "workspaceReadOnly", "sandbox"]
        .some(key => (proof[key] ?? null) !== (shell[key] ?? null)))) return null;
  if (workspace != null && [proof, shell].filter(Boolean).some(receipt => receipt.cwd !== workspace)) return null;
  if (proof?.counts != null && (!record(proof.counts)
      || !["passed", "failed", "total"].every(key => Number.isSafeInteger(proof.counts[key]) && proof.counts[key] >= 0)
      || proof.counts.failed !== 0 || proof.counts.total < 1 || proof.counts.passed < 1
      || proof.counts.passed > proof.counts.total || proof.countsScope !== "single-execution")) return null;
  const command = commandForAuditReceipt(proof, shell, workspace);
  // A successful Node test launcher may discover no cases. In this new ordered
  // path retain measured execution counts, not merely the launcher's exit zero.
  const words = wordsForDirectCommand(command);
  while (words && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  if (words && /^(?:node|nodejs)$/.test(words[0]?.split("/").at(-1) ?? "")
      && words[1] === "--test" && !(proof?.counts?.passed > 0)) return null;
  return command;
}

// Diagnostic context only. Validate historical receipts at their own generation
// to explain why a formerly successful check is now stale; never credit it in
// the current-generation acceptance calculation below.
function staleFocusedCheck(turns, auditIndex, generation, configured, workspace) {
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  let prior = null;
  for (let index = auditIndex + 1; index < turns.length; index++) {
    const turn = turns[index];
    if (!turn || turn.controllerStop || turn.shellScopeRollback?.violations?.length || turn.contractAssertion) continue;
    const entries = Object.hasOwn(turn, "verificationReceipts") ? orderedTurnReceipts(turn, index)
      : turn.verificationEvidence || turn.shellExecution ? [turn] : null;
    for (const entry of entries ?? []) {
      const proof = entry.verificationEvidence, shell = entry.shellExecution;
      const oldGeneration = (proof ?? shell)?.generation;
      if (!Number.isSafeInteger(oldGeneration) || oldGeneration < 0 || oldGeneration >= generation) continue;
      const command = orderedReceiptCommand(proof, shell, { generation: oldGeneration, workspace });
      if (command && isFocusedAuditCommand(command, configured)) prior = { command, generation: oldGeneration, turn: index };
    }
  }
  if (!prior) return null;
  const changed = new Set(), latest = new Map();
  for (const turn of turns.slice(prior.turn + 1)) {
    const paths = turn?.sourceEditedByShell === true && Array.isArray(turn.shellChangedPaths) ? [...turn.shellChangedPaths] : [];
    if (turn?.editApplied === true) paths.push(turn.parsedAction?.p);
    for (const file of paths) if (sourcePath(file) && !/[\x00-\x1f\x7f]/.test(file)) changed.add(file);
    for (const file of changed) if (Object.hasOwn(turn?.workspaceCoherence?.fingerprints ?? {}, file)) {
      latest.set(file, turn.workspaceCoherence.fingerprints[file]);
    }
  }
  const changedPaths = [...changed].slice(0, 6);
  return { ...prior, changedPaths, removedPaths: changedPaths.filter(file => latest.get(file) === "missing") };
}

// Advice only, never an execution witness. Repeated actual failed/opaque Node
// checks suggest switching transport to a retained file and a direct launcher.
// Do not infer attempts from the worker's action, prose, or a forged alias.
function focusedCheckRecovery(turns, auditIndex, generation, workspace) {
  let attempts = 0;
  for (let index = Math.max(auditIndex + 1, turns.length - 64); index < turns.length; index++) {
    const turn = turns[index];
    if (!turn || turn.controllerStop || turn.shellScopeRollback?.violations?.length) continue;
    const entries = Object.hasOwn(turn, "verificationReceipts") ? orderedTurnReceipts(turn, index)
      : turn.shellExecution ? [turn] : null;
    for (const entry of entries ?? []) {
      const proof = entry.verificationEvidence, shell = entry.shellExecution;
      if (!record(shell) || shell.generation !== generation || !Number.isSafeInteger(generation)
          || generation < 0 || !Number.isInteger(shell.exitCode) || shell.exitCode < 0 || shell.exitCode >= 125
          || badFlags(shell) || !HASH.test(shell.outputSha256 ?? "")
          || (workspace != null && shell.cwd !== workspace)
          || typeof shell.executedCommand !== "string" || shell.executedCommand.length > 16000) continue;
      if (proof && (proof.schema !== 1 || proof.source !== "shell" || !["pass", "fail", "unverified"].includes(proof.status)
          || !HASH.test(proof.outputSha256 ?? "") || !sameRecordedCommand(proof.command, shell.command)
          || ["executedCommand", "generation", "exitCode", "cwd", "workspaceReadOnly", "sandbox"]
            .some(key => (proof[key] ?? null) !== (shell[key] ?? null))
          || ["blocked", "invalidated", "interrupted", "aborted", "timedOut", "bufferExceeded", "error", "signal"]
            .some(key => Boolean(proof[key])))) continue;
      // A successful process can still have an unrecognized assertion shape.
      // Count that as a transport/admission attempt, not as accepted proof.
      if (shell.exitCode === 0 && verificationShellStatusRisk(shell.executedCommand) === null
          && isFocusedAuditCommand(shell.executedCommand) && (!proof || proof.status === 'pass')) continue;
      const segments = shellSegments(shell.executedCommand);
      if (segments.length > 128 || !segments.some(segment => {
        const words = splitShellWords(segment);
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
        return /^(?:node|nodejs)$/.test(words[0]?.split("/").at(-1) ?? "")
          && (words.slice(1).some(word => /^(?:--test|--eval|-e)$/.test(word))
            || isFocusedAuditCommand(segment));
      })) continue;
      if (++attempts >= 2) return "standalone-node-file";
    }
  }
  return null;
}

// Context only: distinguish actual process execution from proof admission.
// Never recover acceptance from printed PASS, a proposed command, or raw prose.
function focusedAdmissionDiagnostic(turns, auditIndex, generation, configured, workspace) {
  for (let index = turns.length - 1; index > Math.max(auditIndex, turns.length - 65); index--) {
    const turn = turns[index];
    if (!turn || turn.controllerStop || turn.shellScopeRollback?.violations?.length) continue;
    const entries = Object.hasOwn(turn, 'verificationReceipts') ? orderedTurnReceipts(turn, index)
      : turn.shellExecution ? [turn] : null;
    for (const entry of [...(entries ?? [])].reverse()) {
      const shell = entry.shellExecution, proof = entry.verificationEvidence;
      if (!record(shell) || shell.generation !== generation || shell.cwd !== workspace
          || badFlags(shell) || shell.cached || !HASH.test(shell.outputSha256 ?? '')
          || !Number.isInteger(shell.exitCode) || shell.exitCode < 0 || shell.exitCode >= 125
          || typeof shell.command !== 'string' || typeof shell.executedCommand !== 'string'
          || shell.executedCommand.length > 16000) continue;
      if (proof && (proof.schema !== 1 || proof.source !== 'shell'
          || !['pass','fail','unverified'].includes(proof.status) || !HASH.test(proof.outputSha256 ?? '')
          || !sameRecordedCommand(proof.command, shell.command)
          || ['executedCommand','generation','exitCode','cwd','workspaceReadOnly','sandbox']
            .some(k => (proof[k] ?? null) !== (shell[k] ?? null))
          || ['blocked','invalidated','timedOut','interrupted','aborted','bufferExceeded','error','signal','cached'].some(k => proof[k]))) continue;
      const requested = wordsForDirectCommand(shell.command), words = wordsForDirectCommand(shell.executedCommand);
      const nodeAttempt = shellSegments(shell.executedCommand).some(segment => {
        const w = splitShellWords(segment);
        return /^(?:node|nodejs)$/.test(w[0]?.split('/').at(-1) ?? '')
          && w.slice(1).some(s => ['-e','--eval','--test'].includes(s) || /\.[cm]?js$/.test(s));
      });
      if (!nodeAttempt && !isFocusedAuditCommand(shell.executedCommand, configured)) continue;
      if (configured && sameConfiguredExecution(shell.executedCommand, configured)) continue;
      const admitted = orderedReceiptCommand(proof, shell, { generation, workspace });
      let reason;
      if (shell.exitCode !== 0 || proof?.status === 'fail') reason = 'execution-failed';
      else if (!words || !requested || verificationShellStatusRisk(shell.executedCommand)) reason = 'non-direct-or-status-opaque';
      else if (words.some(w => w === '-e' || w === '--eval') && !isFocusedAuditCommand(shell.executedCommand, configured)) reason = 'inline-assertion-not-recognized';
      else if (!admitted || !isFocusedAuditCommand(admitted, configured)) reason = 'execution-evidence-incomplete';
      else return null; // most recent attempt is already recognized; do not replay an older rejection
      return { schema: 1, generation, turn: index, exitCode: shell.exitCode,
        outputSha256: shell.outputSha256, admission: 'not-admitted', reason };
    }
  }
  return null;
}

// Locate a small existing authored check from CURRENT bytes, not filenames
// mentioned in a model note. This is a launcher suggestion, never a coverage
// claim or verification receipt. It does not execute/import candidate code.
export function existingFocusedCheck(paths, readSource, { generation } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0 || typeof readSource !== 'function') return null;
  for (const p of [...new Set(Array.isArray(paths) ? paths : [])].reverse().slice(0,16)) {
    if (typeof p !== 'string' || p.length > 240 || !/^[\w./-]+\.[cm]?js$/.test(p)
        || p.startsWith('/') || p.split('/').includes('..')) continue;
    try {
      const source = readSource(p);
      if (typeof source !== 'string' || Buffer.byteLength(source) > 32000 || !inlineNodeAssertion(source)) continue;
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
      const imports = ast.body.filter(n => n.type === 'ImportDeclaration').map(n => n.source.value);
      // Require a literal local subject import. Unknown dynamic/CJS layouts
      // fall back to a minimal witness; never guess their entrypoint.
      if (!imports.some(s => /^\.{1,2}\//.test(s))) continue;
      const nodeTest = imports.some(s => /^(?:node:)?test$/.test(s));
      const command = `node ${nodeTest ? '--test ' : ''}${p}`;
      if (!isFocusedAuditCommand(command)) continue;
      return { schema: 1, generation, path: p, command,
        sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
        authority: 'current-source-launcher-hint', verified: false };
    } catch { /* Missing, changed, unparsable or unbounded sources supply no hint. */ }
  }
  return null;
}

function evaluateContractAudit(turns = [], { generation, configuredCommand = null, verificationWorkspaceReadOnly = null, workspace = null } = {}) {
  let auditIndex = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    const audit = turns[index]?.contractStateAudit;
    if (audit?.focus === "collection-preconditions" && audit.status === "report") {
      auditIndex = index;
      break;
    }
  }
  if (auditIndex < 0) return { pending: null, witness: null };
  const audit = turns[auditIndex].contractStateAudit;
  const configured = String(configuredCommand ?? "").trim();
  let focusedTurn = null, projectTurn = null, focusedOrder = null, projectOrder = null, order = 0;
  let focusedWitness = null, projectWitnessValid = false, invalidatedAfterTurn = null;
  // Additional passing checks on this same generation do not revoke an
  // already ordered, execution-backed pair. Failures, unknown receipts and
  // generation changes still clear credit before reaching this predicate.
  let completedPair = null;
  const rememberPair = () => {
    completedPair = focusedTurn !== null && projectTurn !== null
      && projectOrder > focusedOrder && projectWitnessValid ? {witness: focusedWitness} : null;
  };
  const clear = (index = auditIndex) => {
    if (focusedTurn !== null || projectTurn !== null) invalidatedAfterTurn = index;
    focusedTurn = projectTurn = focusedOrder = projectOrder = null;
    focusedWitness = null; projectWitnessValid = false;
    completedPair = null;
  };
  for (let index = auditIndex; index < turns.length; index++) {
    const turn = turns[index];
    if (turn?.contractAssertion) {
      const station = turn.contractAssertion;
      clear(index);
      if (!turn.controllerStop && !turn.shellScopeRollback?.violations?.length
          && validContractAssertion(station, audit, generation)) {
        focusedTurn = index;
        focusedOrder = order++;
        if (validStationProject(station.projectVerification, generation, configured, verificationWorkspaceReadOnly)) {
          projectTurn = index;
          projectOrder = order++;
          projectWitnessValid = true;
          rememberPair();
        }
      }
      // The ordinary action/proof on this turn precedes the station. Only the
      // controller's nested project receipt establishes post-assertion order.
      continue;
    }
    if (index === auditIndex) continue;
    if (turn && Object.hasOwn(turn, "verificationReceipts")) {
      const entries = orderedTurnReceipts(turn, index);
      if (!entries || turn.controllerStop || turn.shellScopeRollback?.violations?.length) { clear(index); continue; }
      for (const entry of entries) {
        const at = order++, proof = entry.verificationEvidence, shell = entry.shellExecution;
        const command = orderedReceiptCommand(proof, shell, { generation, workspace });
        if (!command) { clear(index); continue; }
        if (isFocusedAuditCommand(command, configured)) {
          focusedTurn = index; focusedOrder = at;
          focusedWitness = { command, turn: index, generation };
        }
        if (proof && configured && sameConfiguredExecution(command, configured)) {
          const controller = proof.source !== "shell";
          if ((proof.configuredCommand !== configured && (controller || proof.configuredCommand != null))
              || (controller && (!sameCommand(proof.command, configured) || !sameConfiguredExecution(proof.executedCommand, configured)))
              || (controller && typeof verificationWorkspaceReadOnly === "boolean"
                && proof.workspaceReadOnly !== verificationWorkspaceReadOnly)) { clear(index); continue; }
          projectTurn = index; projectOrder = at; projectWitnessValid = true;
          rememberPair();
        }
      }
      continue;
    }
    const proof = turn?.verificationEvidence;
    const shell = turn?.shellExecution;
    if (!proof && !shell) continue;
    // Typed failure, invalidation, or unknown provenance wins over a parallel
    // success field and clears earlier credit. Never fall back to shell prose.
    if (turn.controllerStop || turn.shellScopeRollback?.violations?.length
        || (proof && !validReceipt(proof, generation, { verification: true }))
        || (shell && !validReceipt(shell, generation))) {
      clear(index);
      continue;
    }
    const command = commandForAuditReceipt(proof, shell, workspace);
    if (!command) { clear(index); continue; }
    const at = order++;
    const nameFiltered = wordsForDirectCommand(command)?.some(word => /^--test-name-pattern(?:=|$)/.test(word));
    // A zero-match filtered run can exit zero. It proves no assertion ran and
    // must not clear the review; absent counts are unknown, not success.
    const observedFilteredCase = !nameFiltered || (proof?.counts?.passed > 0 && proof.counts.failed === 0);
    if ((!proof || proof.statusScope === "execution") && observedFilteredCase
        && isFocusedAuditCommand(command, configured)) {
      focusedTurn = index; focusedOrder = at;
      // Preserve legacy acceptance semantics, but do not protect a script on
      // weaker legacy aliases than the current ordered execution path permits.
      focusedWitness = orderedReceiptCommand(proof, shell, { generation, workspace }) === command
        ? { command, turn: index, generation } : null;
    }
    if (proof && configured && sameConfiguredExecution(command, configured)) {
      projectTurn = index; projectOrder = at;
      const controller = proof.source !== "shell";
      projectWitnessValid = orderedReceiptCommand(proof, shell, { generation, workspace }) === command
        && (proof.configuredCommand === configured || (!controller && proof.configuredCommand == null))
        && (!controller || (sameCommand(proof.command, configured) && sameConfiguredExecution(proof.executedCommand, configured)))
        && (!controller || typeof verificationWorkspaceReadOnly !== "boolean"
          || proof.workspaceReadOnly === verificationWorkspaceReadOnly);
      rememberPair();
    }
  }
  const projectAfterFocused = projectTurn !== null && focusedTurn !== null
    && projectOrder > focusedOrder;
  if (completedPair) return {pending: null, witness: completedPair.witness};
  if (focusedTurn !== null && (!configured || projectAfterFocused)) {
    return { pending: null, witness: focusedWitness && (!configured || projectWitnessValid) ? focusedWitness : null };
  }
  return { pending: { turn: auditIndex, promptSha256: audit.promptSha256 ?? null,
    report: String(audit.report ?? ""), sources: audit.sources ?? [], focusedTurn, projectTurn,
    configuredCommand: configured || null,
    ...(invalidatedAfterTurn !== null ? { invalidatedAfterTurn } : {}),
    ...(focusedTurn === null ? { admissionDiagnostic: focusedAdmissionDiagnostic(turns, auditIndex, generation, configured, workspace) } : {}),
    staleFocus: focusedTurn === null ? staleFocusedCheck(turns, auditIndex, generation, configured, workspace) : null,
    focusedCheckRecovery: focusedTurn === null ? focusedCheckRecovery(turns, auditIndex, generation, workspace) : null,
    generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : null,
    needsFocused: focusedTurn === null,
    needsProject: Boolean(configured && !projectAfterFocused),
    missing: [...(focusedTurn === null ? ["focused-execution"] : []),
      ...(configured && !projectAfterFocused ? ["project-verification"] : [])] }, witness: null };
}

export function pendingContractAudit(turns = [], options = {}) {
  return evaluateContractAudit(turns, options).pending;
}

// A narrow locator for an ordinary receipt-backed focused check after its
// required project verification. This is not completion authority, a proof of
// the check's semantics, or permission to execute its command. Station-only
// assertions have no ordinary workspace witness to protect and return null.
export function currentFocusedAuditWitness(turns = [], options = {}) {
  return evaluateContractAudit(turns, options).witness;
}

export function contractAuditRecoveryNote(pending) {
  if (!pending) return "";
  const configured = typeof pending.configuredCommand === "string" ? pending.configuredCommand : null;
  if (pending.needsFocused === false && pending.needsProject === true && configured
      && Number.isSafeInteger(pending.focusedTurn) && pending.focusedTurn >= 0) {
    return `[contract-audit-recovery] Focused assertion accepted at turn ${pending.focusedTurn + 1} for generation ${pending.generation ?? "unknown"}. Only project-verification remains.\n`
      + `Next action: execute exactly this configured project command:\n${configured}\n`
      + "Do not repeat the focused check or emit DONE yet. Another runner, selector or package script is not interchangeable with this configured command, even if its output looks equivalent. Do not append echoed status, filters or other shell commands.";
  }
  const report = String(pending.report ?? "");
  const stale = pending.staleFocus;
  const brief = value => String(value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  const staleNote = stale ? `Workspace changed since the successful focused check (generation ${stale.generation} -> ${pending.generation}): ${brief(stale.changedPaths?.map(file => `${file}${stale.removedPaths?.includes(file) ? " (removed)" : ""}`).join(", ") || "changed source generation")}. Earlier ${JSON.stringify(brief(stale.command))} is stale, not current proof. Keep intended check scripts; recreate a removed check or use a fresh direct assertion. Finish cleanup BEFORE final focused/project verification; DONE requires the unchanged verified tree.\n` : "";
  return `[contract-audit-recovery] ${staleNote}Next: assert the current diagnostic; missing ${pending.missing?.join(" + ") || "current executable evidence"}. An observed task-valid failure outranks the unverified audit hypothesis. Test the actual API or real CLI (Node: spawnSync(process.execPath,[entry,...args]); entry is the subject CLI, NOT this check); assert child.status and output against the public contract. Run the focused launcher directly${configured ? `, then exactly: ${configured}` : ""}. No echoes or filters.\n`
    + "Replace console.log(condition) with assert.ok(condition) or assert.deepEqual(actual, expected), bound to node:assert/strict and the actual public API result. Printouts and earlier broad green suites are not assertions. Create/repair the check separately; launch directly without setup, filters or status-printing suffixes.\n"
    + "Establish one valid-path case first with writable temporary fixtures and public-contract expectations. Assert actual output. Fix a demonstrated implementation/fixture defect before zero-work or other boundary cases; establish that case and its launcher before scaling a fuzz run.\n"
    + "For a Node CLI, derive entry from the subject's actual CLI entrypoint, NOT the diagnostic's import.meta.url or process.argv[1]. Use spawnSync(process.execPath, [entry, ...args], {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'}), with a task-appropriate finite timeout. Assert exit and stdout/stderr: assert.equal(child.status, expectedStatus, child.stderr). A timeout is not a pass. Do not simulate the CLI by changing process.argv in node -e. Other CLIs require their actual runtime; derive arguments/expectations from the task.\n"
    + "Accepted launch shapes: `node --test test/edge.test.js`, `node check-api.mjs`, `python check_api.py`, or a direct inline assertion. JavaScript assertion shape (supply actual/expected from the public call first): `node -e 'const assert=require(\"node:assert/strict\"); assert.deepEqual(actual, expected);'`. Run the check directly; the check's own exit must measure the assertion.\n"
    + (configured ? `After the focused assertion, execute exactly this configured project command:\n${configured}\n` : "")
    + "Keep intended regression checks; clean temporary fixtures before final verification. For JSON comparisons, parse the actual output and compare structured values with assert.deepEqual instead of manually escaping nested JSON literals.\n"
    + "The audit below is a falsifiable model hypothesis, NOT an established defect or an authoritative expected value. Reject unsupported predictions with an executable counterexample; do not change correct behavior to satisfy the review. Repair only a demonstrated defect. Focused and project receipts must be fresh on the same source generation; an edit or model prose supplies neither. These receipts show execution, not oracle correctness or complete contract coverage. No extra work turns are granted; any explicitly configured terminal allowance is DONE-only.\n"
    + `Unverified review from turn ${pending.turn + 1} (bounded excerpt):\n${report.slice(0, 500)}`
    + (report.length > 500 ? "\n[Review excerpt truncated; the full audit remains recorded.]" : "");
}
