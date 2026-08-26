import crypto from "node:crypto";
import { Datalog } from "../logic/datalog.js";
import { buildSemanticFactPlant } from "./semantic-fact-plant.js";

const ARTIFACT_SCHEMA = "bantam.factory.semantic-object.v1";
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Ahead-of-time compile semantic model output and deterministic workspace facts
 * into one immutable, content-addressed, already-evaluated object.
 */
export function compileSemanticObject({ kit, workspaceRoot = null, accepted = [], compiledAt = new Date().toISOString() } = {}) {
  const plant = buildSemanticFactPlant({ kit, workspaceRoot, accepted });
  const sourceUnits = plant.chunks.map((chunk) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    sha256: chunk.sha256,
    chunkId: chunk.chunkId,
  })).sort(compareUnits);
  const datalog = plant.db.snapshot();
  // Runtime belongs to telemetry, not semantic identity. Including a 0 ms vs
  // 1 ms scheduler observation made byte-identical fixpoints hash differently.
  datalog.stats.ms = 0;
  const compileSummary = structuredClone(plant.summary);
  if (compileSummary.datalog) compileSummary.datalog.ms = 0;
  const body = {
    schema: ARTIFACT_SCHEMA,
    compiler: "bantam-semantic-aot-v1",
    kitRef: plant.kitRef,
    sourceFingerprint: typeof kit?.sourceFingerprint === "string" ? kit.sourceFingerprint : "unknown-source",
    rubric: (kit?.fixture?.rubric?.lanes ?? []).map((lane) => ({ key: lane.key, description: lane.description ?? "" })),
    sourceUnits,
    acceptedFacts: plant.acceptedFacts.map((fact) => ({ ...fact })).sort(compareAccepted),
    modelWork: normalizeModelWork(kit?.summary),
    compileSummary,
    datalog,
  };
  const artifactId = `semantic-object:sha256:${digest(body)}`;
  return {
    artifact: { ...body, artifactId, compiledAt },
    plant,
  };
}

/** Restore the persisted fixpoint. No rules execute and no model endpoint is touched. */
export function loadSemanticObject(artifact, { provenance = true } = {}) {
  validateSemanticObject(artifact);
  return Datalog.fromSnapshot(artifact.datalog, { provenance, installRules: false });
}

/**
 * Compare a new corpus manifest with the compiled semantic units. The returned
 * modelRequired count is the exact number of units that cannot reuse prior work.
 */
export function planSemanticRecompile(artifact, kit) {
  validateSemanticObject(artifact);
  const nextUnits = normalizeKitUnits(kit);
  const before = new Map(artifact.sourceUnits.map((unit) => [locationKey(unit), unit]));
  const after = new Map(nextUnits.map((unit) => [locationKey(unit), unit]));
  const reused = [];
  const changed = [];
  const added = [];
  const removed = [];
  for (const [location, unit] of after) {
    const previous = before.get(location);
    if (!previous) added.push(unit);
    else if (previous.sha256 === unit.sha256) reused.push(unit);
    else changed.push({ before: previous, after: unit });
  }
  for (const [location, unit] of before) if (!after.has(location)) removed.push(unit);
  reused.sort(compareUnits);
  added.sort(compareUnits);
  removed.sort(compareUnits);
  changed.sort((a, b) => compareUnits(a.after, b.after));
  return {
    previousUnits: before.size,
    nextUnits: after.size,
    reused: reused.length,
    changed: changed.length,
    added: added.length,
    removed: removed.length,
    modelRequired: changed.length + added.length,
    reusableFraction: after.size ? reused.length / after.size : 1,
    units: { reused, changed, added, removed },
  };
}

export function validateSemanticObject(artifact) {
  if (!artifact || artifact.schema !== ARTIFACT_SCHEMA) throw new TypeError(`${ARTIFACT_SCHEMA} object required`);
  if (!Array.isArray(artifact.sourceUnits) || !Array.isArray(artifact.acceptedFacts)) {
    throw new TypeError("semantic object sourceUnits and acceptedFacts arrays are required");
  }
  for (const unit of artifact.sourceUnits) validateUnit(unit);
  if (typeof artifact.artifactId !== "string") throw new TypeError("semantic object artifactId is required");
  const { artifactId, compiledAt: _compiledAt, ...body } = artifact;
  const expected = `semantic-object:sha256:${digest(body)}`;
  if (artifactId !== expected) throw new Error(`semantic object digest mismatch: expected ${expected}`);
  // Delegates the complete relation/proof shape validation to the engine without
  // retaining the temporary image.
  Datalog.fromSnapshot(artifact.datalog, { provenance: false });
  return true;
}

function normalizeKitUnits(kit) {
  const rows = Array.isArray(kit?.classified) ? kit.classified : kit?.selected;
  if (!Array.isArray(rows)) throw new TypeError("semantic kit classified or selected array is required");
  const seen = new Set();
  return rows.map((row) => {
    const unit = {
      path: requireText(row?.path, "semantic unit path").replace(/\\/g, "/"),
      startLine: positiveInteger(row?.startLine, "semantic unit startLine"),
      endLine: positiveInteger(row?.endLine, "semantic unit endLine"),
      sha256: requireText(row?.sha256, "semantic unit sha256"),
    };
    validateUnit(unit);
    const key = locationKey(unit);
    if (seen.has(key)) throw new TypeError(`duplicate semantic unit location: ${key}`);
    seen.add(key);
    return unit;
  });
}

function validateUnit(unit) {
  if (!unit || typeof unit.path !== "string" || !unit.path) throw new TypeError("semantic unit path is required");
  positiveInteger(unit.startLine, "semantic unit startLine");
  positiveInteger(unit.endLine, "semantic unit endLine");
  if (unit.endLine < unit.startLine) throw new RangeError("semantic unit line range is reversed");
  if (typeof unit.sha256 !== "string" || !SHA256.test(unit.sha256)) throw new TypeError("semantic unit sha256 is invalid");
}

function normalizeModelWork(summary) {
  const fields = ["elapsedMs", "promptTokens", "completionTokens", "lots", "parseFailures", "retries", "dieFailures"];
  return Object.fromEntries(fields.map((field) => [field, Number(summary?.[field] ?? 0)]));
}

function compareUnits(a, b) {
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine || a.sha256.localeCompare(b.sha256);
}
function compareAccepted(a, b) {
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine ||
    a.lane.localeCompare(b.lane) || a.evidenceRef.localeCompare(b.evidenceRef);
}
function locationKey(unit) { return `${unit.path}\u0000${unit.startLine}\u0000${unit.endLine}`; }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}
