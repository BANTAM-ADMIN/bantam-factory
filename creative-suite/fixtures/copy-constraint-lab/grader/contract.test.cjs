const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const sentences = (s) => String(s).trim().split(/[.!?]+(?:\s+|$)/).filter((x) => x.trim());

test("copy satisfies form, truthfulness, audience, and product contracts", () => {
  const value = JSON.parse(fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, "launch-copy.json"), "utf8"));
  assert.equal(words(value.headline).length, 5);
  assert.ok(words(value.subhead).length >= 8 && words(value.subhead).length <= 12);
  assert.ok(words(value.body).length >= 55 && words(value.body).length <= 70);
  assert.equal(sentences(value.body).length, 3);
  assert.equal(words(value.cta).length, 2);
  assert.equal(value.proofPoints.length, 3);
  assert.ok(words(value.riskNote).length >= 12 && words(value.riskNote).length <= 20);
  assert.ok(words(value.rationale).length >= 35 && words(value.rationale).length <= 55);
  const all = JSON.stringify(value);
  assert.doesNotMatch(all, /\b(?:revolutionary|seamless|magical|disrupt|AI-powered|future)\b/i);
  assert.match(all, /revision/i);
  assert.match(all, /private|privacy|local/i);
  assert.match(value.riskNote, /offline/i);
  assert.match(value.riskNote, /index/i);
  assert.match(value.audience, /novelist|writer|nonfiction/i);
  assert.doesNotMatch(all, /\b\d+(?:\.\d+)?%|\bcertified\b|\btestimonial\b/i);
});
