// A live andon on prompt-prefix cache reuse — jidoka for the one resource we
// cannot recover: TIME.
//
// Root cause of the 2026-08-20 TB2 gpt2-codegolf timeout was CONTEXT, not the
// model. On a local llama.cpp slot (checkpoint-or-nothing prefix reuse) the
// default mutable history rewrote the prompt prefix every turn, so cache_prompt
// bought nothing: each turn reprocessed the full ~19k-token context and
// generation crawled at ~4 tok/s until the 45-minute wall-clock ran out, with a
// nearly-complete GPT-2 still on the belt. The data to catch it was present in
// every completion (usage.cacheHitTokens vs usage.inputTokens) but only ever
// surfaced in a POST-HOC metrics table read after the run. A post-hoc metric is
// an autopsy; this is the smoke alarm — it fires WHILE the run is still going.
//
// The signal is the per-completion cache-hit RATIO on a prompt large enough for
// reuse to matter: cacheHitTokens / inputTokens is ~1 when the prefix reuses and
// ~0 on the pathological full reprocess. It is hardware-independent on purpose —
// a slow GPU and a cache miss look different here, so this fires ONLY on the
// cache miss, never merely because the machine is slow.
//
// This is an OPERATOR/SUPERVISOR-facing andon, NOT a model steer: the model did
// not cause a KV-cache miss and cannot fix one by editing code. The emitted
// event is meant for telemetry and (later) the self-improve controller, which
// can propose the actual remedy (stabilize the prefix / enable append-only
// history / verify cache_prompt is honored) — the recursive kaizen step of
// turning a timed pain point into an automatic fix.

export const THROUGHPUT_ANDON_DEFAULTS = Object.freeze({
  // Ignore small prompts: prefix reuse is irrelevant and noisy when there is
  // barely a prefix to reuse. Only prompts past this size can indicate the
  // full-reprocess pathology.
  minPromptTokens: 2000,
  // "Reused less than half of a large prompt" is a real miss, not jitter. A
  // healthy iterative loop reuses nearly the whole prefix (ratio near 1).
  reuseFloor: 0.5,
  // Require a sustained pattern, not a one-off. The first big turn after a
  // deliberate context compaction legitimately misses; N in a row is the leak.
  streakToAndon: 3,
});

/** Fresh per-run state. One per agent run, like the RepetitionGuard. */
export function createThroughputAndonState() {
  return { lowReuseStreak: 0, fired: false };
}

function nonneg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Judge one completion's prompt-cache reuse and advance the andon state.
 *
 * @param {{inputTokens?:number, cacheHitTokens?:number}|null|undefined} usage
 *        the completion's usage record (from usageFromResponse).
 * @param {{lowReuseStreak:number, fired:boolean}} state  mutated in place.
 * @param {object} [opts]  threshold overrides (see THROUGHPUT_ANDON_DEFAULTS).
 * @returns {{andon:boolean, reuseRatio:number|null, streak:number,
 *            promptTokens:number, skipped?:boolean, message?:string}}
 *          `andon` is true ONLY on the turn the streak first crosses the
 *          threshold (edge-triggered — it will not re-fire every turn). It
 *          re-arms once a healthy turn resets the streak, so a later regression
 *          fires again.
 */
export function assessThroughput(usage, state, opts = {}) {
  const cfg = { ...THROUGHPUT_ANDON_DEFAULTS, ...opts };
  const input = nonneg(usage?.inputTokens);

  // A prompt too small to matter neither confirms nor clears a miss pattern:
  // skip it without touching the streak, so one small interstitial turn between
  // large reprocessing turns does not mask a sustained leak.
  if (input < cfg.minPromptTokens) {
    return { andon: false, reuseRatio: null, streak: state.lowReuseStreak, promptTokens: input, skipped: true };
  }

  const hit = Math.min(input, nonneg(usage?.cacheHitTokens));
  const reuseRatio = hit / input;

  if (reuseRatio >= cfg.reuseFloor) {
    // Healthy reuse — clear the streak and re-arm the alarm.
    state.lowReuseStreak = 0;
    state.fired = false;
    return { andon: false, reuseRatio, streak: 0, promptTokens: input };
  }

  state.lowReuseStreak += 1;
  const cross = state.lowReuseStreak >= cfg.streakToAndon && !state.fired;
  if (cross) state.fired = true;

  return {
    andon: cross,
    reuseRatio,
    streak: state.lowReuseStreak,
    promptTokens: input,
    message: cross ? throughputAndonMessage(state.lowReuseStreak, reuseRatio, input, cfg, opts) : undefined,
  };
}

function throughputAndonMessage(streak, reuseRatio, promptTokens, cfg, { remote = false } = {}) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (remote) {
    return (
      `[throughput-andon] Prompt prefix cache is MISSING: ${streak} consecutive turns reused `
      + `under ${pct(cfg.reuseFloor)} of a ~${promptTokens}-token prompt (last turn ${pct(reuseRatio)}). `
      + `Each turn is reprocessing nearly the whole context. This is a HARNESS/CONTEXT issue, not the model. `
      + `On this remote transport: verify cache_prompt/sessions are honored and the prompt prefix is not `
      + `being rewritten between turns (a re-rendered tail or reordered head breaks provider-side caching).`
    );
  }
  return (
    `[throughput-andon] Prompt prefix cache is MISSING: ${streak} consecutive turns reused `
    + `under ${pct(cfg.reuseFloor)} of a ~${promptTokens}-token prompt (last turn ${pct(reuseRatio)}). `
    + `Each turn is reprocessing nearly the whole context, so generation is crawling and the run may `
    + `time out before it finishes — the way a factory station that suddenly takes an hour to drill three `
    + `holes starves the whole line. This is a HARNESS/CONTEXT issue, not the model, and the model cannot `
    + `fix it. Remedy: on a local llama.cpp slot switch the context dial to extension (\`:context extension\` `
    + `in chat, \`--context-mode extension\` on the command line) so each prompt is a byte-extension of the last `
    + `and the slot's saved checkpoint is reused. Append-only history alone (BANTAM_IMMUTABLE_HISTORY=1) is not `
    + `enough when the churn is the re-rendered tail — the <open_files> panel and the objective reminder — which `
    + `is the usual case: on a hybrid-attention model reuse is checkpoint-granular, so a tail that moves more than `
    + `one ubatch before the previous prompt's end falls back to the head checkpoint every turn. On a remote `
    + `provider, verify cache_prompt is honored and the prompt prefix is not being rewritten each turn.`
  );
}
