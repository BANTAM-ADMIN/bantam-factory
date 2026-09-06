import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptedBantamCompletion, cardCommand, cardOrder, treeHashes, changedSealedFiles } from "../scripts/repobrief-astra-fights.mjs";
import { variantVerdict } from "../scripts/factory-local-variant.mjs";

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
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: true, pass: true, modelFailure: { kind: "transport" } } }), false);
  assert.equal(acceptedBantamCompletion(null), false);
  assert.equal(acceptedBantamCompletion({ turns: [{ parsedAction: { a: "done" } }], result: { pass: true } }), false);
});

test("completion rejects controller terminations even when reachedDone and final verification are green", () => {
  const completed = { result: { reachedDone: true, pass: true }, turns: [{ parsedAction: { a: "done" } }] };
  for (const key of ["progressGateTerminations", "artifactVerificationGateTerminations", "interactiveStopTerminations"]) {
    assert.equal(acceptedBantamCompletion({ ...completed, metrics: { [key]: 0 } }), true);
    for (const count of [1, 2, -1, "1"]) {
      assert.equal(acceptedBantamCompletion({ ...completed, metrics: { [key]: count } }), false);
    }
  }
  for (const summary of [
    "Stopped by progress gate; grading current workspace state.",
    "Stopped by artifact verification gate; grading current workspace state.",
    "Stopped: I kept investigating after being asked to wrap up. Re-steer with a more specific instruction, or say \"keep going\".",
  ]) {
    assert.equal(acceptedBantamCompletion({ ...completed, result: { ...completed.result, summary } }), false);
  }
  assert.equal(acceptedBantamCompletion({ ...completed, result: { ...completed.result, summary: "Implemented progress gate handling and verified it." } }), true);
  assert.equal(acceptedBantamCompletion({ ...completed, metrics: { progressGateRejections: 8, artifactVerificationGateRejections: 1 } }), true);
});

test("recorded completion requires the actual terminal done, not an earlier rejected done or a respond", () => {
  const result = { reachedDone: true, pass: true };
  for (const turns of [
    [], null, {}, [null], [{}], [{ parsedAction: null }], [{ parsedAction: "done" }],
    [{ parsedAction: { a: "done" } }, { parsedAction: { a: "shell", c: "npm test" } }],
    [{ parsedAction: { a: "respond", text: "Everything passes." } }],
    [{ parsedAction: { a: "done" }, doneAccepted: false }],
    [{ parsedAction: { a: "shell" }, action: { a: "done" } }],
    [{ parsedAction: { a: "done" }, action: { a: "shell" } }],
  ]) assert.equal(acceptedBantamCompletion({ result, turns }), false);
  assert.equal(acceptedBantamCompletion({ result, turns: [{ parsedAction: { a: "done" } }] }), true);
  assert.equal(acceptedBantamCompletion({ result, turns: [{ action: { a: "done" } }] }), true);
  assert.equal(acceptedBantamCompletion({ result, turns: [{ parsedAction: { a: "done" } }, { parsedAction: { a: "done" }, doneAccepted: true }] }), true);
});

test("a controller-stopped passing candidate remains OUTPUT_ONLY while a failing candidate remains FAIL", () => {
  const processResult = { code: 0, timedOut: false, aborted: false, bufferExceeded: false };
  const grading = { publicResult: processResult, hidden: processResult, record: { pass: true } };
  const saved = { result: { reachedDone: true, pass: true, summary: "Stopped by progress gate; grading current workspace state." },
    metrics: { progressGateTerminations: 1 }, turns: [{ parsedAction: { a: "shell", c: "node -e '0'" } }] };
  const input = { processResult, grading, tampered: [], saved, usage: { requests: 1 } };
  assert.deepEqual(variantVerdict(input), { outcome: "OUTPUT_ONLY", pass: false, candidatePass: true, processCompleted: false, acceptedCompletion: false });
  const failed = variantVerdict({ ...input, grading: { ...grading, hidden: { ...processResult, code: 1 }, record: { pass: false } } });
  assert.equal(failed.outcome, "FAIL");
  assert.equal(failed.candidatePass, false);
  assert.equal(failed.acceptedCompletion, false);
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
