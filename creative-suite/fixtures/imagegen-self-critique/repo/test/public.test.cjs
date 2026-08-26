const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("selection references two generated PNG assets", () => {
  const value = JSON.parse(fs.readFileSync("selection.json", "utf8"));
  assert.equal(value.generatedFiles.length, 2);
  assert.equal(value.generatedFiles.includes(value.chosenFile), true);
  assert.equal(value.generatedFiles.includes(value.rejectedFile), true);
  assert.notEqual(value.chosenFile, value.rejectedFile);
  for (const file of value.generatedFiles) assert.equal(fs.existsSync(file), true);
});
