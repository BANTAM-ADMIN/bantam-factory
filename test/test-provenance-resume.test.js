import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTestProvenance } from "../src/test-provenance.js";

const supplied = "import test from 'node:test';\ntest('supplied', () => {});\n";
const added = "test('new boundary', () => {});\n";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-provenance-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "test/base.test.js"), supplied);
  return root;
}
const roundtrip = (value) => JSON.parse(JSON.stringify(value));

test("resume does not promote new files or appended test blocks into the supplied baseline", (t) => {
  const root = fixture(t);
  const initial = createTestProvenance(root);
  const snapshot = roundtrip(initial.snapshot());
  fs.writeFileSync(path.join(root, "test/base.test.js"), supplied + added);
  fs.writeFileSync(path.join(root, "test/boundary.test.js"), added);
  const resumed = createTestProvenance(root, { snapshot });
  assert.equal(resumed({ file: "test/base.test.js", line: 3 }), "self-authored");
  assert.equal(resumed({ file: "test/base.test.js", line: 2 }), "baseline-context-changed");
  assert.equal(resumed({ file: "test/boundary.test.js", line: 1 }), "generated");
  assert.equal(createTestProvenance(root)({ file: "test/boundary.test.js", line: 1 }), "baseline", "recapturing current bytes would reproduce the bug");
  assert.deepEqual(resumed.snapshot(), snapshot, "the basis remains the original inventory through repeated resumes");
});

test("resumed supplied tests that changed are not relabeled self-authored", (t) => {
  const root = fixture(t);
  const snapshot = createTestProvenance(root).snapshot();
  fs.writeFileSync(path.join(root, "test/base.test.js"), supplied.replace("'supplied'", "'renamed'"));
  assert.equal(createTestProvenance(root, { snapshot })({ file: "test/base.test.js", line: 2 }), "added-or-modified");
});

test("snapshots relocate safely and do not share mutable collections with classifiers", (t) => {
  const sourceRoot = fixture(t), resumedRoot = fixture(t);
  const initial = createTestProvenance(sourceRoot);
  const snapshot = initial.snapshot();
  const resumed = createTestProvenance(resumedRoot, { snapshot });
  snapshot.originals[0][1] = "forged after restoration";
  snapshot.initialPaths.length = 0;
  assert.equal(initial({ file: "test/base.test.js", line: 2 }), "baseline");
  assert.equal(resumed({ file: "test/base.test.js", line: 2 }), "baseline");
  const secondSnapshot = resumed.snapshot();
  secondSnapshot.originals.length = 0;
  assert.equal(resumed.snapshot().originals.length, 1);
});

test("protected paths override restored ownership, missing files, and missing snapshot evidence", (t) => {
  const root = fixture(t);
  const snapshot = createTestProvenance(root).snapshot();
  fs.writeFileSync(path.join(root, "test/boundary.test.js"), added);
  const protectedPath = (rel) => rel === "test/boundary.test.js";
  for (const evidence of [snapshot, null]) {
    const resumed = createTestProvenance(root, { snapshot: evidence, protectedPath });
    assert.equal(resumed({ file: "test/boundary.test.js", line: 1 }), "protected");
    fs.rmSync(path.join(root, "test/boundary.test.js"), { force: true });
    assert.equal(resumed({ file: "test/boundary.test.js", line: 1 }), "protected");
  }
});

test("incomplete or missing resume evidence remains unknown instead of rescanning current files", (t) => {
  const root = fixture(t);
  const limited = createTestProvenance(root, { maxBytes: 1 }).snapshot();
  assert.equal(limited.complete, false);
  fs.writeFileSync(path.join(root, "test/boundary.test.js"), added);
  for (const snapshot of [limited, null, undefined, {}, { ...limited, schema: 99 }]) {
    const resumed = createTestProvenance(root, { snapshot });
    assert.equal(resumed({ file: "test/base.test.js", line: 2 }), "unknown");
    assert.equal(resumed({ file: "test/boundary.test.js", line: 1 }), "unknown");
  }
});

test("invalid, escaping, duplicate, and over-budget serialized bases are rejected conservatively", (t) => {
  const root = fixture(t);
  const valid = createTestProvenance(root).snapshot();
  const invalid = [
    { ...valid, initialPaths: ["../outside.test.js"] },
    { ...valid, initialPaths: ["/tmp/outside.test.js"] },
    { ...valid, initialPaths: ["C:\\outside.test.js"] },
    { ...valid, initialPaths: ["test//base.test.js"] },
    { ...valid, initialPaths: [...valid.initialPaths, valid.initialPaths[0]] },
    { ...valid, originals: [["test/absent.test.js", supplied]] },
    { ...valid, originals: [...valid.originals, valid.originals[0]] },
    { ...valid, excludedPaths: ["missing"] },
    { ...valid, excludedPaths: ["test"] },
    { ...valid, complete: "yes" },
  ];
  for (const snapshot of invalid) {
    assert.equal(createTestProvenance(root, { snapshot })({ file: "test/base.test.js", line: 2 }), "unknown");
  }
  assert.equal(createTestProvenance(root, { snapshot: valid, maxBytes: 1 })({ file: "test/base.test.js", line: 2 }), "unknown");
  assert.equal(createTestProvenance(root, { snapshot: valid, maxFiles: 1 })({ file: "test/base.test.js", line: 2 }), "unknown");
});

test("bounded fresh inventories and generated-directory exclusions survive the round trip", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "node_modules"));
  const limited = createTestProvenance(root, { maxFiles: 1 }).snapshot();
  assert.ok(limited.initialPaths.length <= 1);
  assert.equal(limited.complete, false);
  const snapshot = createTestProvenance(root).snapshot();
  fs.writeFileSync(path.join(root, "node_modules/new.test.js"), added);
  const resumed = createTestProvenance(root, { snapshot: roundtrip(snapshot) });
  assert.equal(resumed({ file: "node_modules/new.test.js", line: 1 }), "unknown");
  assert.equal(resumed({ file: "../outside.test.js", line: 1 }), "unknown");
});
