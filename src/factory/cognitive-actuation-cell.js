import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalEncode } from "./fact-fabric.js";
import { admitCognitiveWorkpiece, CognitiveActuatorRegistry, issueCognitiveActuationPermit, sha256Bytes } from "./cognitive-actuator.js";
import { runFactoryVerifier } from "./coding-cell.js";

/** Compile a JSON bill of process against the exact installed machine rack. */
export function defineCognitiveActuationRecipe(value, { registry } = {}) {
  if (!(registry instanceof CognitiveActuatorRegistry)) throw new TypeError("cognitive actuation recipe requires a machine registry");
  if (value?.ref && Array.isArray(value.steps) && value.steps.every((step) => typeof step?.actuatorRef === "string")) {
    const source = { ...value, steps: value.steps.map(({ actuatorRef, operation: _operation, ...step }) => ({ ...step, actuator: actuatorRef })) };
    delete source.ref;
    const compiled = defineCognitiveActuationRecipe(source, { registry });
    if (compiled.ref !== value.ref) throw new Error("cognitive actuation recipe content hash does not match");
    return compiled;
  }
  exact(value, ["schema", "kind", "id", "version", "title", "task", "steps", "finalVerification"], "cognitive actuation recipe", ["ref"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-cognitive-actuation-recipe") throw new Error("cognitive actuation recipe must use schema 1");
  if (!Array.isArray(value.steps) || !value.steps.length) throw new Error("cognitive actuation recipe requires steps");
  const ids = new Set();
  const steps = value.steps.map((row, index) => {
    exact(row, ["id", "actuator", "targetPath", "parameters", "verification"], `cognitive actuation step ${index}`);
    const id = token(row.id, `cognitive actuation step ${index} id`); if (ids.has(id)) throw new Error(`duplicate cognitive actuation step: ${id}`); ids.add(id);
    const machine = registry.get(text(row.actuator, `cognitive actuation step ${id} actuator`));
    if (!machine) throw new Error(`cognitive actuation step ${id} references an uninstalled machine: ${row.actuator}`);
    if (!row.parameters || typeof row.parameters !== "object" || Array.isArray(row.parameters)) throw new TypeError(`cognitive actuation step ${id} parameters must be an object`);
    return { id, actuatorRef: machine.ref, operation: machine.operation, targetPath: relativePath(row.targetPath, `cognitive actuation step ${id} target`), parameters: structuredClone(row.parameters), verification: text(row.verification, `cognitive actuation step ${id} verification`) };
  });
  const body = { schema: 1, kind: value.kind, id: token(value.id, "cognitive actuation recipe id"), version: positive(value.version, "cognitive actuation recipe version"), title: text(value.title, "cognitive actuation recipe title"), task: text(value.task, "cognitive actuation recipe task"), steps, finalVerification: text(value.finalVerification, "cognitive actuation final verification") };
  const ref = `cognitive-actuation-recipe:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref && value.ref !== ref) throw new Error("cognitive actuation recipe content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** Same backend projection used by reports and future floor integration. */
export function projectCognitiveActuationRecipe(recipe, { frames = [] } = {}) {
  if (!recipe || typeof recipe.ref !== "string" || !Array.isArray(recipe.steps)) throw new TypeError("compiled cognitive actuation recipe required");
  const state = new Map(frames.filter((frame) => frame.stepId).map((frame) => [frame.stepId, frame]));
  return deepFreeze({ schema: "bantam.factory.cognitive-actuation-projection.v1", kind: "bantam.factory-cognitive-actuation-projection", recipeRef: recipe.ref, title: recipe.title, task: recipe.task, status: frames.at(-1)?.lineStatus ?? "planned", nodes: recipe.steps.map((step, index) => ({ ...step, ordinal: index + 1, state: state.get(step.id)?.state ?? "planned", permitId: state.get(step.id)?.permitId ?? null, workpieceId: state.get(step.id)?.workpieceId ?? null, actuationId: state.get(step.id)?.actuationId ?? null, verification: state.get(step.id)?.verification ?? null })), finalVerification: recipe.finalVerification, frames: frames.length });
}

/**
 * Run a multi-machine article. Model output is injectable; default workpieces
 * come from the recipe for deterministic qualification and demonstrations.
 */
export async function runCognitiveActuationRecipe({ workspace, recipe: source, registry, worker = recipeWorker, verifier = runFactoryVerifier, verificationTimeoutMs = 120_000 } = {}) {
  if (!(registry instanceof CognitiveActuatorRegistry)) throw new TypeError("cognitive actuation run requires a machine registry");
  if (typeof worker !== "function" || typeof verifier !== "function") throw new TypeError("cognitive actuation worker and verifier must be functions");
  const root = fs.realpathSync(text(workspace, "cognitive actuation workspace"));
  const recipe = defineCognitiveActuationRecipe(source, { registry });
  const baselineFingerprint = fingerprint(root), backups = captureTargets(root, recipe.steps), frames = [], actuations = [], workpieces = [], permits = [], verifications = [];
  const emit = (frame) => { const body = { seq: frames.length + 1, ...frame }; frames.push(deepFreeze({ ...body, frameId: `cognitive-actuation-frame:sha256:${digest(body)}` })); };
  emit({ type: "article-started", state: "running", lineStatus: "running", chassisFingerprint: baselineFingerprint, recipeRef: recipe.ref });
  let failure = null;
  try {
    for (const step of recipe.steps) {
      const machine = registry.get(step.actuatorRef), chassisFingerprint = fingerprint(root), bytes = readTarget(root, step.targetPath);
      const permit = issueCognitiveActuationPermit({ actuator: machine, chassisFingerprint, articleId: `${recipe.id}-${step.id}`, targets: [{ path: step.targetPath, sha256: sha256Bytes(bytes) }] }); permits.push(permit);
      emit({ type: "step-dispatched", stepId: step.id, state: "dispatched", lineStatus: "running", chassisFingerprint, permitId: permit.permitId, actuatorRef: machine.ref });
      const answer = await worker({ recipe, step, actuator: machine, permit, source: bytes.toString("utf8") });
      const workpiece = admitCognitiveWorkpiece({ answer, actuator: machine, permit }); workpieces.push(workpiece);
      if (workpiece.disposition !== "admitted-for-actuation") throw stationError(step.id, "workpiece-contained", workpiece.reasons.join(", "));
      emit({ type: "workpiece-admitted", stepId: step.id, state: "admitted", lineStatus: "running", chassisFingerprint, permitId: permit.permitId, workpieceId: workpiece.workpieceId });
      const actuation = registry.execute({ workspace: root, permit, workpiece }); actuations.push(actuation);
      emit({ type: "chassis-actuated", stepId: step.id, state: "awaiting-inspection", lineStatus: "running", chassisFingerprint: fingerprint(root), permitId: permit.permitId, workpieceId: workpiece.workpieceId, actuationId: actuation.actuationId });
      const verification = await verifier(root, step.verification, verificationTimeoutMs); verifications.push({ stepId: step.id, ...summarizeVerification(verification) });
      if (!verification?.pass) throw stationError(step.id, "verification-failed", verification?.detail ?? "verification failed");
      emit({ type: "step-released", stepId: step.id, state: "released", lineStatus: "running", chassisFingerprint: fingerprint(root), permitId: permit.permitId, workpieceId: workpiece.workpieceId, actuationId: actuation.actuationId, verification: summarizeVerification(verification) });
    }
    const final = await verifier(root, recipe.finalVerification, verificationTimeoutMs); verifications.push({ stepId: null, final: true, ...summarizeVerification(final) });
    if (!final?.pass) throw stationError(null, "final-verification-failed", final?.detail ?? "final verification failed");
    const audit = auditScope(root, backups, recipe.steps);
    if (audit.scopeViolations.length || audit.changed.length === 0) throw stationError(null, "scope-audit-failed", audit.scopeViolations.join(", ") || "no product change");
    emit({ type: "article-released", state: "released", lineStatus: "released", chassisFingerprint: fingerprint(root), verification: summarizeVerification(final), audit });
    return result({ recipe, baselineFingerprint, finalFingerprint: fingerprint(root), status: "released", frames, permits, workpieces, actuations, verifications, audit, rollback: null, failure: null });
  } catch (error) {
    failure = { stepId: error.stepId ?? null, code: error.code ?? "infrastructure", message: error.message };
    const rollback = restoreTargets(root, backups);
    emit({ type: "andon-raised", stepId: failure.stepId, state: "contained", lineStatus: "line-stop", chassisFingerprint: fingerprint(root), failure });
    emit({ type: "article-rolled-back", stepId: failure.stepId, state: "contained", lineStatus: "contained", chassisFingerprint: fingerprint(root), rollback });
    return result({ recipe, baselineFingerprint, finalFingerprint: fingerprint(root), status: "contained", frames, permits, workpieces, actuations, verifications, audit: auditScope(root, backups, recipe.steps), rollback, failure });
  }
}

async function recipeWorker({ step, actuator, permit }) { return { status: "completed", permitId: permit.permitId, actuatorRef: actuator.ref, targetPath: step.targetPath, parameters: structuredClone(step.parameters) }; }
function result(value) { const body = { schema: "bantam.factory.cognitive-actuation-result.v1", kind: "bantam.factory-cognitive-actuation-result", ...value }; return deepFreeze({ ...body, resultId: `cognitive-actuation-result:sha256:${digest(body)}` }); }
function stationError(stepId, code, detail) { const error = new Error(`${code}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`); error.stepId = stepId; error.code = code; return error; }
function summarizeVerification(value) { return { pass: value?.pass === true, status: value?.status ?? null, exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null, durationMs: Number.isFinite(value?.durationMs) ? value.durationMs : null, command: value?.command ?? null, detail: typeof value?.detail === "string" ? value.detail.slice(-2000) : "" }; }
function captureTargets(root, steps) { for (const targetPath of [...new Set(steps.map((step) => step.targetPath))]) { const stat = fs.lstatSync(safeTarget(root, targetPath)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`recipe target must be a regular non-symlink file: ${targetPath}`); } const result = {}; for (const targetPath of files(root)) { const absolute = safeTarget(root, targetPath), stat = fs.lstatSync(absolute), bytes = fs.readFileSync(absolute); result[targetPath] = { bytes: bytes.toString("base64"), mode: stat.mode & 0o777, sha256: sha256Bytes(bytes) }; } return result; }
function restoreTargets(root, backups) { const current = new Set(files(root)), restored = [], removed = []; for (const targetPath of current) if (!Object.hasOwn(backups, targetPath)) { fs.rmSync(safeTarget(root, targetPath)); removed.push(targetPath); } for (const [targetPath, backup] of Object.entries(backups)) { const absolute = safeTarget(root, targetPath); fs.mkdirSync(path.dirname(absolute), { recursive: true }); const temp = `${absolute}.bantam-rollback-${process.pid}-${crypto.randomBytes(6).toString("hex")}`; fs.writeFileSync(temp, Buffer.from(backup.bytes, "base64"), { flag: "wx", mode: backup.mode }); fs.renameSync(temp, absolute); restored.push(targetPath); } const exact = canonicalEncode(treeHashes(root)) === canonicalEncode(Object.fromEntries(Object.entries(backups).map(([key, value]) => [key, value.sha256]))); return { exact, restored, removed }; }
function auditScope(root, backups, steps) { const before = Object.fromEntries(Object.entries(backups).map(([key, value]) => [key, value.sha256])), after = treeHashes(root), paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(), changed = paths.filter((key) => before[key] !== after[key]), added = changed.filter((key) => !Object.hasOwn(before, key)), removed = changed.filter((key) => !Object.hasOwn(after, key)), allowed = [...new Set(steps.map((step) => step.targetPath))].sort(); return { changed, added, removed, allowed, scopeViolations: changed.filter((key) => !allowed.includes(key)) }; }
function fingerprint(root) { const rows = {}; for (const file of files(root)) rows[file] = sha256Bytes(fs.readFileSync(path.join(root, file))); return `workspace:sha256:${digest(rows)}`; }
function files(root) { const output = [], stack = [root]; while (stack.length) { const directory = stack.pop(); for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if (entry.name === ".bantam") continue; const absolute = path.join(directory, entry.name); if (entry.isDirectory()) stack.push(absolute); else if (entry.isFile() && !entry.isSymbolicLink()) output.push(path.relative(root, absolute).split(path.sep).join("/")); } } return output.sort(); }
function treeHashes(root) { return Object.fromEntries(files(root).map((file) => [file, sha256Bytes(fs.readFileSync(path.join(root, file)))])); }
function readTarget(root, targetPath) { return fs.readFileSync(safeTarget(root, targetPath)); }
function safeTarget(root, targetPath) { const absolute = path.resolve(root, relativePath(targetPath, "recipe target")); if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error("recipe target escapes workspace"); return absolute; }
function relativePath(value, label) { const result = text(value, label).replaceAll("\\", "/"); if (result.startsWith("/") || result.split("/").includes("..") || result === ".") throw new Error(`${label} must be workspace-relative`); return result; }
function exact(value, fields, label, optional = []) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); const allowed = [...fields, ...optional], unknown = Object.keys(value).filter((key) => !allowed.includes(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function token(value, label) { const result = text(value, label); if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error(`${label} has invalid format`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
