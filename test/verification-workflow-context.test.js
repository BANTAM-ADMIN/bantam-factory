import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { buildPrompt } from "../src/prompt.js";
import { contractAuditDecisionContext, verificationWorkflowPromptText } from "../src/contract-audit-phase.js";

const MARKER = "[verification workflow: current decision]";
const FOCUSED_COMMAND = "node check-api.mjs";
const pending = {
  generation: 4, needsFocused: true, needsProject: true, configuredCommand: "npm test",
  staleFocus: { command: FOCUSED_COMMAND, generation: 3, turn: 5,
    changedPaths: ["check-api.mjs"], removedPaths: ["check-api.mjs"] },
};
const noisyObservation = "[repetition] Prior advice is ordinary clipped text.\n[guidance]\n"
  + "Review every public requirement before doing anything. ".repeat(400)
  + "\n[working-checkpoint; model hypothesis]\n" + "obsolete scratch-cleanup plan ".repeat(600);
const currentWorkflow = prompt => prompt.slice(prompt.lastIndexOf(MARKER));

test("current workflow survives observation clipping in both prompt trajectories", () => {
  const record = contractAuditDecisionContext(pending);
  const exact = verificationWorkflowPromptText(record);
  assert.match(exact, /Earlier successful check "node check-api\.mjs" belongs to generation 3, NOT this tree/);
  assert.match(exact, /Removed files: "check-api\.mjs"/);
  assert.match(exact, /do not rerun a missing file/);
  for (const extensionTrajectory of [true, false]) {
    const rendered = buildPrompt({ task: "Implement the public API.", env: "src/ test/", extensionTrajectory,
      turns: [{ i: 0, action: { a: "read_file", p: "src/items.js" },
        observation: noisyObservation, verificationWorkflow: record }] });
    assert.ok(rendered.includes(exact), "the entire typed state survives; not just its marker");
    assert.ok(rendered.indexOf(exact) > rendered.lastIndexOf("</observation>"));
    assert.ok(rendered.length < noisyObservation.length, "the ordinary oversized observation was actually clipped");
    assert.match(currentWorkflow(rendered), /Rereading unchanged implementation.*do not discharge this step/);
  }
});

test("each appended decision keeps the exact stale check; READY retires it without rewriting history", () => {
  const turns = [], renderCache = new Map();
  let previous = "";
  for (let i = 0; i < 6; i++) {
    turns.push({ i, action: { a: "read_file", p: "src/items.js", start: i < 2 ? 2 : i, limit: 8 - i },
      observation: noisyObservation, verificationWorkflow: contractAuditDecisionContext(pending) });
    const rendered = buildPrompt({ task: "Implement the public API.", env: "src/ test/", turns,
      extensionTrajectory: true, renderCache });
    assert.ok(rendered.startsWith(previous), `decision ${i} must append to the exact previous request`);
    const latest = currentWorkflow(rendered);
    assert.match(latest, /Removed files: "check-api\.mjs"/);
    assert.match(latest, /node check-api\.mjs/);
    assert.match(latest, /generation 4 needs fresh focused execution/);
    previous = rendered;
  }
  turns.push({ i: 6, action: { a: "shell", c: FOCUSED_COMMAND }, observation: noisyObservation,
    verificationWorkflow: contractAuditDecisionContext(null, { generation: 5, command: FOCUSED_COMMAND }) });
  const ready = buildPrompt({ task: "Implement the public API.", env: "src/ test/", turns,
    extensionTrajectory: true, renderCache });
  assert.ok(ready.startsWith(previous), "retirement appends current truth, leaving old instructions historical");
  assert.match(currentWorkflow(ready), /VERIFICATION READY:/);
  assert.match(currentWorkflow(ready), /NO optional cleanup step remaining/);
  assert.match(currentWorkflow(ready), /emit DONE now on this unchanged tree/);
  assert.match(currentWorkflow(ready), /Other completion gates still apply/);
  assert.doesNotMatch(currentWorkflow(ready), /Removed files:|needs fresh focused execution/);
  assert.match(ready.slice(0, ready.lastIndexOf(MARKER)), /Removed files: "check-api\.mjs"/);
});

const TASK = "Implement synchronous src/items.js collectItems(token, items). items must be an array; token must be a nonempty string even for empty arrays. Return items in order. Invalid calls throw Error. Run npm test.";
const GOOD = "export function collectItems(token, items) { if (!Array.isArray(items) || typeof token !== 'string' || !token.length) throw Error('invalid'); return [...items]; }\n"
  + Array.from({ length: 30 }, (_, i) => `// public implementation context ${i}\n`).join("");
const CHECK = "import assert from 'node:assert/strict'; import {collectItems} from './src/items.js'; assert.throws(() => collectItems('', [])); assert.deepEqual(collectItems('ok', [2, 1]), [2, 1]);\n";
const DONE = { a: "done", summary: "Implemented the API and retained its passing regression check." };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-workflow-context-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src")); fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(workspace, "src/items.js"), "export function collectItems() { throw Error('TODO'); }\n");
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {collectItems} from '../src/items.js'; test('normal order', () => assert.deepEqual(collectItems('ok', [2,1]), [2,1]));\n");
  // Preexisting, not a self-authored file: removal remains an authorized edit.
  // The narrower new self-authored-check preservation guard must not mask this
  // real stale-generation transport case.
  fs.writeFileSync(path.join(workspace, "check-api.mjs"), CHECK);
  return workspace;
}

async function run(workspace, plannedActions, options = {}) {
  const actions = [...plannedActions], prompts = [], requests = [], events = [];
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const live = process.env.BANTAM_LIVE_SANDBOX_TEST === "1";
  const result = await runAgent({ task: TASK, workspace, maxTurns: actions.length,
    maxInvalidPerTurn: 0, terminalClosureTurns: 0, promptTrajectory: "extension",
    model: { assistantPrefill: "", actTemperature: null, async complete(prompt, request) {
      if (prompt.includes("You are a source-code state-machine auditor.")) return {
        content: JSON.stringify({ findings: [], note: "A public-API assertion is still required; source review is not proof." }), tokens: 1,
      };
      assert.ok(actions.length, "bounded scripted actions; no model requests");
      prompts.push(prompt); requests.push(request);
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true };
    } }, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: live ? "docker" : "host", verificationWorkspaceReadOnly: live,
    verificationScript: "npm test", completionAudit: false, stateAudit: "off",
    contractStateAudit: "auto", contractAssertionStation: "off", diagnoseStuckTests: false,
    testFocus: false, regressionGuard: false, autoVerifyBlindEdits: 0,
    autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    observationTransform(observation, { action }) {
      return action.a === "read_file" ? `${observation}\n${noisyObservation}` : observation;
    },
    onEvent(event) { events.push(event); checkpoint.note(event); }, ...options });
  return { result, prompts, requests, events, checkpoint };
}

test("actual extension carries stale proof through repeated reads, serialization, and verified completion", async t => {
  const workspace = fixture(t);
  const actions = [
    { a: "write_file", p: "src/items.js", content: GOOD },
    { a: "shell", c: "npm test" }, { a: "shell", c: FOCUSED_COMMAND },
    { a: "shell", c: "rm -f check-api.mjs" },
    ...[4, 4, 5, 6, 7].map((limit, i) => ({ a: "read_file", p: "src/items.js", start: i < 2 ? 2 : i, limit })),
    { a: "write_file", p: "check-api.mjs", content: CHECK },
    { a: "shell", c: FOCUSED_COMMAND }, DONE,
  ];
  const { result, prompts, requests, checkpoint } = await run(workspace, actions);
  assert.equal(result.reachedDone, true, result.turns.at(-1)?.observation);
  assert.equal(result.turns.length, actions.length);
  assert.equal(result.turns[2].verificationReceipts.entries.at(-1).verificationEvidence.status, "pass");
  assert.deepEqual(result.turns[3].shellChangedPaths, ["check-api.mjs"], "the regression exercised actual check deletion");
  assert.equal(result.turns[3].shellExecution.invalidated, true);
  assert.match(currentWorkflow(prompts[3]), /VERIFICATION READY:/);
  for (let i = 4; i <= 9; i++) {
    const latest = currentWorkflow(prompts[i]);
    assert.match(latest, /Removed files: "check-api\.mjs"/, `decision ${i} names the lost executable check`);
    assert.match(latest, /Earlier successful check "node check-api\.mjs"/);
    assert.match(latest, /do not rerun a missing file/);
    assert.ok(!requests[i].jsonSchema.properties.a.enum.includes("done"), "context did not weaken the existing receipt gate");
    assert.ok(prompts[i].startsWith(prompts[i - 1]), `decision ${i} preserves extension history exactly`);
    assert.ok(prompts[i].lastIndexOf(MARKER) > prompts[i].lastIndexOf("</observation>"));
  }
  assert.match(currentWorkflow(prompts[11]), /VERIFICATION READY:/);
  assert.match(currentWorkflow(prompts[11]), /NO optional cleanup step remaining/);
  assert.doesNotMatch(currentWorkflow(prompts[11]), /Removed files:|needs fresh focused execution/);
  assert.ok(requests[11].jsonSchema.properties.a.enum.includes("done"));
  assert.equal(result.turns.at(-1).doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace, "check-api.mjs"), "utf8"), CHECK);
  const film = JSON.parse(JSON.stringify(buildArtifact({ runId: "workflow-context", stamp: "test", result })));
  const saved = JSON.parse(JSON.stringify(checkpoint.turns()));
  for (const i of [2, 3, 4, 5, 6, 7, 8, 10]) {
    assert.ok(result.turns[i].verificationWorkflow, `typed current workflow attached to turn ${i}`);
    assert.deepEqual(saved[i].verificationWorkflow, result.turns[i].verificationWorkflow, `checkpoint turn ${i}`);
    assert.deepEqual(film.turns[i].verificationWorkflow, result.turns[i].verificationWorkflow, `artifact turn ${i}`);
  }
});

test("checkpoint resume preserves historical workflow and recomputes the current missing check", async t => {
  const workspace = fixture(t);
  const first = await run(workspace, [
    { a: "write_file", p: "src/items.js", content: GOOD },
    { a: "shell", c: "npm test" }, { a: "shell", c: FOCUSED_COMMAND },
    { a: "shell", c: "rm -f check-api.mjs" },
    { a: "read_file", p: "src/items.js", start: 2, limit: 4 },
    { a: "read_file", p: "src/items.js", start: 3, limit: 5 },
  ]);
  assert.equal(first.result.reachedDone, false);
  const saved = JSON.parse(JSON.stringify(first.checkpoint.turns()));
  assert.equal(saved[4].verificationWorkflow.phase, "focused");
  const resumed = await run(workspace, [
    { a: "read_file", p: "src/items.js", start: 4, limit: 6 },
    { a: "write_file", p: "check-api.mjs", content: CHECK },
    { a: "shell", c: FOCUSED_COMMAND }, DONE,
  ], { resumeTurns: saved, maxTurns: saved.length + 4 });
  assert.deepEqual(resumed.result.turns[4].verificationWorkflow, saved[4].verificationWorkflow);
  assert.match(currentWorkflow(resumed.prompts[0]), /Earlier successful check "node check-api\.mjs"/);
  assert.match(currentWorkflow(resumed.prompts[0]), /Removed files: "check-api\.mjs"/);
  assert.ok(!resumed.requests[0].jsonSchema.properties.a.enum.includes("done"));
  assert.equal(resumed.result.reachedDone, true, resumed.result.turns.at(-1)?.observation);
  assert.equal(resumed.result.turns.at(-1).doneAccepted, true);
});

test("a later implementation milestone keeps old proof stale without ordering unrelated checks between edits", async t => {
  const workspace = fixture(t);
  const summaryCheck = "import assert from 'node:assert/strict'; import {summary} from './src/summary.js'; assert.deepEqual(summary([2, 5]), {count:2, total:7}); assert.deepEqual(summary([]), {count:0, total:0});\n";
  const {result, prompts, requests} = await run(workspace, [
    {a:'write_file', p:'src/items.js', content:GOOD},
    {a:'shell', c:'npm test'}, {a:'shell', c:FOCUSED_COMMAND},
    {a:'write_file', p:'src/sum.js', content:'export const sum = items => items.reduce((a,b) => a+b, 0);\n'},
    {a:'write_file', p:'src/summary.js', content:"import {sum} from './sum.js'; export const summary = items => ({count:items.length, total:sum(items)});\n"},
    {a:'write_file', p:'check-summary.mjs', content:summaryCheck},
    DONE,
    {a:'shell', c:'node check-summary.mjs'}, DONE,
  ], {task:TASK + ' Also implement src/summary.js summary(items), returning count and numeric total.'});
  for (const i of [4,5,6]) {
    const text = currentWorkflow(prompts[i]);
    if (i < 6) {
      assert.match(text, /Continue any unfinished implementation milestone/);
      assert.match(text, /focused assertion for the behavior changed/);
      assert.match(text, /Do not rerun an unrelated check after each edit/);
    } else assert.match(text, /Next: run exactly "node check-summary.mjs" directly/, 'a newly authored check supplies a specific current launcher');
    assert.doesNotMatch(text, /Next: rerun "node check-api.mjs"/);
    assert.ok(!requests[i].jsonSchema.properties.a.enum.includes('done'));
    for (const verb of ['write_file','replace','read_file','shell']) assert.ok(requests[i].jsonSchema.properties.a.enum.includes(verb));
    assert.ok(prompts[i].startsWith(prompts[i-1]), 'guidance appends without rewriting the cached prefix');
  }
  for (const i of [3,4,5]) assert.equal(result.turns[i].shellExecution ?? null, null, 'no check is executed between milestone edits');
  assert.equal(result.turns[6].doneAccepted, false, 'earlier receipts cannot verify the new tree');
  const receipts=result.turns[7].verificationReceipts.entries;
  assert.equal(receipts[0].shellExecution.executedCommand, 'node check-summary.mjs');
  assert.equal(receipts[1].verificationEvidence.executedCommand, 'npm test');
  assert.equal(receipts[1].verificationEvidence.status, 'pass');
  assert.equal(receipts[1].verificationEvidence.generation, receipts[0].shellExecution.generation);
  assert.equal(result.reachedDone, true);
  assert.equal(result.turns[8].doneAccepted, true);
  assert.equal(fs.readFileSync(path.join(workspace,'check-summary.mjs'),'utf8'), summaryCheck);
});

test("repeated green focused checks execute on each newly edited tree and retain real project receipts", async t => {
  const workspace = fixture(t);
  const actions = [{a:'write_file', p:'src/items.js', content:GOOD}, {a:'shell', c:'npm test'}];
  const checks = [];
  for (let i = 0; i < 9; i++) {
    if (i) actions.push({a:'write_file', p:'src/items.js', content:GOOD + `export const revision = ${i};\n`});
    checks.push(actions.length);
    actions.push({a:'shell', c:FOCUSED_COMMAND});
  }
  actions.push(DONE);
  const {result} = await run(workspace, actions, {dedupeShell:true});
  let previousGeneration = -1;
  for (const i of checks) {
    const turn = result.turns[i], receipts = turn.verificationReceipts?.entries;
    assert.equal(turn.shellExecution?.executedCommand, FOCUSED_COMMAND, `check ${i} must really execute`);
    assert.ok(turn.shellExecution.generation > previousGeneration);
    previousGeneration = turn.shellExecution.generation;
    assert.equal(receipts?.[0].shellExecution.executedCommand, FOCUSED_COMMAND);
    assert.equal(receipts[0].verificationEvidence.status, 'pass');
    for (const entry of receipts.slice(1)) {
      assert.equal(entry.verificationEvidence.executedCommand, 'npm test');
      assert.equal(entry.verificationEvidence.status, 'pass');
      assert.equal(entry.verificationEvidence.generation, previousGeneration);
    }
    assert.doesNotMatch(turn.observation, /\[no-progress\]|previous execution: turn -1/);
  }
  const finalReceipts = result.turns.at(-2).verificationReceipts.entries;
  assert.equal(finalReceipts[0].shellExecution.executedCommand, FOCUSED_COMMAND);
  assert.equal(finalReceipts[1].verificationEvidence.executedCommand, 'npm test');
  assert.equal(finalReceipts[1].verificationEvidence.status, 'pass');
  assert.equal(finalReceipts[1].verificationEvidence.generation, previousGeneration);
  assert.equal(result.reachedDone, true);
});
