import assert from "node:assert/strict";
import test from "node:test";

import {
  assessThroughput,
  createThroughputAndonState,
  THROUGHPUT_ANDON_DEFAULTS,
} from "../src/throughput-andon.js";

const BIG = THROUGHPUT_ANDON_DEFAULTS.minPromptTokens + 1000; // a prompt worth judging
const miss = (ratio = 0.05) => ({ inputTokens: BIG, cacheHitTokens: Math.round(BIG * ratio) });
const hit = (ratio = 0.98) => ({ inputTokens: BIG, cacheHitTokens: Math.round(BIG * ratio) });

test("healthy prefix reuse never fires and holds the streak at zero", () => {
  const state = createThroughputAndonState();
  for (let i = 0; i < 10; i++) {
    const r = assessThroughput(hit(), state);
    assert.equal(r.andon, false);
    assert.equal(r.streak, 0);
    assert.ok(r.reuseRatio >= 0.9);
  }
});

test("a sustained cache miss fires exactly once, on the threshold turn", () => {
  const state = createThroughputAndonState();
  const r1 = assessThroughput(miss(), state);
  assert.equal(r1.andon, false, "turn 1 must not fire (one blip is not a leak)");
  assert.equal(r1.streak, 1);
  const r2 = assessThroughput(miss(), state);
  assert.equal(r2.andon, false, "turn 2 must not fire");
  assert.equal(r2.streak, 2);
  const r3 = assessThroughput(miss(), state);
  assert.equal(r3.andon, true, "turn 3 crosses the default streakToAndon=3 and fires");
  assert.equal(r3.streak, 3);
  assert.match(r3.message, /throughput-andon/);
  // The remedy must name the dial that actually fixes the measured case. On the
  // 2026-08-24 tour run history was already byte-stable; the churn was the
  // re-rendered tail (reminder + <open_files> panel), which only the extension
  // trajectory folds away. Naming only BANTAM_IMMUTABLE_HISTORY sent the operator
  // to a knob that could not help.
  assert.match(r3.message, /:context extension|--context-mode extension/);
  assert.match(r3.message, /open_files|tail/);
  // Edge-triggered: keeps missing but does NOT re-fire every subsequent turn.
  const r4 = assessThroughput(miss(), state);
  assert.equal(r4.andon, false, "must not spam after firing");
  assert.equal(r4.streak, 4);
  assert.equal(r4.message, undefined);
});

test("recovery re-arms the alarm so a later regression fires again", () => {
  const state = createThroughputAndonState();
  assessThroughput(miss(), state);
  assessThroughput(miss(), state);
  assert.equal(assessThroughput(miss(), state).andon, true, "first fire");
  // A healthy turn clears the streak and re-arms.
  const recovered = assessThroughput(hit(), state);
  assert.equal(recovered.streak, 0);
  assert.equal(recovered.andon, false);
  // A fresh miss streak fires again.
  assessThroughput(miss(), state);
  assessThroughput(miss(), state);
  assert.equal(assessThroughput(miss(), state).andon, true, "re-fires after recovery");
});

test("small prompts are skipped and do not touch the streak", () => {
  const state = createThroughputAndonState();
  assessThroughput(miss(), state);
  assessThroughput(miss(), state);
  assert.equal(state.lowReuseStreak, 2);
  // A tiny interstitial prompt (below minPromptTokens) neither confirms nor
  // clears the leak — it must not reset the streak, nor advance it.
  const small = assessThroughput({ inputTokens: 100, cacheHitTokens: 0 }, state);
  assert.equal(small.skipped, true);
  assert.equal(small.andon, false);
  assert.equal(state.lowReuseStreak, 2, "small prompt left the streak untouched");
  // The next big miss still crosses the threshold.
  assert.equal(assessThroughput(miss(), state).andon, true);
});

test("cacheHitTokens above inputTokens cannot produce a ratio over 1", () => {
  const state = createThroughputAndonState();
  const r = assessThroughput({ inputTokens: BIG, cacheHitTokens: BIG * 5 }, state);
  assert.equal(r.reuseRatio, 1);
  assert.equal(r.andon, false);
});

test("missing / malformed usage is treated as a skip, never a crash", () => {
  const state = createThroughputAndonState();
  for (const bad of [null, undefined, {}, { inputTokens: "x" }, { cacheHitTokens: 10 }]) {
    const r = assessThroughput(bad, state);
    assert.equal(r.andon, false);
    assert.equal(r.skipped, true);
  }
  assert.equal(state.lowReuseStreak, 0);
});

test("threshold overrides are honored", () => {
  const state = createThroughputAndonState();
  // Stricter: fire after a single miss, and only below 20% reuse.
  const opts = { streakToAndon: 1, reuseFloor: 0.2 };
  assert.equal(assessThroughput(miss(0.05), state, opts).andon, true, "fires on first hard miss");
  // A 30% reuse turn is now "healthy" under reuseFloor=0.2.
  const ok = assessThroughput(hit(0.3), state, opts);
  assert.equal(ok.andon, false);
  assert.equal(ok.streak, 0);
});
