import crypto from "node:crypto";

import { FactFabric, canonicalEncode } from "./fact-fabric.js";
import { FactSourceRegistry, pullEntity } from "./fact-context.js";
import { FactDatalogBridge } from "./fact-datalog-bridge.js";

const CONTROL_SCHEMA = "bantam.factory.workforce-health-control.v1";
const RULE_ID = "rule:worker-health-out-of-control@1";

export class WorkforceHealthControlCache {
  constructor({ limit = 64 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("workforce health cache limit must be from 1 through 10000");
    this.limit = limit;
    this._entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  project({ scope, workforce, now = Date.now() } = {}) {
    if (typeof scope !== "string" || !scope) throw new TypeError("workforce health cache scope is required");
    const key = workforceHealthControlCacheKey(workforce, { now });
    const retained = this._entries.get(scope);
    if (retained?.key === key) {
      this.hits += 1;
      // Refresh LRU position without rebuilding semantic computation.
      this._entries.delete(scope);
      this._entries.set(scope, retained);
      return retained.control;
    }
    this.misses += 1;
    const control = projectWorkforceHealthControl({ workforce, now });
    this._entries.delete(scope);
    this._entries.set(scope, { key, control });
    while (this._entries.size > this.limit) this._entries.delete(this._entries.keys().next().value);
    return control;
  }

  clear() { this._entries.clear(); }
  stats() { return Object.freeze({ entries: this._entries.size, hits: this.hits, misses: this.misses, limit: this.limit }); }
}

export function workforceHealthControlCacheKey(workforce, { now = Date.now() } = {}) {
  validateWorkforce(workforce);
  if (!Number.isFinite(now)) throw new TypeError("workforce health cache now must be a timestamp");
  return `workforce-health-input:sha256:${digest({
    head: workforce.head,
    events: workforce.events,
    profiles: workforce.profiles.map((profile) => profile.ref),
    qualifications: workforce.qualifications.map((row) => [row.eventId, row.status]),
    health: workforce.health.map((row) => [row.workerRef, row.eventId, Date.parse(row.expiresAt) > now]),
  })}`;
}

/**
 * Publish one audited WorkforceRegistry projection as a pinned temporal source.
 * This is read-only: no workforce journal method or authority enters the view.
 */
export function publishWorkforceFacts(workforce, { now = Date.now() } = {}) {
  validateWorkforce(workforce);
  if (!Number.isFinite(now)) throw new TypeError("workforce fact projection now must be a timestamp");
  const inspectedAt = new Date(now).toISOString();
  const fabric = new FactFabric();
  const healthByWorker = new Map(workforce.health.map((row) => [row.workerRef, row]));

  for (const profile of workforce.profiles) {
    fabric.transact([
      fact(profile.ref, "worker/installed", true),
      fact(profile.ref, "worker/id", profile.id),
      fact(profile.ref, "worker/model", profile.model),
      fact(profile.ref, "worker/runtime", profile.runtime),
      fact(profile.ref, "worker/availability-class", profile.availabilityClass),
      ...profile.capabilities.map((capability) => fact(profile.ref, "worker/capability", capability)),
    ], { src: profile.ref, kind: "installed-worker-profile" });

    const health = healthByWorker.get(profile.ref);
    if (!health) {
      fabric.transact([
        fact(profile.ref, "health/observed", false),
      ], { src: workforce.head ?? "workforce:empty", kind: "deterministic-absence-at-basis" });
      continue;
    }
    const current = Date.parse(health.expiresAt) > now;
    fabric.transact([
      fact(profile.ref, "health/observed", true),
      fact(profile.ref, "health/current", current),
      fact(profile.ref, "health/condition", health.condition),
      fact(profile.ref, "health/code", health.code),
      fact(profile.ref, "health/observed-at", health.time),
      fact(profile.ref, "health/expires-at", health.expiresAt),
      ...(health.slotsAvailable === null ? [] : [fact(profile.ref, "health/slots-available", health.slotsAvailable)]),
      ...(health.quotaRemaining === null ? [] : [fact(profile.ref, "health/quota-remaining", health.quotaRemaining)]),
    ], { src: health.eventId, kind: "worker-health-observation" });
  }

  for (const qualification of workforce.qualifications) {
    const entity = `qualification:${qualification.eventId}`;
    fabric.transact([
      fact(entity, "qualification/worker", qualification.workerRef),
      fact(entity, "qualification/station", qualification.stationRef),
      fact(entity, "qualification/task-family", qualification.taskFamily),
      fact(entity, "qualification/status", qualification.status),
      fact(qualification.workerRef, "worker/qualification", entity),
    ], { src: qualification.eventId, kind: "worker-qualification-record" });
  }

  const snapshot = fabric.snapshot("workforce-projection");
  const projectionId = `workforce-fact-projection:sha256:${digest(fabric.history())}`;
  return Object.freeze({
    fabric,
    view: fabric.viewAt(snapshot.name),
    inspectedAt,
    basis: Object.freeze({
      workforceHead: workforce.head,
      workforceEvents: workforce.events,
      factBasis: snapshot.basis,
      projectionId,
    }),
  });
}

/** Derive and package current worker-health exceptions for supervisor display. */
export function projectWorkforceHealthControl({ workforce, now = Date.now() } = {}) {
  const published = publishWorkforceFacts(workforce, { now });
  const sources = new FactSourceRegistry({ $workforce: published.view });
  const logic = new FactDatalogBridge({ sources });
  ingestHealthRelations(logic);
  installHealthRules(logic);
  logic.run();

  const conclusions = logic.query("worker_health_out_of_control", "?worker", "?code");
  const derived = new FactFabric();
  const exceptionRows = conclusions.map(([workerRef, code]) => {
    const proof = logic.explain("worker_health_out_of_control", workerRef, code);
    const exceptionId = `workforce-exception:sha256:${digest({ basis: published.basis, workerRef, code, proof })}`;
    return { exceptionId, workerRef, code, severity: severityFor(code), proof };
  }).sort((left, right) => left.exceptionId.localeCompare(right.exceptionId));

  if (exceptionRows.length > 0) {
    derived.transact(exceptionRows.flatMap((row) => [
      fact(row.exceptionId, "exception/type", "worker_health_out_of_control"),
      fact(row.exceptionId, "exception/worker", row.workerRef),
      fact(row.exceptionId, "exception/code", row.code),
      fact(row.exceptionId, "exception/severity", row.severity),
      fact(row.exceptionId, "exception/status", "open"),
      fact(row.exceptionId, "exception/source-basis", published.basis),
      fact(row.exceptionId, "exception/proof", row.proof),
    ]), { src: RULE_ID, kind: "derived-conclusion" });
  }
  const derivedSnapshot = derived.snapshot("supervisor-exceptions");
  const packetSpec = workforceExceptionPullSpec();
  const packets = exceptionRows.map((row) => pullEntity(derived.viewAt(derivedSnapshot.name), row.exceptionId, packetSpec, {
    sourceName: "$derived-workforce-control",
    includeEvidence: true,
  }));
  const body = {
    schema: CONTROL_SCHEMA,
    kind: "bantam.factory-workforce-health-control",
    authority: "observe-only",
    ruleId: RULE_ID,
    basis: published.basis,
    derivedBasis: derivedSnapshot.basis,
    summary: summarize(exceptionRows),
    exceptions: exceptionRows.map((row, index) => ({ ...row, packet: packets[index] })),
  };
  return deepFreeze({
    ...body,
    artifactId: `workforce-health-control:sha256:${digest(body)}`,
    inspectedAt: published.inspectedAt,
  });
}

export function workforceExceptionPullSpec() {
  return deepFreeze({ attributes: {
    "exception/type": { as: "type" },
    "exception/worker": { as: "workerRef" },
    "exception/code": { as: "code" },
    "exception/severity": { as: "severity" },
    "exception/status": { as: "status" },
    "exception/source-basis": { as: "sourceBasis" },
    "exception/proof": { as: "proof" },
  } });
}

function ingestHealthRelations(logic) {
  const definitions = [
    ["worker_installed", "worker/installed"],
    ["health_observed", "health/observed"],
    ["health_current", "health/current"],
    ["health_condition", "health/condition"],
    ["health_slots", "health/slots-available"],
    ["health_quota", "health/quota-remaining"],
  ];
  for (const [relation, attribute] of definitions) {
    logic.ingest({ source: "$workforce", relation, pattern: { a: attribute }, fields: ["e", "v"] });
  }
}

function installHealthRules(logic) {
  const yes = logic.literal(true);
  const no = logic.literal(false);
  const zero = logic.literal(0);
  const unavailable = logic.literal("unavailable");
  const degraded = logic.literal("degraded");
  const codes = Object.fromEntries([
    "health-missing",
    "health-expired",
    "health-unavailable",
    "health-degraded",
    "capacity-zero",
    "quota-zero",
  ].map((code) => [code, logic.literal(code)]));
  logic
    .rule(`worker_health_out_of_control(W,${codes["health-missing"]}) :- worker_installed(W,${yes}), health_observed(W,${no})`)
    .rule(`worker_health_out_of_control(W,${codes["health-expired"]}) :- health_observed(W,${yes}), health_current(W,${no})`)
    .rule(`worker_health_out_of_control(W,${codes["health-unavailable"]}) :- health_current(W,${yes}), health_condition(W,${unavailable})`)
    .rule(`worker_health_out_of_control(W,${codes["health-degraded"]}) :- health_current(W,${yes}), health_condition(W,${degraded})`)
    .rule(`worker_health_out_of_control(W,${codes["capacity-zero"]}) :- health_current(W,${yes}), health_slots(W,${zero})`)
    .rule(`worker_health_out_of_control(W,${codes["quota-zero"]}) :- health_current(W,${yes}), health_quota(W,${zero})`);
}

function summarize(rows) {
  const byCode = {};
  for (const row of rows) byCode[row.code] = (byCode[row.code] ?? 0) + 1;
  return { total: rows.length, critical: rows.filter((row) => row.severity === "critical").length, warning: rows.filter((row) => row.severity === "warning").length, byCode };
}

function severityFor(code) {
  return ["health-unavailable", "capacity-zero", "quota-zero"].includes(code) ? "critical" : "warning";
}

function fact(e, a, v) { return { op: "assert", e, a, v }; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }

function validateWorkforce(workforce) {
  if (!workforce || workforce.schema !== 1 || workforce.kind !== "bantam.factory-workforce") throw new TypeError("schema-1 factory workforce projection is required");
  if (!Array.isArray(workforce.profiles) || !Array.isArray(workforce.qualifications) || !Array.isArray(workforce.health)) {
    throw new TypeError("workforce profiles, qualifications, and health arrays are required");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
