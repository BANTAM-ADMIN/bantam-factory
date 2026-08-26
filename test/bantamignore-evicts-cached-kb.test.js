import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGrounding, reconcileGrounding } from "../src/logic/grounding.js";

// 2026-08-24: adding PREFIXTESTING/ (a vendored copy of another project, 1,060
// files) to .bantamignore did nothing to the cached KB — reconcile correctly
// stopped seeing the files and listed them as changed, and refresh then read
// every one of them back from disk. Only a cold rebuild honored the ignore.
// The KB-backed `map brief` made it visible: the vendored frontend topped
// "most-depended modules". A path that the walk would skip must be evicted on
// refresh, not re-indexed.

test("a directory added to .bantamignore leaves the cached KB on the next reconcile", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ignore-evict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w("src/a.js", "export const a = 1;\n");
  w("vendored/lib/b.js", "export const b = 2;\n");
  w("vendored/lib/c.js", 'import { b } from "./b.js";\nexport const c = b;\n');

  const ground = buildGrounding(root);
  assert.ok(ground.factIndex.records.has("vendored/lib/b.js"), "precondition: indexed before the ignore");
  assert.equal(ground.stats.files, 3);

  w(".bantamignore", "vendored\n");
  const rec = reconcileGrounding(ground);
  assert.ok(rec.ok);
  assert.equal(ground.factIndex.records.has("vendored/lib/b.js"), false, "evicted, not re-read");
  assert.equal(ground.factIndex.records.has("vendored/lib/c.js"), false);
  assert.equal(ground.stats.files, 1);
  assert.equal(ground.db.query("depends", "?", "?").length, 0, "derived facts of evicted files are gone too");
});
