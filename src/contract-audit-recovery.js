// An independent model review supplies hypotheses, never an execution proof.
// Ordinary turn checks predating the review cannot discharge it. The explicit
// controller station can execute after a new review on the same turn; only its
// nested receipts establish that ordering, never an unrelated turn-level pass.
import { parse } from "acorn";
import crypto from "node:crypto";
import path from "node:path";
import { hasShellControlOutsideQuotes, splitShellWords } from "./shell-lex.js";
import { verificationShellStatusRisk } from "./verification-evidence.js";
import { projectProbeEvidence } from "./probe-evidence.js";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { parseAssertionSpec, buildAssertionProbe } from "./contract-assertion-spec.js";

const HASH = /^[a-f0-9]{64}$/;
const SOURCES = new Set(["shell", "automatic", "scoped", "landing", "completion"]);
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const badFlags = value => ["blocked", "invalidated", "interrupted", "aborted", "timedOut", "bufferExceeded", "error", "signal", "uncertainty"].some(key => Boolean(value?.[key]));

function wordsForDirectCommand(command) {
  if (typeof command !== "string" || !command.trim() || hasShellControlOutsideQuotes(command)
      || verificationShellStatusRisk(command) !== null) return null;
  const words = splitShellWords(command);
  return words.length ? words : null;
}

function sameCommand(actual, expected) {
  const a = wordsForDirectCommand(actual), b = wordsForDirectCommand(expected);
  return Boolean(a && b && a.length === b.length && a.every((word, index) => word === b[index]));
}

// Recognition only: never rewrite or re-execute a shell program. A successful
// `cd EXACT_WORKSPACE && DIRECT` has the direct child's status, but only if the
// controller's actual cwd and complete execution receipt bind that workspace.
// No relative paths, substitutions, setup programs, extra operators or masks.
function workspacePrefixedCommand(command, workspace, cwd) {
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
  const prefix = command.slice(0, separator), direct = command.slice(separator + 2).trim();
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
      || proof.command !== shell.command || proof.executedCommand !== shell.executedCommand
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
  const bindings = new Set(), calls = [];
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
    if (node.type === "CallExpression") calls.push(node.callee);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, depth + 1));
      else if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(tree);
  return !incomplete && calls.some(callee => callee?.type === "Identifier" ? bindings.has(callee.name)
    : callee?.type === "MemberExpression" && bindings.has(callee.object?.name));
}

export function isFocusedAuditCommand(command, configured = null) {
  if (configured && sameCommand(command, configured)) return false;
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
      || !sameCommand(proof.executedCommand, configured) || !sameCommand(proof.statusCommand, configured)
      || (typeof workspaceReadOnly === "boolean" && proof.workspaceReadOnly !== workspaceReadOnly)) return false;
  if (proof.counts != null && (!record(proof.counts)
      || !["passed", "failed", "total"].every(key => Number.isSafeInteger(proof.counts[key]) && proof.counts[key] >= 0)
      || proof.counts.total < 1 || proof.counts.failed !== 0 || proof.counts.passed !== proof.counts.total)) return false;
  return true;
}

export function pendingContractAudit(turns = [], { generation, configuredCommand = null, verificationWorkspaceReadOnly = null, workspace = null } = {}) {
  let auditIndex = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    const audit = turns[index]?.contractStateAudit;
    if (audit?.focus === "collection-preconditions" && audit.status === "report") {
      auditIndex = index;
      break;
    }
  }
  if (auditIndex < 0) return null;
  const audit = turns[auditIndex].contractStateAudit;
  const configured = String(configuredCommand ?? "").trim();
  let focusedTurn = null, projectTurn = null, stationProjectTurn = null;
  for (let index = auditIndex; index < turns.length; index++) {
    const turn = turns[index];
    if (turn?.contractAssertion) {
      const station = turn.contractAssertion;
      focusedTurn = projectTurn = stationProjectTurn = null;
      if (!turn.controllerStop && !turn.shellScopeRollback?.violations?.length
          && validContractAssertion(station, audit, generation)) {
        focusedTurn = index;
        if (validStationProject(station.projectVerification, generation, configured, verificationWorkspaceReadOnly)) {
          projectTurn = stationProjectTurn = index;
        }
      }
      // The ordinary action/proof on this turn precedes the station. Only the
      // controller's nested project receipt establishes post-assertion order.
      continue;
    }
    if (index === auditIndex) continue;
    const proof = turn?.verificationEvidence;
    const shell = turn?.shellExecution;
    if (!proof && !shell) continue;
    // Typed failure, invalidation, or unknown provenance wins over a parallel
    // success field and clears earlier credit. Never fall back to shell prose.
    if (turn.controllerStop || turn.shellScopeRollback?.violations?.length
        || (proof && !validReceipt(proof, generation, { verification: true }))
        || (shell && !validReceipt(shell, generation))) {
      focusedTurn = projectTurn = stationProjectTurn = null;
      continue;
    }
    const command = commandForAuditReceipt(proof, shell, workspace);
    if (!command) { focusedTurn = projectTurn = stationProjectTurn = null; continue; }
    const nameFiltered = wordsForDirectCommand(command)?.some(word => /^--test-name-pattern(?:=|$)/.test(word));
    // A zero-match filtered run can exit zero. It proves no assertion ran and
    // must not clear the review; absent counts are unknown, not success.
    const observedFilteredCase = !nameFiltered || (proof?.counts?.passed > 0 && proof.counts.failed === 0);
    if ((!proof || proof.statusScope === "execution") && observedFilteredCase
        && isFocusedAuditCommand(command, configured)) focusedTurn = index;
    if (proof && configured && sameCommand(command, configured)) projectTurn = index;
  }
  const projectAfterFocused = projectTurn !== null && focusedTurn !== null
    && (projectTurn > focusedTurn || (projectTurn === focusedTurn && stationProjectTurn === focusedTurn));
  if (focusedTurn !== null && (!configured || projectAfterFocused)) return null;
  return { turn: auditIndex, promptSha256: audit.promptSha256 ?? null,
    report: String(audit.report ?? ""), sources: audit.sources ?? [], focusedTurn, projectTurn,
    needsFocused: focusedTurn === null,
    needsProject: Boolean(configured && !projectAfterFocused),
    missing: [...(focusedTurn === null ? ["focused-execution"] : []),
      ...(configured && !projectAfterFocused ? ["project-verification"] : [])] };
}

export function contractAuditRecoveryNote(pending) {
  if (!pending) return "";
  return `[contract-audit-recovery] The independent API review at turn ${pending.turn + 1} still needs ${pending.missing?.join(" + ") || "current executable evidence"}. An earlier green suite, a fresh broad suite alone, an edit, and the review's prose are not evidence that these boundary combinations were tested.\n`
    + `${pending.report.slice(0, 3000)}${pending.report.length > 3000 ? "\n[Review excerpt truncated; consult the full recorded audit.]" : ""}\n`
    + "Check each supported finding against the public contract. Run a small direct assertion through the actual public API that distinguishes the claimed behavior (including zero-work inputs where applicable), using writable temporary fixtures. Accepted launch shapes include `node --test test/edge.test.js`, `node check-api.mjs`, `python check_api.py`, or a direct inline assertion; use a concrete permitted file, not an output filter, echoed status, or compound shell program. Establish that one case and its launcher work before scaling a fuzz run. Repair only a demonstrated defect; reject unsupported findings with an executable counterexample, not an unrelated edit. Then run fresh configured project verification on the same source generation. These receipts show execution, not oracle correctness or complete contract coverage. The controller's source-bound assertion station can provide this focused execution; its post-station project receipt is separate. An unbound probe projection or model claim does not qualify. No extra turns are granted.";
}
