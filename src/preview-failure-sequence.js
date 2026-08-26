// Keep one measured browser defect fresh until a new preview decides it is closed.
//
// A multi-defect preview is useful evidence, but presenting every item as one
// wall of text makes a small model repeatedly reconstruct the whole checklist.
// This helper turns that report into a serial queue without inventing any new
// diagnosis: one exact measured item is active, one edit is made, then the same
// preview is rerun and the queue is rebuilt from current evidence.

const SOURCE_LOCUS_RE = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+):\s*/g;

/**
 * Split structured preview issues at their file:line anchors. The preview can
 * report one combined sentence ("a.js:10: ... | b.js:20: ...") or one string
 * per issue; both shapes become the same ordered item list.
 */
export function previewFailureItems(preview) {
  if (!preview || preview.status !== "interaction-problems") return [];
  const issues = Array.isArray(preview.interactionIssues)
    ? preview.interactionIssues
    : [];
  const items = [];
  const seen = new Set();

  for (const issue of issues) {
    const text = String(issue ?? "").trim();
    if (!text) continue;
    const matches = [...text.matchAll(SOURCE_LOCUS_RE)];
    if (!matches.length) {
      addItem(items, seen, text);
      continue;
    }
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const next = matches[index + 1];
      const detail = text
        .slice(match.index + match[0].length, next?.index ?? text.length)
        .replace(/\s*[|;]\s*$/, "")
        .trim();
      addItem(items, seen, `${match[1]}:${match[2]}: ${detail}`.trim());
    }
  }
  return items;
}

/**
 * Refresh the serial recovery state from a trusted preview result.
 *
 * A single ordinary issue does not start this protocol. Once a multi-defect
 * episode has started, however, the last remaining item stays focused too.
 */
export function refreshPreviewFailureSequence(preview, query, previous = null) {
  const items = previewFailureItems(preview);
  if (!items.length) return null;
  if (!previous && items.length < 2) return null;
  return {
    items,
    active: items[0],
    query: normalizedPreviewQuery(query, preview),
    editedSincePreview: false,
  };
}

export function notePreviewFailureEdit(sequence) {
  return sequence ? { ...sequence, editedSincePreview: true } : null;
}

export function formatPreviewFailureReanchor(sequence) {
  if (!sequence?.active || !sequence.items?.length) return "";
  const query = sequence.query || "preview interact";
  if (sequence.editedSincePreview) {
    return [
      "MEASURED DEFECT RECHECK — do not resume reconnaissance.",
      `Active defect: ${sequence.active}`,
      `You changed the workspace after this measurement. Your NEXT action should be exactly {"a":"query","q":${JSON.stringify(query)}} so current evidence decides whether this item closed and which single item is next.`,
      "Do not read files or make another speculative edit before that recheck.",
    ].join("\n");
  }
  const remaining = Math.max(0, sequence.items.length - 1);
  return [
    `MEASURED DEFECT RECOVERY — ACTIVE ITEM 1 OF ${sequence.items.length}:`,
    sequence.active,
    `Fix only this measured item now; leave the other ${remaining} item${remaining === 1 ? "" : "s"} parked until fresh evidence advances the queue.`,
    "The current source at its named locus is already in <open_files>. Do not restart broad file reads or reconstruct the whole checklist; make one bounded edit from this evidence.",
    `After that one edit, rerun query ${JSON.stringify(query)} immediately.`,
  ].join("\n");
}

function normalizedPreviewQuery(query, preview) {
  const exact = String(query ?? "").trim();
  if (exact) return exact;
  const entry = String(preview?.entry ?? "").trim();
  const base = entry ? `preview ${entry}` : "preview";
  return preview?.mode === "interact" ? `${base} interact` : base;
}

function addItem(items, seen, item) {
  const value = String(item ?? "").trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  items.push(value);
}
