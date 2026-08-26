// prefix-stability.js — does the prompt actually extend, the way the mode promises?
//
// The `extension` trajectory's whole justification is that each prompt is a
// byte-level extension of the last, so a local llama.cpp slot re-prefills only
// the new tail. Nothing verified that. It is not verified by the trajectory code
// either, because a SECOND, independent context manager runs afterwards:
// capTurns() -> budgetTurns(), which slides its window forward and DROPS THE
// OLDEST TURNS whenever history exceeds historyCharBudget. That rewrites the
// prompt immediately after the system block, which is the most expensive place
// a prompt can change.
//
// MEASURED on write-compressor (2026-08-22, local, extension): 9 of 67 calls
// re-prefilled 77-80% of a ~53k-token prompt. First divergence sat at block 2 —
// 12,967 tokens in, 23% of the prompt, exactly the system block's length. Those
// 9 calls cost 175s of the run's 242s of prefill (72%) in a run that died 5
// bytes short of passing with ~36s left on the clock.
//
// Two managers, one promise, no gauge on the seam. This is the gauge.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The prompt a recorded call sent, or "". */
function promptOf(call) {
  let body = call?.request?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return ""; }
  }
  return typeof body?.prompt === "string" ? body.prompt : "";
}

function timings(call) {
  return call?.response?.normalized?.timings ?? {};
}

/** Longest common prefix length, in characters. */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Walk consecutive calls and report every prompt that is NOT a pure extension
 * of its predecessor. Reports in characters and, where the server told us, in
 * the tokens it actually had to re-prefill — the definitive gauge.
 *
 * Note on within-turn pairs: a turn's action call legitimately extends its think
 * call (the prompt gains the generated reasoning), so both are covered by the
 * same rule and no special-casing is needed.
 */
export function analyzePrefixStability(artifact, { charsPerToken = 2.92 } = {}) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  const prompts = calls.map(promptOf);
  const usable = prompts.filter(Boolean).length;
  if (usable < 2) return null;

  const breaks = [];
  let prefillTokens = 0;
  let prefillSeconds = 0;
  let wastedTokens = 0;
  let wastedSeconds = 0;

  for (let i = 1; i < prompts.length; i += 1) {
    const prev = prompts[i - 1];
    const cur = prompts[i];
    const t = timings(calls[i]);
    const pn = num(t.prompt_n);
    const ms = num(t.prompt_ms);
    prefillTokens += pn;
    prefillSeconds += ms / 1000;
    if (!prev || !cur) continue;

    const common = commonPrefix(prev, cur);
    // A pure extension shares ALL of the previous prompt.
    if (common >= prev.length) continue;

    const lostChars = prev.length - common;
    // WASTE is not the whole re-prefill. Even a pure extension must prefill the
    // bytes that are genuinely new. Waste is only the part that WAS cached and
    // had to be recomputed because the divergence sat behind it — measured as
    // the re-prefill MINUS the new content. Counting the whole call as waste
    // (the first version of this gauge) made every run look 90% wasteful, which
    // is close to tautological: extensions prefill little by construction.
    const newTokens = Math.max(0, (cur.length - prev.length) / charsPerToken);
    const wastedHere = Math.max(0, pn - newTokens);
    const wastedFraction = pn > 0 ? wastedHere / pn : 0;
    // What the divergence cost beyond an extension: everything from the
    // divergence point to the end had to be recomputed.
    const recomputed = (cur.length - common) / charsPerToken;
    breaks.push({
      call: i,
      divergedAtChar: common,
      divergedAtPct: cur.length ? common / cur.length : 0,
      lostChars,
      recomputedTokens: Math.round(recomputed),
      prefilledTokens: pn,
      wastedTokens: Math.round(wastedHere),
      seconds: ms / 1000,
    });
    wastedTokens += wastedHere;
    wastedSeconds += (ms / 1000) * wastedFraction;
  }

  return {
    calls: prompts.length,
    breaks,
    breakCount: breaks.length,
    prefillTokens,
    prefillSeconds,
    wastedTokens,
    wastedSeconds,
    wastedShareOfPrefill: prefillSeconds ? wastedSeconds / prefillSeconds : 0,
    // The shallowest divergence is the worst one: it invalidates the most.
    shallowestPct: breaks.length ? Math.min(...breaks.map((b) => b.divergedAtPct)) : null,
  };
}

const s1 = (x) => `${num(x).toFixed(1)}s`;

/** Human report. Silent when the invariant held. */
export function formatPrefixStability(a) {
  if (!a || !a.breakCount) return [];
  const out = [];
  out.push(
    `prefix breaks: ${a.breakCount} of ${a.calls} calls were NOT extensions of the previous prompt`,
  );
  out.push(
    `  cost ${s1(a.wastedSeconds)} of ${s1(a.prefillSeconds)} prefill`
    + ` (${Math.round(100 * a.wastedShareOfPrefill)}%)`
    + `  ·  shallowest divergence at ${Math.round(100 * (a.shallowestPct ?? 0))}% of the prompt`,
  );
  out.push(
    "  a break this shallow means history was rewritten near its HEAD —"
    + " the signature of the history budget dropping oldest turns.",
  );
  for (const b of a.breaks.slice(0, 5)) {
    out.push(
      `    call ${String(b.call).padStart(3)}`
      + ` diverged at ${Math.round(100 * b.divergedAtPct)}% ·`
      + ` ${b.prefilledTokens.toLocaleString()} tokens re-prefilled · ${s1(b.seconds)}`,
    );
  }
  return out;
}
