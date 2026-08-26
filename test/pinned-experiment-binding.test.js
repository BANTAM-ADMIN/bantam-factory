import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createExperimentManifest } from "../src/experiment.js";
import { LaneStore } from "../src/lane-store.js";
import {
  createPinnedLaunchAttestation,
  readPinnedExperimentBinding,
  verifyPinnedExperimentBinding,
} from "../src/pinned-experiment-binding.js";
import { runStateCommand } from "../src/state-cli.js";

const temporary = new Set();

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(dir);
  return dir;
}

function pinnedState({ launchStub = false } = {}) {
  const root = tempDir("bantam-pinned-experiment-");
  const harness = path.join(root, "harness");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(path.join(harness, "bin"), { recursive: true });
  fs.writeFileSync(path.join(harness, "package.json"), JSON.stringify({
    name: "pinned-test-harness",
    version: "1.0.0",
    type: "module",
  }));
  fs.writeFileSync(
    path.join(harness, "bin", "bantam.js"),
    launchStub
      ? [
        'import fs from "node:fs";',
        "const fd = Number(process.env.BANTAM_PINNED_BINDING_FD);",
        'const attestation = JSON.parse(fs.readFileSync(fd, "utf8"));',
        "fs.writeFileSync(process.env.BANTAM_TEST_LAUNCH_OUTPUT, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  depth: process.env.BANTAM_CHANNEL_LAUNCH_DEPTH,",
        "  attestation,",
        "}));",
        "",
      ].join("\n")
      : "export const pinned = true;\n",
  );

  const store = new LaneStore(stateHome);
  const checkpoint = store.workspaces.capture(harness, {
    message: "pinned experiment test harness",
  });
  const versionRef = store.putVersion({
    kind: "bantam.harness-workspace",
    workspaceCommit: checkpoint.commit,
    workspaceTree: checkpoint.tree,
    files: checkpoint.files,
  });
  store.initChannel("dev", versionRef);
  store.initChannel("regular", versionRef);
  const lane = store.createLane({
    laneId: "experiment-lane",
    channel: "dev",
    sourceWorkspace: harness,
  });
  const runningHarness = path.join(root, "running-harness");
  store.materializeHarnessVersion(versionRef, runningHarness);
  const attestation = createPinnedLaunchAttestation({
    channel: "dev",
    laneId: lane.laneId,
    stateHome,
    harnessRoot: runningHarness,
  });
  return {
    root,
    harness,
    stateHome,
    store,
    versionRef,
    checkpoint,
    lane,
    runningHarness,
    attestation,
  };
}

afterEach(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

describe("pinned experiment binding", () => {
  it("resolves the version from state and re-hashes the executing harness", () => {
    const state = pinnedState();

    const binding = verifyPinnedExperimentBinding(state.attestation, {
      harnessRoot: state.runningHarness,
    });
    const manifest = createExperimentManifest({
      spec: {
        schema: 1,
        name: "pinned",
        fixtures: ["fixture-a"],
        rounds: 1,
        seeds: [17],
        arms: [{ name: "baseline" }, { name: "candidate" }],
      },
      promotionBinding: binding,
    });

    assert.equal(binding.channel, "dev");
    assert.equal(binding.candidateVersionRef, state.versionRef);
    assert.equal(binding.workspaceCommit, state.checkpoint.commit);
    assert.equal(binding.workspaceTree, state.checkpoint.tree);
    assert.deepEqual(manifest.promotion, binding);
  });

  it("refuses an asserted binding when the running harness bytes differ", () => {
    const state = pinnedState();
    fs.writeFileSync(path.join(state.runningHarness, "bin", "bantam.js"), "export const pinned = false;\n");

    assert.throws(
      () => verifyPinnedExperimentBinding(state.attestation, {
        harnessRoot: state.runningHarness,
      }),
      /executing harness bytes do not match pinned dev tree/i,
    );
  });

  it("excludes the launcher's separately verified dependency attachment from the harness tree", () => {
    const state = pinnedState();
    const dependencies = path.join(state.root, "dependencies");
    fs.mkdirSync(dependencies);
    fs.symlinkSync(dependencies, path.join(state.runningHarness, "node_modules"), "dir");

    const binding = verifyPinnedExperimentBinding(state.attestation, {
      harnessRoot: state.runningHarness,
    });

    assert.equal(binding.workspaceTree, state.checkpoint.tree);
  });

  it("does not stamp a direct experiment without a launcher descriptor", () => {
    assert.equal(readPinnedExperimentBinding({
      env: {},
      harnessRoot: process.cwd(),
    }), null);
  });

  it("reads launcher provenance from an inherited descriptor and verifies it", () => {
    const state = pinnedState();
    const file = path.join(state.root, "attestation.json");
    fs.writeFileSync(file, JSON.stringify(state.attestation));
    const descriptor = fs.openSync(file, "r");
    try {
      const binding = readPinnedExperimentBinding({
        env: {
          BANTAM_CHANNEL_LAUNCH_DEPTH: "1",
          BANTAM_PINNED_BINDING_FD: String(descriptor),
        },
        harnessRoot: state.runningHarness,
      });
      assert.equal(binding.candidateVersionRef, state.versionRef);
      assert.equal(binding.workspaceTree, state.checkpoint.tree);
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it("routes channel experiment through the pinned CLI with a private attestation", async () => {
    const state = pinnedState({ launchStub: true });
    const output = path.join(state.root, "launch.json");
    let stderr = "";
    const code = await runStateCommand([
      "channel", "experiment", "dev",
      "--lane", state.lane.laneId,
      "--expected", state.versionRef,
      "--state-home", state.stateHome,
      "--",
      "spec.json",
    ], {
      cwd: state.root,
      env: {
        PATH: process.env.PATH,
        BANTAM_TEST_LAUNCH_OUTPUT: output,
      },
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    });

    assert.equal(code, 0, stderr);
    const launched = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(launched.argv, [
      "experiment",
      "--lane", state.lane.laneId,
      "--state-home", state.stateHome,
      "spec.json",
    ]);
    assert.equal(launched.depth, "1");
    assert.equal(launched.attestation.kind, "bantam.pinned-channel-launch");
    assert.equal(launched.attestation.channel, "dev");
    assert.equal(launched.attestation.laneId, state.lane.laneId);
    assert.equal(
      Object.prototype.hasOwnProperty.call(launched.attestation, "candidateVersionRef"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(launched.attestation, "workspaceTree"),
      false,
    );
  });
});
