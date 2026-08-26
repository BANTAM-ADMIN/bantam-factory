// Statuses where the run never actually attempted the task. Counting these in the
// denominator reports a missing observation as a failure: on 2026-08-01 an
// exhausted Codex account produced "0/1 passed", indistinguishable from a fixture
// the model got wrong, and an hour went into debugging the harness instead of the
// account. Same rule as a blocked competitor arm and a wall-clock-killed run.
const UNGRADED_STATUSES = new Set(["quota-exhausted", "model-error", "blocked", "interrupted"]);

export function summarizeEvalRows(rows) {
  const ungradedRows = rows.filter((r) => UNGRADED_STATUSES.has(r.status));
  const gradedRows = rows.filter((r) => !UNGRADED_STATUSES.has(r.status));
  const total = gradedRows.length;
  const graded = gradedRows.length;
  const ungraded = ungradedRows.length;
  const passed = gradedRows.filter((r) => r.status === "pass").length;
  const grammarCleanPassed = gradedRows.filter((r) =>
    r.status === "pass"
    && (r.invalid ?? 0) === 0
    && (r.protocolViolations ?? 0) === 0
  ).length;
  return {
    total,
    graded,
    ungraded,
    ungradedStatuses: [...new Set(ungradedRows.map((r) => r.status))],
    passed,
    grammarCleanPassed,
    repairedOrSalvagedPassed: passed - grammarCleanPassed,
    invalid: rows.reduce((sum, r) => sum + (r.invalid ?? 0), 0),
    protocolViolations: rows.reduce((sum, r) => sum + (r.protocolViolations ?? 0), 0),
    duplicateActionRejections: rows.reduce((sum, r) => sum + (r.duplicateActionRejections ?? 0), 0),
    outcomeCycleEvents: rows.reduce((sum, r) => sum + (r.outcomeCycleEvents ?? 0), 0),
    outcomeCycleHints: rows.reduce((sum, r) => sum + (r.outcomeCycleHints ?? 0), 0),
    repeatEscapeMasks: rows.reduce((sum, r) => sum + (r.repeatEscapeMasks ?? 0), 0),
    patchActions: rows.reduce((sum, r) => sum + (r.patchActions ?? 0), 0),
    patchFailures: rows.reduce((sum, r) => sum + (r.patchFailures ?? 0), 0),
    deleteFileActions: rows.reduce((sum, r) => sum + (r.deleteFileActions ?? 0), 0),
    moveFileActions: rows.reduce((sum, r) => sum + (r.moveFileActions ?? 0), 0),
    fileOperationFailures: rows.reduce((sum, r) => sum + (r.fileOperationFailures ?? 0), 0),
  };
}

export function formatEvalSummary(rows) {
  const s = summarizeEvalRows(rows);
  const ungradedLine = s.ungraded
    ? [`${s.ungraded} run(s) not graded (${s.ungradedStatuses.join(", ")}) — these never attempted the task`]
    : [];
  if (!s.graded) {
    return [
      `0 run(s) graded — every run was ungraded (${s.ungradedStatuses.join(", ")}).`,
      "No fixture result is implied; nothing was measured.",
    ].join("\n");
  }
  return [
    `${s.passed}/${s.total} passed`,
    `${s.grammarCleanPassed}/${s.total} grammar-clean passed (0 invalid, 0 protocol)`,
    `${s.repairedOrSalvagedPassed}/${s.total} passed with repair/salvage`,
    `${s.duplicateActionRejections} duplicate action(s) replayed, ${s.repeatEscapeMasks} repeat-escape mask(s) applied`,
    `${s.outcomeCycleEvents} repeated failure outcome(s) observed, ${s.outcomeCycleHints} outcome-cycle hint(s) emitted`,
    `${s.patchActions} patch action(s), ${s.patchFailures} patch failure(s)`,
    `${s.deleteFileActions} delete action(s), ${s.moveFileActions} move action(s), ${s.fileOperationFailures} file-op failure(s)`,
    ...ungradedLine,
  ].join("\n");
}
