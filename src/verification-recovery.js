// Only typed execution evidence can select recovery. Error-looking prose in
// task text, a model checkpoint, or a refused action is not a process result.
import { canonicalAuditCommand } from "./verification-command.js";
import { isFocusedAuditCommand, VERIFICATION_RECEIPTS_SCHEMA } from "./contract-audit-recovery.js";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { successfulCheckCommands } from "./verification-chain.js";

export function latestVerificationRecovery(turns = []) {
  for (let index = turns.length - 1; index >= 0; index--) {
    const evidence = turns[index]?.verificationEvidence;
    if (!evidence) continue;
    if (evidence.status === "pass") return null;
    if (evidence.status === "fail" || evidence.status === "unverified") {
      return { turn: index, command: evidence.command, status: evidence.status,
        uncertainty: evidence.uncertainty ?? null };
    }
  }
  return null;
}

export function verificationRecoveryNote(evidence) {
  return `[verification recovery] Recent investigation is not producing conclusive evidence. Reading and query are paused, but shell checks and file edits remain available. The last executable check ${evidence.status === "fail" ? "FAILED" : "was INCONCLUSIVE"}: ${String(evidence.command ?? "").slice(0, 500)}. Do not infer success from the repeat limit or from an old working note. This is verification recovery, not a demand to write a first implementation or make unrelated edits. Run one direct executable witness without output filters, echoed exit codes or status-masking suffixes. For an expected error, assert its exit/stdout/stderr in a small test whose own exit measures success; create any new test in a new permitted file. Correct implementation or fixture only as justified by the public contract. Use an executable probe to distinguish competing hypotheses; another identical read cannot do that. Finish only with an accurate account of the result. The original turn budget still applies.`;
}

const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const HASH = /^[a-f0-9]{64}$/;
const badExecution = value => ["invalidated", "blocked", "timedOut", "interrupted", "aborted", "bufferExceeded", "error", "signal", "uncertainty", "cached"]
  .some(key => Boolean(value?.[key]));

function reminderEntries(turn, index) {
  if (!record(turn) || turn.controllerStop || turn.shellScopeRollback?.violations?.length) return [];
  if (!Object.hasOwn(turn, "verificationReceipts")) {
    return [{ verificationEvidence: turn.verificationEvidence ?? null, shellExecution: turn.shellExecution ?? null }];
  }
  const envelope = turn.verificationReceipts;
  if (!record(envelope) || envelope.schema !== VERIFICATION_RECEIPTS_SCHEMA
      || envelope.authority !== "controller-execution-order" || envelope.turn !== index
      || !Array.isArray(envelope.entries) || envelope.entries.length > 16
      || !envelope.entries.every((entry, sequence) => record(entry) && entry.sequence === sequence
        && (entry.verificationEvidence == null || record(entry.verificationEvidence))
        && (entry.shellExecution == null || record(entry.shellExecution)))) return [];
  try {
    for (const key of ["verificationEvidence", "shellExecution"]) {
      if (turn[key] != null && !envelope.entries.some(entry => entry[key] != null
          && canonicalEncode(entry[key]) === canonicalEncode(turn[key]))) return [];
    }
  } catch { return []; }
  return envelope.entries;
}

function reminderExecution(entry, { generation, workspace, configuredCommand }) {
  const shell = entry.shellExecution, proof = entry.verificationEvidence;
  if (!record(shell) || badExecution(shell) || !HASH.test(shell.outputSha256 ?? "")
      || !Number.isSafeInteger(shell.generation) || shell.generation < 0
      || (Number.isSafeInteger(generation) && shell.generation > generation)
      || !Number.isSafeInteger(shell.exitCode) || shell.exitCode < 0 || shell.exitCode > 255
      || typeof shell.cwd !== "string" || !shell.cwd.startsWith("/")
      || (workspace != null && shell.cwd !== workspace)
      || typeof shell.command !== "string" || !shell.command || shell.command.length > 4096
      || typeof shell.executedCommand !== "string" || !shell.executedCommand || shell.executedCommand.length > 4096
      || (!isFocusedAuditCommand(shell.executedCommand, configuredCommand)
        && !(shell.exitCode === 0 && successfulCheckCommands(shell.executedCommand, configuredCommand).length))) return null;
  if (proof != null) {
    if (!record(proof) || proof.schema !== 1 || proof.source !== "shell" || badExecution(proof)
        || !HASH.test(proof.outputSha256 ?? "") || proof.statusScope !== "execution"
        || proof.statusCommand !== shell.executedCommand
        || proof.status !== (shell.exitCode === 0 ? "pass" : "fail")
        || ["command", "executedCommand", "generation", "exitCode", "cwd", "workspaceReadOnly", "sandbox"]
          .some(key => (proof[key] ?? null) !== (shell[key] ?? null))) return null;
    if (proof.counts != null && (!record(proof.counts) || proof.countsScope !== "single-execution"
        || !["passed", "failed", "total"].every(key => Number.isSafeInteger(proof.counts[key]) && proof.counts[key] >= 0)
        || proof.counts.passed + proof.counts.failed > proof.counts.total
        || (shell.exitCode === 0 && (proof.counts.failed !== 0 || proof.counts.passed < 1)))) return null;
  }
  return shell;
}

// Advisory memory, deliberately separate from acceptance and action masks.
// A green *different* program cannot settle a failed focused check. Inspect at
// most 128 turns and retain eight identities; never read or execute a script.
export function latestUnresolvedFocusedFailure(turns = [], { generation = null, workspace = null, configuredCommand = null } = {}) {
  if (!Array.isArray(turns)) return null;
  const pending = new Map();
  for (let index = Math.max(0, turns.length - 128); index < turns.length; index++) {
    for (const entry of reminderEntries(turns[index], index)) {
      const shell = reminderExecution(entry, { generation, workspace, configuredCommand });
      if (!shell) continue;
      const key = `${shell.cwd}\0${canonicalAuditCommand(shell.executedCommand) ?? shell.executedCommand}`;
      if (shell.exitCode === 0) {
        if (pending.has(key) && shell.generation >= pending.get(key).generation) pending.delete(key);
        for (const command of successfulCheckCommands(shell.executedCommand, configuredCommand)) {
          const checkKey = `${shell.cwd}\0${command}`;
          if (pending.has(checkKey) && shell.generation >= pending.get(checkKey).generation) pending.delete(checkKey);
        }
      } else {
        pending.delete(key);
        pending.set(key, { command: shell.executedCommand, generation: shell.generation, turn: index, exitCode: shell.exitCode });
        if (pending.size > 8) pending.delete(pending.keys().next().value);
      }
    }
  }
  const latest = [...pending.values()].at(-1);
  return latest ? { ...latest, historical: !Number.isSafeInteger(generation) || latest.generation !== generation } : null;
}

export function focusedFailureReminder(failure) {
  if (!failure) return "";
  const command = String(failure.command ?? "");
  return `[diagnosis] Unresolved focused-check observation: ${JSON.stringify(command.slice(0, 180))}${command.length > 180 ? " (command excerpt)" : ""} exited ${failure.exitCode} at turn ${failure.turn + 1}, generation ${failure.generation}.`
    + (failure.historical ? " The workspace has since changed or its generation is unknown; this is historical evidence, not a claim the current code is defective." : " This failure was observed on the current generation.")
    + " A different green command or printed diagnostic does not show this check passed. Use its failure to justify code/fixture repair, then rerun the check directly when execution is permitted. Advisory only: no oracle or completion proof.";
}
