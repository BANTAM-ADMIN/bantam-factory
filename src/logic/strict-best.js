// Pick a winner, or admit there isn't one.
//
// This exists because the same three mistakes were made independently in two
// different comparison tools on the same day, in the same direction:
//
//   compare-plan.js       WINNER_ORDER.find((id) => arms.find(a => a.id === id)?.pass)
//   delegate-comparison.js  [...rows].filter(finite).sort((a,b) => a[k]-b[k])[0]
//
// Both sorted or ordered, took the first element, and called it the winner. Both
// therefore reported a TIE as a win. One of them additionally let rows that had
// measured nothing at all (every field defaulting to `?? 0`) sweep every award.
//
// The three rules, in one place so they cannot drift apart again:
//
//   1. Unmeasured never competes. A row whose value is null/undefined/NaN is not
//      a contender -- it is a missing observation. Absent is not zero.
//   2. A tie is not a win. Equal best values yield no winner and a list of the
//      tied rows.
//   3. One contender is not a comparison. Winning against nobody is reported as
//      uncontested, not as a victory.
//
// The caller decides what to print. This decides what is true.

/**
 * @param {object[]} rows
 * @param {(row:object) => number|null} valueOf   the metric; return null when unmeasured
 * @param {{direction?: "min"|"max", labelOf?: (row:object) => string}} [options]
 * @returns {{
 *   winner: object|null,      // strictly best, and only when contested
 *   tied: object[],           // all leaders when >1 share the best value
 *   uncontested: object|null, // the sole contender, when only one measured
 *   best: number|null,
 *   measured: number,
 *   total: number,
 * }}
 */
export function strictBest(rows, valueOf, { direction = "min", labelOf = null } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const scored = all
    .map((row) => ({ row, value: numeric(valueOf(row)) }))
    .filter((entry) => entry.value !== null);

  const empty = {
    winner: null, tied: [], uncontested: null, best: null,
    measured: scored.length, total: all.length,
  };
  if (!scored.length) return empty;

  const best = direction === "max"
    ? Math.max(...scored.map((e) => e.value))
    : Math.min(...scored.map((e) => e.value));
  const leaders = scored.filter((e) => e.value === best).map((e) => e.row);

  // One contender beats nobody. Reported separately so the caller can say
  // "passed, uncontested" instead of either crowning it or denying it happened.
  if (scored.length === 1) {
    return { ...empty, uncontested: leaders[0], best, measured: 1 };
  }
  if (leaders.length > 1) {
    return { ...empty, tied: leaders, best };
  }
  return { ...empty, winner: leaders[0], best };
}

/**
 * One line describing the outcome, in the caller's own vocabulary.
 *
 * @param {ReturnType<strictBest>} result
 * @param {{label: (row:object) => string, name?: string}} options
 */
export function describeBest(result, { label, name = "Best" }) {
  if (!result.measured) return `${name}: n/a (no row measured it)`;
  if (result.tied.length) return `${name}: tie — ${result.tied.map(label).join(", ")}`;
  if (result.uncontested) {
    return `${name}: ${label(result.uncontested)} (uncontested — only 1 of ${result.total} measured it)`;
  }
  const partial = result.measured < result.total
    ? `  (only ${result.measured} of ${result.total} measured it)`
    : "";
  return `${name}: ${label(result.winner)}${partial}`;
}

// A recorded 0 is a real measurement and must be allowed to win. Only genuinely
// absent values are excluded, so this cannot use a falsy check.
function numeric(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
