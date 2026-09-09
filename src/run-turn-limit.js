// An explicit long-running CLI task still checkpoints and obeys interrupts;
// its checkpoint cadence is not a deadline for reducing the user's scope.
export function parseRunTurnLimit(value, { fallback = 200, restoredTurns = 0 } = {}) {
  const selected = value === undefined || value === null || value === '' ? fallback : value;
  if (selected === 'unlimited') return Infinity;
  const limit = Number(selected);
  if (!['string', 'number'].includes(typeof selected) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('--max-turns must be a positive integer or unlimited');
  }
  if (limit <= restoredTurns) {
    throw new TypeError(`--max-turns is the total trajectory length and must exceed the ${restoredTurns} restored turn(s)`);
  }
  return limit;
}
