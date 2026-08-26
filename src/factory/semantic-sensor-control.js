import crypto from "node:crypto";

import { validateSemanticObject } from "./semantic-object.js";
import { FactFabric, canonicalEncode } from "./fact-fabric.js";
import { FactSourceRegistry, pullEntity } from "./fact-context.js";
import { FactDatalogBridge } from "./fact-datalog-bridge.js";

const RULE_ID = "rule:semantic-sensor-disagreement@1";
const POLICY_ID = "policy:compare-byte-identical-semantic-units@1";

/** Compare two immutable semantic sensors only where exact source units overlap. */
export function projectSemanticSensorDisagreement({ leftArtifact, rightArtifact } = {}) {
  const left = publishSensorMatrix(leftArtifact);
  const right = publishSensorMatrix(rightArtifact);
  const laneKeys = [...left.lanes].sort();
  if (laneKeys.join("\0") !== [...right.lanes].sort().join("\0")) {
    throw new Error("semantic sensor rubrics do not have the same lane keys");
  }
  const policy = new FactFabric();
  policy.transact(laneKeys.map((lane) => fact(lane, "sensor/compared-lane", true)), { src: POLICY_ID, kind: "reviewed-policy" });
  const sources = new FactSourceRegistry({ $left: left.fabric.view(), $right: right.fabric.view(), $policy: policy.view() });
  const logic = new FactDatalogBridge({ sources });
  for (const [source, prefix] of [["$left", "left"], ["$right", "right"]]) {
    logic.ingest({ source, relation: `${prefix}_source`, pattern: { a: "semantic/file" }, fields: ["e", "v"] });
    logic.ingest({ source, relation: `${prefix}_cell_chunk`, pattern: { a: "sensor/chunk" }, fields: ["e", "v"] });
    logic.ingest({ source, relation: `${prefix}_cell_lane`, pattern: { a: "sensor/lane" }, fields: ["e", "v"] });
    logic.ingest({ source, relation: `${prefix}_cell_present`, pattern: { a: "sensor/present" }, fields: ["e", "v"] });
  }
  logic.ingest({ source: "$policy", relation: "compared_lane", pattern: { a: "sensor/compared-lane" }, fields: ["e", "v"] });
  const yes = logic.literal(true), no = logic.literal(false);
  logic
    .rule(`semantic_sensor_disagreement(C,F,L,${yes},${no}) :- left_source(C,F), right_source(C,F), left_cell_chunk(S,C), right_cell_chunk(S,C), left_cell_lane(S,L), right_cell_lane(S,L), left_cell_present(S,${yes}), right_cell_present(S,${no}), compared_lane(L,${yes})`)
    .rule(`semantic_sensor_disagreement(C,F,L,${no},${yes}) :- left_source(C,F), right_source(C,F), left_cell_chunk(S,C), right_cell_chunk(S,C), left_cell_lane(S,L), right_cell_lane(S,L), left_cell_present(S,${no}), right_cell_present(S,${yes}), compared_lane(L,${yes})`)
    .run();
  const conclusions = logic.query("semantic_sensor_disagreement", "?chunk", "?file", "?lane", "?left", "?right");
  const derived = new FactFabric();
  const basis = { leftSemanticObjectId: leftArtifact.artifactId, rightSemanticObjectId: rightArtifact.artifactId, leftKitRef: leftArtifact.kitRef, rightKitRef: rightArtifact.kitRef };
  const rows = conclusions.map(([chunkId, file, lane, leftPresent, rightPresent]) => {
    const proof = logic.explain("semantic_sensor_disagreement", chunkId, file, lane, leftPresent, rightPresent);
    const exceptionId = `semantic-sensor-exception:sha256:${digest({ basis, chunkId, file, lane, leftPresent, rightPresent, proof })}`;
    return { exceptionId, chunkId, file, lane, leftPresent, rightPresent, code: "semantic-sensor-disagreement", severity: "warning", epistemicStatus: "conflicting-model-observations", proof };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.chunkId.localeCompare(b.chunkId) || a.lane.localeCompare(b.lane));
  if (rows.length) derived.transact(rows.flatMap((row) => [
    fact(row.exceptionId, "exception/type", "semantic_sensor_disagreement"), fact(row.exceptionId, "exception/chunk", row.chunkId),
    fact(row.exceptionId, "exception/file", row.file), fact(row.exceptionId, "exception/lane", row.lane), fact(row.exceptionId, "exception/code", row.code),
    fact(row.exceptionId, "exception/severity", row.severity), fact(row.exceptionId, "exception/epistemic-status", row.epistemicStatus),
    fact(row.exceptionId, "exception/status", "review-required"), fact(row.exceptionId, "exception/source-basis", basis),
    fact(row.exceptionId, "exception/left-present", row.leftPresent), fact(row.exceptionId, "exception/right-present", row.rightPresent),
    fact(row.exceptionId, "exception/proof", row.proof),
  ]), { src: RULE_ID, kind: "derived-review-conclusion" });
  const packets = rows.map((row) => pullEntity(derived.view(), row.exceptionId, sensorPullSpec(), { sourceName: "$derived-semantic-sensor", includeEvidence: true }));
  const sharedUnits = left.units.filter((chunkId) => right.unitSet.has(chunkId)).length;
  const byLane = Object.fromEntries(laneKeys.map((lane) => [lane, rows.filter((row) => row.lane === lane).length]));
  const body = {
    schema: "bantam.factory.semantic-sensor-control.v1", kind: "bantam.factory-semantic-sensor-control", authority: "observe-only",
    ruleId: RULE_ID, policyId: POLICY_ID, basis,
    comparison: { leftUnits: left.units.length, rightUnits: right.units.length, sharedByteIdenticalUnits: sharedUnits, comparedLanes: laneKeys.length, comparedDecisions: sharedUnits * laneKeys.length },
    summary: { total: rows.length, critical: 0, warning: rows.length, byLane },
    exceptions: rows.map((row, index) => ({ ...row, packet: packets[index] })),
  };
  return deepFreeze({ ...body, artifactId: `semantic-sensor-control:sha256:${digest(body)}` });
}

function publishSensorMatrix(artifact) {
  validateSemanticObject(artifact);
  const relations = new Map(artifact.datalog.relations.map((relation) => [relation.name, relation.rows]));
  const observed = new Set((relations.get("semantic_observation") ?? []).map(([chunkId, lane]) => `${chunkId}\0${lane}`));
  const fabric = new FactFabric();
  const units = [];
  for (const [chunkId, file] of relations.get("chunk_file") ?? []) {
    units.push(chunkId);
    fabric.transact([fact(chunkId, "semantic/file", file)], { src: chunkId, kind: "exact-source-unit" });
    for (const { key: lane } of artifact.rubric) {
      const cell = `sensor-cell:sha256:${digest({ chunkId, lane })}`;
      fabric.transact([fact(cell, "sensor/chunk", chunkId), fact(cell, "sensor/lane", lane), fact(cell, "sensor/present", observed.has(`${chunkId}\0${lane}`))], { src: artifact.kitRef, kind: "model-lane-decision" });
    }
  }
  return { fabric, lanes: artifact.rubric.map((row) => row.key), units, unitSet: new Set(units) };
}

function sensorPullSpec() { return deepFreeze({ attributes: {
  "exception/type": { as: "type" }, "exception/chunk": { as: "chunkId" }, "exception/file": { as: "file" },
  "exception/lane": { as: "lane" }, "exception/code": { as: "code" }, "exception/severity": { as: "severity" },
  "exception/epistemic-status": { as: "epistemicStatus" }, "exception/status": { as: "status" },
  "exception/source-basis": { as: "sourceBasis" }, "exception/left-present": { as: "leftPresent" },
  "exception/right-present": { as: "rightPresent" }, "exception/proof": { as: "proof" },
} }); }
function fact(e, a, v) { return { op: "assert", e, a, v }; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
