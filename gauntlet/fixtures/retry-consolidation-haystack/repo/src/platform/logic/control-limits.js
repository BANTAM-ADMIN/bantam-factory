// Is this number a result, or a marble?
//
// On 2026-07-30 this session reported four pass rates for the same fixture -- 70%,
// 83%, 38%, 50% -- and built a narrative on them ("the fix worked", then "I caused
// a regression"). A p-chart put every one inside the control limits of a single
// stable process. They were the same process. That is Deming's funnel: adjusting
// after every few marbles degrades a stable process, and reading common-cause
// variation as signal is how it happens.
//
// `experiment-power` answers "could this DESIGN detect the effect?" before a run.
// This answers the different question "is this OBSERVED point distinguishable from
// the process I already had?" after one. Sequential tampering needs the second;
// the first does not catch it.
//
// p-chart, 3-sigma, binomial. Crude at small subgroups and deliberately so -- it
// exists to say "you cannot tell", which is the answer far more often than anyone
// wants it to be.
//
// See docs/RELIABILITY-BORROWINGS.md #1

const MIN_BASELINE_RUNS = 15;

/**
 * Control limits for a pass-rate process.
 *
 * @param {{passes:number,runs:number,subgroup:number}} baseline
 */
export function controlLimits({ passes, runs, subgroup = 6 }) {
  const n = Math.max(1, Number(runs) || 0);
  const p = Math.min(1, Math.max(0, (Number(passes) || 0) / n));
  const k = Math.max(1, Number(subgroup) || 1);
  const sigma = Math.sqrt((p * (1 - p)) / k);
  return {
    centre: p,
    sigma,
    subgroup: k,
    baselineRuns: n,
    upper: Math.min(1, p + 3 * sigma),
    lower: Math.max(0, p - 3 * sigma),
    // Below this the "limits" are so wide they cannot reject anything, and quoting
    // them lends false authority to a number that means nothing.
    usable: n >= MIN_BASELINE_RUNS,
  };
}

/** Where an observed subgroup falls relative to the limits. */
export function classifyPoint(limits, { passes, runs }) {
  const n = Math.max(1, Number(runs) || 0);
  const rate = (Number(passes) || 0) / n;
  let verdict = "common-cause";
  if (rate > limits.upper) verdict = "special-cause-high";
  else if (rate < limits.lower) verdict = "special-cause-low";
  return { rate, passes: Number(passes) || 0, runs: n, verdict };
}

/** Human report. Leads with the honest answer, which is usually "you cannot tell". */
export function formatControlChart(limits, points = []) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const lines = [];
  if (!limits.usable) {
    lines.push(`[control-limits] baseline of ${limits.baselineRuns} runs is too small to chart `
      + `(need >= ${MIN_BASELINE_RUNS}). Any limits computed from it are insufficient to reject anything.`);
    return lines.join("\n");
  }
  lines.push(`[control-limits] process centre ${pct(limits.centre)} from ${limits.baselineRuns} baseline runs; `
    + `3-sigma limits at subgroup n=${limits.subgroup}: ${pct(limits.lower)} to ${pct(limits.upper)}`);
  for (const p of points) {
    const tag = p.verdict === "common-cause" ? "not a result" : "REAL CHANGE";
    lines.push(`  ${pct(p.rate).padStart(4)} (${p.passes}/${p.runs})  ${p.verdict.padEnd(19)} ${tag}`);
  }
  if (points.length && points.every((p) => p.verdict === "common-cause")) {
    lines.push("Every point is inside the limits: no change is demonstrated. "
      + "Reporting any of these as an improvement or a regression would be tampering.");
  }
  return lines.join("\n");
}
