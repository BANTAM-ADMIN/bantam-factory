import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideJevAdaptive, digestNote, verifiedPoints, wantsDigest } from "../src/factory.js";

const review = "the screen flashes for a second every 30 seconds or so .";

describe("factory digest station", () => {
  it("keeps only points whose quote is really in the text", () => {
    const points = verifiedPoints('"the screen flashes" | display stability | negative\n"battery lasts all day" | battery life | positive\nNONE', review);
    assert.deepEqual(points, [{ quote: "the screen flashes", about: "display stability", sentiment: "negative" }]);
    assert.match(digestNote(points), /^DIGEST[^]*"the screen flashes" \| about: display stability \| negative/);
    assert.equal(digestNote([]), null);
  });

  it("applies to one short text with a large family of candidates", () => {
    const family = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, { type: "choice", instructions: `pair ${i}`, criteria: { yes: "present", no: "absent" } }]));
    assert.ok(wantsDigest(JSON.stringify({ review }), family));
    assert.ok(!wantsDigest(JSON.stringify({ review }), { a: family.c0, b: family.c1 }), "a small row");
    assert.ok(!wantsDigest("x".repeat(5000), family), "a long text");
  });

  it("adaptive: every candidate read sees the verified digest", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    let digests = 0;
    const reader = {
      complete: async () => { digests += 1; return { text: '"the screen flashes" | display | negative\n"great keyboard" | keyboard | positive', promptTokens: 1 }; },
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => { seen.push(user); return { probabilities: Object.fromEntries(compiled.labels.map(({ label }, i) => [label, i === 0 ? 0.99 : 0.01])), promptTokens: 1 }; },
    };
    const questions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, { type: "choice", instructions: `Is pair ${i} present?`, criteria: { yes: "present", no: "absent" } }]));
    await decideJevAdaptive({ reader, pool, state: { review }, questions, digestFirst: true });
    assert.equal(digests, 1, "one digest for the row");
    assert.ok(seen.every((user) => user.includes('"the screen flashes" | about: display') && !user.includes("great keyboard")), "the invented quote is dropped");
  });
});
