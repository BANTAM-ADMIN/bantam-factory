import assert from "node:assert/strict";
import { it } from "node:test";
import { renderCodexMutationCohort } from "../src/factory.js";

it("renders mutation telemetry from the retained backend article", () => {
  const stats = { articles: 2, released: 2, yield: 1, durationMs: { mean: 10 }, commands: { mean: 1 }, inputTokens: { mean: 2 }, cachedInputTokens: { mean: 1 }, uncachedInputTokens: { mean: 1 }, outputTokens: { mean: 1 } };
  const arm = (name) => ({ arm: name, repetition: 1, run: { durationMs: 10, commands: [], usage: { input_tokens: 2 } }, audit: { disposition: "released", changed: ["src/core.js"], publicVerification: { pass: true }, hiddenVerification: { pass: true } }, cognitiveProduct: { disposition: "admitted-for-actuation", bytes: 20 }, actuation: { status: "pass" } });
  const report = { schema: "bantam.factory.codex-exocortex-mutation-cohort.v1", reportId: "report:test", aggregate: { control: stats, exocortex: stats }, comparison: { meanDurationRatio: 1, meanCommandRatio: 1, meanInputTokenRatio: 1, meanUncachedInputTokenRatio: 1, meanOutputTokenRatio: 1 }, inputs: {}, arms: [arm("control"), arm("exocortex")] };
  const html = renderCodexMutationCohort(report);
  assert.match(html, /Cognitive product/i);
  assert.match(html, /src\\u002fcore\.js|src\/core\.js/);
  assert.match(html, /admitted-for-actuation/);
  assert.doesNotMatch(html, />undefined</);
});
