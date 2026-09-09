import assert from "node:assert/strict";
import test from "node:test";

import { compactActionReasoning, inspectionCheckpointDue, inspectionCheckpointText, shouldThink } from "../src/thinking.js";

test("action reasoning capsule retains the decision head and tail within its bound", () => {
  const reasoning = `PLAN:${"a".repeat(900)}\nDECISION:${"z".repeat(900)}`;
  const compact = compactActionReasoning(reasoning, 600);
  assert.ok(compact.length <= 600);
  assert.match(compact, /^PLAN:/);
  assert.match(compact, /DECISION:/);
  assert.match(compact, /decision capsule omitted/);
});

test("action reasoning remains byte-identical when disabled or already bounded", () => {
  assert.equal(compactActionReasoning("short decision", 600), "short decision");
  assert.equal(compactActionReasoning("short decision", 0), "short decision");
});

test("post-inspection synthesis is a task-agnostic auto-think boundary", () => {
  assert.equal(shouldThink("auto", {
    turnIndex: 4,
    lastObservation: "source read completed",
    lastWasInvalid: false,
    preEditSynthesis: true,
    lean: true,
  }), true);
  assert.equal(shouldThink("auto", {
    turnIndex: 4,
    lastObservation: "source read completed",
    lastWasInvalid: false,
    preEditSynthesis: false,
    lean: true,
  }), false);
});

test('runtime review and progress corrections trigger reconsideration on the auto rail', () => {
  for (const observation of [
    '[trusted-review-evidence]\nThe saved working note was clipped. Continue from the current files.',
    '[progress-awareness]\nRepeated reconnaissance has not advanced the deliverable.',
    '[implementation-response]\nThe claimed implementation is not verified; create and run the missing check.',
  ]) {
    assert.equal(shouldThink('auto', { turnIndex: 512, lastObservation: observation, lean: true }), true);
    assert.equal(shouldThink('off', { turnIndex: 512, lastObservation: observation }), false);
  }
  assert.equal(shouldThink('auto', { turnIndex: 512, lastObservation: 'Progress report: files listed.', lean: true }), false);
});

test('inspection checkpoint is opt-in and resets after thought, implementation or execution', () => {
  const reads = Array.from({ length: 12 }, (_, i) => ({ action: { a: 'read_file', p: 'DESIGN.md', start: i * 20 + 1 }, observation: 'requirements' }));
  assert.equal(inspectionCheckpointDue(reads), false);
  assert.equal(inspectionCheckpointDue(reads.slice(1), 12), false);
  assert.equal(inspectionCheckpointDue(reads, 12), true);
  for (const boundary of [
    { ...reads[0], reasoning: 'Implement the next milestone.' },
    { action: { a: 'write_file', p: 'app.js' } },
    { action: { a: 'shell', c: 'npm test' } },
    { ...reads[0], observation: '[repetition] read was not executed' },
  ]) assert.equal(inspectionCheckpointDue([...reads.slice(0, 6), boundary, ...reads.slice(7)], 12), false);
  assert.equal(shouldThink('auto', { turnIndex: 900, lean: true, inspectionCheckpoint: true }), true);
  assert.equal(shouldThink('off', { turnIndex: 900, inspectionCheckpoint: true }), false);
  assert.ok(inspectionCheckpointText(12).length < 700);
  assert.match(inspectionCheckpointText(12), /Respect mandatory prereads/);
});
