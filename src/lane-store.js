// Operational channel and lane storage.
//
// Channels are compare-and-swap pointers to immutable, content-addressed
// version records. A lane pins one channel version, owns one private workspace,
// and advances through a single-writer, hash-chained journal. Rewinding never
// mutates history: it creates a new lane from a historical event.

import fs from "node:fs";
import path from "node:path";
import { BlobStore, LaneJournal, LaneLease, RefStore } from "./journal.js";
import { WorkspaceStore } from "./workspace-store.js";

const CHANNEL_NAMES = new Set(["regular", "dev"]);
const CHANNEL_EVENT_KIND = "bantam.channel-event";
const RUN_CURSOR_KIND = "bantam.run-cursor";
const RUN_CURSOR_DELTA_KIND = "bantam.run-cursor-delta";
const RUN_EVIDENCE_FIELDS = ["turns", "rejectedOutputs", "modelCalls", "events"];

export class LaneStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.worktreesRoot = path.join(this.root, "worktrees");
    this.blobs = new BlobStore(path.join(this.root, "blobs"));
    this.refs = new RefStore(this.root);
    this.workspaces = new WorkspaceStore(this.root);
  }

  initChannel(name, version) {
    const channel = validateChannel(name);
    const versionRef = this.resolveVersion(version, null);
    const eventRef = this.putChannelEvent({
      channel,
      parentEventRef: null,
      type: "channel.initialized",
      previousVersionRef: null,
      versionRef,
      metadata: {},
    });
    this.refs.init("channels", channel, channelRef(channel, eventRef, versionRef));
    return this.readChannel(channel);
  }

  advanceChannel(name, expectedVersionRef, version, {
    operation = "channel.checkpointed",
    metadata = {},
  } = {}) {
    const channel = validateChannel(name);
    const current = this.refs.read("channels", channel);
    if (!current) throw new Error(`channel does not exist: ${channel}`);
    const expected = String(expectedVersionRef ?? "");
    if (current.versionRef !== expected) {
      throw new Error(
        `stale channel ref ${channel}: expected ${expected || "null"}, found ${current.versionRef}`,
      );
    }
    const versionRef = this.resolveVersion(version, current.versionRef);
    const eventRef = this.putChannelEvent({
      channel,
      parentEventRef: current.schema === 2 ? current.eventId : null,
      type: validateChannelEventType(operation),
      previousVersionRef: current.versionRef,
      versionRef,
      metadata,
    });
    this.refs.compareAndSwap(
      "channels",
      channel,
      current.eventId,
      channelRef(channel, eventRef, versionRef),
    );
    return this.readChannel(channel);
  }

  rollbackChannel(name, expectedVersionRef, targetVersionRef, metadata = {}) {
    const channel = validateChannel(name);
    const current = this.requireChannel(channel);
    const expected = String(expectedVersionRef ?? "");
    const target = String(targetVersionRef ?? "");
    if (current.versionRef !== expected) {
      throw new Error(
        `stale channel ref ${channel}: expected ${expected || "null"}, found ${current.versionRef}`,
      );
    }
    if (target === current.versionRef) {
      throw new Error(`rollback target is already current: ${channel}/${target}`);
    }
    this.readVersion(target);
    if (!this.channelHasVersion(channel, target)) {
      throw new Error(`rollback target is not in ${channel} history: ${target}`);
    }
    return this.advanceChannel(channel, expected, target, {
      operation: "channel.rolled_back",
      metadata,
    });
  }

  readChannel(name) {
    const channel = validateChannel(name);
    const ref = this.refs.read("channels", channel);
    if (!ref) return null;
    const legacy = ref.schema === 1 && ref.eventId === ref.versionRef;
    if (ref.channel !== channel || (!legacy && ref.schema !== 2)) {
      throw new Error(`corrupt channel ref: ${channel}`);
    }
    if (!legacy) {
      const event = this.readChannelEvent(ref.eventId, channel);
      if (event.versionRef !== ref.versionRef) throw new Error(`corrupt channel ref: ${channel}`);
    }
    return {
      name: channel,
      eventRef: legacy ? null : ref.eventId,
      versionRef: ref.versionRef,
      version: this.readVersion(ref.versionRef),
    };
  }

  readChannelEvent(eventRef, expectedChannel = null) {
    const event = this.blobs.getJson(eventRef);
    if (
      event?.schema !== 1
      || event?.kind !== CHANNEL_EVENT_KIND
      || typeof event.channel !== "string"
      || (expectedChannel !== null && event.channel !== expectedChannel)
      || (event.parentEventRef !== null && !isBlobRef(event.parentEventRef))
      || !isBlobRef(event.versionRef)
      || (event.previousVersionRef !== null && !isBlobRef(event.previousVersionRef))
      || typeof event.type !== "string"
      || typeof event.time !== "string"
    ) {
      throw new Error(`invalid channel event: ${eventRef}`);
    }
    this.readVersion(event.versionRef);
    if (event.previousVersionRef !== null) this.readVersion(event.previousVersionRef);
    return event;
  }

  channelHistory(name) {
    const channel = validateChannel(name);
    const ref = this.refs.read("channels", channel);
    if (!ref) throw new Error(`channel does not exist: ${channel}`);
    if (ref.channel !== channel) throw new Error(`corrupt channel ref: ${channel}`);
    if (ref.schema === 1 && ref.eventId === ref.versionRef) {
      this.readVersion(ref.versionRef);
      return [legacyChannelHistoryRow(channel, ref.versionRef)];
    }
    if (ref.schema !== 2 || ref.channel !== channel) throw new Error(`corrupt channel ref: ${channel}`);

    const newestFirst = [];
    const seen = new Set();
    let eventRef = ref.eventId;
    let expectedVersionRef = ref.versionRef;
    while (eventRef !== null) {
      if (seen.has(eventRef)) throw new Error(`channel event cycle: ${channel}/${eventRef}`);
      seen.add(eventRef);
      const event = this.readChannelEvent(eventRef, channel);
      if (event.versionRef !== expectedVersionRef) {
        throw new Error(`channel history transition mismatch: ${channel}/${eventRef}`);
      }
      newestFirst.push({ eventRef, ...event });
      expectedVersionRef = event.previousVersionRef;
      eventRef = event.parentEventRef;
    }
    if (expectedVersionRef !== null) {
      newestFirst.push(legacyChannelHistoryRow(channel, expectedVersionRef));
    }
    return newestFirst.reverse();
  }

  channelHasVersion(name, versionRef) {
    const target = String(versionRef ?? "");
    return this.channelHistory(name).some((event) => (
      event.versionRef === target || event.previousVersionRef === target
    ));
  }

  readVersion(versionRef) {
    const version = this.blobs.getJson(versionRef);
    if (version?.schema !== 1 || version?.kind !== "bantam.channel-version") {
      throw new Error(`invalid channel version: ${versionRef}`);
    }
    return version;
  }

  putVersion(value, { parentVersionRef = null } = {}) {
    if (parentVersionRef !== null) this.readVersion(parentVersionRef);
    return this.blobs.putJson(immutableVersion(parentVersionRef, value));
  }

  listChannels() {
    return listRefNames(this.root, "channels")
      .map((name) => this.readChannel(name))
      .filter(Boolean);
  }

  materializeHarnessVersion(versionRef, destination) {
    const ref = String(versionRef ?? "");
    const target = path.resolve(String(destination ?? ""));
    if (!destination) throw new Error("materialize destination is required");
    const version = this.readVersion(ref);
    const harness = validateHarnessVersion(version.value, ref);
    if (!this.workspaces.hasCommit(harness.workspaceCommit)) {
      throw new Error(`harness workspace checkpoint is missing: ${harness.workspaceCommit}`);
    }
    const storedTree = this.workspaces.treeOf(harness.workspaceCommit);
    if (storedTree !== harness.workspaceTree) {
      throw new Error(
        `harness workspace tree mismatch: expected ${harness.workspaceTree}, found ${storedTree}`,
      );
    }
    rejectSymlinkDestination(target, "materialize destination");
    this.assertOutsideManagedWorkspaces(target);
    const restored = this.workspaces.materialize(harness.workspaceCommit, target);
    if (restored.tree !== harness.workspaceTree) throw new Error(`materialized harness tree mismatch: ${ref}`);
    return { ...restored, versionRef: ref };
  }

  materializeChannel(name, destination, {
    versionRef = null,
    expectedVersionRef = null,
  } = {}) {
    const channel = this.requireChannel(name);
    if (expectedVersionRef !== null && channel.versionRef !== expectedVersionRef) {
      throw new Error(
        `stale channel ref ${channel.name}: expected ${expectedVersionRef}, found ${channel.versionRef}`,
      );
    }
    const selected = versionRef ?? channel.versionRef;
    if (!this.channelHasVersion(channel.name, selected)) {
      throw new Error(`version is not in ${channel.name} history: ${selected}`);
    }
    return {
      ...this.materializeHarnessVersion(selected, destination),
      channel: channel.name,
    };
  }

  putChannelEvent({
    channel,
    parentEventRef,
    type,
    previousVersionRef,
    versionRef,
    metadata,
  }) {
    return this.blobs.putJson({
      schema: 1,
      kind: CHANNEL_EVENT_KIND,
      channel: validateChannel(channel),
      parentEventRef,
      type: validateChannelEventType(type),
      time: new Date().toISOString(),
      previousVersionRef,
      versionRef,
      metadata: copyJson(metadata, "channel event metadata"),
    });
  }

  createLane({ laneId, channel, sourceWorkspace, controllerState = {}, metadata = {} }) {
    const id = validateId(laneId, "lane");
    const source = requireDirectory(sourceWorkspace, "source workspace");
    const pinned = this.requireChannel(channel);
    const state = copyJson(controllerState, "controller state");
    const meta = copyJson(metadata, "lane metadata");
    const destination = this.privateWorkspacePath(id);

    this.assertLaneAvailable(id, destination);
    assertNonOverlapping(source, destination, "source and lane workspace");

    return this.withNewLaneLease(id, () => {
      const checkpoint = this.workspaces.capture(source, {
        message: `BANTAM lane ${id} created from source workspace`,
      });
      this.workspaces.materialize(checkpoint.commit, destination);
      return this._publishCreatedLane({
        id,
        pinned,
        destination,
        checkpoint,
        controllerState: state,
        metadata: meta,
      });
    });
  }

  /**
   * Create a lane whose initial workspace is the exact immutable harness
   * version currently selected by `channel`.
   *
   * Unlike createLane(), this path deliberately has no source-workspace input:
   * callers cannot accidentally pin one harness while seeding arbitrary bytes.
   */
  createLaneFromChannel(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("channel lane options must be an object");
    }
    if (Object.prototype.hasOwnProperty.call(options, "sourceWorkspace")) {
      throw new Error("createLaneFromChannel does not accept sourceWorkspace");
    }
    const {
      laneId,
      channel,
      controllerState = {},
      metadata = {},
    } = options;
    const id = validateId(laneId, "lane");
    const pinned = this.requireChannel(channel);
    const harness = validateHarnessVersion(pinned.version.value, pinned.versionRef);
    const state = copyJson(controllerState, "controller state");
    const meta = copyJson(metadata, "lane metadata");
    const destination = this.privateWorkspacePath(id);

    this.assertLaneAvailable(id, destination);

    return this.withNewLaneLease(id, () => {
      try {
        const restored = this.materializeHarnessVersion(pinned.versionRef, destination);
        if (
          restored.commit !== harness.workspaceCommit
          || restored.tree !== harness.workspaceTree
        ) {
          throw new Error(
            `materialized channel harness does not match pinned version: ${pinned.versionRef}`,
          );
        }
        return this._publishCreatedLane({
          id,
          pinned,
          destination,
          checkpoint: {
            commit: restored.commit,
            tree: restored.tree,
          },
          controllerState: state,
          metadata: meta,
        });
      } catch (error) {
        this._cleanupUnpublishedLane(id, destination);
        throw error;
      }
    });
  }

  acquireLane(laneId, {
    expectedEventId = undefined,
    metadata = {},
    allowWorkspaceDrift = false,
  } = {}) {
    const id = validateId(laneId, "lane");
    const lease = new LaneLease({ root: this.root, laneId: id });
    lease.acquire({ metadata: copyJson(metadata, "lease metadata") });
    try {
      const current = this.readLaneHead(id);
      if (expectedEventId !== undefined && current.ref.eventId !== expectedEventId) {
        throw new Error(
          `stale lane writer ${id}: expected ${expectedEventId}, found ${current.ref.eventId}`,
        );
      }
      const liveWorkspace = this.workspaces.treeForWorkspace(current.ref.workspacePath, {
        baselineCommit: current.ref.workspaceCommit,
      });
      const workspaceDrift = liveWorkspace.tree !== current.ref.workspaceTree;
      if (workspaceDrift && !allowWorkspaceDrift) {
        throw new Error(
          `lane workspace diverged from published head: ${id}; explicit allowWorkspaceDrift is required to adopt it`,
        );
      }
      return new LaneWriter(this, current, lease, {
        acquiredWorkspaceTree: liveWorkspace.tree,
        workspaceDrift,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  inspect(laneId, eventId = null) {
    const id = validateId(laneId, "lane");
    const head = this.readLaneHead(id);
    const event = eventId === null ? head.event : head.journal.at(String(eventId));
    if (!event) throw new Error(`lane event does not exist: ${id}/${eventId}`);
    const snapshot = eventSnapshot(event, id);
    if (!this.workspaces.hasCommit(snapshot.workspaceCommit)) {
      throw new Error(`workspace checkpoint is missing: ${snapshot.workspaceCommit}`);
    }
    return {
      laneId: id,
      eventId: event.id,
      event,
      workspacePath: head.ref.workspacePath,
      workspaceCommit: snapshot.workspaceCommit,
      workspaceTree: snapshot.workspaceTree,
      controllerStateRef: snapshot.controllerStateRef,
      controllerState: this.readControllerState(snapshot.controllerStateRef),
      channel: snapshot.channel,
      channelVersionRef: snapshot.channelVersionRef,
      channelVersion: this.readVersion(snapshot.channelVersionRef),
      ancestry: snapshot.ancestry,
    };
  }

  // Run cursors are append-heavy and may contain large exact requests. Schema
  // 2 stores only the new evidence rows at each checkpoint, linked to the
  // prior controller blob. Callers keep seeing the schema-1 full cursor shape;
  // legacy full-state blobs remain valid chain anchors.
  readControllerState(controllerStateRef) {
    const deltas = [];
    const seen = new Set();
    let ref = String(controllerStateRef ?? "");
    let state;
    while (true) {
      if (seen.has(ref)) throw new Error(`controller state delta cycle: ${ref}`);
      seen.add(ref);
      const value = this.blobs.getJson(ref);
      if (value?.schema !== 2 || value?.kind !== RUN_CURSOR_DELTA_KIND) {
        state = value;
        break;
      }
      validateRunCursorDelta(value, ref);
      deltas.push(value);
      ref = value.previousControllerStateRef;
    }
    for (let index = deltas.length - 1; index >= 0; index--) {
      state = applyRunCursorDelta(state, deltas[index]);
    }
    return state;
  }

  materialize(laneId, eventId, destination) {
    const snapshot = this.inspect(laneId, eventId);
    const target = path.resolve(String(destination ?? ""));
    if (!destination) throw new Error("materialize destination is required");
    rejectSymlinkDestination(target, "materialize destination");
    this.assertOutsideManagedWorkspaces(target);
    return {
      ...this.workspaces.materialize(snapshot.workspaceCommit, target),
      laneId: snapshot.laneId,
      eventId: snapshot.eventId,
      controllerStateRef: snapshot.controllerStateRef,
    };
  }

  forkLane({ fromLaneId, eventId, laneId, channel = null, metadata = {} }) {
    const sourceId = validateId(fromLaneId, "source lane");
    const id = validateId(laneId, "lane");
    if (sourceId === id) throw new Error("rewind must fork to a new lane id");
    const source = this.inspect(sourceId, eventId);
    const destination = this.privateWorkspacePath(id);
    const pinned = channel === null
      ? { name: source.channel, versionRef: source.channelVersionRef }
      : this.requireChannel(channel);
    const meta = copyJson(metadata, "fork metadata");

    this.assertLaneAvailable(id, destination);
    return this.withNewLaneLease(id, () => {
      this.workspaces.materialize(source.workspaceCommit, destination);
      const journal = new LaneJournal({ root: this.root, laneId: id });
      const ancestry = {
        parentLaneId: sourceId,
        parentEventId: source.eventId,
        parentAncestry: source.ancestry,
      };
      const event = journal.append("lane.forked", {
        channel: pinned.name,
        channelVersionRef: pinned.versionRef,
        workspaceCommit: source.workspaceCommit,
        workspaceTree: source.workspaceTree,
        controllerStateRef: source.controllerStateRef,
        ancestry,
        metadata: meta,
      });
      this.refs.init("lanes", id, laneRef({
        laneId: id,
        event,
        workspacePath: destination,
        channel: pinned.name,
        channelVersionRef: pinned.versionRef,
        workspaceCommit: source.workspaceCommit,
        workspaceTree: source.workspaceTree,
        controllerStateRef: source.controllerStateRef,
      }));
      return this.inspect(id, event.id);
    });
  }

  status(laneId) {
    const id = validateId(laneId, "lane");
    const head = this.readLaneHead(id);
    const snapshot = eventSnapshot(head.event, id);
    return {
      laneId: id,
      eventId: head.event.id,
      sequence: head.event.seq,
      eventType: head.event.type,
      journalEvents: head.journal.count(),
      channel: snapshot.channel,
      channelVersionRef: snapshot.channelVersionRef,
      workspacePath: head.ref.workspacePath,
      workspaceCommit: snapshot.workspaceCommit,
      workspaceTree: snapshot.workspaceTree,
      controllerStateRef: snapshot.controllerStateRef,
      leased: fs.existsSync(path.join(this.root, "locks", `${id}.lock`)),
      ancestry: snapshot.ancestry,
    };
  }

  listLanes() {
    return listRefNames(this.root, "lanes").map((laneId) => this.status(laneId));
  }

  privateWorkspacePath(laneId) {
    return path.join(this.worktreesRoot, validateId(laneId, "lane"));
  }

  _publishCreatedLane({
    id,
    pinned,
    destination,
    checkpoint,
    controllerState,
    metadata,
  }) {
    const stateRef = this.blobs.putJson(controllerState);
    const journal = new LaneJournal({ root: this.root, laneId: id });
    const event = journal.append("lane.created", {
      channel: pinned.name,
      channelVersionRef: pinned.versionRef,
      workspaceCommit: checkpoint.commit,
      workspaceTree: checkpoint.tree,
      controllerStateRef: stateRef,
      ancestry: null,
      metadata,
    });
    this.refs.init("lanes", id, laneRef({
      laneId: id,
      event,
      workspacePath: destination,
      channel: pinned.name,
      channelVersionRef: pinned.versionRef,
      workspaceCommit: checkpoint.commit,
      workspaceTree: checkpoint.tree,
      controllerStateRef: stateRef,
    }));
    return this.inspect(id, event.id);
  }

  _cleanupUnpublishedLane(laneId, destination) {
    if (this.refs.read("lanes", laneId)) return;
    fs.rmSync(destination, { recursive: true, force: true });
    fs.rmSync(
      path.join(this.root, "journal", "lanes", `${laneId}.jsonl`),
      { force: true },
    );
  }

  _checkpoint(writer, controllerState, metadata) {
    writer.assertActive();
    const state = copyJson(controllerState, "controller state");
    const meta = copyJson(metadata, "checkpoint metadata");
    const current = this.readLaneHead(writer.laneId);
    if (current.ref.eventId !== writer.expectedEventId) {
      throw new Error(
        `stale lane writer ${writer.laneId}: expected ${writer.expectedEventId}, found ${current.ref.eventId}`,
      );
    }
    if (current.ref.workspacePath !== writer.workspacePath) {
      throw new Error(`lane workspace changed while leased: ${writer.laneId}`);
    }
    requireDirectory(writer.workspacePath, "lane workspace");

    const checkpoint = this.workspaces.capture(writer.workspacePath, {
      parent: current.ref.workspaceCommit,
      message: `BANTAM lane ${writer.laneId} checkpoint`,
    });
    const stateRef = this.blobs.putJson(state);
    const journal = new LaneJournal({ root: this.root, laneId: writer.laneId });
    const event = journal.append("lane.checkpointed", {
      channel: current.ref.channel,
      channelVersionRef: current.ref.channelVersionRef,
      workspaceCommit: checkpoint.commit,
      workspaceTree: checkpoint.tree,
      controllerStateRef: stateRef,
      ancestry: current.event.payload.ancestry ?? null,
      previousEventId: current.event.id,
      previousWorkspaceCommit: current.ref.workspaceCommit,
      adoptedWorkspaceDrift: writer.workspaceDrift ? {
        publishedTree: current.ref.workspaceTree,
        acquiredTree: writer.acquiredWorkspaceTree,
      } : null,
      metadata: meta,
    }, { parent: current.event.id });
    this.refs.compareAndSwap(
      "lanes",
      writer.laneId,
      writer.expectedEventId,
      laneRef({
        laneId: writer.laneId,
        event,
        workspacePath: writer.workspacePath,
        channel: current.ref.channel,
        channelVersionRef: current.ref.channelVersionRef,
        workspaceCommit: checkpoint.commit,
        workspaceTree: checkpoint.tree,
        controllerStateRef: stateRef,
      }),
    );
    writer.expectedEventId = event.id;
    writer.acquiredWorkspaceTree = checkpoint.tree;
    writer.workspaceDrift = false;
    return this.inspect(writer.laneId, event.id);
  }

  requireChannel(name) {
    const channel = this.readChannel(name);
    if (!channel) throw new Error(`channel does not exist: ${name}`);
    return channel;
  }

  resolveVersion(valueOrRef, parentVersionRef) {
    if (typeof valueOrRef === "string" && /^sha256:[a-f0-9]{64}$/.test(valueOrRef)) {
      this.readVersion(valueOrRef);
      return valueOrRef;
    }
    return this.putVersion(valueOrRef, { parentVersionRef });
  }

  readLaneHead(laneId) {
    const ref = this.refs.read("lanes", laneId);
    if (!ref) throw new Error(`lane does not exist: ${laneId}`);
    const expectedPath = this.privateWorkspacePath(laneId);
    if (ref.schema !== 1 || ref.laneId !== laneId || ref.workspacePath !== expectedPath) {
      throw new Error(`corrupt lane ref: ${laneId}`);
    }
    const journal = new LaneJournal({ root: this.root, laneId });
    const event = journal.at(ref.eventId);
    if (!event) throw new Error(`lane ref points outside its journal: ${laneId}`);
    const snapshot = eventSnapshot(event, laneId);
    if (
      snapshot.workspaceCommit !== ref.workspaceCommit
      || snapshot.workspaceTree !== ref.workspaceTree
      || snapshot.controllerStateRef !== ref.controllerStateRef
      || snapshot.channel !== ref.channel
      || snapshot.channelVersionRef !== ref.channelVersionRef
    ) {
      throw new Error(`lane ref disagrees with journal: ${laneId}`);
    }
    return { ref, journal, event };
  }

  assertLaneAvailable(laneId, destination) {
    if (this.refs.read("lanes", laneId)) throw new Error(`lane already exists: ${laneId}`);
    const journalPath = new LaneJournal({ root: this.root, laneId }).path;
    if (fs.existsSync(journalPath)) throw new Error(`lane journal already exists: ${laneId}`);
    for (const status of this.listLanes()) {
      assertNonOverlapping(destination, status.workspacePath, "lane workspaces");
    }
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`lane workspace is not a private directory: ${destination}`);
      }
      if (fs.readdirSync(destination).length > 0) {
        throw new Error(`lane workspace is not empty: ${destination}`);
      }
    }
  }

  assertOutsideManagedWorkspaces(destination) {
    for (const lane of this.listLanes()) {
      assertNonOverlapping(destination, lane.workspacePath, "materialize destination and lane workspace");
    }
  }

  withNewLaneLease(laneId, fn) {
    const lease = new LaneLease({ root: this.root, laneId });
    lease.acquire({ operation: "create" });
    try { return fn(); }
    finally { lease.release(); }
  }
}

export class LaneWriter {
  constructor(store, current, lease, { acquiredWorkspaceTree, workspaceDrift }) {
    this.store = store;
    this.laneId = current.ref.laneId;
    this.workspacePath = current.ref.workspacePath;
    this.expectedEventId = current.ref.eventId;
    this.acquiredWorkspaceTree = acquiredWorkspaceTree;
    this.workspaceDrift = workspaceDrift;
    this.lease = lease;
    this.active = true;
  }

  checkpoint(controllerState, metadata = {}) {
    return this.store._checkpoint(this, controllerState, metadata);
  }

  status() {
    this.assertActive();
    return this.store.status(this.laneId);
  }

  close() {
    if (!this.active) return false;
    this.active = false;
    return this.lease.release();
  }

  assertActive() {
    if (!this.active || !this.lease.owned) throw new Error(`lane writer is closed: ${this.laneId}`);
  }
}

function immutableVersion(parentVersionRef, value) {
  return {
    schema: 1,
    kind: "bantam.channel-version",
    parentVersionRef,
    value: copyJson(value, "channel version"),
  };
}

function channelRef(channel, eventRef, versionRef) {
  return {
    schema: 2,
    channel,
    eventId: eventRef,
    versionRef,
  };
}

function legacyChannelHistoryRow(channel, versionRef) {
  return {
    eventRef: null,
    schema: 0,
    kind: CHANNEL_EVENT_KIND,
    channel,
    parentEventRef: null,
    type: "channel.legacy",
    time: null,
    previousVersionRef: null,
    versionRef,
    metadata: {},
  };
}

function validateHarnessVersion(value, versionRef) {
  if (
    value?.kind !== "bantam.harness-workspace"
    || typeof value.workspaceCommit !== "string"
    || !/^[a-f0-9]{40,64}$/.test(value.workspaceCommit)
    || typeof value.workspaceTree !== "string"
    || !/^[a-f0-9]{40,64}$/.test(value.workspaceTree)
  ) {
    throw new Error(`channel version is not a harness workspace: ${versionRef}`);
  }
  return value;
}

function validateChannelEventType(value) {
  const type = String(value ?? "");
  if (!/^channel\.[a-z][a-z_]*$/.test(type)) throw new Error(`invalid channel event type: ${type}`);
  return type;
}

function isBlobRef(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value ?? ""));
}

function laneRef({
  laneId,
  event,
  workspacePath,
  channel,
  channelVersionRef,
  workspaceCommit,
  workspaceTree,
  controllerStateRef,
}) {
  return {
    schema: 1,
    laneId,
    eventId: event.id,
    workspacePath,
    channel,
    channelVersionRef,
    workspaceCommit,
    workspaceTree,
    controllerStateRef,
  };
}

function eventSnapshot(event, laneId) {
  const payload = event?.payload;
  if (
    !payload
    || typeof payload.channel !== "string"
    || typeof payload.channelVersionRef !== "string"
    || typeof payload.workspaceCommit !== "string"
    || typeof payload.workspaceTree !== "string"
    || typeof payload.controllerStateRef !== "string"
  ) {
    throw new Error(`lane event has no valid snapshot: ${laneId}/${event?.id ?? "unknown"}`);
  }
  return {
    channel: payload.channel,
    channelVersionRef: payload.channelVersionRef,
    workspaceCommit: payload.workspaceCommit,
    workspaceTree: payload.workspaceTree,
    controllerStateRef: payload.controllerStateRef,
    ancestry: payload.ancestry ?? null,
  };
}

function copyJson(value, label) {
  validateJson(value, label, new Set());
  return JSON.parse(JSON.stringify(value));
}

function validateRunCursorDelta(delta, ref) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(delta.previousControllerStateRef ?? ""))) {
    throw new Error(`invalid controller state delta parent: ${ref}`);
  }
  if (typeof delta.reset !== "boolean") {
    throw new Error(`invalid controller state delta reset flag: ${ref}`);
  }
  if (!delta.cursor || delta.cursor.schema !== 1 || delta.cursor.kind !== RUN_CURSOR_KIND) {
    throw new Error(`invalid controller state delta cursor: ${ref}`);
  }
  if (!delta.evidence || !delta.counts) {
    throw new Error(`invalid controller state delta evidence: ${ref}`);
  }
  for (const field of RUN_EVIDENCE_FIELDS) {
    if (!Array.isArray(delta.evidence[field])) {
      throw new Error(`invalid controller state delta ${field}: ${ref}`);
    }
    if (!Number.isInteger(delta.counts[field]) || delta.counts[field] < 0) {
      throw new Error(`invalid controller state delta ${field} count: ${ref}`);
    }
  }
}

function applyRunCursorDelta(previous, delta) {
  const base = delta.reset ? {} : previous;
  if (!delta.reset && base?.kind !== RUN_CURSOR_KIND) {
    throw new Error("controller state delta parent is not a run cursor");
  }
  const merged = { ...delta.cursor };
  for (const field of RUN_EVIDENCE_FIELDS) {
    const priorRows = base?.[field] ?? [];
    if (!Array.isArray(priorRows)) {
      throw new Error(`controller state delta parent has invalid ${field}`);
    }
    merged[field] = [...priorRows, ...delta.evidence[field]];
    if (merged[field].length !== delta.counts[field]) {
      throw new Error(`controller state delta ${field} count mismatch`);
    }
  }
  if (merged.turnCount !== merged.turns.length) {
    throw new Error("controller state delta turn count mismatch");
  }
  return merged;
}

function validateJson(value, label, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} must be JSON serializable`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain only JSON objects and arrays`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, label, ancestors);
  } else {
    for (const item of Object.values(value)) validateJson(item, label, ancestors);
  }
  ancestors.delete(value);
}

function requireDirectory(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const resolved = path.resolve(String(value));
  let stat;
  try { stat = fs.statSync(resolved); }
  catch { throw new Error(`${label} does not exist: ${resolved}`); }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function assertNonOverlapping(first, second, label) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
    throw new Error(`${label} must not overlap: ${a} and ${b}`);
  }
}

function rejectSymlinkDestination(destination, label) {
  if (!fs.existsSync(destination)) return;
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${destination}`);
}

function listRefNames(root, kind) {
  const directory = path.join(root, "refs", kind);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

function validateChannel(value) {
  const channel = String(value ?? "");
  if (!CHANNEL_NAMES.has(channel)) throw new Error(`invalid channel: ${channel}`);
  return channel;
}

function validateId(value, label) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid ${label} id: ${id}`);
  return id;
}
