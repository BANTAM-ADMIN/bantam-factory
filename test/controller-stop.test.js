import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wasControllerStopped } from "../src/controller-stop.js";
import { runAgent } from "../src/agent.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { acceptedBantamCompletion } from "../scripts/repobrief-astra-fights.mjs";

test("controller stop classifier fails closed on typed and legacy contradictory completion", () => {
  assert.equal(wasControllerStopped({ reachedDone: true, verification: { status: "pass" } }), false);
  assert.equal(wasControllerStopped({ controllerStop: { kind: "progress-gate", turn: 2 } }), true);
  for (const key of ["progressGateTerminations", "artifactVerificationGateTerminations", "interactiveStopTerminations"]) {
    for (const count of [1, -1, "0", NaN]) assert.equal(wasControllerStopped({ metrics: { [key]: count } }), true);
    assert.equal(wasControllerStopped({ metrics: { [key]: 0 } }), false);
  }
  assert.equal(wasControllerStopped({ summary: "Stopped by progress gate; grading current workspace state." }), true);
  assert.equal(acceptedBantamCompletion({ result: { reachedDone: true, pass: true, controllerStop: { kind: "progress-gate" } } }), false);
});

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-controller-stop-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "target.js"), "module.exports = 0;\n");
  fs.writeFileSync(path.join(workspace, "other.txt"), "background\n");
  fs.writeFileSync(path.join(workspace, "verify.cjs"), 'require("node:assert/strict").equal(require("./target.js"), 1);\n');
  return workspace;
}

async function run(workspace, actions, options = {}) {
  let index = 0;
  const events = [];
  const result = await runAgent({
    task: "Update target.js and check the result.", workspace,
    model: { assistantPrefill: "", actTemperature: null, async complete() {
      const action = actions[index++] ?? { a: "read_file", p: "other.txt" };
      return { content: JSON.stringify(action), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    } },
    maxTurns: 20, useGrammar: false, grounding: false, shellSandbox: "host",
    verificationScript: "node verify.cjs", verificationPolicy: "always",
    completionAudit: false, stateAudit: "off", contractStateAudit: "off",
    autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    progressAwareness: true, progressNudgeAfter: 2, progressGateMaxRejections: 1,
    artifactVerifyAfter: 99, artifactVerifyMaxRejections: 1,
    dedupeActions: false, dedupeShell: false, diagnoseStuckTests: false,
    onEvent: event => events.push(event), ...options,
  });
  return { result, events };
}

for (const kind of ["progress-gate", "artifact-verification-gate"]) {
  test(`${kind} retains passing final verification without manufacturing completion`, async (t) => {
    const workspace = fixture(t);
    const actions = [{ a: "read_file", p: "target.js" }, { a: "write_file", p: "target.js", content: "module.exports = 1;\n" }];
    if (kind === "progress-gate") actions.push({ a: "shell", c: "node verify.cjs" });
    else actions.push({ a: "write_file", p: "output.txt", content: "result\n" });
    const { result, events } = await run(workspace, actions, kind === "artifact-verification-gate"
      ? { task: "Update target.js and write output.txt with the result.", artifactVerifyAfter: 1, progressNudgeAfter: 99 } : {});
    assert.equal(result.controllerStop?.kind, kind);
    assert.equal(result.done, false);
    assert.equal(result.reachedDone, false);
    assert.equal(result.responded, false);
    assert.equal(result.verification.status, "pass");
    assert.equal(result.skillLearned, null);
    assert.ok(result.turns.length < 20);
    const last = result.turns.at(-1);
    assert.deepEqual(last.controllerStop, result.controllerStop);
    assert.deepEqual(events.filter(event => event.type === "observation").at(-1).controllerStop, result.controllerStop);
    const film = buildArtifact({ runId: "controller-stop", stamp: "test", task: "fixture", result });
    assert.deepEqual(film.result.controllerStop, result.controllerStop);
    assert.deepEqual(film.turns.at(-1).controllerStop, result.controllerStop);
    assert.equal(film.result.pass, true, "artifact verification remains independent of worker completion");
    assert.equal(acceptedBantamCompletion(film), false);
  });
}

test("a genuine done action remains completion and its acceptance survives film serialization", async (t) => {
  const { result } = await run(fixture(t), [
    { a: "read_file", p: "target.js" },
    { a: "write_file", p: "target.js", content: "module.exports = 1;\n" },
    { a: "shell", c: "node verify.cjs" },
    { a: "done", summary: "The current implementation passed verification." },
  ]);
  assert.equal(result.reachedDone, true);
  assert.equal(result.controllerStop, null);
  assert.equal(result.turns.at(-1).doneAccepted, true);
  const film = buildArtifact({ runId: "genuine-done", stamp: "test", result });
  assert.equal(film.turns.at(-1).doneAccepted, true);
  assert.equal(acceptedBantamCompletion(film), true);
});

test("interactive hard stop is not an accepted answer", async (t) => {
  const priorLimit = process.env.BANTAM_INTERACTIVE_RECON_LIMIT;
  const priorMax = process.env.BANTAM_INTERACTIVE_STOP_MAX;
  process.env.BANTAM_INTERACTIVE_RECON_LIMIT = "1";
  process.env.BANTAM_INTERACTIVE_STOP_MAX = "1";
  t.after(() => {
    if (priorLimit === undefined) delete process.env.BANTAM_INTERACTIVE_RECON_LIMIT;
    else process.env.BANTAM_INTERACTIVE_RECON_LIMIT = priorLimit;
    if (priorMax === undefined) delete process.env.BANTAM_INTERACTIVE_STOP_MAX;
    else process.env.BANTAM_INTERACTIVE_STOP_MAX = priorMax;
  });
  const { result } = await run(fixture(t), [], { task: "Inspect other.txt and report.", interactive: true, progressAwareness: false, verificationScript: null });
  assert.equal(result.controllerStop?.kind, "interactive-budget");
  assert.equal(result.reachedDone, false);
  assert.equal(result.responded, false);
});

test("rejected completion and controller-stop receipts survive crash checkpoint and resume", async (t) => {
  const workspace = fixture(t), dest = path.join(workspace, "partial.json");
  const checkpoint = new RunCheckpoint({ dest, autosaveEvery: 0 });
  const controllerStop = { kind: "artifact-verification-gate", turn: 0 };
  checkpoint.note({ type: "action", action: { a: "done", summary: "proposed completion" } });
  checkpoint.note({ type: "observation", observation: "Stopped by artifact verification gate.", doneAccepted: false, controllerStop });
  assert.equal(checkpoint.flush("test"), true);
  const saved = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(saved.turns[0].doneAccepted, false);
  assert.deepEqual(saved.turns[0].controllerStop, controllerStop);
  const { result } = await run(workspace, [], { resumeTurns: saved.turns, maxTurns: 1, verificationScript: null });
  assert.equal(result.turns[0].doneAccepted, false);
  assert.deepEqual(result.turns[0].controllerStop, controllerStop);
  assert.equal(result.reachedDone, false);
});
