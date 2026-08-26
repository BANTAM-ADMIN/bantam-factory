import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import { graderTampering, graderSnapshot, snapshotTree } from "../src/scope-guard.js";

// `bantam run --verify <cmd>` grades the run by that command. Nothing stopped
// the model from rewriting the tests that command runs, and the guard that
// exists for exactly this (scope-guard.js, "stop the model from gaming the
// hidden verifier") was wired only into the eval path.
//
// Demonstrated on 2026-08-17 in three turns: given a suite asserting
// `assert.equal(1, 9)`, the model rewrote it to `assert.equal(9, 9)` and
// `assert.ok(true)`, and the run was recorded `pass: true`.
//
// Auditing the stored runs afterwards: exactly two ever edited a pre-existing
// test file, and both FAILED — so no recorded pass is contaminated. The problem
// is not that it happened; it is that a green could not be distinguished from a
// rewritten grader at all.
//
// Reporting, not blocking: `bantam run` is a general CLI and changing a test is
// a legitimate thing to be asked for. Writing NEW tests is the task in half the
// tickets, so injection is not tampering and must not be reported as it.

const snap = (entries) => new Map(entries);

test("a rewritten pre-existing test is reported", () => {
  const before = snap([["test/x.test.js", "sha-original"], ["src/impl.js", "sha-a"]]);
  const after = snap([["test/x.test.js", "sha-weakened"], ["src/impl.js", "sha-a"]]);
  const found = graderTampering(before, after);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].path, "test/x.test.js");
  assert.equal(found[0].kind, "test-tampering");
});

test("a deleted grader is reported", () => {
  const found = graderTampering(snap([["test/x.test.js", "sha"]]), snap([]));
  assert.equal(found.length, 1);
  assert.equal(found[0].change, "deleted");
});

test("writing a NEW test is not tampering", () => {
  // Ticket B requires the model to add tests. Reporting that as gaming the
  // verifier would cry wolf on the task itself.
  const found = graderTampering(snap([["src/impl.js", "sha-a"]]), snap([
    ["src/impl.js", "sha-a"], ["test/new-feature.test.js", "sha-new"],
  ]));
  assert.deepEqual(found, []);
});

test("ordinary source edits are not reported", () => {
  const found = graderTampering(snap([["src/impl.js", "sha-a"]]), snap([["src/impl.js", "sha-b"]]));
  assert.deepEqual(found, []);
});

test("it reads a real tree", (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-tamper-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/x.test.js"), "assert.equal(1, 9);\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = snapshotTree(dir);
  fs.writeFileSync(path.join(dir, "test/x.test.js"), "assert.equal(9, 9);\n");
  const found = graderTampering(before, snapshotTree(dir));
  assert.equal(found.length, 1, JSON.stringify(found));
});

// scope-guard leaves package.json and pyproject.toml to a fixture's `editable`
// allowlist, because they are legitimate source targets — and `bantam run` has
// no allowlist. So `--verify "npm test"` can be turned green by rewriting the
// script it names, without touching a test file.
//
// NO corpus evidence: no stored run uses a manifest-script verifier (3 direct
// commands, 0 manifest). Fixed anyway, and scoped narrowly, because an integrity
// check with a documented bypass is worse than none — it creates confidence it
// has not earned. A direct verifier, which is every real case so far, is
// unaffected.
test("a manifest is grader only when the verifier actually runs it", () => {
  const before = snap([["package.json", "sha-a"], ["src/impl.js", "sha-x"]]);
  const after = snap([["package.json", "sha-b"], ["src/impl.js", "sha-x"]]);

  assert.deepEqual(
    graderTampering(before, after, { verifyCommand: "node --test test/x.test.js" }),
    [],
    "a direct verifier does not care about package.json",
  );
  const viaNpm = graderTampering(before, after, { verifyCommand: "npm test" });
  assert.equal(viaNpm.length, 1, JSON.stringify(viaNpm));
  assert.equal(viaNpm[0].path, "package.json");
  assert.equal(viaNpm[0].kind, "runner-config-tampering");
});

test("editing an unrelated manifest is still not tampering", () => {
  const before = snap([["package.json", "sha-a"]]);
  const after = snap([["package.json", "sha-b"]]);
  assert.deepEqual(graderTampering(before, after, { verifyCommand: "pytest -q" }), []);
});

// snapshotTree hashes every file in the workspace. The grader check only ever
// COMPARES test paths and (when the verifier runs one) a manifest, so hashing
// the rest is pure cost: measured 4.8s and 76,079 files at this repo's root,
// twice per run. Filtered, it reads what it will look at.
test("the grader snapshot hashes graders, not the whole tree", (t) => {
  const fs2 = require("node:fs"), os2 = require("node:os"), path2 = require("node:path");
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "bantam-grader-snap-"));
  fs2.mkdirSync(path2.join(dir, "test"), { recursive: true });
  fs2.mkdirSync(path2.join(dir, "src"), { recursive: true });
  fs2.writeFileSync(path2.join(dir, "test/a.test.js"), "assert.ok(1);\n");
  fs2.writeFileSync(path2.join(dir, "src/impl.js"), "export const x = 1;\n");
  fs2.writeFileSync(path2.join(dir, "package.json"), '{"name":"t"}');
  fs2.writeFileSync(path2.join(dir, "README.md"), "# docs\n");
  t.after(() => fs2.rmSync(dir, { recursive: true, force: true }));

  const snap = graderSnapshot(dir, { verifyCommand: "node --test test/a.test.js" });
  assert.ok(snap.has("test/a.test.js"), "a grader is in it");
  assert.ok(!snap.has("src/impl.js"), "ordinary source is not");
  assert.ok(!snap.has("README.md"), "nor is prose");

  const viaNpm = graderSnapshot(dir, { verifyCommand: "npm test" });
  assert.ok(viaNpm.has("package.json"), "the manifest joins when the verifier runs it");
});

test("tampering is still detected through the filtered snapshot", (t) => {
  const fs2 = require("node:fs"), os2 = require("node:os"), path2 = require("node:path");
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "bantam-grader-snap2-"));
  fs2.mkdirSync(path2.join(dir, "test"), { recursive: true });
  fs2.writeFileSync(path2.join(dir, "test/a.test.js"), "assert.equal(1, 9);\n");
  t.after(() => fs2.rmSync(dir, { recursive: true, force: true }));
  const before = graderSnapshot(dir, {});
  fs2.writeFileSync(path2.join(dir, "test/a.test.js"), "assert.equal(9, 9);\n");
  const found = graderTampering(before, graderSnapshot(dir, {}));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].kind, "test-tampering");
});
