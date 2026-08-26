// Deterministic, model-free comparison of same-task BANTAM trajectories.
//
// Teacher models are useful for proposing mechanisms, but they should not have
// to rediscover basic facts such as "Sol inspected two files Local never
// opened" or "Local attempted DONE four turns earlier."  This module computes
// those facts before any teacher call.  It deliberately reports observations,
// not causal stories: a different action is evidence of divergence, not proof
// that the different action caused an outcome.

import crypto from "node:crypto";

export const TRAJECTORY_COMPARISON_KIND = "bantam.trajectory-comparison";
export const TRAJECTORY_COMPARISON_SCHEMA = 1;
export const TRAJECTORY_HYPOTHESES_KIND = "bantam.trajectory-hypotheses";
export const TRAJECTORY_HYPOTHESES_SCHEMA = 1;

const EDIT_ACTIONS = new Set(["replace", "edit_lines", "write_file", "patch"]);
const READ_ACTIONS = new Set(["read_file", "list_dir", "search"]);
const VERIFY_ACTIONS = new Set(["shell", "verify"]);
const PATH_FIELDS = Object.freeze(["p", "path", "file"]);
const MAX_COVERAGE_PATHS = 24;
const MAX_PATH_CHARS = 240;
const MAX_SIGNATURE_CHARS = 1_200;
const PRIVATE_PATH_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_ -]?key|authorization|bearer)[=: -]+\S+/gi,
]);

export function compareTeacherTrajectories(local, references = []) {
  requireArtifact(local, "local artifact");
  if (!Array.isArray(references) || references.length < 1) {
    throw new TypeError("trajectory comparison requires at least one reference artifact");
  }
  for (const [index, artifact] of references.entries()) {
    requireArtifact(artifact, `reference artifact ${index}`);
    if (String(artifact.task ?? "") !== String(local.task ?? "")) {
      throw new Error("trajectory comparison requires the exact same task");
    }
  }

  const localView = trajectoryView(local);
  const rows = references.map((artifact, index) => {
    const reference = trajectoryView(artifact);
    return comparePair(localView, reference, index);
  });
  const comparison = {
    schema: TRAJECTORY_COMPARISON_SCHEMA,
    kind: TRAJECTORY_COMPARISON_KIND,
    taskSha256: sha256(String(local.task ?? "")),
    localRunId: localView.runId,
    local: summaryView(localView),
    references: rows,
    consensus: consensusFacts(localView, rows),
  };
  comparison.sha256 = sha256(canonicalJson(comparison));
  return deepFreeze(comparison);
}

export function formatTrajectoryComparison(comparison) {
  if (comparison?.kind !== TRAJECTORY_COMPARISON_KIND) {
    throw new TypeError("invalid trajectory comparison");
  }
  const lines = [
    `Trajectory evidence: local ${comparison.local.status} in ${comparison.local.turns} turn(s)`,
  ];
  for (const row of comparison.references) {
    const divergence = row.firstActionDivergence
      ? `first divergence at turn ${row.firstActionDivergence.turn}: `
        + `${row.firstActionDivergence.local ?? "(none)"} vs ${row.firstActionDivergence.reference ?? "(none)"}`
      : "action sequences match";
    lines.push(
      `  ${row.reference.modelId}: ${row.reference.status} in ${row.reference.turns} turn(s); ${divergence}`,
    );
    if (row.referenceOnly.readPaths.length) {
      lines.push(`    reference-only reads: ${row.referenceOnly.readPaths.join(", ")}`);
    }
    if (row.referenceOnly.editPaths.length) {
      lines.push(`    reference-only edits: ${row.referenceOnly.editPaths.join(", ")}`);
    }
  }
  if (comparison.consensus.referenceOnlyReadPaths.length) {
    lines.push(
      `  shared reference-only reads: ${comparison.consensus.referenceOnlyReadPaths.join(", ")}`,
    );
  }
  if (comparison.consensus.referenceOnlyEditPaths.length) {
    lines.push(
      `  shared reference-only edits: ${comparison.consensus.referenceOnlyEditPaths.join(", ")}`,
    );
  }
  lines.push(`Evidence SHA-256: ${comparison.sha256}`);
  return lines.join("\n");
}

/**
 * Reduce same-task trajectory differences into falsifiable harness candidates.
 * This is deliberately model-free and reports hypotheses, never causality.
 */
export function deriveTrajectoryHypotheses(comparison, { maxCandidates = 4 } = {}) {
  requireComparison(comparison);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 12) {
    throw new RangeError("maxCandidates must be an integer from 1 to 12");
  }

  const supporting = comparison.references.filter((row) => (
    row.reference.passed && !row.outcomeGap.localPassed
  ));
  const candidates = [];
  const sharedReads = consensusAcross(supporting, (row) => row.referenceOnly.readPaths);
  const sharedEdits = consensusAcross(supporting, (row) => row.referenceOnly.editPaths);

  if (sharedReads.length) {
    candidates.push(candidate({
      id: "context-coverage-before-edit",
      priority: 90,
      pattern: `${supporting.length} passing reference run(s) inspected path(s) the failing subject did not inspect.`,
      evidence: {
        subjectRunId: comparison.localRunId,
        referenceRunIds: supporting.map((row) => row.reference.runId),
        paths: sharedReads,
      },
      mechanism: "Before the first edit, surface a bounded context suggestion for task-relevant paths that independent successful trajectories repeatedly inspected.",
      helps: ["multi-file contracts", "specification-driven repairs", "repository localization"],
      risks: ["extra reads on already-localized tasks", "path-frequency bias from a narrow cohort"],
      falsification: "On a fresh paired cohort, relevant pre-edit coverage must improve without reducing strict pass rate or adding more than two median investigation turns.",
      promote: "No strict-pass regression; at least one previously missed contract passes; median turns rise no more than 10%.",
      rollback: "Any strict-pass regression or repeated irrelevant context injection.",
    }));
  }

  const verificationRows = supporting.filter((row) => (
    row.reference.verificationAttempts > comparison.local.verificationAttempts
  ));
  if (supporting.length && verificationRows.length === supporting.length) {
    const verificationKinds = uniqueSorted(supporting.flatMap((row) => (
      row.reference.actionKinds.filter((kind) => VERIFY_ACTIONS.has(kind))
    )));
    candidates.push(candidate({
      id: "verification-before-completion",
      priority: 100,
      pattern: `${supporting.length} passing reference run(s) verified before completion while the failing subject did not.`,
      evidence: {
        subjectRunId: comparison.localRunId,
        referenceRunIds: supporting.map((row) => row.reference.runId),
        actionKinds: verificationKinds,
        subjectVerificationAttempts: comparison.local.verificationAttempts,
      },
      mechanism: "Require one task-relevant verification observation after the final edit and before accepting completion.",
      helps: ["focused repairs", "hidden edge cases", "regression-sensitive work"],
      risks: ["verifier latency", "infrastructure failures being mistaken for code failures"],
      falsification: "Fresh paired tasks must show a real defect caught without lowering pass rate or trapping infrastructure-blocked runs.",
      promote: "Strict pass rate improves or stays equal, and false completion deferrals remain below 5%.",
      rollback: "Any verifier loop, infrastructure deadlock, or strict-pass regression.",
    }));
  }

  const earlyDoneRows = supporting.filter((row) => (
    Number.isInteger(row.doneTurnDelta) && row.doneTurnDelta > 0
  ));
  if (supporting.length && earlyDoneRows.length === supporting.length) {
    candidates.push(candidate({
      id: "premature-completion-audit",
      priority: 80,
      pattern: `The failing subject first attempted completion earlier than every passing reference (delta ${earlyDoneRows.map((row) => row.doneTurnDelta).join(", ")} turn(s)).`,
      evidence: {
        subjectRunId: comparison.localRunId,
        subjectDoneTurn: comparison.local.doneTurn,
        referenceDoneTurns: earlyDoneRows.map((row) => ({
          runId: row.reference.runId,
          turn: row.reference.doneTurn,
        })),
      },
      mechanism: "When completion is first attempted unusually early, run one bounded audit for an unexamined contract, sibling path, or missing verification signal.",
      helps: ["ambiguous contracts", "cross-file changes", "short false-positive repairs"],
      risks: ["post-green churn", "using reference length as a quality proxy"],
      falsification: "A fresh paired study must show concrete omitted work found; longer trajectories alone do not count.",
      promote: "At least one additional strict pass with no pass-rate loss and no more than one median post-green turn.",
      rollback: "Audit produces churn without a verified outcome gain.",
    }));
  }

  if (sharedEdits.length) {
    candidates.push(candidate({
      id: "edit-scope-completeness",
      priority: 70,
      pattern: `${supporting.length} passing reference run(s) edited path(s) left untouched by the failing subject.`,
      evidence: {
        subjectRunId: comparison.localRunId,
        referenceRunIds: supporting.map((row) => row.reference.runId),
        paths: sharedEdits,
      },
      mechanism: "After an edit, check repository evidence for contract-linked sibling implementations or call sites before accepting completion.",
      helps: ["migrations", "parallel adapters", "duplicated implementations"],
      risks: ["unnecessary scope expansion", "copying incidental reference edits"],
      falsification: "On fresh paired tasks, suggested sibling edits must be justified by repository structure and improve verified completeness.",
      promote: "Completeness improves without increasing out-of-scope edits or lowering regression pass rate.",
      rollback: "Any repeated speculative edit expansion or scope violation.",
    }));
  }

  const reduced = {
    schema: TRAJECTORY_HYPOTHESES_SCHEMA,
    kind: TRAJECTORY_HYPOTHESES_KIND,
    sourceComparisonSha256: comparison.sha256,
    taskSha256: comparison.taskSha256,
    subjectRunId: comparison.localRunId,
    passingReferenceCount: supporting.length,
    boundary: supporting.length
      ? "Observable divergence supports experiments, not causality or promotion."
      : "No passing-reference versus failing-subject outcome gap; no candidates emitted.",
    candidates: candidates
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .slice(0, maxCandidates)
      .map(({ priority: _priority, ...row }) => row),
  };
  reduced.sha256 = sha256(canonicalJson(reduced));
  return deepFreeze(reduced);
}

export function formatTrajectoryHypotheses(result) {
  if (result?.kind !== TRAJECTORY_HYPOTHESES_KIND) {
    throw new TypeError("invalid trajectory hypotheses");
  }
  const lines = [
    `Trajectory candidates: ${result.candidates.length} from ${result.passingReferenceCount} passing reference(s)`,
    `Boundary: ${result.boundary}`,
  ];
  for (const [index, row] of result.candidates.entries()) {
    lines.push(
      "",
      `${index + 1}. ${row.id}`,
      `   observed: ${row.pattern}`,
      `   mechanism: ${row.mechanism}`,
      `   falsify: ${row.falsification}`,
      `   promote: ${row.thresholds.promote}`,
      `   rollback: ${row.thresholds.rollback}`,
    );
  }
  lines.push("", `Evidence SHA-256: ${result.sha256}`);
  return lines.join("\n");
}

function candidate({
  id, priority, pattern, evidence, mechanism, helps, risks, falsification, promote, rollback,
}) {
  return {
    id,
    priority,
    pattern,
    evidence,
    mechanism,
    expectedTaskClasses: helps,
    possibleHarms: risks,
    falsification,
    thresholds: { promote, rollback },
  };
}

function consensusAcross(rows, select) {
  if (!rows.length) return [];
  return intersection(rows.map((row) => new Set(select(row) ?? [])));
}

function requireComparison(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("trajectory comparison must be an object");
  }
  if (value.kind !== TRAJECTORY_COMPARISON_KIND) {
    throw new Error("trajectory comparison has the wrong kind");
  }
  if (!Array.isArray(value.references) || !value.local || !value.sha256) {
    throw new Error("trajectory comparison is incomplete");
  }
}

function comparePair(local, reference, index) {
  const length = Math.max(local.actions.length, reference.actions.length);
  let firstActionDivergence = null;
  for (let turn = 0; turn < length; turn++) {
    const left = local.actions[turn]?.signature ?? null;
    const right = reference.actions[turn]?.signature ?? null;
    if (left !== right) {
      firstActionDivergence = {
        turn: turn + 1,
        local: left,
        reference: right,
      };
      break;
    }
  }
  const localRead = new Set(local.readPaths);
  const localEdit = new Set(local.editPaths);
  const referenceRead = new Set(reference.readPaths);
  const referenceEdit = new Set(reference.editPaths);
  return {
    referenceIndex: index,
    reference: summaryView(reference),
    outcomeGap: {
      localPassed: local.passed,
      referencePassed: reference.passed,
      statusDiffers: local.status !== reference.status,
    },
    turnDelta: reference.turns - local.turns,
    verificationAttemptDelta: reference.verificationAttempts - local.verificationAttempts,
    doneTurnDelta: nullableDelta(reference.doneTurn, local.doneTurn),
    firstActionDivergence,
    actionCountDelta: histogramDelta(local.histogram, reference.histogram),
    referenceOnly: {
      readPaths: difference(referenceRead, localRead),
      editPaths: difference(referenceEdit, localEdit),
      actionKinds: difference(new Set(reference.actionKinds), new Set(local.actionKinds)),
    },
    localOnly: {
      readPaths: difference(localRead, referenceRead),
      editPaths: difference(localEdit, referenceEdit),
      actionKinds: difference(new Set(local.actionKinds), new Set(reference.actionKinds)),
    },
  };
}

function trajectoryView(artifact) {
  const turns = Array.isArray(artifact.turns) ? artifact.turns : [];
  const actions = turns.map((turn) => normalizeAction(turn?.parsedAction ?? turn?.action));
  const result = artifact.result ?? {};
  const status = String(result.status ?? (result.pass === true ? "pass" : "unknown"));
  const readPaths = [];
  const editPaths = [];
  const histogram = {};
  let verificationAttempts = 0;
  let doneTurn = null;
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    histogram[action.kind] = (histogram[action.kind] ?? 0) + 1;
    readPaths.push(...action.readPaths);
    editPaths.push(...action.editPaths);
    if (VERIFY_ACTIONS.has(action.kind)) verificationAttempts += 1;
    if (action.kind === "done" && doneTurn === null) doneTurn = index + 1;
  }
  return {
    runId: String(artifact.runId),
    modelId: String(artifact.modelId ?? artifact.model?.id ?? "unknown"),
    status,
    passed: result.pass === true || status === "pass",
    turns: actions.length,
    doneTurn,
    verificationAttempts,
    actions,
    actionKinds: Object.keys(histogram).sort(),
    histogram,
    readPaths: uniqueSorted(readPaths).slice(0, MAX_COVERAGE_PATHS),
    editPaths: uniqueSorted(editPaths).slice(0, MAX_COVERAGE_PATHS),
  };
}

function summaryView(view) {
  return {
    runId: view.runId,
    modelId: view.modelId,
    status: view.status,
    passed: view.passed,
    turns: view.turns,
    doneTurn: view.doneTurn,
    verificationAttempts: view.verificationAttempts,
    actionKinds: [...view.actionKinds],
    readPaths: [...view.readPaths],
    editPaths: [...view.editPaths],
  };
}

function normalizeAction(value) {
  let action = value;
  if (typeof value === "string") {
    try {
      action = JSON.parse(value);
    } catch {
      action = null;
    }
  }
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return {
      kind: "invalid",
      path: null,
      readPaths: [],
      editPaths: [],
      signature: "invalid",
    };
  }
  const kind = String(action.a ?? action.type ?? "unknown").trim() || "unknown";
  const path = PATH_FIELDS
    .map((field) => action[field])
    .find((candidate) => typeof candidate === "string" && candidate.trim());
  const normalizedPath = path
    ? redactPath(path.replaceAll("\\", "/").replace(/^\.\//, "")).slice(0, MAX_PATH_CHARS)
    : null;
  const children = Array.isArray(action.ops)
    ? action.ops.slice(0, 24).map(normalizeAction)
    : [];
  const ownReadPaths = READ_ACTIONS.has(kind) && normalizedPath ? [normalizedPath] : [];
  const ownEditPaths = EDIT_ACTIONS.has(kind) && normalizedPath ? [normalizedPath] : [];
  const childSignature = children.length
    ? `[${children.map((child) => child.signature).join(",")}]`
    : "";
  return {
    kind,
    path: normalizedPath,
    readPaths: uniqueSorted([
      ...ownReadPaths,
      ...children.flatMap((child) => child.readPaths),
    ]),
    editPaths: uniqueSorted([
      ...ownEditPaths,
      ...children.flatMap((child) => child.editPaths),
    ]),
    signature: `${normalizedPath ? `${kind}:${normalizedPath}` : kind}${childSignature}`
      .slice(0, MAX_SIGNATURE_CHARS),
  };
}

function consensusFacts(local, rows) {
  const passed = rows.filter((row) => row.reference.passed);
  const source = passed.length ? passed : rows;
  return {
    referenceCount: rows.length,
    passingReferenceCount: passed.length,
    allReferencesPassedWhileLocalFailed:
      !local.passed && passed.length === rows.length && rows.length > 0,
    referenceOnlyReadPaths: intersection(
      source.map((row) => new Set(row.referenceOnly.readPaths)),
    ),
    referenceOnlyEditPaths: intersection(
      source.map((row) => new Set(row.referenceOnly.editPaths)),
    ),
    referenceOnlyActionKinds: intersection(
      source.map((row) => new Set(row.referenceOnly.actionKinds)),
    ),
  };
}

function histogramDelta(local, reference) {
  const keys = new Set([...Object.keys(local), ...Object.keys(reference)]);
  return Object.fromEntries([...keys].sort().map((key) => [
    key,
    (reference[key] ?? 0) - (local[key] ?? 0),
  ]).filter(([, delta]) => delta !== 0));
}

function nullableDelta(left, right) {
  return Number.isInteger(left) && Number.isInteger(right) ? left - right : null;
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function intersection(sets) {
  if (!sets.length) return [];
  return [...sets[0]].filter((value) => sets.every((set) => set.has(value))).sort();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function requireArtifact(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (value.kind !== "bantam-run") throw new Error(`${label} is not a saved bantam-run artifact`);
  if (!value.runId) throw new Error(`${label} is missing runId`);
}

function redactPath(value) {
  let text = String(value ?? "").replace(/\u0000/g, "");
  for (const pattern of PRIVATE_PATH_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
