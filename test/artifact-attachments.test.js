import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveGeneratedAttachments } from "../src/artifact-attachments.js";
import { runFixture } from "../src/fixture-runner.js";
import { FactLog } from "../src/logic/fact-log.js";
import { runPreviewSync } from "../src/logic/preview.js";
import { snapshotTree } from "../src/scope-guard.js";
import { formatExperimentSummary } from "../src/experiment.js";
import { buildGauntletShowcase } from "../src/gauntlet-showcase.js";
import { saveArtifact } from "../src/artifact.js";
import { auditRunArtifact } from "../src/run-artifact-audit.js";
import { chromiumSkipReason, networkSkipReason, compositeSkipReason } from "./helpers/env-guards.js";

const _chromiumSkip = chromiumSkipReason();
const _networkSkip = await networkSkipReason();

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

test("generated attachment archival preserves only changed managed evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-attachments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const generated = path.join(workspace, "assets", "generated");
  const artifactPath = path.join(root, "evidence", "run.json");
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, "unchanged.png"), "same");
  fs.writeFileSync(path.join(generated, "changed.png"), "before");
  const before = snapshotTree(workspace);

  fs.writeFileSync(path.join(generated, "changed.png"), "after");
  fs.mkdirSync(path.join(generated, "nested"));
  fs.writeFileSync(path.join(generated, "nested", "review.html"), "<h1>review</h1>");
  fs.writeFileSync(path.join(generated, "notes.txt"), "not visual evidence");
  const outside = path.join(root, "outside-secret");
  fs.writeFileSync(outside, "must not be copied");
  fs.symlinkSync(outside, path.join(generated, "leak.json"));

  const archived = archiveGeneratedAttachments({
    workspace,
    artifactPath,
    before,
  });

  assert.equal(archived.status, "partial");
  assert.equal(archived.files.length, 2);
  assert.deepEqual(
    archived.files.map((item) => item.sourcePath),
    ["assets/generated/changed.png", "assets/generated/nested/review.html"],
  );
  assert.deepEqual(
    archived.omitted.map((item) => [item.path, item.reason]),
    [
      ["assets/generated/leak.json", "symlink"],
      ["assets/generated/notes.txt", "unsupported-extension"],
    ],
  );
  for (const item of archived.files) {
    const saved = path.resolve(path.dirname(artifactPath), item.path);
    const data = fs.readFileSync(saved);
    assert.equal(item.sha256, sha(data));
    assert.equal(item.bytes, data.length);
    assert.ok(saved.startsWith(path.resolve(root, "evidence") + path.sep));
  }
  assert.ok(!archived.files.some((item) => item.sourcePath.endsWith("unchanged.png")));
  assert.ok(!fs.readFileSync(path.resolve(path.dirname(artifactPath), archived.indexPath), "utf8")
    .includes("must not be copied"));
});

test("generated attachment archival enforces per-file, total, and count limits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-attachment-limits-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = path.join(root, "workspace", "assets", "generated");
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, "a.png"), Buffer.alloc(4, 1));
  fs.writeFileSync(path.join(generated, "b.png"), Buffer.alloc(5, 2));
  fs.writeFileSync(path.join(generated, "c.png"), Buffer.alloc(20, 3));
  fs.writeFileSync(path.join(generated, "d.png"), Buffer.alloc(4, 4));
  fs.writeFileSync(path.join(generated, "e.png"), Buffer.alloc(1, 5));

  const archived = archiveGeneratedAttachments({
    workspace: path.join(root, "workspace"),
    artifactPath: path.join(root, "run.json"),
    limits: { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 8 },
  });

  assert.equal(archived.totalBytes, 8);
  assert.deepEqual(archived.files.map((item) => item.sourcePath), [
    "assets/generated/a.png",
    "assets/generated/d.png",
  ]);
  assert.deepEqual(archived.omitted.map((item) => item.reason), [
    "total-size-limit",
    "file-size-limit",
    "file-count-limit",
  ]);
});

test("fixture cleanup leaves archived generated evidence readable and renderable", { skip: _chromiumSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-attachment-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  const repo = path.join(fixture, "repo");
  const artifactPath = path.join(root, "experiment", "runs", "proof.json");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(fixture, "task.json"), JSON.stringify({
    name: "attachment-lifecycle-proof",
    task: "Create the requested generated evidence files, verify them, and finish.",
    verify: "node -e \"const f=require('fs'); f.accessSync('assets/generated/proof.json'); f.accessSync('assets/generated/review.html')\"",
    maxTurns: 8,
    editable: ["assets/generated"],
  }));

  const outputs = [
    { a: "write_file", p: "assets/generated/proof.json", content: "{\"proof\":true}\n" },
    { a: "write_file", p: "assets/generated/review.html", content: "<!doctype html><title>Archived review</title><main><h1>Archived evidence survives cleanup</h1></main>" },
    { a: "shell", c: "node -e \"const f=require('fs'); f.accessSync('assets/generated/proof.json'); f.accessSync('assets/generated/review.html'); console.log('evidence ready')\"" },
    { a: "done", summary: "Generated evidence created and verified." },
  ];
  let call = 0;
  const model = {
    endpoint: null,
    profileName: "test",
    temperature: 0,
    actTemperature: 0,
    topP: 1,
    topK: 0,
    seed: 1,
    nPredict: 1024,
    stop: [],
    codex: false,
    metadata: () => ({ runtime: "test", model: "scripted" }),
    usageSummary: () => ({}),
    usageBreakdownSummary: () => ({}),
    requestLog: () => [],
    async complete() {
      const action = outputs[Math.min(call++, outputs.length - 1)];
      return {
        content: JSON.stringify(action),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };

  const row = await runFixture({
    dir: fixture,
    model,
    captureArtifact: true,
    artifactPathForRun: () => artifactPath,
    artifactPathLabel: (value) => path.relative(path.join(root, "experiment"), value),
    modelId: "scripted",
    preGate: false,
    factsLog: new FactLog(),
  });

  assert.equal(row.status, "pass");
  assert.equal(row.archivedAttachments, 2);
  assert.equal(row.archivedAttachmentFiles.length, 2);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(row.runArtifactIntegrityStatus, "pass");
  assert.equal(artifact.metrics.runArtifactIntegrity.status, "pass");
  assert.equal(artifact.metrics.runArtifactIntegrity.checks.attachments, "pass");
  assert.equal(artifact.metrics.runArtifactIntegrity.checks.finalDiff, "pass");
  assert.match(artifact.fixtureProvenance.evaluatorSha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.fixtureProvenance.taskSpecSha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.fixtureProvenance.repoFiles, 0);
  assert.equal(artifact.attachments.status, "captured");
  assert.equal(artifact.attachments.files.length, 2);
  for (const invalidPath of ["../escape.png", "/absolute.png", "nested//empty.png"]) {
    const invalid = structuredClone(artifact);
    invalid.attachments.files[0].path = invalidPath;
    assert.throws(
      () => saveArtifact(path.join(root, `invalid-${sha(invalidPath).slice(0, 8)}.json`), invalid),
      /relative path|traversal|empty segments/,
    );
  }
  const invalidHash = structuredClone(artifact);
  invalidHash.attachments.files[0].sha256 = "not-a-hash";
  assert.throws(
    () => saveArtifact(path.join(root, "invalid-hash.json"), invalidHash),
    /sha256/,
  );
  const invalidFixtureRoot = structuredClone(artifact);
  invalidFixtureRoot.fixtureProvenance.graderTreeSha256 = "0".repeat(64);
  const provenanceAudit = auditRunArtifact(invalidFixtureRoot, { artifactPath });
  assert.equal(provenanceAudit.status, "fail");
  assert.ok(
    provenanceAudit.failures.some((failure) =>
      failure.code === "fixture_provenance_hash"),
  );
  const attachmentRoot = path.resolve(
    path.dirname(artifactPath),
    path.dirname(artifact.attachments.indexPath),
  );
  const preview = runPreviewSync(attachmentRoot, "assets/generated/review.html");
  assert.equal(preview.previewStatus, "pass");
  assert.match(preview.visibleTextSample, /survives cleanup/i);

  const manifest = {
    id: "attachment-proof",
    name: "attachment-proof",
    status: "complete",
    specSha256: "abc123",
    completedAt: "2026-07-29T00:00:00.000Z",
    spec: {
      rounds: 1,
      passAtK: [1],
      fixtures: ["attachment-lifecycle-proof"],
      arms: [{ name: "scripted", model: { runtime: "test", name: "scripted" } }],
    },
    schedule: [{
      arm: "scripted",
      round: 1,
      sequence: 0,
      status: "complete",
      durationMs: row.durationMs,
      runs: [row],
    }],
  };
  const summary = formatExperimentSummary(manifest);
  assert.match(summary, /Archived generated evidence/);
  assert.match(summary, /Complete run integrity: scripted 1\/1 applicable pass, 0 n\/a, 0 failures, 0 warnings/);
  assert.match(summary, /\[contact sheet 1\]\(runs\/proof\.attachments\/assets\/generated\/review\.html\)/);
  const showcase = buildGauntletShowcase(manifest);
  assert.match(showcase, /scripted · attachment-lifecycle-proof contact 1/);
  assert.match(showcase, /runs\/proof\.attachments\/assets\/generated\/review\.html/);

  call = 0;
  const rejectedPath = path.join(root, "experiment", "runs", "rejected.json");
  const rejected = await runFixture({
    dir: fixture,
    model,
    captureArtifact: true,
    artifactPathForRun: () => rejectedPath,
    modelId: "scripted",
    preGate: false,
    factsLog: new FactLog(),
    auditRunArtifactFn: () => ({
      schema: 1,
      status: "fail",
      checks: { identity: { status: "fail" } },
      failures: [{ check: "identity", code: "injected", message: "controlled evidence failure" }],
      warnings: [],
    }),
  });
  assert.equal(rejected.status, "evidence-invalid");
  assert.equal(rejected.runArtifactIntegrityFailures, 1);
  const rejectedArtifact = JSON.parse(fs.readFileSync(rejectedPath, "utf8"));
  assert.equal(rejectedArtifact.result.pass, false);
  assert.equal(rejectedArtifact.result.status, "evidence-invalid");
  assert.equal(rejectedArtifact.metrics.runArtifactIntegrity.failures[0].code, "injected");
});
