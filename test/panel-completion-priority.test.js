import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fullyRenderedPaths, renderOpenFiles } from "../src/open-files.js";

// Measured 2026-08-15 (ticket A parity reruns): bin/bantam.js (218KB) sat first
// in the open list, took the 4x primary weight, and starved gate-policy.js
// (11.2KB) into a fragment — which the model then re-read six times. A file
// that cannot be rendered completely at any budget must not consume the budget
// that would complete a smaller one: fragment bytes do not prevent re-reads,
// completed files do.
test("an un-completable giant does not starve completable files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-priority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "giant.js"), Array.from({ length: 6000 }, (_, i) => `// giant line ${i}`).join("\n"));
  fs.writeFileSync(path.join(dir, "policy.js"), Array.from({ length: 300 }, (_, i) => `export const p${i} = ${i};`).join("\n"));
  fs.writeFileSync(path.join(dir, "small.js"), "export const tiny = 1;\n");

  const list = ["giant.js", "policy.js", "small.js"];   // giant is primary
  const complete = fullyRenderedPaths(dir, list, {});
  assert.ok(complete.has("policy.js"), "the completable mid-size file must render whole");
  assert.ok(complete.has("small.js"), "the small file must render whole");
  assert.ok(!complete.has("giant.js"), "the giant cannot be complete, and that is fine");

  const panel = renderOpenFiles(dir, list, {});
  const giantEntry = panel.slice(panel.indexOf("# giant.js"), panel.indexOf("# policy.js"));
  // The invariant is "does not starve", not "stays small": once every
  // completable file is whole, leftover budget SHOULD go to the giant rather
  // than sit unspent (2026-08-16 — ticket B ran with 10KB unused while both
  // files it had to edit were clipped). So: the giant must not dominate, and
  // the completable files above must still be complete.
  assert.ok(giantEntry.length < panel.length * 0.75,
    `the giant must not dominate the panel (got ${giantEntry.length} of ${panel.length})`);
});
