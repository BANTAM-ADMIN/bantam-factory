import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCodexCohortRun, repositoryAssessmentGauge, scoreRepositoryAssessment } from "../src/factory.js";

const packet = {
  schema: "bantam.factory.repository-shift-packet.v1",
  summary: { releaseDisposition: "blocked" },
  products: [
    { predicate: "verification_work_order", tuple: { test: "test/a.test.js" } },
    { predicate: "requirement_affected", tuple: { requirement: "requirement:a" } },
    { predicate: "release_blocked_stale_evidence", tuple: { requirement: "requirement:a" } },
    { predicate: "release_blocked_stale_authority", tuple: { requirement: "requirement:a" } },
  ],
  buttons: [{ operation: "run-verification" }, { operation: "request-approval" }, { operation: "run-verification" }],
};

describe("Codex exocortex matched-cohort gauges", () => {
  it("builds and scores an order-independent exact repository assessment", () => {
    const expected = repositoryAssessmentGauge(packet);
    const answer = { ...expected, nextOperations: [...expected.nextOperations].reverse(), blockers: [...expected.blockers].reverse() };
    assert.equal(scoreRepositoryAssessment(answer, expected).exact, true);
    assert.equal(scoreRepositoryAssessment({ ...answer, releaseDisposition: "ready" }, expected).fieldScores.releaseDisposition, false);
    assert.equal(scoreRepositoryAssessment(null, expected).valid, false);
  });

  it("extracts answer, usage, commands, and item economics from Codex JSONL", () => {
    const answer = repositoryAssessmentGauge(packet);
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg core", status: "completed", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } }),
    ].join("\n");
    const parsed = parseCodexCohortRun(stdout);
    assert.deepEqual(parsed.answer, answer);
    assert.equal(parsed.commands.length, 1);
    assert.equal(parsed.itemTypes.command_execution, 1);
    assert.equal(parsed.usage.cached_input_tokens, 20);
    assert.match(parsed.traceId, /^codex-cohort-trace:sha256:/);
  });
});
