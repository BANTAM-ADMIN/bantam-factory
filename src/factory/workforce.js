// Versioned worker identity, station qualification, and shadow staffing.

import crypto from "node:crypto";
import path from "node:path";

import { canonicalJson, LaneJournal, LaneLease, verifyJournal } from "../journal.js";

const PROFILE_KIND = "bantam.factory-worker-profile";
const LANE = "workforce";
const ID = /^[a-z][a-z0-9._-]*$/;
const TOKEN = /^[a-z][a-z0-9._:-]*$/;
const WORKER_REF = /^worker:[a-z][a-z0-9._-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/;
const STATION_REF = /^station:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/;
const RUNTIMES = new Set(["codex", "api", "local", "tool", "human"]);
const AVAILABILITY = new Set(["remote-api", "local-compute", "deterministic", "human"]);
const QUALIFICATION = new Set(["candidate", "qualified", "suspended", "removed"]);
const HEALTH = new Set(["available", "degraded", "unavailable"]);
const COST_KINDS = new Set(["subscription", "metered", "local", "none", "unknown"]);

export function defineWorkerProfile(value) {
  const row = record(value, "worker profile");
  exact(row, ["schema", "kind", "id", "version", "runtime", "provider", "model", "reasoningEffort", "transport", "availabilityClass", "capabilities", "cost"], "worker profile");
  if (row.schema !== 1 || row.kind !== PROFILE_KIND) throw new Error("worker profile must use bantam.factory-worker-profile schema 1");
  const profile = {
    schema: 1,
    kind: PROFILE_KIND,
    id: pattern(row.id, ID, "worker id"),
    version: positiveInteger(row.version, "worker version"),
    runtime: oneOf(row.runtime, RUNTIMES, "worker runtime"),
    provider: text(row.provider, "worker provider"),
    model: text(row.model, "worker model"),
    reasoningEffort: row.reasoningEffort === null ? null : pattern(row.reasoningEffort, TOKEN, "worker reasoning effort"),
    transport: pattern(row.transport, TOKEN, "worker transport"),
    availabilityClass: oneOf(row.availabilityClass, AVAILABILITY, "worker availability class"),
    capabilities: stringSet(row.capabilities, "worker capability"),
    cost: normalizeCost(row.cost),
  };
  const ref = workerProfileRef(profile);
  return deepFreeze({ ...profile, ref });
}

export function workerProfileRef(value) {
  const body = { ...value };
  delete body.ref;
  return `worker:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`;
}

export class WorkforceRegistry {
  constructor(root) {
    this.root = path.resolve(text(root, "workforce root"));
  }

  install(value) {
    const profile = defineWorkerProfile(value);
    return this.withLease(() => {
      const state = this.project();
      const key = `${profile.id}@${profile.version}`;
      const prior = state.profiles.find((entry) => `${entry.id}@${entry.version}` === key);
      if (prior && prior.ref !== profile.ref) throw new Error(`worker ${key} is already installed with different bytes`);
      if (prior) return prior;
      this.journal().append("worker.profile-installed", { profile });
      return profile;
    });
  }

  installRuntimeIdentity(identity) {
    return this.install(profileFromRuntimeIdentity(identity));
  }

  qualify({ workerRef, stationRef, taskFamily, status = "qualified", evidence = null, limits = null, reason = "operator qualification" } = {}) {
    return this.withLease(() => {
      const state = this.project();
      const worker = state.profiles.find((profile) => profile.ref === workerRef);
      if (!worker) throw new Error(`qualification references an uninstalled worker: ${workerRef}`);
      const normalizedStation = pattern(stationRef, STATION_REF, "qualification station ref");
      const normalizedFamily = pattern(taskFamily, ID, "qualification task family");
      const prior = state.qualifications.find((row) => row.workerRef === workerRef && row.stationRef === normalizedStation && row.taskFamily === normalizedFamily);
      const qualification = {
        workerRef,
        stationRef: normalizedStation,
        taskFamily: normalizedFamily,
        status: oneOf(status, QUALIFICATION, "qualification status"),
        evidence: evidence === null ? (prior?.evidence ?? normalizeEvidence({})) : normalizeEvidence(evidence),
        limits: limits === null ? (prior?.limits ?? normalizeLimits({})) : normalizeLimits(limits),
        reason: text(reason, "qualification reason"),
      };
      return this.journal().append("worker.qualification-set", qualification);
    });
  }

  observeHealth({ workerRef, condition, code, ttlMs = 60_000, slotsAvailable = null, quotaRemaining = null, detail = null } = {}) {
    return this.withLease(() => {
      const state = this.project();
      if (!state.profiles.some((profile) => profile.ref === workerRef)) throw new Error(`health references an uninstalled worker: ${workerRef}`);
      const ttl = boundedInteger(ttlMs, 1, 86_400_000, "health ttlMs");
      return this.journal().append("worker.health-observed", {
        workerRef,
        condition: oneOf(condition, HEALTH, "worker health condition"),
        code: pattern(code, TOKEN, "worker health code"),
        ttlMs: ttl,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        slotsAvailable: slotsAvailable === null ? null : boundedInteger(slotsAvailable, 0, 1_000_000, "health slotsAvailable"),
        quotaRemaining: quotaRemaining === null ? null : nonNegative(quotaRemaining, "health quotaRemaining"),
        detail: detail === null ? null : String(detail).slice(0, 1_000),
      });
    });
  }

  project({ now = Date.now() } = {}) {
    const journal = this.journal();
    verifyJournal(journal.events, LANE);
    const profiles = [];
    const qualificationByKey = new Map();
    const healthByWorker = new Map();
    for (const event of journal.events) {
      if (event.type === "worker.profile-installed") profiles.push(auditStoredProfile(event.payload.profile));
      else if (event.type === "worker.qualification-set") {
        const row = event.payload;
        qualificationByKey.set(qualificationKey(row.workerRef, row.stationRef, row.taskFamily), deepFreeze({ ...row, eventId: event.id, time: event.time }));
      } else if (event.type === "worker.health-observed") {
        healthByWorker.set(event.payload.workerRef, deepFreeze({ ...event.payload, eventId: event.id, time: event.time }));
      } else throw new Error(`unsupported workforce event: ${event.type}`);
    }
    const health = [...healthByWorker.values()].map((row) => ({ ...row, current: Date.parse(row.expiresAt) > now }));
    return deepFreeze({
      schema: 1,
      kind: "bantam.factory-workforce",
      events: journal.events.length,
      head: journal.head?.id ?? null,
      profiles: profiles.sort((a, b) => a.ref.localeCompare(b.ref)),
      qualifications: [...qualificationByKey.values()].sort(compareQualification),
      health: health.sort((a, b) => a.workerRef.localeCompare(b.workerRef)),
    });
  }

  eligible({ stationRef, taskFamily, requiredCapabilities = [], maxP95Ms = null, maxExpectedCostUsd = null, now = Date.now() } = {}) {
    const station = pattern(stationRef, STATION_REF, "staffing station ref");
    const family = pattern(taskFamily, ID, "staffing task family");
    const required = stringSet(requiredCapabilities, "required capability");
    const state = this.project({ now });
    const accepted = [];
    const rejected = [];
    for (const profile of state.profiles) {
      const qualification = state.qualifications.find((row) => row.workerRef === profile.ref && row.stationRef === station && row.taskFamily === family);
      const health = state.health.find((row) => row.workerRef === profile.ref && row.current) ?? null;
      const reasons = [];
      if (!qualification) reasons.push("not-qualified");
      else if (qualification.status !== "qualified") reasons.push(`qualification-${qualification.status}`);
      for (const capability of required) if (!profile.capabilities.includes(capability)) reasons.push(`missing-capability:${capability}`);
      if (health?.condition === "unavailable") reasons.push(`unavailable:${health.code}`);
      if (health?.slotsAvailable === 0) reasons.push("capacity-zero");
      if (health?.quotaRemaining === 0) reasons.push("quota-zero");
      if (maxP95Ms !== null && qualification?.evidence?.p95Ms !== null && qualification.evidence.p95Ms > nonNegative(maxP95Ms, "staffing maxP95Ms")) reasons.push("p95-limit");
      if (maxExpectedCostUsd !== null && qualification?.evidence?.expectedCostUsd !== null && qualification.evidence.expectedCostUsd > nonNegative(maxExpectedCostUsd, "staffing maxExpectedCostUsd")) reasons.push("cost-limit");
      const candidate = { workerRef: profile.ref, profile, qualification: qualification ?? null, health: health ?? { condition: "unknown", current: false } };
      if (reasons.length) rejected.push({ ...candidate, reasons });
      else accepted.push(candidate);
    }
    accepted.sort(compareCandidate);
    rejected.sort((a, b) => a.workerRef.localeCompare(b.workerRef));
    return deepFreeze({
      schema: 1,
      kind: "bantam.factory-staffing-recommendation",
      mode: "shadow",
      stationRef: station,
      taskFamily: family,
      requiredCapabilities: required,
      selected: accepted[0]?.workerRef ?? null,
      eligible: accepted,
      rejected,
      workforceHead: state.head,
    });
  }

  ingestFactoryPerformance({ events, taskFamily } = {}) {
    if (!Array.isArray(events)) throw new Error("workforce factory import requires traveler events");
    const family = pattern(taskFamily, ID, "workforce import task family");
    const attempts = new Map();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.type === "station.started") attempts.set(event.payload.stationAttempt, {
        stationRef: event.payload.stationRef,
        inputProductRevision: event.payload.inputProductRevision ?? null,
        outputProductRevision: null,
        startedIndex: index,
        status: null,
        gaugeEvent: null,
        performance: null,
        sourceRefs: [event.id],
      });
      else if (event.type === "station.completed") {
        const row = attempts.get(event.payload.stationAttempt);
        if (row) { row.outputProductRevision = event.payload.outputProductRevision ?? null; row.sourceRefs.push(event.id); }
      }
      else if (event.type === "gauge.result") {
        const row = attempts.get(event.payload.stationAttempt);
        if (row) { row.status = event.payload.status; row.gaugeEvent = event; row.sourceRefs.push(event.id); }
      } else if (event.type === "station.performance") {
        const row = attempts.get(event.payload.stationAttempt);
        if (row) { row.performance = event.payload; row.sourceRefs.push(event.id); }
      }
    }
    const rows = [...attempts.values()];
    for (const row of rows) {
      if (row.status !== "pass" || !row.outputProductRevision) continue;
      const consumer = rows.find((candidate) => (
        candidate !== row
        && candidate.startedIndex > row.startedIndex
        && candidate.inputProductRevision === row.outputProductRevision
      ));
      row.escape = consumer?.status === "fail" ? consumer : null;
      if (row.escape?.gaugeEvent?.id) row.sourceRefs.push(row.escape.gaugeEvent.id);
    }
    const groups = new Map();
    for (const row of rows) {
      if (!row.performance?.workerRef) continue;
      const key = `${row.performance.workerRef}\u0000${row.stationRef}`;
      if (!groups.has(key)) groups.set(key, { workerIdentity: row.performance.workerRef, stationRef: row.stationRef, rows: [] });
      groups.get(key).rows.push(row);
    }
    const imported = [];
    for (const group of groups.values()) {
      const profile = this.install(profileFromRuntimeIdentity(group.workerIdentity));
      const prior = this.project().qualifications.find((row) => row.workerRef === profile.ref && row.stationRef === group.stationRef && row.taskFamily === family);
      const wall = group.rows.map((row) => row.performance.operationMs + row.performance.inspectionMs).sort((a, b) => a - b);
      const tokens = group.rows.map((row) => row.performance.totalTokens).filter(Number.isFinite);
      const costs = group.rows.map((row) => row.performance.estimatedCostUsd).filter(Number.isFinite);
      const importedEvidence = {
        articles: group.rows.length,
        passes: group.rows.filter((row) => row.status === "pass" && !row.escape).length,
        escapes: group.rows.filter((row) => row.escape).length,
        falseStops: 0,
        p95Ms: percentile(wall, 0.95),
        meanTotalTokens: mean(tokens),
        expectedCostUsd: mean(costs),
        sourceRefs: [...new Set(group.rows.flatMap((row) => row.sourceRefs))].sort(),
      };
      const duplicate = prior && importedEvidence.sourceRefs.every((ref) => prior.evidence.sourceRefs.includes(ref));
      if (duplicate) {
        imported.push({ profile, qualificationEvent: null, evidence: prior.evidence, duplicate: true });
        continue;
      }
      if (prior && importedEvidence.sourceRefs.some((ref) => prior.evidence.sourceRefs.includes(ref))) {
        throw new Error(`workforce import overlaps prior evidence for ${profile.id} at ${group.stationRef}`);
      }
      const evidence = prior ? mergeEvidence(prior.evidence, importedEvidence) : importedEvidence;
      const newEscape = prior && evidence.escapes > prior.evidence.escapes;
      const shouldSuspend = prior?.status === "qualified" && newEscape;
      const event = this.qualify({
        workerRef: profile.ref,
        stationRef: group.stationRef,
        taskFamily: family,
        status: shouldSuspend ? "suspended" : prior?.status ?? "candidate",
        evidence,
        limits: prior?.limits ?? {},
        reason: shouldSuspend ? "suspended by downstream escape evidence" : "imported audited factory station performance",
      });
      imported.push({ profile, qualificationEvent: event, evidence, duplicate: false });
    }
    return deepFreeze(imported);
  }

  profileForRuntimeIdentity(identity) {
    let expected;
    try { expected = defineWorkerProfile(profileFromRuntimeIdentity(identity)); }
    catch { return null; }
    return this.project().profiles.find((profile) => profile.ref === expected.ref) ?? null;
  }

  observeRuntimeHealth({ identity, condition, code, ttlMs = 60_000, slotsAvailable = null, quotaRemaining = null, detail = null } = {}) {
    const profile = this.profileForRuntimeIdentity(identity);
    if (!profile) return null;
    return this.observeHealth({ workerRef: profile.ref, condition, code, ttlMs, slotsAvailable, quotaRemaining, detail });
  }

  journal() { return new LaneJournal({ root: this.root, laneId: LANE }); }
  withLease(operation) {
    const lease = new LaneLease({ root: this.root, laneId: LANE });
    lease.acquire({ component: "factory-workforce" });
    try { return operation(); }
    finally { lease.release(); }
  }
}

export function formatWorkforce(state) {
  const lines = ["BANTAMFACTORY WORKFORCE", `profiles ${state.profiles.length}  qualifications ${state.qualifications.length}  events ${state.events}`, ""];
  for (const profile of state.profiles) {
    const health = state.health.find((row) => row.workerRef === profile.ref && row.current);
    const qualified = state.qualifications.filter((row) => row.workerRef === profile.ref && row.status === "qualified").length;
    lines.push(`${profile.id}@${profile.version}  ${profile.model}  ${profile.reasoningEffort ?? "default"}  health ${health?.condition ?? "unknown"}  qualified roles ${qualified}`);
  }
  if (!state.profiles.length) lines.push("(no workers installed)");
  return lines.join("\n");
}

export function formatStaffingRecommendation(report) {
  const lines = ["BANTAMFACTORY SHADOW STAFFING", `station ${report.stationRef}`, `task family ${report.taskFamily}`, `selected ${report.selected ?? "none"}`, ""];
  for (const row of report.eligible) lines.push(`[OK] ${row.workerRef}  health ${row.health.condition}`);
  for (const row of report.rejected) lines.push(`[--] ${row.workerRef}  ${row.reasons.join(", ")}`);
  return lines.join("\n");
}

function normalizeCost(value) {
  const row = record(value, "worker cost");
  exact(row, ["kind", "currency", "inputPerMillion", "outputPerMillion", "fixedPerUse"], "worker cost");
  return {
    kind: oneOf(row.kind, COST_KINDS, "worker cost kind"),
    currency: row.currency === null ? null : pattern(row.currency, /^[A-Z]{3}$/, "worker cost currency"),
    inputPerMillion: nullableNonNegative(row.inputPerMillion, "worker input cost"),
    outputPerMillion: nullableNonNegative(row.outputPerMillion, "worker output cost"),
    fixedPerUse: nullableNonNegative(row.fixedPerUse, "worker fixed cost"),
  };
}
function auditStoredProfile(value) {
  const row = record(value, "stored worker profile");
  const { ref, ...body } = row;
  const profile = defineWorkerProfile(body);
  if (ref !== profile.ref) throw new Error(`stored worker profile reference mismatch: ${profile.id}@${profile.version}`);
  return profile;
}
function profileFromRuntimeIdentity(value) {
  const identity = text(value, "factory worker identity");
  const local = /^local:(.+)$/.exec(identity);
  if (local) {
    const model = text(local[1], "local factory model");
    return {
      schema: 1,
      kind: PROFILE_KIND,
      id: pattern(`local-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), ID, "imported worker id"),
      version: 1,
      runtime: "local",
      provider: "plant",
      model,
      reasoningEffort: null,
      transport: "llama.cpp-native",
      availabilityClass: "local-compute",
    capabilities: ["code.general", "model.semantic-work"],
      cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
    };
  }
  const codex = /^codex:([^:]+):([^:]+)$/.exec(identity);
  if (!codex) throw new Error(`unsupported factory worker identity: ${identity}`);
  const [, model, effort] = codex;
  return {
    schema: 1,
    kind: PROFILE_KIND,
    id: pattern(`codex-${model}-${effort}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), ID, "imported worker id"),
    version: 1,
    runtime: "codex",
    provider: "openai",
    model,
    reasoningEffort: pattern(effort, TOKEN, "imported worker effort"),
    transport: "codex-app-server",
    availabilityClass: "remote-api",
    capabilities: ["model.semantic-work"],
    cost: { kind: "subscription", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  };
}
function normalizeEvidence(value) {
  const row = record(value, "qualification evidence");
  const fields = ["articles", "passes", "escapes", "falseStops", "p95Ms", "meanTotalTokens", "expectedCostUsd", "sourceRefs"];
  for (const key of Object.keys(row)) if (!fields.includes(key)) throw new Error(`qualification evidence has unknown field: ${key}`);
  const evidence = {
    articles: boundedInteger(row.articles ?? 0, 0, 1_000_000_000, "evidence articles"),
    passes: boundedInteger(row.passes ?? 0, 0, 1_000_000_000, "evidence passes"),
    escapes: boundedInteger(row.escapes ?? 0, 0, 1_000_000_000, "evidence escapes"),
    falseStops: boundedInteger(row.falseStops ?? 0, 0, 1_000_000_000, "evidence falseStops"),
    p95Ms: nullableNonNegative(row.p95Ms ?? null, "evidence p95Ms"),
    meanTotalTokens: nullableNonNegative(row.meanTotalTokens ?? null, "evidence meanTotalTokens"),
    expectedCostUsd: nullableNonNegative(row.expectedCostUsd ?? null, "evidence expectedCostUsd"),
    sourceRefs: hashRefs(row.sourceRefs ?? [], "evidence source ref"),
  };
  if (evidence.passes > evidence.articles || evidence.escapes > evidence.articles || evidence.falseStops > evidence.articles) {
    throw new Error("qualification evidence counts cannot exceed articles");
  }
  return evidence;
}
function normalizeLimits(value) {
  const row = record(value, "qualification limits");
  const fields = ["maxP95Ms", "maxExpectedCostUsd", "authority"];
  for (const key of Object.keys(row)) if (!fields.includes(key)) throw new Error(`qualification limits has unknown field: ${key}`);
  return { maxP95Ms: nullableNonNegative(row.maxP95Ms ?? null, "limit maxP95Ms"), maxExpectedCostUsd: nullableNonNegative(row.maxExpectedCostUsd ?? null, "limit maxExpectedCostUsd"), authority: stringSet(row.authority ?? [], "qualification authority") };
}
function mergeEvidence(prior, current) {
  const articles = prior.articles + current.articles;
  return {
    articles,
    passes: prior.passes + current.passes,
    escapes: prior.escapes + current.escapes,
    falseStops: prior.falseStops + current.falseStops,
    p95Ms: maximumKnown(prior.p95Ms, current.p95Ms),
    meanTotalTokens: weightedKnown(prior.meanTotalTokens, prior.articles, current.meanTotalTokens, current.articles),
    expectedCostUsd: weightedKnown(prior.expectedCostUsd, prior.articles, current.expectedCostUsd, current.articles),
    sourceRefs: [...new Set([...prior.sourceRefs, ...current.sourceRefs])].sort(),
  };
}
function maximumKnown(left, right) { const rows = [left, right].filter(Number.isFinite); return rows.length ? Math.max(...rows) : null; }
function weightedKnown(left, leftCount, right, rightCount) { const rows = [[left, leftCount], [right, rightCount]].filter(([value]) => Number.isFinite(value)); return rows.length ? rows.reduce((sum, [value, count]) => sum + value * count, 0) / rows.reduce((sum, [, count]) => sum + count, 0) : null; }
function compareCandidate(a, b) {
  const rank = (row) => row.health.condition === "available" ? 0 : row.health.condition === "degraded" ? 1 : 2;
  return rank(a) - rank(b)
    || known(a.qualification.evidence.expectedCostUsd) - known(b.qualification.evidence.expectedCostUsd)
    || known(a.qualification.evidence.p95Ms) - known(b.qualification.evidence.p95Ms)
    || a.workerRef.localeCompare(b.workerRef);
}
function compareQualification(a, b) { return qualificationKey(a.workerRef, a.stationRef, a.taskFamily).localeCompare(qualificationKey(b.workerRef, b.stationRef, b.taskFamily)); }
function qualificationKey(worker, station, family) { return `${worker}\u0000${station}\u0000${family}`; }
function known(value) { return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY; }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, keys, label) { const allowed = new Set(keys); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); const missing = keys.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`); }
function text(value, label) { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function pattern(value, regex, label) { const result = text(value, label); if (!regex.test(result)) throw new Error(`invalid ${label}: ${result}`); return result; }
function oneOf(value, allowed, label) { const result = String(value ?? "").trim(); if (!allowed.has(result)) throw new Error(`invalid ${label}: ${result}`); return result; }
function positiveInteger(value, label) { return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label); }
function boundedInteger(value, min, max, label) { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}`); return number; }
function nonNegative(value, label) { const number = Number(value); if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be non-negative`); return number; }
function nullableNonNegative(value, label) { return value === null ? null : nonNegative(value, label); }
function stringSet(value, label) { if (!Array.isArray(value)) throw new Error(`${label}s must be an array`); const rows = [...new Set(value.map((item) => pattern(item, TOKEN, label)))].sort(); return rows; }
function hashRefs(value, label) { if (!Array.isArray(value)) throw new Error(`${label}s must be an array`); return [...new Set(value.map((item) => pattern(item, /^sha256:[a-f0-9]{64}$/, label)))].sort(); }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function percentile(values, fraction) { return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] : null; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
