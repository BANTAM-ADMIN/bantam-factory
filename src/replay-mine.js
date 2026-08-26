import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixtureEvaluatorRoot } from "./fixture-provenance.js";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_SCAN_FILES = 100_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PRIORITY_TURNS = 5;
const FAILURE_STATUSES = new Set(["contract-fail", "fail", "cheated"]);
const EDIT_ACTIONS = new Set(["write_file", "replace", "edit_lines", "patch"]);
const TERMINAL_ACTIONS = new Set(["done", "respond"]);

/**
 * Find exact-task mixed-outcome cohorts that can support replay hypothesis
 * design. This is witness discovery only: a passing reference and a replayable
 * failure do not establish a remedy or causality.
 */
export function mineReplayCohorts({
  roots = [".bantam"],
  maxFiles = DEFAULT_MAX_FILES,
  maxScanFiles = DEFAULT_MAX_SCAN_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  untreatedOnly = false,
  uncontrastedOnly = false,
  uncoveredOnly = false,
  coverage = [],
} = {}) {
  if (typeof untreatedOnly !== "boolean") {
    throw new Error("replay mine untreatedOnly must be a boolean");
  }
  if (typeof uncontrastedOnly !== "boolean") {
    throw new Error("replay mine uncontrastedOnly must be a boolean");
  }
  if (typeof uncoveredOnly !== "boolean") {
    throw new Error("replay mine uncoveredOnly must be a boolean");
  }
  const coverageByArtifact = normalizeReplayCoverage(coverage);
  validateEvidenceFileBound(maxFiles);
  const files = discoverJsonFiles(roots, maxScanFiles);
  const groups = new Map();
  const studiesByArtifactTurn = new Map();
  const ignored = {
    malformed: 0,
    oversized: 0,
    nonRun: 0,
    noTask: 0,
    invalidStudy: 0,
  };
  let runArtifacts = 0;
  let replayStudyArtifacts = 0;
  let evidenceJsonFiles = 0;

  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) {
      ignored.oversized++;
      continue;
    }
    let bytes;
    let artifact;
    try {
      bytes = fs.readFileSync(file);
      artifact = JSON.parse(bytes);
    } catch {
      ignored.malformed++;
      continue;
    }
    if (artifact?.kind === "bantam-replay-experiment") {
      evidenceJsonFiles++;
      enforceEvidenceFileBound(evidenceJsonFiles, maxFiles);
      const study = replayStudyView(artifact, file, bytes);
      if (!study) {
        ignored.invalidStudy++;
        continue;
      }
      const key = artifactTurnKey(study.sourceArtifactSha256, study.turn);
      const studies = studiesByArtifactTurn.get(key) ?? [];
      studies.push(study);
      studiesByArtifactTurn.set(key, studies);
      replayStudyArtifacts++;
      continue;
    }
    if (artifact?.kind !== "bantam-run") {
      ignored.nonRun++;
      continue;
    }
    evidenceJsonFiles++;
    enforceEvidenceFileBound(evidenceJsonFiles, maxFiles);
    const task = normalizeTask(artifact.task);
    if (!task) {
      ignored.noTask++;
      continue;
    }
    runArtifacts++;
    const taskSha256 = sha256(task);
    const evaluator = evaluatorIdentity(artifact, file, bytes);
    const groupKey = `${taskSha256}\0${evaluator.key}`;
    const group = groups.get(groupKey) ?? {
      task,
      taskSha256,
      evaluatorIdentity: evaluator.public,
      runs: [],
    };
    group.runs.push(runView(artifact, file, bytes, evaluator.public));
    groups.set(groupKey, group);
  }

  for (const studies of studiesByArtifactTurn.values()) {
    studies.sort((left, right) => left.path.localeCompare(right.path));
  }

  const compatibleCohorts = [...groups.values()]
    .map((group) => {
      const runs = group.runs.map((run) => ({
        ...withReplayStudies(run, studiesByArtifactTurn),
        declaredCoverage: coverageByArtifact.get(run.sha256) ?? null,
      }));
      const references = runs.filter((run) => run.pass);
      const failures = runs.filter((run) => run.observedFailure);
      const eligibleFailures = uncoveredOnly
        ? failures.filter((run) => !run.declaredCoverage)
        : failures;
      const replayableFailures = eligibleFailures
        .filter((run) => run.replayableTurns.length > 0);
      const untreatedReplayableFailures = replayableFailures
        .filter((run) => run.untreatedReplayableTurns.length > 0);
      if (!references.length || !replayableFailures.length) return null;
      const experimentContrasts = crossArmExperimentContrasts(runs);
      return {
        taskSha256: group.taskSha256,
        taskPreview: bounded(group.task, 240),
        evaluatorIdentity: group.evaluatorIdentity,
        failures,
        replayableFailures,
        untreatedReplayableFailures,
        references,
        experimentContrasts,
      };
    })
    .filter(Boolean);
  const excludedCrossArmContrastedCohorts = uncontrastedOnly
    ? compatibleCohorts.filter((cohort) => cohort.experimentContrasts.length > 0).length
    : 0;
  const allCohorts = uncontrastedOnly
    ? compatibleCohorts.filter((cohort) => cohort.experimentContrasts.length === 0)
    : compatibleCohorts;
  const totals = replayStudyCoverage(allCohorts);
  const cohorts = allCohorts
    .map((cohort) => {
      const selectedFailures = untreatedOnly
        ? cohort.untreatedReplayableFailures
        : cohort.replayableFailures;
      const publicFailures = cohort.failures
        .map((failure) => publicRunView(failure, failure.replayableTurns));
      const publicReplayableFailures = selectedFailures.map((failure) =>
        publicRunView(
          failure,
          untreatedOnly
            ? failure.untreatedReplayableTurns
            : failure.replayableTurns,
        ));
      const failureModes = clusterFailureModes(publicReplayableFailures);
      return {
        ...cohort,
        failures: publicFailures,
        replayableFailures: publicReplayableFailures,
        untreatedReplayableFailures: cohort.untreatedReplayableFailures
          .map((failure) => publicRunView(failure, failure.untreatedReplayableTurns)),
        references: cohort.references
          .map((reference) => publicRunView(reference, reference.replayableTurns)),
        failureModes,
        representativeReplayFailures: failureModes
          .map((mode) => publicReplayableFailures.find((failure) =>
            failure.sha256 === mode.representative.sha256)),
      };
    })
    .filter((cohort) => cohort.replayableFailures.length > 0)
    .sort((left, right) =>
      right.replayableFailures.length - left.replayableFailures.length
      || left.taskSha256.localeCompare(right.taskSha256));
  const priorityReplayTurns = cohorts.reduce((total, cohort) =>
    total + cohort.replayableFailures.reduce((subtotal, failure) =>
      subtotal + failure.priorityReplayTurns.length, 0), 0);
  const replayableFailures = cohorts.reduce((total, cohort) =>
    total + cohort.replayableFailures.length, 0);
  const failureModes = cohorts.reduce((total, cohort) =>
    total + cohort.failureModes.length, 0);

  return {
    schema: 1,
    kind: "bantam-replay-specimen-mine",
    status: "witness-only",
    boundary: "Mixed exact-task, evaluator-compatible outcomes locate replay specimens; they do not identify a causal remedy or justify promotion. New artifacts match exact fixture content roots; legacy artifacts match only within one experiment. Study status reflects only exact artifact-hash-and-turn evidence found under the scanned roots.",
    studyEvidenceBoundary: "Studied or attempted means a structurally complete replay artifact exists; run audit-replay before relying on that study's result.",
    experimentContrastBoundary: "A cross-arm contrast means one saved experiment contains failures in one arm and passes in a different arm. It prevents rediscovery but does not by itself prove that the arm difference caused the outcome or that a remedy was promoted.",
    rankingBoundary: "Priority scores are transparent retrospective heuristics, not causal turn identification; every candidate turn remains in the report.",
    failureModeBoundary: "Failure fingerprints use authoritative structured verifier evidence for navigation only; representatives do not establish causality and every artifact remains in JSON evidence.",
    declaredCoverageBoundary: "Declared coverage is an operator-supplied, artifact-SHA-pinned navigation exclusion with named evidence. It does not prove that the current safeguard caused a pass; inspect and test the cited evidence before relying on it.",
    filter: [
      untreatedOnly ? "untreated-only" : null,
      uncontrastedOnly ? "uncontrasted" : null,
      uncoveredOnly ? "uncovered" : null,
    ].filter(Boolean).join("+") || "all",
    roots: roots.map((root) => path.resolve(root)),
    scannedJsonFiles: files.length,
    evidenceJsonFiles,
    runArtifacts,
    replayStudyArtifacts,
    indexedArtifactTurns: studiesByArtifactTurn.size,
    duplicateReplayStudyArtifacts: Math.max(
      0,
      replayStudyArtifacts - studiesByArtifactTurn.size,
    ),
    replayableTurns: totals.replayable,
    studiedReplayableTurns: totals.studied,
    attemptedReplayableTurns: totals.attempted,
    untreatedReplayableTurns: totals.untreated,
    candidateReplayTurns: untreatedOnly ? totals.untreated : totals.replayable,
    priorityReplayTurns,
    replayableFailures,
    failureModes,
    representativeReplayFailures: failureModes,
    priorStudyTurnsExcluded: untreatedOnly
      ? totals.studied + totals.attempted
      : 0,
    crossArmExperimentContrasts: cohorts.reduce((total, cohort) =>
      total + cohort.experimentContrasts.length, 0),
    excludedCrossArmContrastedCohorts,
    declaredCoverageEntries: coverageByArtifact.size,
    declaredCoveredFailures: [...groups.values()].reduce((total, group) =>
      total + group.runs.filter((run) =>
        run.observedFailure && coverageByArtifact.has(run.sha256)).length, 0),
    ignored,
    cohorts,
  };
}

export function loadReplayCoverage(file) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (parsed?.schema !== 1 || parsed?.kind !== "bantam-replay-coverage") {
    throw new Error("replay coverage must be schema 1 kind bantam-replay-coverage");
  }
  if (!Array.isArray(parsed.failures)) {
    throw new Error("replay coverage failures must be an array");
  }
  return parsed.failures;
}

/**
 * Select one verifier-backed mode by a unique SHA-256 prefix. This is a
 * projection of an already-mined report: it does not rescan, rescore, or infer
 * that the grouped artifacts share a cause.
 */
export function selectReplayFailureMode(report, selector) {
  if (typeof selector !== "string" || !/^[a-f0-9]{8,64}$/i.test(selector)) {
    throw new Error("replay mine failure mode must be an 8-64 character hexadecimal SHA-256 prefix");
  }
  const prefix = selector.toLowerCase();
  const matches = report.cohorts
    .flatMap((cohort) => cohort.failureModes)
    .filter((mode) => mode.sha256.startsWith(prefix));
  const identities = [...new Set(matches.map((mode) => mode.sha256))];
  if (!identities.length) {
    throw new Error(`replay mine failure mode not found: ${selector}`);
  }
  if (identities.length > 1) {
    throw new Error(`replay mine failure mode prefix is ambiguous: ${selector}`);
  }
  const identity = identities[0];
  const cohorts = report.cohorts
    .map((cohort) => {
      const failureModes = cohort.failureModes
        .filter((mode) => mode.sha256 === identity);
      if (!failureModes.length) return null;
      const artifactHashes = new Set(
        failureModes.flatMap((mode) => mode.artifacts.map((artifact) => artifact.sha256)),
      );
      const replayableFailures = cohort.replayableFailures
        .filter((failure) => artifactHashes.has(failure.sha256));
      return {
        ...cohort,
        failures: cohort.failures.filter((failure) => artifactHashes.has(failure.sha256)),
        replayableFailures,
        untreatedReplayableFailures: cohort.untreatedReplayableFailures
          .filter((failure) => artifactHashes.has(failure.sha256)),
        failureModes,
        representativeReplayFailures: cohort.representativeReplayFailures
          .filter((failure) => artifactHashes.has(failure.sha256)),
      };
    })
    .filter(Boolean);
  const replayableFailures = cohorts.reduce((total, cohort) =>
    total + cohort.replayableFailures.length, 0);
  const candidateReplayTurns = cohorts.reduce((total, cohort) =>
    total + cohort.replayableFailures.reduce((subtotal, failure) =>
      subtotal + failure.candidateReplayTurns.length, 0), 0);
  const priorityReplayTurns = cohorts.reduce((total, cohort) =>
    total + cohort.replayableFailures.reduce((subtotal, failure) =>
      subtotal + failure.priorityReplayTurns.length, 0), 0);
  return {
    ...report,
    failureModeFilter: identity,
    candidateReplayTurns,
    priorityReplayTurns,
    replayableFailures,
    failureModes: 1,
    representativeReplayFailures: 1,
    cohorts,
  };
}

export function formatReplayMine(report) {
  const lines = [
    "Replay specimen mine",
    `Scanned ${report.scannedJsonFiles} JSON files · ${report.evidenceJsonFiles ?? "unknown"} evidence files · ${report.runArtifacts} run artifacts · ${report.replayStudyArtifacts ?? 0} replay studies`,
    `Indexed ${report.indexedArtifactTurns ?? 0} exact artifact-turns · ${report.cohorts.length} mixed exact-task cohorts · filter ${report.filter ?? "all"}`,
    `Candidate replay turns ${report.candidateReplayTurns ?? "unknown"} · prior-study turns excluded ${report.priorStudyTurnsExcluded ?? 0}`,
    `Cross-arm experiment contrasts ${report.crossArmExperimentContrasts ?? 0} · contrasted cohorts excluded ${report.excludedCrossArmContrastedCohorts ?? 0}`,
    `Priority shortlist ${report.priorityReplayTurns ?? "unknown"} turns (up to ${MAX_PRIORITY_TURNS} per failure)`,
    `Boundary: ${report.boundary}`,
    `Study evidence: ${report.studyEvidenceBoundary}`,
    `Experiment contrasts: ${report.experimentContrastBoundary}`,
    `Ranking: ${report.rankingBoundary}`,
    `Failure modes: ${report.failureModeBoundary}`,
    `Declared coverage: ${report.declaredCoverageBoundary}`,
    `Declared covered failures ${report.declaredCoveredFailures ?? 0} · registry entries ${report.declaredCoverageEntries ?? 0}`,
  ];
  for (const [index, cohort] of report.cohorts.entries()) {
    lines.push(
      "",
      `${index + 1}. ${cohort.taskPreview}`,
      `   task ${cohort.taskSha256}`,
      `   evaluator ${cohort.evaluatorIdentity?.status ?? "unknown"} ${cohort.evaluatorIdentity?.sha256 ?? "unavailable"}`,
      `   ${cohort.replayableFailures.length} failures · ${cohort.failureModes.length} failure modes · untreated failures ${cohort.untreatedReplayableFailures?.length ?? "unknown"} · passing references ${cohort.references.length}`,
    );
    for (const contrast of cohort.experimentContrasts ?? []) {
      lines.push(
        `   CONTRAST ${contrast.name} · fail ${contrast.failingArms.join(", ")} · pass ${contrast.passingArms.join(", ")}`,
      );
    }
    for (const mode of cohort.failureModes) {
      lines.push(
        `   MODE ${mode.sha256.slice(0, 12)} ×${mode.count} ${mode.label}`,
        `        REP ${mode.representative.model} · priority ${priorityTurnList(mode.representative.priorityReplayTurns)}`,
        `        ${mode.representative.path}`,
        ...(mode.count > 1
          ? [`        ${mode.count - 1} equivalent artifact(s) retained in JSON evidence`]
          : []),
      );
    }
    for (const reference of cohort.references.slice(0, 3)) {
      lines.push(`   PASS ${reference.model} · ${reference.path}`);
    }
  }
  return lines.join("\n");
}

function replayStudyView(artifact, file, bytes) {
  const sourceArtifactSha256 = String(artifact?.artifact?.sha256 ?? "");
  const turn = artifact?.spec?.turn;
  const samples = artifact?.spec?.samples;
  const pairs = artifact?.pairs;
  const status = String(artifact?.status ?? "");
  if (
    artifact?.schema !== 1
    || !/^[a-f0-9]{64}$/i.test(sourceArtifactSha256)
    || !Number.isInteger(turn)
    || turn < 0
    || !Number.isInteger(samples)
    || samples < 1
    || !Array.isArray(pairs)
    || pairs.length !== samples
    || artifact?.totals?.samples !== samples
    || !["complete", "complete_with_errors"].includes(status)
  ) return null;
  const verdict = String(artifact?.totals?.verdict ?? "unknown");
  const outcome = status === "complete" && verdict !== "inconclusive"
    ? "studied"
    : "attempted";
  return {
    path: path.resolve(file),
    sha256: sha256(bytes),
    name: bounded(artifact.name ?? path.basename(file), 120),
    sourceArtifactSha256: sourceArtifactSha256.toLowerCase(),
    turn,
    status,
    verdict,
    outcome,
  };
}

function withReplayStudies(run, studiesByArtifactTurn) {
  const replayableTurnEvidence = run.replayableTurns.map((turn) => {
    const studies = studiesByArtifactTurn.get(artifactTurnKey(run.sha256, turn)) ?? [];
    const status = studies.some((study) => study.outcome === "studied")
      ? "studied"
      : studies.length
        ? "attempted"
        : "untreated";
    return { turn, status, studies };
  });
  return {
    ...run,
    replayableTurnEvidence,
    studiedReplayableTurns: replayableTurnEvidence
      .filter((entry) => entry.status === "studied")
      .map((entry) => entry.turn),
    attemptedReplayableTurns: replayableTurnEvidence
      .filter((entry) => entry.status === "attempted")
      .map((entry) => entry.turn),
    untreatedReplayableTurns: replayableTurnEvidence
      .filter((entry) => entry.status === "untreated")
      .map((entry) => entry.turn),
  };
}

function artifactTurnKey(sha, turn) {
  return `${String(sha).toLowerCase()}:${turn}`;
}

function replayStudyCoverage(cohorts) {
  const totals = { replayable: 0, studied: 0, attempted: 0, untreated: 0 };
  for (const cohort of cohorts) {
    for (const failure of cohort.replayableFailures) {
      totals.replayable += failure.replayableTurns.length;
      totals.studied += failure.studiedReplayableTurns.length;
      totals.attempted += failure.attemptedReplayableTurns.length;
      totals.untreated += failure.untreatedReplayableTurns.length;
    }
  }
  return totals;
}

function turnList(turns) {
  return Array.isArray(turns) && turns.length ? turns.join(",") : "none";
}

function priorityTurnList(entries) {
  if (!Array.isArray(entries) || !entries.length) return "none";
  return entries.map((entry) => `${entry.turn}(${entry.score})`).join(", ");
}

function normalizeReplayCoverage(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("replay mine coverage must be an array");
  }
  const out = new Map();
  for (const [index, entry] of entries.entries()) {
    const label = `replay coverage entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const artifactSha256 = String(entry.artifactSha256 ?? "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
      throw new Error(`${label} artifactSha256 must be a SHA-256`);
    }
    const mechanism = String(entry.mechanism ?? "").trim();
    if (!mechanism) throw new Error(`${label} mechanism is required`);
    if (!Array.isArray(entry.evidence) || !entry.evidence.length
        || entry.evidence.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`${label} evidence must be a non-empty string array`);
    }
    if (out.has(artifactSha256)) {
      throw new Error(`${label} duplicates artifactSha256 ${artifactSha256}`);
    }
    out.set(artifactSha256, {
      artifactSha256,
      mechanism,
      evidence: [...entry.evidence],
      note: typeof entry.note === "string" && entry.note.trim()
        ? entry.note.trim()
        : null,
    });
  }
  return out;
}

function discoverJsonFiles(roots, maxScanFiles) {
  if (!Number.isInteger(maxScanFiles) || maxScanFiles < 1) {
    throw new Error("replay mine maxScanFiles must be a positive integer");
  }
  const files = [];
  const stack = roots.map((root) => path.resolve(root));
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (current.endsWith(".json")) files.push(current);
    } else if (stat.isDirectory()) {
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        stack.push(path.join(current, entry.name));
      }
    }
    if (files.length > maxScanFiles) {
      throw new Error(`replay mine exceeded its ${maxScanFiles}-JSON scan bound`);
    }
  }
  return files.sort();
}

function enforceEvidenceFileBound(count, maxFiles) {
  validateEvidenceFileBound(maxFiles);
  if (count > maxFiles) {
    throw new Error(`replay mine exceeded its ${maxFiles}-evidence-file bound`);
  }
}

function validateEvidenceFileBound(maxFiles) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error("replay mine maxFiles must be a positive integer");
  }
}

function runView(artifact, file, bytes, evaluatorIdentity) {
  const pass = artifact?.result?.pass === true;
  const status = String(artifact?.result?.status ?? "");
  const contractFailed = artifact?.result?.contract?.pass === false;
  const observedFailure = !pass && (contractFailed || FAILURE_STATUSES.has(status));
  const replayableTurns = replayableTurnIndices(artifact);
  return {
    path: path.resolve(file),
    sha256: sha256(bytes),
    runId: artifact.runId ?? null,
    evaluatorIdentity,
    experiment: normalizeRunExperiment(artifact?.experiment),
    model: artifact?.model?.metadata?.model
      ?? artifact?.model?.model
      ?? artifact?.modelId
      ?? "unknown",
    pass,
    status: status || (pass ? "pass" : "unknown"),
    observedFailure,
    turns: Array.isArray(artifact.turns) ? artifact.turns.length : 0,
    replayableTurns,
    _replayTurnRanking: observedFailure
      ? rankReplayTurns(artifact, replayableTurns)
      : [],
    failureSummary: failureSummary(artifact),
    failureMode: failureMode(artifact),
  };
}

function crossArmExperimentContrasts(runs) {
  const groups = new Map();
  for (const run of runs) {
    const experiment = run.experiment;
    if (!experiment?.id || !experiment.arm) continue;
    const group = groups.get(experiment.id) ?? {
      id: experiment.id,
      name: experiment.name ?? experiment.id,
      failing: new Map(),
      passing: new Map(),
    };
    const target = run.pass
      ? group.passing
      : run.observedFailure
        ? group.failing
        : null;
    if (target) target.set(experiment.arm, (target.get(experiment.arm) ?? 0) + 1);
    groups.set(experiment.id, group);
  }
  return [...groups.values()]
    .filter((group) =>
      group.failing.size > 0
      && group.passing.size > 0
      && [...group.failing.keys()].some((failingArm) =>
        [...group.passing.keys()].some((passingArm) => passingArm !== failingArm)))
    .map((group) => ({
      id: group.id,
      name: group.name,
      failingArms: [...group.failing.keys()].sort(),
      passingArms: [...group.passing.keys()].sort(),
      failureRuns: [...group.failing.values()].reduce((sum, value) => sum + value, 0),
      passingRuns: [...group.passing.values()].reduce((sum, value) => sum + value, 0),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeRunExperiment(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: typeof value.id === "string" ? value.id : null,
    name: typeof value.name === "string" ? value.name : null,
    arm: typeof value.arm === "string" ? value.arm : null,
    round: Number.isInteger(value.round) ? value.round : null,
  };
}

function evaluatorIdentity(artifact, file, bytes) {
  const captured = artifact?.fixtureProvenance?.evaluatorSha256;
  if (typeof captured === "string"
      && fixtureEvaluatorRoot(artifact.fixtureProvenance) === captured) {
    return {
      key: `fixture:${captured}`,
      public: { status: "captured-fixture", sha256: captured },
    };
  }
  const experimentId = artifact?.experiment?.id;
  if (typeof experimentId === "string" && experimentId) {
    const digest = sha256(`${experimentId}\0${String(artifact?.fixture ?? "")}`);
    return {
      key: `legacy-experiment:${digest}`,
      public: { status: "legacy-experiment", sha256: digest },
    };
  }
  // A legacy standalone run has no evidence that another artifact used the
  // same grader. Give it a unique identity instead of manufacturing a cohort.
  const digest = sha256(bytes);
  return {
    key: `legacy-unverified:${digest}`,
    public: {
      status: "legacy-unverified",
      sha256: digest,
      artifact: path.resolve(file),
    },
  };
}

function publicRunView(run, candidateReplayTurns) {
  const { _replayTurnRanking = [], ...visible } = run;
  const candidates = new Set(candidateReplayTurns);
  return {
    ...visible,
    candidateReplayTurns,
    priorityReplayTurns: _replayTurnRanking
      .filter((entry) => candidates.has(entry.turn))
      .slice(0, MAX_PRIORITY_TURNS),
  };
}

function clusterFailureModes(failures) {
  const groups = new Map();
  for (const failure of failures) {
    const mode = failure.failureMode;
    const group = groups.get(mode.sha256) ?? {
      sha256: mode.sha256,
      category: mode.category,
      label: mode.label,
      failures: [],
    };
    group.failures.push(failure);
    groups.set(mode.sha256, group);
  }
  return [...groups.values()]
    .map((group) => {
      const ranked = [...group.failures].sort((left, right) =>
        priorityScore(right) - priorityScore(left)
        || left.candidateReplayTurns.length - right.candidateReplayTurns.length
        || left.path.localeCompare(right.path));
      const representative = ranked[0];
      return {
        sha256: group.sha256,
        category: group.category,
        label: group.label,
        count: ranked.length,
        models: [...new Set(ranked.map((failure) => failure.model))].sort(),
        representative: {
          path: representative.path,
          sha256: representative.sha256,
          runId: representative.runId,
          model: representative.model,
          priorityReplayTurns: representative.priorityReplayTurns,
          selection: "highest top-turn priority, then fewest candidate turns, then lexical artifact path",
        },
        artifacts: ranked.map((failure) => ({
          path: failure.path,
          sha256: failure.sha256,
          runId: failure.runId,
          model: failure.model,
        })),
      };
    })
    .sort((left, right) =>
      right.count - left.count || left.sha256.localeCompare(right.sha256));
}

function priorityScore(failure) {
  return Number(failure?.priorityReplayTurns?.[0]?.score ?? 0);
}

function replayableTurnIndices(artifact) {
  if (!Array.isArray(artifact.turns) || !Array.isArray(artifact.modelCalls)) return [];
  const calls = new Set(artifact.modelCalls
    .filter((call) => typeof call?.request?.body === "string")
    .map((call) => call.index));
  return artifact.turns
    .filter((turn) => Number.isInteger(turn?.i) && calls.has(turn.modelCallIndex))
    .map((turn) => turn.i);
}

function failureSummary(artifact) {
  const detail = failureDetail(artifact);
  const lines = detail.split("\n").map((line) => line.trim()).filter(Boolean);
  const specific = lines.find((line) =>
    /^(?:The input did not|Expected values|ERR_|ENOENT|Cannot find)/i.test(line))
    ?? lines.find((line) => /^error:/i.test(line) && !/^error:\s*\|[-+]?$/i.test(line))
    ?? lines.find((line) => !/^(?:TAP version|AssertionError|error:\s*\|[-+]?)$/i.test(line));
  return bounded(specific ?? "failure", 240);
}

function failureMode(artifact) {
  const detail = failureDetail(artifact);
  const summary = failureSummary(artifact);
  const subtest = detail.match(/^# Subtest:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const assertionLocation = detail.match(/TestContext\.<anonymous>\s*\((.+):(\d+):(\d+)\)/);
  const locationMatch = assertionLocation
    ?? detail.match(/^\s*location:\s*['"]?(.+):(\d+):(\d+)['"]?\s*$/m);
  const location = locationMatch
    ? `${normalizeFailureLocation(locationMatch[1])}:${locationMatch[2]}`
    : null;
  const code = detail.match(/^\s*code:\s*['"]([^'"]+)['"]\s*$/m)?.[1] ?? null;
  const operator = detail.match(/^\s*operator:\s*['"]([^'"]+)['"]\s*$/m)?.[1] ?? null;
  const result = artifact?.result ?? {};
  const scopeFailure = result?.contract?.pass !== false
    && typeof result.verifyDetail === "string"
    && /scope violation|test-tampering|out-of-scope/i.test(result.verifyDetail);
  const category = scopeFailure
    ? "scope"
    : location || code || operator
      ? "contract-assertion"
      : "unstructured";
  const evidence = scopeFailure
    ? {
        category,
        summary: normalizeFailureText(summary),
      }
    : {
        category,
        subtest: normalizeFailureText(subtest),
        location,
        code,
        operator,
        headline: normalizeFailureText(summary),
      };
  return {
    sha256: sha256(JSON.stringify(evidence)),
    category,
    label: bounded(
      [summary, location ? `at ${location}` : null].filter(Boolean).join(" "),
      320,
    ),
    evidence,
  };
}

function failureDetail(artifact) {
  const result = artifact?.result ?? {};
  const contract = result.contract ?? {};
  const authoritativeDetail = contract.pass === false
    ? contract.detail
    : result.verifyDetail
      ?? result.reason
      ?? contract.detail;
  return String(
    authoritativeDetail
    ?? result.status
    ?? "failure",
  ).replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeFailureLocation(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^['"]|['"]$/g, "");
  const grader = normalized.lastIndexOf("/grader/");
  if (grader >= 0) return normalized.slice(grader + 1);
  return normalized.split("/").filter(Boolean).slice(-3).join("/");
}

function normalizeFailureText(value) {
  return value === null || value === undefined
    ? null
    : String(value).replace(/\s+/g, " ").trim();
}

function rankReplayTurns(artifact, replayableTurns) {
  const turns = Array.isArray(artifact.turns) ? artifact.turns : [];
  const replayable = new Set(replayableTurns);
  const task = String(artifact.task ?? "");
  const ranked = [];
  for (let position = 0; position < turns.length; position++) {
    const turn = turns[position];
    if (!replayable.has(turn?.i)) continue;
    const current = turn?.parsedAction ?? turn?.action ?? {};
    const previousTurn = position > 0 ? turns[position - 1] : null;
    const previous = previousTurn?.parsedAction ?? previousTurn?.action ?? {};
    const currentVerb = String(current?.a ?? "unknown");
    const previousVerb = String(previous?.a ?? "unknown");
    const currentPaths = actionPaths(current);
    const previousPaths = actionPaths(previous);
    const reasons = [];
    let score = 10;

    if (EDIT_ACTIONS.has(previousVerb)) {
      score += 35;
      reasons.push(`prompt follows immediately preceding ${previousVerb}${pathSuffix(previousPaths)}`);
      const named = previousPaths.filter((file) => taskNamesPath(task, file));
      if (named.length) {
        score += 10;
        reasons.push(`immediately preceding edit targets task-named path ${named.join(", ")}`);
      }
    }
    const priorObservation = String(previousTurn?.observation ?? "");
    if (looksFailed(priorObservation)) {
      score += 30;
      reasons.push("prompt contains an immediately preceding failed verification");
    } else if (looksPassed(priorObservation)) {
      score += 12;
      reasons.push("prompt contains an immediately preceding successful verification");
    }
    if (previousVerb === "query" && /\bview_image\b/i.test(String(previous?.q ?? ""))) {
      score += 15;
      reasons.push("prompt follows grounded image inspection evidence");
    }
    if (EDIT_ACTIONS.has(currentVerb)) {
      score += 25;
      reasons.push(`original action edits workspace${pathSuffix(currentPaths)}`);
      const named = currentPaths.filter((file) => taskNamesPath(task, file));
      if (named.length) {
        score += 10;
        reasons.push(`original action edits task-named path ${named.join(", ")}`);
      }
    }
    if (currentVerb === "shell" || currentVerb === "verify") {
      score += 5;
      reasons.push("original action checks the workspace");
    }
    if (TERMINAL_ACTIONS.has(currentVerb)) {
      score -= 25;
      reasons.push("original action is terminal, lowering intervention priority");
    }
    ranked.push({
      turn: turn.i,
      score: Math.max(0, Math.min(100, score)),
      originalAction: {
        verb: currentVerb,
        paths: currentPaths,
      },
      reasons,
    });
  }
  return ranked.sort((left, right) =>
    right.score - left.score || left.turn - right.turn);
}

function actionPaths(action) {
  const values = [];
  for (const field of ["p", "path", "file"]) {
    if (typeof action?.[field] === "string") values.push(action[field]);
  }
  if (Array.isArray(action?.edits)) {
    for (const edit of action.edits) {
      if (typeof edit?.p === "string") values.push(edit.p);
    }
  }
  return [...new Set(values.map((value) => value.replaceAll("\\", "/")))];
}

function taskNamesPath(task, file) {
  const source = String(task).toLowerCase();
  const normalized = String(file).toLowerCase();
  const basename = path.posix.basename(normalized);
  return source.includes(normalized)
    || (basename.length >= 4 && source.includes(basename));
}

function pathSuffix(paths) {
  return paths.length ? ` to ${paths.join(", ")}` : "";
}

function looksFailed(value) {
  return /VERDICT:[^\n]*FAILED|AssertionError|\bERR_[A-Z_]+\b|\bexit [1-9]\d*\b/i.test(value);
}

function looksPassed(value) {
  return /VERDICT:[^\n]*\bpass(?:ed)?\b|\ball \d+ tests? passed\b|\bexit 0\b/i.test(value);
}

function normalizeTask(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

function bounded(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
