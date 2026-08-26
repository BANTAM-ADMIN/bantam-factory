// Station notes are shop-floor signage for the WORKER, not the customer.
// Steers, gates, pins and audits ([verify-cadence], [fix-tests], [repour]…)
// are appended to observations so the MODEL course-corrects; shown raw in the
// interactive feed they read as "the agent is malfunctioning" (operator
// report, 2026-08-25: a user watching the feed thought the run was failing
// while the factory was simply working). Display-side only: the model's
// context, run.json films, and fight-card logs keep every byte.
//
// [timeout] and [interrupted] survive: they explain a real, user-visible
// outcome of the user's own command, not internal steering.
const USER_FACING = new Set(["timeout", "interrupted"]);
const NOTE_RE = /^\[([a-z][a-z0-9_-]*)\]/i;

export function scrubStationNotes(observation, { show = process.env.BANTAM_SHOW_STATIONS === "1" } = {}) {
  const s = String(observation ?? "");
  if (show || !s.includes("[")) return s;
  const kept = [];
  for (const block of s.split(/\n{2,}/)) {
    const m = NOTE_RE.exec(block.trimStart());
    if (m && !USER_FACING.has(m[1].toLowerCase())) continue;
    kept.push(block);
  }
  return kept.join("\n\n").trim() === "" ? "" : kept.join("\n\n");
}
