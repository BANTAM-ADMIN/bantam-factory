import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Executor } from "../src/executor.js";
import { runAgent } from "../src/agent.js";
import { runShellProcess } from "../src/executor.js";
import { composeInstructionGuards } from "../src/instruction-guard.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";

const before = 'export function report(xs) {\n  const out = [...xs];\n  out.sort();\n  return out;\n}\n';
const after = 'export function report(xs) {\n  const out = [...xs];\n  return out;\n}\nfunction cli() { console.log("ready"); }\n';
const preserved = before + 'function cli() { console.log("ready"); }\n';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-edit-preserve-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.mjs"), before);
  return { workspace, executor: new Executor(workspace, { shellSandbox: "host" }) };
}

for (const action of [
  { a: "replace", p: "source.mjs", old: before, new: after },
  { a: "replace", p: "source.mjs", old: before, new: after, line: 1 },
  { a: "edit_lines", p: "source.mjs", start: 1, end: 6, new: after },
  { a: "write_file", p: "source.mjs", content: after },
  { a: "patch", edits: [{ p: "source.mjs", old: before, new: after }] },
  { a: "write_batch", files: [{ p: "source.mjs", content: after }] },
]) test(`${action.a}${action.line ? " at line" : ""}: additive deletion is reviewed before mutation, identical retry can confirm`, async t => {
  const { workspace, executor } = fixture(t);
  const first = await executor.execute(action);
  assert.equal(first.editOutcome.applied, false);
  assert.equal(first.editOutcome.reason, "confirmation_required");
  assert.match(first.observation, /edit-preservation/);
  assert.match(first.observation, /out\.sort/);
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), before);
  assert.equal(first.editOutcome.preservationReviews[0].decision, "review-required");
  const second = await executor.execute(action);
  assert.equal(second.editOutcome.applied, true, second.observation);
  assert.equal(second.editOutcome.preservationReviews[0].decision, "confirmed");
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), after);
});

test("correcting the proposal preserves previous behavior without an extra confirmation", async t => {
  const { workspace, executor } = fixture(t);
  await executor.execute({ a: "write_file", p: "source.mjs", content: after });
  const result = await executor.execute({ a: "write_file", p: "source.mjs", content: preserved });
  assert.equal(result.editOutcome.applied, true);
  assert.equal(result.editOutcome.preservationReviews, undefined);
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), preserved);
});

test("two-file write transaction retains earlier confirmation until all files can commit", async t => {
  const { workspace, executor } = fixture(t);
  fs.writeFileSync(path.join(workspace, "second.mjs"), before);
  const action = { a: "write_batch", files: [
    { p: "source.mjs", content: after }, { p: "second.mjs", content: after },
  ] };
  for (let i = 0; i < 2; i++) {
    const result = await executor.execute(action);
    assert.equal(result.editOutcome.applied, false);
    for (const file of ["source.mjs", "second.mjs"]) assert.equal(fs.readFileSync(path.join(workspace, file), "utf8"), before);
  }
  const result = await executor.execute(action);
  assert.equal(result.editOutcome.applied, true, result.observation);
  for (const file of ["source.mjs", "second.mjs"]) assert.equal(fs.readFileSync(path.join(workspace, file), "utf8"), after);
});

test("confirmation is bound to exact before and after bytes", async t => {
  const { executor } = fixture(t);
  await executor.execute({ a: "write_file", p: "source.mjs", content: after });
  const result = await executor.execute({ a: "write_file", p: "source.mjs", content: after.replace("ready", "changed") });
  assert.equal(result.editOutcome.applied, false);
  assert.equal(result.editOutcome.preservationReviews[0].decision, "review-required");
});

test("live Docker protects existing tests while permitting a new test file", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1", timeout: 20000,
}, async t => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, "test"));
  const supplied = path.join(workspace, "test", "public.test.js");
  fs.writeFileSync(supplied, "// supplied test\n");
  const { protectedExistingTests } = composeInstructionGuards({ workspace,
    instruction: "Do not modify existing public tests. You may add tests." });
  const result = await runShellProcess(workspace,
    'node -e \'const f=require("fs"); let denied=false; try { f.appendFileSync("test/public.test.js","changed"); } catch(e) { if(e.code!=="EROFS")throw e; denied=true; } if(!denied)process.exit(1); f.writeFileSync("test/new.test.js","// new test\\n");\'',
    { shellSandbox: "docker", shellNetwork: false, readOnlyWorkspacePaths: protectedExistingTests, timeoutMs: 15000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(supplied, "utf8"), "// supplied test\n");
  assert.equal(fs.readFileSync(path.join(workspace, "test/new.test.js"), "utf8"), "// new test\n");
});

test("live agent receives concrete removal evidence and persists the review decision", async t => {
  const { workspace } = fixture(t), calls = [], events = [];
  const actions = [
    { a: "write_file", p: "source.mjs", content: after },
    { a: "write_file", p: "source.mjs", content: preserved },
    { a: "respond", text: "Added the CLI while preserving existing behavior." },
  ];
  const result = await runAgent({ workspace, task: "Add a CLI to source.mjs while preserving its existing behavior.",
    model: { assistantPrefill: "", async complete(prompt) {
      calls.push(prompt);
      return { content: JSON.stringify(actions.shift() ?? { a: "done", summary: "Added CLI." }), tokens: 1, timings: {} };
    } }, maxTurns: 4, interactive: true, grounding: false, shellSandbox: "host",
    completionAudit: false, verificationPolicy: "after_edit", onEvent: event => events.push(event),
  });
  assert.match(calls[1], /edit-preservation/);
  assert.match(calls[1], /out\.sort/);
  assert.equal(result.turns[0].editApplied, false);
  assert.equal(result.turns[0].editOutcome.preservationReviews[0].decision, "review-required");
  assert.ok(events.some(event => event.type === "edit_preservation_review"));
  assert.equal(fs.readFileSync(path.join(workspace, "source.mjs"), "utf8"), preserved);
});

const chainBefore = 'export function report(xs) { return {entries:[...xs].sort().map(x => ({value:x}))}; }\n';
const chainAfter = chainBefore.replace('[...xs].sort()', 'xs');

for (const action of [
  { a: "replace", p: "source.mjs", old: '[...xs].sort()', new: 'xs' },
  { a: "edit_lines", p: "source.mjs", start: 1, end: 1, new: chainAfter.trimEnd() },
  { a: "write_file", p: "source.mjs", content: chainAfter },
  { a: "patch", edits: [{ p: "source.mjs", old: chainBefore, new: chainAfter }] },
  { a: "write_batch", files: [{ p: "source.mjs", content: chainAfter }] },
]) test(`${action.a}: removing an intermediate call receives exact-byte review without an added function`, async t => {
  const { workspace, executor } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'source.mjs'), chainBefore);
  const first = await executor.execute(action);
  assert.equal(first.editOutcome.applied, false);
  assert.equal(first.editOutcome.reason, 'confirmation_required');
  const review = first.editOutcome.preservationReviews[0];
  assert.equal(review.decision, 'review-required');
  assert.equal(review.witness.chainRemovalRisk, true);
  assert.equal(review.witness.additiveReplacementRisk, false);
  assert.equal(review.witness.addedTopLevelFunctionCount, 0);
  assert.match(first.observation, /sort/);
  assert.match(first.observation, /No files were changed/);
  assert.equal(fs.readFileSync(path.join(workspace, 'source.mjs'), 'utf8'), chainBefore);
  const second = await executor.execute(action);
  assert.equal(second.editOutcome.applied, true, second.observation);
  assert.equal(second.editOutcome.preservationReviews[0].decision, 'confirmed');
  assert.equal(fs.readFileSync(path.join(workspace, 'source.mjs'), 'utf8'), chainAfter);
});

test('call-chain review cannot bypass caller-protected files or confirm a different transition', async t => {
  const { workspace, executor } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'source.mjs'), chainBefore);
  await executor.execute({ a: 'write_file', p: 'source.mjs', content: chainAfter });
  const changed = await executor.execute({ a: 'write_file', p: 'source.mjs', content: chainAfter + '// changed proposal\n' });
  assert.equal(changed.editOutcome.applied, false);
  assert.equal(changed.editOutcome.preservationReviews[0].decision, 'review-required');
  const restricted = new Executor(workspace, { shellSandbox: 'host',
    readOnlyWorkspacePaths: ['source.mjs'] });
  for (let i = 0; i < 2; i++) {
    const result = await restricted.execute({ a: 'write_file', p: 'source.mjs', content: chainAfter });
    assert.equal(result.editOutcome.applied, false);
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'source.mjs'), 'utf8'), chainBefore);
});

test('extension worker sees the removed call, preserves it, verifies ordering and finishes', async t => {
  const { workspace } = fixture(t), prompts = [], checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  fs.writeFileSync(path.join(workspace, 'source.mjs'), chainBefore);
  fs.mkdirSync(path.join(workspace, 'test'));
  const testPath = path.join(workspace, 'test/public.test.mjs');
  const publicTest = `import test from 'node:test'; import assert from 'node:assert/strict';
import {report, render} from '../source.mjs';
test('sorted nonmutating report and new renderer', () => {
  const input = ['z', 'A', 'a'];
  assert.deepEqual(report(input), {entries:[{value:'A'},{value:'a'},{value:'z'}]});
  assert.deepEqual(input, ['z', 'A', 'a']);
  assert.equal(render(input), 'A,a,z');
});\n`;
  fs.writeFileSync(testPath, publicTest);
  const preservedFeature = chainBefore + 'export function render(xs) { return report(xs).entries.map(x => x.value).join(","); }\n';
  const actions = [
    { a: 'read_file', p: 'source.mjs' },
    { a: 'replace', p: 'source.mjs', old: '[...xs].sort()', new: 'xs' },
    { a: 'write_file', p: 'source.mjs', content: preservedFeature },
    { a: 'shell', c: 'node --test test/public.test.mjs' },
    { a: 'done', summary: 'Added render while preserving sorted, nonmutating report behavior.' },
  ];
  const result = await runAgent({ workspace,
    task: 'Add exported render(xs) in source.mjs, joining report entry values with commas. Preserve sorted nonmutating report behavior. Do not modify existing public tests. Run node --test test/public.test.mjs.\n'
      + 'Preserve existing behavior while extending the module.\n'.repeat(100),
    model: { assistantPrefill: '', actTemperature: null, async complete(prompt) {
      prompts.push(prompt);
      assert.ok(actions.length, 'bounded repair actions only');
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
    } }, maxTurns: 8, maxInvalidPerTurn: 0, interactive: false, grounding: false,
    promptTrajectory: 'extension', goalReanchor: true, goalReanchorAfter: 0,
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === '1' ? 'docker' : 'host',
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === '1',
    verificationScript: 'node --test test/public.test.mjs', completionAudit: false,
    contractStateAudit: 'off', stateAudit: 'off', regressionGuard: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent: event => checkpoint.note(event),
  });
  assert.equal(result.turns[1].editApplied, false);
  assert.match(prompts[2], /edit-preservation/);
  assert.match(prompts[2], /sort/);
  assert.equal(result.turns[1].editOutcome.preservationReviews[0].witness.chainRemovalRisk, true);
  assert.equal(result.turns[2].editApplied, true);
  assert.equal(result.turns[3].verificationEvidence.status, 'pass');
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(fs.readFileSync(testPath, 'utf8'), publicTest);
  assert.equal(fs.readFileSync(path.join(workspace, 'source.mjs'), 'utf8'), preservedFeature);
  const saved = checkpoint.turns()[1].editOutcome.preservationReviews;
  const film = buildArtifact({ runId: 'chain-preservation', stamp: 'test', result });
  assert.deepEqual(saved, result.turns[1].editOutcome.preservationReviews);
  assert.deepEqual(film.turns[1].editOutcome.preservationReviews, saved);
});
