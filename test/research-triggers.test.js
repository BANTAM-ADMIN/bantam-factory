// The librarian study's central lesson (2026-08-19): felt uncertainty flags
// land on real errors, but the WORST errors carry no flag — a confident
// "bitmask, not an enum" reproduced across four runs. So class membership
// triggers the offer even with zero flags. Fixtures are drawn from the
// study's actual cold answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uncertaintyFlags, claimClassMatches, researchOffer, elicitGaps } from "../src/logic/research-triggers.js";

const CONFIDENT_DELUSION = `general.file_type is a bitmask, not a plain enum.
GGML_TYPE_Q4_K = 13, GGML_TYPE_Q5_K = 14. The canonical table lives in ggml.h.`;

const FLAGGED_ANSWER = `The key is derived from the identifier. I'd want to confirm
the exact manifest attribute that carries the key before relying on it in code.`;

const PLAIN_PROSE = `A factory line beats a lone artisan because inspection is
continuous and defects surface at the station that made them.`;

test("the unflagged delusion still draws an offer via claim classes", () => {
  assert.equal(uncertaintyFlags(CONFIDENT_DELUSION).length, 0, "no felt uncertainty — the dangerous case");
  const classes = claimClassMatches(CONFIDENT_DELUSION);
  assert.ok(classes.some((c) => c.cls === "constant-table"));
  assert.match(researchOffer(CONFIDENT_DELUSION), /research-prone classes/);
});

test("felt uncertainty is detected and offered", () => {
  assert.ok(uncertaintyFlags(FLAGGED_ANSWER).length >= 1);
  assert.match(researchOffer(FLAGGED_ANSWER), /flagged unverified/);
});

test("plain reasoning prose draws no offer", () => {
  assert.equal(researchOffer(PLAIN_PROSE), null);
});

test("version particulars and spec numerics are recognized", () => {
  const c1 = claimClassMatches("TaskGroup was introduced in Python 3.11.");
  assert.ok(c1.some((c) => c.cls === "version-particular"));
  const c2 = claimClassMatches("The scheme obfuscates the first 1040 bytes per RFC-style rules.");
  assert.ok(c2.some((c) => c.cls === "spec-numeric"));
  const c3 = claimClassMatches("The card has 16,384 CUDA cores on a 384-bit bus at 450 W.");
  assert.ok(c3.some((c) => c.cls === "vendor-figure"));
});

test("elicitGaps parses GAP- lines and ignores the instruction echo", async () => {
  const fetchImpl = async (url, opts) => ({ json: async () => ({
    content: "each on its own line beginning with GAP- then a colon\nGAP-1: the exact version\nGAP-2: the key suffix\nsome trailing prose" }) });
  const gaps = await elicitGaps({ endpoint: "http://x", question: "q?", fetchImpl });
  assert.deepEqual(gaps, ["GAP-1: the exact version", "GAP-2: the key suffix"]);
});

test("elicitGaps returns empty on NO-GAPS", async () => {
  const fetchImpl = async () => ({ json: async () => ({ content: "NO-GAPS" }) });
  assert.deepEqual(await elicitGaps({ endpoint: "http://x", question: "q?", fetchImpl }), []);
});
