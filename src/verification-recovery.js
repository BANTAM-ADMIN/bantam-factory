// Only typed execution evidence can select recovery. Error-looking prose in
// task text, a model checkpoint, or a refused action is not a process result.
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
