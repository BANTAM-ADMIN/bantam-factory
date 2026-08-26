const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { analyzeRegion } = require("../../../grader/semantic-region.cjs");

test("extracts exact text, counts, colors, and spatial evidence", () => {
  const value = JSON.parse(fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, "deliverable.json"), "utf8"));
  assert.equal(value.title, "NIGHT FERRY");
  assert.equal(value.routeCode, "Q7");
  assert.equal(value.departure, "23:40");
  assert.equal(value.pier, "4");
  assert.equal(value.weather, "LIGHT FOG");
  assert.equal(value.diamondCount, 3);
  assert.ok(analyzeRegion(value.clockLocation).horizontal.includes("right"));
  assert.deepEqual(new Set(value.accentColors), new Set(["#37d6c0", "#ed4e87"]));
  const layout = analyzeRegion(value.layoutSummary);
  assert.ok(layout.horizontal.includes("left"));
  assert.ok(layout.horizontal.includes("right"));
});
