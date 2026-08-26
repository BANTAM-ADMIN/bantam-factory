import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineCandidatePressTask, runCandidatePress } from "../src/factory.js";

const task = () => ({
  schema: 1,
  kind: "bantam.factory-candidate-press-task",
  id: "boundary-case-press",
  version: 1,
  title: "Boundary case press",
  purpose: "Generate bounded candidates for an independent executable oracle.",
  candidateDie: {
    schema: 1,
    kind: "bantam.factory-candidate-die",
    fields: [
      { name: "value", type: "string", required: true, minLength: 1, maxLength: 40 },
      { name: "class", type: "string", required: true, enum: ["ordinary", "edge"] },
    ],
    additionalProperties: false,
  },
  limits: { maxCandidates: 4 },
  release: { minAccepted: 1, minUniqueAccepted: 1 },
});

describe("candidate foundry", () => {
  it("content-addresses a strict candidate task", () => {
    const defined = defineCandidatePressTask(task());
    assert.match(defined.ref, /^candidate-press-task:boundary-case-press@1:sha256:/);
    assert.equal(Object.isFrozen(defined.candidateDie.fields), true);
    assert.throws(() => defineCandidatePressTask({ ...task(), ambientTool: "shell" }), /unknown=\[ambientTool\]/);
    assert.throws(() => defineCandidatePressTask({ ...defined, purpose: "changed" }), /content hash/);
  });

  it("separates schema admission, uniqueness, and independent usefulness", async () => {
    const article = await runCandidatePress({
      task: task(),
      produce: async () => ({
        answer: { candidates: [
          { value: "ordinary", class: "ordinary" },
          { value: "ordinary", class: "ordinary" },
          { value: "edge-case", class: "edge" },
          { value: "bad", class: "unknown" },
          { value: "overflow", class: "edge" },
        ] },
        telemetry: { elapsedMs: 100, promptTokens: 20, completionTokens: 50 },
      }),
      gauge: async (candidate) => candidate.class === "edge"
        ? { accepted: true, reasons: [], proof: { oracle: "edge-class" } }
        : { accepted: false, reasons: ["oracle:not-edge"], proof: { oracle: "edge-class" } },
    });
    assert.equal(article.disposition, "released");
    assert.deepEqual(article.summary, {
      emitted: 5,
      inspected: 4,
      overflow: 1,
      schemaAdmitted: 3,
      unique: 2,
      accepted: 1,
      rejected: 4,
      acceptanceRate: 0.25,
      uniqueAcceptanceRate: 0.5,
    });
    assert.equal(article.inspections[1].reasons[0], "duplicate-candidate");
    assert.equal(article.inspections[3].reasons[0], "die:enum:class");
    assert.equal(article.telemetry.completionTokensPerSecond, 500);
    assert.match(article.articleId, /^candidate-press-article:sha256:/);
  });

  it("contains an article that does not meet its useful-product threshold", async () => {
    const article = await runCandidatePress({
      task: task(),
      produce: async () => ({ answer: { candidates: [{ value: "ordinary", class: "ordinary" }] }, telemetry: {} }),
      gauge: () => ({ accepted: false, reasons: ["oracle:not-useful"], proof: null }),
    });
    assert.equal(article.disposition, "contained");
    assert.equal(article.summary.accepted, 0);
  });

  it("refuses a self-certifying or malformed gauge", async () => {
    await assert.rejects(() => runCandidatePress({
      task: task(),
      produce: async () => ({ answer: { candidates: [{ value: "edge", class: "edge" }] }, telemetry: {} }),
      gauge: () => ({ accepted: true, reasons: ["model-says-good"], proof: null }),
    }), /accepted candidate cannot carry rejection reasons/);
  });
});
