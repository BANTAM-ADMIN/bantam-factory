import { isTestCommand, isDeliverableRun } from "./logic/deliverable-signals.js";
import { parseTestCounts, parseTestFailures } from "./logic/test-focus.js";
import { shellContainsExactCommandSegment, shellSegments, splitShellWords } from "./shell-lex.js";
import crypto from "node:crypto";

// A quoted heredoc is literal stdin, not shell source. Support one conventional
// literal delimiter per header; leave other forms conservative/opaque. Keep the
// header and every shell suffix so `node <<'EOF' | tail` remains a pipeline.
function withoutLiteralHeredocBodies(value) {
  const lines = String(value ?? "").split(/\r?\n/), result = [];
  for (let line = 0; line < lines.length; line++) {
    const header = lines[line];let quote = null, marker = null;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if (ch === "\\" && quote !== "'") { i++; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#" && (i === 0 || /[\s;|&]/.test(header[i - 1]))) break;
      if (header.slice(i, i + 2) !== "<<") continue;
      const match = header.slice(i).match(/^<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (!match || marker) return String(value ?? "");
      marker = { tabs: match[1] === "-", delimiter: match[3] };i += match[0].length - 1;
    }
    result.push(header);
    if (marker) {
      let end = line + 1;
      while (end < lines.length && (marker.tabs ? lines[end].replace(/^\t+/, "") : lines[end]) !== marker.delimiter) end++;
      if (end === lines.length) return String(value ?? "");
      line = end;
    }
  }
  return result.join("\n").trim();
}

/**
 * Classify only status propagation, never whether diagnostic prose is an error.
 * `pipefail` must come from the executor, not a model's description of its run.
 * This is deliberately conservative about compound/opaque shell programs; it
 * does not expand substitutions or pretend to be a complete shell parser.
 */
export function verificationShellStatusRisk(value, { pipefail = false, finalSequenceScope = false } = {}, depth = 0) {
  const command = withoutLiteralHeredocBodies(value);
  if (depth > 4) return "nested shell status is unknown";
  let quote = null, pipeline = false, compound = false, masksStatus = false, opaque = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i], next = command[i + 1];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) opaque = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /[\s;|&]/.test(command[i - 1]))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")") opaque = true;
    if (ch === ";" || ch === "\n") {
      // A trailing terminator changes no status; a subsequent command can.
      if (!finalSequenceScope && command.slice(i + 1).trim()) masksStatus = compound = true;
    } else if (ch === "|") {
      if (next === "|") { masksStatus = compound = true; i++; }
      else if (command[i - 1] !== ">") { pipeline = true; if (next === "&") i++; }
    } else if (ch === "&" && command[i - 1] !== ">" && next !== ">") {
      compound = true;
      if (next === "&") i++;
      else masksStatus = true;
    }
  }
  if (quote || opaque) return "nested or opaque shell status is unknown";
  if (masksStatus) return "compound shell syntax can mask an earlier failure";
  // A new `sh -c` does not inherit the outer shell's pipefail guarantee. Inspect
  // its literal program conservatively, without interpreting arbitrary scripts.
  for (const segment of shellSegments(command)) {
    const words = splitShellWords(segment);
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
    if (words[index] === "!") return "shell negation can turn a failed command into success";
    while (words[index] === "command") index++;
    if (words[index] === "env") {
      index++;
      while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
    }
    if (finalSequenceScope && /^(?:exit|return|exec|break|continue|if|then|else|elif|fi|case|esac|for|while|until|do|done|\{|\})$/.test(words[index] ?? "")) return "shell control transfer can skip the final verifier";
    if (finalSequenceScope && (/[$`]/.test(words[index] ?? "") || words[index]?.startsWith("-"))) return "expanded or wrapped command identity is unknown";
    if (["eval", "builtin"].includes(words[index])) return "evaluated or builtin shell status is unknown";
    if (!/^(?:.*\/)?(?:ba|da|a|k|z)?sh$/.test(words[index] ?? "")) continue;
    const flag = words.findIndex((word, i) => i > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (flag < 0 || !words[flag + 1]) continue;
    const nested = verificationShellStatusRisk(words[flag + 1], { pipefail: false }, depth + 1);
    if (nested) return `nested shell: ${nested}`;
  }
  if (pipeline && (!pipefail || compound)) return !pipefail
    ? "pipeline stage exits were not protected by executor pipefail"
    : "pipefail alone does not certify a compound pipeline";
  return null;
}

function finalConfiguredSequence(command, configured) {
  const normalized = withoutLiteralHeredocBodies(command), segments = shellSegments(normalized);
  // Without an explicit baseline, a final recognized suite still has its own
  // observable exit status. Do not extend this fallback to arbitrary probes.
  const verifier = configured || (isTestCommand(segments.at(-1)) ? segments.at(-1) : null);
  if (!verifier || shellSegments(verifier).length !== 1 || segments.length < 2
      || !shellContainsExactCommandSegment(segments.at(-1), verifier)) return null;
  // This scopes only the final configured command. Earlier semicolon/newline
  // commands are not certified, and a pipeline/OR/background/control transfer
  // still cannot borrow the final shell exit as proof.
  return verificationShellStatusRisk(normalized, { finalSequenceScope: true }) === null ? verifier : null;
}

/** Only an actual process execution can produce verification evidence. */
export function verificationEvidence({ execution, command, configuredCommand = null,
  generation, source = "shell", invalidated = false } = {}) {
  if (!execution || typeof execution !== "object") return null;
  const actualCommand = String(command ?? execution.command ?? "").trim();
  if (!actualCommand) return null;
  const configured = String(configuredCommand ?? "").trim();
  const runsConfigured = Boolean(configured && (actualCommand === configured
    || shellContainsExactCommandSegment(actualCommand, configured)));
  const stdout = String(execution.stdout ?? "");
  const stderr = String(execution.stderr ?? "");
  const rawOutput = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  const parsedCounts = parseTestCounts(rawOutput);
  const summaryLines = rawOutput.split(/\r?\n/).filter((line) =>
    /^#\s+pass\s+\d+\s*$/.test(line)
    || (!/^\s*(?:--- (?:PASS|FAIL):|ok |not ok )/.test(line) && parseTestCounts(line)));
  const ambiguousCounts = summaryLines.length > 1;
  if (source === "shell" && !runsConfigured && !isTestCommand(actualCommand)
      && !isDeliverableRun(actualCommand)) return null;
  const exitCode = execution.exitCode ?? execution.code ?? null;
  const interrupted = Boolean(execution.interrupted || execution.aborted);
  const timedOut = Boolean(execution.timedOut);
  // A filter can exit zero after a silent/crashed verifier. Printed suite counts
  // do not recover missing stage status, and expected-error text is not failure.
  let statusRisk = exitCode === 0 ? verificationShellStatusRisk(
    execution.executedCommand ?? actualCommand, { pipefail: execution.pipefail === true }) : null;
  const finalConfiguredScope = statusRisk && finalConfiguredSequence(execution.executedCommand ?? actualCommand, configured);
  if (finalConfiguredScope) statusRisk = null;
  const unavailable = invalidated || execution.blocked || execution.error
    || execution.bufferExceeded || interrupted || timedOut || !Number.isInteger(exitCode)
    || statusRisk || (exitCode === 0 && parsedCounts?.total === 0 && isTestCommand(actualCommand));
  const reportedFailures = parsedCounts?.failed > 0
    || /^#\s+fail\s+[1-9]\d*\s*$/m.test(rawOutput)
    || summaryLines.some((line) => parseTestCounts(line)?.failed > 0);
  const failures = unavailable ? [] : parseTestFailures(rawOutput);
  return Object.freeze({
    schema: 1, source, command: actualCommand,
    executedCommand: execution.executedCommand ?? actualCommand,
    configuredCommand: runsConfigured ? configured : null,
    generation, exitCode, timedOut, interrupted,
    pipefail: typeof execution.pipefail === "boolean" ? execution.pipefail : null,
    scratchDirectory: execution.scratchDirectory ?? null,
    workspaceReadOnly: typeof execution.workspaceReadOnly === "boolean" ? execution.workspaceReadOnly : null,
    statusScope: finalConfiguredScope ? (configured ? "final-configured-command" : "final-test-command") : "execution",
    statusCommand: finalConfiguredScope || execution.executedCommand || actualCommand,
    ...(statusRisk ? { uncertainty: `outer shell success may mask an inner runner failure: ${statusRisk}` } : {}),
    status: unavailable ? "unverified" : exitCode === 0 && !reportedFailures ? "pass" : "fail",
    counts: unavailable || ambiguousCounts ? null : parsedCounts,
    countsScope: ambiguousCounts ? "multiple-summaries" : finalConfiguredScope ? "compound-output-single-summary" : "single-execution",
    failingTests: failures.slice(0, 32).map((failure) => failure.name),
    failingTestsComplete: !unavailable && !ambiguousCounts && Boolean(parsedCounts)
      && failures.length >= parsedCounts.failed && failures.length <= 32,
    rawOutput,
    sandbox: execution.sandbox ?? null,
  });
}

/** Preserve the evidence identity without duplicating bulky output in turn metadata. */
export function verificationReceipt(evidence) {
  if (!evidence) return null;
  const { rawOutput, ...receipt } = evidence;
  return { ...receipt, outputSha256: crypto.createHash("sha256").update(rawOutput).digest("hex") };
}

/** Exit-bound evidence for non-suite probes; never replay shell prose as proof. */
export function shellExecutionReceipt(execution, { generation, invalidated = false } = {}) {
  if (!execution) return null;
  const { command, executedCommand, exitCode, timedOut, interrupted, bufferExceeded,
    error, blocked, sandbox, pipefail, scratchDirectory, workspaceReadOnly } = execution;
  const rawOutput = String(execution.stdout ?? "") + "\n" + String(execution.stderr ?? "");
  return { command, executedCommand, exitCode, generation, timedOut, interrupted,
    bufferExceeded, error, blocked, sandbox, pipefail, scratchDirectory, workspaceReadOnly, invalidated,
    outputSha256: crypto.createHash("sha256").update(rawOutput).digest("hex") };
}
