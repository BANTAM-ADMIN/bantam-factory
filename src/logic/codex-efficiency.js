// Where did this Codex run spend tokens?
//
// Every efficiency change made on 2026-07-31 was found by hand-writing a throwaway
// script against a recorded artifact, and the two that mattered most were sitting
// in telemetry BANTAM already collected and nothing ever read:
//
//   promptChurn.firstRewrittenSections { openFiles: 8 }     <- a rewritten section
//   promptChurn.replacedSuffixChars  21,820                 <- rewritten, not added
//   codexPromptDelivery.savedRatio   0.367                  <- limited delivery savings
//
// The reusable output of that work is not the fixes; it is this report. Reading a
// recorded run costs seconds of local compute, while re-running one costs a Codex
// call, so the cheapest possible loop is: change prompt assembly, replay the
// numbers, and only spend a call once the local metrics move.

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const TOKEN_KEYS = ['input', 'cacheHit', 'cacheMiss', 'output', 'reasoning'];
function callTokens(call) {
  const u = call?.response?.normalized?.usage ?? {};
  let input = count(u.inputTokens), hit = count(u.cacheHitTokens), miss = count(u.cacheMissTokens);
  if (input === null && hit !== null && miss !== null) input = count(hit + miss);
  if (miss === null && input !== null && hit !== null && hit <= input) miss = input - hit;
  if (input !== null && hit !== null && (hit > input || (miss !== null && hit + miss !== input))) {
    hit = null; miss = null;
  }
  return { input, cacheHit: hit, cacheMiss: miss, output: count(u.outputTokens), reasoning: count(u.reasoningTokens) };
}

function tokenTotals(calls) {
  const rows = calls.map(callTokens);
  return Object.fromEntries(TOKEN_KEYS.map(key => [key,
    rows.length && rows.every((r, i) => r[key] !== null && calls[i]?.response?.normalized?.usage?.complete !== false)
      ? count(rows.reduce((sum, r) => sum + r[key], 0)) : null]));
}

/** Cache and delivery totals for one recorded run. */
export function codexEfficiency(artifact) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  const delivery = artifact?.metrics?.codexPromptDelivery ?? {};
  const churn = artifact?.metrics?.promptChurn ?? {};
  const threads = artifact?.metrics?.codexThreads ?? {};

  const tokens = tokenTotals(calls), { input, cacheHit: hit, cacheMiss: miss } = tokens;
  const phases = { initial: [], continuation: [], unknown: [] }, uncachedContinuations = [];
  for (const [index, call] of calls.entries()) {
    const reused = call?.response?.normalized?.codexThread?.threadReused;
    const phase = reused === false ? 'initial' : reused === true ? 'continuation' : 'unknown';
    phases[phase].push(call);
    const measured = callTokens(call);
    if (phase === 'continuation' && measured.input > 0 && measured.cacheHit === 0
        && call?.response?.normalized?.usage?.complete !== false) {
      uncachedContinuations.push({ callIndex: call.index ?? index, inputTokens: measured.input,
        deliveryMode: call?.response?.normalized?.codexPromptDelivery?.mode ?? null });
    }
  }

  const turns = Array.isArray(artifact?.turns) ? artifact.turns.length : calls.length;

  // Rewritten bytes are the actionable number. Appended bytes are the cost of
  // making progress; replaced bytes are the cost of changing our mind about what
  // we already said. Rewrites can increase delivery and reduce prefix reuse;
  // the provider's recorded counters establish the actual token impact.
  const replaced = Number(churn.replacedSuffixChars) || 0;
  const added = Number(churn.addedSuffixChars) || 0;

  return {
    turns,
    status: artifact?.result?.status ?? null,
    contract: artifact?.result?.contract
      ? { passed: artifact.result.contract.passed, tests: artifact.result.contract.tests }
      : null,
    tokens,
    cacheHitRatio: input && hit !== null ? hit / input : null,
    perTurn: turns ? { cacheMiss: miss === null ? null : miss / turns, replacedChars: replaced / turns } : null,
    phases: Object.fromEntries(Object.entries(phases).map(([phase, calls]) => [phase, { calls: calls.length, tokens: tokenTotals(calls) }])),
    uncachedContinuations,
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
const number = value => value === null || value === undefined ? 'unknown' : String(value);

/** Human report, leading with the number that is worth acting on. */
export function formatCodexEfficiency(report, label = "") {
  const r = report;
  const lines = [];
  const head = label ? `[codex-efficiency] ${label}` : "[codex-efficiency]";
  const verdict = r.contract ? `${r.contract.passed}/${r.contract.tests} hidden` : (r.status ?? "?");
  lines.push(`${head}  ${r.turns} turns  ${verdict}`);
  lines.push(`  tokens     in ${number(r.tokens.input)}  (hit ${number(r.tokens.cacheHit)} / miss ${number(r.tokens.cacheMiss)}, `
    + `${pct(r.cacheHitRatio)} cached)  out ${number(r.tokens.output)}  reasoning ${number(r.tokens.reasoning)}`);
  for (const [phase, title] of [['initial', 'thread starts'], ['continuation', 'continuations'], ['unknown', 'unclassified']]) {
    const p = r.phases?.[phase];
    if (p?.calls) lines.push(`  ${title.padEnd(13)} ${p.calls} calls · input ${number(p.tokens.input)} · uncached ${number(p.tokens.cacheMiss)}`);
  }
  if (r.uncachedContinuations?.length) {
    lines.push(`  zero-cache continuations at model call(s): ${r.uncachedContinuations.map(c => c.callIndex).join(', ')}.`);
    lines.push('  These are reported cache misses on reused threads; inspect delivery evidence before assigning a cause.');
  }
  lines.push(`  delivery   ${r.delivery.deltaCalls}/${r.delivery.calls} delta, `
    + `${r.delivery.fallbackCalls} fallback, saved ${pct(r.delivery.savedRatio)}`);
  lines.push(`  churn      prefix kept ${pct(r.churn.commonPrefixRatio)}  `
    + `rewritten ${r.churn.replacedChars} vs appended ${r.churn.addedChars} `
    + `(${pct(r.churn.rewriteRatio)} of change is rewrite)`);

  // A section that grew keeps its prior bytes intact; actionHistory grows every
  // turn by construction, so the changed-section count names it almost always and
  // means nothing. An earlier version of this report led with that number and told
  // readers it showed where history was being rewritten. It did not.
  const rewritten = Object.entries(r.churn.firstRewrittenSections ?? {})
    .filter(([name]) => name !== "none")
    .sort((a, b) => b[1] - a[1]);
  if (rewritten.length) {
    lines.push(`  REWRITES history in: ${rewritten.map(([k, v]) => `${k} x${v}`).join(", ")}`);
    lines.push("  ^ already-sent bytes changed here; compare delivery and provider cache counters.");
    lines.push("    Appended text also counts as input; unchanged prefixes can be reused.");
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
