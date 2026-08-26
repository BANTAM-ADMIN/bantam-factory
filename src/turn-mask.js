// Per-turn grammar mask composition.
//
// Once an investigation budget is spent (or a spiral is detected) the harness
// removes verbs from the action grammar so the model literally CANNOT take the
// wrong move — a message the model can ignore becomes a grammar it cannot. But
// several masks can be active on the same turn, and they compose. The
// composition was inline in the agent loop and had a silent defect: a co-active
// wrap-up / force-edit mask re-excluded a verb that a document-only protocol
// deliberately kept available, making a MANDATED action grammatically
// impossible. Extracted here so the composed exclusion set is unit-testable in
// isolation and the anti-trap invariant lives in one place.
// (Task-3 mask-composition bug, verified 2026-07-16.)

// Interactive wrap-up: once the investigation budget is spent, these verbs are removed from the
// grammar so the model literally cannot investigate further — it must answer or edit.
export const WRAP_UP_MASK = ["read_file", "list_dir", "search", "inspect", "shell", "query"];
// A revision checkpoint is document-only, not blindly edit-only. Exact source
// bytes can be clipped from <open_files>; preserving read_file lets the model
// recover the pending document instead of retrying stale text forever. Other
// reconnaissance, shell, tests, and completion remain unavailable.
export const DOCUMENT_REVISION_MASK = [...WRAP_UP_MASK.filter((verb) => verb !== "read_file"), "done", "respond"];
// A document review is also read-driven: the protocol REQUIRES a whole-file read
// of the pending document before it can be judged, so read_file is likewise
// absent here on purpose.
export const DOCUMENT_REVIEW_MASK = ["list_dir", "search", "inspect", "shell", "query", "done", "respond"];

/**
 * Compose the per-turn grammar exclusion set. Pure: given the turn's mask flags,
 * returns the array of verbs to remove from the action grammar (order preserved
 * for stable grammar-cache keys).
 *
 * Anti-trap invariant: the document-only protocols (revision & review) MANDATE a
 * whole-file read to recover the pending document's exact bytes, which is why
 * read_file is deliberately absent from DOCUMENT_REVISION_MASK / DOCUMENT_REVIEW_MASK.
 * But a co-active wrap-up / force-edit mask seeds the set with WRAP_UP_MASK (which
 * lists read_file), and a read_file repeat-escape mask can add it too — either
 * would re-exclude read_file and leave the required read grammatically impossible
 * that turn (the exact trap this function was extracted to close). So on any
 * document-only turn, read_file is re-permitted LAST, after every other mask has
 * been composed, so the exemption survives composition unconditionally.
 */
export function composeExcludeVerbs({
  useGrammar = true,
  baseExcludeVerbs = [],
  forceWrapUp = false,
  forceBuildEdit = false,
  documentRevisionTurn = false,
  documentReviewTurn = false,
  lineEditRecoveryTurn = false,
  maskedVerbForTurn = null,
  patchEnabled = false,
} = {}) {
  const exclude = [...baseExcludeVerbs];
  const add = (verb) => { if (!exclude.includes(verb)) exclude.push(verb); };
  if (forceWrapUp) {
    for (const verb of WRAP_UP_MASK) add(verb);
  }
  // After the build-first veto: one turn where respond is masked too, so an edit is the only exit.
  if (forceBuildEdit && useGrammar) {
    for (const verb of WRAP_UP_MASK) add(verb);
    add("respond");
  }
  if (documentRevisionTurn && useGrammar) {
    for (const verb of DOCUMENT_REVISION_MASK) add(verb);
    add("replace");
    if (patchEnabled) add("patch");
  } else if (documentReviewTurn && useGrammar) {
    for (const verb of DOCUMENT_REVIEW_MASK) add(verb);
  }
  if (lineEditRecoveryTurn && useGrammar) {
    add("replace");
    if (patchEnabled) add("patch");
  }
  if (maskedVerbForTurn) add(maskedVerbForTurn);
  // Anti-trap invariant (see the docstring). Enforced LAST so it dominates every
  // other mask that may have re-added read_file during composition.
  if ((documentRevisionTurn || documentReviewTurn) && useGrammar) {
    const readIndex = exclude.indexOf("read_file");
    if (readIndex !== -1) exclude.splice(readIndex, 1);
  }
  return exclude;
}
