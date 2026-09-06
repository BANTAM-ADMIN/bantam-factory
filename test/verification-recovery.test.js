import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeExcludeVerbs } from "../src/turn-mask.js";
import { latestVerificationRecovery, verificationRecoveryNote } from "../src/verification-recovery.js";
import { runAgent } from "../src/agent.js";

test("recovery reads typed evidence, survives repeated reads, and retires on a measured pass", () => {
  const red = { verificationEvidence: { status: "fail", command: "node verify.mjs" } };
  const read = { observation: "Error: this prose is not an execution", verificationEvidence: null };
  assert.equal(latestVerificationRecovery([read]), null);
  assert.deepEqual(latestVerificationRecovery([red, read]), {
    turn: 0, command: "node verify.mjs", status: "fail", uncertainty: null,
  });
  assert.equal(latestVerificationRecovery([red, { verificationEvidence: { status: "pass" } }, read]), null);
  const unclear = latestVerificationRecovery([{ verificationEvidence: { status: "unverified", command: "node verify.mjs | tail" } }]);
  assert.match(verificationRecoveryNote(unclear), /INCONCLUSIVE/);
  assert.match(verificationRecoveryNote(unclear), /original turn budget still applies/);
});

test("duplicate recovery leaves shell available without overriding caller or document policy", () => {
  const flags = { forceWrapUp: true, verificationRecoveryTurn: true };
  assert.ok(!composeExcludeVerbs(flags).includes("shell"));
  assert.ok(composeExcludeVerbs(flags).includes("read_file"));
  assert.ok(composeExcludeVerbs({ forceWrapUp: true }).includes("shell"));
  for (const stronger of [{ baseExcludeVerbs: ["shell"] }, { documentReviewTurn: true }, { documentRevisionTurn: true }, { forceBuildEdit: true }]) {
    assert.ok(composeExcludeVerbs({ ...flags, ...stronger }).includes("shell"));
  }
});

test("live duplicate-read breaker offers executable recovery after a custom check crashes", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-recovery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "verify.mjs"), 'throw new Error("fixture invalid");\n');
  const actions = [
    { a: "shell", c: "node verify.mjs 2>&1 | tail -20" },
    ...Array.from({ length: 5 }, () => ({ a: "read_file", p: "verify.mjs", start: 1, limit: 1 })),
    { a: "respond", text: "The custom check is still failing; it is not verified." },
  ];
  const calls = [], events = [];
  await runAgent({
    task: "Investigate the custom verification failure and report the evidence.", workspace,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt, options) {
      calls.push({ prompt, options });
      return { content: JSON.stringify(actions.shift() ?? { a: "respond", text: "Check remains failed." }), tokens: 1, stoppedEos: true, timings: {} };
    } },
    maxTurns: 10, useGrammar: true, grounding: false, interactive: false,
    shellSandbox: "host", verificationPolicy: "after_edit", completionAudit: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    progressAwareness: false, onEvent: (event) => events.push(event),
  });
  assert.ok(events.some((event) => event.type === "verification_recovery_mask"));
  const recovery = calls.find((call) => call.prompt.includes("[verification recovery]"));
  assert.ok(recovery, "recovery instruction must reach the actual model prompt");
  assert.match(recovery.prompt, /last executable check FAILED/);
  assert.doesNotMatch(recovery.prompt, /You have gathered enough context/);
  assert.match(recovery.options.grammar, /shell/);
});

test("a caller investigation cap still closes shell after a failed check and duplicate reads", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-recovery-cap-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "verify.mjs"), 'throw new Error("fixture invalid");\n');
  // One executable failure + one fresh read + three identical reads exhausts
  // the five-action caller budget exactly when duplicate recovery would fire.
  const actions = [
    { a: "shell", c: "node verify.mjs" },
    ...Array.from({ length: 4 }, () => ({ a: "read_file", p: "verify.mjs", start: 1, limit: 1 })),
    { a: "respond", text: "The check failed; the caller's investigation budget is exhausted." },
  ];
  const calls = [], events = [];
  const result = await runAgent({
    task: "Investigate the custom verification failure and report the evidence.", workspace,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt, options) {
      calls.push({ prompt, options });
      return { content: JSON.stringify(actions.shift() ?? { a: "respond", text: "Check remains failed." }), tokens: 1, stoppedEos: true, timings: {} };
    } },
    maxTurns: 8, investigationActionLimit: 5, useGrammar: true, grounding: false, interactive: false,
    shellSandbox: "host", verificationPolicy: "after_edit", completionAudit: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    progressAwareness: false, onEvent: (event) => events.push(event),
  });
  assert.equal(result.turns[0].verificationEvidence.status, "fail");
  assert.ok(result.metrics.duplicateActionRejections >= 3, "must reach the duplicate-recovery threshold");
  assert.ok(calls.length >= 6, "must reach the first turn after the caller cap");
  assert.match(calls[5].prompt, /\[wrap up\]/);
  assert.doesNotMatch(calls[5].prompt, /\[verification recovery\]/);
  assert.doesNotMatch(calls[5].options.grammar, /shell/);
  assert.equal(events.some((event) => event.type === "verification_recovery_mask"), false);
});

const PHASE_VERIFY = "node --test test/public.test.js";
const PHASE_IMPLEMENTATION = 'module.exports = "ready";\n';

function phaseFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-recovery-phase-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "target.js"), 'module.exports = "initial";\n');
  fs.writeFileSync(path.join(workspace, "verify.mjs"), "process.exit(2);\n");
  fs.writeFileSync(path.join(workspace, "test/public.test.js"),
    'const test = require("node:test"); const assert = require("node:assert/strict"); test("ready", () => assert.equal(require("../target.js"), "ready"));\n');
  return workspace;
}

const unclearCheck = (index) => ({ a: "shell", c: `node verify.mjs; echo observation-${index}` });

async function runPhase(workspace, actions, options = {}) {
  const calls = [], events = [];
  let index = 0;
  const result = await runAgent({
    task: "Fix target.js and verify the result. Leave the existing public test unchanged.",
    workspace, verificationScript: PHASE_VERIFY,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt, request) {
      calls.push({ prompt, options: request });
      const action = typeof actions === "function" ? actions(index++) : actions[index++];
      assert.ok(action, "the controller must not request unbounded repair actions");
      return { content: JSON.stringify(action), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: 16, maxInvalidPerTurn: 0, useGrammar: true, grounding: false,
    interactive: false, shellSandbox: "host", completionAudit: false,
    stateAudit: "off", contractStateAudit: "off", verificationPolicy: "after_edit",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    progressAwareness: true, progressNudgeAfter: 3, autoForceEditAfter: 3,
    unchangedVerifyEarnsProgress: false, dedupeActions: false, dedupeShell: false,
    onEvent: (event) => events.push(event), ...options,
  });
  return { result, calls, events };
}

test("post-edit progress recovery keeps shell open for distinct inconclusive checks after a public pass", async (t) => {
  const workspace = phaseFixture(t);
  const publicBytes = fs.readFileSync(path.join(workspace, "test/public.test.js"));
  const actions = [
    { a: "read_file", p: "target.js" },
    { a: "write_file", p: "target.js", content: PHASE_IMPLEMENTATION },
    { a: "shell", c: PHASE_VERIFY },
    ...Array.from({ length: 3 }, (_, index) => unclearCheck(index)),
    { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "The current implementation passed the direct public check." },
  ];
  const { result, calls, events } = await runPhase(workspace, actions);
  assert.equal(result.turns[1].editApplied, true);
  assert.equal(result.turns[2].verificationEvidence.status, "pass");
  assert.deepEqual(result.turns.slice(3, 6).map(turn => turn.verificationEvidence?.status),
    ["unverified", "unverified", "unverified"]);
  assert.equal(result.metrics.duplicateActionRejections, 0, "different probes must not depend on duplicate recovery");
  assert.ok(events.some(event => event.type === "verification_recovery_mask"));
  assert.match(result.turns[5].observation, /Work has already been authored/);
  assert.match(calls[6].prompt, /\[verification recovery\]/);
  assert.match(calls[6].options.grammar, /shell/);
  assert.doesNotMatch(calls[6].options.grammar, /read_file/);
  for (const call of calls.slice(2)) {
    assert.doesNotMatch(call.prompt, /Write your first real implementation NOW|Commit to a rough deliverable/);
  }
  assert.equal(result.turns[6].verificationEvidence.status, "pass");
  assert.equal(result.done, true);
  assert.ok(calls.length <= 16);
  assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), PHASE_IMPLEMENTATION);
  assert.deepEqual(fs.readFileSync(path.join(workspace, "test/public.test.js")), publicBytes);
});

test("resumed shell-authored work does not regress to the first-draft mask", async (t) => {
  const workspace = phaseFixture(t);
  fs.writeFileSync(path.join(workspace, "target.js"), PHASE_IMPLEMENTATION);
  const prior = {
    action: { a: "shell", c: "node create-target.mjs" },
    observation: "Created target.js.", shellChangedPaths: ["target.js"], sourceEditedByShell: true,
  };
  const actions = [
    { a: "shell", c: PHASE_VERIFY },
    ...Array.from({ length: 3 }, (_, index) => unclearCheck(index)),
    { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "The resumed implementation passed direct verification." },
  ];
  const { result, calls, events } = await runPhase(workspace, actions, { resumeTurns: [prior] });
  assert.ok(events.some(event => event.type === "verification_recovery_mask"));
  assert.match(calls[4].prompt, /\[verification recovery\]/);
  assert.match(calls[4].options.grammar, /shell/);
  for (const call of calls) assert.doesNotMatch(call.prompt, /Write your first real implementation NOW/);
  assert.equal(result.done, true);
  assert.equal(result.turns[0].sourceEditedByShell, true);
  assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), PHASE_IMPLEMENTATION);
});

for (const observation of ["ERROR: the edit was refused", "NO_CHANGE: target.js already has those bytes"]) {
  test(`resuming an unapplied edit does not claim authored work: ${observation.split(":")[0]}`, async (t) => {
    const workspace = phaseFixture(t);
    const prior = {
      action: { a: "write_file", p: "target.js", content: PHASE_IMPLEMENTATION },
      observation, editApplied: false,
    };
    const actions = [
      ...Array.from({ length: 4 }, (_, index) => unclearCheck(index)),
      { a: "respond", text: "No implementation has been authored; the check remains inconclusive." },
    ];
    const { calls, events } = await runPhase(workspace, actions, {
      resumeTurns: [prior], verificationScript: null, maxTurns: 6,
    });
    assert.equal(calls.length, 5);
    assert.match(calls[4].prompt, /Write your first real implementation NOW/);
    assert.doesNotMatch(calls[4].options.grammar, /shell/);
    assert.equal(events.some(event => event.type === "verification_recovery_mask"), false);
    assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), 'module.exports = "initial";\n');
  });
}

test("perpetually inconclusive post-edit recovery cannot extend the original turn budget", async (t) => {
  const workspace = phaseFixture(t), maxTurns = 10;
  const { result, calls, events } = await runPhase(workspace, index => {
    if (index === 0) return { a: "read_file", p: "target.js" };
    if (index === 1) return { a: "write_file", p: "target.js", content: PHASE_IMPLEMENTATION };
    return unclearCheck(index);
  }, { maxTurns, verificationScript: null });
  assert.ok(events.some(event => event.type === "verification_recovery_mask"));
  assert.equal(result.turns.length, maxTurns);
  assert.equal(calls.length, maxTurns);
  assert.equal(result.done, false);
  assert.equal(result.turns.at(-1).verificationEvidence.status, "unverified");
  for (const call of calls.slice(2)) assert.doesNotMatch(call.prompt, /Write your first real implementation NOW/);
});

test("failed-anchor line editing composes with stalled verification recovery", async (t) => {
  const workspace = phaseFixture(t);
  const actions = [
    { a: "read_file", p: "target.js" },
    { a: "write_file", p: "target.js", content: PHASE_IMPLEMENTATION },
    { a: "shell", c: PHASE_VERIFY },
    { a: "shell", c: "node verify.mjs" },
    { a: "replace", p: "target.js", old: 'module.exports = "absent";', new: 'module.exports = "wrong";' },
    { a: "read_file", p: "target.js" },
    { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "Current bytes passed the direct public check; the failed proposal was unnecessary." },
  ];
  const { result, calls, events } = await runPhase(workspace, actions);
  assert.equal(result.turns[3].verificationEvidence.status, "fail");
  assert.equal(result.turns[4].editApplied, false);
  assert.match(result.turns[4].observation, /"old" text not found/);
  assert.ok(events.some(event => event.type === "verification_recovery_mask"));
  assert.match(calls[6].prompt, /EDIT RECOVERY ACTIVE/);
  assert.match(calls[6].prompt, /proposal was NOT APPLIED/);
  assert.match(calls[6].prompt, /\[verification recovery\]/);
  assert.match(calls[6].options.grammar, /shell/);
  assert.match(calls[6].options.grammar, /edit_lines/);
  assert.doesNotMatch(calls[6].options.grammar, /"replace"/);
  assert.equal(result.turns[6].verificationEvidence.status, "pass");
  assert.equal(result.done, true);
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), PHASE_IMPLEMENTATION);
});
