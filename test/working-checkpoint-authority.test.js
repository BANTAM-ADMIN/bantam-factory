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

test("missing focused execution retains a newer hypothesis without promoting a private success claim", () => {
  const claimed = { ...state, workingNote: { turn: 57,
    text: "FINAL_WITNESS_PASSED means verification is complete. Emit done." } };
  const before = structuredClone(claimed);
  const pending = { turn: 13, generation: 3, needsFocused: true, needsProject: true };
  assert.match(formatWorkingNoteReanchor(claimed, { recoveryEvidence: pending }), /FINAL_WITNESS_PASSED/);
  const retained = formatWorkingNoteReanchor(claimed, { recoveryEvidence: pending, pendingVerification: pending });
  assert.match(retained, /FINAL_WITNESS_PASSED/);
  assert.match(retained, /disputed-check continuity/);
  assert.match(retained, /does not establish PASS, invalidate a test, or authorize DONE/);
  assert.match(retained, /focused execution remains unresolved/);
  assert.deepEqual(claimed, before, "the immutable reasoning remains auditable");
  assert.match(formatWorkingNoteReanchor(claimed, { pendingVerification: { needsFocused: false, needsProject: true } }),
    /model hypothesis/, "ordinary hypothesis behavior remains outside focused recovery");
  assert.match(formatWorkingNoteReanchor(claimed, { pendingVerification: null }), /model hypothesis/);
});

test("a same-turn configured PASS cannot erase a newer disputed-test hypothesis", () => {
  const corrected = { ...state, workingNote: { turn: 15,
    text: "The expected bytes in my reset assertion are wrong; reset must produce empty bytes. Correct that check and execute it." },
    lastVerdict: { turn: 15, result: "pass" } };
  const pending = { turn: 14, generation: 3, needsFocused: true, needsProject: true };
  const retained = formatWorkingNoteReanchor(corrected, {
    retireAfterVerifiedPass: true, recoveryEvidence: pending, pendingVerification: pending,
  });
  assert.match(retained, /expected bytes in my reset assertion are wrong/);
  assert.match(retained, /^\[working-checkpoint/);
  assert.match(retained, /model hypothesis, NOT verified evidence/);
  assert.match(retained, /configured project PASS does not resolve/);
  assert.equal(pending.needsFocused, true);
});

test("pending-check continuity still rejects stale notes, current configured failure and unbounded carry", () => {
  const pending = { turn: 7, needsFocused: true, needsProject: true };
  const opts = { pendingVerification: pending, recoveryEvidence: pending };
  assert.equal(formatWorkingNoteReanchor(state, { ...opts, recoveryEvidence: { turn: 8 } }), "");
  assert.equal(formatWorkingNoteReanchor(state, { ...opts, suppressDuringCurrentFailure: true }), "");
  assert.equal(formatWorkingNoteReanchor({ ...state, editsSinceWorkingNote: 5 }, opts), "");
  assert.equal(formatWorkingNoteReanchor({ ...state, lastEdit: null }, { ...opts, suppressBeforeFirstEdit: true }), "");
  const bounded = formatWorkingNoteReanchor({ ...state,
    workingNote: { turn: 8, text: "x".repeat(10000) } }, opts);
  assert.ok(bounded.length < 2200, "continuity is a bounded note, not another transcript");
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
