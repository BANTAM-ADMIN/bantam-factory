// A sol bridge lane (card 20) showed "⚠ ... this is usually --ubatch-size" —
// llama.cpp advice on a remote chat transport where no such knob exists, plus
// a cold 2-turn session where low reuse is EXPECTED. A gauge that names the
// wrong mechanism is a bench defect: the operator debugs a knob that isn't
// there. Advice must speak the transport it's measuring.

import assert from "node:assert/strict";
import test from "node:test";
import { formatPrefixReuse } from "../src/model-usage.js";
import { assessThroughput, createThroughputAndonState, THROUGHPUT_ANDON_DEFAULTS } from "../src/throughput-andon.js";

const LOW = { inputTokens: 40000, cacheHitTokens: 11000 };

test("local low reuse keeps the ubatch advice", () => {
  const line = formatPrefixReuse(LOW);
  assert.match(line, /--ubatch-size/);
});

test("remote low reuse names the remote mechanism, never ubatch", () => {
  const line = formatPrefixReuse(LOW, { remote: true });
  assert.match(line, /prefix reuse: 28%/);
  assert.doesNotMatch(line, /ubatch/);
  assert.match(line, /cache_prompt|session|prefix is rewritten/i);
});

test("a short remote run is quiet — cold sessions are expected to reuse little", () => {
  const line = formatPrefixReuse({ inputTokens: 40000, cacheHitTokens: 11000, requests: 2 }, { remote: true });
  assert.doesNotMatch(line, /⚠/);
});

test("the mid-run andon drops local remedies on a remote transport", () => {
  const BIG = THROUGHPUT_ANDON_DEFAULTS.minPromptTokens + 1000;
  const miss = { inputTokens: BIG, cacheHitTokens: Math.round(BIG * 0.05) };
  const localState = createThroughputAndonState();
  const remoteState = createThroughputAndonState();
  let localMsg, remoteMsg;
  for (let i = 0; i < 10; i++) {
    const l = assessThroughput(miss, localState); if (l.andon) localMsg = l.message;
    const r = assessThroughput(miss, remoteState, { remote: true }); if (r.andon) remoteMsg = r.message;
  }
  assert.match(localMsg, /--context-mode extension/);
  assert.match(remoteMsg, /cache_prompt/);
  assert.doesNotMatch(remoteMsg, /ubatch|--context-mode/);
});
