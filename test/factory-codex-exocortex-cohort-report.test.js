import assert from "node:assert/strict";
import { it } from "node:test";
import { renderCodexExocortexCohort } from "../src/factory.js";
it("renders matched Codex economics from exact report articles", () => {
  const report = { schema: "bantam.factory.codex-repository-exocortex-cohort.v1", reportId: "report:fixture", arms: [
    { arm: "control", repetition: 1, score: { exact: true }, run: { durationMs: 100, commands: [{ command: "rg" }], usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } } },
    { arm: "exocortex", repetition: 1, score: { exact: true }, run: { durationMs: 25, commands: [], usage: { input_tokens: 250, cached_input_tokens: 0, output_tokens: 25 } } },
  ] };
  const html = renderCodexExocortexCohort(report);
  assert.match(html, /COGNITIVE DIVIDEND BOARD/);
  assert.match(html, /CONTROL · RECONSTRUCT THE FACTORY/);
  assert.match(html, /EXOCORTEX · USE STORED COMPUTATION/);
  assert.match(html, /cached and uncached token economics/);
});
