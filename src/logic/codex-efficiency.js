// What did this Codex run actually cost, and where did it leak?
//
// Every efficiency change made on 2026-07-31 was found by hand-writing a throwaway
// script against a recorded artifact, and the two that mattered most were sitting
// in telemetry BANTAM already collected and nothing ever read:
//
//   promptChurn.firstChangedSections { actionHistory: 8 }   <- every turn rewrote
//   promptChurn.replacedSuffixChars  21,820                 <- rewritten, not added
//   codexPromptDelivery.savedRatio   0.367                  <- delta paying twice
//
// The reusable output of that work is not the fixes; it is this report. Reading a
// recorded run costs seconds of local compute, while re-running one costs a Codex
// call, so the cheapest possible loop is: change prompt assembly, replay the
// numbers, and only spend a call once the local metrics move.

/** Cache and delivery totals for one recorded run. */
export function codexEfficiency(artifact) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  const delivery = artifact?.metrics?.codexPromptDelivery ?? {};
  const churn = artifact?.metrics?.promptChurn ?? {};
  const threads = artifact?.metrics?.codexThreads ?? {};

  let hit = 0;
  let miss = 0;
  let out = 0;
  let reasoning = 0;
  for (const call of calls) {
    const usage = call?.response?.normalized?.usage ?? {};
    hit += Number(usage.cacheHitTokens) || 0;
    miss += Number(usage.cacheMissTokens) || 0;
    out += Number(usage.outputTokens) || 0;
    reasoning += Number(usage.reasoningTokens) || 0;
  }

  const turns = Array.isArray(artifact?.turns) ? artifact.turns.length : calls.length;
  const input = hit + miss;

  // Rewritten bytes are the actionable number. Appended bytes are the cost of
  // making progress; replaced bytes are the cost of changing our mind about what
  // we already said, and they are paid twice -- once in cache misses and once in
  // delta re-delivery.
  const replaced = Number(churn.replacedSuffixChars) || 0;
  const added = Number(churn.addedSuffixChars) || 0;

  return {
    turns,
    status: artifact?.result?.status ?? null,
    contract: artifact?.result?.contract
      ? { passed: artifact.result.contract.passed, tests: artifact.result.contract.tests }
      : null,
    tokens: { input, cacheHit: hit, cacheMiss: miss, output: out, reasoning },
    cacheHitRatio: input ? hit / input : null,
    perTurn: turns ? { cacheMiss: miss / turns, replacedChars: replaced / turns } : null,
    delivery: {
      calls: Number(delivery.calls) || 0,
      deltaCalls: Number(delivery.deltaCalls) || 0,
      fallbackCalls: Number(delivery.fallbackCalls) || 0,
      savedRatio: typeof delivery.savedRatio === "number" ? delivery.savedRatio : null,
    },
    churn: {
      commonPrefixRatio: typeof churn.commonPrefixRatio === "number" ? churn.commonPrefixRatio : null,
      replacedChars: replaced,
      addedChars: added,
      // Above ~0 means history is being rewritten rather than extended. Zero is
      // the goal; the run this module was written from sat at 0.57.
      rewriteRatio: added + replaced ? replaced / (added + replaced) : null,
      firstChangedSections: churn.firstChangedSections ?? {},
      firstRewrittenSections: churn.firstRewrittenSections ?? {},
    },
    threads: {
      mode: threads.mode ?? null,
      unique: Number(threads.uniqueThreads) || 0,
      rebased: Number(threads.rebasedCalls) || 0,
    },
  };
}

const pct = (x) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "n/a");

/** Human report, leading with the number that is worth acting on. */
export function formatCodexEfficiency(report, label = "") {
  const r = report;
  const lines = [];
  const head = label ? `[codex-efficiency] ${label}` : "[codex-efficiency]";
  const verdict = r.contract ? `${r.contract.passed}/${r.contract.tests} hidden` : (r.status ?? "?");
  lines.push(`${head}  ${r.turns} turns  ${verdict}`);
  lines.push(`  tokens     in ${r.tokens.input}  (hit ${r.tokens.cacheHit} / miss ${r.tokens.cacheMiss}, `
    + `${pct(r.cacheHitRatio)} cached)  out ${r.tokens.output}  reasoning ${r.tokens.reasoning}`);
  lines.push(`  delivery   ${r.delivery.deltaCalls}/${r.delivery.calls} delta, `
    + `${r.delivery.fallbackCalls} fallback, saved ${pct(r.delivery.savedRatio)}`);
  lines.push(`  churn      prefix kept ${pct(r.churn.commonPrefixRatio)}  `
    + `rewritten ${r.churn.replacedChars} vs appended ${r.churn.addedChars} `
    + `(${pct(r.churn.rewriteRatio)} of change is rewrite)`);

  // Only REWRITTEN sections are actionable. A section that merely grew costs
  // nothing -- everything already sent stays valid -- and actionHistory grows every
  // turn by construction, so the changed-section count names it almost always and
  // means nothing. An earlier version of this report led with that number and told
  // readers it showed where history was being rewritten. It did not.
  const rewritten = Object.entries(r.churn.firstRewrittenSections ?? {})
    .filter(([name]) => name !== "none")
    .sort((a, b) => b[1] - a[1]);
  if (rewritten.length) {
    lines.push(`  REWRITES history in: ${rewritten.map(([k, v]) => `${k} x${v}`).join(", ")}`);
    lines.push("  ^ already-sent bytes changed here; each rewrite is paid twice, in cache");
    lines.push("    misses and in delta re-delivery. Growth elsewhere is free.");
  } else if (Object.keys(r.churn.firstRewrittenSections ?? {}).length) {
    lines.push("  no section rewrote already-sent bytes: every change was pure growth.");
  } else if (r.churn.commonPrefixRatio !== null) {
    // Absent is not zero. A run recorded before this metric existed must not read
    // as a run with no rewrites -- that is the same mistake as scoring a missing
    // grader 0/0 or an absent gate counter as never-fired.
    lines.push("  rewrite locations NOT RECORDED for this run (predates the metric);");
    lines.push("    the rewritten-vs-appended totals above still apply.");
  }
  if (r.threads.rebased) {
    lines.push(`  WARNING  ${r.threads.rebased} thread rebase(s): the whole prompt was re-sent.`);
  }
  return lines.join("\n");
}
