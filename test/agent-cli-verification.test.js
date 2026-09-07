import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { cliVerificationPassed } from "../src/contract-cli-verification.js";

const TASK = "Extend tool.mjs. Export synchronous `transform(value)`, returning {value}. Reject a non-number value with an Error. Preserve the public tests and package.json. Run npm test.\n\nCLI: `node tool.mjs INPUT_FILE`. The UTF-8 JSON file contains `{value}`. Exactly one argument is required. Success prints one result JSON followed by newline, exits 0 and has no stderr. Invalid arguments, unreadable files or invalid JSON exit 2, with nonempty stderr and no stdout. Importing must not run the CLI.";
const API = "export function transform(value) { if (typeof value !== 'number') throw Error('number'); return {value}; }\n";
const BASE = "import fs from 'node:fs';\nimport {pathToFileURL} from 'node:url';\n" + API + `
function main() {
  if (process.argv.length !== 3) { process.stderr.write('usage\\n'); process.exitCode = 2; return; }
  try { const value = transform(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).value); process.stdout.write(JSON.stringify(value) + '\\n'); }
  catch (error) { process.stderr.write(String(error.message) + '\\n'); process.exitCode = 2; }
}
`;
const GOOD = BASE + "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();\n";
const BAD = BASE + "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.length === 3) main();\n";
const SPEC = { module: "tool.mjs", input: { value: 3 } };

test("real CLI subprocess evidence blocks API-green DONE, binds generation, and permits repaired completion", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1" ? "requires explicit live Docker opt-in" : false,
  timeout: 90000,
}, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-cli-verification-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "test"));
  const packageText = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import {transform} from '../tool.mjs'; test('public API works',()=>assert.deepEqual(transform(3),{value:3}));\n";
  fs.writeFileSync(path.join(workspace, "tool.mjs"), API);
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), publicTest);
  const actions = [
    { a: "write_file", p: "tool.mjs", content: BAD }, { a: "shell", c: "npm test" },
    { a: "done", summary: "The exported API passed." },
    { a: "write_file", p: "tool.mjs", content: GOOD }, { a: "shell", c: "npm test" },
    { a: "write_file", p: "tool.mjs", content: BAD },
    { a: "done", summary: "Reuse the prior CLI pass after the edit." },
    { a: "write_file", p: "tool.mjs", content: GOOD }, { a: "shell", c: "npm test" },
    { a: "done", summary: "Current CLI cases and project checks pass." },
  ];
  const prompts = [], stationPrompts = [], events = [], checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const result = await runAgent({
    workspace, task: TASK, model: { assistantPrefill: "", async complete(prompt, options = {}) {
      if (options.recordLabel === "contract-cli-assertion") {
        stationPrompts.push(prompt);
        return { content: JSON.stringify(SPEC), tokens: 30, stoppedLimit: false, stoppedEos: true };
      }
      prompts.push(prompt);
      assert.ok(actions.length, "the scripted worker has a bounded repair sequence");
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedLimit: false, stoppedEos: true };
    } },
    maxTurns: 10, maxInvalidPerTurn: 0, useGrammar: false, interactive: false, grounding: false,
    shellSandbox: "docker", shellNetwork: false, probeEnabled: true,
    verificationScript: "npm test", verificationWorkspaceReadOnly: true,
    contractStateAudit: "off", contractAssertionStation: "off", completionAudit: false, stateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
    onEvent(event) { events.push(event); checkpoint.note(event); },
  });
  const stations = result.turns.filter(turn => turn.cliVerification).map(turn => turn.cliVerification);
  assert.equal(stationPrompts.length, 4, JSON.stringify({ cliEnabled: result.metrics?.cliVerificationEnabled,
    turns: result.turns.map(turn => ({ a: turn.parsedAction?.a, obs: turn.observation?.slice(0, 200), status: turn.cliVerification?.status })) }));
  assert.deepEqual(stations.map(station => station.status), ["failed", "complete", "failed", "complete"]);
  assert.equal(result.turns[2].doneAccepted, false, "API-green cannot discharge a failed CLI obligation");
  assert.equal(result.turns[6].doneAccepted, false, "an edit invalidates a previous CLI proof");
  assert.equal(result.turns.at(-1).doneAccepted, true, result.turns.at(-1).observation);
  assert.equal(result.reachedDone, true);
  assert.ok(stations[1].generation < stations[2].generation);
  assert.equal(cliVerificationPassed(stations[1].contract, stations[1], { generation: stations[2].generation }), false);
  for (const [index, station] of stations.entries()) {
    const check = station.probeEvidence.stages[2];
    const packet = JSON.parse(check.stdout);
    assert.equal(packet.reference.status, 0);
    assert.equal(packet.reference.result, "returned");
    const apiOutcome = JSON.parse(Buffer.from(packet.reference.outcomeBase64, "base64"));
    assert.deepEqual(apiOutcome.value, { value: 3 });
    assert.equal(Object.hasOwn(station.spec, "expected"), false);
    assert.deepEqual(packet.cases.map(item => item.case), ["valid-input", "missing-argument", "extra-argument"]);
    assert.deepEqual(packet.cases.map(item => item.status), index % 2 === 0 ? [0, 0, 0] : [0, 2, 2]);
    assert.equal(check.code, index % 2 === 0 ? 1 : 0, "wrapper status is separate from actual child statuses");
    if (index % 2 === 0) assert.equal(station.projectVerification, undefined);
    else {
      assert.equal(station.projectVerification.status, "pass");
      assert.equal(station.projectVerification.workspaceReadOnly, true);
      assert.equal(station.projectVerification.generation, station.generation);
    }
  }
  const current = prompts[2].slice(prompts[2].lastIndexOf("[verification workflow: current decision]"));
  assert.match(current, /missing-argument: failed; actual exit 0, required 2/);
  assert.match(current, /extra-argument: failed; actual exit 0, required 2/);
  const artifact = buildArtifact({ runId: "cli-proof", stamp: "test", result });
  assert.deepEqual(artifact.turns.filter(turn => turn.cliVerification).map(turn => turn.cliVerification), stations);
  assert.deepEqual(checkpoint.turns().filter(turn => turn.cliVerification).map(turn => turn.cliVerification), stations);
  assert.equal(events.filter(event => event.type === "contract_cli").length, 4);
  assert.equal(fs.readFileSync(path.join(workspace, "tool.mjs"), "utf8"), GOOD);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);
  assert.deepEqual(fs.readdirSync(workspace).sort(), ["package.json", "test", "tool.mjs"]);
});

test("a source edit triggers measured API-reference diagnostics even while the configured suite is red", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1" ? "requires explicit live Docker opt-in" : false,
  timeout: 60000,
}, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-cli-red-api-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "test"));
  const packageText = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import {transform} from '../tool.mjs'; test('independent API requirement',()=>assert.deepEqual(transform(3),{value:3}));\n";
  fs.writeFileSync(path.join(workspace, "tool.mjs"), GOOD);
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  fs.writeFileSync(path.join(workspace, "test/public.test.js"), publicTest);
  const broken = GOOD.replace(API, "export function transform(value) { throw Error('API_RED_MARKER'); }\n");
  const actions = [{ a: "write_file", p: "tool.mjs", content: broken }, { a: "shell", c: "npm test" },
    { a: "write_file", p: "tool.mjs", content: GOOD }, { a: "done", summary: "API repaired; real CLI preserves its measured result." }];
  const workerPrompts = [], proposals = [];
  const result = await runAgent({
    workspace, task: TASK, model: { assistantPrefill: "", async complete(prompt, options = {}) {
      if (options.recordLabel === "contract-cli-assertion") {
        proposals.push(prompt); return { content: JSON.stringify(SPEC), tokens: 30, stoppedLimit: false, stoppedEos: true };
      }
      workerPrompts.push(prompt); assert.ok(actions.length);
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedLimit: false, stoppedEos: true };
    } },
    maxTurns: 4, maxInvalidPerTurn: 0, useGrammar: true, interactive: false, grounding: false,
    shellSandbox: "docker", shellNetwork: false, probeEnabled: true,
    verificationScript: "npm test", verificationWorkspaceReadOnly: true,
    contractStateAudit: "off", contractAssertionStation: "off", completionAudit: false, stateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    diagnoseStuckTests: false, testFocus: false, regressionGuard: false,
  });
  assert.equal(proposals.length, 2);
  assert.equal(result.turns[0].cliVerification?.status, "unavailable", "source-edit scheduling does not require an earlier green suite");
  assert.equal(result.turns[1].verificationEvidence.status, "fail", "independent API test still fails");
  const first = result.turns[0].cliVerification;
  const raw = JSON.parse(first.probeEvidence.stages[2].stdout);
  assert.equal(raw.reference.result, "unavailable");
  assert.equal(raw.reference.status, 0, "clean reference runner exit is not a returned API value");
  const outcome = JSON.parse(Buffer.from(raw.reference.outcomeBase64, "base64"));
  assert.equal(outcome.kind, "threw");
  assert.equal(outcome.diagnostic.message, "API_RED_MARKER");
  assert.deepEqual(raw.cases, [], "there is no comparison to an invented expected value");
  assert.match(workerPrompts[1], /API_RED_MARKER/);
  assert.equal(result.turns[2].cliVerification?.status, "complete");
  assert.equal(result.turns[2].cliVerification.projectVerification.status, "pass");
  assert.equal(result.turns[2].cliVerification.projectVerification.workspaceReadOnly, true);
  assert.equal(result.turns.at(-1).doneAccepted, true, result.turns.at(-1).observation);
  assert.equal(fs.readFileSync(path.join(workspace, "test/public.test.js"), "utf8"), publicTest);
  assert.equal(fs.readFileSync(path.join(workspace, "package.json"), "utf8"), packageText);
  assert.equal(fs.readFileSync(path.join(workspace, "tool.mjs"), "utf8"), GOOD);
});
