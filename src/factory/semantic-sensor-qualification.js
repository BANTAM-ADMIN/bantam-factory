import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";
import { defineStationAsset } from "./station-registry.js";
import { validateSemanticObject } from "./semantic-object.js";
import { projectSemanticSensorDisagreement } from "./semantic-sensor-control.js";

const TASK_FAMILY = "semantic-matrix-inspection";
const SHA256 = /^[a-f0-9]{64}$/;

const policyBody = Object.freeze({
  schema: 1,
  kind: "bantam.factory-semantic-sensor-qualification-policy",
  id: "semantic-sensor-first-cohort",
  version: 1,
  taskFamily: TASK_FAMILY,
  minimumArticles: 3,
  minimumSharedDecisions: 1_000,
  minimumLaneAgreement: 0.98,
  minimumPositiveJaccard: 0.85,
  minimumReviewedDecisions: 50,
  minimumReviewedPositivePerLane: 1,
  minimumReviewedNegativePerLane: 1,
  minimumPrecision: 0.95,
  minimumRecall: 0.95,
  maximumDieFailures: 0,
});

export const SEMANTIC_SENSOR_QUALIFICATION_POLICY = deepFreeze({
  ...policyBody,
  ref: `semantic-sensor-qualification-policy:${policyBody.id}@${policyBody.version}:sha256:${digest(policyBody)}`,
});

/** The model station being qualified. Its independent gauge is this module. */
export function semanticSensorStationAsset() {
  return defineStationAsset({
    schema: 2,
    kind: "bantam.factory-station",
    id: "semantic-matrix-inspector",
    version: 1,
    title: "Semantic matrix inspector",
    purpose: "Classify exact source units against a finite semantic lane rubric without mutating source material.",
    worker: { kind: "model", adapter: "bantam.factory.semantic-matrix-inspector/v1" },
    inputs: [{ name: "source-rack", artifactType: "bantam.semantic-source-rack/v1", required: true }],
    outputs: [{ name: "matrix", artifactType: "bantam.semantic-matrix/v1", required: true }],
    capabilities: ["model.semantic-work", "semantic.matrix.classify"],
    authority: ["workspace.read"],
    gauge: { id: "semantic-sensor-qualification", version: 1, independent: true },
    dispositions: ["blocked", "contained", "infrastructure", "released", "rework"],
    presentation: { group: "inspection", icon: "chicken", color: "violet" },
    standardWork: {
      operation: "Peck the semantic lane buttons for each clamped source unit",
      instructions: [
        "Read only the exact source unit presented by the rack.",
        "Judge every lane in the supplied finite rubric.",
        "Return only the constrained matrix row.",
      ],
      fixtures: ["Byte-addressed source rack", "Finite lane rubric", "Grammar-constrained response die"],
      prohibited: ["Do not mutate the workspace.", "Do not invent lanes.", "Do not silently omit a lane decision."],
      releaseCriteria: ["Every source unit has one Boolean decision per rubric lane and passes the independent qualification gauge."],
    },
  });
}

/**
 * Qualify a semantic sensor from repeat runs plus independently reviewed facts.
 * A model observation never certifies itself: reviewed facts are a separate,
 * explicit gauge and must include both positive and negative decisions.
 */
export function evaluateSemanticSensorQualification({ artifacts, reviewed = [], policy = SEMANTIC_SENSOR_QUALIFICATION_POLICY } = {}) {
  const qualificationPolicy = normalizePolicy(policy);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new TypeError("semantic sensor qualification artifacts must be a non-empty array");
  const articles = artifacts.map((artifact) => { validateSemanticObject(artifact); return artifact; });
  const ids = new Set(articles.map((artifact) => artifact.artifactId));
  if (ids.size !== articles.length) throw new Error("semantic sensor qualification requires distinct article artifacts");
  const laneKeys = articles[0].rubric.map((lane) => lane.key).sort();
  for (const artifact of articles.slice(1)) {
    if (artifact.rubric.map((lane) => lane.key).sort().join("\0") !== laneKeys.join("\0")) throw new Error("semantic sensor qualification rubrics do not have the same lane keys");
  }
  const matrices = articles.map(readMatrix);
  const comparisons = [];
  for (let left = 0; left < articles.length; left += 1) {
    for (let right = left + 1; right < articles.length; right += 1) {
      comparisons.push(projectSemanticSensorDisagreement({ leftArtifact: articles[left], rightArtifact: articles[right] }));
    }
  }
  const laneRepeatability = Object.fromEntries(laneKeys.map((lane) => {
    let decisions = 0, disagreements = 0, positiveIntersection = 0, positiveUnion = 0;
    for (const control of comparisons) {
      decisions += control.comparison.sharedByteIdenticalUnits;
      disagreements += control.summary.byLane[lane] ?? 0;
      const left = matrices.find((matrix) => matrix.artifactId === control.basis.leftSemanticObjectId);
      const right = matrices.find((matrix) => matrix.artifactId === control.basis.rightSemanticObjectId);
      for (const unit of left.units.values()) {
        const peer = right.units.get(unit.identity);
        if (!peer) continue;
        const a = unit.positive.has(lane), b = peer.positive.has(lane);
        if (a && b) positiveIntersection += 1;
        if (a || b) positiveUnion += 1;
      }
    }
    return [lane, {
      decisions,
      disagreements,
      agreement: decisions ? (decisions - disagreements) / decisions : null,
      positiveIntersection,
      positiveUnion,
      positiveJaccard: positiveUnion ? positiveIntersection / positiveUnion : 1,
    }];
  }));
  const reviewedFacts = normalizeReviewed(reviewed, laneKeys);
  const reviewedCoverage = Object.fromEntries(laneKeys.map((lane) => [lane, {
    positive: reviewedFacts.filter((fact) => fact.lane === lane && fact.present).length,
    negative: reviewedFacts.filter((fact) => fact.lane === lane && !fact.present).length,
  }]));
  const scores = Object.fromEntries(articles.map((artifact) => [artifact.artifactId, { tp: 0, fp: 0, tn: 0, fn: 0, reviewedDecisions: 0 }]));
  const unmatchedReviewed = [];
  for (const fact of reviewedFacts) {
    let matched = false;
    for (const matrix of matrices) {
      const unit = matrix.units.get(identity(fact));
      if (!unit) continue;
      matched = true;
      const observed = unit.positive.has(fact.lane);
      const score = scores[matrix.artifactId];
      score.reviewedDecisions += 1;
      if (observed && fact.present) score.tp += 1;
      else if (observed) score.fp += 1;
      else if (fact.present) score.fn += 1;
      else score.tn += 1;
    }
    if (!matched) unmatchedReviewed.push(fact);
  }
  if (unmatchedReviewed.length) throw new Error(`reviewed semantic decisions do not address an article source unit: ${unmatchedReviewed.map((row) => `${row.path}:${row.startLine}-${row.endLine}:${row.lane}`).join(", ")}`);
  const totals = Object.values(scores).reduce((sum, score) => {
    for (const key of ["tp", "fp", "tn", "fn", "reviewedDecisions"]) sum[key] += score[key];
    return sum;
  }, { tp: 0, fp: 0, tn: 0, fn: 0, reviewedDecisions: 0 });
  const precision = totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : (totals.reviewedDecisions ? 1 : null);
  const recall = totals.tp + totals.fn ? totals.tp / (totals.tp + totals.fn) : (totals.reviewedDecisions ? 1 : null);
  const totalSharedDecisions = Object.values(laneRepeatability).reduce((sum, row) => sum + row.decisions, 0);
  const dieFailures = articles.reduce((sum, artifact) => sum + Number(artifact.modelWork?.dieFailures ?? 0), 0);
  const blockers = [];
  if (articles.length < qualificationPolicy.minimumArticles) blockers.push(blocker("insufficient-articles", articles.length, qualificationPolicy.minimumArticles));
  if (totalSharedDecisions < qualificationPolicy.minimumSharedDecisions) blockers.push(blocker("insufficient-shared-decisions", totalSharedDecisions, qualificationPolicy.minimumSharedDecisions));
  for (const [lane, row] of Object.entries(laneRepeatability)) {
    if (row.agreement === null || row.agreement < qualificationPolicy.minimumLaneAgreement) blockers.push(blocker("lane-agreement-below-die", row.agreement, qualificationPolicy.minimumLaneAgreement, lane));
    if (row.positiveJaccard < qualificationPolicy.minimumPositiveJaccard) blockers.push(blocker("positive-jaccard-below-die", row.positiveJaccard, qualificationPolicy.minimumPositiveJaccard, lane));
  }
  if (totals.reviewedDecisions < qualificationPolicy.minimumReviewedDecisions) blockers.push(blocker("insufficient-reviewed-decisions", totals.reviewedDecisions, qualificationPolicy.minimumReviewedDecisions));
  for (const [lane, coverage] of Object.entries(reviewedCoverage)) {
    if (coverage.positive < qualificationPolicy.minimumReviewedPositivePerLane) blockers.push(blocker("insufficient-reviewed-positive-lane-coverage", coverage.positive, qualificationPolicy.minimumReviewedPositivePerLane, lane));
    if (coverage.negative < qualificationPolicy.minimumReviewedNegativePerLane) blockers.push(blocker("insufficient-reviewed-negative-lane-coverage", coverage.negative, qualificationPolicy.minimumReviewedNegativePerLane, lane));
  }
  if (precision === null || precision < qualificationPolicy.minimumPrecision) blockers.push(blocker("precision-below-die", precision, qualificationPolicy.minimumPrecision));
  if (recall === null || recall < qualificationPolicy.minimumRecall) blockers.push(blocker("recall-below-die", recall, qualificationPolicy.minimumRecall));
  if (dieFailures > qualificationPolicy.maximumDieFailures) blockers.push(blocker("die-failures-above-limit", dieFailures, qualificationPolicy.maximumDieFailures));
  const sourceRefs = articles.map((artifact) => `sha256:${artifact.artifactId.split(":").at(-1)}`).sort();
  const elapsed = articles.map((artifact) => Number(artifact.modelWork?.elapsedMs ?? 0)).sort((a, b) => a - b);
  const perArticleAccuracy = Object.fromEntries(Object.entries(scores).map(([artifactId, score]) => [artifactId, {
    ...score,
    precision: score.tp + score.fp ? score.tp / (score.tp + score.fp) : (score.reviewedDecisions ? 1 : null),
    recall: score.tp + score.fn ? score.tp / (score.tp + score.fn) : (score.reviewedDecisions ? 1 : null),
  }]));
  const station = semanticSensorStationAsset();
  const body = {
    schema: 1,
    kind: "bantam.factory-semantic-sensor-qualification",
    authority: "observe-only",
    taskFamily: TASK_FAMILY,
    stationRef: station.ref,
    policy: qualificationPolicy,
    status: blockers.length ? "candidate" : "qualified",
    articles: articles.map((artifact) => ({ artifactId: artifact.artifactId, kitRef: artifact.kitRef, units: artifact.sourceUnits.length, modelWork: artifact.modelWork })),
    repeatability: { pairs: comparisons.length, totalSharedDecisions, lanes: laneRepeatability, controls: comparisons.map((control) => ({ artifactId: control.artifactId, basis: control.basis, comparedDecisions: control.comparison.comparedDecisions, disagreements: control.summary.total, exceptionIds: control.exceptions.map((row) => row.exceptionId) })) },
    reviewedAccuracy: { facts: reviewedFacts.length, coverage: reviewedCoverage, totals, precision, recall, byArticle: perArticleAccuracy },
    dieFailures,
    blockers,
    workforceEvidence: {
      articles: articles.length,
      passes: articles.filter((artifact) => Number(artifact.modelWork?.dieFailures ?? 0) === 0).length,
      escapes: Object.values(scores).filter((score) => score.fn > 0).length,
      falseStops: Object.values(scores).filter((score) => score.fp > 0).length,
      p95Ms: percentile(elapsed, 0.95),
      meanTotalTokens: mean(articles.map((artifact) => Number(artifact.modelWork?.promptTokens ?? 0) + Number(artifact.modelWork?.completionTokens ?? 0))),
      expectedCostUsd: null,
      sourceRefs,
    },
  };
  return deepFreeze({ ...body, artifactId: `semantic-sensor-qualification:sha256:${digest(body)}` });
}

export function certifySemanticSensorWorker({ workforce, workerRef, report } = {}) {
  if (!workforce || typeof workforce.project !== "function" || typeof workforce.qualify !== "function") throw new TypeError("semantic sensor certification requires a workforce registry");
  validateSemanticSensorQualificationReport(report);
  const stationRef = semanticSensorStationAsset().ref;
  if (report.stationRef !== stationRef || report.taskFamily !== TASK_FAMILY) throw new Error("semantic sensor qualification report targets a different station or task family");
  if (report.status !== "qualified" || report.blockers.length) throw new Error(`semantic sensor remains candidate: ${report.blockers.map((row) => row.code).join(", ") || "qualification not released"}`);
  const state = workforce.project();
  const prior = state.qualifications.find((row) => row.workerRef === workerRef && row.stationRef === stationRef && row.taskFamily === TASK_FAMILY);
  if (prior?.status === "qualified") return deepFreeze({ policy: report.policy, qualification: prior, alreadyQualified: true });
  const event = workforce.qualify({
    workerRef,
    stationRef,
    taskFamily: TASK_FAMILY,
    status: "qualified",
    evidence: report.workforceEvidence,
    limits: { maxP95Ms: null, maxExpectedCostUsd: null, authority: ["workspace.read"] },
    reason: `certified by ${report.artifactId}`,
  });
  const qualification = workforce.project().qualifications.find((row) => row.eventId === event.id);
  return deepFreeze({ policy: report.policy, qualification, alreadyQualified: false });
}

export function validateSemanticSensorQualificationReport(report) {
  if (!report || report.kind !== "bantam.factory-semantic-sensor-qualification") throw new TypeError("semantic sensor qualification report is required");
  const expectedId = `semantic-sensor-qualification:sha256:${digest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "artifactId")))}`;
  if (report.artifactId !== expectedId) throw new Error("semantic sensor qualification report digest mismatch");
  if (!Array.isArray(report.blockers) || !report.reviewedAccuracy || !report.repeatability || !report.workforceEvidence) throw new Error("semantic sensor qualification report is incomplete");
  return true;
}

function readMatrix(artifact) {
  const relations = new Map(artifact.datalog.relations.map((relation) => [relation.name, relation.rows]));
  const positive = new Map();
  for (const [chunkId, lane] of relations.get("semantic_observation") ?? []) {
    if (!positive.has(chunkId)) positive.set(chunkId, new Set());
    positive.get(chunkId).add(lane);
  }
  const units = new Map(artifact.sourceUnits.map((unit) => [identity(unit), { ...unit, identity: identity(unit), positive: positive.get(unit.chunkId) ?? new Set() }]));
  return { artifactId: artifact.artifactId, units };
}

function normalizeReviewed(value, lanes) {
  if (!Array.isArray(value)) throw new TypeError("reviewed semantic decisions must be an array");
  const laneSet = new Set(lanes), seen = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`reviewed semantic decision ${index} must be an object`);
    const fields = ["path", "startLine", "endLine", "sha256", "lane", "present", "evidenceRef"];
    const unknown = Object.keys(entry).filter((key) => !fields.includes(key));
    const missing = fields.filter((key) => !Object.hasOwn(entry, key));
    if (unknown.length || missing.length) throw new Error(`reviewed semantic decision ${index} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`);
    if (typeof entry.path !== "string" || !entry.path) throw new TypeError(`reviewed semantic decision ${index} path is required`);
    if (!Number.isInteger(entry.startLine) || entry.startLine < 1 || !Number.isInteger(entry.endLine) || entry.endLine < entry.startLine) throw new TypeError(`reviewed semantic decision ${index} line range is invalid`);
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw new TypeError(`reviewed semantic decision ${index} sha256 is invalid`);
    if (!laneSet.has(entry.lane)) throw new Error(`reviewed semantic decision ${index} references unknown lane: ${entry.lane}`);
    if (typeof entry.present !== "boolean") throw new TypeError(`reviewed semantic decision ${index} present must be Boolean`);
    if (typeof entry.evidenceRef !== "string" || !entry.evidenceRef.trim()) throw new TypeError(`reviewed semantic decision ${index} evidenceRef is required`);
    const row = { path: entry.path.replace(/\\/g, "/"), startLine: entry.startLine, endLine: entry.endLine, sha256: entry.sha256, lane: entry.lane, present: entry.present, evidenceRef: entry.evidenceRef.trim() };
    const key = `${identity(row)}\0${row.lane}`;
    if (seen.has(key)) throw new Error(`duplicate reviewed semantic decision: ${row.path}:${row.startLine}-${row.endLine}:${row.lane}`);
    seen.add(key);
    return row;
  }).sort((a, b) => identity(a).localeCompare(identity(b)) || a.lane.localeCompare(b.lane));
}

function normalizePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("semantic sensor qualification policy must be an object");
  const fields = Object.keys(policyBody);
  const allowed = new Set([...fields, "ref"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`semantic sensor qualification policy fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`);
  if (value.schema !== 1 || value.kind !== policyBody.kind) throw new Error("invalid semantic sensor qualification policy envelope");
  for (const field of ["minimumArticles", "minimumSharedDecisions", "minimumReviewedDecisions", "minimumReviewedPositivePerLane", "minimumReviewedNegativePerLane", "maximumDieFailures"]) if (!Number.isInteger(value[field]) || value[field] < 0) throw new TypeError(`${field} must be a non-negative integer`);
  if (value.taskFamily !== TASK_FAMILY) throw new Error(`semantic sensor qualification policy task family must be ${TASK_FAMILY}`);
  for (const field of ["minimumLaneAgreement", "minimumPositiveJaccard", "minimumPrecision", "minimumRecall"]) if (!Number.isFinite(value[field]) || value[field] < 0 || value[field] > 1) throw new TypeError(`${field} must be from zero to one`);
  const normalized = Object.fromEntries(fields.map((field) => [field, value[field]]));
  const ref = `semantic-sensor-qualification-policy:${normalized.id}@${normalized.version}:sha256:${digest(normalized)}`;
  if (Object.hasOwn(value, "ref") && value.ref !== ref) throw new Error("semantic sensor qualification policy digest mismatch");
  return deepFreeze({ ...normalized, ref });
}

function identity(unit) { return `${unit.path}\0${unit.startLine}\0${unit.endLine}\0${unit.sha256}`; }
function blocker(code, actual, required, lane = null) { return { code, ...(lane ? { lane } : {}), actual, required }; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function percentile(values, fraction) { return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] : null; }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
