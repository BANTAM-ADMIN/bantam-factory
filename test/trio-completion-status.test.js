import assert from "node:assert/strict";
import test from "node:test";

import { implementationArmOutcome } from "../src/trio-session.js";

// Measured 2026-08-15 (ticket A trio, then every parity run): an arm that hit
// its turn cap without ever declaring done was displayed identically to one
// that finished — because implementation-mode pass read only
// `verification.status`. The local arm was reported "pass" with the ticket's
// CLI wiring never written; the verifier happened to be green because it ran
// the test file the arm had just created. reachedDone is in the artifact; the
// summary must not discard it.

test("verification green but never done is incomplete, not pass", () => {
  const outcome = implementationArmOutcome({
    verification: { status: "pass" },
    reachedDone: false,
  });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.status, "incomplete");
});

test("verification green and done is a pass", () => {
  const outcome = implementationArmOutcome({
    verification: { status: "pass" },
    reachedDone: true,
  });
  assert.equal(outcome.pass, true);
  assert.equal(outcome.status, "pass");
});

test("a failed verifier stays failed regardless of done", () => {
  assert.equal(implementationArmOutcome({ verification: { status: "fail" }, reachedDone: true }).pass, false);
  assert.equal(implementationArmOutcome({ verification: { status: "fail" }, reachedDone: false }).pass, false);
});

test("no verifier configured: done is unverified, not-done is incomplete", () => {
  assert.equal(implementationArmOutcome({ verification: null, reachedDone: true }).status, "unverified");
  assert.equal(implementationArmOutcome({ verification: null, reachedDone: false }).status, "incomplete");
});
