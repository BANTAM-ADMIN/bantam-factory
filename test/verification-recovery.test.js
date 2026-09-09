import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeExcludeVerbs } from "../src/turn-mask.js";
import { latestVerificationRecovery, verificationRecoveryNote, latestUnresolvedFocusedFailure, focusedFailureReminder } from "../src/verification-recovery.js";
import { runAgent } from "../src/agent.js";
import { contextUpdatePromptText, clipKeepingControllerAnnotation } from "../src/prompt.js";
import { VERIFICATION_RECEIPTS_SCHEMA } from "../src/contract-audit-recovery.js";
import { actionPromptMenuLine, LINE_EDIT_FEATURE } from "../src/action-protocol.js";

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

const reminderOptions = { generation: 6, workspace: "/fixture/workspace", configuredCommand: "npm test" };
function reminderEntry(command, exitCode = 0, generation = 6) {
  const shellExecution = { command, executedCommand: command, exitCode, generation,
    cwd: reminderOptions.workspace, workspaceReadOnly: false, sandbox: "host",
    invalidated: false, blocked: false, timedOut: false, interrupted: false,
    outputSha256: "a".repeat(64) };
  return { shellExecution, verificationEvidence: { ...shellExecution, schema: 1, source: "shell",
    status: exitCode === 0 ? "pass" : "fail", statusScope: "execution", statusCommand: command,
    counts: null, countsScope: "single-execution", outputSha256: "b".repeat(64) } };
}
function reminderTurn(index, entries) {
  return { ...entries.at(-1), verificationReceipts: { schema: VERIFICATION_RECEIPTS_SCHEMA,
    authority: "controller-execution-order", turn: index,
    entries: entries.map((entry, sequence) => ({ ...entry, sequence })) } };
}

test("a failed focused command survives unrelated green diagnostics and broad verification", () => {
  // Receipt projection of Stream's real check_audit -> dbg2 -> landing sequence:
  // the diagnostic process exits zero while printing a child's failure.
  const command = "node /tmp/check_audit.mjs";
  const project = reminderEntry("npm test");
  project.verificationEvidence.source = "landing"; project.shellExecution = null;
  const turns = [reminderTurn(0, [reminderEntry(command, 1)]),
    { ...reminderTurn(1, [reminderEntry("node /tmp/dbg2.mjs")]), observation: 'status 2\nstderr "bad input"' },
    reminderTurn(2, [project])];
  const failure = latestUnresolvedFocusedFailure(turns, reminderOptions);
  assert.deepEqual(failure, { command, generation: 6, turn: 0, exitCode: 1, historical: false });
  assert.match(focusedFailureReminder(failure), /different green command or printed diagnostic does not show this check passed/);
  assert.equal(latestUnresolvedFocusedFailure([...turns, reminderTurn(3, [reminderEntry(command)])], reminderOptions), null);
  assert.equal(latestUnresolvedFocusedFailure([{ ...reminderEntry(command, 1) }], reminderOptions)?.command, command,
    "fully bound legacy execution remains readable without inventing an envelope");
});

test("ordered receipts retain a focused failure beside same-turn landing green and clear only an actual later match", () => {
  const command = "node check-api.mjs", failed = reminderEntry(command, 1);
  const project = reminderEntry("npm test");
  project.verificationEvidence.source = "landing"; project.shellExecution = null;
  const row = reminderTurn(0, [failed, project]); row.shellExecution = failed.shellExecution;
  assert.equal(latestUnresolvedFocusedFailure([row], reminderOptions)?.command, command);
  const normalized = reminderEntry(command);
  normalized.shellExecution.command = normalized.verificationEvidence.command = `${command}; echo EXIT=$?`;
  assert.equal(latestUnresolvedFocusedFailure([row, reminderTurn(1, [normalized])], reminderOptions), null,
    "clearing binds the actually executed command, not its normalized-away passive echo");
  assert.equal(latestUnresolvedFocusedFailure([reminderTurn(0, [reminderEntry(command), failed])], reminderOptions)?.command, command);
  assert.equal(latestUnresolvedFocusedFailure([reminderTurn(0, [failed, reminderEntry(command)])], reminderOptions), null);
});

test("source changes make a failed check historical rather than claiming the new code is defective", () => {
  const command = "node check-api.mjs", turns = [reminderTurn(0, [reminderEntry(command, 1, 5)])];
  const failure = latestUnresolvedFocusedFailure(turns, reminderOptions);
  assert.equal(failure.historical, true);
  const note = focusedFailureReminder(failure);
  assert.match(note, /historical evidence, not a claim the current code is defective/);
  assert.doesNotMatch(note, /failure was observed on the current generation/);
  assert.ok(latestUnresolvedFocusedFailure([...turns, reminderTurn(1, [reminderEntry(command, 0, 4)])], reminderOptions),
    "older-generation green cannot settle a newer failure");
  assert.equal(latestUnresolvedFocusedFailure([...turns, reminderTurn(1, [reminderEntry(command, 0, 6)])], reminderOptions), null);
  const delivered = clipKeepingControllerAnnotation("output\n" + note + "\n[working-checkpoint; model hypothesis]\n" + "old plan ".repeat(3000));
  assert.ok(note.length < 700 && delivered.includes(note));
});

test("malformed, mismatched, invalidated and masked receipts neither invent failure nor erase one", () => {
  const command = "node check-api.mjs", failed = reminderTurn(0, [reminderEntry(command, 1)]);
  const mutations = [
    row => { row.verificationReceipts.authority = "worker"; },
    row => { row.verificationReceipts.turn = 99; },
    row => { row.verificationReceipts.entries[0].sequence = 2; },
    row => { row.verificationReceipts.entries[0].verificationEvidence.outputSha256 = "missing"; },
    row => { row.verificationReceipts.entries[0].shellExecution.executedCommand = `${command}; true`; },
    row => { row.verificationReceipts.entries[0].verificationEvidence.statusCommand = "node other-check.mjs"; },
    row => { row.verificationReceipts.entries[0].shellExecution.cwd = "/elsewhere"; },
    row => { row.verificationReceipts.entries[0].shellExecution.invalidated = true; },
    row => { row.verificationReceipts.entries[0].verificationEvidence.counts = { passed: 0, failed: 0, total: 0 }; },
    row => { row.verificationEvidence = { ...row.verificationEvidence, command: "forged alias" }; },
  ];
  for (const mutate of mutations) {
    const row = reminderTurn(1, [reminderEntry(command)]); mutate(row);
    assert.ok(latestUnresolvedFocusedFailure([failed, row], reminderOptions), mutate.toString());
  }
  for (const execution of [reminderEntry(`${command}; true`, 1), reminderEntry("node -e 'console.log(false)'", 1),
    { verificationEvidence: { status: "fail", command }, shellExecution: null }]) {
    assert.equal(latestUnresolvedFocusedFailure([reminderTurn(0, [execution])], reminderOptions), null);
  }
  const malformed = reminderTurn(0, [reminderEntry(command, 1)]);
  malformed.verificationReceipts = Object.create({ schema: VERIFICATION_RECEIPTS_SCHEMA });
  assert.equal(latestUnresolvedFocusedFailure([malformed], reminderOptions), null);
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
    model: { codex: options.codex === true, assistantPrefill: "", actTemperature: null, async complete(prompt, request) {
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

test("real failed check stays in delivered context after print-only success and retires after its fresh pass", async t => {
  const workspace = phaseFixture(t);
  fs.writeFileSync(path.join(workspace, "check-api.mjs"),
    "import assert from 'node:assert/strict'; import value from './target.js'; assert.equal(value, 'ready');\n");
  fs.writeFileSync(path.join(workspace, "debug.mjs"),
    "import value from './target.js'; console.log('observed value:', value);\n");
  const { result, calls } = await runPhase(workspace, [
    { a: "write_file", p: "target.js", content: 'module.exports = "broken";\n' },
    { a: "shell", c: "node check-api.mjs" }, { a: "shell", c: "node debug.mjs" },
    { a: "write_file", p: "target.js", content: PHASE_IMPLEMENTATION },
    { a: "shell", c: "node check-api.mjs" }, { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "The corrected result passes the focused and configured checks." },
  ], { extensionTrajectory: true, prefixMode: "immutable", progressAwareness: false });
  assert.equal(result.turns[1].shellExecution.exitCode, 1);
  assert.equal(result.turns[2].shellExecution.exitCode, 0);
  assert.match(result.turns[2].observation, /observed value: broken/);
  assert.match(result.turns[2].observation, /\[diagnosis\] Unresolved focused-check observation: "node check-api\.mjs"/);
  assert.match(calls[3].prompt, /different green command or printed diagnostic does not show this check passed/);
  assert.match(result.turns[3].observation, /historical evidence, not a claim the current code is defective/);
  assert.equal(result.turns[4].shellExecution.exitCode, 0);
  assert.doesNotMatch(result.turns[4].observation, /Unresolved focused-check observation/);
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.metrics.contractAudits ?? 0, 0, "the reminder adds no model review calls");
  assert.equal(result.turns.length, 7, "the advisory adds neither actions nor execution budget");
});

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

test("Codex keeps its schema stable through failed-anchor recovery and rejects masked actions before execution", async t => {
  const workspace = phaseFixture(t);
  const actions = [
    { a: "read_file", p: "target.js" },
    { a: "replace", p: "target.js", old: 'absent anchor', new: PHASE_IMPLEMENTATION },
    { a: "replace", p: "target.js", old: 'module.exports = "initial";\n', new: 'CORRUPTED\n' },
    { a: "read_file", p: "target.js" },
    { a: "edit_lines", p: "target.js", start: 1, end: 1, new: PHASE_IMPLEMENTATION.trimEnd() },
    { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "Repaired and verified." },
  ];
  const { result, calls } = await runPhase(workspace, actions, {
    codex: true, maxInvalidPerTurn: 1, promptTrajectory: "extension", immutableHistory: true,
    autoForceEditAfter: 0,
  });
  assert.equal(result.done, true);
  assert.equal(new Set(calls.map(call => JSON.stringify(call.options.jsonSchema))).size, 1);
  assert.equal(result.rejectedOutputs.filter(row => row.kind === "action_policy").length, 1);
  assert.ok(result.turns.every(turn => !String(turn.observation).includes("CORRUPTED")));
  assert.match(calls[2].prompt, /ACTION POLICY FOR THIS TURN:/);
  const policy = calls[2].prompt.slice(calls[2].prompt.lastIndexOf("ACTION POLICY FOR THIS TURN:"));
  assert.doesNotMatch(policy.split(".")[0], /\breplace\b/);
  assert.match(calls[3].prompt, /unavailable at this checkpoint/);
  assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), PHASE_IMPLEMENTATION);
});

test("long-task extension delivers the dynamic edit schema through coactive recovery and applies a real line edit", async (t) => {
  const workspace = phaseFixture(t);
  const publicBytes = fs.readFileSync(path.join(workspace, "test/public.test.js"));
  const actions = [
    { a: "read_file", p: "target.js" },
    { a: "write_file", p: "target.js", content: 'module.exports = "wrong";\n' },
    { a: "shell", c: PHASE_VERIFY },
    { a: "replace", p: "target.js", old: 'module.exports = "absent";', new: PHASE_IMPLEMENTATION },
    { a: "read_file", p: "target.js" },
    { a: "shell", c: "node verify.mjs" },
    { a: "edit_lines", p: "target.js", start: 1, end: 1, new: PHASE_IMPLEMENTATION.trimEnd() },
    { a: "shell", c: PHASE_VERIFY },
    { a: "done", summary: "Repaired the current source and passed its direct public test." },
  ];
  const { result, calls, events } = await runPhase(workspace, actions, {
    task: "Fix target.js to export ready and pass its unchanged public test.\n"
      + "Use Node.js builtins. Preserve the public contract and existing protected tests.\n".repeat(80),
    promptTrajectory: "extension", goalReanchor: true, goalReanchorAfter: 0,
    preserveSlimmedControlAnnotations: true,
  });
  assert.equal(result.turns[3].editApplied, false);
  assert.ok(events.some(event => event.type === "verification_recovery_mask"));
  const call = calls[6];
  assert.match(call.prompt, /\[verification recovery\]/);
  assert.match(call.options.grammar, /edit_lines/);
  assert.match(call.options.grammar, /shell/);
  assert.doesNotMatch(call.options.grammar, /read_file/);
  assert.doesNotMatch(call.options.grammar, /\\"replace\\"/);
  const expected = actionPromptMenuLine("edit_lines", { features: [LINE_EDIT_FEATURE] });
  assert.ok(call.prompt.includes(expected), "the newly enabled verb's complete canonical schema must actually reach the worker");
  const update = result.turns[5].contextUpdates.find(entry => entry.kind === "action-contract");
  assert.equal(update.turn, 6);
  assert.ok(call.prompt.includes(contextUpdatePromptText(update)));
  assert.match(contextUpdatePromptText(update), /read_file is unavailable/);
  assert.ok(result.metrics.contextUpdatePromptReceipts.some(receipt => receipt.id === update.id && receipt.status === "included"));
  assert.equal(result.turns[6].editApplied, true);
  assert.equal(result.turns[7].verificationEvidence.status, "pass");
  assert.equal(result.done, true);
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.deepEqual(fs.readFileSync(path.join(workspace, "test/public.test.js")), publicBytes);
  assert.equal(fs.readFileSync(path.join(workspace, "target.js"), "utf8"), PHASE_IMPLEMENTATION);
});

for (const excludeEdit of [false, true]) {
  test(`document-revision action interface respects caller exclusions${excludeEdit ? " including edit_lines" : " despite the grammar read exemption"}`, async (t) => {
    const workspace = phaseFixture(t);
    const draft = "# Plan\nCurrent draft.\n";
    fs.writeFileSync(path.join(workspace, "plan.md"), draft);
    const calls = [];
    const result = await runAgent({
      task: "Write plan.md with the required rollout and verification sections.", workspace,
      model: { assistantPrefill: "", actTemperature: null, async complete(prompt, options) {
        calls.push({ prompt, options });
        return { content: JSON.stringify({ a: "read_file", p: "plan.md" }), tokens: 1, stoppedEos: true, timings: {} };
      } },
      resumeTurns: [
        { action: { a: "write_file", p: "plan.md", content: draft }, editApplied: true,
          observation: "wrote plan.md\n[completion-audit] Review the complete document." },
        { action: { a: "read_file", p: "plan.md" }, observation: draft
          + "\nDocument review context: review the current draft.\n- Task-derived safe-rollout gap: missing verification section" },
      ],
      maxTurns: 3, maxInvalidPerTurn: 0, useGrammar: true, grounding: false,
      interactive: false, promptTrajectory: "extension", planAudit: "on",
      excludeActions: ["read_file", "shell", "probe", ...(excludeEdit ? ["edit_lines"] : [])],
      progressAwareness: false, completionAudit: false,
      stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
      autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].options.grammar, /read_file/, "exercise the existing document-only grammar exemption");
    const update = result.turns[1].contextUpdates?.find(entry => entry.kind === "action-contract");
    if (excludeEdit) {
      assert.equal(update, undefined, "an excluded edit verb must not receive a privileged interface grant");
    } else {
      assert.equal(update.reason, "document-revision");
      assert.ok(calls[0].prompt.includes(contextUpdatePromptText(update)));
      for (const verb of ["read_file", "shell", "probe"]) assert.ok(!update.availableVerbs.includes(verb));
      assert.match(update.text, /read_file is unavailable/);
      assert.doesNotMatch(update.text, /read_file that exact path\/range before editing/);
    }
    assert.equal(result.turns.length, 2, "the caller-excluded action is rejected before execution, not recorded as a fresh read");
    assert.equal(result.done, false);
    assert.equal(fs.readFileSync(path.join(workspace, "plan.md"), "utf8"), draft);
  });
}
