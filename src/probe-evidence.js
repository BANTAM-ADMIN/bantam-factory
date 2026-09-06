// Source-bound, scoped experiment evidence. The executor owns measurements;
// the model owns the question/check design, which is never accepted authority.
// Initial BANTAM27B construction did not qualify; this implementation includes
// explicit Astra review/repair. Preserved build evidence is documented separately.
import crypto from "node:crypto";
import { FactBus } from "./factory/fact-bus.js";
import { canonicalEncode } from "./factory/fact-fabric.js";
import { FactDatalogBridge } from "./factory/fact-datalog-bridge.js";

const RECEIPT_SCHEMA = "bantam.probe-receipt.v1";
const PHASES = ["setup", "witness", "check"];
const STAGE_FIELDS = ["stage", "experimentId", "sourceDigest", "commandDigest", "executed", "code", "signal", "timedOut", "aborted", "bufferExceeded", "error", "stdoutDigest", "stderrDigest"];
const STRINGS = ["experimentId", "specDigest", "sourceDigest", "sourceAfterDigest", "question"];
const STAGE_STRINGS = ["experimentId", "sourceDigest", "commandDigest", "stdoutDigest", "stderrDigest"];
const FLAGS = ["timedOut", "aborted", "bufferExceeded"];
const INFRA_CODES = new Set([125, 126, 127]);
const fact = (e, a, v) => ({ op: "assert", e, a, v });
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const digest = value => `sha256:${crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex")}`;

/**
 * Project one executor-owned receipt; no process, filesystem, or model work.
 * `assertion_passed` means only the declared experiment passed on its bound
 * source. It is not independent test-design acceptance or task verification.
 */
export function projectProbeEvidence(receipt) {
  const valid = validReceipt(receipt);
  // Retain exactly the required receipt fields. Arbitrary command/output prose
  // stays in the caller's raw artifact, referred to by its measured hashes.
  const measured = valid ? {
    schema: receipt.schema,
    ...Object.fromEntries(STRINGS.map(key => [key, receipt[key]])),
    stages: receipt.stages.map(stage => Object.fromEntries(STAGE_FIELDS.map(key => [key, stage[key]]))),
  } : { schema: RECEIPT_SCHEMA, malformed: true, inputType: receipt === null ? "null" : Array.isArray(receipt) ? "array" : typeof receipt };
  const receiptRef = digest(measured);
  const entity = `probe-evidence:${receiptRef}`;
  const bus = new FactBus();
  bus.observe([
    fact(entity, "probe/question", valid ? measured.question : null),
    fact(entity, "probe/specification", valid ? measured.specDigest : null),
  ], { src: "probe:worker-question", kind: "model-designed-experiment" });

  const operations = [
    fact(entity, "probe/receipt", measured),
    fact(entity, "probe/receipt-reference", receiptRef),
    fact(entity, "probe/shape-valid", valid),
  ];
  if (valid) {
    const identitiesMatch = measured.stages.every(stage => stage.experimentId === measured.experimentId && stage.sourceDigest === measured.sourceDigest);
    const states = measured.stages.map(processState);
    operations.push(
      fact(entity, "probe/experiment", measured.experimentId),
      fact(entity, "probe/source-before", measured.sourceDigest),
      fact(entity, "probe/source-after", measured.sourceAfterDigest),
      fact(entity, "probe/identity-match", identitiesMatch),
      fact(entity, "probe/source-match", measured.sourceDigest === measured.sourceAfterDigest),
      fact(entity, "probe/infrastructure-free", states.every(state => state !== "infrastructure")),
    );
    measured.stages.forEach((stage, index) => {
      const stageEntity = `${entity}/${stage.stage}`;
      operations.push(
        fact(entity, "probe/stage", stageEntity),
        fact(stageEntity, "stage/name", stage.stage),
        fact(stageEntity, "stage/experiment", stage.experimentId),
        fact(stageEntity, "stage/source", stage.sourceDigest),
        fact(stageEntity, "stage/receipt", stage),
        fact(stageEntity, "stage/state", states[index]),
      );
    });
  }
  const telemetry = bus.measure(operations, { src: "probe:executor-receipt", kind: "source-bound-process-measurement" });

  // A source registry pins its views: create it AFTER committing measurements.
  const bridge = new FactDatalogBridge({ sources: bus.sources() });
  for (const [relation, attribute] of [
    ["receipt", "probe/receipt"], ["shape", "probe/shape-valid"],
    ["experiment", "probe/experiment"], ["source_before", "probe/source-before"],
    ["source_after", "probe/source-after"], ["identities", "probe/identity-match"],
    ["freshness", "probe/source-match"], ["infra_free", "probe/infrastructure-free"],
    ["linked_stage", "probe/stage"], ["stage_name", "stage/name"],
    ["stage_experiment", "stage/experiment"], ["stage_source", "stage/source"],
    ["stage_receipt", "stage/receipt"], ["stage_state", "stage/state"],
  ]) bridge.ingest({ source: "$telemetry", relation, pattern: { a: attribute }, fields: ["e", "v"] });

  // The engine intentionally has positive Horn clauses, not negation or JS
  // callbacks. Typed primitive measurements encode explicit absence/inequality;
  // these fixed rules own the conjunctions and the diagnostic precedence.
  const k = Object.fromEntries([true, false, "setup", "witness", "check", "zero", "nonzero", "missing", "infrastructure", "unresolved", "malformed_receipt", "identity_mismatch", "stale_source", "setup_failed", "witness_unobserved", "incomplete", "assertion_passed", "assertion_failed"]
    .map(value => [String(value), bridge.literal(value)]));
  const rules = [
    `bound(R,S,E) :- shape(R,${k.true}), identities(R,${k.true}), source_before(R,S), source_after(R,S), experiment(R,E), receipt(R,P)`,
    `eligible(R,S,E) :- bound(R,S,E), infra_free(R,${k.true})`,
    `stage_bound(R,N,S,E,X,P) :- linked_stage(R,X), stage_name(X,N), stage_source(X,S), stage_experiment(X,E), stage_receipt(X,P)`,
    `stage_zero(R,N,S,E) :- stage_bound(R,N,S,E,X,P), stage_state(X,${k.zero})`,
    `stage_nonzero(R,N,S,E) :- stage_bound(R,N,S,E,X,P), stage_state(X,${k.nonzero})`,
    `stage_missing(R,N,S,E) :- stage_bound(R,N,S,E,X,P), stage_state(X,${k.missing})`,
    `decision(R,${k.unresolved},${k.malformed_receipt}) :- shape(R,${k.false}), receipt(R,P)`,
    `decision(R,${k.unresolved},${k.identity_mismatch}) :- shape(R,${k.true}), identities(R,${k.false}), receipt(R,P)`,
    `decision(R,${k.unresolved},${k.stale_source}) :- shape(R,${k.true}), identities(R,${k.true}), freshness(R,${k.false}), receipt(R,P)`,
    `decision(R,${k.unresolved},${k.infrastructure}) :- bound(R,S,E), stage_bound(R,N,S,E,X,P), stage_state(X,${k.infrastructure})`,
    `decision(R,${k.unresolved},${k.setup_failed}) :- eligible(R,S,E), stage_nonzero(R,${k.setup},S,E)`,
    `decision(R,${k.unresolved},${k.incomplete}) :- eligible(R,S,E), stage_missing(R,${k.setup},S,E)`,
    `decision(R,${k.unresolved},${k.witness_unobserved}) :- eligible(R,S,E), stage_zero(R,${k.setup},S,E), stage_nonzero(R,${k.witness},S,E)`,
    `decision(R,${k.unresolved},${k.incomplete}) :- eligible(R,S,E), stage_zero(R,${k.setup},S,E), stage_missing(R,${k.witness},S,E)`,
    `decision(R,${k.unresolved},${k.incomplete}) :- eligible(R,S,E), stage_zero(R,${k.setup},S,E), stage_zero(R,${k.witness},S,E), stage_missing(R,${k.check},S,E)`,
    `decision(R,${k.assertion_failed},${k.assertion_failed}) :- eligible(R,S,E), stage_zero(R,${k.setup},S,E), stage_zero(R,${k.witness},S,E), stage_nonzero(R,${k.check},S,E)`,
    `decision(R,${k.assertion_passed},${k.assertion_passed}) :- eligible(R,S,E), stage_zero(R,${k.setup},S,E), stage_zero(R,${k.witness},S,E), stage_zero(R,${k.check},S,E)`,
  ];
  for (const rule of rules) bridge.rule(rule);
  bridge.run();
  const decisions = bridge.query("decision", entity, "?status", "?reason");
  const selected = decisions.length === 1 ? decisions[0] : null;
  return {
    schema: "bantam.probe-evidence.v1",
    status: selected?.[1] ?? "unresolved",
    reason: selected?.[2] ?? "incomplete",
    // Never fabricate a proof if a substrate error leaves no unique decision.
    proof: selected ? bridge.explain("decision", ...selected) : null,
    datalog: bridge.describe(),
    receiptRef,
    measurementRef: telemetry.receiptId,
    authority: "model-designed-experiment",
    scope: "declared-assertion-only",
    basis: bus.basis(),
  };
}

function validReceipt(receipt) {
  if (!record(receipt) || receipt.schema !== RECEIPT_SCHEMA || !STRINGS.every(key => text(receipt[key]))
      || !Array.isArray(receipt.stages) || receipt.stages.length !== PHASES.length) return false;
  return receipt.stages.every((stage, index) => record(stage)
    && STAGE_FIELDS.every(key => Object.hasOwn(stage, key))
    && stage.stage === PHASES[index] && STAGE_STRINGS.every(key => text(stage[key]))
    && typeof stage.executed === "boolean" && FLAGS.every(key => typeof stage[key] === "boolean")
    && (stage.code === null || (Number.isInteger(stage.code) && stage.code >= 0 && stage.code <= 255))
    && (stage.signal === null || typeof stage.signal === "string")
    && (stage.error === null || typeof stage.error === "string"));
}

// Process classification only: not a candidate/task verdict. Skipped stages
// cannot inherit old process flags, and reserved runner codes cannot be checks.
function processState(stage) {
  if (!stage.executed) return "missing";
  if (stage.signal !== null || stage.error !== null || FLAGS.some(key => stage[key]) || INFRA_CODES.has(stage.code)) return "infrastructure";
  if (stage.code === null) return "missing";
  return stage.code === 0 ? "zero" : "nonzero";
}
