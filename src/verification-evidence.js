import { isTestCommand, isDeliverableRun } from "./logic/deliverable-signals.js";
import { parseTestCounts, parseTestFailures } from "./logic/test-focus.js";
import { shellContainsExactCommandSegment, shellSegments } from "./shell-lex.js";
import crypto from "node:crypto";

import { verificationShellStatusRisk, sameAuditCommand, withoutLiteralHeredocBodies } from "./verification-command.js";
export { verificationShellStatusRisk } from "./verification-command.js";

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
  const runsConfigured = Boolean(configured && (sameAuditCommand(actualCommand, configured) || actualCommand === configured
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
    // A direct custom check (e.g. node test/uv-check.js) may be classified as
    // a deliverable launcher. Its explicit zero-test summary is still no proof.
    || statusRisk || (exitCode === 0 && parsedCounts?.total === 0);
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
    cwd: typeof execution.cwd === "string" ? execution.cwd : null,
    workspaceReadOnly: typeof execution.workspaceReadOnly === "boolean" ? execution.workspaceReadOnly : null,
    statusScope: finalConfiguredScope ? (configured ? "final-configured-command" : "final-test-command") : "execution",
    statusCommand: finalConfiguredScope || execution.executedCommand || actualCommand,
    ...(statusRisk ? { uncertainty: `outer shell success may mask an inner runner failure: ${statusRisk}` } : {}),
    status: unavailable ? "unverified" : exitCode === 0 && !reportedFailures ? "pass" : "fail",
    counts: unavailable || ambiguousCounts ? null : parsedCounts,
    countsScope: ambiguousCounts ? "multiple-summaries" : finalConfiguredScope ? "compound-output-single-summary" : "single-execution",
    failingTests: failures.slice(0, 32).map((failure) => failure.name),
    failureSites: failures.filter(f => f.file && Number.isSafeInteger(f.assertionLine) && f.assertionLine > 0)
      .slice(0, 4).map(f => ({file: f.file, line: f.assertionLine})),
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
    error, blocked, sandbox, pipefail, scratchDirectory, workspaceReadOnly, cwd } = execution;
  const rawOutput = String(execution.stdout ?? "") + "\n" + String(execution.stderr ?? "");
  return { command, executedCommand, exitCode, generation, timedOut, interrupted,
    bufferExceeded, error, blocked, sandbox, pipefail, scratchDirectory, workspaceReadOnly, cwd, invalidated,
    outputSha256: crypto.createHash("sha256").update(rawOutput).digest("hex") };
}
