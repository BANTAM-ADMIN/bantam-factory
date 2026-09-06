// Premature-done from the run's OWN evidence.
//
// A common completion failure is "oracle blindness": the model ran a check, that check
// showed failure, and it called `done` anyway. `analyzeTestResult` only recognizes formal
// runner output; a segfault on a binary the model itself built can slip straight through.
//
// This guard reads the model's last deliverable-verification before `done` and refuses `done` once if
// that verification reported a HARD failure with no subsequent clean run.
//
// Precision over recall, deliberately. A guard that false-refuses a correct `done` traps the run — the
// exact bug a narrow domain gate shipped. So the failure signal must be unambiguous:
//   * a crash signal (segfault / abort / core dumped), or
//   * a non-zero exit on a command that RAN THE DELIVERABLE or a real test runner — never on a `grep`,
//     `test`, `[`, or `find` whose non-zero exit is ordinary control flow, or
//   * a recognised test-runner failure summary (pytest "N failed", ctest "failed").
//
// Deliberate gap: self-authored string checks are not covered. Recognizing arbitrary
// model-defined failure tokens risks false positives on passing runs that print "fail" while exploring.

import { recordTurns, unresolvedDeliverableFailure } from "./runlog.js";

const EVIDENCE_TAG = "[done-guard]";

// Live agent turns are { action: {a, c}, observation }; saved fixtures may be flat { a, c, observation }.
// Read both, exactly as done-guard's own lastIndexOfEdit does.
function act(turn) { return (turn && (turn.action || turn.parsedAction)) || turn || {}; }

/**
 * Read the last deliverable-verification before `done` — now a QUERY over run datoms, not an
 * imperative scan. `recordTurns` records each deliverable run's crash/exit as a `run/deliverable`
 * datom; `unresolvedDeliverableFailure` is the as-of query. This is the substrate form: the check is
 * a predicate over the append-only run history, matching the pattern of `prematureDoneByQuery`.
 * @returns {null | { cmd, reason, idx }} null when the last verification was clean or absent.
 */
export function unresolvedRunFailure(turns, { workspaceGeneration } = {}) {
  const all = turns ?? [];
  // recordTurns reads {action|parsedAction}; saved fixtures/tests may be flat {a,c,p}. Normalize.
  // Preserve `scopedVerify` — a trusted harness-run verdict recordTurns credits in the deliverable
  // channel; dropping it here made a passing auto/scoped verify invisible, so the guard falsely
  // reported the model's earlier failed run as still unresolved.
  // Preserve typed presence AND typed absence, plus edit/generation provenance.
  // Discarding the receipt made assignment prose appended to exit-0 test output
  // ("a non-repository directory must exit 1") fabricate a failed execution.
  const norm = all.map((t) => ({ ...t, action: act(t) }));
  const log = recordTurns(norm, { workspaceGeneration });
  const q = unresolvedDeliverableFailure(log, all.length);
  if (!q) return null;
  const evidence = log.asof(`turn:${q.at}`, "deliverable-evidence", q.at)?.v;
  return { cmd: evidence?.command, reason: evidence?.reason ?? "failure", idx: q.at };
}

/**
 * @param {Array<{a,c,observation}>} turns  the run trajectory
 * @param {number} alreadyRejected
 * @param {{maxRejections?: number}} opts
 * @returns {string|null}
 */
export function unresolvedEvidenceObjection(turns, alreadyRejected = 0, { maxRejections = 1, workspaceGeneration } = {}) {
  if (maxRejections <= 0 || alreadyRejected >= maxRejections) return null;
  const fail = unresolvedRunFailure(turns, { workspaceGeneration });
  if (!fail) return null;
  return `${EVIDENCE_TAG} You called done, but your own last check of the deliverable failed and you did`
    + ` not fix it. Command:\n  ${String(fail.cmd).slice(0, 200)}\nreported: ${fail.reason}.\n`
    + `Re-run that command, confirm it now succeeds`
    + ` (clean exit, no crash, no test failures), and only then call done.`;
}
