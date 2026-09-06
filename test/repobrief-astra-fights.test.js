import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptedBantamCompletion, cardCommand, cardOrder, treeHashes, changedSealedFiles } from "../scripts/repobrief-astra-fights.mjs";

test("project cards alternate order and retain the same two explicitly pinned models", () => {
  assert.deepEqual(cardOrder(1), ["bantam-codex-astra", "codex-astra", "bantam-local-27b"]);
  assert.deepEqual(cardOrder(2), [...cardOrder(1)].reverse());
  for (const arm of cardOrder(1)) {
    const c = cardCommand(arm, "EXACT_TASK", "/tmp/project-candidate", "/tmp/arm-evidence");
    assert.ok(c.args.includes("EXACT_TASK"));
    if (arm !== "bantam-local-27b") assert.ok(c.args.includes("gpt-6-astra"));
    else {
      assert.ok(c.args.includes("http://127.0.0.1:8085"));
      assert.ok(!c.args.includes("--codex"));
    }
    if (arm.startsWith("bantam")) {
      assert.equal(c.args[c.args.indexOf("--workspace") + 1], "/tmp/project-candidate");
      assert.ok(c.args.includes("--save-run=/tmp/arm-evidence/run.json"));
      assert.equal(c.env.BANTAM_SHELL_SANDBOX, "docker");
      assert.equal(c.env.BANTAM_TEACHER, "0");
      assert.equal(c.env.BANTAM_EXTENSION_WORKING_SET, "0");
    } else {
      assert.match(c.exe, /astra-container-cli\.mjs$/);
      assert.ok(c.args.includes("--dangerously-bypass-approvals-and-sandbox"));
      assert.ok(!c.args.includes("--sandbox"));
    }
  }
});

test("completion uses the actual artifact schema, not the internal done action field", () => {
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: true, pass: true, interrupted: false, modelFailure: null } }), true);
  assert.equal(acceptedBantamCompletion({ result: { done: true, pass: true } }), false);
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: false, pass: true } }), false);
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: true, pass: false } }), false);
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: true, pass: true, interrupted: true } }), false);
});

test("material seals detect modified, missing and symlink-replaced protected tests", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repobrief-seal-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test/a.js"), "original");
  const seal = treeHashes(dir);
  assert.deepEqual(changedSealedFiles(seal, dir), []);
  fs.writeFileSync(path.join(dir, "test/a.js"), "changed");
  assert.deepEqual(changedSealedFiles(seal, dir), ["test/a.js"]);
  fs.unlinkSync(path.join(dir, "test/a.js"));
  assert.deepEqual(changedSealedFiles(seal, dir), ["test/a.js"]);
  fs.writeFileSync(path.join(dir, "outside.js"), "original");
  fs.symlinkSync("../outside.js", path.join(dir, "test/a.js"));
  assert.deepEqual(changedSealedFiles(seal, dir), ["test/a.js"]);
});
