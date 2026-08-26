import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("creative coding deliverable exposes pure logic and browser files", async () => {
  for (const file of ["index.html", "styles.css", "app.js", "src/constellation.js"]) {
    assert.equal(fs.existsSync(file), true);
  }
  const mod = await import(`../src/constellation.js?t=${Date.now()}`);
  assert.equal(mod.normalizeText("abc"), "abc");
  assert.equal(mod.createConstellation("ab").length, 2);
  assert.equal(mod.removeLast("ab"), "a");
});
