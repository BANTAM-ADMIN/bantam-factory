import assert from "node:assert/strict";
import { it } from "node:test";
import { renderCodexExocortexCohort, renderCodexMutationCohort } from "../src/factory.js";

// D3 negative controls. Each board renders a cohort whose numbers differ from
// the retained flagship cohorts; every headline figure must follow the data.
// A board that still shows the flagship's numbers is decoration, not evidence.

function mutationReport() {
  const stats = (released, articles) => ({ articles, released, yield: released / articles, durationMs: { mean: 10 }, commands: { mean: 1 }, inputTokens: { mean: 2 }, cachedInputTokens: { mean: 1 }, uncachedInputTokens: { mean: 1 }, outputTokens: { mean: 1 } });
  const arm = (name, repetition, disposition) => ({ arm: name, repetition, run: { durationMs: 10, commands: [], usage: { input_tokens: 2 } }, audit: { disposition, changed: ["src/core.js"], publicVerification: { pass: disposition === "released" }, hiddenVerification: { pass: disposition === "released" } }, cognitiveProduct: { disposition: "admitted-for-actuation", bytes: 20 }, actuation: { status: "pass" } });
  return {
    schema: "bantam.factory.codex-exocortex-mutation-cohort.v1",
    reportId: "report:negative-control",
    aggregate: { control: stats(1, 2), exocortex: stats(1, 2) },
    comparison: { meanDurationRatio: 0.5, meanCommandRatio: 0.25, meanInputTokenRatio: 0.75, meanUncachedInputTokenRatio: 0.6, meanOutputTokenRatio: 0.8 },
    inputs: {},
    arms: [arm("control", 1, "released"), arm("control", 2, "contained"), arm("exocortex", 1, "released"), arm("exocortex", 2, "contained")],
  };
}

function exocortexReport() {
  const arm = (name, repetition, exact) => ({ arm: name, repetition, score: { exact }, run: { durationMs: 100, commands: [], usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } } });
  return {
    schema: "bantam.factory.codex-repository-exocortex-cohort.v1",
    reportId: "report:negative-control",
    arms: [arm("control", 1, true), arm("control", 2, false), arm("exocortex", 1, true), arm("exocortex", 2, false)],
  };
}

it("mutation board headline follows the cohort, not the flagship", () => {
  const html = renderCodexMutationCohort(mutationReport());
  assert.doesNotMatch(html, /4 \/ 4 RELEASED/, "flagship stamp survived a 2/4 cohort");
  assert.match(html, /2 \/ 4 RELEASED/, "stamp must state this cohort's released/articles");
});

it("mutation board observed panel is computed from the comparison, not quoted from V8", () => {
  const html = renderCodexMutationCohort(mutationReport());
  for (const flagship of ["36.6%", "16.7%", "28.7%", "55.0%", "37.4%"]) {
    assert.ok(!html.includes(flagship), `V8 figure ${flagship} survived a different cohort`);
  }
  assert.match(html, /50\.0% wall time/);
  assert.match(html, /25\.0% commands/);
  assert.match(html, /75\.0% total input/);
});

it("mutation board chrome carries no fixture-specific claims", () => {
  const html = renderCodexMutationCohort(mutationReport());
  assert.ok(!html.includes("28 exhaustive semantic products"), "V8 fixture claim in station chrome");
  assert.ok(!html.includes("3.4 KB"), "V8 kit size in station chrome");
  assert.ok(!html.includes("7/7 public tests"), "V8 test count in station chrome");
  assert.ok(!html.includes("two articles per arm"), "hard-coded arm size in boundary text");
  assert.match(html, /2 articles per arm/);
});

it("exocortex board quality badge follows the cohort, not the flagship", () => {
  const html = renderCodexExocortexCohort(exocortexReport());
  assert.doesNotMatch(html, /4 \/ 4 EXACT/, "flagship badge survived a 2/4 cohort");
  assert.match(html, /2 \/ 4 EXACT/, "badge must state this cohort's exact/articles");
});

it("exocortex board chrome carries no fixture- or model-specific claims", () => {
  const html = renderCodexExocortexCohort(exocortexReport());
  assert.ok(!html.includes("80-module"), "v2 fixture description in boundary chrome");
  assert.ok(!html.includes("Terra"), "provider model name in header chrome");
});

it("boards still render the flagship cohorts faithfully (positive control)", () => {
  const stats = (released, articles) => ({ articles, released, yield: released / articles, durationMs: { mean: 10 }, commands: { mean: 1 }, inputTokens: { mean: 2 }, cachedInputTokens: { mean: 1 }, uncachedInputTokens: { mean: 1 }, outputTokens: { mean: 1 } });
  const arm = (name, repetition) => ({ arm: name, repetition, run: { durationMs: 10, commands: [], usage: { input_tokens: 2 } }, audit: { disposition: "released", changed: ["src/core.js"], publicVerification: { pass: true }, hiddenVerification: { pass: true } }, cognitiveProduct: { disposition: "admitted-for-actuation", bytes: 20 }, actuation: { status: "pass" } });
  const html = renderCodexMutationCohort({
    schema: "bantam.factory.codex-exocortex-mutation-cohort.v1",
    reportId: "report:positive-control",
    aggregate: { control: stats(2, 2), exocortex: stats(2, 2) },
    comparison: { meanDurationRatio: 0.366, meanCommandRatio: 0.167, meanInputTokenRatio: 0.287, meanUncachedInputTokenRatio: 0.55, meanOutputTokenRatio: 0.374 },
    inputs: {},
    arms: [arm("control", 1), arm("control", 2), arm("exocortex", 1), arm("exocortex", 2)],
  });
  assert.match(html, /4 \/ 4 RELEASED/);
  assert.match(html, /36\.6% wall time/);
});
