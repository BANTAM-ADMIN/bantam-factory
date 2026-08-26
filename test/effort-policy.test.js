import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { turnEffort, isSetback } from "../src/logic/effort-policy.js";

// Codex takes reasoning effort per TURN, and codex-transport guards model changes
// inside a run-scoped thread while deliberately not guarding effort -- so varying
// it reuses the thread and does not disturb delta prompting or its prefix reuse.
//
// The measured curve says the room is ABOVE the baseline, not below it: low is
// worse than medium on both turns and cache misses, so thinking less on easy turns
// buys nothing. Thinking harder on the few turns that actually decide the outcome
// is the lever.

describe("per-turn effort policy", () => {
  it("is inert until armed, so it cannot change behaviour by accident", () => {
    assert.equal(turnEffort({ base: "medium", consecutiveSetbacks: 3 }).effort, "medium");
  });

  it("stays at base while the run is going well", () => {
    const r = turnEffort({ base: "medium", consecutiveSetbacks: 0, enabled: true });
    assert.equal(r.effort, "medium");
    assert.equal(r.reason, "steady");
  });

  it("thinks harder after a setback", () => {
    assert.equal(turnEffort({ base: "medium", consecutiveSetbacks: 1, enabled: true }).effort, "high");
  });

  it("escalates further as setbacks accumulate", () => {
    assert.equal(turnEffort({ base: "medium", consecutiveSetbacks: 2, enabled: true }).effort, "xhigh");
  });

  // A policy that ratchets up and never comes down is an expensive default
  // wearing a disguise.
  it("returns to base as soon as the run recovers", () => {
    assert.equal(turnEffort({ base: "medium", consecutiveSetbacks: 0, enabled: true }).effort, "medium");
  });

  it("respects the escalation ceiling", () => {
    const r = turnEffort({ base: "medium", consecutiveSetbacks: 9, enabled: true, maxSteps: 1 });
    assert.equal(r.effort, "high");
  });

  it("saturates at the top of the ladder rather than inventing a level", () => {
    const r = turnEffort({ base: "xhigh", consecutiveSetbacks: 5, enabled: true });
    assert.equal(r.effort, "xhigh");
    assert.equal(r.reason, "at-ceiling");
  });

  it("passes an unrecognised base through untouched", () => {
    assert.equal(turnEffort({ base: "ultra", consecutiveSetbacks: 2, enabled: true }).effort, "ultra");
  });
});

describe("what counts as a setback", () => {
  it("counts a failed verification, a refused done, an invalid action and a failed edit", () => {
    assert.equal(isSetback({ verificationFailed: true }), true);
    assert.equal(isSetback({ doneRejected: true }), true);
    assert.equal(isSetback({ invalidAction: true }), true);
    assert.equal(isSetback({ editFailed: true }), true);
  });

  it("does not count an ordinary turn", () => {
    assert.equal(isSetback({}), false);
    assert.equal(isSetback(), false);
  });
});
