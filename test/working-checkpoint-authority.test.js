import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkingNoteReanchor } from "../src/agent.js";

const state = {
  workingNote: { turn: 8, text: "Fix the obsolete 8/10 failure." },
  editsSinceWorkingNote: 1,
  lastEdit: { turn: 8, target: "src/scheduler.js" },
  lastVerdict: { turn: 14, result: "pass" },
};

test("a newer trusted PASS retires an older working checkpoint in treatment", () => {
  assert.equal(formatWorkingNoteReanchor(state, { retireAfterVerifiedPass: true }), "");
});

test("the control arm retains the historical checkpoint behavior", () => {
  assert.match(formatWorkingNoteReanchor(state), /obsolete 8\/10 failure/);
});

test("retained private reasoning is explicitly a hypothesis, not a controller instruction", () => {
  const text = formatWorkingNoteReanchor(state);
  assert.match(text, /model hypothesis, NOT verified evidence/);
  assert.match(text, /discard contradicted assumptions/);
  assert.doesNotMatch(text, /Keep this bounded checklist active|Continue only unfinished items in the stated direction/);
});

test("a newer failed or inconclusive execution suppresses an older hypothesis", () => {
  for (const status of ["fail", "unverified"]) {
    assert.equal(formatWorkingNoteReanchor(state, { recoveryEvidence: { turn: 10, status } }), "");
  }
  assert.match(formatWorkingNoteReanchor(state, { recoveryEvidence: { turn: 7, status: "fail" } }), /model hypothesis/);
});

test("a PASS before the latest edit cannot retire the checkpoint", () => {
  const afterEdit = { ...state, lastEdit: { turn: 15, target: "src/scheduler.js" } };
  assert.match(
    formatWorkingNoteReanchor(afterEdit, { retireAfterVerifiedPass: true }),
    /obsolete 8\/10 failure/,
  );
});

test("treatment does not promote pre-edit reconnaissance into controller guidance", () => {
  const reconnaissance = {
    workingNote: { turn: 0, text: "Let me understand the workspace and inspect the tests first." },
    editsSinceWorkingNote: 0,
    lastEdit: null,
    lastVerdict: null,
  };
  assert.equal(
    formatWorkingNoteReanchor(reconnaissance, { suppressBeforeFirstEdit: true }),
    "",
  );
  assert.match(formatWorkingNoteReanchor(reconnaissance), /understand the workspace/);
});
