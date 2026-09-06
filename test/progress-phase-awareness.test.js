import assert from "node:assert/strict";
import test from "node:test";
import { formatProgressNudge, shouldForceDraftEdit, progressGateFor } from "../src/progress-awareness.js";

test("hard progress refusal also respects the post-authoring phase", () => {
  const flags = { progresslessTurns: 8, threshold: 3, hasAuthoredWork: true };
  for (const action of [{ a: "read_file", p: "target.js" }, { a: "shell", c: "ls" }]) {
    const note = progressGateFor(action, flags);
    assert.match(note, /work has already been authored/);
    assert.match(note, /rejected edit proposal did not change the file/);
    assert.match(note, /direct executable check/);
    assert.doesNotMatch(note, /next action must create|rough deliverable/);
  }
  assert.match(progressGateFor({ a: "read_file", p: "target.js" }, { ...flags, hasAuthoredWork: false }), /next action must create/);
});

const stalled = {
  interactive: false, useGrammar: true, progressAwareness: true,
  autoForceEditAfter: 3, progresslessTurns: 3,
};

test("first-draft enforcement is limited to the pre-authoring phase", () => {
  assert.equal(shouldForceDraftEdit(stalled), true);
  assert.equal(shouldForceDraftEdit({ ...stalled, hasAuthoredWork: false }), true);
  assert.equal(shouldForceDraftEdit({ ...stalled, hasAuthoredWork: true }), false);
  assert.equal(shouldForceDraftEdit({ ...stalled, hasAuthoredWork: true, progresslessTurns: 100 }), false);
});

test("phase awareness does not loosen caller mode or source-provenance exclusions", () => {
  for (const override of [
    { interactive: true }, { useGrammar: false }, { progressAwareness: false },
    { autoForceEditAfter: 0 }, { progresslessTurns: 2 }, { sourceProvenanceRequired: true },
  ]) assert.equal(shouldForceDraftEdit({ ...stalled, ...override }), false);
});

test("post-authoring guidance requests current evidence rather than arbitrary new edits", () => {
  const note = formatProgressNudge(3, { hasAuthoredWork: true });
  assert.match(note, /Work has already been authored/);
  assert.match(note, /Do not restart implementation or make an unrelated edit/);
  assert.match(note, /direct executable witness/);
  assert.match(note, /expected exit\/stdout\/stderr/);
  assert.match(note, /new permitted file/);
  assert.doesNotMatch(note, /first implementation|rough deliverable|best current assumption/);
  assert.match(formatProgressNudge(3), /first implementation/);
});

test("source-provenance guidance stays authoritative after authored work", () => {
  const note = formatProgressNudge(3, {
    hasAuthoredWork: true,
    sourceProvenance: { outputs: ["result.txt"], sources: ["archive.bin"] },
  });
  assert.match(note, /exact transcription task/);
  assert.match(note, /do NOT write a rough draft/);
  assert.doesNotMatch(note, /Work has already been authored/);
});
