import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArtifact, saveArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";
import { runAgent } from "../src/agent.js";
import { createContextUpdate } from "../src/context-updates.js";
import { contextUpdatePromptText } from "../src/prompt.js";

const source = 'export const delimiter = "\\t"; // café\n';
const sourceIdentity = {
  path: "src/parser.js",
  bytes: Buffer.byteLength(source),
  sha256: crypto.createHash("sha256").update(source).digest("hex"),
};

function updates() {
  return [
    { schema: 1, id: "decision-2", kind: "decision", generation: 2,
      text: "Keep the delimiter contract.\nThis decision is not execution evidence.",
      paths: [{ ...sourceIdentity }] },
    { schema: 1, id: "edit-recovery-2", kind: "edit-recovery", generation: 2,
      text: "The edit did not apply; the file remains unchanged.", paths: [{ ...sourceIdentity }] },
  ];
}

function artifact(turns, metrics = {}) {
  return buildArtifact({ runId: "context-update-persistence", stamp: "test", model: {}, result: { turns, metrics } });
}

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-context-update-film-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("final artifacts clone nested context updates before disk serialization", (t) => {
  const contextUpdates = updates();
  const expected = structuredClone(contextUpdates);
  const saved = artifact([{ action: { a: "read_file", p: sourceIdentity.path }, contextUpdates }]);
  assert.deepEqual(saved.turns[0].contextUpdates, expected);
  assert.notEqual(saved.turns[0].contextUpdates, contextUpdates);
  assert.notEqual(saved.turns[0].contextUpdates[0].paths[0], contextUpdates[0].paths[0]);
  contextUpdates[0].paths[0].sha256 = "mutated after artifact construction";
  contextUpdates[0].text = "different decision";
  contextUpdates.push({ schema: 1, id: "later" });
  assert.deepEqual(saved.turns[0].contextUpdates, expected);
  const dest = path.join(directory(t), "final.json");
  saveArtifact(dest, saved);
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")).turns[0].contextUpdates, expected);
});

test("context-update presence preserves empty arrays and explicit null without inventing legacy fields", () => {
  const inherited = Object.assign(Object.create({ contextUpdates: updates() }), { observation: "legacy" });
  const saved = artifact([{ contextUpdates: [] }, { contextUpdates: null }, {}, inherited, { contextUpdates: undefined }]);
  assert.deepEqual(saved.turns[0].contextUpdates, []);
  assert.equal(saved.turns[1].contextUpdates, null);
  assert.equal(Object.hasOwn(saved.turns[2], "contextUpdates"), false);
  assert.equal(Object.hasOwn(saved.turns[3], "contextUpdates"), false);
  assert.equal(Object.hasOwn(saved.turns[4], "contextUpdates"), true);
  assert.equal(saved.turns[4].contextUpdates, null);
});

test("autosaved context updates survive resumed checkpoints and final artifact save without aliasing", (t) => {
  const dir = directory(t);
  const dest = path.join(dir, "partial.json");
  const checkpoint = new RunCheckpoint({ dest, autosaveEvery: 1 });
  const event = { type: "observation", observation: "read the source", contextUpdates: updates() };
  const expected = structuredClone(event.contextUpdates);
  checkpoint.note({ type: "action", action: { a: "read_file", p: sourceIdentity.path } });
  checkpoint.note(event);
  event.contextUpdates[0].paths[0].bytes = 0;
  assert.deepEqual(checkpoint.turns()[0].contextUpdates, expected);
  const saved = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.deepEqual(saved.turns[0].contextUpdates, expected);
  const resumed = new RunCheckpoint({ dest, autosaveEvery: 1, initialEvidence: saved });
  saved.turns[0].contextUpdates[1].paths[0].sha256 = "mutated after resume";
  resumed.note({ type: "action", action: { a: "done", summary: "No additional work." } });
  resumed.note({ type: "observation", observation: "done", contextUpdates: [] });
  const roundTrip = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.deepEqual(roundTrip.turns[0].contextUpdates, expected);
  assert.deepEqual(roundTrip.turns[1].contextUpdates, []);
  const finalPath = path.join(dir, "final.json");
  saveArtifact(finalPath, artifact(roundTrip.turns));
  assert.deepEqual(JSON.parse(fs.readFileSync(finalPath, "utf8")).turns.map((turn) => turn.contextUpdates), [expected, []]);
});

test("context updates annotated after a turn is sealed reach checkpoint flushes as independent copies", (t) => {
  const dest = path.join(directory(t), "partial.json");
  const checkpoint = new RunCheckpoint({ dest, autosaveEvery: 0 });
  checkpoint.note({ type: "action", action: { a: "read_file", p: sourceIdentity.path } });
  checkpoint.note({ type: "observation", observation: "original observation" });
  const event = { type: "observation_annotated", turn: 0, observation: "annotated observation", contextUpdates: updates() };
  const expected = structuredClone(event.contextUpdates);
  checkpoint.note(event);
  event.contextUpdates[0].paths[0].sha256 = "mutated after annotation";
  assert.deepEqual(checkpoint.turns()[0].contextUpdates, expected);
  checkpoint.note({ type: "observation_annotated", turn: 0, observation: "later annotation without updates" });
  assert.equal(checkpoint.flush("test"), true);
  const saved = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(saved.turns[0].observation, "later annotation without updates");
  assert.deepEqual(saved.turns[0].contextUpdates, expected);
  for (const contextUpdates of [[], null, undefined]) {
    checkpoint.note({ type: "observation_annotated", turn: 0, contextUpdates });
    assert.equal(checkpoint.flush("test"), true);
    const turn = JSON.parse(fs.readFileSync(dest, "utf8")).turns[0];
    assert.equal(Object.hasOwn(turn, "contextUpdates"), true);
    assert.deepEqual(turn.contextUpdates, contextUpdates ?? null);
  }
});

test("metrics retain nested prepared-prompt context update receipts without claiming server delivery", (t) => {
  const metrics = { contextUpdatePromptReceipts: [{
    schema: 1, boundary: "prepared-prompt", generation: 2,
    updateIds: ["decision-2", "edit-recovery-2"],
    paths: [{ ...sourceIdentity }],
  }] };
  const expected = structuredClone(metrics.contextUpdatePromptReceipts);
  const saved = artifact([], metrics);
  metrics.contextUpdatePromptReceipts[0].updateIds.push("later");
  metrics.contextUpdatePromptReceipts[0].paths[0].bytes = 0;
  assert.deepEqual(saved.metrics.contextUpdatePromptReceipts, expected);
  const dest = path.join(directory(t), "final.json");
  saveArtifact(dest, saved);
  const roundTrip = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.deepEqual(roundTrip.metrics.contextUpdatePromptReceipts, expected);
  assert.equal(roundTrip.metrics.contextUpdatePromptReceipts[0].boundary, "prepared-prompt");
  assert.equal(Object.hasOwn(roundTrip.metrics.contextUpdatePromptReceipts[0], "serverAccepted"), false);
});

test("real agent resume delivers saved typed source, preserves its input artifact, and extends the prompt prefix", async (t) => {
  const workspace = directory(t);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, sourceIdentity.path), source);
  fs.writeFileSync(path.join(workspace, "README.md"), "Inspect the delimiter without editing files.\n");
  const update = createContextUpdate(workspace, { kind: "decision", paths: [sourceIdentity.path], generation: 0 });
  assert.ok(update, "capture real on-disk source using the production producer");
  const block = contextUpdatePromptText(update);
  assert.ok(block.includes(source.trimEnd()), "the exact source bytes survive formatting");
  const initialArtifact = JSON.parse(JSON.stringify(artifact([{
    i: 0, action: { a: "read_file", p: sourceIdentity.path }, observation: source,
    contextUpdates: [update],
  }])));
  const originalArtifactBytes = JSON.stringify(initialArtifact);
  const checkpointPath = path.join(workspace, "partial.json");
  const checkpoint = new RunCheckpoint({ dest: checkpointPath, autosaveEvery: 1, initialEvidence: initialArtifact });
  const actions = [
    { a: "read_file", p: "README.md" },
    { a: "respond", text: "The saved delimiter source was inspected; no files were edited." },
  ];
  const prompts = [];
  const model = {
    assistantPrefill: "", actTemperature: null,
    requestCursor: () => prompts.length,
    async complete(prompt) {
      assert.ok(actions.length, "scripted model must not receive an unexpected request");
      prompts.push(String(prompt));
      return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
  const result = await runAgent({
    workspace, task: "Inspect README.md and report the delimiter source already captured. Do not edit files.",
    model, resumeTurns: initialArtifact.turns, maxTurns: 3,
    interactive: true, useGrammar: false, grounding: false, promptTrajectory: "extension",
    completionAudit: false, stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
    verificationPolicy: "after_edit", onEvent: (event) => checkpoint.note(event),
  });
  assert.equal(result.responded, true);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.ok(prompt.includes(block), "the complete typed update reaches the actual model callback");
  assert.ok(prompts[1].startsWith(prompts[0]), "the subsequent outgoing prompt retains the complete previous prefix");
  assert.equal(JSON.stringify(initialArtifact), originalArtifactBytes, "resume must not mutate its source artifact");
  assert.deepEqual(result.turns[0].contextUpdates, [update]);
  assert.notEqual(result.turns[0].contextUpdates, initialArtifact.turns[0].contextUpdates);
  assert.notEqual(result.turns[0].contextUpdates[0].paths[0], initialArtifact.turns[0].contextUpdates[0].paths[0]);
  assert.deepEqual(checkpoint.turns()[0].contextUpdates, [update]);
  assert.equal(checkpoint.flush("test"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(checkpointPath, "utf8")).turns[0].contextUpdates, [update]);
  const finalPath = path.join(workspace, "final.json");
  saveArtifact(finalPath, artifact(result.turns, result.metrics));
  const finalArtifact = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  assert.deepEqual(finalArtifact.turns[0].contextUpdates, [update]);
  assert.deepEqual(finalArtifact.metrics.contextUpdatePromptReceipts, [{
    id: update.id, kind: update.kind, generation: 0, status: "included", boundary: "prepared-prompt",
    chars: block.length, promptSha256: crypto.createHash("sha256").update(prompts[0]).digest("hex"), modelCallIndex: 0,
  }]);
  result.turns[0].contextUpdates[0].paths[0].readBytes = 0;
  assert.equal(JSON.stringify(initialArtifact), originalArtifactBytes, "nested resumed metadata is independently owned");
  assert.equal(fs.readFileSync(path.join(workspace, sourceIdentity.path), "utf8"), source);
});

test("malformed restored context-update paths neither crash resume nor gain privileged prompt rendering", async (t) => {
  for (const kind of ["edit-recovery", "decision"]) {
    const invalid = { schema: 1, id: `${kind}:0:invalid`, kind, generation: 0,
      text: "MALFORMED_RESTORED_CONTEXT_SENTINEL", paths: "bad" };
    const prompts = [];
    const result = await runAgent({
      workspace: directory(t), task: "Report status without editing any files.",
      model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
        prompts.push(String(prompt));
        return { content: JSON.stringify({ a: "respond", text: "Status reported." }), tokens: 1, stoppedEos: true, timings: {} };
      } },
      resumeTurns: [{ i: 0, parsedAction: { a: "read_file", p: "missing.txt" },
        observation: "No file was read.", contextUpdates: [invalid] }],
      maxTurns: 2, interactive: true, useGrammar: false, grounding: false, promptTrajectory: "extension",
      completionAudit: false, stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
      verificationPolicy: "after_edit",
    });
    assert.equal(result.responded, true, kind);
    assert.equal(prompts.length, 1, kind);
    assert.ok(!prompts[0].includes("MALFORMED_RESTORED_CONTEXT_SENTINEL"), kind);
    assert.ok(!prompts[0].includes("<bantam-context-update"), kind);
    assert.deepEqual(result.metrics.contextUpdatePromptReceipts, [], kind);
  }
});

test("invalid historical decisions cannot suppress or poison a fresh snapshot at the same generation", async (t) => {
  const workspace = directory(t);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, sourceIdentity.path), source);
  const prior = process.env.BANTAM_DECISION_SNAPSHOT;
  process.env.BANTAM_DECISION_SNAPSHOT = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.BANTAM_DECISION_SNAPSHOT;
    else process.env.BANTAM_DECISION_SNAPSHOT = prior;
  });
  const invalid = { schema: 1, id: "decision:1:invalid", kind: "decision", generation: 1,
    text: "INVALID_PRIOR_DECISION", paths: "bad" };
  for (const invalidLocation of ["earlier", "latest"]) {
    const prompts = [];
    const result = await runAgent({
      workspace, task: "Report the completed inspection without editing any files.",
      model: { assistantPrefill: "", actTemperature: null, async complete(prompt) {
        prompts.push(String(prompt));
        return { content: JSON.stringify({ a: "respond", text: "Inspection reported." }), tokens: 1, stoppedEos: true, timings: {} };
      } },
      resumeTurns: [
        { i: 0, parsedAction: { a: "write_file", p: sourceIdentity.path, content: source },
          observation: "source edited", editApplied: true,
          ...(invalidLocation === "earlier" ? { contextUpdates: [invalid] } : {}) },
        { i: 1, parsedAction: { a: "shell", c: "node --test" }, observation: "# pass 1\n# fail 0\n",
          verificationEvidence: { status: "pass", source: "shell", command: "node --test", generation: 1 },
          ...(invalidLocation === "latest" ? { contextUpdates: [invalid, { ...invalid, id: "decision:1:invalid-second" }] } : {}) },
      ],
      maxTurns: 3, interactive: true, useGrammar: false, grounding: false, promptTrajectory: "extension",
      completionAudit: false, stateAudit: "off", contractStateAudit: "off", shellSandbox: "host",
      verificationPolicy: "after_edit",
    });
    assert.equal(result.responded, true, invalidLocation);
    assert.equal(result.metrics.decisionSnapshots, 1, invalidLocation);
    const update = result.turns[1].contextUpdates?.[0];
    assert.equal(update?.kind, "decision", invalidLocation);
    assert.equal(update.generation, 1, invalidLocation);
    assert.equal(result.turns[1].contextUpdates.length, 1, "invalid records cannot occupy the new update budget");
    assert.ok(prompts[0].includes(contextUpdatePromptText(update)), invalidLocation);
    assert.ok(!prompts[0].includes("INVALID_PRIOR_DECISION"), invalidLocation);
    assert.equal(result.metrics.contextUpdatePromptReceipts.filter((receipt) => receipt.status === "included").length, 1, invalidLocation);
  }
});
