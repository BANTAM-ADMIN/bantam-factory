import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { modelOptionsForGauntletArm } from "../src/gauntlet.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("both experiment launchers honor normalized arm runtimes", () => {
  for (const launcher of ["bantam.js", "bantambuild.js"]) {
    const source = fs.readFileSync(path.join(root, "bin", launcher), "utf8");
    const experimentBody = source.slice(
      source.indexOf("async function runExperimentCommand"),
      source.indexOf("function resolveExperimentFixtures"),
    );
    assert.match(
      experimentBody,
      /arm\.model\.runtime[\s\S]*modelOptionsForGauntletArm\(arm\.model/,
      `${launcher} must not route runtime-aware experiment arms through saved API defaults`,
    );
  }
});

test("Codex experiment arm options exclude ambient API transports", () => {
  assert.deepEqual(
    modelOptionsForGauntletArm(
      { runtime: "codex", name: "gpt-5.5", effort: "medium", timeoutMs: 600000 },
      {
        endpoint: "http://localhost:8085",
        apiUrl: "https://api.deepseek.com/v1",
        apiKey: "ambient-secret",
        profile: "generic",
      },
    ),
    {
      profile: "generic",
      timeoutMs: 600000,
      apiUrl: null,
      apiKey: null,
      deepseek: false,
      codex: true,
      model: "gpt-5.5",
      codexEffort: "medium",
    },
  );
});

test("experiment dry-run bypasses ambient model startup in both launchers", () => {
  const spec = path.join(root, "creative-suite", "lexical-contract-audit-experiment.json");
  for (const launcher of ["bantam.js", "bantambuild.js"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "bin", launcher), "experiment", spec, "--dry-run"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BANTAM_API_URL: "https://ambient.invalid/v1",
          BANTAM_API_KEY: "must-not-be-used",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /model:|grammar|ambient\.invalid/i);
    const output = JSON.parse(result.stdout);
    assert.equal(output.spec.name, "codex-lexical-contract-audit-ab");
    assert.equal(output.schedule.length, 4);
  }
});

test("both experiment launchers accept validated composed fixtures", () => {
  const spec = path.join(root, "creative-suite", "preview-review-proof-terra-sol.json");
  for (const launcher of ["bantam.js", "bantambuild.js"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "bin", launcher), "experiment", spec, "--dry-run"],
      { cwd: root, encoding: "utf8", env: { ...process.env, BANTAM_NO_FACTS: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.spec.fixtures[0], "creative-suite/fixtures/review-first-occlusion");
    assert.equal(output.schedule.length, 12);
  }
});

test("native experiment arms require explicit execution consent in both launchers", () => {
  const spec = path.join(root, "examples", "experiments", "model-league-smoke.json");
  for (const launcher of ["bantam.js", "bantambuild.js"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "bin", launcher), "experiment", spec],
      { cwd: root, encoding: "utf8", env: { ...process.env, BANTAM_NO_FACTS: "1" } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require --yes/);
    assert.doesNotMatch(result.stderr, /model is unreachable|delegate_started/);
  }
});
