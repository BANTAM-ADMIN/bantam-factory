// Preregistered cohort execution.
//
// This fitting prevents accidental analysis drift and repeated-until-positive
// runs. It is not an identity provider: role references are declared identities,
// not authenticated principals. A supervisor can add signature verification at
// the admission boundary without changing the plan/result identities.
//
// AUTHORITY: admits or refuses a cohort invocation and scores only the frozen
// primary outcome. It cannot make model calls or write result files.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "../journal.js";

const PLAN_KIND = "bantam.factory-preregistration";
const ADMISSION_KIND = "bantam.factory-preregistered-cohort-admission";
const SCORE_KIND = "bantam.factory-preregistered-cohort-score";

export function definePreregistration(value) {
  const source = record(value, "preregistration");
  exact(source, [
    "schema", "kind", "id", "question", "designerRef", "arms",
    "primaryOutcome", "decisionRule", "outcomes", "articlesPerArm",
    "powerAnalysis", "frozenSettings", "resultTarget",
  ], "preregistration", ["ref"]);
  if (source.schema !== 1 || source.kind !== PLAN_KIND) throw new Error(`preregistration must use schema 1 and kind ${PLAN_KIND}`);
  const arms = uniqueText(source.arms, "preregistration arms");
  if (arms.length < 2) throw new Error("a preregistration needs at least two distinct arms");
  const plan = {
    schema: 1,
    kind: PLAN_KIND,
    id: token(source.id, "preregistration id"),
    question: text(source.question, "preregistration question"),
    designerRef: text(source.designerRef, "preregistration designerRef"),
    arms,
    primaryOutcome: token(source.primaryOutcome, "preregistration primaryOutcome"),
    decisionRule: normalizeDecisionRule(source.decisionRule),
    outcomes: normalizeOutcomes(source.outcomes),
    articlesPerArm: positiveInteger(source.articlesPerArm, "preregistration articlesPerArm"),
    powerAnalysis: normalizePowerAnalysis(source.powerAnalysis),
    frozenSettings: jsonValue(source.frozenSettings, "preregistration frozenSettings"),
    resultTarget: relativePath(source.resultTarget, "preregistration resultTarget"),
  };
  if (plan.decisionRule.candidateArm === plan.decisionRule.controlArm) throw new Error("preregistration decision rule arms must be distinct");
  if (!arms.includes(plan.decisionRule.candidateArm) || !arms.includes(plan.decisionRule.controlArm)) throw new Error("preregistration decision rule arms must be declared plan arms");
  const ref = `prereg:${plan.id}:sha256:${sha256(canonicalJson(plan))}`;
  if (source.ref !== undefined && source.ref !== ref) throw new Error("preregistration content hash does not match");
  return deepFreeze({ ...plan, ref });
}

export function loadPreregistration(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`cannot read preregistration ${file}: ${error.message}`); }
  return definePreregistration(parsed);
}

// Called before endpoint discovery or any paid/model work. A prior result makes
// a rerun a four-role act: designer, runner, scorer, and override approver must
// all be distinct, and the override names the exact bytes it supersedes.
export function admitCohortRun({ plan: suppliedPlan, runnerRef, scorerRef, repositoryRoot, rerunOverride = null }) {
  const plan = definePreregistration(suppliedPlan);
  const runner = text(runnerRef, "cohort runnerRef");
  const scorer = text(scorerRef, "cohort scorerRef");
  const root = path.resolve(text(repositoryRoot, "cohort repositoryRoot"));
  const resultsFile = path.resolve(root, plan.resultTarget);
  if (!resultsFile.startsWith(`${root}${path.sep}`)) throw new Error("preregistration resultTarget escapes repositoryRoot");
  const blockers = [];
  if (runner === plan.designerRef) blockers.push(`runner ${runner} is the plan designer`);
  if (scorer === plan.designerRef) blockers.push(`scorer ${scorer} is the plan designer`);
  if (scorer === runner) blockers.push("runner and scorer must be different declared roles");

  const existingResultSha256 = resultsFile && fs.existsSync(resultsFile)
    ? sha256(fs.readFileSync(resultsFile))
    : null;
  let override = null;
  if (existingResultSha256 !== null) {
    if (rerunOverride === null) {
      blockers.push("a prior result exists; rerun requires a reason-bearing override bound to its digest");
    } else {
      override = normalizeRerunOverride(rerunOverride);
      if (override.priorResultSha256 !== existingResultSha256) blockers.push("rerun override does not name the existing result digest");
      if ([plan.designerRef, runner, scorer].includes(override.approvedByRef)) blockers.push("rerun override approver must be distinct from designer, runner, and scorer");
    }
  } else if (rerunOverride !== null) {
    blockers.push("rerun override supplied when no prior result exists");
  }

  const body = {
    schema: 1,
    kind: ADMISSION_KIND,
    planRef: plan.ref,
    runnerRef: runner,
    scorerRef: scorer,
    resultTarget: plan.resultTarget,
    existingResultSha256,
    rerunOverride: override,
    admitted: blockers.length === 0,
    blockers,
  };
  return deepFreeze({ ...body, ref: `cohort-admission:sha256:${sha256(canonicalJson(body))}` });
}

// Score only the frozen primary outcome and bind the disposition to both the
// plan and the pre-run admission. Secondary measurements survive as context but
// cannot rescue a failed primary.
export function scoreAgainstPlan({ plan: suppliedPlan, admission, scorerRef, measurements }) {
  const plan = definePreregistration(suppliedPlan);
  const admitted = validateAdmission(admission);
  if (admitted.admitted !== true || admitted.blockers.length !== 0) throw new Error("scoreAgainstPlan requires an admitted cohort authorization");
  if (admitted.planRef !== plan.ref) throw new Error("cohort admission does not belong to this preregistration");
  const scorer = text(scorerRef, "cohort scorerRef");
  if (scorer !== admitted.scorerRef) throw new Error("cohort scorer does not match the admitted scorer");
  const values = jsonValue(record(measurements, "measurements"), "measurements");
  const unplanned = Object.keys(values).filter((key) => key !== plan.primaryOutcome).sort();
  const primaryValue = values[plan.primaryOutcome];
  let verdict = "unscoreable";
  let reason = `the plan's primary outcome ${plan.primaryOutcome} was not measured`;
  let analysis = null;
  if (primaryValue !== undefined) {
    analysis = evaluateDecisionRule(plan.decisionRule, primaryValue, plan.articlesPerArm);
    verdict = analysis.accepted ? "accepted" : "rejected";
    reason = plan.outcomes[verdict];
  }
  const body = {
    schema: 1,
    kind: SCORE_KIND,
    planRef: plan.ref,
    admissionRef: text(admitted.ref, "cohort admission ref"),
    scorerRef: scorer,
    verdict,
    reason,
    primaryOutcome: plan.primaryOutcome,
    primaryValue: primaryValue === undefined ? null : primaryValue,
    decisionRule: plan.decisionRule,
    analysis,
    measurements: values,
    unplanned,
    note: "secondary measurements are context and may not be substituted for the primary outcome",
  };
  return deepFreeze({ ...body, ref: `cohort-score:sha256:${sha256(canonicalJson(body))}` });
}

export function verifyPreregisteredCohortEvidence(value, { expectedResultTarget = null } = {}) {
  const evidence = record(value, "preregistered cohort evidence");
  const bundle = record(evidence.preregistration, "preregistered cohort evidence bundle");
  exact(bundle, ["plan", "admission", "score"], "preregistered cohort evidence bundle");
  const plan = definePreregistration(bundle.plan);
  if (expectedResultTarget !== null && plan.resultTarget !== relativePath(expectedResultTarget, "expected preregistered result target")) throw new Error("preregistered cohort plan targets a different evidence file");
  const admission = validateAdmission(bundle.admission);
  if (admission.planRef !== plan.ref) throw new Error("preregistered cohort admission does not belong to its plan");
  const suppliedScore = record(bundle.score, "preregistered cohort score");
  const score = scoreAgainstPlan({
    plan,
    admission,
    scorerRef: suppliedScore.scorerRef,
    measurements: suppliedScore.measurements,
  });
  if (canonicalJson(score) !== canonicalJson(suppliedScore)) throw new Error("preregistered cohort score content does not verify");

  const articles = Array.isArray(evidence.articles) ? evidence.articles : null;
  if (articles === null) throw new Error("preregistered cohort evidence must retain article rows");
  const counts = Object.fromEntries(plan.arms.map((arm) => [arm, { passed: 0, of: 0 }]));
  for (const [index, article] of articles.entries()) {
    const row = record(article, `preregistered cohort article ${index}`);
    if (!Object.hasOwn(counts, row.arm)) throw new Error(`preregistered cohort article ${index} has an unplanned arm`);
    if (typeof row.pass !== "boolean" || typeof row.repaired !== "boolean") throw new Error(`preregistered cohort article ${index} must record Boolean pass and repaired fields`);
    counts[row.arm].of += 1;
    if (row.pass === true && row.repaired !== true) counts[row.arm].passed += 1;
  }
  for (const arm of plan.arms) if (counts[arm].of !== plan.articlesPerArm) throw new Error(`preregistered cohort arm ${arm} retained ${counts[arm].of} rows, planned ${plan.articlesPerArm}`);
  const primary = score.measurements[plan.primaryOutcome];
  if (canonicalJson(primary) !== canonicalJson(counts)) throw new Error("preregistered cohort score counts do not match retained article rows");
  return deepFreeze({ plan, admission, score, counts });
}

function validateAdmission(value) {
  const source = record(value, "cohort admission");
  exact(source, [
    "schema", "kind", "planRef", "runnerRef", "scorerRef", "resultTarget",
    "existingResultSha256", "rerunOverride", "admitted", "blockers", "ref",
  ], "cohort admission");
  if (source.schema !== 1 || source.kind !== ADMISSION_KIND) throw new Error("invalid cohort admission schema or kind");
  const existingResultSha256 = source.existingResultSha256 === null ? null : text(source.existingResultSha256, "cohort admission existingResultSha256");
  if (existingResultSha256 !== null && !/^[0-9a-f]{64}$/.test(existingResultSha256)) throw new Error("cohort admission existingResultSha256 must be a SHA-256 digest");
  const blockers = uniqueText(source.blockers, "cohort admission blockers");
  if (typeof source.admitted !== "boolean" || source.admitted !== (blockers.length === 0)) throw new Error("cohort admission disposition does not match its blockers");
  const body = {
    schema: 1,
    kind: ADMISSION_KIND,
    planRef: text(source.planRef, "cohort admission planRef"),
    runnerRef: text(source.runnerRef, "cohort admission runnerRef"),
    scorerRef: text(source.scorerRef, "cohort admission scorerRef"),
    resultTarget: relativePath(source.resultTarget, "cohort admission resultTarget"),
    existingResultSha256,
    rerunOverride: source.rerunOverride === null ? null : normalizeRerunOverride(source.rerunOverride),
    admitted: source.admitted,
    blockers,
  };
  const ref = `cohort-admission:sha256:${sha256(canonicalJson(body))}`;
  if (source.ref !== ref) throw new Error("cohort admission content hash does not match");
  return deepFreeze({ ...body, ref });
}

function normalizeDecisionRule(value) {
  const source = record(value, "preregistration decisionRule");
  exact(source, ["op", "candidateArm", "controlArm", "z"], "preregistration decisionRule");
  if (source.op !== "wilson-superiority") throw new Error(`unsupported preregistration decision rule: ${source.op}`);
  if (!Number.isFinite(source.z) || source.z <= 0) throw new Error("preregistration decision rule z must be positive and finite");
  return {
    op: source.op,
    candidateArm: token(source.candidateArm, "preregistration candidateArm"),
    controlArm: token(source.controlArm, "preregistration controlArm"),
    z: source.z,
  };
}

function evaluateDecisionRule(rule, value, plannedArticlesPerArm) {
  if (rule.op === "wilson-superiority") {
    const comparison = record(value, "wilson-superiority primary outcome");
    exact(comparison, [rule.candidateArm, rule.controlArm], "wilson-superiority primary outcome");
    const candidate = binomialArm(comparison[rule.candidateArm], rule.candidateArm);
    const control = binomialArm(comparison[rule.controlArm], rule.controlArm);
    if (candidate.of !== plannedArticlesPerArm || control.of !== plannedArticlesPerArm) throw new Error(`wilson-superiority arms must each contain the planned ${plannedArticlesPerArm} articles`);
    const candidateInterval = wilson(candidate.passed, candidate.of, rule.z);
    const controlInterval = wilson(control.passed, control.of, rule.z);
    return {
      accepted: candidateInterval.low > controlInterval.high,
      candidate,
      control,
      candidateInterval,
      controlInterval,
    };
  }
  throw new Error(`unsupported preregistration decision rule: ${rule.op}`);
}

function binomialArm(value, label) {
  const source = record(value, `${label} arm`);
  exact(source, ["passed", "of"], `${label} arm`);
  const of = positiveInteger(source.of, `${label} arm of`);
  if (!Number.isInteger(source.passed) || source.passed < 0 || source.passed > of) throw new Error(`${label} arm passed must be an integer from zero through of`);
  return { passed: source.passed, of };
}

function wilson(passed, of, z) {
  const proportion = passed / of;
  const denominator = 1 + (z * z) / of;
  const centre = proportion + (z * z) / (2 * of);
  const spread = z * Math.sqrt((proportion * (1 - proportion)) / of + (z * z) / (4 * of * of));
  return {
    low: Number(Math.max(0, (centre - spread) / denominator).toFixed(6)),
    high: Number(Math.min(1, (centre + spread) / denominator).toFixed(6)),
  };
}

function normalizeOutcomes(value) {
  const source = record(value, "preregistration outcomes");
  exact(source, ["accepted", "rejected"], "preregistration outcomes");
  return { accepted: text(source.accepted, "accepted outcome"), rejected: text(source.rejected, "rejected outcome") };
}

function normalizePowerAnalysis(value) {
  const source = record(value, "preregistration powerAnalysis");
  exact(source, ["method", "alpha", "power", "targetEffect", "unit"], "preregistration powerAnalysis");
  const alpha = ratio(source.alpha, "preregistration alpha");
  const power = ratio(source.power, "preregistration power");
  if (alpha === 0 || alpha === 1 || power === 0 || power === 1) throw new Error("preregistration alpha and power must lie strictly between zero and one");
  if (!Number.isFinite(source.targetEffect) || source.targetEffect <= 0) throw new Error("preregistration targetEffect must be positive and finite");
  return {
    method: text(source.method, "preregistration power method"),
    alpha,
    power,
    targetEffect: source.targetEffect,
    unit: text(source.unit, "preregistration effect unit"),
  };
}

function normalizeRerunOverride(value) {
  const source = record(value, "rerun override");
  exact(source, ["reason", "approvedByRef", "priorResultSha256"], "rerun override");
  const priorResultSha256 = text(source.priorResultSha256, "rerun override priorResultSha256");
  if (!/^[0-9a-f]{64}$/.test(priorResultSha256)) throw new Error("rerun override priorResultSha256 must be a SHA-256 digest");
  return {
    reason: text(source.reason, "rerun override reason"),
    approvedByRef: text(source.approvedByRef, "rerun override approvedByRef"),
    priorResultSha256,
  };
}

function jsonValue(value, label) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((child, index) => jsonValue(child, `${label}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must contain only JSON values`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonValue(value[key], `${label}.${key}`)]));
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`); if (value !== value.trim()) throw new Error(`${label} must not have surrounding whitespace`); return value; }
function token(value, label) { const result = text(value, label); if (!/^[a-z][a-z0-9._-]*$/.test(result)) throw new Error(`${label} must be a lowercase token`); return result; }
function relativePath(value, label) { const result = text(value, label); if (path.isAbsolute(result) || path.normalize(result).startsWith(`..${path.sep}`) || path.normalize(result) === "..") throw new Error(`${label} must stay within the repository`); return result.split(path.sep).join("/"); }
function positiveInteger(value, label) { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; }
function ratio(value, label) { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between zero and one`); return value; }
function uniqueText(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) => text(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}
function exact(value, required, label, optional = []) {
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const allowed = new Set([...required, ...optional]);
  const unknown = actual.filter((key) => !allowed.has(key));
  if (missing.length) throw new Error(`${label} is missing: ${missing.join(", ")}`);
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
