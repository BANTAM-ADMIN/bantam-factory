import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../journal.js";
import { compileFactoryBlueprint, runFactoryBlueprint } from "./blueprint.js";
import { gaugeRef } from "./compatibility-line.js";
import { validateSemanticObject } from "./semantic-object.js";
import { evaluateSemanticSensorQualification, validateSemanticSensorQualificationReport } from "./semantic-sensor-qualification.js";
import { defineStationAsset } from "./station-registry.js";

export const SEMANTIC_REVIEW_LANES = Object.freeze([
  "filesystem_write", "process_execution", "persistent_state_mutation",
  "authority_gate", "release_or_promotion", "rollback_or_recovery",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/semantic-sensor-qualification-cell.json", import.meta.url)), "utf8"));
const CHANGE_ORDER = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../examples/factory/semantic-reviewed-gauge-change-order.json", import.meta.url)), "utf8"));

export function semanticReviewedGaugeStationAsset() { return defineStationAsset(CHANGE_ORDER.requestedStation); }
export function semanticSensorQualificationLine() {
  const compiled = compileFactoryBlueprint(BLUEPRINT_SOURCE);
  if (compiled.assets.gauge.ref !== semanticReviewedGaugeStationAsset().ref) throw new Error("semantic qualification line gauge has drifted from the foundry product");
  return compiled;
}

export function defineSemanticReviewedRack(value) {
  const row = record(value, "semantic reviewed rack");
  const fields = ["schema", "kind", "rubric", "units"];
  exact(row, Object.hasOwn(row, "ref") ? [...fields, "ref"] : fields, "semantic reviewed rack");
  if (row.schema !== 1 || row.kind !== "bantam.semantic-reviewed-rack") throw new Error("semantic reviewed rack must use bantam.semantic-reviewed-rack schema 1");
  if (row.rubric !== "factory-mutation-surface-v1") throw new Error("semantic reviewed rack uses an unsupported rubric");
  if (!Array.isArray(row.units) || row.units.length === 0) throw new Error("semantic reviewed rack requires units");
  const seen = new Set();
  const units = row.units.map((entry, index) => {
    const unit = record(entry, `semantic reviewed unit ${index}`);
    exact(unit, ["path", "startLine", "endLine", "sha256", "evidenceRef", "decisions"], `semantic reviewed unit ${index}`);
    const decisions = record(unit.decisions, `semantic reviewed unit ${index} decisions`);
    exact(decisions, SEMANTIC_REVIEW_LANES, `semantic reviewed unit ${index} decisions`);
    const normalized = {
      path: text(unit.path, `semantic reviewed unit ${index} path`).replace(/\\/g, "/"),
      startLine: positive(unit.startLine, `semantic reviewed unit ${index} startLine`),
      endLine: positive(unit.endLine, `semantic reviewed unit ${index} endLine`),
      sha256: pattern(unit.sha256, SHA256, `semantic reviewed unit ${index} sha256`),
      evidenceRef: text(unit.evidenceRef, `semantic reviewed unit ${index} evidenceRef`),
      decisions: Object.fromEntries(SEMANTIC_REVIEW_LANES.map((lane) => {
        if (typeof decisions[lane] !== "boolean") throw new TypeError(`semantic reviewed unit ${index} ${lane} decision must be Boolean`);
        return [lane, decisions[lane]];
      })),
    };
    if (normalized.endLine < normalized.startLine) throw new Error(`semantic reviewed unit ${index} line range is reversed`);
    const identity = unitIdentity(normalized);
    if (seen.has(identity)) throw new Error(`duplicate semantic reviewed unit: ${normalized.path}:${normalized.startLine}-${normalized.endLine}`);
    seen.add(identity);
    return normalized;
  }).sort(compareUnits);
  const body = { schema: 1, kind: "bantam.semantic-reviewed-rack", rubric: row.rubric, units };
  const ref = `semantic-reviewed-rack:sha256:${digest(body)}`;
  if (Object.hasOwn(row, "ref") && row.ref !== ref) throw new Error("semantic reviewed rack content hash does not match");
  return deepFreeze({ ...body, ref });
}

export function expandSemanticReviewedFacts(value) {
  const rack = defineSemanticReviewedRack(value);
  return deepFreeze(rack.units.flatMap((unit) => SEMANTIC_REVIEW_LANES.map((lane) => ({
    path: unit.path, startLine: unit.startLine, endLine: unit.endLine, sha256: unit.sha256,
    lane, present: unit.decisions[lane], evidenceRef: `${unit.evidenceRef}#${lane}`,
  }))));
}

export function evaluateSemanticReviewedGauge({ artifacts, rack, policy } = {}) {
  const reviewedRack = defineSemanticReviewedRack(rack);
  return evaluateSemanticSensorQualification({ artifacts, reviewed: expandSemanticReviewedFacts(reviewedRack), ...(policy ? { policy } : {}) });
}

export async function runSemanticReviewedGaugeArticle({ root, artifacts, rack, policy, jobId = null, signal = null, time } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new TypeError("semantic reviewed gauge article requires artifacts");
  for (const artifact of artifacts) validateSemanticObject(artifact);
  const reviewedRack = defineSemanticReviewedRack(rack);
  const compiled = semanticSensorQualificationLine();
  const id = jobId ?? `semantic-gauge-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  let report = null, adapterFailure = null;
  const matrixManifest = deepFreeze({ schema: 1, kind: "bantam.semantic-matrix-manifest", artifactIds: artifacts.map((artifact) => artifact.artifactId) });
  const rackHandle = deepFreeze({ schema: 1, kind: "bantam.semantic-reviewed-rack-handle", ref: reviewedRack.ref });
  const adapters = {
    "bantam.factory.semantic-qualification-intake/v1": async (order) => ({ productRevision: order.inputProductRevision, outputs: { matrix: matrixManifest, "reviewed-rack": rackHandle } }),
    "bantam.factory.semantic-reviewed-gauge/v1": async (order) => {
      try {
        const admittedMatrix = input(order, "matrix"), admittedRack = input(order, "reviewed-rack");
        if (canonicalJson(admittedMatrix) !== canonicalJson(matrixManifest) || canonicalJson(admittedRack) !== canonicalJson(rackHandle)) throw new Error("semantic gauge material handles do not match admitted immutable objects");
        report = evaluateSemanticReviewedGauge({ artifacts, rack: reviewedRack, policy });
        return { productRevision: productRevision(report.artifactId), outputs: { evidence: report } };
      } catch (error) {
        adapterFailure = String(error?.message ?? error);
        throw error;
      }
    },
  };
  const { assets } = compiled;
  const gauges = {
    [gaugeRef(assets.intake)]: async (order) => {
      const matrices = output(order, "matrix"), admittedRack = output(order, "reviewed-rack");
      const pass = canonicalJson(matrices) === canonicalJson(matrixManifest) && canonicalJson(admittedRack) === canonicalJson(rackHandle);
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "semantic-qualification-material-binding", pass, articles: matrices.artifactIds?.length ?? 0, rackRef: admittedRack.ref }] };
    },
    [gaugeRef(assets.gauge)]: async (order) => {
      const evidence = output(order, "evidence");
      let pass = false;
      try {
        validateSemanticSensorQualificationReport(evidence);
        pass = evidence.reviewedAccuracy.facts === reviewedRack.units.length * SEMANTIC_REVIEW_LANES.length
          && evidence.articles.length === artifacts.length
          && evidence.stationRef === report.stationRef;
      } catch { pass = false; }
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "semantic-reviewed-exactness", pass, qualificationArtifactId: evidence.artifactId, disposition: evidence.status, rackRef: reviewedRack.ref }] };
    },
  };
  const basis = digest({ artifacts: artifacts.map((artifact) => artifact.artifactId), rackRef: reviewedRack.ref });
  const line = await runFactoryBlueprint({ compiled, root, jobId: id, task: "Qualify the semantic matrix inspector against reviewed exact decisions.", initialProductRevision: `artifact:${basis}`, adapters, gauges, workspaceLabel: `semantic-qualification://${reviewedRack.ref}`, signal, time });
  return deepFreeze({ schema: 1, kind: "bantam.factory-semantic-reviewed-gauge-result", jobId: id, status: line.supervisor.status, qualification: report, infrastructure: adapterFailure === null ? null : { code: "semantic-reviewed-gauge-adapter", message: adapterFailure }, rackRef: reviewedRack.ref, stationRef: assets.gauge.ref, blueprintRef: compiled.blueprint.ref, routeRef: compiled.route.ref, line });
}

function input(order, name) { const material = order.inputs?.find((entry) => entry.port === name); if (!material) throw new Error(`semantic gauge adapter missing input: ${name}`); return material.value; }
function output(order, name) { const material = order.outputs?.find((entry) => entry.port === name); if (!material) throw new Error(`semantic gauge inspection missing output: ${name}`); return material.value; }
function productRevision(reference) { return `artifact:${String(reference).split(":").at(-1)}`; }
function unitIdentity(unit) { return `${unit.path}\0${unit.startLine}\0${unit.endLine}\0${unit.sha256}`; }
function compareUnits(a, b) { return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine || a.sha256.localeCompare(b.sha256); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); return value; }
function exact(value, fields, label) { const allowed = new Set(fields), unknown = Object.keys(value).filter((key) => !allowed.has(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function pattern(value, regex, label) { const result = text(value, label); if (!regex.test(result)) throw new TypeError(`${label} has invalid format`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
