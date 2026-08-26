import assert from "node:assert/strict";
import test from "node:test";
import { buildGauntletShowcase } from "../src/gauntlet-showcase.js";

function manifest() {
  return {
    id: "gauntlet-test",
    completedAt: "2026-07-25T12:00:00.000Z",
    specSha256: "abc123",
    spec: {
      rounds: 1,
      passAtK: [1],
      fixtures: ["fixture-one"],
      arms: [
        { name: "local", model: { runtime: "local" } },
        { name: "sol", model: { runtime: "codex", name: "gpt-5.6-sol" } },
        { name: "terra", model: { runtime: "codex", name: "gpt-5.6-terra" } },
      ],
    },
    schedule: [
      entry("local", "pass", 3, 1_000, 100, 20, 0),
      entry("sol", "pass", 2, 2_000, 200, 30, 12),
      entry("terra", "pass", 1, 1_500, 150, 25, 8),
    ],
  };
}

function entry(arm, status, turns, durationMs, inputTok, outputTok, reasoningTok) {
  return {
    arm,
    round: 1,
    runs: [{
      name: "fixture-one",
      status,
      strictPass: status === "pass",
      turns,
      durationMs,
      requests: turns + 1,
      inputTok,
      outputTok,
      cacheHitTok: 0,
      cacheMissTok: inputTok,
      reasoningTok,
      costUsd: 0,
      invalidActions: 0,
      protocolViolations: 0,
      artifactPath: `runs/${arm}/fixture.json`,
    }],
  };
}

test("gauntlet showcase renders measured values and evidence links", () => {
  const html = buildGauntletShowcase(manifest(), { evidenceHref: "../../../../evidence" });
  assert.match(html, /3\/3 passed/);
  assert.match(html, /gpt-5\.6-sol|Sol/);
  assert.match(html, /fixture-one/);
  assert.match(html, /runs\/local\/fixture\.json/);
  assert.match(html, /\.\.\/\.\.\/\.\.\/\.\.\/evidence\/manifest\.json/);
  assert.match(html, /one illustrative round, not a universal ranking/);
});

test("gauntlet showcase escapes untrusted manifest text", () => {
  const value = manifest();
  value.id = `<script>alert("no")</script>`;
  value.spec.fixtures = [`<img src=x onerror=alert(1)>`];
  for (const entry of value.schedule) {
    entry.runs[0].name = value.spec.fixtures[0];
  }
  const html = buildGauntletShowcase(value);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test("gauntlet showcase supports N arms and reports failures honestly", () => {
  const value = manifest();
  value.spec.arms.push(
    { name: "luna", model: { runtime: "codex", name: "gpt-5.6-luna", effort: "medium" } },
    { name: "control", model: { runtime: "codex", name: "gpt-5.5", effort: "medium" } },
  );
  value.schedule.push(
    entry("luna", "pass", 1, 900, 90, 20, 3),
    entry("control", "fail", 1, 800, 80, 18, 1),
  );
  const html = buildGauntletShowcase(value);
  assert.match(html, /4\/5 passed/);
  assert.match(html, /5 reasoning engines/);
  assert.match(html, /control result/);
  assert.match(html, /A faster failing arm never outranks a passing arm/);
  assert.doesNotMatch(html, /All models solved every hidden contract/);
});
