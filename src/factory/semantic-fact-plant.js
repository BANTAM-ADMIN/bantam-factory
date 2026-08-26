import crypto from "node:crypto";
import path from "node:path";
import { Datalog } from "../logic/datalog.js";
import { createCodeFactIndex, materializeCodeFacts } from "../logic/codefacts.js";

const ID = /^[a-z][a-z0-9_]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EFFECT_LANES = Object.freeze([
  "filesystem_write",
  "process_execution",
  "persistent_state_mutation",
]);

/**
 * Compile a DiffusionGemma semantic evidence kit into a transient, provenanced
 * Datalog view. Model output remains an observation. Only caller-supplied,
 * independently governed accepted facts enter accepted_lane.
 */
export function buildSemanticFactPlant({ kit, workspaceRoot = null, accepted = [] } = {}) {
  const normalized = normalizeKit(kit);
  const db = new Datalog({ provenance: true });
  let codeStats = null;
  if (workspaceRoot) {
    const index = createCodeFactIndex(path.resolve(workspaceRoot));
    codeStats = materializeCodeFacts(db, index);
  }

  const chunkByLocation = new Map();
  for (const chunk of normalized.chunks) {
    const chunkId = contentId(chunk);
    const key = locationKey(chunk);
    chunkByLocation.set(key, { ...chunk, chunkId });
    db.fact("source_chunk", chunkId);
    db.fact("chunk_file", chunkId, chunk.path);
    db.fact("chunk_span", chunkId, chunk.startLine, chunk.endLine);
    db.fact("chunk_hash", chunkId, chunk.sha256);
    db.fact("observed_in_kit", chunkId, normalized.kitRef);
    for (const [lane, present] of Object.entries(chunk.lanes)) {
      if (present) db.fact("semantic_observation", chunkId, lane, normalized.kitRef);
    }
  }

  const acceptedFacts = accepted.map((fact, index) => normalizeAccepted(fact, index, chunkByLocation));
  for (const fact of acceptedFacts) {
    db.fact("accepted_lane", fact.chunkId, fact.lane, fact.evidenceRef);
  }

  db.rule("file_observed_lane(F, L) :- chunk_file(C, F), semantic_observation(C, L, K)");
  db.rule("file_accepted_lane(F, L) :- chunk_file(C, F), accepted_lane(C, L, E)");
  db.rule("corroborated_lane(C, L) :- semantic_observation(C, L, K), accepted_lane(C, L, E)");
  db.rule("file_corroborated_lane(F, L) :- chunk_file(C, F), corroborated_lane(C, L)");
  for (const lane of EFFECT_LANES) db.rule(`effect_chunk(C) :- semantic_observation(C, ${lane}, K)`);
  db.rule("effect_file(F) :- chunk_file(C, F), effect_chunk(C)");
  db.rule("authority_file(F) :- file_observed_lane(F, authority_gate)");
  db.rule("release_file(F) :- file_observed_lane(F, release_or_promotion)");
  db.rule("recovery_file(F) :- file_observed_lane(F, rollback_or_recovery)");
  if (workspaceRoot) {
    db.rule("semantic_impact(Consumer, Source, Lane) :- reaches(Consumer, Source), file_observed_lane(Source, Lane)");
    db.rule("corroborated_impact(Consumer, Source, Lane) :- reaches(Consumer, Source), file_corroborated_lane(Source, Lane)");
  }
  db.run();

  const effectFiles = unarySet(db.query("effect_file", "?"));
  const authorityFiles = unarySet(db.query("authority_file", "?"));
  const releaseFiles = unarySet(db.query("release_file", "?"));
  const recoveryFiles = unarySet(db.query("recovery_file", "?"));
  const candidateGaps = {
    effectWithoutSameFileAuthorityObservation: difference(effectFiles, authorityFiles),
    releaseWithoutSameFileRecoveryObservation: difference(releaseFiles, recoveryFiles),
  };

  return {
    db,
    kitRef: normalized.kitRef,
    chunks: [...chunkByLocation.values()],
    acceptedFacts,
    codeStats,
    summary: {
      chunks: normalized.chunks.length,
      semanticObservations: db.count("semantic_observation"),
      acceptedLanes: db.count("accepted_lane"),
      corroboratedLanes: db.count("corroborated_lane"),
      observedFiles: db.count("file_observed_lane"),
      effectFiles: effectFiles.size,
      authorityFiles: authorityFiles.size,
      releaseFiles: releaseFiles.size,
      recoveryFiles: recoveryFiles.size,
      semanticImpacts: db.count("semantic_impact"),
      corroboratedImpacts: db.count("corroborated_impact"),
      facts: db.totalFacts(),
      datalog: { ...db.stats },
    },
    candidateGaps,
  };
}

/** Explicit governed promotion into BANTAM's durable FactLog. */
export function promoteAcceptedSemanticFacts(log, plant, { src = "factory-semantic-gauge" } = {}) {
  if (!log || typeof log.assert !== "function" || typeof log.view !== "function") {
    throw new TypeError("a BANTAM FactLog is required");
  }
  if (!plant || !Array.isArray(plant.acceptedFacts)) throw new TypeError("a semantic fact plant is required");
  const view = log.view();
  const appended = [];
  for (const fact of plant.acceptedFacts) {
    const args = [fact.chunkId, fact.lane, fact.path, fact.startLine, fact.endLine, fact.evidenceRef];
    if (view.has("accepted_semantic_lane", ...args)) continue;
    appended.push(log.assert("accepted_semantic_lane", args, { src, kind: "accepted" }));
  }
  return appended;
}

function normalizeKit(kit) {
  if (!kit || typeof kit !== "object" || (!Array.isArray(kit.classified) && !Array.isArray(kit.selected))) {
    throw new TypeError("semantic kit classified or selected array is required");
  }
  if (kit.fixture?.die !== "matrix") throw new TypeError("semantic kit must use the matrix die");
  const lanes = kit.fixture?.rubric?.lanes;
  if (!Array.isArray(lanes) || lanes.length < 2) throw new TypeError("semantic kit rubric lanes are required");
  const laneKeys = lanes.map((lane) => lane?.key);
  if (laneKeys.some((lane) => typeof lane !== "string" || !ID.test(lane)) || new Set(laneKeys).size !== laneKeys.length) {
    throw new TypeError("semantic kit lane keys must be unique identifiers");
  }
  const articles = Array.isArray(kit.classified) ? kit.classified : kit.selected;
  const chunks = articles.map((chunk, index) => normalizeChunk(chunk, index, laneKeys));
  const fingerprint = typeof kit.sourceFingerprint === "string" ? kit.sourceFingerprint : "unknown-source";
  return {
    chunks,
    // A semantic kit is content, not an event. Excluding completion time means
    // identical model output compiles to the same identity across reruns.
    kitRef: `semantic-kit:sha256:${crypto.createHash("sha256").update(`${fingerprint}\n${JSON.stringify(laneKeys)}\n${JSON.stringify(chunks)}`).digest("hex")}`,
  };
}

function normalizeChunk(chunk, index, laneKeys) {
  if (!chunk || typeof chunk !== "object") throw new TypeError(`semantic chunk ${index} must be an object`);
  const normalized = {
    path: requireText(chunk.path, `semantic chunk ${index} path`).replace(/\\/g, "/"),
    startLine: requirePositiveInteger(chunk.startLine, `semantic chunk ${index} startLine`),
    endLine: requirePositiveInteger(chunk.endLine, `semantic chunk ${index} endLine`),
    sha256: requireText(chunk.sha256, `semantic chunk ${index} sha256`),
    lanes: {},
  };
  if (normalized.endLine < normalized.startLine) throw new RangeError(`semantic chunk ${index} line range is reversed`);
  if (!SHA256.test(normalized.sha256)) throw new TypeError(`semantic chunk ${index} sha256 is invalid`);
  if (!chunk.lanes || typeof chunk.lanes !== "object" || Array.isArray(chunk.lanes)) {
    throw new TypeError(`semantic chunk ${index} lanes are required`);
  }
  if (Object.keys(chunk.lanes).sort().join("\0") !== [...laneKeys].sort().join("\0")) {
    throw new TypeError(`semantic chunk ${index} lane schema does not match the rubric`);
  }
  for (const lane of laneKeys) {
    if (typeof chunk.lanes[lane] !== "boolean") throw new TypeError(`semantic chunk ${index} lane ${lane} must be boolean`);
    normalized.lanes[lane] = chunk.lanes[lane];
  }
  return normalized;
}

function normalizeAccepted(fact, index, chunkByLocation) {
  if (!fact || typeof fact !== "object") throw new TypeError(`accepted semantic fact ${index} must be an object`);
  const probe = {
    path: requireText(fact.path, `accepted semantic fact ${index} path`).replace(/\\/g, "/"),
    startLine: requirePositiveInteger(fact.startLine, `accepted semantic fact ${index} startLine`),
    endLine: requirePositiveInteger(fact.endLine, `accepted semantic fact ${index} endLine`),
  };
  const chunk = chunkByLocation.get(locationKey(probe));
  if (!chunk) throw new RangeError(`accepted semantic fact ${index} does not address an issued chunk`);
  const lane = requireText(fact.lane, `accepted semantic fact ${index} lane`);
  if (!(lane in chunk.lanes)) throw new RangeError(`accepted semantic fact ${index} lane is not in the rubric`);
  return {
    chunkId: chunk.chunkId,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    lane,
    evidenceRef: requireText(fact.evidenceRef, `accepted semantic fact ${index} evidenceRef`),
  };
}

function contentId(chunk) {
  return `chunk:sha256:${crypto.createHash("sha256").update(`${chunk.path}\n${chunk.startLine}\n${chunk.endLine}\n${chunk.sha256}`).digest("hex")}`;
}

function locationKey(chunk) { return `${chunk.path}\0${chunk.startLine}\0${chunk.endLine}`; }
function unarySet(rows) { return new Set(rows.map((row) => row[0])); }
function difference(left, right) { return [...left].filter((value) => !right.has(value)).sort(); }
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}
