import { isTestCommand, isDeliverableRun } from "./logic/deliverable-signals.js";
import { parseTestCounts, parseTestFailures } from "./logic/test-focus.js";
import { shellContainsExactCommandSegment, hasShellControlOutsideQuotes } from "./shell-lex.js";
import crypto from "node:crypto";

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
  // An outer successful shell can mask an inner runner crash. Do not claim a
  // cause from that prose, but do not certify the inner invocation either.
  const maskedRunner = exitCode === 0 && !parsedCounts && hasShellControlOutsideQuotes(actualCommand)
    && /Traceback \(most recent call last\)|\b(?:SyntaxError|AssertionError):/.test(rawOutput);
  const unavailable = invalidated || execution.blocked || execution.error
    || execution.bufferExceeded || interrupted || timedOut || !Number.isInteger(exitCode)
    || maskedRunner || (exitCode === 0 && parsedCounts?.total === 0 && isTestCommand(actualCommand));
  const reportedFailures = parsedCounts?.failed > 0
    || /^#\s+fail\s+[1-9]\d*\s*$/m.test(rawOutput)
    || summaryLines.some((line) => parseTestCounts(line)?.failed > 0);
  const failures = unavailable ? [] : parseTestFailures(rawOutput);
  return Object.freeze({
    schema: 1, source, command: actualCommand,
    executedCommand: execution.executedCommand ?? actualCommand,
    configuredCommand: runsConfigured ? configured : null,
    generation, exitCode, timedOut, interrupted,
    ...(maskedRunner ? { uncertainty: "outer shell success may mask an inner runner failure" } : {}),
    status: unavailable ? "unverified" : exitCode === 0 && !reportedFailures ? "pass" : "fail",
    counts: unavailable || ambiguousCounts ? null : parsedCounts,
    countsScope: ambiguousCounts ? "multiple-summaries" : "single-execution",
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
    error, blocked, sandbox } = execution;
  const rawOutput = String(execution.stdout ?? "") + "\n" + String(execution.stderr ?? "");
  return { command, executedCommand, exitCode, generation, timedOut, interrupted,
    bufferExceeded, error, blocked, sandbox, invalidated,
    outputSha256: crypto.createHash("sha256").update(rawOutput).digest("hex") };
}
