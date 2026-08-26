import fs from "node:fs";
import path from "node:path";
import {
  buildExperimentSchedule,
  hashJson,
  normalizeExperimentPromotionBinding,
  normalizeExperimentSpec,
} from "./experiment.js";

export function prepareExperimentResume({
  destination,
  spec,
  fixtures,
  harnessGit,
  promotionBinding = null,
  invocation,
  resumedAt,
}) {
  const manifestPath = path.join(destination, "manifest.json");
  const specPath = path.join(destination, "spec.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(specPath)) {
    throw new Error(`resume directory is missing manifest.json or spec.json: ${destination}`);
  }

  let manifest;
  let storedSpec;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    storedSpec = normalizeExperimentSpec(JSON.parse(fs.readFileSync(specPath, "utf8")));
  } catch (error) {
    throw new Error(`cannot read experiment resume state: ${error.message}`);
  }
  validateManifestIdentity(manifest, spec, storedSpec, harnessGit, promotionBinding);
  validateSchedule(manifest, spec);

  const historyEntry = {
    resumedAt,
    previousStatus: manifest.status,
    previousOutputDir: manifest.outputDir ?? null,
    invocation,
    entries: manifest.schedule.map((entry) => ({
      sequence: entry.sequence,
      status: entry.status,
      completedRuns: (entry.runs ?? []).filter((row) => row.status !== "error").length,
      durationMs: entry.durationMs ?? null,
      priorDurationMs: entry.priorDurationMs ?? 0,
      inFlight: entry.inFlight ?? null,
    })),
  };
  const ledgerArtifactPaths = loadLedgerArtifactPaths(path.join(destination, "ledger.jsonl"));

  for (const entry of manifest.schedule) {
    prepareScheduleEntry({ entry, fixtures, destination, manifest, ledgerArtifactPaths, resumedAt });
  }

  manifest.resumeHistory = Array.isArray(manifest.resumeHistory) ? manifest.resumeHistory : [];
  manifest.resumeHistory.push(historyEntry);
  manifest.outputDir = destination;
  manifest.status = "running";
  manifest.completedAt = null;
  manifest.error = null;
  return manifest;
}

function validateManifestIdentity(manifest, spec, storedSpec, harnessGit, promotionBinding) {
  if (manifest?.kind !== "bantam-experiment" || manifest.schema !== 1) {
    throw new Error("resume manifest is not a supported Bantam experiment");
  }
  if (["complete", "complete_with_failures"].includes(manifest.status)) {
    throw new Error(`experiment is already complete (${manifest.status})`);
  }
  if (manifest.status === "stopped") {
    throw new Error("experiment stopped by policy and cannot be resumed");
  }
  if (!["running", "failed"].includes(manifest.status)) {
    throw new Error(`experiment status cannot be resumed: ${manifest.status}`);
  }
  const expectedHash = hashJson(normalizeExperimentSpec(spec));
  let manifestHash = null;
  try { manifestHash = hashJson(normalizeExperimentSpec(manifest.spec)); } catch { /* manifest.spec may be missing */ }
  if (expectedHash !== manifest.specSha256
      || hashJson(storedSpec) !== manifest.specSha256
      || manifestHash !== manifest.specSha256) {
    throw new Error("resume spec does not match the persisted experiment");
  }
  const pinned = assertSamePromotionBinding(manifest.promotion ?? null, promotionBinding);
  if (!pinned) assertSameHarnessSnapshot(manifest.harnessGit, harnessGit);
}

function assertSamePromotionBinding(stored, current) {
  if (stored === null && current === null) return false;
  if (stored === null || current === null) {
    throw new Error("resume requires the same pinned harness binding as the original experiment");
  }
  let normalizedStored;
  let normalizedCurrent;
  try {
    normalizedStored = normalizeExperimentPromotionBinding(stored);
    normalizedCurrent = normalizeExperimentPromotionBinding(current);
  } catch (error) {
    throw new Error(`resume has an invalid pinned harness binding: ${error.message}`);
  }
  if (JSON.stringify(normalizedStored) !== JSON.stringify(normalizedCurrent)) {
    throw new Error("resume pinned harness binding does not match the original experiment");
  }
  return true;
}

function validateSchedule(manifest, spec) {
  const expectedSchedule = buildExperimentSchedule(spec);
  if (!Array.isArray(manifest.schedule) || manifest.schedule.length !== expectedSchedule.length) {
    throw new Error("resume manifest schedule does not match the experiment spec");
  }
  for (let index = 0; index < expectedSchedule.length; index++) {
    const actual = manifest.schedule[index];
    const expected = expectedSchedule[index];
    if (actual.sequence !== expected.sequence || actual.round !== expected.round
        || actual.arm !== expected.arm || actual.seed !== expected.seed) {
      throw new Error(`resume manifest schedule entry ${index} does not match the experiment spec`);
    }
  }
}

function prepareScheduleEntry({ entry, fixtures, destination, manifest, ledgerArtifactPaths, resumedAt }) {
  const rows = Array.isArray(entry.runs) ? entry.runs : [];
  const firstError = rows.findIndex((row) => row.status === "error");
  if (firstError !== -1 && rows.slice(firstError).some((row) => row.status !== "error")) {
    throw new Error(`resume entry ${entry.sequence} has completed evidence after an error row`);
  }
  const retained = rows.filter((row) => row.status !== "error");
  if (retained.length > fixtures.length) throw new Error(`resume entry ${entry.sequence} has too many fixture rows`);
  for (let index = 0; index < retained.length; index++) {
    validateRetainedRow({
      row: retained[index],
      fixture: fixtures[index],
      destination,
      manifest,
      entry,
      ledgerArtifactPaths,
    });
  }

  entry.interruptedRuns = Array.isArray(entry.interruptedRuns) ? entry.interruptedRuns : [];
  if (entry.inFlight) {
    const interruptedArtifact = resolveEvidencePath(destination, entry.inFlight.artifactPath);
    entry.interruptedRuns.push({
      ...entry.inFlight,
      recoveredAt: resumedAt,
      artifactPresent: fs.existsSync(interruptedArtifact),
    });
  }
  entry.runs = retained;
  entry.inFlight = null;
  entry.error = null;
  if (retained.length === fixtures.length) {
    entry.status = "complete";
    return;
  }
  entry.priorDurationMs = (entry.priorDurationMs ?? 0) + (entry.durationMs ?? 0);
  entry.status = "pending";
  entry.startedAt = null;
  entry.completedAt = null;
  entry.durationMs = null;
  entry.modelId = null;
  entry.effectiveModel = null;
}

function validateRetainedRow({ row, fixture, destination, manifest, entry, ledgerArtifactPaths }) {
  if (row.name !== fixture.name) {
    throw new Error(`resume entry ${entry.sequence} fixture order does not match the spec`);
  }
  const artifactPath = resolveEvidencePath(destination, row.artifactPath);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error(`resume evidence is missing for ${row.name}: ${row.artifactPath}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read retained artifact ${row.artifactPath}: ${error.message}`);
  }
  const matches = artifact.partial !== true
    && artifact.fixture === row.name
    && artifact.experiment?.id === manifest.id
    && artifact.experiment?.arm === entry.arm
    && artifact.experiment?.round === entry.round
    && artifact.result?.status === row.status;
  if (!matches) throw new Error(`resume artifact provenance does not match ${row.artifactPath}`);
  if (!ledgerArtifactPaths.has(row.artifactPath)) {
    throw new Error(`resume ledger link is missing for ${row.name}: ${row.artifactPath}`);
  }
}

export function assertSameHarnessSnapshot(stored, current) {
  if (!stored?.sha || !current?.sha || stored.sha !== current.sha) {
    throw new Error("resume harness revision does not match the original experiment");
  }
  if (Boolean(stored.dirty) !== Boolean(current.dirty)) {
    throw new Error("resume harness cleanliness does not match the original experiment");
  }
  if (!stored.dirty) return;

  // A dirty harness is safe to resume only as an immutable snapshot. dirtyHash
  // already binds the complete status, worktree/staged diffs, and content hashes
  // for every untracked file. Require the component hashes too so older or
  // partially populated manifests fail closed rather than receiving weaker
  // provenance than a new experiment.
  const fields = [
    "dirtyHash",
    "statusSha256",
    "worktreeDiffSha256",
    "stagedDiffSha256",
    "untrackedSha256",
  ];
  if (fields.some((field) => !stored[field] || !current[field])) {
    throw new Error("resume dirty harness snapshot lacks complete integrity fingerprints");
  }
  if (fields.some((field) => stored[field] !== current[field])) {
    throw new Error("resume dirty harness snapshot does not match the original experiment");
  }
}

function resolveEvidencePath(root, artifactPath) {
  if (typeof artifactPath !== "string" || !artifactPath) throw new Error("resume row has no artifact path");
  const full = path.resolve(root, artifactPath);
  if (full === root || !full.startsWith(root + path.sep)) {
    throw new Error(`resume artifact path escapes the evidence directory: ${artifactPath}`);
  }
  return full;
}

function loadLedgerArtifactPaths(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return new Set();
  const paths = new Set();
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      const row = JSON.parse(lines[index]);
      if (typeof row.artifactPath === "string") paths.add(row.artifactPath);
    } catch (error) {
      throw new Error(`resume ledger has invalid JSON on line ${index + 1}: ${error.message}`);
    }
  }
  return paths;
}
