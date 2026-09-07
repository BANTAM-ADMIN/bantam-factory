import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contractAuditPhaseState, contractAuditDecisionContext, verificationWorkflowPromptText } from "../src/contract-audit-phase.js";
import { actionGrammar, actionJsonSchema } from "../src/grammar.js";
import { composeExcludeVerbs } from "../src/turn-mask.js";
import { runAgent } from "../src/agent.js";
import { ALL_ACTION_VERBS } from "../src/action-protocol.js";

const PENDING = Object.freeze({ needsFocused: true, needsProject: true, configuredCommand: "npm test" });

test("separate CLI obligation keeps completion masked after API/project green", () => {
  const phase = contractAuditPhaseState({ needsCli: true, needsFocused: false, needsProject: false });
  assert.equal(phase.active, true);
  assert.deepEqual(phase.excludeVerbs, ["done", "respond"]);
  assert.match(phase.note, /API-only green cannot substitute/);
  assert.deepEqual(contractAuditPhaseState({ needsCli: true }, { callerExcludedActions: ["shell", "write_file", "replace"] }).excludeVerbs, ["done"]);
  assert.equal(contractAuditPhaseState({ needsCli: true }, { interactive: true }).active, false);
  assert.equal(contractAuditPhaseState({ needsCli: true }, { advisoryMode: true }).active, false);
  assert.ok(verificationWorkflowPromptText({ schema: 1, phase: "cli", generation: 2,
    text: "CLI VERIFICATION REQUIRED: recorded process status is wrong." }).includes("recorded process status"));
});

test("maximal recovery fields remain bounded and render instead of silently losing the decision", () => {
  for (const command of ["x".repeat(510), '"'.repeat(510), "node check-api.mjs"]) {
    const pending = { ...PENDING, generation: Number.MAX_SAFE_INTEGER,
      staleFocus: { command, generation: Number.MAX_SAFE_INTEGER - 1,
        removedPaths: ["a".repeat(510), "b".repeat(510), "c".repeat(510)] } };
    const context = contractAuditDecisionContext(pending);
    assert.ok(context.text.length <= 2400);
    assert.ok(verificationWorkflowPromptText(context).includes("CONTRACT AUDIT PHASE:"));
  }
});

test("pending proof masks only impossible autonomous completion verbs", () => {
  const phase = contractAuditPhaseState(PENDING);
  assert.deepEqual(phase.excludeVerbs, ["done", "respond"]);
  const schema = actionJsonSchema({ excludeVerbs: phase.excludeVerbs, features: ["probe"] });
  for (const verb of ["shell", "read_file", "write_file", "replace", "probe"]) assert.ok(schema.properties.a.enum.includes(verb));
  for (const verb of phase.excludeVerbs) assert.ok(!schema.properties.a.enum.includes(verb));
  assert.doesNotMatch(actionGrammar({ excludeVerbs: phase.excludeVerbs }), /done|respond/);
  assert.match(phase.note, /direct assertion.*actual API or CLI/);
  assert.match(phase.note, /Repair source only for a demonstrated defect/);
  assert.match(phase.note, /falsifiable model hypothesis/);
  assert.ok(phase.note.length < 1200);
  assert.deepEqual(PENDING, { needsFocused: true, needsProject: true, configuredCommand: "npm test" });
});

test("fresh phase projection retires immediately, and preserves communication exceptions", () => {
  for (const pending of [null, {}, { needsFocused: false, needsProject: false }])
    assert.deepEqual(contractAuditPhaseState(pending), { active: false, excludeVerbs: [], note: "" });
  for (const options of [{ interactive: true }, { advisoryMode: true }])
    assert.deepEqual(contractAuditPhaseState(PENDING, options), { active: false, excludeVerbs: [], note: "" });
  const readOnly = { callerExcludedActions: ["write_file", "replace", "shell"] };
  assert.deepEqual(contractAuditPhaseState(PENDING, readOnly).excludeVerbs, ["done"]);
  assert.deepEqual(contractAuditPhaseState(PENDING, { ...readOnly, writeBatch: true }).excludeVerbs, ["done", "respond"]);
  assert.deepEqual(contractAuditPhaseState(PENDING, { ...readOnly, writeBatch: true,
    callerExcludedActions: [...readOnly.callerExcludedActions, "write_batch"] }).excludeVerbs, ["done"]);
});

test("grammar-off keeps a current reminder without claiming a sampling constraint", () => {
  const phase = contractAuditPhaseState(PENDING, { useGrammar: false });
  assert.equal(phase.active, true);
  assert.deepEqual(phase.excludeVerbs, []);
  assert.match(phase.note, /completion is not yet available/);
});

test("project-only phase names the exact verifier without requesting another focus", () => {
  const phase = contractAuditPhaseState({ ...PENDING, needsFocused: false });
  assert.match(phase.note, /Focused proof is accepted/);
  assert.match(phase.note, /exactly the configured project verifier "npm test"/);
  assert.match(phase.note, /Do not repeat the focused check/);
  assert.doesNotMatch(phase.note, /Next: execute a direct assertion/);
  for (const configuredCommand of ["x".repeat(4000), "npm test\ninvalid", null]) {
    const bounded = contractAuditPhaseState({ ...PENDING, needsFocused: false, configuredCommand });
    assert.ok(bounded.note.length < 1000);
    assert.match(bounded.note, /the exact configured project verifier/);
  }
});

test("phase composes with existing recovery masks without regranting forbidden tools", () => {
  const prior = composeExcludeVerbs({ forceWrapUp: true, verificationRecoveryTurn: true,
    baseExcludeVerbs: ["replace", "probe"] });
  const combined = [...new Set([...prior, ...contractAuditPhaseState(PENDING).excludeVerbs])];
  const allowed = actionJsonSchema({ excludeVerbs: combined.filter(verb => verb !== "probe") }).properties.a.enum;
  assert.ok(allowed.includes("shell"));
  assert.ok(allowed.includes("write_file"));
  for (const verb of ["replace", "read_file", "done", "respond"]) assert.ok(!allowed.includes(verb));
  assert.deepEqual(prior, composeExcludeVerbs({ forceWrapUp: true, verificationRecoveryTurn: true,
    baseExcludeVerbs: ["replace", "probe"] }));
});

const TASK = "Implement synchronous src/items.js collectItems(token, items). items must be an array; token must be a nonempty string even for empty arrays. Return items in order. Invalid calls throw Error. Run npm test.";
const GOOD = "export function collectItems(token, items) { if (!Array.isArray(items) || typeof token !== 'string' || !token.length) throw Error('invalid'); return [...items]; }\n";
const EDIT = { a: "write_file", p: "src/items.js", content: GOOD };
const VERIFY = { a: "shell", c: "npm test" };
const FOCUS = { a: "shell", c: `node --input-type=module -e "import assert from 'node:assert/strict'; import {collectItems} from './src/items.js'; assert.throws(() => collectItems('', [])); assert.deepEqual(collectItems('ok', []), []);"` };
const DONE = { a: "done", summary: "Implemented and verified the public API." };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-audit-phase-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {collectItems} from '../src/items.js'; test('normal order', () => assert.deepEqual(collectItems('ok', [2,1]), [2,1]));\n");
  return workspace;
}

async function run(workspace, actions, options = {}) {
  const requests = [], prompts = [];
  const result = await runAgent({ task: TASK, workspace, maxTurns: actions.length, maxInvalidPerTurn: 0,
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt, request) {
      if (prompt.includes("You are a source-code state-machine auditor.")) return {
        content: JSON.stringify({ findings: [], note: "Source review only; execute a public-API assertion." }), tokens: 1,
      };
      assert.ok(actions.length, "fixed action budget; no extra completion requests");
      prompts.push(prompt); requests.push(request);
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true };
    } }, useGrammar: true, interactive: false, grounding: false, shellSandbox: "host",
    verificationScript: "npm test", completionAudit: false, stateAudit: "off", contractStateAudit: "auto",
    contractAssertionStation: "off", diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0, ...options });
  return { result, requests, prompts };
}

test("actual audit masks the next request and fresh focused/project receipts restore DONE", async t => {
  const { result, prompts, requests } = await run(fixture(t), [EDIT, VERIFY,
    // runAgent's extension trajectory itself enables immutable history;
    // prefixMode is a CLI policy name, not an option consumed by runAgent.
    { a: "read_file", p: "src/items.js" }, FOCUS, DONE], { promptTrajectory: "extension" });
  assert.equal(result.reachedDone, true, result.turns.at(-1)?.observation);
  assert.equal(requests.length, 5);
  assert.ok(requests[1].jsonSchema.properties.a.enum.includes("done"), "pre-review work remains unchanged");
  for (const index of [2, 3]) {
    assert.match(prompts[index], /CONTRACT AUDIT PHASE: completion is not yet available/);
    for (const verb of ["done", "respond"]) assert.ok(!requests[index].jsonSchema.properties.a.enum.includes(verb));
    assert.doesNotMatch(requests[index].grammar, /done|respond/);
    for (const verb of ["shell", "write_file", "read_file", "replace"]) assert.ok(requests[index].jsonSchema.properties.a.enum.includes(verb));
  }
  assert.equal(result.turns[3].verificationReceipts.entries.length, 2, "actual focused then mandatory project execution");
  assert.equal(result.turns[3].verificationReceipts.entries[1].verificationEvidence.status, "pass");
  assert.ok(requests[4].jsonSchema.properties.a.enum.includes("done"));
  const currentObservation = prompts[4].slice(prompts[4].lastIndexOf("<observation>"));
  assert.doesNotMatch(currentObservation, /CONTRACT AUDIT PHASE:/, "current guidance retires after settled proof");
  assert.match(currentObservation, /audit-recovery requirements are satisfied/);
  assert.ok(prompts[3].startsWith(prompts[2]), "ordinary pending append preserves exact frozen history");
  assert.ok(prompts[4].startsWith(prompts[3]), "phase retirement appends current truth without rewriting prior guidance");
  assert.match(prompts[4].slice(0, prompts[4].lastIndexOf("<observation>")), /CONTRACT AUDIT PHASE:/,
    "old phase text remains historical evidence, not a rewritten cache prefix");
  assert.equal(result.metrics.contractAuditRecoveryRejections ?? 0, 0);
});

test("grammar-free or disobedient DONE still reaches the unchanged evidence gate", async t => {
  for (const useGrammar of [true, false]) {
    const { result, requests, prompts } = await run(fixture(t), [EDIT, VERIFY, DONE, FOCUS, DONE], { useGrammar });
    assert.equal(result.turns[2].doneAccepted, false);
    assert.match(result.turns[2].observation, /focused-execution/);
    assert.equal(result.reachedDone, true, result.turns.at(-1)?.observation);
    assert.match(prompts[2], /CONTRACT AUDIT PHASE:/);
    if (!useGrammar) assert.equal(requests[2].grammar, undefined);
    assert.equal(result.metrics.contractAuditRecoveryRejections, 1);
  }
});

test("resumed pending proof cannot create an empty grammar or grant a forbidden route", async t => {
  const workspace = fixture(t);
  const prior = await run(workspace, [EDIT, VERIFY]);
  assert.equal(prior.result.reachedDone, false);
  const { result, requests } = await run(workspace, [DONE], {
    resumeTurns: prior.result.turns, maxTurns: 3,
    excludeActions: ALL_ACTION_VERBS.filter(verb => verb !== "done" && verb !== "inspect"),
  });
  assert.equal(requests.length, 0, "no impossible sampler request and no extra tool grant");
  assert.equal(result.reachedDone, false);
  assert.equal(result.controllerStop?.kind, "contract-audit-no-action");
  assert.equal(result.turns.length, prior.result.turns.length);
});
