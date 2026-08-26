import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sourceFileCount } from "../src/logic/repomap.js";
import { decideSeamSteer } from "../src/seam-steer.js";
import { decidePatchAction } from "../src/patch-policy.js";

// countLangs spends its budget on EVERY file it walks, not only source. The
// 400-entry budget sourceFileCount inherited from mapUsable (whose floor is 5)
// is therefore not a count on any repo carrying assets, fixtures or data.
//
// Measured on this repo: 25 source files at a 400 budget, 786 at 4,000, 4,468
// walking everything. Its two consumers compare against 30 ("largeRepo") and
// saturate at 210, so a 4,468-file codebase was classified as fixture territory
// on every run — silently withholding the seam steer, which returns
// {enabled:false, reason:"small-repo"} before reading the task at all, and the
// patch action's feature-integration path. Both exist for exactly that size.

function repoWithAssets(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-large-repo-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  // Alphabetically ahead of src/, and numerous: exactly what starves the sample.
  for (let i = 0; i < 500; i += 1) fs.writeFileSync(path.join(dir, "assets", `a${i}.png`), "x");
  for (let i = 0; i < 120; i += 1) fs.writeFileSync(path.join(dir, "src", `m${i}.js`), "export const x = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("source files behind a wall of assets are still counted", (t) => {
  const dir = repoWithAssets(t);
  assert.equal(sourceFileCount(dir), 120, "all 120 source files must be seen past 500 assets");
  assert.ok(sourceFileCount(dir) > 30, "and the repo must read as large");
});

test("a genuinely small repo still reads as small", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-small-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(dir, "src", `s${i}.js`), "export const y = 1;\n");
  assert.equal(sourceFileCount(dir), 4);
  assert.ok(sourceFileCount(dir) <= 30, "fixture territory must keep its measured defaults");
});

test("the aids that size gate controls become reachable", (t) => {
  // Both read the same boolean. Neither can fire while it is wrong.
  const dir = repoWithAssets(t);
  const large = sourceFileCount(dir) > 30;
  const task = "Add `bantam gates` — a subcommand that reports which done-gates are active for a run configuration and why. Wire it into the CLI dispatch and the help text.";
  assert.equal(decideSeamSteer(task, { largeRepo: large }).enabled, true);
  assert.equal(decidePatchAction(task, "auto", { largeRepo: large }).enabled, true);
});
