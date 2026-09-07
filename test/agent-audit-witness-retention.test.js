import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { runProcess } from "../src/process-runner.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { buildArtifact } from "../src/artifact.js";
import { currentFocusedAuditWitness, pendingContractAudit } from "../src/contract-audit-recovery.js";

const TASK = "Implement and export synchronous collectItems(token, items) in src/items.js. items must be an array. token must be a nonempty string for every call, including empty arrays. Return an array preserving order. Invalid inputs must throw an Error. Run npm test. Do not modify package.json or existing public tests. You may add tests. Temporary fixture files belong in os.tmpdir() and must be cleaned up; verification uses a read-only workspace.";
const GOOD = "export function collectItems(token, items) { if (!Array.isArray(items)) throw Error('items'); if (typeof token !== 'string' || !token.length) throw Error('token'); return [...items]; }\n";
const CHECK = "import assert from 'node:assert/strict'; import { collectItems } from './src/items.js'; assert.throws(() => collectItems('', []), Error); assert.deepEqual(collectItems('valid', []), []); assert.deepEqual(collectItems('valid', [2,1]), [2,1]);\n";
const VERIFY = { a: "shell", c: "npm test" };
const FOCUS = { a: "shell", c: "node final-check.mjs" };
const WRITE_CHECK = { a: "write_file", p: "final-check.mjs", content: CHECK };
const DONE = { a: "done", summary: "Implemented and verified the requested API." };
const CLEANUP = { a: "shell", c: "rm -f final-check.mjs && ls && echo '---FINAL---' && npm test 2>&1" };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-retained-witness-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  const packageText = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import { collectItems } from '../src/items.js'; test('normal items', () => assert.deepEqual(collectItems('valid', [2,1]), [2,1]));\n";
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), publicTest);
  return { workspace, packageText, publicTest };
}

async function run(workspace, actions) {
  const prompts = [], processes = [], events = [], checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  let audits = 0;
  const result = await runAgent({
    task: TASK, workspace, promptTrajectory: "extension", maxTurns: 14, maxInvalidPerTurn: 0,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
      if (String(prompt).includes("You are a source-code state-machine auditor.")) {
        audits++;
        return { content: JSON.stringify({ findings: [], note: "Execute an assertion against the public API, including empty work." }), tokens: 1 };
      }
      prompts.push(String(prompt));
      assert.ok(actions.length, "scripted worker must finish within the exact bounded sequence");
      const action = actions.shift();
      return { content: JSON.stringify(typeof action === "function" ? action(prompt) : action), tokens: 1, stoppedEos: true, stoppedLimit: false };
    } },
    useGrammar: true, interactive: false, grounding: false, verificationScript: "npm test",
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1",
    completionAudit: false, stateAudit: "off", contractStateAudit: "auto", contractAssertionStation: "off",
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    shellProcessRunner(file, args, options) { processes.push({ file, args }); return runProcess(file, args, options); },
    onEvent(event) { events.push(event); checkpoint.note(event); },
  });
  return { result, prompts, processes, events, checkpoint, audits };
}

const opening = () => [{ a: "write_file", p: "src/items.js", content: GOOD }, WRITE_CHECK, VERIFY, FOCUS];
const recoveryOptions = (workspace, generation) => ({ generation, configuredCommand: "npm test", workspace: fs.realpathSync(workspace),
  verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" });

test("extension retains the self-authored verified witness across two exact cleanup requests, including events and checkpoint", async t => {
  const { workspace, packageText, publicTest } = fixture(t);
  const { result, prompts, processes, events, checkpoint, audits } = await run(workspace, [...opening(), CLEANUP, CLEANUP, DONE]);
  assert.equal(result.reachedDone, true, JSON.stringify(result.turns.map(turn => ({ action: turn.action, observation: turn.observation?.slice(-1000) }))));
  assert.equal(result.turns.length, 7); assert.equal(audits, 1);
  const focused = result.turns[3], generation = focused.shellExecution.generation;
  assert.equal(focused.verificationReceipts.entries.length, 2);
  assert.equal(focused.verificationReceipts.entries[0].shellExecution.executedCommand, FOCUS.c);
  assert.equal(focused.verificationReceipts.entries[1].verificationEvidence.status, "pass");
  assert.equal(focused.verificationReceipts.entries[1].verificationEvidence.configuredCommand, "npm test");
  assert.ok(processes.every(process => !process.args.includes(CLEANUP.c)), "neither cleanup compound nor its rewritten suffix is launched");
  for (const i of [4, 5]) {
    const turn = result.turns[i];
    assert.equal(turn.shellExecution, null);
    assert.equal(turn.verificationEvidence, null, "refusal does not invent another passing execution");
    assert.notEqual(turn.sourceEditedByShell, true);
    assert.deepEqual(turn.shellChangedPaths ?? [], []);
    assert.match(turn.observation, /Requested cleanup was not executed/);
    assert.match(turn.observation, /proof is still current/);
    assert.match(prompts[i + 1], /request DONE now/);
    assert.equal(pendingContractAudit(result.turns.slice(0, i + 1), recoveryOptions(workspace, generation)), null);
    assert.deepEqual(currentFocusedAuditWitness(result.turns.slice(0, i + 1), recoveryOptions(workspace, generation)),
      { command: FOCUS.c, turn: 3, generation });
  }
  assert.equal(result.metrics.auditWitnessRetentionRefusals, 2);
  const refusals = events.filter(event => event.type === "verification_workflow_refusal" && event.kind === "protected-audit-witness-cleanup");
  assert.deepEqual(refusals.map(event => event.turn), [4, 5]);
  assert.equal(checkpoint.events().filter(event => event.type === "verification_workflow_refusal" && event.kind === "protected-audit-witness-cleanup").length, 2);
  const film = JSON.parse(JSON.stringify(buildArtifact({ runId: "retained-witness", stamp: "test", result })));
  assert.equal(film.metrics.auditWitnessRetentionRefusals, 2);
  for (const i of [3, 4, 5]) {
    assert.deepEqual(checkpoint.turns()[i].verificationReceipts, film.turns[i].verificationReceipts);
    assert.equal(checkpoint.turns()[i].observation, film.turns[i].observation);
  }
  assert.equal(result.turns[6].doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "final-check.mjs"), "utf8"), CHECK);
  assert.equal(fs.readFileSync(path.join(workspace, "src/items.js"), "utf8"), GOOD);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);
});

test("a genuine production change invalidates retained proof, disarms cleanup protection, and requires a new focus before DONE", async t => {
  const { workspace, packageText, publicTest } = fixture(t);
  const changed = GOOD.replace("return [...items];", "return items.slice();");
  const { result, processes, events, audits } = await run(workspace, [...opening(),
    { a: "replace", p: "src/items.js", old: "return [...items];", new: "return items.slice();" }, DONE,
    CLEANUP, WRITE_CHECK, FOCUS, DONE]);
  assert.equal(result.reachedDone, true, JSON.stringify(result.turns.map(turn => ({ action: turn.action, observation: turn.observation?.slice(-1000) }))));
  assert.equal(result.turns.length, 10); assert.equal(audits, 2);
  assert.equal(result.turns[4].editApplied, true, "retention never refuses a necessary production edit");
  assert.match(result.turns[4].observation, /Verification invalidated/);
  assert.equal(result.turns[5].doneAccepted, false, "old retained green cannot certify the edited implementation");
  assert.equal(result.turns[6].shellExecution.command, CLEANUP.c, "stale proof no longer activates retention");
  assert.ok(result.turns[6].shellChangedPaths.includes("final-check.mjs"));
  assert.equal(processes.filter(process => process.args.includes(CLEANUP.c)).length, 1);
  assert.equal(events.filter(event => event.kind === "protected-audit-witness-cleanup").length, 0);
  const oldGeneration = result.turns[3].shellExecution.generation, fresh = result.turns[8];
  assert.ok(fresh.shellExecution.generation > oldGeneration);
  assert.equal(fresh.verificationReceipts.entries[0].shellExecution.executedCommand, FOCUS.c);
  assert.equal(fresh.verificationReceipts.entries[1].verificationEvidence.status, "pass");
  assert.equal(result.turns[9].doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "src/items.js"), "utf8"), changed);
  assert.equal(fs.readFileSync(path.join(workspace, "final-check.mjs"), "utf8"), CHECK);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);
});
