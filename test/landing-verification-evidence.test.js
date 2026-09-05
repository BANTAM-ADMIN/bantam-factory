import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";

const VERIFY = "node --test target.test.js";
const GREEN = "TAP version 13\nok 1 - target\n1..1\n# tests 1\n# pass 1\n# fail 0\n";
const RED = "TAP version 13\nnot ok 1 - target\n1..1\n# tests 1\n# pass 0\n# fail 1\n";
const EMPTY = "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n";
const write = (value) => ({ a: "write_file", p: "target.js", content: `module.exports = ${JSON.stringify(value)};\n` });
const done = { a: "done", summary: "Updated target and verified the current files." };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-landing-evidence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "package.json"), '{"private":true,"scripts":{"test":"node --test target.test.js"}}');
  fs.writeFileSync(path.join(workspace, "target.js"), "module.exports = 'initial';\n");
  fs.writeFileSync(path.join(workspace, "target.test.js"),
    'const test = require("node:test"); const assert = require("node:assert/strict"); test("target", () => assert.equal(require("./target.js"), "good"));\n');
  return workspace;
}

function run(workspace, actions, options = {}) {
  let index = 0;
  return runAgent({
    workspace, task: "Fix target.js so the tests pass.", verificationScript: VERIFY,
    model: { assistantPrefill: "", actTemperature: null, async complete() {
      return { content: JSON.stringify(actions[Math.min(index++, actions.length - 1)]), tokens: 1,
        stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: 2, interactive: false, useGrammar: false, grounding: false,
    shellSandbox: "host", completionAudit: false, stateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    ...options,
  });
}

test("a real passing landing check on an edit permits done without a redundant model shell", async (t) => {
  const result = await run(fixture(t), [write("good"), done]);
  assert.equal(result.done, true);
  assert.equal(result.metrics.landingVerifies, 1);
  const receipt = result.turns[0].verificationEvidence;
  assert.equal(receipt.source, "landing");
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.command, VERIFY);
  assert.equal(receipt.configuredCommand, VERIFY);
  assert.equal(receipt.counts.passed, 1);
  assert.equal(receipt.generation, 1);
  assert.equal(result.turns[0].scopedVerify.verdict, "pass");
  assert.equal(result.verification.status, "pass");
});

test("landing caches raw-result identity and resets full-verification cadence", async (t) => {
  let calls = 0;
  const result = await run(fixture(t), [write("good"), write("still good"), done], {
    maxTurns: 3, autoVerifyStaleTurns: 2,
    shellProcessRunner: async () => { calls++; return { code: 0, stdout: GREEN, stderr: "" }; },
  });
  assert.equal(result.done, true);
  assert.equal(result.metrics.autoVerifies ?? 0, 0, "a fresh landing check resets the stale-suite clock");
  assert.equal(result.metrics.landingVerifies, 2);
  assert.equal(calls, 2, "the final done reuses the latest generation's proof");
  assert.equal(result.turns[1].verificationEvidence.generation, 2);
  assert.equal(result.turns[1].verificationEvidence.outputSha256,
    crypto.createHash("sha256").update(GREEN).digest("hex"));
});

for (const [label, execution, status] of [
  ["failed", { code: 1, stdout: RED, stderr: "" }, "fail"],
  ["timed out despite green-looking output", { code: 0, stdout: GREEN, stderr: "", timedOut: true }, "unverified"],
  ["empty discovery", { code: 0, stdout: EMPTY, stderr: "" }, "unverified"],
  ["reported failures despite exit zero", { code: 0, stdout: RED, stderr: "" }, "fail"],
]) {
  test(`a ${label} landing check cannot qualify done`, async (t) => {
    const result = await run(fixture(t), [write("good"), done], {
      shellProcessRunner: async () => execution,
    });
    assert.equal(result.done, false);
    assert.equal(result.turns[0].verificationEvidence.source, "landing");
    assert.equal(result.turns[0].verificationEvidence.status, status);
    assert.equal(result.verification.status, status);
    assert.doesNotMatch(result.turns[0].observation, /verify command PASSES/);
    if (status === "unverified") assert.equal(result.turns[0].scopedVerify, undefined);
  });
}

test("a landing restoration invalidates the pre-restore receipt until another check runs", async (t) => {
  const workspace = fixture(t);
  const result = await run(workspace, [write("good"), { a: "shell", c: VERIFY }, write("bad"), done], {
    maxTurns: 4, regressionGuard: true,
  });
  assert.equal(result.metrics.landingReverts, 1);
  assert.match(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), /good/);
  const restoredTurn = result.turns[2];
  assert.equal(restoredTurn.verificationEvidence.source, "landing");
  assert.equal(restoredTurn.verificationEvidence.status, "unverified");
  assert.equal(restoredTurn.verificationEvidence.invalidated, true);
  assert.equal(restoredTurn.verificationEvidence.counts, null);
  assert.equal(restoredTurn.scopedVerify, undefined);
  assert.equal(result.done, false, "the immediate done was refused without a current in-loop receipt");
  assert.match(result.turns[3].observation, /earlier workspace state|changed code after your last test run/);
  assert.equal(result.turns[3].verificationEvidence, null);
  assert.equal(result.verification.status, "pass", "the terminal verifier independently checks the restored files");
});

test("an inconclusive landing attempt cannot restore source based on an older green", async (t) => {
  const workspace = fixture(t);
  const result = await run(workspace, [write("good"), { a: "shell", c: VERIFY }, write("bad"), done], {
    maxTurns: 4, regressionGuard: true,
    shellProcessRunner: async () => fs.readFileSync(path.join(workspace, "target.js"), "utf8").includes('"bad"')
      ? { code: 0, stdout: GREEN, stderr: "", timedOut: true }
      : { code: 0, stdout: GREEN, stderr: "" },
  });
  assert.equal(result.metrics.landingReverts ?? 0, 0);
  assert.match(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), /bad/);
  assert.equal(result.turns[2].verificationEvidence.status, "unverified");
  assert.doesNotMatch(result.turns[2].observation, /I restored|You broke working code/);
});

test("a failing landing suite cannot restore a snapshot from a different baseline command", async (t) => {
  const workspace = fixture(t);
  const result = await run(workspace, [write("good"),
    { a: "shell", c: "node --test --test-name-pattern target target.test.js" }, write("bad"), done], {
    maxTurns: 5, regressionGuard: true,
    shellProcessRunner: async () => fs.readFileSync(path.join(workspace, "target.js"), "utf8").includes('"bad"')
      ? { code: 1, stdout: RED, stderr: "" }
      : { code: 0, stdout: GREEN, stderr: "" },
  });
  assert.equal(result.metrics.landingReverts ?? 0, 0);
  assert.equal(result.metrics.regressionReverts ?? 0, 0);
  assert.match(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), /bad/);
  assert.equal(result.turns[2].verificationEvidence.status, "fail");
  assert.match(result.turns[2].observation, /different test command/);
});
