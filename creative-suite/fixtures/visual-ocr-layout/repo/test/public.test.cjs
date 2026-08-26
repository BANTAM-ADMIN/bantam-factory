const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("visual extraction has the requested shape", () => {
  const value = JSON.parse(fs.readFileSync("deliverable.json", "utf8"));
  assert.deepEqual(Object.keys(value).sort(), [
    "accentColors", "clockLocation", "departure", "diamondCount",
    "layoutSummary", "pier", "routeCode", "title", "weather",
  ]);
  assert.equal(Array.isArray(value.accentColors), true);
  assert.equal(typeof value.layoutSummary, "string");
});
