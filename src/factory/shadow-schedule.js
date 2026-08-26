import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";
import { projectFactoryDispatchBoard } from "./dispatch-board.js";

const POLICY_KIND = "bantam.factory-shadow-schedule-policy";
const SCHEDULE_KIND = "bantam.factory-shadow-schedule";
const POLICY_ID = /^[a-z][a-z0-9-]*$/;
const DEFERRAL_CODES = new Set([
  "unsupported-resource-kind",
  "worker-unavailable",
  "capacity-unknown",
  "duration-unknown",
  "capacity-inconsistent",
  "horizon-exceeded",
]);

export const DEFAULT_SHADOW_SCHEDULE_POLICY = defineShadowSchedulePolicy({
  schema: 1,
  kind: POLICY_KIND,
  id: "earliest-qualified-capacity",
  version: 1,
  objective: "earliest-feasible",
  durationSource: "qualification-p95",
  unknownCapacity: "defer",
  unknownDuration: "defer",
  maxHorizonMs: 86_400_000,
});

export function defineShadowSchedulePolicy(value) {
  const source = record(value, "shadow schedule policy");
  exact(source, ["schema", "kind", "id", "version", "objective", "durationSource", "unknownCapacity", "unknownDuration", "maxHorizonMs"], "shadow schedule policy");
  if (source.schema !== 1 || source.kind !== POLICY_KIND) throw new Error(`shadow schedule policy must use ${POLICY_KIND} schema 1`);
  if (!POLICY_ID.test(source.id)) throw new Error(`invalid shadow schedule policy id: ${source.id}`);
  if (!Number.isInteger(source.version) || source.version < 1) throw new Error("shadow schedule policy version must be a positive integer");
  if (source.objective !== "earliest-feasible") throw new Error(`unsupported shadow schedule objective: ${source.objective}`);
  if (source.durationSource !== "qualification-p95") throw new Error(`unsupported shadow schedule duration source: ${source.durationSource}`);
  if (source.unknownCapacity !== "defer" || source.unknownDuration !== "defer") throw new Error("shadow schedule policy must defer unknown capacity and duration");
  if (!Number.isInteger(source.maxHorizonMs) || source.maxHorizonMs < 1 || source.maxHorizonMs > 604_800_000) throw new Error("shadow schedule max horizon must be from 1 to 604800000ms");
  const body = {
    schema: 1,
    kind: POLICY_KIND,
    id: source.id,
    version: source.version,
    objective: source.objective,
    durationSource: source.durationSource,
    unknownCapacity: source.unknownCapacity,
    unknownDuration: source.unknownDuration,
    maxHorizonMs: source.maxHorizonMs,
  };
  return deepFreeze({ ...body, ref: policyRef(body) });
}

export function projectFactoryShadowSchedule({ root, now = Date.now(), policy = DEFAULT_SHADOW_SCHEDULE_POLICY } = {}) {
  const dispatch = projectFactoryDispatchBoard({ root, now });
  return buildFactoryShadowSchedule({ dispatch, now, policy });
}

export function buildFactoryShadowSchedule({ dispatch, now = Date.now(), policy = DEFAULT_SHADOW_SCHEDULE_POLICY } = {}) {
  if (!dispatch || dispatch.kind !== "bantam.factory-dispatch-board") throw new Error("shadow schedule requires a factory dispatch board");
  if (!Number.isFinite(now)) throw new Error("shadow schedule now must be a timestamp");
  const normalizedPolicy = defineShadowSchedulePolicy(stripRef(policy));
  const generatedAt = new Date(now).toISOString();
  const ready = dispatch.operations.filter((row) => row.state === "ready");
  const allocations = [];
  const deferred = [];
  const lanesByWorker = new Map();

  for (const operation of ready) {
    const operationKey = `${operation.jobId}/${operation.stationId}`;
    if (operation.workerKind !== "model") {
      deferred.push(defer(operation, operationKey, "unsupported-resource-kind", `shadow capacity planning currently supports model workers, not ${operation.workerKind}`));
      continue;
    }
    const workerRef = operation.staffing?.selected ?? null;
    const candidate = operation.staffing?.eligible?.find((row) => row.workerRef === workerRef) ?? null;
    if (!workerRef || !candidate) {
      deferred.push(defer(operation, operationKey, "worker-unavailable", operation.staffing?.explanation ?? "no selected qualified worker"));
      continue;
    }
    if (!candidate.healthCurrent || !Number.isInteger(candidate.slotsAvailable) || candidate.slotsAvailable < 1) {
      deferred.push(defer(operation, operationKey, "capacity-unknown", `current positive slot evidence is unavailable for ${candidate.workerId}`));
      continue;
    }
    if (!Number.isFinite(candidate.p95Ms) || candidate.p95Ms <= 0 || !Number.isSafeInteger(Math.ceil(candidate.p95Ms))) {
      deferred.push(defer(operation, operationKey, "duration-unknown", `positive qualification p95 is unavailable for ${candidate.workerId}`));
      continue;
    }
    const durationMs = Math.ceil(candidate.p95Ms);
    let resource = lanesByWorker.get(workerRef);
    if (!resource) {
      resource = { capacity: candidate.slotsAvailable, lanes: Array.from({ length: candidate.slotsAvailable }, () => now) };
      lanesByWorker.set(workerRef, resource);
    } else if (resource.capacity !== candidate.slotsAvailable) {
      deferred.push(defer(operation, operationKey, "capacity-inconsistent", `ready operations disagree on current slots for ${candidate.workerId}`));
      continue;
    }
    let slotIndex = 0;
    for (let index = 1; index < resource.lanes.length; index += 1) if (resource.lanes[index] < resource.lanes[slotIndex]) slotIndex = index;
    const start = resource.lanes[slotIndex];
    const end = start + durationMs;
    if (end - now > normalizedPolicy.maxHorizonMs) {
      deferred.push(defer(operation, operationKey, "horizon-exceeded", `predicted completion exceeds ${normalizedPolicy.maxHorizonMs}ms shadow horizon`));
      continue;
    }
    resource.lanes[slotIndex] = end;
    allocations.push({
      operationKey,
      jobId: operation.jobId,
      stationId: operation.stationId,
      stationRef: operation.stationRef,
      workerRef,
      workerId: candidate.workerId,
      slot: slotIndex + 1,
      capacity: resource.capacity,
      capacityEvidence: "current-worker-health",
      plannedStart: new Date(start).toISOString(),
      plannedEnd: new Date(end).toISOString(),
      durationMs,
      durationEvidence: normalizedPolicy.durationSource,
      status: "shadow-planned",
    });
  }

  const body = {
    schema: 1,
    kind: SCHEDULE_KIND,
    mode: "shadow",
    authority: "observe-only",
    generatedAt,
    policy: normalizedPolicy,
    policyRef: normalizedPolicy.ref,
    dispatchGeneratedAt: dispatch.generatedAt,
    workforceHead: dispatch.workforceHead,
    summary: {
      ready: ready.length,
      planned: allocations.length,
      deferred: deferred.length,
      resources: new Set(allocations.map((row) => row.workerRef)).size,
      spanMs: allocations.length ? Math.max(...allocations.map((row) => Date.parse(row.plannedEnd))) - now : 0,
    },
    allocations,
    deferred,
  };
  const schedule = deepFreeze({ ...body, ref: scheduleRef(body) });
  auditFactoryShadowSchedule(schedule);
  return schedule;
}

export function auditFactoryShadowSchedule(value) {
  const schedule = record(value, "shadow schedule");
  exact(schedule, ["schema", "kind", "mode", "authority", "generatedAt", "policy", "policyRef", "dispatchGeneratedAt", "workforceHead", "summary", "allocations", "deferred", "ref"], "shadow schedule");
  if (schedule.schema !== 1 || schedule.kind !== SCHEDULE_KIND || schedule.mode !== "shadow" || schedule.authority !== "observe-only") throw new Error("unsupported shadow schedule envelope");
  const policy = defineShadowSchedulePolicy(stripRef(schedule.policy));
  if (schedule.policy.ref !== policy.ref) throw new Error("embedded shadow schedule policy reference mismatch");
  if (policy.ref !== schedule.policyRef) throw new Error("shadow schedule policy reference mismatch");
  const generated = timestamp(schedule.generatedAt, "shadow schedule generatedAt");
  const dispatchGenerated = timestamp(schedule.dispatchGeneratedAt, "shadow schedule dispatchGeneratedAt");
  if (dispatchGenerated > generated) throw new Error("shadow schedule cannot predate its dispatch observation");
  if (schedule.workforceHead !== null && !/^sha256:[a-f0-9]{64}$/.test(schedule.workforceHead)) throw new Error("shadow schedule workforce head is invalid");
  const summary = record(schedule.summary, "shadow schedule summary");
  exact(summary, ["ready", "planned", "deferred", "resources", "spanMs"], "shadow schedule summary");
  for (const field of ["ready", "planned", "deferred", "resources", "spanMs"]) nonNegativeInteger(summary[field], `shadow schedule summary ${field}`);
  if (!Array.isArray(schedule.allocations) || !Array.isArray(schedule.deferred)) throw new Error("shadow schedule rows must be arrays");
  const operations = new Set();
  const byLane = new Map();
  const capacityByWorker = new Map();
  for (const row of schedule.allocations) {
    record(row, "shadow allocation");
    exact(row, ["operationKey", "jobId", "stationId", "stationRef", "workerRef", "workerId", "slot", "capacity", "capacityEvidence", "plannedStart", "plannedEnd", "durationMs", "durationEvidence", "status"], "shadow allocation");
    allocationIdentity(row);
    if (operations.has(row.operationKey)) throw new Error(`shadow schedule operation is allocated twice: ${row.operationKey}`);
    operations.add(row.operationKey);
    positiveInteger(row.capacity, `shadow schedule capacity: ${row.operationKey}`);
    positiveInteger(row.slot, `shadow schedule slot: ${row.operationKey}`);
    if (row.slot > row.capacity) throw new Error(`shadow schedule slot exceeds observed capacity: ${row.operationKey}`);
    if (row.capacityEvidence !== "current-worker-health") throw new Error(`invalid shadow allocation capacity evidence: ${row.operationKey}`);
    const knownCapacity = capacityByWorker.get(row.workerRef);
    if (knownCapacity !== undefined && knownCapacity !== row.capacity) throw new Error(`shadow schedule worker capacity is inconsistent: ${row.workerRef}`);
    capacityByWorker.set(row.workerRef, row.capacity);
    const start = timestamp(row.plannedStart, `shadow allocation start: ${row.operationKey}`);
    const end = timestamp(row.plannedEnd, `shadow allocation end: ${row.operationKey}`);
    positiveInteger(row.durationMs, `shadow allocation duration: ${row.operationKey}`);
    if (start < generated || end <= start || end - start !== row.durationMs) throw new Error(`invalid shadow schedule interval: ${row.operationKey}`);
    if (end - generated > policy.maxHorizonMs) throw new Error(`shadow allocation exceeds policy horizon: ${row.operationKey}`);
    if (row.durationEvidence !== policy.durationSource || row.status !== "shadow-planned") throw new Error(`invalid shadow allocation evidence: ${row.operationKey}`);
    const lane = `${row.workerRef}\u0000${row.slot}`;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push({ start, end, operationKey: row.operationKey });
  }
  for (const intervals of byLane.values()) {
    intervals.sort((a, b) => a.start - b.start || a.operationKey.localeCompare(b.operationKey));
    for (let index = 1; index < intervals.length; index += 1) if (intervals[index].start < intervals[index - 1].end) throw new Error(`shadow schedule double-books a worker slot: ${intervals[index].operationKey}`);
  }
  for (const row of schedule.deferred) {
    record(row, "shadow deferral");
    exact(row, ["operationKey", "jobId", "stationId", "stationRef", "code", "reason"], "shadow deferral");
    operationIdentity(row);
    if (!DEFERRAL_CODES.has(row.code)) throw new Error(`invalid shadow deferral code: ${row.code}`);
    requiredString(row.reason, `shadow deferral reason: ${row.operationKey}`);
    if (operations.has(row.operationKey)) throw new Error(`shadow schedule operation is both planned and deferred: ${row.operationKey}`);
    operations.add(row.operationKey);
  }
  const resources = new Set(schedule.allocations.map((row) => row.workerRef)).size;
  const spanMs = schedule.allocations.length ? Math.max(...schedule.allocations.map((row) => timestamp(row.plannedEnd, `shadow allocation end: ${row.operationKey}`))) - generated : 0;
  if (summary.ready !== operations.size || summary.planned !== schedule.allocations.length || summary.deferred !== schedule.deferred.length || summary.resources !== resources || summary.spanMs !== spanMs) throw new Error("shadow schedule summary mismatch");
  const { ref, ...body } = schedule;
  if (ref !== scheduleRef(body)) throw new Error("shadow schedule reference mismatch");
  return deepFreeze({ ok: true, allocations: schedule.allocations.length, deferred: schedule.deferred.length, ref });
}

export function formatFactoryShadowSchedule(schedule) {
  auditFactoryShadowSchedule(schedule);
  const lines = [
    "BANTAMFACTORY SHADOW CAPACITY PLAN",
    `ready ${schedule.summary.ready}  planned ${schedule.summary.planned}  deferred ${schedule.summary.deferred}  span ${duration(schedule.summary.spanMs)}`,
    `policy ${schedule.policy.id}@${schedule.policy.version}  authority observe-only`,
    "",
  ];
  for (const row of schedule.allocations) lines.push(`[PLAN] ${row.operationKey}  ${row.workerId}#${row.slot}  ${time(row.plannedStart)}-${time(row.plannedEnd)}  p95 ${duration(row.durationMs)}`);
  for (const row of schedule.deferred) lines.push(`[WAIT] ${row.operationKey}  ${row.code}: ${row.reason}`);
  if (!schedule.summary.ready) lines.push("(no dependency-ready operations)");
  return lines.join("\n");
}

function defer(operation, operationKey, code, reason) { return { operationKey, jobId: operation.jobId, stationId: operation.stationId, stationRef: operation.stationRef, code, reason }; }
function allocationIdentity(row) { operationIdentity(row); requiredString(row.workerRef, `shadow allocation workerRef: ${row.operationKey}`); requiredString(row.workerId, `shadow allocation workerId: ${row.operationKey}`); }
function operationIdentity(row) { requiredString(row.operationKey, "shadow operation key"); requiredString(row.jobId, `shadow job id: ${row.operationKey}`); requiredString(row.stationId, `shadow station id: ${row.operationKey}`); requiredString(row.stationRef, `shadow station ref: ${row.operationKey}`); if (row.operationKey !== `${row.jobId}/${row.stationId}`) throw new Error(`shadow operation identity mismatch: ${row.operationKey}`); }
function stripRef(value) { const { ref: ignored, ...body } = record(value, "shadow schedule policy"); return body; }
function policyRef(body) { return `schedule-policy:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`; }
function scheduleRef(body) { return `shadow-schedule:sha256:${sha256(canonicalJson(body))}`; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function duration(ms) { return ms < 1_000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`; }
function time(value) { return new Date(value).toISOString().slice(11, 19); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, keys, label) { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} fields mismatch`); }
function requiredString(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value; }
function nonNegativeInteger(value, label) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; }
function positiveInteger(value, label) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; }
function timestamp(value, label) { if (typeof value !== "string") throw new Error(`${label} is invalid`); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} is invalid`); return parsed; }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
