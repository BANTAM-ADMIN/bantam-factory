// think-budget.js — how many tokens this think may take.
//
// MEASURED (write-compressor, 2026-08-23, pinned run): turn 0's think was 15
// tokens ("let me read the files first"); the first REAL think -- 4096,
// severed mid-sentence -- came at turn 7, right before the first write_file
// of the encoder, and every severed think after it preceded an edit. A deep
// budget pinned to "turn 0" therefore buys nothing: the model has nothing to
// think about until it has read the spec. The analysis phase is "no edits
// yet", and that is where one uninterrupted deep think has a chance to form
// the idea the task actually needs.
//
// So the deep budget applies to every think made BEFORE the first accepted
// edit, and the normal budget after. The first build is the boundary.

/**
 * @param {object} o
 * @param {number} o.normal        the standard per-think budget
 * @param {number} [o.deep]        the analysis-phase budget (0/absent = off)
 * @param {number} [o.editCount]   accepted edits so far in the run
 */
export function thinkBudget({ normal, deep = 0, editCount = 0, grant = false } = {}) {
  const n = Number(normal) > 0 ? Number(normal) : 4096;
  const d = Number(deep) > 0 ? Number(deep) : 0;
  if (!d) return n;
  // A one-shot grant: the caller saw the same verify fail three times after
  // three edits -- the model is re-patching, not re-deriving -- and hands the
  // NEXT think the deep budget so it can re-derive. Staged alongside the
  // analysis-phase rule; the caller owns the grant's lifecycle (set on the
  // repeated-failure hint, cleared once consumed).
  if (grant) return Math.max(n, d);
  return (Number(editCount) || 0) === 0 ? Math.max(n, d) : n;
}
