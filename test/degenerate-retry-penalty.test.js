import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenAiBody } from "../src/openai-transport.js";

// Advice alone cannot stop a sampler that has already collapsed: the retry
// re-samples the same distribution and loops again. The certified server stack
// runs --repeat-penalty 1.0 --presence-penalty 0.0, both disabled on purpose,
// because penalising repetition degrades code where repeated tokens are correct.
// So the penalty is opt-in per request, applied only after a degenerate output
// has actually been observed.

test("no penalty is sent unless a caller asks", () => {
  const b = buildOpenAiBody({ prompt: "x", sampling: { nPredict: 100, temperature: 1 } });
  assert.equal("presence_penalty" in b, false, "a first attempt must sample exactly as before");
});

test("an asked-for penalty reaches the wire", () => {
  const b = buildOpenAiBody({ prompt: "x", sampling: { nPredict: 100, temperature: 1, presencePenalty: 0.6 } });
  assert.equal(b.presence_penalty, 0.6);
});

test("a zero penalty is treated as absent, not sent as 0", () => {
  const b = buildOpenAiBody({ prompt: "x", sampling: { nPredict: 100, presencePenalty: 0 } });
  assert.equal("presence_penalty" in b, false);
});
