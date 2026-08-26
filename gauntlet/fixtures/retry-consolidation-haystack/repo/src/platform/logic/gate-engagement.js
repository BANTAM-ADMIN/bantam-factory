// Was this gate ever evaluated, or is it merely silent?
//
// Measured 2026-07-30 across 516 recorded artifacts: 10 of 15 done-gates never
// fired, six of them default-on. Only `verify_red` records how often it was
// EVALUATED (243/516 runs, 0 fires -- reachable and correctly silent). For the
// other fourteen, "never fired" is ambiguous between "correctly silent" and
// "structurally unreachable", and the anti-spiral gate proved that ambiguity is
// not academic: its trigger could never be satisfied, and it sat inert through a
// recorded 26-turn spiral until someone traced it by hand.
//
// A rejection counter answers "did this gate object?". It cannot answer "was this
// gate ever asked?". Both are needed, and only the second distinguishes a working
// guard from a dead one.
//
// See docs/RELIABILITY-BORROWINGS.md (#4, #5) and
// docs/superpowers/reports/2026-07-30-unchanged-verify-progress-credit.md

/** Gate name -> the metric counting how often it was EVALUATED. */
export const GATE_ENGAGEMENT_METRIC = Object.freeze({
  verify_red: "verifyRedGateEvaluations",
  sibling_symbol: "siblingSymbolGateEvaluations",
  family_convention: "familyConventionGateEvaluations",
  edge_smoke: "edgeSmokeGateEvaluations",
  spec_example: "specExampleGateEvaluations",
  lexical_smoke: "lexicalSmokeGateEvaluations",
  type_contract: "typeContractGateEvaluations",
});

/** Gate name -> the metric counting how often it OBJECTED. */
export const GATE_REJECTION_METRIC = Object.freeze({
  verify_red: "verifyRedDoneRejections",
  sibling_symbol: "siblingSymbolRejections",
  family_convention: "familyConventionRejections",
  edge_smoke: "edgeSmokeRejections",
  spec_example: "specExampleRejections",
  lexical_smoke: "lexicalSmokeRejections",
  type_contract: "typeContractRejections",
});

const VERDICT_ORDER = ["inconsistent", "never-evaluated", "correctly-silent", "active", "not-instrumented"];

/**
 * Aggregate engagement across many runs' metrics objects.
 *
 * @param {Array<object>} metricsList
 * @returns {object} keyed by gate, plus a non-enumerable format()
 */
export function summarizeGateEngagement(metricsList) {
  const list = Array.isArray(metricsList) ? metricsList : [];
  const out = {};
  for (const gate of Object.keys(GATE_ENGAGEMENT_METRIC)) {
    const evalKey = GATE_ENGAGEMENT_METRIC[gate];
    const fireKey = GATE_REJECTION_METRIC[gate];
    let evaluated = 0;
    let fired = 0;
    let instrumented = 0;   // runs that actually carry the evaluation counter
    for (const m of list) {
      // ABSENT is not zero. Artifacts recorded before these counters existed have
      // no key at all, and reading that as "never evaluated" made the first live
      // report scream about all 516 historical runs. Only runs carrying the
      // counter contribute to the evaluated total or the verdict.
      if (m && m[evalKey] !== undefined) {
        instrumented += 1;
        evaluated += Number(m[evalKey]) || 0;
        fired += Number(m?.[fireKey] ?? 0) || 0;
      }
    }
    let verdict;
    if (instrumented === 0) {
      verdict = "not-instrumented";
    } else if (fired > 0 && evaluated === 0) {
      // The gate objected without ever being asked. That is impossible, so the
      // instrumentation is wrong and every number for this gate is suspect.
      verdict = "inconsistent";
    } else if (evaluated === 0) {
      verdict = "never-evaluated";
    } else if (fired === 0) {
      verdict = "correctly-silent";
    } else {
      verdict = "active";
    }
    out[gate] = {
      gate, evaluated, fired, verdict, instrumented,
      hitRate: evaluated ? fired / evaluated : null,
    };
  }
  Object.defineProperty(out, "format", {
    enumerable: false,
    value: () => formatGateEngagement(out),
  });
  return out;
}

/** Human report. Unreachable and inconsistent gates first -- they are the bugs. */
export function formatGateEngagement(summary) {
  const rows = Object.values(summary)
    .filter((r) => r && typeof r === "object" && r.gate)
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
  const lines = ["[gate-engagement] evaluated vs fired, across the supplied runs:"];
  for (const r of rows) {
    const rate = r.hitRate === null ? "  n/a" : `${(r.hitRate * 100).toFixed(1)}%`;
    lines.push(`  ${r.verdict.padEnd(17)} ${r.gate.padEnd(20)} evaluated ${String(r.evaluated).padStart(5)}  fired ${String(r.fired).padStart(4)}  ${rate}`);
  }
  const legacy = rows.filter((r) => r.verdict === "not-instrumented").map((r) => r.gate);
  if (legacy.length) {
    lines.push(`No evaluation data yet (runs predate the counter): ${legacy.join(", ")}.`);
  }
  const dead = rows.filter((r) => r.verdict === "never-evaluated").map((r) => r.gate);
  const bad = rows.filter((r) => r.verdict === "inconsistent").map((r) => r.gate);
  if (bad.length) {
    lines.push(`INSTRUMENTATION BUG: ${bad.join(", ")} recorded rejections without ever being evaluated.`);
  }
  if (dead.length) {
    lines.push(`A gate that is never evaluated is not a gate: ${dead.join(", ")}.`);
    lines.push("Either its trigger is unsatisfiable, or it is disabled in every run measured.");
  }
  return lines.join("\n");
}
