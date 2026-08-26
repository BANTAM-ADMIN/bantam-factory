import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalEncode } from "./fact-fabric.js";

const ASSET_KIND = "bantam.factory-cognitive-actuator";
const TOKEN = /^[a-z][a-z0-9-]*$/;
const REF = /^cognitive-actuator:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{64}$/;
const TYPES = new Set(["string", "integer", "boolean", "string-array"]);

/** A machine tool definition: immutable die, limits, adapter identity, authority. */
export function defineCognitiveActuatorAsset(value) {
  exact(value, ["schema", "kind", "id", "version", "title", "purpose", "operation", "adapter", "inputDie", "limits", "authority", "presentation"], "cognitive actuator asset", ["ref"]);
  if (value.schema !== 1 || value.kind !== ASSET_KIND) throw new Error("cognitive actuator asset must use schema 1");
  const body = {
    schema: 1,
    kind: ASSET_KIND,
    id: token(value.id, "actuator id"),
    version: positive(value.version, "actuator version"),
    title: text(value.title, "actuator title"),
    purpose: text(value.purpose, "actuator purpose"),
    operation: token(value.operation, "actuator operation"),
    adapter: text(value.adapter, "actuator adapter"),
    inputDie: normalizeDie(value.inputDie),
    limits: normalizeLimits(value.limits),
    authority: normalizeAuthority(value.authority),
    presentation: normalizePresentation(value.presentation),
  };
  const ref = `cognitive-actuator:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref && value.ref !== ref) throw new Error("cognitive actuator content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** One execution capability, bound to exact machine, chassis, and target bytes. */
export function issueCognitiveActuationPermit({ actuator, chassisFingerprint, articleId, targets } = {}) {
  const machine = defineCognitiveActuatorAsset(actuator);
  if (!Array.isArray(targets) || !targets.length || targets.length > machine.limits.maxTargets) throw new Error(`actuation permit requires 1..${machine.limits.maxTargets} targets`);
  const normalizedTargets = targets.map((row, index) => {
    exact(row, ["path", "sha256"], `actuation permit target ${index}`);
    const targetPath = relativePath(row.path, `actuation permit target ${index} path`);
    if (!SHA.test(row.sha256)) throw new Error(`actuation permit target ${index} sha256 is invalid`);
    return { path: targetPath, sha256: row.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(normalizedTargets.map((row) => row.path)).size !== normalizedTargets.length) throw new Error("actuation permit targets must be unique");
  const body = {
    schema: "bantam.factory.cognitive-actuation-permit.v1",
    kind: "bantam.factory-cognitive-actuation-permit",
    actuatorRef: machine.ref,
    operation: machine.operation,
    chassisFingerprint: text(chassisFingerprint, "actuation chassis fingerprint"),
    articleId: token(articleId, "actuation article id"),
    targets: normalizedTargets,
    authority: { execute: "granted", release: "withheld", uses: 1 },
  };
  return deepFreeze({ ...body, permitId: `cognitive-actuation-permit:sha256:${digest(body)}` });
}

/** Convert model output into material. This performs no workspace mutation. */
export function admitCognitiveWorkpiece({ answer, actuator, permit } = {}) {
  const machine = defineCognitiveActuatorAsset(actuator);
  const ticket = normalizePermit(permit);
  const reasons = [];
  const row = answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
  const allowed = ["status", "permitId", "actuatorRef", "targetPath", "parameters"];
  const unknown = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unknown.length) reasons.push(`unknown-answer-fields:${unknown.sort().join(",")}`);
  if (row.status !== "completed") reasons.push("worker-not-completed");
  if (row.permitId !== ticket.permitId) reasons.push("permit-mismatch");
  if (row.actuatorRef !== machine.ref || ticket.actuatorRef !== machine.ref) reasons.push("actuator-mismatch");
  if (!ticket.targets.some((target) => target.path === row.targetPath)) reasons.push("target-out-of-scope");
  const parameterInspection = inspectParameters(row.parameters, machine.inputDie);
  reasons.push(...parameterInspection.reasons);
  const body = {
    schema: "bantam.factory.cognitive-workpiece.v1",
    kind: "bantam.factory-cognitive-workpiece",
    permitId: ticket.permitId,
    actuatorRef: machine.ref,
    articleId: ticket.articleId,
    targetPath: typeof row.targetPath === "string" ? row.targetPath : null,
    parameters: parameterInspection.parameters,
    disposition: reasons.length ? "contained" : "admitted-for-actuation",
    reasons,
  };
  return deepFreeze({ ...body, workpieceId: `cognitive-workpiece:sha256:${digest(body)}` });
}

export class CognitiveActuatorRegistry {
  constructor() { this.assets = new Map(); this.adapters = new Map(); }

  install(value, adapter) {
    const asset = defineCognitiveActuatorAsset(value);
    if (typeof adapter !== "function") throw new TypeError("cognitive actuator adapter must be a function");
    const key = `${asset.id}@${asset.version}`, existing = this.assets.get(key);
    if (existing && existing.ref !== asset.ref) throw new Error(`cognitive actuator ${key} is installed with different bytes`);
    if (existing && this.adapters.get(existing.ref) !== adapter) throw new Error(`cognitive actuator ${key} adapter identity changed`);
    this.assets.set(key, asset); this.adapters.set(asset.ref, adapter);
    return asset;
  }

  get(reference) {
    if (typeof reference !== "string") return null;
    if (REF.test(reference)) return [...this.assets.values()].find((asset) => asset.ref === reference) ?? null;
    return this.assets.get(reference) ?? null;
  }

  list() { return [...this.assets.values()].sort((a, b) => a.ref.localeCompare(b.ref)); }

  /** Execute admitted material through a fitted adapter and atomically move one target. */
  execute({ workspace, permit, workpiece } = {}) {
    const root = fs.realpathSync(text(workspace, "actuator workspace"));
    const ticket = normalizePermit(permit);
    const machine = this.get(ticket.actuatorRef);
    if (!machine) throw new Error(`actuation permit references an uninstalled machine: ${ticket.actuatorRef}`);
    const material = normalizeWorkpiece(workpiece);
    if (material.disposition !== "admitted-for-actuation" || material.permitId !== ticket.permitId || material.actuatorRef !== machine.ref) throw new Error("actuator refused unadmitted or mismatched workpiece");
    if (ticket.targets.length !== 1 || material.targetPath !== ticket.targets[0].path) throw new Error("actuator currently requires one exact permitted target");
    const target = safeTarget(root, material.targetPath), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("actuator target must be a regular non-symlink file");
    const before = fs.readFileSync(target), beforeHash = sha256(before);
    if (before.length > machine.limits.maxInputBytes) throw new Error("actuator input violates machine byte limits");
    if (beforeHash !== ticket.targets[0].sha256) throw new Error("actuator refused stale target baseline");
    const adapter = this.adapters.get(machine.ref), started = process.hrtime.bigint();
    const output = adapter({ source: before.toString("utf8"), path: material.targetPath, parameters: structuredClone(material.parameters), asset: machine });
    if (typeof output !== "string") throw new TypeError("cognitive actuator adapter must return replacement text");
    const bytes = Buffer.from(output, "utf8");
    if (!bytes.length || bytes.length > machine.limits.maxOutputBytes) throw new Error("actuator output violates machine byte limits");
    const afterHash = sha256(bytes);
    if (afterHash === beforeHash) throw new Error("actuator refused a byte-identical product");
    const temp = path.join(path.dirname(target), `.bantam-actuator-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    try {
      fs.writeFileSync(temp, bytes, { flag: "wx", mode: stat.mode & 0o777 });
      fs.renameSync(temp, target);
    } finally { try { fs.rmSync(temp, { force: true }); } catch { /* renamed or best effort */ } }
    const body = { schema: "bantam.factory.cognitive-actuation-record.v1", kind: "bantam.factory-cognitive-actuation-record", permitId: ticket.permitId, workpieceId: material.workpieceId, actuatorRef: machine.ref, operation: machine.operation, targetPath: material.targetPath, beforeSha256: beforeHash, afterSha256: afterHash, bytes: bytes.length, releaseAuthority: "withheld" };
    return deepFreeze({ ...body, actuationId: `cognitive-actuation-record:sha256:${digest(body)}`, telemetry: { durationMs: Number(process.hrtime.bigint() - started) / 1e6 } });
  }
}

export function sha256Bytes(value) { return sha256(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); }

function normalizeDie(value) {
  exact(value, ["schema", "kind", "fields", "additionalProperties"], "actuator input die");
  if (value.schema !== 1 || value.kind !== "bantam.factory-actuator-input-die" || value.additionalProperties !== false) throw new Error("actuator input die must be closed schema 1");
  if (!Array.isArray(value.fields) || !value.fields.length) throw new Error("actuator input die requires fields");
  const names = new Set();
  const fields = value.fields.map((row, index) => {
    exact(row, ["name", "type", "required"], `actuator die field ${index}`, ["minLength", "maxLength", "pattern", "enum"]);
    const name = token(row.name, `actuator die field ${index} name`);
    if (names.has(name)) throw new Error(`duplicate actuator die field: ${name}`); names.add(name);
    if (!TYPES.has(row.type)) throw new Error(`unsupported actuator die type: ${row.type}`);
    const field = { name, type: row.type, required: row.required === true };
    if (row.minLength !== undefined) field.minLength = nonnegative(row.minLength, `${name} minLength`);
    if (row.maxLength !== undefined) field.maxLength = positive(row.maxLength, `${name} maxLength`);
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) throw new Error(`${name} length limits are reversed`);
    if (row.pattern !== undefined) { text(row.pattern, `${name} pattern`); new RegExp(row.pattern); field.pattern = row.pattern; }
    if (row.enum !== undefined) { if (!Array.isArray(row.enum) || !row.enum.length || !row.enum.every((entry) => typeof entry === "string")) throw new Error(`${name} enum must contain strings`); field.enum = [...new Set(row.enum)].sort(); }
    return field;
  });
  return { schema: 1, kind: value.kind, fields, additionalProperties: false };
}
function normalizeLimits(value) { exact(value, ["maxInputBytes", "maxOutputBytes", "maxTargets"], "actuator limits"); return { maxInputBytes: positive(value.maxInputBytes, "max input bytes"), maxOutputBytes: positive(value.maxOutputBytes, "max output bytes"), maxTargets: positive(value.maxTargets, "max targets") }; }
function normalizeAuthority(value) { exact(value, ["execute", "release"], "actuator authority"); if (value.execute !== "fitted-only" || value.release !== "withheld") throw new Error("actuator authority must be fitted-only with release withheld"); return { execute: value.execute, release: value.release }; }
function normalizePresentation(value) { exact(value, ["icon", "color", "group"], "actuator presentation"); return { icon: text(value.icon, "actuator icon"), color: text(value.color, "actuator color"), group: text(value.group, "actuator group") }; }
function normalizePermit(value) { if (!value || value.schema !== "bantam.factory.cognitive-actuation-permit.v1" || typeof value.permitId !== "string") throw new TypeError("cognitive actuation permit required"); const { permitId, ...body } = value; if (permitId !== `cognitive-actuation-permit:sha256:${digest(body)}`) throw new Error("cognitive actuation permit content hash mismatch"); return value; }
function normalizeWorkpiece(value) { if (!value || value.schema !== "bantam.factory.cognitive-workpiece.v1" || typeof value.workpieceId !== "string") throw new TypeError("cognitive workpiece required"); const { workpieceId, ...body } = value; if (workpieceId !== `cognitive-workpiece:sha256:${digest(body)}`) throw new Error("cognitive workpiece content hash mismatch"); return value; }
function inspectParameters(value, die) {
  const reasons = [], row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (row !== value) reasons.push("parameters-not-object");
  const allowed = new Set(die.fields.map((field) => field.name));
  const unknown = Object.keys(row).filter((key) => !allowed.has(key)).sort(); if (unknown.length) reasons.push(`unknown-parameters:${unknown.join(",")}`);
  const normalized = {};
  for (const field of die.fields) {
    const present = Object.hasOwn(row, field.name), item = row[field.name];
    if (!present) { if (field.required) reasons.push(`missing-parameter:${field.name}`); continue; }
    if (!validType(item, field.type)) { reasons.push(`invalid-type:${field.name}`); continue; }
    const lengths = field.type === "string" ? [item.length] : field.type === "string-array" ? item.map((entry) => entry.length) : [];
    if (field.minLength !== undefined && lengths.some((length) => length < field.minLength)) reasons.push(`too-short:${field.name}`);
    if (field.maxLength !== undefined && lengths.some((length) => length > field.maxLength)) reasons.push(`too-long:${field.name}`);
    if (field.pattern && (field.type !== "string" || !new RegExp(field.pattern).test(item))) reasons.push(`pattern-mismatch:${field.name}`);
    if (field.enum && !field.enum.includes(item)) reasons.push(`enum-mismatch:${field.name}`);
    normalized[field.name] = structuredClone(item);
  }
  return { reasons, parameters: normalized };
}
function validType(value, type) { if (type === "string") return typeof value === "string"; if (type === "integer") return Number.isInteger(value); if (type === "boolean") return typeof value === "boolean"; return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function safeTarget(root, targetPath) { const absolute = path.resolve(root, relativePath(targetPath, "actuator target")); if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error("actuator target escapes workspace"); const parent = fs.realpathSync(path.dirname(absolute)); if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("actuator target parent escapes workspace"); return absolute; }
function relativePath(value, label) { const result = text(value, label).replaceAll("\\", "/"); if (result.startsWith("/") || result.split("/").includes("..") || result === ".") throw new Error(`${label} must be workspace-relative`); return result; }
function exact(value, fields, label, optional = []) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); const allowed = [...fields, ...optional], unknown = Object.keys(value).filter((key) => !allowed.includes(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function token(value, label) { const result = text(value, label); if (!TOKEN.test(result)) throw new Error(`${label} has invalid format`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function nonnegative(value, label) { if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function digest(value) { return sha256(canonicalEncode(value)); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
