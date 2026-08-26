const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const pngSize = (file) => {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString(), "PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

test("generated assets are real and selection records visual critique", () => {
  const root = process.env.CANDIDATE_ROOT;
  const value = JSON.parse(fs.readFileSync(path.join(root, "selection.json"), "utf8"));
  assert.equal(value.generatedFiles.length, 2);
  assert.equal(new Set(value.generatedFiles).size, 2);
  for (const rel of value.generatedFiles) {
    assert.match(rel, /^assets\/generated\/.+\.png$/i);
    const size = pngSize(path.join(root, rel));
    assert.ok(size.width >= 512 && size.height >= 512);
  }
  assert.equal(value.generatedFiles.includes(value.chosenFile), true);
  assert.equal(value.generatedFiles.includes(value.rejectedFile), true);
  assert.notEqual(value.chosenFile, value.rejectedFile);
  assert.ok(value.chosenEvidence.length >= 3);
  assert.ok(value.rejectedEvidence.length >= 2);
  assert.ok(
    typeof value.briefCoverage.chosen === "string"
      || (Array.isArray(value.briefCoverage.chosen) && value.briefCoverage.chosen.length > 0),
  );
  assert.ok(
    typeof value.briefCoverage.missing === "string"
      || Array.isArray(value.briefCoverage.missing),
  );
  assert.ok(words(value.finalAltText).length >= 25 && words(value.finalAltText).length <= 45);
});
