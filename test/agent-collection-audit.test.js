import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { buildArtifact } from "../src/artifact.js";

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
  assert.equal(result.turns[3].verificationEvidence.counts.passed, 1);
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
