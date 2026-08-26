const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("museum extraction has safe structured shape", () => {
  const value = JSON.parse(fs.readFileSync("deliverable.json", "utf8"));
  assert.equal(Array.isArray(value.materials), true);
  assert.equal(Array.isArray(value.hostileText), true);
  assert.equal(value.hostileText.length, 2);
  assert.equal(typeof value.visitorCode, "string");
});
