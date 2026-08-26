const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("campaign deliverable has visual audit and copy", () => {
  const value = JSON.parse(fs.readFileSync("campaign.json", "utf8"));
  assert.equal(typeof value.visualFacts, "object");
  assert.equal(Array.isArray(value.corrections), true);
  assert.equal(typeof value.headline, "string");
  assert.equal(typeof value.body, "string");
  assert.equal(typeof value.cta, "string");
  assert.equal(typeof value.placement, "object");
});
