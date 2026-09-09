import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { archiveGeneratedAttachments } from "../src/artifact-attachments.js";
import { buildArtifact, saveArtifact } from "../src/artifact.js";
import {
  auditRunArtifact,
  auditRunArtifactFile,
  auditRunArtifactFileAsync,
} from "../src/run-artifact-audit.js";

function proofRun(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-run-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const generated = path.join(workspace, "assets", "generated");
  const artifactPath = path.join(root, "evidence", "run.json");
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, "proof.json"), "{\"proof\":true}\n");
  const usage = {
    requests: 2,
    inputTokens: 30,
    outputTokens: 7,
    totalTokens: 37,
    cacheHitTokens: 10,
    cacheMissTokens: 20,
    reasoningTokens: 3,
    costUsd: 0,
    codexRequests: 2,
  };
  const toolOutcome = {
    schema: 1,
    tool: "view_image",
    status: "pass",
    terminal: false,
    retryable: null,
    artifacts: [],
    failures: [],
    blocked: null,
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
      reasoningTokens: 0,
      costUsd: 0,
      codexRequests: 1,
    },
    proof: null,
    details: { usageSource: "supplied_image_vision" },
  };
  const artifact = buildArtifact({
    runId: "run-audit-proof",
    stamp: "2026-07-29T12-00-00-000Z",
    fixture: "audit-proof",
    task: "prove the evidence",
    model: {
      endpoint: null,
      metadata: () => ({ runtime: "test", model: "scripted" }),
      requestLog: () => [],
    },
    modelId: "scripted",
    result: {
      finalStatus: "pass",
      turns: [{
        i: 0,
        queryTool: "view_image",
        queryExecuted: true,
        toolOutcome,
      }],
      rejectedOutputs: [],
      warnings: [],
      usage,
      usageBySource: {
        action_generation: {
          ...usage,
          requests: 1,
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cacheMissTokens: 10,
          codexRequests: 1,
        },
        supplied_image_vision: {
          ...usage,
          requests: 1,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cacheHitTokens: 0,
          cacheMissTokens: 10,
          reasoningTokens: 0,
          codexRequests: 1,
        },
      },
      metrics: { turns: 1, toolOutcomeCounts: { pass: 1 } },
    },
    finalDiff: {
      format: "git-unified-diff",
      status: "captured",
      truncated: false,
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      files: [],
      fileCount: 0,
      text: "",
    },
  });
  artifact.attachments = archiveGeneratedAttachments({
    workspace,
    artifactPath,
  });
  saveArtifact(artifactPath, artifact);
  return { root, artifact, artifactPath };
}

test("run artifact audit independently reconciles complete evidence", async (t) => {
  const { artifactPath } = proofRun(t);
  const report = auditRunArtifactFile(artifactPath);
  assert.deepEqual(await auditRunArtifactFileAsync(artifactPath), report);
  assert.equal(report.status, "pass");
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.status])),
    {
      identity: "pass",
      toolOutcomes: "pass",
      usage: "pass",
      attachments: "pass",
      finalDiff: "pass",
      codexPrompt: "not-applicable",
    },
  );
  assert.equal(report.checks.usage.sums.totalTokens, 37);
  assert.equal(report.checks.attachments.files, 1);
});

test('streamed artifact audits retain explicit unreadable-file failures', async t => {
  const { artifactPath } = proofRun(t);
  for (const text of ['{"schema":1,"turns":[{}', 'not JSON']) {
    fs.writeFileSync(artifactPath,text);
    const report=await auditRunArtifactFileAsync(artifactPath);
    assert.equal(report.status,'fail');
    assert.equal(report.failures[0].code,'unreadable');
  }
  const missing=await auditRunArtifactFileAsync(artifactPath+'.missing');
  assert.equal(missing.status,'fail');
  assert.equal(missing.failures[0].code,'unreadable');
});

test("run artifact audit detects tampered, missing, and symlinked attachment bytes", (t) => {
  const { artifact, artifactPath, root } = proofRun(t);
  const attached = path.resolve(path.dirname(artifactPath), artifact.attachments.files[0].path);
  const original = fs.readFileSync(attached);

  fs.writeFileSync(attached, "tampered\n");
  let report = auditRunArtifactFile(artifactPath);
  assert.equal(report.status, "fail");
  assert.ok(report.failures.some((item) => item.code === "sha256"));

  fs.rmSync(attached);
  report = auditRunArtifactFile(artifactPath);
  assert.ok(report.failures.some((item) => item.code === "unreadable"));

  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, attached);
  report = auditRunArtifactFile(artifactPath);
  assert.ok(report.failures.some((item) => item.code === "unreadable" && /symlink/.test(item.message)));
});

test("run artifact audit detects accounting, tool, diff, index, and traversal regressions", (t) => {
  const { artifact, artifactPath } = proofRun(t);

  const accounting = structuredClone(artifact);
  accounting.metrics.usage.outputTokens++;
  let report = auditRunArtifact(accounting, { artifactPath });
  assert.ok(report.failures.some((item) => item.check === "usage" && item.code === "reconciliation"));

  const tool = structuredClone(artifact);
  tool.turns[0].toolOutcome.status = "mystery";
  report = auditRunArtifact(tool, { artifactPath });
  assert.ok(report.failures.some((item) => item.check === "toolOutcomes" && item.code === "status"));
  assert.ok(report.failures.some((item) => item.code === "counts_mismatch"));

  const toolUsage = structuredClone(artifact);
  toolUsage.turns[0].toolOutcome.usage.outputTokens++;
  report = auditRunArtifact(toolUsage, { artifactPath });
  assert.ok(report.failures.some((item) => item.check === "toolOutcomes" && item.code === "usage_mismatch"));

  const traversal = structuredClone(artifact);
  traversal.attachments.files[0].path = "../outside.json";
  report = auditRunArtifact(traversal, { artifactPath });
  assert.ok(report.failures.some((item) => item.check === "attachments" && item.code === "path"));

  const diff = structuredClone(artifact);
  diff.finalDiff.text = "silently replaced";
  report = auditRunArtifact(diff, { artifactPath });
  assert.ok(report.failures.some((item) => item.check === "finalDiff" && item.code === "sha256"));

  const indexPath = path.resolve(path.dirname(artifactPath), artifact.attachments.indexPath);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index.files[0].bytes++;
  fs.writeFileSync(indexPath, JSON.stringify(index));
  report = auditRunArtifactFile(artifactPath);
  assert.ok(report.failures.some((item) => item.code === "index_mismatch"));
});

test("run artifact audit remains honest about legacy evidence gaps", () => {
  const report = auditRunArtifact({
    schema: 1,
    kind: "bantam-run",
    runId: "legacy",
    turns: [],
    metrics: {},
    finalDiff: null,
  });
  assert.equal(report.status, "pass");
  assert.equal(report.checks.usage.status, "not-applicable");
  assert.equal(report.checks.toolOutcomes.status, "not-applicable");
  assert.equal(report.checks.attachments.status, "not-applicable");
  assert.equal(report.checks.finalDiff.status, "not-applicable");
  assert.ok(report.warnings.length >= 4);
});

test("audit-run CLI is model-free and returns machine-readable failure evidence", (t) => {
  const { artifactPath } = proofRun(t);
  const cli = path.resolve("bin/bantam.js");
  let run = spawnSync(process.execPath, [cli, "audit-run", artifactPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout)[0].status, "pass");

  fs.appendFileSync(
    path.resolve(
      path.dirname(artifactPath),
      JSON.parse(fs.readFileSync(artifactPath, "utf8")).attachments.files[0].path,
    ),
    "corruption",
  );
  run = spawnSync(process.execPath, [cli, "audit-run", artifactPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  const failure = JSON.parse(run.stdout)[0];
  assert.equal(failure.status, "fail");
  assert.ok(failure.failures.some((item) => item.code === "sha256"));
  assert.equal(run.stderr, "");
});
