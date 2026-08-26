import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReplayExperimentPreflight,
  formatReplayExperimentPreflight,
} from "../src/replay-experiment-preflight.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(root, { samples = 3 } = {}) {
  const artifact = {
    kind: "bantam-run",
    runId: "preflight-source",
    model: {
      metadata: {
        runtime: "codex",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
    },
    turns: [{
      i: 0,
      modelCallIndex: 7,
      parsedAction: { a: "shell", c: "npm test" },
      observation: "",
    }],
    modelCalls: [{
      index: 7,
      request: {
        url: "codex-app-server://local/gpt-5.6-terra",
        body: JSON.stringify({ prompt: "recorded prompt", seed: 42 }),
      },
      response: {
        normalized: {
          usage: {
            provider: "codex",
            model: "gpt-5.6-terra",
            requests: 1,
            inputTokens: 1200,
            outputTokens: 80,
            totalTokens: 1280,
            cacheHitTokens: 900,
            cacheMissTokens: 300,
            reasoningTokens: 12,
            costUsd: 0,
            codexRequests: 1,
          },
        },
      },
      promptTelemetry: { chars: 15, bytes: 15 },
    }],
  };
  const artifactPath = path.join(root, "run.json");
  fs.writeFileSync(artifactPath, JSON.stringify(artifact));
  const spec = {
    schema: 1,
    name: "preflight-study",
    artifact: "run.json",
    turn: 0,
    samples,
    remedy: "Use the recorded contract evidence.",
    expectation: {
      verbs: ["replace"],
      paths: ["index.html"],
      contentAny: ["fixed"],
    },
  };
  const specPath = path.join(root, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { artifact, artifactPath, specPath };
}

test("replay preflight reconstructs request budget, seeds, runtime, and source telemetry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-preflight-"));
  try {
    const { artifactPath, specPath } = fixture(tempDir);
    const before = fs.readdirSync(tempDir).sort();
    const report = buildReplayExperimentPreflight({ specPath });
    assert.equal(report.status, "ready");
    assert.equal(report.budget.modelRequests, 6);
    assert.equal(report.sampling.pairing, "seed-paired");
    assert.equal(report.sampling.orderBalance, "best-possible");
    assert.deepEqual(report.sampling.seeds, [42, 43, 44]);
    assert.deepEqual(report.schedule.map((row) => row.order), [
      ["baseline", "candidate"],
      ["candidate", "baseline"],
      ["baseline", "candidate"],
    ]);
    assert.equal(report.runtime.kind, "codex-recorded");
    assert.equal(report.runtime.model, "gpt-5.6-terra");
    assert.equal(report.source.sha256, sha256(fs.readFileSync(artifactPath)));
    assert.equal(report.source.recordedCallUsage.inputTokens, 1200);
    assert.equal(report.source.recordedCallUsageBoundary, "source-call telemetry; not a replay cost projection");
    assert.ok(report.budget.serializedRequestBytes.candidate > report.budget.serializedRequestBytes.baseline);
    assert.deepEqual(fs.readdirSync(tempDir).sort(), before, "preflight must not write");
    assert.match(formatReplayExperimentPreflight(report), /6 model requests/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay preflight blocks an exceeded call cap and rejects corrupt source requests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-preflight-block-"));
  try {
    const { artifact, artifactPath, specPath } = fixture(tempDir);
    const blocked = buildReplayExperimentPreflight({ specPath, maxCalls: 4 });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.failures.join("\n"), /6 model requests exceeds --max-calls 4/);
    assert.throws(
      () => buildReplayExperimentPreflight({ specPath, maxCalls: true }),
      /--max-calls must be an integer/,
    );

    artifact.modelCalls[0].request.bodySha256 = "0".repeat(64);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.throws(
      () => buildReplayExperimentPreflight({ specPath }),
      /request body checksum does not match/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay preflight blocks only an exact prior design, not an alternate hypothesis", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-preflight-study-"));
  try {
    const { artifactPath, specPath } = fixture(tempDir);
    const studyDir = path.join(tempDir, "studies");
    fs.mkdirSync(studyDir);
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    const prior = {
      schema: 1,
      kind: "bantam-replay-experiment",
      name: "prior exact design",
      status: "complete",
      spec,
      artifact: {
        sha256: sha256(fs.readFileSync(artifactPath)),
        turn: spec.turn,
      },
      pairs: Array.from({ length: spec.samples }, (_, sample) => ({ sample })),
      totals: { samples: spec.samples, verdict: "no-lift" },
    };
    fs.writeFileSync(path.join(studyDir, "exact.json"), JSON.stringify(prior));
    fs.writeFileSync(path.join(studyDir, "incomplete.json"), JSON.stringify({
      ...prior,
      name: "incomplete",
      status: "running",
    }));

    const duplicate = buildReplayExperimentPreflight({
      specPath,
      studyRoots: [studyDir],
      requireNewDesign: true,
    });
    assert.equal(duplicate.status, "blocked");
    assert.equal(duplicate.priorStudies.exactTurn.length, 1);
    assert.equal(duplicate.priorStudies.exactDesign.length, 1);
    assert.equal(duplicate.priorStudies.ignoredInvalid, 1);
    assert.match(duplicate.failures.join("\n"), /exact replay design already has 1 prior study/);

    spec.remedy = "Test a genuinely different bounded hypothesis.";
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const alternate = buildReplayExperimentPreflight({
      specPath,
      studyRoots: [studyDir],
      requireNewDesign: true,
    });
    assert.equal(alternate.status, "ready");
    assert.equal(alternate.priorStudies.exactTurn.length, 1);
    assert.equal(alternate.priorStudies.exactDesign.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay-ab dry-run is model-free and write-free in both launchers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-preflight-cli-"));
  try {
    const { artifactPath, specPath } = fixture(tempDir, { samples: 2 });
    const studyDir = path.join(tempDir, "studies");
    fs.mkdirSync(studyDir);
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    fs.writeFileSync(path.join(studyDir, "prior.json"), JSON.stringify({
      schema: 1,
      kind: "bantam-replay-experiment",
      name: "prior",
      status: "complete",
      spec,
      artifact: {
        sha256: sha256(fs.readFileSync(artifactPath)),
        turn: spec.turn,
      },
      pairs: Array.from({ length: spec.samples }, (_, sample) => ({ sample })),
      totals: { samples: spec.samples, verdict: "no-lift" },
    }));
    for (const launcher of ["bantam.js", "bantambuild.js"]) {
      const output = path.join(tempDir, `${launcher}-evidence`);
      const result = spawnSync(process.execPath, [
        path.join(repoRoot, "bin", launcher),
        "replay-ab",
        specPath,
        "--dry-run",
        "--max-calls",
        "4",
        "--output",
        output,
        "--json",
      ], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).status, "ready");
      assert.equal(fs.existsSync(output), false);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /^model:|replay sample/m);

      const blockedOutput = path.join(tempDir, `${launcher}-blocked`);
      const blocked = spawnSync(process.execPath, [
        path.join(repoRoot, "bin", launcher),
        "replay-ab",
        specPath,
        "--max-calls",
        "1",
        "--output",
        blockedOutput,
      ], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /4 model requests exceeds --max-calls 1/);
      assert.equal(fs.existsSync(blockedOutput), false);
      assert.doesNotMatch(`${blocked.stdout}\n${blocked.stderr}`, /^model:|replay sample/m);

      const duplicateOutput = path.join(tempDir, `${launcher}-duplicate`);
      const duplicate = spawnSync(process.execPath, [
        path.join(repoRoot, "bin", launcher),
        "replay-ab",
        specPath,
        "--require-new-design",
        "--study-root",
        studyDir,
        "--output",
        duplicateOutput,
      ], { cwd: repoRoot, encoding: "utf8" });
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /exact replay design already has 1 prior study/);
      assert.equal(fs.existsSync(duplicateOutput), false);
      assert.doesNotMatch(`${duplicate.stdout}\n${duplicate.stderr}`, /^model:|replay sample/m);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
