import assert from "node:assert/strict";
import test from "node:test";

import { deriveEscalationDecision } from "../src/escalation-policy.js";

test("first semantic failure repairs context before spending a delegate", () => {
  const result = deriveEscalationDecision({ attempts: [{
    stage: "local", status: "contract-fail", publicStatus: "pass", contractStatus: "fail", turns: 8, turnLimit: 30,
  }] });
  assert.equal(result.action, "repair-context");
  assert.deepEqual(result.triggers, ["hidden-contract-failure"]);
  assert.equal(result.basedOnSelfReportedConfidence, false);
});

test("repeated identical failure requests a diagnostic teacher", () => {
  const attempt = {
    stage: "local", status: "contract-fail", publicStatus: "pass", contractStatus: "fail", turns: 8, turnLimit: 30,
  };
  const result = deriveEscalationDecision({ attempts: [attempt, attempt] });
  assert.equal(result.action, "diagnose-with-teacher");
  assert.ok(result.triggers.includes("repeated-failure"));
  assert.ok(result.facts.includes("escalation_trigger(current_task, repeated_failure)."));
});

test("failed local retry after a diagnostic delegates the task", () => {
  const result = deriveEscalationDecision({ attempts: [
    { stage: "local", status: "contract-fail", publicStatus: "pass", contractStatus: "fail" },
    { stage: "diagnostic", status: "contract-fail", publicStatus: "pass", contractStatus: "fail" },
    { stage: "local", status: "contract-fail", publicStatus: "pass", contractStatus: "fail" },
  ] });
  assert.equal(result.action, "delegate-task");
  assert.equal(result.tier, 3);
});

test("integrity and infrastructure failures do not masquerade as intelligence failures", () => {
  assert.equal(deriveEscalationDecision({ attempts: [{ status: "cheated", scopeViolations: 1 }] }).action, "human-review");
  assert.equal(deriveEscalationDecision({ attempts: [{ status: "quota-exhausted" }] }).action, "retry-infrastructure");
  assert.equal(deriveEscalationDecision({ attempts: [{ status: "native-sandbox-error" }] }).action, "retry-infrastructure");
});

test("verified pass terminates escalation", () => {
  assert.equal(deriveEscalationDecision({ attempts: [{ status: "pass" }] }).action, "complete");
});
