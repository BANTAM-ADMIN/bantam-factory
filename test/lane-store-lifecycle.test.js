import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { LaneStore } from "../src/lane-store.js";

const temporary = new Set();

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(directory);
  return directory;
}

function write(root, relative, contents, mode = null) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
  if (mode !== null) fs.chmodSync(destination, mode);
  return destination;
}

function harnessVersion(checkpoint) {
  return {
    kind: "bantam.harness-workspace",
    workspaceCommit: checkpoint.commit,
    workspaceTree: checkpoint.tree,
    files: checkpoint.files,
  };
}

function fixture() {
  const root = tempDir("bantam-lane-lifecycle-");
  const harness = path.join(root, "harness");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(harness);
  write(harness, "package.json", '{"name":"lane-fixture","type":"module"}\n');
  write(harness, "bin/bantam.js", "export const revision = 'pinned';\n", 0o755);
  write(harness, "src/value.js", "export const value = 'channel';\n");

  const store = new LaneStore(stateHome);
  const checkpoint = store.workspaces.capture(harness, {
    message: "lane lifecycle harness",
  });
  const versionRef = store.putVersion(harnessVersion(checkpoint));
  store.initChannel("dev", versionRef);
  return { root, harness, stateHome, store, checkpoint, versionRef };
}

afterEach(() => {
  for (const directory of temporary) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporary.clear();
});

describe("LaneStore exact channel lane lifecycle", () => {
  it("seeds the private lane with the pinned harness commit, tree, modes, and bytes", () => {
    const state = fixture();
    const lane = state.store.createLaneFromChannel({
      laneId: "exact-seed",
      channel: "dev",
      controllerState: { phase: "seeded" },
      metadata: { reason: "lifecycle-test" },
    });

    assert.equal(lane.channel, "dev");
    assert.equal(lane.channelVersionRef, state.versionRef);
    assert.equal(lane.workspaceCommit, state.checkpoint.commit);
    assert.equal(lane.workspaceTree, state.checkpoint.tree);
    assert.deepEqual(lane.controllerState, { phase: "seeded" });
    assert.equal(lane.workspacePath, state.store.privateWorkspacePath("exact-seed"));
    assert.notEqual(lane.workspacePath, state.harness);
    assert.equal(
      path.relative(state.store.worktreesRoot, lane.workspacePath),
      "exact-seed",
    );
    assert.equal(
      fs.readFileSync(path.join(lane.workspacePath, "src/value.js"), "utf8"),
      "export const value = 'channel';\n",
    );
    assert.notEqual(
      fs.statSync(path.join(lane.workspacePath, "bin/bantam.js")).mode & 0o111,
      0,
    );
    assert.equal(fs.existsSync(path.join(lane.workspacePath, ".git")), false);
    assert.equal(
      state.store.workspaces.treeForWorkspace(lane.workspacePath, {
        baselineCommit: lane.workspaceCommit,
      }).tree,
      state.checkpoint.tree,
    );
    assert.equal(state.store.status(lane.laneId).leased, false);
  });

  it("keeps arbitrary-source lanes distinct and refuses a source on the exact-channel API", () => {
    const state = fixture();
    const other = path.join(state.root, "other-source");
    fs.mkdirSync(other);
    write(other, "package.json", '{"name":"other","type":"module"}\n');
    write(other, "src/value.js", "export const value = 'arbitrary';\n");

    const arbitrary = state.store.createLane({
      laneId: "arbitrary-seed",
      channel: "dev",
      sourceWorkspace: other,
    });
    assert.equal(arbitrary.channelVersionRef, state.versionRef);
    assert.notEqual(arbitrary.workspaceTree, state.checkpoint.tree);
    assert.equal(
      fs.readFileSync(path.join(arbitrary.workspacePath, "src/value.js"), "utf8"),
      "export const value = 'arbitrary';\n",
    );

    assert.throws(
      () => state.store.createLaneFromChannel({
        laneId: "exact-after-rejection",
        channel: "dev",
        sourceWorkspace: other,
      }),
      /does not accept sourceWorkspace/,
    );
    const exact = state.store.createLaneFromChannel({
      laneId: "exact-after-rejection",
      channel: "dev",
    });
    assert.equal(exact.workspaceTree, state.checkpoint.tree);
    assert.equal(
      fs.readFileSync(path.join(exact.workspacePath, "src/value.js"), "utf8"),
      "export const value = 'channel';\n",
    );
  });

  it("keeps the original immutable pin when the channel advances", () => {
    const state = fixture();
    const lane = state.store.createLaneFromChannel({
      laneId: "immutable-pin",
      channel: "dev",
    });

    write(state.harness, "src/value.js", "export const value = 'new-dev';\n");
    const nextCheckpoint = state.store.workspaces.capture(state.harness, {
      message: "advanced dev harness",
    });
    const next = state.store.advanceChannel(
      "dev",
      state.versionRef,
      harnessVersion(nextCheckpoint),
    );

    assert.notEqual(next.versionRef, state.versionRef);
    const pinned = state.store.inspect(lane.laneId);
    assert.equal(pinned.channelVersionRef, state.versionRef);
    assert.equal(pinned.workspaceCommit, state.checkpoint.commit);
    assert.equal(pinned.workspaceTree, state.checkpoint.tree);
    assert.equal(
      fs.readFileSync(path.join(pinned.workspacePath, "src/value.js"), "utf8"),
      "export const value = 'channel';\n",
    );
  });

  it("supports one leased writer, immutable checkpoints, and clean lease release", () => {
    const state = fixture();
    const lane = state.store.createLaneFromChannel({
      laneId: "checkpointed",
      channel: "dev",
      controllerState: { phase: "ready" },
    });
    const writer = state.store.acquireLane(lane.laneId, {
      expectedEventId: lane.eventId,
      metadata: { purpose: "lifecycle-test" },
    });

    assert.equal(state.store.status(lane.laneId).leased, true);
    assert.throws(
      () => state.store.acquireLane(lane.laneId),
      /already leased/,
    );

    write(lane.workspacePath, "src/value.js", "export const value = 'implemented';\n");
    const next = writer.checkpoint(
      { phase: "implemented" },
      { source: "lifecycle-test" },
    );

    assert.notEqual(next.eventId, lane.eventId);
    assert.notEqual(next.workspaceCommit, lane.workspaceCommit);
    assert.notEqual(next.workspaceTree, lane.workspaceTree);
    assert.equal(next.channelVersionRef, state.versionRef);
    assert.deepEqual(next.controllerState, { phase: "implemented" });
    assert.equal(state.store.inspect(lane.laneId, lane.eventId).workspaceTree, lane.workspaceTree);
    assert.equal(writer.close(), true);
    assert.equal(writer.close(), false);
    assert.equal(state.store.status(lane.laneId).leased, false);

    assert.throws(
      () => state.store.acquireLane(lane.laneId, {
        expectedEventId: lane.eventId,
      }),
      /stale lane writer/,
    );
    assert.equal(state.store.status(lane.laneId).leased, false);
    const resumed = state.store.acquireLane(lane.laneId, {
      expectedEventId: next.eventId,
    });
    assert.equal(resumed.close(), true);
  });

  it("removes a materialized workspace, journal, and lease when publication fails", (t) => {
    const state = fixture();
    const laneId = "failed-publication";
    const destination = state.store.privateWorkspacePath(laneId);
    const journal = path.join(
      state.stateHome,
      "journal",
      "lanes",
      `${laneId}.jsonl`,
    );
    const lock = path.join(state.stateHome, "locks", `${laneId}.lock`);

    t.mock.method(state.store.refs, "init", (kind) => {
      if (kind === "lanes") throw new Error("injected lane ref failure");
      throw new Error(`unexpected ref kind: ${kind}`);
    });

    assert.throws(
      () => state.store.createLaneFromChannel({ laneId, channel: "dev" }),
      /injected lane ref failure/,
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(state.store.refs.read("lanes", laneId), null);
  });
});
