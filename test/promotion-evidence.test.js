import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createExperimentManifest,
  summarizeExperiment,
} from "../src/experiment.js";
import {
  EvidenceError,
  validatePromotionEvidence,
} from "../src/promotion-evidence.js";

const VERSION_REF = `sha256:${"a".repeat(64)}`;
const WORKSPACE_COMMIT = "c".repeat(40);
const WORKSPACE_TREE = "b".repeat(40);
const temporary = new Set();

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(dir);
  return dir;
}

function spec() {
  return {
    schema: 1,
    name: "promotion-test",
    fixtures: ["fixture-a"],
    rounds: 1,
    seeds: [17],
    arms: [
      { name: "baseline" },
      { name: "candidate" },
    ],
  };
}

function completedManifest({
  candidateVersionRef = VERSION_REF,
  workspaceTree = WORKSPACE_TREE,
  explicitBinding = true,
  harnessGit = null,
  promotionBinding = null,
} = {}) {
  const manifest = createExperimentManifest({
    spec: spec(),
    id: "exp-test",
    harnessGit,
    promotionBinding,
  });
  for (const entry of manifest.schedule) {
    entry.status = "complete";
    entry.completedAt = new Date().toISOString();
    entry.durationMs = 1;
    entry.runs = [{
      name: "fixture-a",
      status: "pass",
      turns: 1,
      durationMs: 1,
    }];
  }
  manifest.status = "complete";
  manifest.completedAt = new Date().toISOString();
  manifest.totals = summarizeExperiment(manifest);
  manifest.candidateArm = "candidate";
  if (explicitBinding) {
    manifest.candidateVersionRef = candidateVersionRef;
    manifest.workspaceTree = workspaceTree;
  }
  return manifest;
}

function writeEvidence(manifest, root = tempDir("bantam-promotion-evidence-")) {
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "spec.json"), `${JSON.stringify(manifest.spec, null, 2)}\n`);
  return root;
}

function validate(root, overrides = {}) {
  return validatePromotionEvidence(root, {
    arm: "candidate",
    candidateVersionRef: VERSION_REF,
    workspaceCommit: WORKSPACE_COMMIT,
    workspaceTree: WORKSPACE_TREE,
    harnessRoot: root,
    ...overrides,
  });
}

function expectEvidenceError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof EvidenceError);
    assert.match(error.message, pattern);
    return true;
  });
}

afterEach(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

describe("promotion evidence integrity", () => {
  it("accepts a structured binding from the verified pinned channel launcher", () => {
    const promotionBinding = {
      schema: 1,
      kind: "bantam.pinned-experiment-binding",
      source: "verified-channel-launch",
      channel: "dev",
      laneId: "experiment-lane",
      candidateVersionRef: VERSION_REF,
      workspaceCommit: WORKSPACE_COMMIT,
      workspaceTree: WORKSPACE_TREE,
    };
    const manifest = completedManifest({
      explicitBinding: false,
      promotionBinding,
    });

    const evidence = validate(writeEvidence(manifest), { sourceChannel: "dev" });

    assert.equal(evidence.harness.binding, "pinned-channel-version-tree");
    assert.equal(evidence.harness.channel, "dev");
    assert.equal(evidence.harness.laneId, "experiment-lane");
    assert.equal(evidence.harness.workspaceCommit, WORKSPACE_COMMIT);
  });

  it("rejects pinned evidence attributed to a different promotion source channel", () => {
    const manifest = completedManifest({
      explicitBinding: false,
      promotionBinding: {
        schema: 1,
        kind: "bantam.pinned-experiment-binding",
        source: "verified-channel-launch",
        channel: "regular",
        laneId: "experiment-lane",
        candidateVersionRef: VERSION_REF,
        workspaceCommit: WORKSPACE_COMMIT,
        workspaceTree: WORKSPACE_TREE,
      },
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest), { sourceChannel: "dev" }),
      /source channel regular.*promotion source dev/i,
    );
  });

  it("rejects a pinned binding with a commit unrelated to the promoted version", () => {
    const manifest = completedManifest({
      explicitBinding: false,
      promotionBinding: {
        schema: 1,
        kind: "bantam.pinned-experiment-binding",
        source: "verified-channel-launch",
        channel: "dev",
        laneId: "experiment-lane",
        candidateVersionRef: VERSION_REF,
        workspaceCommit: "d".repeat(40),
        workspaceTree: WORKSPACE_TREE,
      },
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest), { sourceChannel: "dev" }),
      /workspace commit.*does not match promoted commit/i,
    );
  });

  it("accepts recomputable evidence explicitly bound to the promoted version and tree", () => {
    const evidence = validate(writeEvidence(completedManifest()));

    assert.equal(evidence.candidate, "candidate");
    assert.equal(evidence.candidateVersionRef, VERSION_REF);
    assert.equal(evidence.workspaceTree, WORKSPACE_TREE);
    assert.equal(evidence.harness.binding, "explicit-version-tree");
    assert.match(evidence.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.arms.candidate.tasks, 1);
  });

  it("accepts a completed recovery experiment where the baseline failed and candidate passed", () => {
    const manifest = completedManifest();
    const baseline = manifest.schedule.find((entry) => entry.arm === "baseline");
    baseline.runs[0].status = "fail";
    manifest.status = "complete_with_failures";
    manifest.totals = summarizeExperiment(manifest);

    const evidence = validate(writeEvidence(manifest));

    assert.equal(evidence.delta.passed, 1);
    assert.equal(evidence.arms.candidate.passed, 1);
    assert.equal(evidence.arms.baseline.passed, 0);
  });

  it("rejects a completed experiment with no candidate successes", () => {
    const manifest = completedManifest();
    for (const entry of manifest.schedule) entry.runs[0].status = "fail";
    manifest.status = "complete_with_failures";
    manifest.totals = summarizeExperiment(manifest);

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /no passing samples/i,
    );
  });

  it("rejects candidate scope violations even when pass totals look non-regressive", () => {
    const manifest = completedManifest();
    const candidate = manifest.schedule.find((entry) => entry.arm === "candidate");
    candidate.runs[0].scopeViolations = 1;
    manifest.totals = summarizeExperiment(manifest);

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /scope\/integrity violations/i,
    );
  });

  it("rejects zero-sample manifests even when their totals were recomputed", () => {
    const manifest = completedManifest();
    for (const entry of manifest.schedule) entry.runs = [];
    manifest.totals = summarizeExperiment(manifest);

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /0 sample|zero/i,
    );
  });

  it("rejects totals inconsistent with the schedule", () => {
    const manifest = completedManifest();
    manifest.totals.arms.candidate.passed = 99;

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /totals do not match/i,
    );
  });

  it("rejects schedule identity tampering", () => {
    const manifest = completedManifest();
    manifest.schedule[0].arm = "candidate";

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /schedule entry 0/i,
    );
  });

  it("rejects fixture identity tampering even when totals are recomputed", () => {
    const manifest = completedManifest();
    manifest.schedule[0].runs[0].name = "substituted-fixture";
    manifest.totals = summarizeExperiment(manifest);

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /does not match fixture/i,
    );
  });

  it("rejects manifest spec hash tampering", () => {
    const manifest = completedManifest();
    manifest.spec.name = "changed-after-run";

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /spec hash/i,
    );
  });

  it("rejects evidence without the persisted preregistered spec", () => {
    const root = writeEvidence(completedManifest());
    fs.unlinkSync(path.join(root, "spec.json"));

    expectEvidenceError(
      () => validate(root),
      /missing.*spec\.json/i,
    );
  });

  it("rejects evidence bound to a different candidate version", () => {
    const manifest = completedManifest({
      candidateVersionRef: `sha256:${"c".repeat(64)}`,
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /does not match promoted version/i,
    );
  });

  it("rejects evidence bound to a different workspace tree", () => {
    const manifest = completedManifest({
      workspaceTree: "c".repeat(40),
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /does not match promoted tree/i,
    );
  });

  it("falls back to a resolvable clean Git tree for manifests without explicit binding", () => {
    const repo = tempDir("bantam-promotion-git-");
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.js"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", [
      "-c", "user.name=Bantam Test",
      "-c", "user.email=bantam@example.invalid",
      "commit", "-qm", "baseline",
    ], { cwd: repo });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim();
    const manifest = completedManifest({
      explicitBinding: false,
      harnessGit: { sha, dirty: false },
    });
    const evidenceDir = path.join(repo, "evidence");
    fs.mkdirSync(evidenceDir);
    writeEvidence(manifest, evidenceDir);

    const evidence = validatePromotionEvidence(evidenceDir, {
      arm: "candidate",
      candidateVersionRef: VERSION_REF,
      workspaceTree: tree,
      harnessRoot: repo,
    });

    assert.equal(evidence.harness.binding, "clean-git-tree");
    assert.equal(evidence.harness.gitSha, sha);
    assert.equal(evidence.workspaceTree, tree);
  });

  it("rejects dirty legacy evidence without an explicit version/tree binding", () => {
    const manifest = completedManifest({
      explicitBinding: false,
      harnessGit: { sha: "d".repeat(40), dirty: true },
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /allow-unevidenced/i,
    );
  });

  it("rejects an unresolvable clean legacy harness without an explicit binding", () => {
    const manifest = completedManifest({
      explicitBinding: false,
      harnessGit: { sha: "d".repeat(40), dirty: false },
    });

    expectEvidenceError(
      () => validate(writeEvidence(manifest)),
      /cannot be resolved.*allow-unevidenced/i,
    );
  });
});
