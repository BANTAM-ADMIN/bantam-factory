import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { verificationEvidence, verificationReceipt, shellExecutionReceipt } from "../src/verification-evidence.js";

const VERIFY = "node --test check.test.js";
const GREEN = "TAP version 13\nok 1 - fixture\n1..1\n# tests 1\n# pass 1\n# fail 0\n";
const RED = "TAP version 13\nnot ok 1 - fixture\n1..1\n# tests 1\n# pass 0\n# fail 1\nEROFS: read-only file system, open 'fixture.txt'\n";
const DONE = { a: "done", summary: "Completed and checked the task." };
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-verifier-parity-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "check.test.js"), "// fixture writes into source workspace\n");
  return workspace;
}
function run(workspace, actions, options = {}) {
  let index = 0;
  return runAgent({ workspace, task: "Ensure the configured project check passes.", verificationScript: VERIFY,
    maxTurns: 8, interactive: true, useGrammar: false, grounding: false,
    shellSandbox: "docker", dockerImage: "fixture/image:local", shellNetwork: false,
    verificationWorkspaceReadOnly: true, completionAudit: false, stateAudit: "off", contractStateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    model: { assistantPrefill: "", async complete() {
      return { content: JSON.stringify(actions[Math.min(index++, actions.length - 1)]), tokens: 1,
        stoppedEos: true, stoppedLimit: false, timings: {} };
    } }, ...options });
}
function runner(workspace, respond) {
  const calls = [];
  const processRunner = async (file, args) => {
    assert.equal(file, "docker");
    const readOnly = args.includes(`${workspace}:${workspace}:ro`);
    assert.notEqual(readOnly, args.includes(`${workspace}:${workspace}:rw`));
    if (readOnly) assert.ok(args.includes("/tmp:rw,exec,nosuid,nodev"));
    calls.push({ readOnly, command: args.at(-1) });
    return { code: 0, stdout: GREEN, stderr: "", timedOut: false, aborted: false, ...respond?.(readOnly) };
  };
  return { calls, processRunner };
}
test("manual RW success cannot satisfy early RO completion or exhaust its mandatory check", async t => {
  const workspace = fixture(t), fake = runner(workspace, ro => ro ? { code: 1, stdout: RED } : {});
  const result = await run(workspace, [{ a: "shell", c: VERIFY }, DONE], { shellProcessRunner: fake.processRunner });
  assert.equal(result.done, false);
  assert.deepEqual(fake.calls.map(call => call.readOnly), [false, true]);
  assert.equal(result.turns[0].verificationEvidence.workspaceReadOnly, false);
  assert.equal(result.turns[0].verificationEvidence.status, "pass");
  assert.equal(result.turns[1].verificationEvidence.workspaceReadOnly, true);
  assert.equal(result.turns[1].verificationEvidence.status, "fail");
  assert.match(result.turns[1].observation, /read-only check did not pass/);
  assert.match(result.turns[1].observation, /EROFS/);
  assert.equal(result.verification.status, "fail");
  assert.equal(result.verification.workspaceReadOnly, true);
});
test("repair obtains fresh RO proof while edits and manual shells remain writable", async t => {
  const workspace = fixture(t), fake = runner(workspace, ro => ro && !fs.readFileSync(path.join(workspace, "check.test.js"), "utf8").includes("os.tmpdir")
    ? { code: 1, stdout: RED } : {});
  const result = await run(workspace, [{ a: "shell", c: VERIFY }, DONE,
    { a: "write_file", p: "check.test.js", content: "// fixture now uses os.tmpdir() + fs.mkdtempSync\n" },
    { a: "shell", c: VERIFY }, DONE], { shellProcessRunner: fake.processRunner });
  assert.equal(result.done, true);
  assert.equal(result.turns[2].editApplied, true);
  assert.deepEqual(fake.calls.map(call => call.readOnly), [false, true, false, true]);
  assert.equal(result.verification.status, "pass");
  assert.equal(result.verification.workspaceReadOnly, true);
});
test("landing cannot cache RW manual evidence as RO configured proof", async t => {
  const workspace = fixture(t), fake = runner(workspace);
  const result = await run(workspace, [{ a: "write_file", p: "value.txt", content: "done\n" },
    { a: "shell", c: VERIFY }, DONE], { maxTurns: 3, interactive: false, shellProcessRunner: fake.processRunner });
  assert.equal(result.done, true);
  assert.ok(fake.calls.some(call => !call.readOnly));
  assert.ok(fake.calls.some(call => call.readOnly));
  assert.equal(result.turns[0].verificationEvidence.workspaceReadOnly, true);
  assert.equal(result.turns[0].verificationEvidence.source, "landing");
  assert.equal(result.turns[1].verificationEvidence.workspaceReadOnly, false,
    "the actual writable worker receipt is not overwritten by an older cached RO check");
  assert.equal(result.turns[1].verificationEvidence.source, "shell");
  assert.equal(result.turns[1].verificationReceipts.entries.length, 1);
  assert.deepEqual(fake.calls.map(call => call.readOnly), [true, false], "cached RO proof remains valid without pretending it ran again");
  assert.equal(result.verification.workspaceReadOnly, true);
});
test("env opt-in is disclosed in context and an explicit false overrides it", async t => {
  const workspace = fixture(t), previous = process.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY;
  process.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY = "1";
  t.after(() => { if (previous === undefined) delete process.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY;
    else process.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY = previous; });
  const fake = runner(workspace), prompts = [];
  const model = { assistantPrefill: "", async complete(prompt) {
    prompts.push(prompt); return { content: JSON.stringify(DONE), tokens: 1, timings: {} };
  } };
  const selected = await run(workspace, [], { model, verificationWorkspaceReadOnly: undefined, shellProcessRunner: fake.processRunner });
  assert.equal(selected.done, true);
  assert.match(prompts[0], /entire source workspace READ-ONLY/);
  assert.match(prompts[0], /fresh writable \/tmp/);
  assert.match(prompts[0], /Ordinary edits and manual shell commands remain writable/);
  assert.deepEqual(fake.calls.map(call => call.readOnly), [true]);
  const other = runner(workspace);
  const ordinary = await run(workspace, [DONE], { verificationWorkspaceReadOnly: false, shellProcessRunner: other.processRunner });
  assert.equal(ordinary.done, true);
  assert.ok(other.calls.every(call => call.readOnly === false));
  assert.equal(ordinary.verification.workspaceReadOnly, false);
});
test("host mode cannot claim RO enforcement, even with an injected runner", async t => {
  await assert.rejects(run(fixture(t), [DONE], { shellSandbox: "host",
    shellProcessRunner: async () => { assert.fail("must not execute"); } }), /requires the Docker shell sandbox/);
});
test("inconclusive RO execution cannot certify completion", async t => {
  const workspace = fixture(t), fake = runner(workspace, () => ({ code: 0, stdout: "1..0\n# tests 0\n# pass 0\n# fail 0\n" }));
  const result = await run(workspace, [DONE], { shellProcessRunner: fake.processRunner, maxTurns: 3 });
  assert.equal(result.done, false);
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.verification.workspaceReadOnly, true);
});
test("verification and process receipts preserve mode without inferring absent metadata", () => {
  const execution = { command: VERIFY, exitCode: 0, stdout: GREEN, stderr: "", pipefail: true, workspaceReadOnly: true };
  assert.equal(verificationReceipt(verificationEvidence({ execution })).workspaceReadOnly, true);
  assert.equal(shellExecutionReceipt(execution).workspaceReadOnly, true);
  const unknown = { ...execution }; delete unknown.workspaceReadOnly;
  assert.equal(verificationEvidence({ execution: unknown }).workspaceReadOnly, null);
});
