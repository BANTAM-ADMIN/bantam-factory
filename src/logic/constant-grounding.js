// Constant tables must be read, not recalled — the gate form.
//
// Measured escalation (2026-08-18 bake-off): three sighted arms wrote three
// DIFFERENT hallucinated GGML enum tables; every byte-derived fact in the
// same tools was exact. The [provenance] edit-note fired at the moment of
// risk and was waved past (hint inert, replicating the 2026-08-15 finding
// that advisories get skipped where bounces get repaired). Arm-A, which read
// the library, was the only arm with correct names.
//
// The gate's evidence rule: an int-keyed literal table (>=3 entries) landed
// by this run's edits is GROUNDED only if some observation in the run shows
// at least two of its key->name pairs together — the shape a real source
// (an enum listing, a spec table, a header) produces and recall does not.
// The tool's own report output does not qualify: reports print names WITH
// COUNTS, not names WITH THEIR ENUM KEYS.
//
// Opt-in (BANTAM_CONSTANT_GROUNDING=1), one bounce, block delivery.

const TABLE_ENTRY_RE = /(?:^|[{,\n])\s*(\d{1,4})\s*:\s*[("']*"?([A-Za-z_][A-Za-z0-9_.]*)/g;

function editText(action) {
  const a = action || {};
  return [a.content, a.new, a.text, ...(Array.isArray(a.edits) ? a.edits.map((e) => e?.new) : [])]
    .filter((s) => typeof s === "string").join("\n");
}

/** Extract {key, name} entries from int-keyed literal tables in an edit. */
export function tableEntries(action) {
  const text = editText(action);
  const out = [];
  for (const m of text.matchAll(TABLE_ENTRY_RE)) out.push({ key: m[1], name: m[2] });
  return out.length >= 3 ? out : [];
}

/** Did any observation show this key and name TOGETHER (within a line of each other)? */
function pairSighted(turns, entry, editTurnIdx) {
  const probe = new RegExp(`\\b${entry.key}\\b[^\\n]{0,80}\\b${entry.name}\\b|\\b${entry.name}\\b[^\\n]{0,80}\\b${entry.key}\\b`);
  return (turns ?? []).some((t, i) => i !== editTurnIdx && probe.test(String(t?.observation ?? "")));
}

/**
 * @returns {string|null} objection when a table landed ungrounded.
 */
export function constantGroundingObjection(turns, alreadyRejected = 0, { maxRejections = 1 } = {}) {
  if (alreadyRejected >= maxRejections) return null;
  const all = turns ?? [];
  for (let i = all.length - 1; i >= 0; i--) {
    const a = (all[i] && (all[i].action || all[i].parsedAction)) || all[i] || {};
    if (!["replace", "write_file", "patch", "edit_lines"].includes(a.a)) continue;
    const entries = tableEntries(a);
    if (!entries.length) continue;
    const sighted = entries.filter((e) => pairSighted(all, e, i)).length;
    if (sighted >= 2) return null;
    return `[constant-grounding] Your edit to ${a.p ?? "a file"} embeds a numeric-keyed constant table`
      + ` (${entries.length} entries), and this run never READ those mappings from any source — no`
      + ` observation shows even two of its key→name pairs together. Recalled tables shift (real`
      + ` enums have holes from deleted entries). Find the authoritative table in a reachable source`
      + ` (search installed packages/headers for one of the names), verify at least two entries`
      + ` against it, fix any that differ, and only then call done.`;
  }
  return null;
}
