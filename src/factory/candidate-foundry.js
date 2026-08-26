import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";

const TASK_KIND = "bantam.factory-candidate-press-task";
const TOKEN = /^[a-z][a-z0-9-]*$/;
const FIELD_TYPES = new Set(["string", "boolean", "integer", "string-array"]);

/** A content-addressed contract for high-volume, mechanically filtered model output. */
export function defineCandidatePressTask(value) {
  exact(value, ["schema", "kind", "id", "version", "title", "purpose", "candidateDie", "limits", "release"], "candidate press task", ["ref"]);
  if (value.schema !== 1 || value.kind !== TASK_KIND) throw new Error("candidate press task must use schema 1");
  const body = {
    schema: 1,
    kind: TASK_KIND,
    id: token(value.id, "candidate press task id"),
    version: positive(value.version, "candidate press task version"),
    title: text(value.title, "candidate press task title"),
    purpose: text(value.purpose, "candidate press task purpose"),
    candidateDie: normalizeDie(value.candidateDie),
    limits: normalizeLimits(value.limits),
    release: normalizeRelease(value.release),
  };
  const ref = `candidate-press-task:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref && value.ref !== ref) throw new Error("candidate press task content hash does not match");
  return deepFreeze({ ...body, ref });
}

/**
 * Run one candidate-producing worker behind a closed die and an independent
 * gauge. The worker never decides which candidates are useful or releasable.
 */
export async function runCandidatePress({ task: value, produce, gauge } = {}) {
  const task = defineCandidatePressTask(value);
  if (typeof produce !== "function") throw new TypeError("candidate press producer must be a function");
  if (typeof gauge !== "function") throw new TypeError("candidate press gauge must be a function");
  const started = process.hrtime.bigint();
  const production = await produce({ task });
  const answer = production?.answer;
  const emitted = answer && typeof answer === "object" && !Array.isArray(answer) && Array.isArray(answer.candidates)
    ? answer.candidates
    : [];
  const overflow = Math.max(0, emitted.length - task.limits.maxCandidates);
  const bounded = emitted.slice(0, task.limits.maxCandidates);
  const seen = new Set();
  const inspections = [];
  let verificationNs = 0n;

  for (let index = 0; index < bounded.length; index += 1) {
    const candidate = bounded[index];
    const dieReasons = inspectCandidate(candidate, task.candidateDie);
    let key = null;
    let duplicate = false;
    if (!dieReasons.length) {
      key = canonicalEncode(candidate);
      duplicate = seen.has(key);
      seen.add(key);
    }
    if (duplicate) {
      inspections.push(deepFreeze({ index, candidate: structuredClone(candidate), disposition: "rejected", reasons: ["duplicate-candidate"], proof: null }));
      continue;
    }
    if (dieReasons.length) {
      inspections.push(deepFreeze({ index, candidate: safeClone(candidate), disposition: "rejected", reasons: dieReasons, proof: null }));
      continue;
    }
    const gaugeStarted = process.hrtime.bigint();
    const result = normalizeGaugeResult(await gauge(structuredClone(candidate), { index, task }));
    verificationNs += process.hrtime.bigint() - gaugeStarted;
    inspections.push(deepFreeze({
      index,
      candidate: structuredClone(candidate),
      disposition: result.accepted ? "accepted" : "rejected",
      reasons: result.reasons,
      proof: result.proof,
    }));
  }

  const accepted = inspections.filter((row) => row.disposition === "accepted");
  const schemaAdmitted = inspections.filter((row) => !row.reasons.some((reason) => reason.startsWith("die:"))).length;
  const unique = inspections.filter((row) => !row.reasons.includes("duplicate-candidate") && !row.reasons.some((reason) => reason.startsWith("die:"))).length;
  const modelMs = finiteNonnegative(production?.telemetry?.elapsedMs) ?? 0;
  const verificationMs = Number(verificationNs) / 1e6;
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const released = accepted.length >= task.release.minAccepted && new Set(accepted.map((row) => canonicalEncode(row.candidate))).size >= task.release.minUniqueAccepted;
  const body = {
    schema: "bantam.factory.candidate-press-article.v1",
    kind: "bantam.factory-candidate-press-article",
    taskRef: task.ref,
    disposition: released ? "released" : "contained",
    summary: {
      emitted: emitted.length,
      inspected: inspections.length,
      overflow,
      schemaAdmitted,
      unique,
      accepted: accepted.length,
      rejected: inspections.length - accepted.length + overflow,
      acceptanceRate: inspections.length ? accepted.length / inspections.length : 0,
      uniqueAcceptanceRate: unique ? accepted.length / unique : 0,
    },
    telemetry: {
      modelMs,
      verificationMs,
      wallMs,
      promptTokens: integerNonnegative(production?.telemetry?.promptTokens) ?? 0,
      completionTokens: integerNonnegative(production?.telemetry?.completionTokens) ?? 0,
      completionTokensPerSecond: modelMs > 0 ? ((integerNonnegative(production?.telemetry?.completionTokens) ?? 0) / (modelMs / 1000)) : 0,
      acceptedPerSecond: wallMs > 0 ? accepted.length / (wallMs / 1000) : 0,
    },
    inspections,
  };
  return deepFreeze({ ...body, articleId: `candidate-press-article:sha256:${digest(body)}` });
}

function normalizeDie(value) {
  exact(value, ["schema", "kind", "fields", "additionalProperties"], "candidate die");
  if (value.schema !== 1 || value.kind !== "bantam.factory-candidate-die" || value.additionalProperties !== false) throw new Error("candidate die must be closed schema 1");
  if (!Array.isArray(value.fields) || !value.fields.length) throw new Error("candidate die requires fields");
  const names = new Set();
  const fields = value.fields.map((row, index) => {
    exact(row, ["name", "type", "required"], `candidate die field ${index}`, ["enum", "minLength", "maxLength"]);
    const name = token(row.name, `candidate die field ${index} name`);
    if (names.has(name)) throw new Error(`duplicate candidate die field: ${name}`);
    names.add(name);
    if (!FIELD_TYPES.has(row.type)) throw new Error(`unsupported candidate die type: ${row.type}`);
    const field = { name, type: row.type, required: row.required === true };
    if (row.enum !== undefined) {
      if (!Array.isArray(row.enum) || !row.enum.length || !row.enum.every((item) => typeof item === "string")) throw new Error(`${name} enum must contain strings`);
      field.enum = [...new Set(row.enum)].sort();
    }
    if (row.minLength !== undefined) field.minLength = nonnegative(row.minLength, `${name} minLength`);
    if (row.maxLength !== undefined) field.maxLength = positive(row.maxLength, `${name} maxLength`);
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) throw new Error(`${name} length limits are reversed`);
    return field;
  });
  return { schema: 1, kind: value.kind, fields, additionalProperties: false };
}

function normalizeLimits(value) {
  exact(value, ["maxCandidates"], "candidate press limits");
  return { maxCandidates: positive(value.maxCandidates, "candidate press max candidates") };
}

function normalizeRelease(value) {
  exact(value, ["minAccepted", "minUniqueAccepted"], "candidate press release");
  const result = {
    minAccepted: nonnegative(value.minAccepted, "candidate press minimum accepted"),
    minUniqueAccepted: nonnegative(value.minUniqueAccepted, "candidate press minimum unique accepted"),
  };
  if (result.minAccepted > result.minUniqueAccepted) throw new Error("minimum accepted cannot exceed minimum unique accepted");
  return result;
}

function inspectCandidate(value, die) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return ["die:candidate-not-plain-object"];
  const allowed = new Set(die.fields.map((field) => field.name));
  const reasons = Object.keys(value).filter((key) => !allowed.has(key)).sort().map((key) => `die:unknown-field:${key}`);
  for (const field of die.fields) {
    if (!Object.hasOwn(value, field.name)) {
      if (field.required) reasons.push(`die:missing-field:${field.name}`);
      continue;
    }
    const item = value[field.name];
    if (!validType(item, field.type)) { reasons.push(`die:invalid-type:${field.name}`); continue; }
    if (field.enum && field.type === "string" && !field.enum.includes(item)) reasons.push(`die:enum:${field.name}`);
    if (field.enum && field.type === "string-array" && item.some((entry) => !field.enum.includes(entry))) reasons.push(`die:enum:${field.name}`);
    const lengths = field.type === "string" ? [item.length] : field.type === "string-array" ? item.map((entry) => entry.length) : [];
    if (field.minLength !== undefined && lengths.some((length) => length < field.minLength)) reasons.push(`die:too-short:${field.name}`);
    if (field.maxLength !== undefined && lengths.some((length) => length > field.maxLength)) reasons.push(`die:too-long:${field.name}`);
  }
  return reasons;
}

function normalizeGaugeResult(value) {
  exact(value, ["accepted", "reasons", "proof"], "candidate gauge result");
  if (typeof value.accepted !== "boolean") throw new TypeError("candidate gauge accepted must be boolean");
  if (!Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === "string" && reason.length)) throw new TypeError("candidate gauge reasons must be strings");
  if (value.accepted && value.reasons.length) throw new Error("accepted candidate cannot carry rejection reasons");
  canonicalEncode(value.proof);
  return { accepted: value.accepted, reasons: [...value.reasons], proof: structuredClone(value.proof) };
}

function exact(value, fields, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
  const allowed = [...fields, ...optional];
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (missing.length || unknown.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`);
}
function validType(value, type) { if (type === "string") return typeof value === "string"; if (type === "boolean") return typeof value === "boolean"; if (type === "integer") return Number.isInteger(value); return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function token(value, label) { const result = text(value, label); if (!TOKEN.test(result)) throw new Error(`${label} has invalid format`); return result; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function nonnegative(value, label) { if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`); return value; }
function integerNonnegative(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function finiteNonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function safeClone(value) { try { return structuredClone(value); } catch { return null; } }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
