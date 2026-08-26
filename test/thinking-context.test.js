import assert from "node:assert/strict";
import test from "node:test";

import { compactActionReasoning, shouldThink } from "../src/thinking.js";

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
