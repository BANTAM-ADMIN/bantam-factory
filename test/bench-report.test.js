import assert from "node:assert/strict";
import test from "node:test";

import {
  addBenchRun,
  emptyBenchTotals,
  formatBenchRow,
} from "../src/bench-report.js";

const ADDITIVE_FIELDS = [
  "invalid",
  "protocol",
  "turns",
  "durationMs",
  "preGateFails",
  "shellCwdGuards",
  "shellReadGuards",
  "testPipeGuards",
  "testDigestHits",
  "repeatedFailureHints",
  "outcomeCycleEvents",
  "outcomeCycleHints",
  "capabilityHints",
  "duplicateActionRejections",
  "repeatEscapeMasks",
  "doneRejections",
  "ledgerRejections",
  "secretAuditRejections",
  "queryBudgetBlocks",
  "progressNudges",
  "progressGateRejections",
  "progressGateTerminations",
  "artifactVerificationNudges",
  "artifactVerificationGateRejections",
  "artifactVerificationGateTerminations",
  "replaceFailures",
  "replaceOldNotFound",
  "replaceAmbiguous",
  "replaceLineStale",
  "replaceOther",
  "patchActions",
  "patchFailures",
  "deleteFileActions",
  "moveFileActions",
  "fileOperationFailures",
];

test("emptyBenchTotals returns a fresh complete zero-valued accumulator", () => {
  const first = emptyBenchTotals();
  const second = emptyBenchTotals();

  assert.notStrictEqual(first, second);
  assert.deepEqual(Object.keys(first), [
    "pass",
    ...ADDITIVE_FIELDS.slice(0, 25),
    "maxProgresslessTurns",
    ...ADDITIVE_FIELDS.slice(25),
  ]);
  for (const value of Object.values(first)) assert.equal(value, 0);

  first.pass = 3;
  assert.equal(second.pass, 0);
});

test("addBenchRun aggregates every sum and keeps the maximum progressless run", () => {
  const totals = emptyBenchTotals();
  const first = { pass: true, maxProgresslessTurns: 7 };
  const second = { pass: false, maxProgresslessTurns: 4 };
  ADDITIVE_FIELDS.forEach((field, index) => {
    first[field] = index + 1;
    second[field] = index + 2;
  });

  assert.strictEqual(addBenchRun(totals, first), totals);
  assert.strictEqual(addBenchRun(totals, second), totals);
  assert.equal(totals.pass, 1);
  assert.equal(totals.maxProgresslessTurns, 7);
  ADDITIVE_FIELDS.forEach((field, index) => {
    assert.equal(totals[field], (index + 1) + (index + 2), field);
  });
});

test("missing optional metrics contribute zero", () => {
  const totals = emptyBenchTotals();

  addBenchRun(totals, { pass: false });

  assert.deepEqual(totals, emptyBenchTotals());
});

test("invalid run metrics are rejected atomically", () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "2", {}, true]) {
    const totals = emptyBenchTotals();
    const before = structuredClone(totals);

    assert.throws(
      () => addBenchRun(totals, {
        pass: true,
        turns: 2,
        fileOperationFailures: invalid,
      }),
      /fileOperationFailures must be a non-negative safe integer/i,
    );
    assert.deepEqual(totals, before);
  }

  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
    const totals = emptyBenchTotals();
    assert.throws(
      () => addBenchRun(totals, { pass: true, durationMs: invalid }),
      /durationMs must be a finite non-negative number/i,
    );
    assert.deepEqual(totals, emptyBenchTotals());
  }
});

test("invalid pass values and malformed accumulators are rejected", () => {
  for (const pass of [undefined, null, 0, 1, "false"]) {
    const totals = emptyBenchTotals();
    assert.throws(
      () => addBenchRun(totals, { pass }),
      /run pass must be a boolean/i,
    );
    assert.deepEqual(totals, emptyBenchTotals());
  }

  for (const totals of [null, [], {}, { ...emptyBenchTotals(), turns: "0" }]) {
    assert.throws(
      () => addBenchRun(totals, { pass: false }),
      /totals must be an object|totals.*missing|totals turns/i,
    );
  }
});

test("overflow is rejected before any total is changed", () => {
  const countTotals = emptyBenchTotals();
  countTotals.turns = Number.MAX_SAFE_INTEGER;
  const countBefore = structuredClone(countTotals);
  assert.throws(
    () => addBenchRun(countTotals, { pass: false, turns: 1 }),
    /aggregated turns must be a non-negative safe integer/i,
  );
  assert.deepEqual(countTotals, countBefore);

  const durationTotals = emptyBenchTotals();
  durationTotals.durationMs = Number.MAX_VALUE;
  const durationBefore = structuredClone(durationTotals);
  assert.throws(
    () => addBenchRun(durationTotals, {
      pass: false,
      durationMs: Number.MAX_VALUE,
    }),
    /aggregated durationMs must be a finite non-negative number/i,
  );
  assert.deepEqual(durationTotals, durationBefore);
});

test("formatBenchRow renders every total and derives averages from repeat", () => {
  const totals = emptyBenchTotals();
  addBenchRun(totals, {
    pass: true,
    invalid: 1,
    protocol: 2,
    turns: 5,
    durationMs: 21,
    preGateFails: 3,
    shellCwdGuards: 4,
    shellReadGuards: 5,
    testPipeGuards: 6,
    testDigestHits: 7,
    repeatedFailureHints: 8,
    outcomeCycleEvents: 9,
    outcomeCycleHints: 10,
    capabilityHints: 11,
    duplicateActionRejections: 12,
    repeatEscapeMasks: 13,
    doneRejections: 14,
    ledgerRejections: 15,
    secretAuditRejections: 16,
    queryBudgetBlocks: 17,
    progressNudges: 18,
    progressGateRejections: 19,
    progressGateTerminations: 20,
    artifactVerificationNudges: 21,
    artifactVerificationGateRejections: 22,
    artifactVerificationGateTerminations: 23,
    maxProgresslessTurns: 24,
    replaceFailures: 25,
    replaceOldNotFound: 26,
    replaceAmbiguous: 27,
    replaceLineStale: 28,
    replaceOther: 29,
    patchActions: 30,
    patchFailures: 31,
    deleteFileActions: 32,
    moveFileActions: 33,
    fileOperationFailures: 34,
  });

  assert.equal(
    formatBenchRow("fixture", "grammar ON", totals, 2),
    "fixture                    grammar ON  pass 1/2"
      + "  invalidOutputs 1"
      + "  protocolViolations 2"
      + "  preGateFails 3"
      + "  replaceFailures 25"
      + " (26 old, 27 ambiguous, 28 stale-line, 29 other)"
      + "  patchActions 30"
      + "  patchFailures 31"
      + "  deleteFileActions 32"
      + "  moveFileActions 33"
      + "  fileOperationFailures 34"
      + "  shellCwdGuards 4"
      + "  shellReadGuards 5"
      + "  testPipeGuards 6"
      + "  testDigestHits 7"
      + "  repeatedFailureHints 8"
      + "  outcomeCycleEvents 9"
      + "  outcomeCycleHints 10"
      + "  capabilityHints 11"
      + "  duplicateActionRejections 12"
      + "  repeatEscapeMasks 13"
      + "  doneRejections 14"
      + "  ledgerRejections 15"
      + "  secretAuditRejections 16"
      + "  queryBudgetBlocks 17"
      + "  progressNudges 18"
      + "  progressGateRejections 19"
      + "  progressGateTerminations 20"
      + "  artifactVerificationNudges 21"
      + "  artifactVerificationGateRejections 22"
      + "  artifactVerificationGateTerminations 23"
      + "  maxProgresslessTurns 24"
      + "  avgTurns 2.5"
      + "  avgMs 11",
  );
});

test("formatBenchRow supports an empty run set and rejects invalid report inputs", () => {
  const totals = emptyBenchTotals();
  assert.match(formatBenchRow("fixture", "mode", totals, 0), /pass 0\/0.*avgTurns 0\.0  avgMs 0$/);

  for (const repeat of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    assert.throws(
      () => formatBenchRow("fixture", "mode", totals, repeat),
      /repeat must be a non-negative safe integer/i,
    );
  }
  assert.throws(
    () => formatBenchRow(null, "mode", totals, 0),
    /benchmark name must be a string/i,
  );
  assert.throws(
    () => formatBenchRow("fixture", null, totals, 0),
    /benchmark label must be a string/i,
  );
  assert.throws(
    () => formatBenchRow("fixture", "mode", { ...totals, invalid: -1 }, 0),
    /totals invalid must be a non-negative safe integer/i,
  );
  assert.throws(
    () => formatBenchRow("fixture", "mode", { ...totals, pass: 1 }, 0),
    /cannot exceed repeat/i,
  );
});
