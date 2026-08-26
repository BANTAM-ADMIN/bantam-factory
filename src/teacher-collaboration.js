// Governed Sol/Terra collaboration over recorded BANTAM runs.
//
// This is a witness, not a promotion path. A local run remains the primary
// specimen. Stronger Codex models independently diagnose the harness-level gap,
// then review each other's hypotheses. Cross-accepted hypotheses are persisted
// as build-only self-improvement candidates with adversarial-test plans. The
// existing private-lane controller, replay scorers, experiments, and promotion
// evidence remain authoritative for implementation and promotion.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";
import { compareTeacherTrajectories } from "./trajectory-comparison.js";

export const TEACHER_REPORT_KIND = "bantam.teacher-collaboration";
export const TEACHER_REPORT_SCHEMA = 1;
export const TEACHER_REPORT_DIR = ".bantam/teacher-collaboration/reports";
export const DEFAULT_TEACHER_MODELS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

const MAX_PACKET_CHARS = 48_000;
const MAX_TURNS_IN_PACKET = 30;
const MAX_REPORTS = 50;
const REMEDY_TYPES = Object.freeze([
  "prompt-context",
  "done-gate",
  "action-mask",
  "tool-feedback",
  "verification-policy",
  "recovery-policy",
  "grounding-tool",
  "skill",
  "test-oracle",
]);
const REVIEW_VERDICTS = Object.freeze(["accept", "revise", "reject"]);
const SAFE_TARGET_PREFIXES = Object.freeze(["src/", "bin/", "test/", "docs/"]);
const REMEDY_TARGETS = deepFreeze({
  "prompt-context": ["src/prompt.js", "src/prompt-audit.js"],
  "done-gate": ["src/done-gates.js", "src/done-guard.js", "src/completion-audit.js", "src/agent.js"],
  "action-mask": ["src/turn-mask.js", "src/grammar.js", "src/agent.js"],
  "tool-feedback": ["src/agent.js"],
  "verification-policy": ["src/done-gates.js", "src/executor.js", "src/agent.js"],
  "recovery-policy": ["src/agent.js"],
  "grounding-tool": ["src/context-packet.js", "src/logic/grounding.js", "src/agent.js"],
  skill: ["src/skills.js", "src/agent.js"],
  "test-oracle": [
    "src/done-gates.js",
    "src/done-guard.js",
    "src/completion-audit.js",
    "src/edge-smoke.js",
    "src/spec-examples.js",
    "src/agent.js",
  ],
});
const PRIVATE_TEXT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bauthorization\s*:\s*bearer\s+\S+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/gi,
];

export const TEACHER_ANALYSIS_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "hypotheses", "adversarialTests", "cautions"],
  properties: {
    verdict: {
      type: "string",
      enum: ["harness-gap", "task-specific", "insufficient-evidence"],
    },
    summary: { type: "string" },
    hypotheses: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "slug",
          "failureMode",
          "evidence",
          "mechanism",
          "remedyType",
          "remedy",
          "deliveryPoint",
          "targets",
          "falsificationTest",
          "expectedLocalBehavior",
          "confidence",
        ],
        properties: {
          slug: { type: "string" },
          failureMode: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string" },
          },
          mechanism: { type: "string" },
          remedyType: { type: "string", enum: [...REMEDY_TYPES] },
          remedy: { type: "string" },
          deliveryPoint: { type: "string" },
          targets: {
            type: "array",
            maxItems: 6,
            items: { type: "string" },
          },
          falsificationTest: { type: "string" },
          expectedLocalBehavior: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    adversarialTests: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "purpose", "setup", "assertion", "guardsAgainst"],
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          setup: { type: "string" },
          assertion: { type: "string" },
          guardsAgainst: { type: "string" },
        },
      },
    },
    cautions: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
    },
  },
});

export const TEACHER_REVIEW_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "hypotheses", "missingRisks", "confidence"],
  properties: {
    verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
    summary: { type: "string" },
    hypotheses: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "verdict", "reason", "requiredEvidence"],
        properties: {
          slug: { type: "string" },
          verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
          reason: { type: "string" },
          requiredEvidence: { type: "string" },
        },
      },
    },
    missingRisks: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

/**
 * Decide whether a local run justifies paid/subscription teacher calls.
 * A clean, short, verified run does not escalate unless the operator supplies a
 * failing external grade or explicitly requests proactive analysis.
 */
export function assessLocalRun(artifact, {
  grade = null,
  force = false,
  excessiveTurns = 20,
} = {}) {
  requireArtifact(artifact, "local artifact");
  const reasons = [];
  const result = artifact.result ?? {};
  const metrics = artifact.metrics ?? {};
  const normalizedGrade = normalizeGrade(grade);
  if (force) reasons.push("operator explicitly requested proactive teacher analysis");
  if (result.pass === false || ["fail", "blocked"].includes(result.status)) {
    reasons.push(`local result is ${result.status ?? "failed"}`);
  }
  if (normalizedGrade && normalizedGrade.passed < normalizedGrade.tests) {
    reasons.push(`external grade is ${normalizedGrade.passed}/${normalizedGrade.tests}`);
  }
  if (Number(metrics.turns ?? 0) >= excessiveTurns) {
    reasons.push(`local run used ${metrics.turns} turns`);
  }
  for (const [field, label] of [
    ["invalid", "invalid outputs"],
    ["protocolViolations", "protocol violations"],
    ["duplicateActionRejections", "duplicate actions"],
    ["duplicateShellRejections", "duplicate shell actions"],
    ["noOpEdits", "no-op edits"],
    ["progressGateTerminations", "progress terminations"],
  ]) {
    const count = nonNegativeInt(metrics[field]);
    if (count > 0) reasons.push(`${count} ${label}`);
  }
  return {
    eligible: reasons.length > 0,
    reasons,
    grade: normalizedGrade,
    localPassedVisible: result.pass === true,
  };
}

/**
 * Build the bounded, redacted evidence packet all teachers receive. Keeping the
 * packet identical is what makes independent diagnoses comparable.
 */
export function buildTeacherPacket({
  local,
  references = [],
  grades = {},
  taskLabel = null,
} = {}) {
  requireArtifact(local, "local artifact");
  if (!Array.isArray(references) || references.length < 2) {
    throw new TypeError("teacher collaboration requires at least two reference artifacts");
  }
  for (const [index, artifact] of references.entries()) {
    requireArtifact(artifact, `reference artifact ${index}`);
  }
  const task = String(local.task ?? "");
  if (!task) throw new Error("local artifact is missing the exact task");
  for (const artifact of references) {
    if (String(artifact.task ?? "") !== task) {
      throw new Error("teacher artifacts must record the exact same task as the local artifact");
    }
  }

  const packet = {
    schema: 1,
    kind: "bantam.teacher-evidence-packet",
    taskLabel: taskLabel ? bounded(taskLabel, 160) : null,
    task: bounded(redact(task), 8_000),
    taskSha256: sha256(task),
    local: artifactView(local, grades.local),
    references: references.map((artifact, index) => artifactView(
      artifact,
      grades[referenceGradeKey(artifact, index)],
    )),
    trajectoryComparison: compareTeacherTrajectories(local, references),
  };
  const serialized = JSON.stringify(packet);
  if (serialized.length <= MAX_PACKET_CHARS) return packet;

  // Degrade detail before truth: keep identities, outcomes, metrics, and action
  // sequences, but trim verbose observations uniformly.
  for (const arm of [packet.local, ...packet.references]) {
    arm.trajectory = arm.trajectory.map((turn) => ({
      ...turn,
      reasoning: bounded(turn.reasoning, 180),
      observation: bounded(turn.observation, 320),
    }));
  }
  if (JSON.stringify(packet).length > MAX_PACKET_CHARS) {
    for (const arm of [packet.local, ...packet.references]) {
      arm.trajectory = arm.trajectory.slice(-12);
    }
  }
  return packet;
}

/**
 * Four-call council:
 *   1. each teacher independently analyzes one immutable packet;
 *   2. each teacher reviews the other's report;
 *   3. only cross-accepted hypotheses become candidates.
 *
 * invokeTeacher({model, phase, prompt, schema}) is injected for hermetic tests.
 */
export async function runTeacherCollaboration({
  local,
  references,
  grades = {},
  models = DEFAULT_TEACHER_MODELS,
  effort = "high",
  force = false,
  excessiveTurns = 20,
  invokeTeacher,
  usageForModel = null,
  now = () => new Date(),
} = {}) {
  if (typeof invokeTeacher !== "function") {
    throw new TypeError("teacher collaboration requires an invokeTeacher port");
  }
  const uniqueModels = normalizeModels(models);
  if (uniqueModels.length < 2) {
    throw new Error("teacher collaboration requires at least two distinct teacher models");
  }
  const assessment = assessLocalRun(local, {
    grade: grades.local,
    force,
    excessiveTurns,
  });
  if (!assessment.eligible) {
    return {
      status: "withheld",
      reason: "local run has no struggle signal; use explicit proactive mode to consult teachers",
      assessment,
      report: null,
    };
  }
  const packet = buildTeacherPacket({ local, references, grades });
  const analyses = [];
  for (const model of uniqueModels) {
    const prompt = buildAnalysisPrompt(packet, model);
    const raw = await invokeTeacher({
      model,
      effort,
      phase: "analysis",
      prompt,
      schema: TEACHER_ANALYSIS_SCHEMA,
    });
    analyses.push({
      model,
      analysis: normalizeAnalysis(parseStructured(raw, `${model} analysis`)),
    });
  }

  const reviews = [];
  for (let index = 0; index < analyses.length; index++) {
    const reviewer = analyses[index];
    const subjects = analyses.filter((_, candidateIndex) => candidateIndex !== index);
    for (const subject of subjects) {
      const prompt = buildReviewPrompt(packet, reviewer.model, subject);
      const raw = await invokeTeacher({
        model: reviewer.model,
        effort,
        phase: "cross-review",
        prompt,
        schema: TEACHER_REVIEW_SCHEMA,
      });
      reviews.push({
        reviewer: reviewer.model,
        subject: subject.model,
        review: normalizeReview(parseStructured(raw, `${reviewer.model} review`)),
      });
    }
  }

  const council = synthesizeCouncil({ analyses, reviews });
  const recordedAt = now().toISOString();
  const identity = {
    taskSha256: packet.taskSha256,
    localRunId: String(local.runId),
    teacherModels: uniqueModels,
    recordedAt,
  };
  const report = {
    schema: TEACHER_REPORT_SCHEMA,
    kind: TEACHER_REPORT_KIND,
    id: `teachers-${sha256(canonicalJson(identity)).slice(0, 16)}`,
    recordedAt,
    taskSha256: packet.taskSha256,
    localRunId: String(local.runId),
    assessment,
    models: uniqueModels.map((model) => ({ model, effort })),
    usage: Object.fromEntries(uniqueModels.map((model) => [
      model,
      typeof usageForModel === "function" ? usageForModel(model) : null,
    ])),
    grades: normalizeGrades(grades),
    analyses,
    reviews,
    council,
    candidates: council.recommendations.map((accepted, index) => candidateFromAccepted({
      accepted,
      index,
      identity,
      packet,
      analyses,
      reviews,
    })),
  };
  report.sha256 = reportHash(report);
  return { status: "complete", assessment, report };
}

export function synthesizeCouncil({ analyses = [], reviews = [] } = {}) {
  const accepted = [];
  const rejected = [];
  for (const subject of analyses) {
    const subjectReviews = reviews.filter((row) => row.subject === subject.model);
    for (const hypothesis of subject.analysis.hypotheses) {
      const judgments = subjectReviews.flatMap((row) => (
        row.review.hypotheses.filter((item) => item.slug === hypothesis.slug)
          .map((item) => ({
            reviewer: row.reviewer,
            verdict: item.verdict,
            reason: item.reason,
            requiredEvidence: item.requiredEvidence,
          }))
      ));
      const allAccepted = subjectReviews.length > 0
        && judgments.length === subjectReviews.length
        && judgments.every((item) => item.verdict === "accept");
      const row = {
        sourceModel: subject.model,
        hypothesis,
        judgments,
      };
      if (allAccepted) accepted.push(row);
      else rejected.push(row);
    }
  }
  accepted.sort((left, right) => (
    right.hypothesis.confidence - left.hypothesis.confidence
    || left.sourceModel.localeCompare(right.sourceModel)
    || left.hypothesis.slug.localeCompare(right.hypothesis.slug)
  ));
  const participating = new Set(accepted.map((row) => row.sourceModel));
  const recommendations = consolidateAccepted(accepted);
  return {
    verdict: accepted.length === 0
      ? "no-consensus"
      : participating.size === analyses.length ? "strong-consensus" : "partial-consensus",
    accepted,
    recommendations,
    rejected,
    adversarialTests: dedupeTests(analyses.flatMap((row) => row.analysis.adversarialTests)),
    cautions: uniqueStrings([
      ...analyses.flatMap((row) => row.analysis.cautions),
      ...reviews.flatMap((row) => row.review.missingRisks),
    ], 12),
  };
}

export function saveTeacherCollaboration(workspace, report, {
  output = null,
} = {}) {
  const root = requireDirectory(workspace, "teacher collaboration workspace");
  validateReport(report);
  const destination = output
    ? path.resolve(output)
    : path.join(root, TEACHER_REPORT_DIR, `${report.recordedAt.replace(/[:.]/g, "-")}-${report.id}.json`);
  assertInside(root, destination);
  assertNoSymlinkComponents(root, destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlinkComponents(root, destination);
  writeJsonAtomic(destination, report);
  return destination;
}

/**
 * Load only hash-valid council candidates. They remain build-only when merged
 * into the governed self-improvement controller.
 */
export function loadTeacherCandidates(workspace, {
  limit = MAX_REPORTS,
} = {}) {
  const root = requireDirectory(workspace, "teacher collaboration workspace");
  const directory = path.join(root, TEACHER_REPORT_DIR);
  try {
    assertNoSymlinkComponents(root, directory);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reports = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, limit)) {
    const file = path.join(directory, entry.name);
    let report;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      report = JSON.parse(fs.readFileSync(file, "utf8"));
      validateReport(report);
    } catch {
      continue;
    }
    reports.push(report);
  }
  const seen = new Set();
  const recurring = aggregateRecurringCandidates(reports);
  const individual = reports.flatMap((report) => report.candidates.map((candidate) => ({
    ...candidate,
    evidence: {
      ...candidate.evidence,
      reportId: report.id,
      reportSha256: report.sha256,
      recordedAt: report.recordedAt,
    },
  })));
  return [...recurring, ...individual].filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

/**
 * Repeated mechanisms across distinct tasks are stronger than one council's
 * agreement. Aggregate them without asking another model: retain every source
 * report/candidate/test as evidence and ask the implementation lane to build a
 * general mechanism rather than either task's answer.
 */
export function aggregateRecurringCandidates(reports = []) {
  const groups = new Map();
  for (const report of reports) {
    if (!report?.taskSha256 || !Array.isArray(report.candidates)) continue;
    for (const candidate of report.candidates) {
      const type = candidate?.evidence?.remedyType;
      if (!REMEDY_TYPES.includes(type)) continue;
      const key = type;
      const group = groups.get(key) ?? [];
      group.push({ report, candidate });
      groups.set(key, group);
    }
  }
  const out = [];
  for (const [remedyType, rows] of groups) {
    const perTask = new Map();
    for (const row of rows) {
      const prior = perTask.get(row.report.taskSha256);
      if (!prior || row.candidate.evidence.confidence > prior.candidate.evidence.confidence) {
        perTask.set(row.report.taskSha256, row);
      }
    }
    const witnesses = [...perTask.values()];
    if (witnesses.length < 2) continue;
    witnesses.sort((left, right) => (
      right.candidate.evidence.confidence - left.candidate.evidence.confidence
      || left.report.id.localeCompare(right.report.id)
    ));
    const digest = sha256(canonicalJson(witnesses.map(({ report, candidate }) => ({
      reportId: report.id,
      taskSha256: report.taskSha256,
      candidateId: candidate.id,
    })))).slice(0, 8);
    const proposals = uniqueStrings(
      witnesses.map(({ candidate }) => bounded(candidate.proposal, 700)),
      4,
    );
    const targets = normalizeTargets([
      ...(REMEDY_TARGETS[remedyType] ?? []),
      ...witnesses.flatMap(({ candidate }) => candidate.targets ?? []),
    ]).slice(0, 6);
    const tests = dedupeTests(witnesses.flatMap(({ candidate }) => (
      candidate.evidence?.adversarialTests ?? []
    ))).slice(0, 8);
    const teacherModels = uniqueStrings(witnesses.flatMap(({ report, candidate }) => [
      ...(report.models ?? []).map((entry) => entry.model),
      ...(candidate.evidence?.teacherModels ?? []),
    ]), 8);
    out.push({
      id: `teacher-recurring-${slugify(remedyType)}-${digest}`,
      area: "teacher-collaboration",
      problem:
        `${witnesses.length} distinct task councils independently identified a recurring `
        + `${remedyType} weakness in the local harness.`,
      proposal: bounded(
        `Build one task-general ${remedyType} mechanism; do not encode either benchmark's answer. `
        + `The independently accepted remedies were:\n- ${proposals.join("\n- ")}`,
        3_000,
      ),
      targets,
      occurrences: witnesses.length,
      effort: 4,
      impact: 5,
      source: "teacher-collaboration",
      promotionEligible: false,
      lanePolicy: "build-only",
      promotionBlocker:
        "cross-task teacher recurrence is still hypothesis evidence; a preregistered paired fresh-task experiment is required",
      evidence: {
        schema: 1,
        kind: "bantam.recurring-teacher-candidate-evidence",
        remedyType,
        distinctTasks: witnesses.length,
        taskSha256: witnesses.map(({ report }) => report.taskSha256),
        reports: witnesses.map(({ report, candidate }) => ({
          reportId: report.id,
          reportSha256: report.sha256,
          candidateId: candidate.id,
          confidence: candidate.evidence.confidence,
        })),
        teacherModels,
        adversarialTests: tests,
      },
    });
  }
  return out.sort((left, right) => (
    right.occurrences - left.occurrences || left.id.localeCompare(right.id)
  ));
}

export function parseGrade(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? "").trim());
  if (!match) throw new Error(`invalid grade "${value}"; expected passed/tests`);
  const passed = Number(match[1]);
  const tests = Number(match[2]);
  if (tests < 1 || passed > tests) {
    throw new Error(`invalid grade "${value}"; require 0 <= passed <= tests`);
  }
  return { passed, tests, rate: passed / tests };
}

export function formatTeacherCollaboration(result, reportPath = null) {
  if (result.status === "withheld") {
    return `Teacher council withheld: ${result.reason}.`;
  }
  const report = result.report;
  const lines = [
    `Teacher council: ${report.council.verdict}`,
    `Local evidence: ${report.assessment.reasons.join("; ")}`,
    `Cross-accepted recommendations: ${report.candidates.length}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(`  [${candidate.id}] ${candidate.proposal}`);
    lines.push(`    tests: ${candidate.evidence.adversarialTests.length}; targets: ${candidate.targets.join(", ") || "(teacher must localize)"}`);
  }
  if (reportPath) lines.push(`Report: ${reportPath}`);
  lines.push("Status: witness/build-only; replay or paired experiment evidence is still required for promotion.");
  return lines.join("\n");
}

function buildAnalysisPrompt(packet, model) {
  return [
    "You are one member of BANTAM's teacher council.",
    `You are ${model}. Analyze the evidence independently; do not assume another teacher agrees.`,
    "The local model is the system being improved. Reference runs are evidence, not answers to copy.",
    "Find general HARNESS improvements: missing context, weak gates, tool feedback, recovery policy, grounding, or test-oracle gaps.",
    "Distinguish a reusable harness failure from a task-specific implementation mistake.",
    "Every hypothesis must cite concrete trajectory or grading evidence and include a falsification test.",
    "Use trajectoryComparison for deterministic divergence facts. Do not claim those differences caused an outcome unless the packet proves causality.",
    "Propose adversarial tests that would have caught the weakness without revealing the answer.",
    "Do not propose model-weight changes, copying reference source, lowering tests, or automatic promotion.",
    "Return only the schema-conforming JSON.",
    "",
    "IMMUTABLE EVIDENCE PACKET:",
    JSON.stringify(packet),
  ].join("\n");
}

function buildReviewPrompt(packet, reviewerModel, subject) {
  return [
    "You are cross-reviewing another BANTAM teacher's hypotheses.",
    `Reviewer: ${reviewerModel}. Subject teacher: ${subject.model}.`,
    "Reject plausible stories not grounded in the packet. Accept only general harness remedies with a concrete falsification test.",
    "A correct task solution is not itself a harness improvement. Tests must not encode or leak the reference solution.",
    "Review every subject hypothesis by its exact slug. Return only schema-conforming JSON.",
    "",
    "EVIDENCE PACKET:",
    JSON.stringify(packet),
    "",
    "SUBJECT ANALYSIS:",
    JSON.stringify(subject.analysis),
  ].join("\n");
}

function artifactView(artifact, grade) {
  const metrics = artifact.metrics ?? {};
  const result = artifact.result ?? {};
  const turns = Array.isArray(artifact.turns) ? artifact.turns : [];
  return {
    runId: String(artifact.runId),
    modelId: String(artifact.modelId ?? artifact.model?.id ?? "unknown"),
    visibleResult: {
      pass: result.pass ?? null,
      status: String(result.status ?? "unknown"),
      reachedDone: Boolean(result.reachedDone),
      summary: bounded(redact(result.summary ?? ""), 1_200),
      contract: result.contract ? {
        status: result.contract.status ?? null,
        tests: result.contract.tests ?? null,
        passed: result.contract.passed ?? null,
        failed: result.contract.failed ?? null,
      } : null,
    },
    externalGrade: normalizeGrade(grade),
    metrics: {
      turns: nonNegativeInt(metrics.turns),
      invalid: nonNegativeInt(metrics.invalid),
      protocolViolations: nonNegativeInt(metrics.protocolViolations),
      duplicateActionRejections: nonNegativeInt(metrics.duplicateActionRejections),
      duplicateShellRejections: nonNegativeInt(metrics.duplicateShellRejections),
      noOpEdits: nonNegativeInt(metrics.noOpEdits),
      repeatedFailureHints: nonNegativeInt(metrics.repeatedFailureHints),
      progressGateRejections: nonNegativeInt(metrics.progressGateRejections),
      progressGateTerminations: nonNegativeInt(metrics.progressGateTerminations),
      replaceFailures: nonNegativeInt(metrics.replaceFailures?.total ?? metrics.replaceFailures),
      patchFailures: nonNegativeInt(metrics.patchFailures?.total ?? metrics.patchFailures),
      generatedTokens: nonNegativeInt(metrics.genTok),
      durationMs: Number.isFinite(metrics.totalMs) ? metrics.totalMs : null,
      actions: safeActions(metrics.actions),
    },
    trajectory: turns.slice(-MAX_TURNS_IN_PACKET).map((turn) => ({
      turn: Number.isInteger(turn.i) ? turn.i : null,
      reasoning: bounded(redact(turn.reasoning ?? ""), 500),
      action: safeAction(turn.parsedAction ?? turn.action),
      protocolViolation: Boolean(turn.protocolViolation),
      observation: bounded(redact(turn.observation ?? ""), 900),
    })),
  };
}

function candidateFromAccepted({
  accepted,
  index,
  identity,
  packet,
  analyses,
  reviews,
}) {
  const hypothesis = accepted.hypothesis;
  const safeSlug = slugify(hypothesis.slug) || `hypothesis-${index + 1}`;
  const idHash = sha256(canonicalJson({
    taskSha256: identity.taskSha256,
    sourceModel: accepted.sourceModel,
    slug: safeSlug,
    remedy: hypothesis.remedy,
  })).slice(0, 8);
  const tests = dedupeTests([
    ...analyses.flatMap((row) => row.analysis.adversarialTests),
  ]).filter((test) => (
    containsFolded(test.guardsAgainst, hypothesis.failureMode)
    || containsFolded(test.purpose, hypothesis.failureMode)
    || containsFolded(hypothesis.falsificationTest, test.name)
  )).slice(0, 6);
  const selectedTests = tests.length
    ? tests
    : [{
        name: `falsify-${safeSlug}`,
        purpose: "Falsify the teacher council's proposed harness mechanism.",
        setup: hypothesis.falsificationTest,
        assertion: hypothesis.expectedLocalBehavior,
        guardsAgainst: hypothesis.failureMode,
      }];
  return {
    id: `teacher-${safeSlug}-${idHash}`,
    area: "teacher-collaboration",
    problem: bounded(hypothesis.failureMode, 1_000),
    proposal: bounded(hypothesis.remedy, 2_000),
    targets: targetsForHypothesis(hypothesis),
    occurrences: 1,
    effort: 3,
    impact: Math.max(1, Math.min(5, Math.round(hypothesis.confidence * 5))),
    source: "teacher-collaboration",
    promotionEligible: false,
    lanePolicy: "build-only",
    promotionBlocker:
      "teacher consensus is a hypothesis, not behavioral lift; replay and a preregistered paired experiment are required",
    evidence: {
      schema: 1,
      kind: "bantam.teacher-candidate-evidence",
      taskSha256: packet.taskSha256,
      localRunId: packet.local.runId,
      sourceModel: accepted.sourceModel,
      confidence: hypothesis.confidence,
      mechanism: hypothesis.mechanism,
      remedyType: hypothesis.remedyType,
      deliveryPoint: hypothesis.deliveryPoint,
      expectedLocalBehavior: hypothesis.expectedLocalBehavior,
      falsificationTest: hypothesis.falsificationTest,
      citedEvidence: hypothesis.evidence,
      trajectoryComparisonSha256: packet.trajectoryComparison.sha256,
      crossReviews: accepted.judgments,
      corroboratingTeachers: accepted.corroborating ?? [{
        sourceModel: accepted.sourceModel,
        slug: hypothesis.slug,
        confidence: hypothesis.confidence,
      }],
      adversarialTests: selectedTests,
      teacherModels: identity.teacherModels,
      reviewCount: reviews.length,
    },
  };
}

function normalizeAnalysis(value) {
  const hypotheses = Array.isArray(value.hypotheses) ? value.hypotheses : [];
  return {
    verdict: ["harness-gap", "task-specific", "insufficient-evidence"].includes(value.verdict)
      ? value.verdict : "insufficient-evidence",
    summary: bounded(value.summary, 2_000),
    hypotheses: hypotheses.slice(0, 4).map((item, index) => ({
      slug: slugify(item.slug) || `hypothesis-${index + 1}`,
      failureMode: bounded(item.failureMode, 1_500),
      evidence: uniqueStrings(item.evidence, 6).map((entry) => bounded(entry, 1_000)),
      mechanism: bounded(item.mechanism, 2_000),
      remedyType: REMEDY_TYPES.includes(item.remedyType) ? item.remedyType : "prompt-context",
      remedy: bounded(item.remedy, 2_000),
      deliveryPoint: bounded(item.deliveryPoint, 800),
      targets: normalizeTargets(item.targets),
      falsificationTest: bounded(item.falsificationTest, 2_000),
      expectedLocalBehavior: bounded(item.expectedLocalBehavior, 1_500),
      confidence: confidence(item.confidence),
    })).filter((item) => item.failureMode && item.remedy && item.evidence.length),
    adversarialTests: normalizeTests(value.adversarialTests),
    cautions: uniqueStrings(value.cautions, 6).map((entry) => bounded(entry, 1_000)),
  };
}

function normalizeReview(value) {
  return {
    verdict: REVIEW_VERDICTS.includes(value.verdict) ? value.verdict : "reject",
    summary: bounded(value.summary, 2_000),
    hypotheses: (Array.isArray(value.hypotheses) ? value.hypotheses : []).slice(0, 4)
      .map((item) => ({
        slug: slugify(item.slug),
        verdict: REVIEW_VERDICTS.includes(item.verdict) ? item.verdict : "reject",
        reason: bounded(item.reason, 1_500),
        requiredEvidence: bounded(item.requiredEvidence, 1_500),
      })).filter((item) => item.slug),
    missingRisks: uniqueStrings(value.missingRisks, 6).map((entry) => bounded(entry, 1_000)),
    confidence: confidence(value.confidence),
  };
}

function normalizeTests(value) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((item, index) => ({
    name: slugify(item.name) || `adversarial-${index + 1}`,
    purpose: bounded(item.purpose, 1_200),
    setup: bounded(item.setup, 2_000),
    assertion: bounded(item.assertion, 1_500),
    guardsAgainst: bounded(item.guardsAgainst, 1_200),
  })).filter((item) => item.purpose && item.assertion);
}

function dedupeTests(tests) {
  const seen = new Set();
  return normalizeTests(tests).filter((test) => {
    const key = `${test.name}\0${test.assertion}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModels(models) {
  if (!Array.isArray(models)) throw new TypeError("teacher models must be an array");
  return uniqueStrings(models, 8)
    .map((model) => String(model).trim())
    .filter(Boolean);
}

function normalizeGrades(grades) {
  const out = {};
  for (const [name, value] of Object.entries(grades ?? {})) {
    const grade = normalizeGrade(value);
    if (grade) out[name] = grade;
  }
  return out;
}

function normalizeGrade(value) {
  if (value == null) return null;
  if (typeof value === "string") return parseGrade(value);
  const passed = Number(value.passed);
  const tests = Number(value.tests);
  if (!Number.isInteger(passed) || !Number.isInteger(tests)
      || passed < 0 || tests < 1 || passed > tests) {
    throw new TypeError("grade must contain integer passed/tests with 0 <= passed <= tests");
  }
  return { passed, tests, rate: passed / tests };
}

function referenceGradeKey(artifact, index) {
  const model = String(artifact.modelId ?? artifact.model?.id ?? "").toLowerCase();
  if (model.includes("sol")) return "sol";
  if (model.includes("terra")) return "terra";
  return `reference${index + 1}`;
}

function normalizeTargets(value) {
  const targets = uniqueStrings(value, 8).map((entry) => (
    String(entry).trim().replaceAll("\\", "/").replace(/^\.\//, "")
  ));
  return targets.filter((entry) => (
    entry
    && !path.posix.isAbsolute(entry)
    && !entry.split("/").includes("..")
    && SAFE_TARGET_PREFIXES.some((prefix) => entry.startsWith(prefix))
    && !entry.includes("\0")
  )).slice(0, 6);
}

function targetsForHypothesis(hypothesis) {
  const proposed = normalizeTargets(hypothesis.targets);
  const routed = normalizeTargets(REMEDY_TARGETS[hypothesis.remedyType] ?? []);
  return uniqueStrings([...proposed, ...routed], 6);
}

function consolidateAccepted(accepted) {
  const groups = [];
  for (const row of accepted) {
    const match = groups.find((group) => (
      group.hypothesis.remedyType === row.hypothesis.remedyType
      && hypothesisSimilarity(group.hypothesis, row.hypothesis) >= 0.12
    ));
    if (!match) {
      groups.push({
        ...row,
        corroborating: [{
          sourceModel: row.sourceModel,
          slug: row.hypothesis.slug,
          confidence: row.hypothesis.confidence,
        }],
      });
      continue;
    }
    match.corroborating.push({
      sourceModel: row.sourceModel,
      slug: row.hypothesis.slug,
      confidence: row.hypothesis.confidence,
    });
    match.judgments = [...match.judgments, ...row.judgments];
    match.hypothesis = {
      ...match.hypothesis,
      targets: uniqueStrings([
        ...match.hypothesis.targets,
        ...row.hypothesis.targets,
      ], 6),
      evidence: uniqueStrings([
        ...match.hypothesis.evidence,
        ...row.hypothesis.evidence,
      ], 6),
      confidence: Math.max(match.hypothesis.confidence, row.hypothesis.confidence),
    };
  }
  return groups;
}

function hypothesisSimilarity(left, right) {
  const tokens = (value) => new Set(
    `${value.failureMode} ${value.mechanism} ${value.remedy}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5 && ![
        "model", "local", "agent", "harness", "should", "would", "could",
        "before", "after", "require", "implementation",
      ].includes(token)),
  );
  const a = tokens(left);
  const b = tokens(right);
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size || 1;
  return intersection / union;
}

function validateReport(report) {
  if (!report || report.kind !== TEACHER_REPORT_KIND || report.schema !== TEACHER_REPORT_SCHEMA) {
    throw new Error("invalid teacher collaboration report kind or schema");
  }
  if (!Array.isArray(report.candidates) || !Array.isArray(report.analyses)
      || !Array.isArray(report.reviews)) {
    throw new Error("invalid teacher collaboration report collections");
  }
  if (!/^[a-f0-9]{64}$/.test(report.taskSha256 ?? "")) {
    throw new Error("invalid teacher collaboration task digest");
  }
  if (report.sha256 !== reportHash(report)) {
    throw new Error("teacher collaboration report hash does not match");
  }
  for (const candidate of report.candidates) {
    if (!/^teacher-[a-z0-9-]+-[a-f0-9]{8}$/.test(candidate.id ?? "")
        || candidate.source !== "teacher-collaboration"
        || candidate.promotionEligible !== false
        || candidate.lanePolicy !== "build-only") {
      throw new Error("invalid teacher collaboration candidate");
    }
    if (JSON.stringify(candidate.targets) !== JSON.stringify(normalizeTargets(candidate.targets))) {
      throw new Error("unsafe teacher collaboration candidate target");
    }
  }
}

function reportHash(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.sha256;
  return sha256(canonicalJson(copy));
}

function parseStructured(raw, label) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw ?? "").trim();
  if (!text) throw new Error(`${label} returned no structured output`);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} returned invalid structured output`);
  }
}

function requireArtifact(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.kind !== "bantam-run" || !value.runId) {
    throw new TypeError(`${label} must be a saved bantam-run artifact`);
  }
}

function requireDirectory(value, label) {
  const root = path.resolve(value);
  let stat;
  try { stat = fs.statSync(root); } catch { /* handled below */ }
  if (!stat?.isDirectory()) throw new Error(`${label} is not a directory: ${root}`);
  return root;
}

function assertInside(root, destination) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("teacher collaboration output must be a file inside the workspace");
  }
}

function assertNoSymlinkComponents(root, destination) {
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("teacher collaboration path escapes the workspace");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`teacher collaboration path contains a symlink: ${current}`);
    }
  }
}

function safeActions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([name, count]) => /^[a-z_]+$/.test(name) && Number.isFinite(count))
    .map(([name, count]) => [name, nonNegativeInt(count)]));
}

function safeAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = [
    "a", "p", "q", "cmd", "start", "end", "summary", "text",
    "old", "new", "content",
  ];
  const out = {};
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (typeof item === "string") {
      const max = ["old", "new", "content"].includes(key) ? 1_200 : key === "text" ? 600 : 300;
      out[key] = bounded(redact(item), max);
    }
    else if (Number.isFinite(item)) out[key] = item;
  }
  return out;
}

function redact(value) {
  let text = String(value ?? "");
  for (const pattern of PRIVATE_TEXT_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function bounded(value, max) {
  const text = String(value ?? "").replace(/\u0000/g, "");
  return text.length <= max ? text : `${text.slice(0, max - 2)} …`;
}

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function containsFolded(haystack, needle) {
  const left = String(haystack ?? "").toLowerCase();
  const right = String(needle ?? "").toLowerCase();
  if (!left || !right) return false;
  const words = right.split(/[^a-z0-9]+/).filter((word) => word.length >= 5);
  return words.some((word) => left.includes(word));
}

function uniqueStrings(value, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, max);
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
