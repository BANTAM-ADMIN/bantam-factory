import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { verificationVerdict } from "../src/done-guard.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-instruction-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "keep.txt"), "original");
  return workspace;
}

function scripted(actions) {
  let call = 0;
  return { assistantPrefill: "", actTemperature: null, async complete() {
    return { content: JSON.stringify(actions[Math.min(call++, actions.length - 1)]), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  } };
}

const options = {
  task: "Implement deliverable.txt. Do not modify keep.txt.",
  interactive: true, useGrammar: false, grounding: false, completionAudit: false, stateAudit: "off", shellSandbox: "host",
};

test("ordinary interactive agent enforces named prohibition before repeated direct edits", async (t) => {
  const workspace = fixture(t);
  const result = await runAgent({ ...options, workspace, maxTurns: 5, model: scripted([
    { a: "write_file", p: "keep.txt", content: "forbidden" },
    { a: "write_file", p: "keep.txt", content: "forbidden again" },
    { a: "write_file", p: "deliverable.txt", content: "implemented" },
    { a: "done", summary: "Implemented deliverable.txt." },
  ]) });
  assert.equal(result.done, true);
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "original");
  assert.equal(result.metrics.immutableEditRejections, 2);
  assert.equal(result.turns[0].editApplied, false);
  assert.equal(result.turns[1].editApplied, false);
});

test("ordinary interactive agent restores forbidden shell writes and invalidates their green output", async (t) => {
  const workspace = fixture(t);
  const result = await runAgent({ ...options, workspace, maxTurns: 1, model: scripted([
    { a: "shell", c: "printf forbidden > keep.txt; printf implemented > deliverable.txt; printf 'all 5 tests passed\\n'" },
  ]) });
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(workspace, "deliverable.txt"), "utf8"), "implemented");
  assert.equal(result.turns[0].shellScopeRollback.clean, true);
  assert.equal(verificationVerdict(result.turns[0]), "fail");
});

test("public existing-test instruction blocks direct edits and rolls back shell appends but allows a new test file", async t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  const baseline = "// supplied test assertions\n";
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), baseline);
  fs.symlinkSync("test/base.test.js", path.join(workspace, "test-alias.js"));
  const result = await runAgent({ ...options, workspace, maxTurns: 4,
    task: "Implement deliverable.txt. Do not add dependencies or modify package.json or existing public tests. You may add tests.",
    autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0,
    model: scripted([
      { a: "write_file", p: "test/base.test.js", content: baseline + "// forbidden direct append\n" },
      { a: "write_file", p: "test/new.test.js", content: "// legitimate new assertions\n" },
      { a: "replace", p: "test-alias.js", old: baseline, new: "// forbidden alias replacement\n" },
      { a: "shell", c: "printf '// forbidden shell append\\n' >> test/base.test.js; printf '// legitimate extension\\n' >> test/new.test.js" },
    ]),
  });
  assert.equal(result.metrics.immutableEditRejections, 2);
  assert.equal(fs.readFileSync(path.join(workspace, "test/base.test.js"), "utf8"), baseline);
  assert.equal(fs.readFileSync(path.join(workspace, "test/new.test.js"), "utf8"), "// legitimate new assertions\n// legitimate extension\n");
  assert.equal(result.turns[3].shellScopeRollback.clean, true);
  assert.ok(result.turns[3].shellScopeRollback.violations.some(v => v.path === "test/base.test.js"));
});

test("Docker instruction enforcement mounts only invocation-existing test files read-only", async t => {
  const workspace = fixture(t), calls = [];
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), "// supplied assertions\n");
  await runAgent({ ...options, workspace, maxTurns: 2,
    task: "Do not modify existing public tests. You may add tests.",
    shellSandbox: "docker", shellNetwork: false, dockerImage: "fixture/image:local",
    autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0,
    shellProcessRunner: async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: "probe\n", stderr: "", timedOut: false, bufferExceeded: false, aborted: false };
    },
    model: scripted([
      { a: "write_file", p: "test/new.test.js", content: "// new assertions\n" },
      { a: "shell", c: "printf probe" },
    ]),
  });
  const shell = calls.find(call => call.file === "docker" && call.args.at(-1) === "printf probe");
  assert.ok(shell, "mocked implementation shell was observed");
  const mounts = shell.args.flatMap((arg, i) => arg === "-v" ? [shell.args[i + 1]] : []);
  assert.ok(mounts.includes(`${workspace}:${workspace}:rw`));
  assert.ok(mounts.includes(`${workspace}/test/base.test.js:${workspace}/test/base.test.js:ro`));
  assert.ok(!mounts.includes(`${workspace}/test:${workspace}/test:ro`));
  assert.ok(!mounts.includes(`${workspace}/test/new.test.js:${workspace}/test/new.test.js:ro`));
});

test("same-task agent resume keeps new worker tests writable and original tests protected", async t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), "// supplied\n");
  const task = "Do not modify existing public tests. You may add tests.";
  const common = { ...options, workspace, task, autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0 };
  const first = await runAgent({ ...common, maxTurns: 1, model: scripted([
    { a: "write_file", p: "test/new.test.js", content: "// worker v1\n" },
  ]) });
  assert.ok(first.turns[0].contextBasis.frozenTests.existingTests.includes("test/base.test.js"));
  const calls = [];
  const resumed = await runAgent({ ...common, maxTurns: 4, resumeTurns: JSON.parse(JSON.stringify(first.turns)),
    shellSandbox: "docker", shellNetwork: false, dockerImage: "fixture/image:local",
    shellProcessRunner: async (file, args) => { calls.push({ file, args });
      return { code: 0, stdout: "probe\n", stderr: "", timedOut: false, bufferExceeded: false, aborted: false }; },
    model: scripted([
      { a: "write_file", p: "test/new.test.js", content: "// worker v2\n" },
      { a: "write_file", p: "test/base.test.js", content: "// forbidden\n" },
      { a: "shell", c: "printf resume-probe" },
    ]) });
  assert.equal(fs.readFileSync(path.join(workspace, "test/new.test.js"), "utf8"), "// worker v2\n");
  assert.equal(fs.readFileSync(path.join(workspace, "test/base.test.js"), "utf8"), "// supplied\n");
  assert.equal(resumed.metrics.immutableEditRejections, 1);
  const shell = calls.find(call => call.file === "docker" && call.args.at(-1) === "printf resume-probe");
  assert.ok(shell);
  assert.ok(shell.args.includes(`${workspace}/test/base.test.js:${workspace}/test/base.test.js:ro`));
  assert.ok(!shell.args.includes(`${workspace}/test/new.test.js:${workspace}/test/new.test.js:ro`));
});

test("same-task resume retains original immutable test hashes for the final done gate", async t => {
  const workspace = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), "// supplied\n");
  const common = { ...options, workspace, task: "Do not modify existing public tests. You may add tests.",
    autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0 };
  const first = await runAgent({ ...common, maxTurns: 1, model: scripted([
    { a: "write_file", p: "test/new.test.js", content: "// worker\n" },
  ]) });
  fs.writeFileSync(path.join(workspace, "test/base.test.js"), "// changed while paused\n");
  const resumed = await runAgent({ ...common, maxTurns: 2, resumeTurns: first.turns,
    model: scripted([{ a: "done", summary: "Finished." }]) });
  assert.equal(resumed.done, false);
  assert.ok(resumed.turns.some(turn => /instruction forbids modifying.*base\.test\.js/.test(turn.observation)));
});
