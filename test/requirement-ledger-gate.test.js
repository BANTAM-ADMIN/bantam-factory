// requirement_ledger done-gate: a one-shot grounding directive. On the first
// otherwise-acceptable done it demands a requirement ledger (requirement, expected
// value, SOURCE of that value, check result); bounded by maxRejections so it can
// never trap the run — the termination path is "already rejected enough → allow".

import assert from "node:assert/strict";
import test from "node:test";

import { requirementLedgerObjection } from "../src/done-guard.js";

test("requirement_ledger fires on the first done with a ledger directive", () => {
  const obj = requirementLedgerObjection([], 0);
  assert.equal(typeof obj, "string");
  assert.ok(obj.length > 0, "expected a non-null objection message");
  assert.match(obj, /REQUIREMENT LEDGER/);
  assert.match(obj, /SOURCE/);
});

test("requirement_ledger stays silent once the rejection bound is reached", () => {
  assert.equal(requirementLedgerObjection([], 1), null);
});

test("requirement_ledger stays silent when maxRejections is not positive", () => {
  assert.equal(requirementLedgerObjection([], 0, { maxRejections: 0 }), null);
  assert.equal(requirementLedgerObjection([], 0, { maxRejections: -1 }), null);
});
