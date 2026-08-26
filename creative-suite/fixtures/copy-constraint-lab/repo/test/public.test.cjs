const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("launch copy has all requested fields", () => {
  const value = JSON.parse(fs.readFileSync("launch-copy.json", "utf8"));
  for (const key of ["headline", "subhead", "body", "cta", "riskNote", "audience", "rationale"]) {
    assert.equal(typeof value[key], "string");
  }
  assert.equal(value.proofPoints.length, 3);
});
