import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditReplayExperimentEvidence,
  formatReplayExperimentAudit,
  resolveReplayEvidenceFile,
} from "../src/replay-experiment-audit.js";
import {
  normalizeReplayExperimentSpec,
  scoreReplayOutput,
} from "../src/replay-experiment.js";

const spec = normalizeReplayExperimentSpec({
  name: "audited-replay",
  artifact: "run.json",
  turn: 2,
  samples: 1,
  remedy: "Correct the grounded alt.",
  expectation: {
    verbs: ["replace"],
    paths: ["index.html"],
    contentAny: ["moon"],
    contentAll: ["alt="],
  },
});
const baselineRaw = '{"a":"shell","c":"npm test"}';
const candidateRaw = JSON.stringify({
  a: "replace",
  p: "index.html",
  old: "alt=\"city\"",
  new: "alt=\"greenhouse beneath a crescent moon\"",
});
const artifactBytes = Buffer.from('{"run":1}');
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function evidence() {
  const evidenceSpec = structuredClone(spec);
  return {
    schema: 1,
    kind: "bantam-replay-experiment",
    status: "complete",
    spec: evidenceSpec,
    specSha256: hash(JSON.stringify(evidenceSpec)),
    artifact: { path: "run.json", sha256: hash(artifactBytes) },
    pairs: [{
      sample: 0,
      seed: null,
      baseline: {
        rawOutput: baselineRaw,
        score: scoreReplayOutput(baselineRaw, spec.expectation),
        error: null,
      },
      candidate: {
        rawOutput: candidateRaw,
        score: scoreReplayOutput(candidateRaw, spec.expectation),
        error: null,
      },
    }],
    totals: {
      samples: 1,
      baselinePasses: 0,
      candidatePasses: 1,
      lift: 1,
      errors: 0,
      pairing: "alternating-unseeded",
      verdict: "supported-unpaired",
    },
  };
}

test("replay evidence audit independently verifies hashes, actions, and totals", () => {
  const report = auditReplayExperimentEvidence(evidence(), { artifactBytes });
  assert.equal(report.status, "pass");
  assert.deepEqual(report.failures, []);
  assert.match(formatReplayExperimentAudit(report), /candidate 1\/1/);
});

test("replay evidence audit detects raw action, total, spec, and artifact tampering", () => {
  const tampered = evidence();
  tampered.pairs[0].candidate.rawOutput = baselineRaw;
  tampered.totals.candidatePasses = 9;
  tampered.specSha256 = "0".repeat(64);
  const report = auditReplayExperimentEvidence(tampered, {
    artifactBytes: Buffer.from("different"),
  });
  assert.equal(report.status, "fail");
  assert.match(report.failures.join("\n"), /spec SHA-256/);
  assert.match(report.failures.join("\n"), /source artifact SHA-256/);
  assert.match(report.failures.join("\n"), /candidate pass score/);
  assert.match(report.failures.join("\n"), /totals.candidatePasses/);
});

test("replay evidence audit rejects a semantically plausible but inapplicable edit", () => {
  const strict = evidence();
  strict.spec.expectation.requireOldInPrompt = true;
  strict.specSha256 = hash(JSON.stringify(strict.spec));
  strict.pairs[0].candidate.rawOutput = JSON.stringify({
    a: "replace",
    p: "index.html",
    old: "THIS NEVER EXISTED",
    new: "alt=\"greenhouse beneath a crescent moon\"",
  });
  const sourceArtifact = {
    turns: [{
      modelCallIndex: 0,
      parsedAction: { a: "shell", c: "npm test" },
      rawOutput: baselineRaw,
      observation: "",
    }],
    modelCalls: [{
      index: 0,
      request: {
        url: "http://localhost/completion",
        body: JSON.stringify({ prompt: '# index.html\n12\t<img alt="city">' }),
      },
    }],
  };
  const sourceBytes = Buffer.from(JSON.stringify(sourceArtifact));
  strict.artifact.sha256 = hash(sourceBytes);
  const report = auditReplayExperimentEvidence(strict, {
    artifactBytes: sourceBytes,
  });
  assert.equal(report.status, "fail");
  assert.match(report.failures.join("\n"), /candidate pass score/);
});

test("replay evidence audit rejects a claimed but non-counterbalanced call order", () => {
  const malformed = evidence();
  malformed.pairs[0].order = ["candidate", "baseline"];
  malformed.totals.pairing = "counterbalanced-unseeded";
  malformed.totals.orderBalance = "best-possible";
  const report = auditReplayExperimentEvidence(malformed, { artifactBytes });
  assert.equal(report.status, "fail");
  assert.match(report.failures.join("\n"), /call order/);
});

test("model-free replay CLI help and evidence audits do not initialize a model", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-audit-"));
  try {
    const artifactPath = path.join(tempDir, "run.json");
    const evidencePath = path.join(tempDir, "evidence.json");
    const savedEvidence = evidence();
    savedEvidence.artifact.path = "run.json";
    fs.writeFileSync(artifactPath, artifactBytes);
    fs.writeFileSync(evidencePath, JSON.stringify(savedEvidence));

    for (const launcher of ["bantam.js", "bantambuild.js"]) {
      const cli = path.join(repoRoot, "bin", launcher);
      for (const command of ["audit-replay", "replay-ab"]) {
        const help = spawnSync(process.execPath, [cli, command, "--help"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        assert.equal(help.status, 0, `${launcher} ${command} --help: ${help.stderr}`);
        assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /^model:/m);
      }
      const missingSpec = spawnSync(process.execPath, [cli, "replay-ab"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.equal(missingSpec.status, 2);
      assert.doesNotMatch(
        `${missingSpec.stdout}\n${missingSpec.stderr}`,
        /^model:/m,
      );

      const audited = spawnSync(
        process.execPath,
        [cli, "audit-replay", evidencePath, "--json"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(
        audited.status,
        0,
        `${launcher} audit-replay:\nstdout: ${audited.stdout}\nstderr: ${audited.stderr}`,
      );
      assert.equal(JSON.parse(audited.stdout).status, "pass");
      assert.doesNotMatch(`${audited.stdout}\n${audited.stderr}`, /^model:/m);

      const auditedDirectory = spawnSync(
        process.execPath,
        [cli, "audit-replay", tempDir, "--json"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(auditedDirectory.status, 0, auditedDirectory.stderr);
      assert.equal(JSON.parse(auditedDirectory.stdout).status, "pass");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay evidence path resolver accepts files and study directories", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-path-"));
  try {
    const evidencePath = path.join(tempDir, "evidence.json");
    fs.writeFileSync(evidencePath, "{}");
    assert.equal(resolveReplayEvidenceFile(evidencePath), evidencePath);
    assert.equal(resolveReplayEvidenceFile(tempDir), evidencePath);

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-empty-"));
    try {
      assert.throws(
        () => resolveReplayEvidenceFile(emptyDir),
        /has no evidence\.json/,
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
