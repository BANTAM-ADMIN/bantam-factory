// Does the oracle reject work that is actually correct?
//
// Every gauge check in this codebase asks whether the public suite CATCHES a
// defect -- red/green against a constructed broken specimen. That is half a
// calibration. A gauge that rejects good parts is as bad as one that passes bad
// parts, and until 2026-07-31 nothing here measured the second failure mode.
//
// It was happening. keyed-task-pool-strong's public suite asserted that
// `new KeyedTaskPool({ concurrency: null })` throws RangeError. The hidden grader
// checks [0,-1,1.5,NaN,"2"] and says nothing about null; the task writes
// `{ concurrency = 2 }`, which makes null invalid under destructuring-default
// semantics and the default under `?? 2`. The contract does not settle it, so the
// assertion was invented. Recorded run v4 named it "the only failing test",
// rewrote the concurrency guard three consecutive times, and was killed by the
// wall clock without ever producing a verdict.
//
// The fix needs no new fixtures. A run the hidden grader PASSED is a known-good
// specimen by definition, and BANTAM already records its final diff. Replaying
// those against the current public suite finds invented requirements for free,
// and grows more sensitive with every run.
//
// Validated against recorded reality before being trusted, per the rule in
// docs/RELIABILITY-BORROWINGS.md: four recorded hidden-PASS specimens, replayed
// against the pre-fix suite (rejected 1 -- the defect) and the post-fix suite
// (rejected 0).

/**
 * Pull replayable known-good specimens out of recorded run artifacts.
 *
 * A specimen is only usable when the hidden grader passed it AND its diff was
 * captured whole -- replaying a truncated tree would blame the oracle for the
 * truncation.
 *
 * @param {Array<object>} records
 */
export function extractGoldenSpecimens(records) {
  const list = Array.isArray(records) ? records : [];
  const specimens = [];
  const rejected = { failedContract: 0, unusableDiff: 0 };
  for (const record of list) {
    const status = record?.result?.status ?? record?.status;
    if (status !== "pass") {
      rejected.failedContract += 1;
      continue;
    }
    const diff = record?.finalDiff;
    if (!diff || diff.truncated === true || typeof diff.text !== "string" || diff.text.length === 0) {
      rejected.unusableDiff += 1;
      continue;
    }
    specimens.push({ runId: record.runId ?? null, diff: diff.text, files: diff.files ?? [] });
  }
  return { specimens, rejected };
}

/**
 * Classify a set of replay results.
 *
 * @param {Array<{runId:string, applied:boolean, publicFail:number, failures:string[]}>} results
 */
export function summarizeGoldenReplay(results) {
  const list = Array.isArray(results) ? results : [];
  const applied = list.filter((r) => r?.applied);
  const notApplied = list.length - applied.length;

  const byAssertion = {};
  let rejectedGood = 0;
  for (const r of applied) {
    const failures = Array.isArray(r.failures) ? r.failures : [];
    if ((Number(r.publicFail) || 0) > 0 || failures.length > 0) rejectedGood += 1;
    for (const name of failures) byAssertion[name] = (byAssertion[name] ?? 0) + 1;
  }

  // Ordered by how many known-good implementations each assertion rejects. An
  // assertion that rejects several distinct correct implementations is almost
  // certainly wrong about the contract rather than unlucky.
  const inventedAssertions = Object.keys(byAssertion)
    .sort((a, b) => byAssertion[b] - byAssertion[a] || a.localeCompare(b));

  let verdict;
  if (applied.length === 0) verdict = "no-specimens";
  else if (rejectedGood > 0) verdict = "invented-requirement";
  else verdict = "clean";

  return {
    verdict,
    replayed: applied.length,
    notApplied,
    rejectedGood,
    byAssertion,
    inventedAssertions,
  };
}

/** Human report. Leads with the assertions to delete. */
export function formatGoldenReplay(summary) {
  const s = summary ?? {};
  const lines = [];
  if (s.verdict === "no-specimens") {
    lines.push("[golden-replay] no known-good specimens available, so the oracle has "
      + "not been checked for invented requirements. This is not a clean result.");
    if (s.notApplied) lines.push(`  ${s.notApplied} recorded specimen(s) could not be replayed.`);
    return lines.join("\n");
  }

  lines.push(`[golden-replay] replayed ${s.replayed} implementation(s) the hidden grader passed, `
    + `against the current public suite.`);
  if (s.notApplied) {
    lines.push(`  ${s.notApplied} specimen(s) did not apply and were not counted either way.`);
  }

  if (s.verdict === "clean") {
    lines.push("  Every known-good implementation is accepted: no invented requirements found.");
    return lines.join("\n");
  }

  lines.push(`  INVENTED REQUIREMENT: ${s.rejectedGood} of ${s.replayed} known-good implementation(s) `
    + `are REJECTED by the public suite.`);
  for (const name of s.inventedAssertions) {
    lines.push(`    rejects ${String(s.byAssertion[name]).padStart(2)} good implementation(s)  ${name}`);
  }
  lines.push("  An assertion that fails an implementation the hidden contract accepts is not a");
  lines.push("  requirement -- it is the oracle inventing one, and it costs turns the run needs.");
  return lines.join("\n");
}
