import assert from "node:assert/strict";
import test from "node:test";

import { summarizeGateEngagement, GATE_ENGAGEMENT_METRIC } from "../src/logic/gate-engagement.js";

// Measured 2026-07-30 across 516 recorded artifacts: 10 of 15 done-gates never
// fired, six of them default-on. Only ONE gate (verify_red) records how often it
// was EVALUATED, so for the other fourteen "never fired" is ambiguous between
// "correctly silent" and "structurally unreachable" -- which is exactly how the
// anti-spiral gate stayed inert through a recorded 26-turn spiral.
//
// A gate that is never evaluated is not a gate. This makes that measurable.

test("names an evaluation counter for every gate", () => {
  assert.equal(GATE_ENGAGEMENT_METRIC.verify_red, "verifyRedGateEvaluations");
  assert.equal(GATE_ENGAGEMENT_METRIC.type_contract, "typeContractGateEvaluations");
  assert.ok(Object.keys(GATE_ENGAGEMENT_METRIC).length >= 7);
});

test("classifies a gate that was evaluated and stayed silent as correctly silent", () => {
  const s = summarizeGateEngagement([
    { verifyRedGateEvaluations: 3, verifyRedDoneRejections: 0 },
    { verifyRedGateEvaluations: 2, verifyRedDoneRejections: 0 },
  ]);
  assert.equal(s.verify_red.evaluated, 5);
  assert.equal(s.verify_red.fired, 0);
  assert.equal(s.verify_red.verdict, "correctly-silent");
});

test("flags a gate that was never evaluated as unreachable", () => {
  const s = summarizeGateEngagement([
    { typeContractGateEvaluations: 0, typeContractRejections: 0 },
    { typeContractGateEvaluations: 0, typeContractRejections: 0 },
  ]);
  assert.equal(s.type_contract.verdict, "never-evaluated");
});

test("reports a gate that fires as active, with its hit rate", () => {
  const s = summarizeGateEngagement([
    { typeContractGateEvaluations: 4, typeContractRejections: 1 },
    { typeContractGateEvaluations: 4, typeContractRejections: 3 },
  ]);
  assert.equal(s.type_contract.evaluated, 8);
  assert.equal(s.type_contract.fired, 4);
  assert.equal(s.type_contract.verdict, "active");
  assert.equal(s.type_contract.hitRate, 0.5);
});

// Historical artifacts predate the evaluation counters, so the metric is ABSENT
// rather than zero. Absent must not read as "never evaluated" or the report
// screams about every run recorded before the instrumentation existed -- which is
// what it did on first use against 516 real artifacts.
test("distinguishes an absent counter from an instrumented zero", () => {
  const legacy = summarizeGateEngagement([{ typeContractRejections: 3 }]);
  assert.equal(legacy.type_contract.verdict, "not-instrumented");

  const modern = summarizeGateEngagement([{ typeContractGateEvaluations: 0, typeContractRejections: 0 }]);
  assert.equal(modern.type_contract.verdict, "never-evaluated");
});

test("a mix of legacy and instrumented runs counts only the instrumented ones", () => {
  const s = summarizeGateEngagement([
    { typeContractRejections: 5 },                                        // legacy, no counter
    { typeContractGateEvaluations: 4, typeContractRejections: 2 },        // instrumented
  ]);
  assert.equal(s.type_contract.evaluated, 4);
  assert.equal(s.type_contract.fired, 2);
  assert.equal(s.type_contract.verdict, "active");
});

// The dangerous case the audit exists to catch: rejections recorded while the
// evaluation counter says it never ran means the instrumentation itself is wrong,
// and any conclusion drawn from that gate's numbers is unsound.
test("flags inconsistent instrumentation rather than silently averaging it", () => {
  const s = summarizeGateEngagement([{ typeContractGateEvaluations: 0, typeContractRejections: 2 }]);
  assert.equal(s.type_contract.verdict, "inconsistent");
});

test("formats a report naming unreachable gates first", () => {
  const s = summarizeGateEngagement([
    { verifyRedGateEvaluations: 5, verifyRedDoneRejections: 0 },
    { typeContractGateEvaluations: 0, typeContractRejections: 0 },
  ]);
  const text = s.format();
  assert.match(text, /never-evaluated/);
  assert.match(text, /type_contract/);
  assert.ok(text.indexOf("type_contract") < text.indexOf("verify_red"),
    "unreachable gates must be reported before merely-silent ones");
});
