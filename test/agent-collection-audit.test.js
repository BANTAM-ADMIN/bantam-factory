import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { buildArtifact } from "../src/artifact.js";
import { pendingContractAudit } from "../src/contract-audit-recovery.js";

const TASK = "Implement and export synchronous collectItems(token, items) in src/items.js. items must be an array. token must be a nonempty string for every call, including empty arrays. Return an array preserving order. Invalid inputs must throw an Error. Run npm test.";
const BAD = "export function collectItems(token, items) { if (!Array.isArray(items)) throw Error('items'); const result = []; for (const item of items) { if (typeof token !== 'string' || !token.length) throw Error('token'); result.push(item); } return result; }\n";
const GOOD = "export function collectItems(token, items) { if (!Array.isArray(items)) throw Error('items'); if (typeof token !== 'string' || !token.length) throw Error('token'); return [...items]; }\n";
const EXTRA = "import test from 'node:test'; import assert from 'node:assert/strict'; import { collectItems } from '../src/items.js'; test('token precondition also applies with no work', () => { assert.throws(() => collectItems('', [])); assert.deepEqual(collectItems('valid', []), []); });\n";
const VERIFY = { a: "shell", c: "npm test" };
const FOCUSED = { a: "shell", c: "node --test test/edge.test.js" };
const DONE = { a: "done", summary: "Implemented the API and checked it." };
const edit = content => ({ a: "write_file", p: "src/items.js", content });

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-collection-audit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { collectItems } from '../src/items.js'; test('normal items', () => assert.deepEqual(collectItems('valid', [2, 1]), [2, 1]));\n");
  return workspace;
}

async function run(workspace, actions, extra = {}) {
  const audits = [], prompts = [], events = [];
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const result = await runAgent({
    task: TASK, workspace, model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
      if (String(prompt).includes("You are a source-code state-machine auditor.")) {
        audits.push(prompt);
        return { content: JSON.stringify({ findings: audits.length === 1 ? [{
          entrypoint: "collectItems", requirement: "token must be a nonempty string for every call, including empty arrays",
          location: "src/items.js: collectItems loop", fixture: "collectItems('', [])",
          expected: "throws Error", predicted: "returns [] because validation occurs only inside the loop",
        }] : [], note: "Unverified source review; execute the public-API assertion." }), tokens: 25 };
      }
      prompts.push(prompt);
      assert.ok(actions.length, "no unbounded repair turns");
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: 16, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: "host", verificationScript: "npm test", completionAudit: false,
    stateAudit: "off", contractStateAudit: "auto", diagnoseStuckTests: false,
    testFocus: false, regressionGuard: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    onEvent(event) { events.push(event); checkpoint.note(event); }, ...extra,
  });
  return { result, audits, prompts, events, checkpoint };
}

test("fresh collection audit makes an empty-work precondition executable before completion", async (t) => {
  const workspace = fixture(t);
  const { result, audits, events, checkpoint } = await run(workspace, [
    { a: "read_file", p: "src/items.js" }, edit(BAD), VERIFY, DONE,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED,
    edit(GOOD), FOCUSED, FOCUSED, VERIFY, DONE,
  ]);
  assert.equal(result.reachedDone, true, JSON.stringify({ modelFailure: result.modelFailure, turns: result.turns.map(turn => ({ a: turn.action, obs: turn.observation?.slice(0,220), proof: turn.verificationEvidence, shell: turn.shellExecution })) }));
  assert.equal(audits.length, 2);
  assert.equal(result.turns[1].contractStateAudit, undefined, "first incomplete draft cannot spend the collection review");
  assert.equal(result.turns[2].contractStateAudit.focus, "collection-preconditions");
  assert.equal(result.turns[2].verificationEvidence.status, "pass", "the visible suite missed the cross-product edge");
  assert.equal(result.turns[3].doneAccepted, false);
  assert.match(result.turns[3].observation, /still needs.*focused-execution/);
  assert.equal(result.turns[5].verificationEvidence.status, "fail", "real new API assertion demonstrates the defect");
  assert.equal(result.turns[7].verificationEvidence?.status, "pass", JSON.stringify(result.turns.map(turn => ({ a: turn.action.a, obs: turn.observation?.slice(0,180), proof: turn.verificationEvidence?.status }))));
  assert.equal(result.turns[7].contractStateAudit.focus, "collection-preconditions");
  assert.equal(result.turns[8].verificationEvidence?.status, "pass", JSON.stringify(result.turns.map(turn => ({ a: turn.action.a, obs: turn.observation?.slice(0,180), proof: turn.verificationEvidence?.status }))));
  assert.equal(result.turns[8].contractStateAudit, undefined, "two-call cap stays fixed");
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.equal(result.metrics.contractAuditRecoveryRejections, 1);
  assert.ok(events.some(event => event.type === "contract_audit_recovery"));
  const film = buildArtifact({ runId: "collection-audit", stamp: "test", result });
  assert.deepEqual(checkpoint.turns().filter(turn => turn.contractStateAudit).map(turn => turn.contractStateAudit),
    film.turns.filter(turn => turn.contractStateAudit).map(turn => turn.contractStateAudit));
  assert.ok(audits[0].includes(BAD.trim()));
  assert.ok(audits[1].includes(GOOD.trim()));
  assert.doesNotMatch(audits[1], /Unverified counterexample: collectItems/);
});

test("test-only edits do not spend a second review on identical source", async (t) => {
  const { result, audits } = await run(fixture(t), [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED, VERIFY, DONE]);
  assert.equal(result.reachedDone, true);
  assert.equal(audits.length, 1, "review identity follows current source, not test-file edits");
});

test("proposed done can start the collection review without trusting old green", async (t) => {
  const { result, audits } = await run(fixture(t), [edit(GOOD), DONE,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED, VERIFY, DONE]);
  assert.equal(audits.length, 1);
  assert.equal(result.turns[1].doneAccepted, false);
  assert.equal(result.turns[1].contractStateAudit.focus, "collection-preconditions");
  assert.equal(result.reachedDone, true);
});

test("explicitly disabled collection reviews preserve the existing opt-out", async (t) => {
  const { result, audits } = await run(fixture(t), [edit(GOOD), VERIFY, DONE], { contractStateAudit: "off" });
  assert.equal(audits.length, 0);
  assert.equal(result.reachedDone, true);
});

test("an actually executed named case clears audit recovery after fresh project verification", async (t) => {
  const { result, audits } = await run(fixture(t), [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA },
    { a: "shell", c: "node --test --test-name-pattern='precondition' test/edge.test.js" },
    VERIFY, DONE]);
  assert.equal(audits.length, 1);
  assert.equal(result.turns[3].verificationEvidence.status, "pass");
  assert.equal(result.turns[3].verificationReceipts.entries[0].verificationEvidence.counts.passed, 1);
  assert.equal(result.turns[3].verificationReceipts.entries[1].verificationEvidence.counts.passed, 2,
    "the mandatory configured check follows the focused assertion without another model decision");
  assert.match(result.turns[3].shellExecution.executedCommand, /--test-timeout=\d+/);
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted, true);
});

test("passive status echoes yield actual direct check receipts through audit completion", async (t) => {
  const broad = { a: "shell", c: 'npm test; echo "EXIT=$?"' };
  const focused = { a: "shell", c: 'node --test test/edge.test.js; echo "CHECK_EXIT=$?"' };
  const { result } = await run(fixture(t), [edit(GOOD), broad,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, focused, broad, DONE]);
  assert.equal(result.turns[1].verificationEvidence.status, "pass");
  assert.equal(result.turns[3].verificationEvidence.status, "pass");
  assert.match(result.turns[3].shellExecution.executedCommand, /^node --test --test-timeout=\d+ test\/edge.test.js$/);
  assert.match(result.turns[3].observation, /echo was not executed/);
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted, true);
});

test("exact-workspace cd checks execute unchanged and retain measured cwd through completion evidence", async (t) => {
  const workspace = fixture(t);
  const focused = { a: "shell", c: `cd '${workspace}' && node --test test/edge.test.js` };
  const project = { a: "shell", c: `cd '${workspace}' && npm test` };
  const { result, audits, checkpoint } = await run(workspace, [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, focused, project, DONE],
  { contractAssertionStation: "off",
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" });
  assert.equal(audits.length, 1);
  assert.equal(result.turns.length, 6, "actual focused and project executions finish without additional repair turns");
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.equal(result.metrics.contractAssertionStations ?? 0, 0);
  const film = JSON.parse(JSON.stringify(buildArtifact({ runId: "collection-audit-cwd", stamp: "test", result })));
  const savedTurns = JSON.parse(JSON.stringify(checkpoint.turns()));
  for (const [index, action, passed] of [[3, focused, 1], [4, project, 2]]) {
    const turn = result.turns[index];
    const workerProof = turn.verificationReceipts.entries.find(entry => entry.shellExecution)?.verificationEvidence;
    assert.equal(turn.shellExecution.command, action.c, "requested compound command is preserved");
    assert.ok(turn.shellExecution.executedCommand.startsWith(`cd '${workspace}' && `), "the actual execution retains its cd prefix");
    assert.equal(turn.shellExecution.exitCode, 0);
    assert.equal(turn.shellExecution.cwd, fs.realpathSync(workspace));
    assert.equal(turn.verificationEvidence.status, "pass");
    assert.equal(turn.verificationEvidence.statusScope, "execution");
    assert.equal(workerProof.counts.passed, passed, "the real worker test runner executed the expected assertions");
    assert.equal(turn.verificationEvidence.counts.failed, 0);
    assert.equal(turn.verificationEvidence.cwd, fs.realpathSync(workspace));
    for (const stored of [film.turns[index], savedTurns[index]]) {
      assert.deepEqual(stored.shellExecution, turn.shellExecution);
      assert.deepEqual(stored.verificationEvidence, turn.verificationEvidence);
      assert.equal(stored.shellExecution.cwd, fs.realpathSync(workspace));
      assert.equal(stored.verificationEvidence.cwd, fs.realpathSync(workspace));
    }
  }
});

test("a fresh focused inline assertion immediately receives exact project verification and can finish", async (t) => {
  const workspace = fixture(t);
  const focused = { a: "shell", c: `node --input-type=module -e "import assert from 'node:assert/strict'; import {collectItems} from './src/items.js'; assert.throws(() => collectItems('', [])); assert.deepEqual(collectItems('valid', []), []);"` };
  const { result, checkpoint } = await run(workspace, [edit(GOOD), VERIFY, focused, DONE], {
    shellSandbox: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly: process.env.BANTAM_LIVE_SANDBOX_TEST === "1",
  });
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.length, 4, "no repeated focus, renamed project command, or extra model action");
  assert.equal(result.metrics.contractAuditRecoveryVerifies, 1);
  assert.equal(result.metrics.landingVerifies ?? 0, 0);
  assert.equal(result.metrics.contractAuditRecoveryRejections ?? 0, 0);
  const [assertion, project] = result.turns[2].verificationReceipts.entries;
  assert.equal(assertion.verificationEvidence, null, "inline assertions use their real shell receipt, not invented suite counts");
  assert.equal(assertion.shellExecution.exitCode, 0);
  assert.equal(project.verificationEvidence.command, "npm test");
  assert.equal(project.verificationEvidence.source, "automatic");
  assert.equal(project.verificationEvidence.auditPromptSha256, result.turns[1].contractStateAudit.promptSha256);
  assert.equal(project.verificationEvidence.status, "pass");
  assert.deepEqual(checkpoint.turns()[2].verificationReceipts, result.turns[2].verificationReceipts);
});

test("duplicate project checks cannot mask shell while a review still needs a focused assertion", async (t) => {
  const { result, prompts, events } = await run(fixture(t), [edit(GOOD), VERIFY, VERIFY, VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED, DONE]);
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  const duplicate = result.turns[3];
  assert.equal(duplicate.verificationEvidence, null, "dedup is not a new project receipt");
  assert.match(duplicate.observation, /identical command was not executed again/);
  assert.match(duplicate.observation, /focused-execution/);
  assert.doesNotMatch(duplicate.observation, /mark it done|respond now|last real check remains UNVERIFIED/);
  const event = events.find(event => event.type === "duplicate_action");
  assert.match(event.message, /contract-audit-recovery/);
  assert.doesNotMatch(prompts[4], /shell.*(?:masked|excluded)|(?:masked|excluded).*shell/i);
});

test("failed automatic audit verification is not retried indefinitely on the same generation", async (t) => {
  const { result } = await run(fixture(t), [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/fail.test.js", content: "import test from 'node:test'; import assert from 'node:assert/strict'; test('deliberately red project check', () => assert.fail('repair this before completion'));\n" },
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED,
    { a: "shell", c: "node --test --test-name-pattern='precondition' test/edge.test.js" },
    VERIFY, DONE, DONE], { maxTurns: 9 });
  assert.equal(result.reachedDone, false);
  assert.equal(result.metrics.contractAuditRecoveryVerifies, 1);
  assert.equal(result.turns[4].verificationReceipts.entries[0].verificationEvidence.status, "pass");
  assert.equal(result.turns[4].verificationReceipts.entries[1].verificationEvidence.status, "fail");
  assert.match(result.turns[4].observation, /contract-audit-check.*Result: FAIL/);
  assert.doesNotMatch(result.turns[4].observation, /receipts are now complete/);
  assert.equal(result.turns[5].verificationReceipts.entries.length, 1, "different fresh focus cannot trigger a second automatic attempt on this generation");
  assert.equal(result.turns.at(-1).doneAccepted, false);
});

test("last-budget focused execution survives a fresh landing suite, storage and resume", async (t) => {
  const workspace = fixture(t);
  const sandbox = process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host";
  const readOnly = sandbox === "docker";
  const { result, checkpoint } = await run(workspace, [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, FOCUSED, DONE],
  { maxTurns: 5, shellSandbox: sandbox, verificationWorkspaceReadOnly: readOnly });
  assert.equal(result.reachedDone, true, result.turns.at(-1).observation);
  assert.equal(result.turns.length, 5);
  assert.equal(result.metrics.landingVerifies, 2, "pre-focused cached green cannot replace the post-focused project execution");
  assert.match(result.turns[2].observation, /Next action: run the focused API assertion directly/);
  assert.doesNotMatch(result.turns[2].observation, /Emit done now/);
  const focused = result.turns[3];
  assert.match(focused.observation, /Emit done now/);
  assert.equal(focused.verificationReceipts.turn, 3);
  assert.equal(focused.verificationReceipts.entries.length, 2);
  const [assertion, project] = focused.verificationReceipts.entries;
  assert.equal(assertion.sequence, 0);
  assert.equal(assertion.verificationEvidence.source, "shell");
  assert.equal(assertion.verificationEvidence.counts.passed, 1);
  assert.equal(assertion.shellExecution.exitCode, 0);
  assert.equal(project.sequence, 1);
  assert.equal(project.verificationEvidence.source, "landing");
  assert.equal(project.verificationEvidence.command, "npm test");
  assert.equal(project.verificationEvidence.counts.passed, 2);
  assert.equal(project.verificationEvidence.workspaceReadOnly, readOnly);
  assert.equal(project.shellExecution, null);
  for (const receipt of [assertion.verificationEvidence, assertion.shellExecution, project.verificationEvidence]) {
    assert.equal(receipt.cwd, fs.realpathSync(workspace));
    assert.equal(receipt.generation, project.verificationEvidence.generation);
    assert.match(receipt.outputSha256, /^[a-f0-9]{64}$/);
  }
  const film = JSON.parse(JSON.stringify(buildArtifact({ runId: "ordered-landing", stamp: "test", result })));
  const saved = JSON.parse(JSON.stringify(checkpoint.turns()));
  const options = { generation: project.verificationEvidence.generation,
    configuredCommand: "npm test", verificationWorkspaceReadOnly: readOnly, workspace: fs.realpathSync(workspace) };
  for (const stored of [film.turns, saved]) {
    assert.deepEqual(stored[3].verificationReceipts, focused.verificationReceipts);
    assert.equal(pendingContractAudit(stored.slice(0, 4), options), null);
  }
  const resumed = await run(workspace, [DONE], { maxTurns: 5, resumeTurns: saved.slice(0, 4),
    shellSandbox: sandbox, verificationWorkspaceReadOnly: readOnly });
  assert.equal(resumed.result.reachedDone, true, resumed.result.turns.at(-1).observation);
  assert.deepEqual(resumed.result.turns[3].verificationReceipts, focused.verificationReceipts);
});

test("landing green never instructs done over an unresolved masked assertion", async (t) => {
  const workspace = fixture(t);
  const masked = { a: "shell", c: `node --input-type=module -e "import assert from 'node:assert/strict'; import {collectItems} from './src/items.js'; assert.throws(() => collectItems('', [])); console.log('BOUNDARY ASSERTIONS OK')"; echo "exit=$?"; npm test 2>&1; echo "exit=$?"` };
  const { result } = await run(workspace, [edit(GOOD), VERIFY,
    { a: "write_file", p: "test/edge.test.js", content: EXTRA }, masked, DONE], { maxTurns: 5 });
  assert.equal(result.reachedDone, false);
  assert.match(result.turns[3].observation, /Project green is not yet completion/);
  assert.match(result.turns[3].observation, /Next action: run the focused API assertion directly/);
  assert.doesNotMatch(result.turns[3].observation, /Emit done now/);
  assert.equal(result.turns[3].verificationEvidence.status, "unverified", "cached landing cannot overwrite the masked worker receipt");
  assert.equal(result.turns[3].verificationReceipts.entries.length, 1, "no invented cached execution");
  assert.equal(result.turns.at(-1).doneAccepted, false);
});
