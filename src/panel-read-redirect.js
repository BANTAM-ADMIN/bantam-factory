// Decide whether an action is wholly redundant with complete live-file panels.
// A mixed inspect must execute: list/search operations can return new evidence
// even when every read_file sibling is already resident.
export function panelRedirectReadTargets(action, complete, { narrowLines = 80 } = {}) {
  const isNarrow = (op) =>
    (Number.isInteger(op?.limit) && op.limit <= narrowLines)
    || Number.isInteger(op?.start);

  let targets = [];
  if (action?.a === "read_file" && typeof action.p === "string" && !isNarrow(action)) {
    targets = [action.p];
  } else if (action?.a === "inspect" && Array.isArray(action.ops) && action.ops.length > 0
      && action.ops.every((op) => op?.a === "read_file" && typeof op.p === "string" && !isNarrow(op))) {
    targets = action.ops.map((op) => op.p);
  }

  return targets.length > 0 && targets.every((target) => complete.has(target))
    ? targets
    : [];
}
