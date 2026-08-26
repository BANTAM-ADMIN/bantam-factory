import crypto from "node:crypto";

import { validateSemanticObject } from "./semantic-object.js";
import { FactFabric, canonicalEncode } from "./fact-fabric.js";
import { FactSourceRegistry, pullEntity } from "./fact-context.js";
import { FactDatalogBridge } from "./fact-datalog-bridge.js";

const RULE_ID = "rule:mutation-without-authority@1";
const POLICY_ID = "policy:mutation-authority-lanes@1";
const EFFECT_LANES = ["filesystem_write", "process_execution", "persistent_state_mutation"];

export function publishSemanticObjectFacts(artifact) {
  validateSemanticObject(artifact);
  const relations = new Map(artifact.datalog.relations.map((relation) => [relation.name, relation.rows]));
  const chunks = new Map(artifact.sourceUnits.map((unit) => [unit.chunkId, unit]));
  const fabric = new FactFabric();
  for (const [chunkId, file] of relations.get("chunk_file") ?? []) {
    const unit = chunks.get(chunkId);
    if (!unit) throw new Error(`semantic object chunk_file references unknown unit: ${chunkId}`);
    const span = (relations.get("chunk_span") ?? []).find((row) => row[0] === chunkId);
    fabric.transact([
      fact(chunkId, "semantic/file", file),
      fact(chunkId, "semantic/start-line", Number(span?.[1] ?? unit.startLine)),
      fact(chunkId, "semantic/end-line", Number(span?.[2] ?? unit.endLine)),
      fact(chunkId, "semantic/source-hash", unit.sha256),
    ], { src: chunkId, kind: "exact-source-unit" });
  }
  for (const [chunkId, lane, kitRef] of relations.get("semantic_observation") ?? []) {
    fabric.transact([fact(chunkId, "semantic/observed-lane", lane)], { src: kitRef, kind: "model-observation" });
  }
  for (const [chunkId, lane, evidenceRef] of relations.get("accepted_lane") ?? []) {
    fabric.transact([fact(chunkId, "semantic/accepted-lane", lane)], { src: evidenceRef, kind: "reviewed-acceptance" });
  }

  const files = [...new Set((relations.get("chunk_file") ?? []).map((row) => row[1]))].sort();
  const observedAuthority = new Set((relations.get("authority_file") ?? []).map((row) => row[0]));
  const acceptedAuthority = new Set((relations.get("file_accepted_lane") ?? []).filter((row) => row[1] === "authority_gate").map((row) => row[0]));
  for (const file of files) {
    fabric.transact([
      fact(file, "semantic/authority-observed", observedAuthority.has(file)),
      fact(file, "semantic/authority-accepted", acceptedAuthority.has(file)),
    ], { src: artifact.artifactId, kind: "deterministic-presence-at-semantic-basis" });
  }
  const snapshot = fabric.snapshot("semantic-object-projection");
  return Object.freeze({
    fabric,
    view: fabric.viewAt(snapshot.name),
    basis: Object.freeze({ semanticObjectId: artifact.artifactId, kitRef: artifact.kitRef, factBasis: snapshot.basis }),
  });
}

export function projectMutationAuthorityControl({ artifact } = {}) {
  const semantic = publishSemanticObjectFacts(artifact);
  const policy = new FactFabric();
  policy.transact(EFFECT_LANES.map((lane) => fact(lane, "policy/effect-lane", true)), { src: POLICY_ID, kind: "reviewed-policy" });
  const sources = new FactSourceRegistry({ $semantic: semantic.view, $policy: policy.view() });
  const logic = new FactDatalogBridge({ sources });
  logic.ingest({ source: "$semantic", relation: "chunk_file", pattern: { a: "semantic/file" }, fields: ["e", "v"] });
  logic.ingest({ source: "$semantic", relation: "observed_lane", pattern: { a: "semantic/observed-lane" }, fields: ["e", "v"] });
  logic.ingest({ source: "$semantic", relation: "accepted_lane", pattern: { a: "semantic/accepted-lane" }, fields: ["e", "v"] });
  logic.ingest({ source: "$semantic", relation: "authority_observed", pattern: { a: "semantic/authority-observed" }, fields: ["e", "v"] });
  logic.ingest({ source: "$semantic", relation: "authority_accepted", pattern: { a: "semantic/authority-accepted" }, fields: ["e", "v"] });
  logic.ingest({ source: "$policy", relation: "effect_lane", pattern: { a: "policy/effect-lane" }, fields: ["e", "v"] });
  const yes = logic.literal(true), no = logic.literal(false);
  const observedGap = logic.literal("model-observed-authority-gap");
  const acceptedGap = logic.literal("accepted-mutation-authority-gap");
  logic
    .rule(`mutation_without_authority(C,F,L,${observedGap}) :- chunk_file(C,F), observed_lane(C,L), effect_lane(L,${yes}), authority_observed(F,${no})`)
    .rule(`mutation_without_authority(C,F,L,${acceptedGap}) :- chunk_file(C,F), accepted_lane(C,L), effect_lane(L,${yes}), authority_accepted(F,${no})`)
    .run();

  const conclusions = logic.query("mutation_without_authority", "?chunk", "?file", "?lane", "?code");
  const derived = new FactFabric();
  const rows = conclusions.map(([chunkId, file, lane, code]) => {
    const proof = logic.explain("mutation_without_authority", chunkId, file, lane, code);
    const exceptionId = `mutation-authority-exception:sha256:${digest({ basis: semantic.basis, chunkId, file, lane, code, proof })}`;
    return { exceptionId, chunkId, file, lane, code, severity: code.startsWith("accepted-") ? "critical" : "warning", epistemicStatus: code.startsWith("accepted-") ? "accepted-evidence-gap" : "model-observation-gap", proof };
  }).sort((a, b) => a.exceptionId.localeCompare(b.exceptionId));
  if (rows.length) derived.transact(rows.flatMap((row) => [
    fact(row.exceptionId, "exception/type", "mutation_without_authority"),
    fact(row.exceptionId, "exception/chunk", row.chunkId),
    fact(row.exceptionId, "exception/file", row.file),
    fact(row.exceptionId, "exception/lane", row.lane),
    fact(row.exceptionId, "exception/code", row.code),
    fact(row.exceptionId, "exception/severity", row.severity),
    fact(row.exceptionId, "exception/epistemic-status", row.epistemicStatus),
    fact(row.exceptionId, "exception/status", "review-required"),
    fact(row.exceptionId, "exception/source-basis", semantic.basis),
    fact(row.exceptionId, "exception/proof", row.proof),
  ]), { src: RULE_ID, kind: "derived-review-conclusion" });
  const packets = rows.map((row) => pullEntity(derived.view(), row.exceptionId, mutationAuthorityPullSpec(), { sourceName: "$derived-mutation-authority", includeEvidence: true }));
  const body = {
    schema: "bantam.factory.mutation-authority-control.v1",
    kind: "bantam.factory-mutation-authority-control",
    authority: "observe-only",
    ruleId: RULE_ID,
    policyId: POLICY_ID,
    basis: semantic.basis,
    summary: { total: rows.length, critical: rows.filter((row) => row.severity === "critical").length, warning: rows.filter((row) => row.severity === "warning").length },
    exceptions: rows.map((row, index) => ({ ...row, packet: packets[index] })),
  };
  return deepFreeze({ ...body, artifactId: `mutation-authority-control:sha256:${digest(body)}` });
}

export function mutationAuthorityPullSpec() {
  return deepFreeze({ attributes: {
    "exception/type": { as: "type" }, "exception/chunk": { as: "chunkId" }, "exception/file": { as: "file" },
    "exception/lane": { as: "lane" }, "exception/code": { as: "code" }, "exception/severity": { as: "severity" },
    "exception/epistemic-status": { as: "epistemicStatus" }, "exception/status": { as: "status" },
    "exception/source-basis": { as: "sourceBasis" }, "exception/proof": { as: "proof" },
  } });
}

function fact(e, a, v) { return { op: "assert", e, a, v }; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
