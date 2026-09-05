import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { runAgent } from "../src/agent.js";
import { verificationVerdict } from "../src/done-guard.js";

function artifact(turns) {
  return buildArtifact({ runId: "receipt-test", stamp: "test", model: {}, result: { turns, metrics: {} } });
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-receipt-film-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const receiptFields = {
  verificationEvidence: { status: "pass", source: "landing", command: "npm test", generation: 2, outputSha256: "execution-output-identity" },
  shellExecution: { command: "node probe.js", generation: 2, exitCode: 0, timedOut: false, outputSha256: "probe-output-identity" },
  editOutcome: { applied: false, reason: "protected", paths: ["test/original.test.js"] },
  contractStateAudit: { status: "report", generation: 2, advisory: true, sources: [{ path: "src/parser.js", sha256: "source-identity" }], report: "hypothesis, not proof" },
  editApplied: false,
  scopedVerify: { verdict: "pass", command: "npm test", tests: [] },
  sourceEditedByShell: false,
  shellChangedPaths: [],
  shellScopeRollback: { clean: true, paths: ["test/original.test.js"] },
  stateAudit: { pending: false, deferralsUsed: 1 },
};

test("final artifacts preserve exact typed receipts, false flags, and audit state without shared references", () => {
  const turn = structuredClone({ action: { a: "shell", c: "npm test" }, observation: "clipped output", ...receiptFields });
  const saved = JSON.parse(JSON.stringify(artifact([turn])));
  for (const [key, value] of Object.entries(receiptFields)) assert.deepEqual(saved.turns[0][key], value, key);
  turn.verificationEvidence.generation = 99;
  turn.contractStateAudit.sources[0].sha256 = "changed";
  assert.equal(saved.turns[0].verificationEvidence.generation, 2);
  assert.equal(saved.turns[0].contractStateAudit.sources[0].sha256, "source-identity");
});

test("new null proof stays null and cannot fall back to passing prose; legacy absence stays absent", () => {
  const base = { action: { a: "shell", c: "npm test" }, observation: "all 5 tests passed" };
  const saved = artifact([{ ...base, verificationEvidence: null, shellExecution: null, editOutcome: null }, base]);
  assert.equal(Object.hasOwn(saved.turns[0], "verificationEvidence"), true);
  assert.equal(saved.turns[0].verificationEvidence, null);
  assert.equal(saved.turns[0].shellExecution, null);
  assert.equal(saved.turns[0].editOutcome, null);
  assert.notEqual(verificationVerdict(saved.turns[0]), "pass");
  assert.equal(Object.hasOwn(saved.turns[1], "verificationEvidence"), false);
  assert.equal(Object.hasOwn(saved.turns[1], "shellExecution"), false);
});

test("autosaved and resumed checkpoints retain controller receipts and their explicit null boundaries", (t) => {
  const dest = path.join(directory(t), "partial.json");
  const checkpoint = new RunCheckpoint({ dest, autosaveEvery: 1 });
  checkpoint.note({ type: "action", action: { a: "shell", c: "npm test" } });
  const observation = structuredClone({ type: "observation", observation: "clipped", ...receiptFields });
  checkpoint.note(observation);
  observation.verificationEvidence.generation = 99;
  let saved = JSON.parse(fs.readFileSync(dest, "utf8"));
  for (const [key, value] of Object.entries(receiptFields)) assert.deepEqual(saved.turns[0][key], value, key);
  const resumed = new RunCheckpoint({ dest, autosaveEvery: 1, initialEvidence: saved });
  resumed.note({ type: "action", action: { a: "write_file", p: "src/parser.js", content: "blocked" } });
  resumed.note({ type: "observation", observation: "all 5 tests passed", verificationEvidence: null, shellExecution: null, editApplied: false });
  saved = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.deepEqual(saved.turns[0].contractStateAudit, receiptFields.contractStateAudit);
  assert.equal(saved.turns[1].editApplied, false);
  assert.equal(saved.turns[1].verificationEvidence, null);
  assert.equal(saved.turns[1].shellExecution, null);
  assert.notEqual(verificationVerdict(saved.turns[1]), "pass");
});

test("real agent observation events persist the same receipts as the final film", async (t) => {
  const workspace = directory(t);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "original");
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const actions = [
    { a: "write_file", p: "keep.txt", content: "forbidden" },
    { a: "shell", c: "npm test" },
    { a: "done", summary: "Checked." },
  ];
  const model = { assistantPrefill: "", actTemperature: null, async complete() {
    return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
  } };
  const result = await runAgent({ workspace, task: "Do not modify keep.txt. Run npm test.", model,
    maxTurns: 3, interactive: true, useGrammar: false, grounding: false,
    completionAudit: false, stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
    shellProcessRunner: async () => ({ code: 0, stdout: "TAP version 13\nok 1 - check\n1..1\n# tests 1\n# pass 1\n# fail 0\n", stderr: "" }),
    onEvent: (event) => checkpoint.note(event),
  });
  const saved = artifact(result.turns).turns;
  const partial = checkpoint.turns();
  assert.equal(partial.length, saved.length);
  for (let i = 0; i < saved.length; i++) {
    for (const key of Object.keys(receiptFields)) {
      assert.deepEqual(partial[i][key], saved[i][key], `turn ${i}: ${key}`);
    }
  }
  assert.equal(partial[0].editApplied, false);
  assert.equal(partial[0].verificationEvidence, null);
  assert.equal(partial[1].verificationEvidence.status, "pass");
  assert.equal(partial[1].verificationEvidence.source, "shell");
});

test("agent resume preserves explicit null receipt keys instead of reclassifying them as legacy evidence", async (t) => {
  const model = { assistantPrefill: "", actTemperature: null, async complete() {
    return { content: JSON.stringify({ a: "done", summary: "Resumed." }), tokens: 1, stoppedEos: true, timings: {} };
  } };
  const result = await runAgent({ workspace: directory(t), task: "Report status.", model,
    maxTurns: 2, interactive: true, useGrammar: false, grounding: false,
    completionAudit: false, stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
    resumeTurns: [{ i: 0, parsedAction: { a: "read_file", p: "example.txt" }, observation: "all 5 tests passed",
      verificationEvidence: null, shellExecution: null, editOutcome: null }],
  });
  for (const key of ["verificationEvidence", "shellExecution", "editOutcome"]) {
    assert.equal(Object.hasOwn(result.turns[0], key), true, key);
    assert.equal(result.turns[0][key], null, key);
  }
  assert.notEqual(verificationVerdict(result.turns[0]), "pass");
});
