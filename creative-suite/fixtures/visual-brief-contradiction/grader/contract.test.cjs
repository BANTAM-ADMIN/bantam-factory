const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { analyzeRegion, matchesRegion } = require("../../../grader/semantic-region.cjs");

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const copySafePolicy = {
  anyOf: [
    { horizontal: ["center"] },
    { horizontal: ["right"], quality: ["open"], notVertical: ["upper"] },
  ],
};

test("visual facts override every stale note and copy satisfies constraints", () => {
  const value = JSON.parse(fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, "campaign.json"), "utf8"));
  assert.equal(value.visualFacts.people, 1);
  assert.equal(value.visualFacts.paperBirds, 3);
  assert.ok(analyzeRegion(value.visualFacts.gardenerLocation).horizontal.includes("left"));
  assert.ok(matchesRegion(value.visualFacts.moonLocation, {
    horizontal: ["right"],
    vertical: ["upper"],
  }));
  assert.ok(matchesRegion(value.visualFacts.copySafeRegion, copySafePolicy));
  const corrections = JSON.stringify(value.corrections).toLowerCase();
  for (const signal of ["two", "four", "upper-left", "lower-left"]) assert.match(corrections, new RegExp(signal));
  assert.ok(words(value.headline).length >= 3 && words(value.headline).length <= 6);
  assert.ok(words(value.body).length >= 35 && words(value.body).length <= 55);
  assert.equal(words(value.cta).length, 2);
  assert.doesNotMatch(`${value.headline} ${value.body} ${value.cta}`, /\b(?:future|green|grow)\b/i);
  assert.ok(matchesRegion(
    `${value.placement.region} ${value.placement.rationale}`,
    copySafePolicy,
  ));
});
