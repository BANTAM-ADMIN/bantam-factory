import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createExperimentManifest,
  summarizeExperiment,
} from "../src/experiment.js";
import { LaneStore } from "../src/lane-store.js";
import { runStateCommand } from "../src/state-cli.js";

const temporary = new Set();

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(dir);
  return dir;
}

function invoke(cwd, stateHome, args) {
  let stdout = "";
  let stderr = "";
  const code = runStateCommand(
    [...args, "--state-home", stateHome, "--json"],
    {
      cwd,
      env: {},
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    },
  );
  assert.equal(typeof code?.then, "undefined", "test only invokes synchronous state commands");
  return {
    code,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : null,
  };
}

function promotionManifest(versionRef, workspaceTree) {
  const spec = {
    schema: 1,
    name: "state-promotion",
    fixtures: ["fixture-a"],
    rounds: 1,
    seeds: [17],
    arms: [
      { name: "baseline" },
      { name: "candidate" },
    ],
  };
  const manifest = createExperimentManifest({ spec, id: "state-promotion-evidence" });
  for (const entry of manifest.schedule) {
    entry.status = "complete";
    entry.completedAt = new Date().toISOString();
    entry.durationMs = 1;
    entry.runs = [{ name: "fixture-a", status: "pass", durationMs: 1 }];
  }
  manifest.status = "complete";
  manifest.completedAt = new Date().toISOString();
  manifest.totals = summarizeExperiment(manifest);
  manifest.candidateArm = "candidate";
  manifest.candidateVersionRef = versionRef;
  manifest.workspaceTree = workspaceTree;
  return manifest;
}

function writeEvidence(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "spec.json"), `${JSON.stringify(manifest.spec, null, 2)}\n`);
}

function initializedState() {
  const root = tempDir("bantam-state-promotion-");
  const source = path.join(root, "source");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "harness.js"), "export const revision = 1;\n");
  const initialized = invoke(root, stateHome, ["state", "init", "--source", source]);
  assert.equal(initialized.code, 0, initialized.stderr);

  fs.writeFileSync(path.join(source, "harness.js"), "export const revision = 2;\n");
  const devBefore = new LaneStore(stateHome).readChannel("dev");
  const checkpoint = invoke(root, stateHome, [
    "channel", "checkpoint", "dev",
    "--source", source,
    "--expected", devBefore.versionRef,
  ]);
  assert.equal(checkpoint.code, 0, checkpoint.stderr);
  return { root, source, stateHome, store: new LaneStore(stateHome) };
}

afterEach(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

describe("state channel promotion evidence", () => {
  it("records evidence digest and the exact promoted source version/tree", () => {
    const { root, stateHome, store } = initializedState();
    const dev = store.readChannel("dev");
    const evidenceDir = path.join(root, "evidence");
    writeEvidence(
      evidenceDir,
      promotionManifest(dev.versionRef, dev.version.value.workspaceTree),
    );

    const promoted = invoke(root, stateHome, [
      "channel", "promote",
      "--from", "dev",
      "--to", "regular",
      "--evidence", evidenceDir,
      "--arm", "candidate",
    ]);

    assert.equal(promoted.code, 0, promoted.stderr);
    assert.equal(promoted.json.versionRef, dev.versionRef);
    assert.equal(promoted.json.evidence.candidateVersionRef, dev.versionRef);
    assert.equal(promoted.json.evidence.workspaceTree, dev.version.value.workspaceTree);
    const event = new LaneStore(stateHome).channelHistory("regular").at(-1);
    assert.equal(event.metadata.sourceChannel, "dev");
    assert.equal(event.metadata.sourceVersionRef, dev.versionRef);
    assert.equal(event.metadata.sourceWorkspaceCommit, dev.version.value.workspaceCommit);
    assert.equal(event.metadata.sourceWorkspaceTree, dev.version.value.workspaceTree);
    assert.equal(event.metadata.evidenceManifestSha256, promoted.json.evidence.manifestSha256);
  });

  it("keeps --allow-unevidenced as an explicit audited escape hatch", () => {
    const { root, stateHome, store } = initializedState();
    const dev = store.readChannel("dev");

    const promoted = invoke(root, stateHome, [
      "channel", "promote",
      "--from", "dev",
      "--to", "regular",
      "--allow-unevidenced",
    ]);

    assert.equal(promoted.code, 0, promoted.stderr);
    const event = new LaneStore(stateHome).channelHistory("regular").at(-1);
    assert.equal(event.metadata.unevidenced, true);
    assert.equal(event.metadata.sourceVersionRef, dev.versionRef);
    assert.equal(event.metadata.sourceWorkspaceTree, dev.version.value.workspaceTree);
    assert.equal(event.metadata.evidence, undefined);
  });

  it("rejects pinned evidence whose workspace commit differs from the dev version", () => {
    const { root, stateHome, store } = initializedState();
    const dev = store.readChannel("dev");
    const regularBefore = store.readChannel("regular");
    const manifest = promotionManifest(dev.versionRef, dev.version.value.workspaceTree);
    delete manifest.candidateVersionRef;
    delete manifest.workspaceTree;
    manifest.promotion = {
      schema: 1,
      kind: "bantam.pinned-experiment-binding",
      source: "verified-channel-launch",
      channel: "dev",
      laneId: "experiment-lane",
      candidateVersionRef: dev.versionRef,
      workspaceCommit: "f".repeat(40),
      workspaceTree: dev.version.value.workspaceTree,
    };
    const evidenceDir = path.join(root, "wrong-commit-evidence");
    writeEvidence(evidenceDir, manifest);

    const promoted = invoke(root, stateHome, [
      "channel", "promote",
      "--from", "dev",
      "--to", "regular",
      "--evidence", evidenceDir,
      "--arm", "candidate",
    ]);

    assert.equal(promoted.code, 2);
    assert.match(promoted.stderr, /workspace commit.*does not match promoted commit/i);
    assert.equal(new LaneStore(stateHome).readChannel("regular").versionRef, regularBefore.versionRef);
  });

  it("refuses evidence for a different dev version without moving regular", () => {
    const { root, stateHome, store } = initializedState();
    const dev = store.readChannel("dev");
    const regularBefore = store.readChannel("regular").versionRef;
    const evidenceDir = path.join(root, "wrong-evidence");
    writeEvidence(
      evidenceDir,
      promotionManifest(`sha256:${"f".repeat(64)}`, dev.version.value.workspaceTree),
    );

    const rejected = invoke(root, stateHome, [
      "channel", "promote",
      "--evidence", evidenceDir,
      "--arm", "candidate",
    ]);

    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /does not match promoted version/i);
    assert.equal(new LaneStore(stateHome).readChannel("regular").versionRef, regularBefore);
  });
});
