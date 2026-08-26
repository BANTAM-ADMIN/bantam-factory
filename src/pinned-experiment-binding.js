// Promotion provenance for experiments launched through an immutable channel.
//
// The launcher passes only a state/lane identity over a private inherited file
// descriptor. The experiment process does not trust version or tree strings
// from the environment: it resolves them from the content-addressed state store
// and re-hashes the harness directory that contains its own CLI.

import fs from "node:fs";
import path from "node:path";
import { LaneStore } from "./lane-store.js";

export const PINNED_BINDING_FD_ENV = "BANTAM_PINNED_BINDING_FD";
export const PINNED_LAUNCH_KIND = "bantam.pinned-channel-launch";
export const EXPERIMENT_BINDING_KIND = "bantam.pinned-experiment-binding";

const LAUNCH_KEYS = new Set([
  "schema",
  "kind",
  "channel",
  "laneId",
  "stateHome",
  "harnessRoot",
]);

export function createPinnedLaunchAttestation({
  channel,
  laneId,
  stateHome,
  harnessRoot,
}) {
  return {
    schema: 1,
    kind: PINNED_LAUNCH_KIND,
    channel: requiredName(channel, "channel"),
    laneId: requiredName(laneId, "lane"),
    stateHome: path.resolve(requiredString(stateHome, "state home")),
    harnessRoot: path.resolve(requiredString(harnessRoot, "harness root")),
  };
}

export function readPinnedExperimentBinding({
  env = process.env,
  harnessRoot,
} = {}) {
  const descriptor = env?.[PINNED_BINDING_FD_ENV];
  if (descriptor === undefined) return null;
  if (env?.BANTAM_CHANNEL_LAUNCH_DEPTH !== "1") {
    throw new Error("pinned experiment binding requires a channel launcher");
  }
  if (!/^[0-9]+$/.test(String(descriptor)) || Number(descriptor) < 3) {
    throw new Error("pinned experiment binding descriptor is invalid");
  }

  let attestation;
  try {
    const raw = fs.readFileSync(Number(descriptor), "utf8");
    attestation = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot read pinned experiment binding: ${error.message}`);
  }
  return verifyPinnedExperimentBinding(attestation, { harnessRoot });
}

export function verifyPinnedExperimentBinding(attestation, {
  harnessRoot,
} = {}) {
  requireExactObject(attestation, LAUNCH_KEYS, "pinned channel attestation");
  if (attestation.schema !== 1 || attestation.kind !== PINNED_LAUNCH_KIND) {
    throw new Error("pinned channel attestation has an unsupported schema or kind");
  }
  const channel = requiredName(attestation.channel, "channel");
  const laneId = requiredName(attestation.laneId, "lane");
  const stateHome = requireRealDirectory(attestation.stateHome, "state home");
  const runningRoot = requireRealDirectory(harnessRoot, "running harness");
  const assertedRoot = requireRealDirectory(attestation.harnessRoot, "attested harness");
  if (runningRoot !== assertedRoot) {
    throw new Error(`pinned harness root mismatch: expected ${assertedRoot}, found ${runningRoot}`);
  }

  const store = new LaneStore(stateHome);
  const lane = store.status(laneId);
  if (lane.channel !== channel) {
    throw new Error(`pinned lane ${laneId} belongs to ${lane.channel}, not ${channel}`);
  }
  if (!store.channelHasVersion(channel, lane.channelVersionRef)) {
    throw new Error(`pinned lane version is not in ${channel} history: ${lane.channelVersionRef}`);
  }

  const version = store.readVersion(lane.channelVersionRef);
  const workspaceCommit = version?.value?.workspaceCommit;
  const workspaceTree = version?.value?.workspaceTree;
  if (
    version?.value?.kind !== "bantam.harness-workspace"
    || typeof workspaceCommit !== "string"
    || !/^[a-f0-9]{40,64}$/.test(workspaceCommit)
    || typeof workspaceTree !== "string"
    || !/^[a-f0-9]{40,64}$/.test(workspaceTree)
  ) {
    throw new Error(`pinned lane has no valid harness workspace: ${lane.channelVersionRef}`);
  }
  if (store.workspaces.treeOf(workspaceCommit) !== workspaceTree) {
    throw new Error(`stored pinned harness tree is corrupt: ${lane.channelVersionRef}`);
  }

  const actual = store.workspaces.treeForWorkspace(runningRoot, {
    baselineCommit: workspaceCommit,
    // The launcher may attach one separately verified dependency directory
    // after checking the immutable harness tree. It is runtime input, not part
    // of the captured harness workspace.
    excludePaths: [path.join(runningRoot, "node_modules")],
  });
  if (actual.tree !== workspaceTree) {
    throw new Error(
      `executing harness bytes do not match pinned ${channel} tree ${workspaceTree}`,
    );
  }

  return {
    schema: 1,
    kind: EXPERIMENT_BINDING_KIND,
    source: "verified-channel-launch",
    channel,
    laneId,
    candidateVersionRef: lane.channelVersionRef,
    workspaceCommit,
    workspaceTree,
  };
}

function requireExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
}

function requireRealDirectory(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error(`${label} does not exist: ${resolved}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function requiredName(value, label) {
  const name = requiredString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`invalid ${label}: ${name}`);
  return name;
}
