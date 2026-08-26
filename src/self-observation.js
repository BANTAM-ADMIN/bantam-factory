// Bounded, redacted telemetry for Bantam improving Bantam.
//
// This store deliberately records outcomes, not trajectories. Task text is
// represented only by its SHA-256 digest; prompts, summaries, verifier output,
// rejected model output, paths, and block messages never enter the persisted
// shape. Persistence is enabled only for an exact Bantam development checkout.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ALL_ACTION_VERBS } from "./action-protocol.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { acquireExclusiveFileLock } from "./exclusive-file-lock.js";

export const SELF_OBSERVATION_LIMIT = 200;
export const SELF_OBSERVATION_PATH = ".bantam/self-observations.json";
export const EXCESSIVE_TURNS_THRESHOLD = 30;
export const MIN_AFFECTED_RUNS = 2;
const OBSERVATION_LOCK_WAIT_MS = 2_000;
const OBSERVATION_LOCK_STALE_MS = 30_000;
const OBSERVATION_LOCK_POLL_MS = 10;

export const BANTAM_SELF_HOST_MARKERS = Object.freeze([
  "package.json",
  "bin/run-dev.sh",
  "bin/bantam.js",
  "src/agent.js",
  "src/self-improve.js",
]);

const OBSERVATION_KIND = "bantam.self-observation";
const ACTION_NAMES = new Set(ALL_ACTION_VERBS);
const MUTATING_ACTION_NAMES = new Set([
  "replace",
  "edit_lines",
  "patch",
  "write_file",
  "delete_file",
  "move_file",
]);
const VERIFICATION_STATUSES = new Set(["pass", "fail", "unverified"]);
const RESULT_STATUSES = new Set(["pass", "fail", "unverified", "interrupted", "blocked"]);
const COUNT_FIELDS = Object.freeze([
  "invalid",
  "protocolViolations",
  "duplicateActionRejections",
  "duplicateShellRejections",
  "repeatEscapeMasks",
  "noOpEdits",
]);
const EDIT_FAILURE_FIELDS = Object.freeze({
  replace: ["total", "oldNotFound", "ambiguous", "lineStale", "other"],
  patch: ["total", "oldNotFound", "ambiguous", "overlap", "other"],
  fileOperations: ["total", "delete_file", "move_file", "other"],
});

/**
 * Recognize only this development harness, using stable exact marker paths and
 * the package identity that owns its local launcher. Markers must be regular
 * files; a symlink cannot opt an unrelated workspace into self-observation.
 */
export function isBantamSelfHostWorkspace(workspace) {
  if (typeof workspace !== "string" || !workspace || workspace.includes("\0")) return false;
  const root = path.resolve(workspace);
  for (const marker of BANTAM_SELF_HOST_MARKERS) {
    try {
      if (!fs.lstatSync(path.join(root, marker)).isFile()) return false;
    } catch {
      return false;
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return pkg?.name === "bantam"
      && pkg?.private === true
      && pkg?.type === "module"
      && pkg?.bin?.bantam === "bin/bantam.js";
  } catch {
    return false;
  }
}

/**
 * Reduce one completed run to bounded counters suitable for longitudinal
 * self-host diagnosis. The returned value has no references to the input.
 */
export function summarizeSelfObservation({
  task,
  result,
  recordedAt = new Date().toISOString(),
} = {}) {
  if (typeof task !== "string" || task.length === 0) {
    throw new TypeError("self-observation task must be a non-empty string");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("self-observation result must be an object");
  }

  const artifactResult = result.kind === "bantam-run" ? result.result : null;
  const outcome = artifactResult ?? result;
  const metrics = result.metrics ?? outcome.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new TypeError("self-observation result must contain metrics");
  }

  const timestamp = normalizeTimestamp(recordedAt);
  const verification = normalizeVerification(outcome.verification, artifactResult);
  const editFailures = normalizeEditFailures(metrics);
  const durationMs = nullableCount(metrics.durationMs ?? metrics.totalMs ?? outcome.durationMs);

  return {
    schema: 2,
    kind: OBSERVATION_KIND,
    recordedAt: timestamp,
    taskSha256: sha256(task),
    result: {
      status: normalizeResultStatus(outcome, verification.status),
      verification,
      interrupted: Boolean(outcome.interrupted),
      blocked: Boolean(outcome.blocked),
    },
    metrics: {
      turns: count(metrics.turns),
      invalid: count(metrics.invalid),
      protocolViolations: count(metrics.protocolViolations),
      duplicateActionRejections: count(metrics.duplicateActionRejections),
      duplicateShellRejections: count(metrics.duplicateShellRejections),
      repeatEscapeMasks: count(metrics.repeatEscapeMasks),
      noOpEdits: count(metrics.noOpEdits),
      durationMs,
      actions: normalizeActions(metrics.actions),
      editFailures,
    },
  };
}

/**
 * Decide whether a completed self-host run contains operational evidence.
 * Greetings and read-only explanations are not improvement trials; recording
 * them as "unverified" would manufacture a verifier-reliability weakness.
 */
export function isObservableSelfHostWork(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const artifactResult = result.kind === "bantam-run" ? result.result : null;
  const outcome = artifactResult ?? result;
  if (result.responded || outcome?.responded) return false;

  const verification = outcome?.verification;
  if (verification && ["pass", "fail"].includes(verification.status)) return true;

  const metrics = result.metrics ?? outcome?.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return false;
  const actions = metrics.actions;
  if (actions && typeof actions === "object" && !Array.isArray(actions)) {
    for (const name of MUTATING_ACTION_NAMES) {
      if (finiteNonNegative(actions[name]) && Number(actions[name]) > 0) return true;
    }
  }
  const turns = Array.isArray(result.turns) ? result.turns : [];
  if (turns.some((turn) => (
    turn?.sourceEditedByShell === true
    || Array.isArray(turn?.shellChangedPaths) && turn.shellChangedPaths.length > 0
  ))) {
    return true;
  }
  if (COUNT_FIELDS.some((field) => finiteNonNegative(metrics[field]) && Number(metrics[field]) > 0)) {
    return true;
  }
  return Object.keys(EDIT_FAILURE_FIELDS).some((group) => {
    const sourceName = group === "fileOperations" ? "fileOperationFailures" : `${group}Failures`;
    const failures = metrics[sourceName];
    if (!failures || typeof failures !== "object" || Array.isArray(failures)) return false;
    return Object.values(failures).some((value) => finiteNonNegative(value) && Number(value) > 0);
  });
}

/**
 * Record one observable run against the Bantam checkout that owns the active
 * launcher. `taskWorkspace` is provenance only: a run may operate on any
 * project, but its bounded harness telemetry always belongs to Bantam and must
 * never create `.bantam` state in the project being worked on.
 */
export function observeCompletedSelfHostRun({
  launcherWorkspace,
  taskWorkspace,
  task,
  result,
  warn = () => {},
} = {}) {
  if (!isObservableSelfHostWork(result)) return null;
  if (!isBantamSelfHostWorkspace(launcherWorkspace)) return null;
  // Resolve the task workspace only as non-persisted provenance. In
  // particular, never pass it to recordSelfObservation.
  if (typeof taskWorkspace !== "string" || taskWorkspace.length === 0) return null;
  try {
    return recordSelfObservation(launcherWorkspace, { task, result });
  } catch (error) {
    warn(`self-observation was not recorded: ${error.message}`);
    return null;
  }
}

/**
 * Load the self-host observation ledger. Missing state is an empty history;
 * malformed, symlinked, wrong-schema, or over-limit state is corruption and
 * fails closed.
 */
export function loadSelfObservations(workspace) {
  const root = requireSelfHostWorkspace(workspace);
  const storePath = path.join(root, SELF_OBSERVATION_PATH);
  let stat;
  try {
    stat = fs.lstatSync(storePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`self-observation store is not a regular file: ${storePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch (error) {
    throw new Error(`self-observation store is corrupt: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("self-observation store is corrupt: expected an array");
  }
  if (parsed.length > SELF_OBSERVATION_LIMIT) {
    throw new Error(
      `self-observation store is corrupt: ${parsed.length} entries exceeds ${SELF_OBSERVATION_LIMIT}`,
    );
  }
  return parsed.map((observation, index) => validateObservation(observation, index));
}

/**
 * Atomically append one redacted observation, retaining the newest 200 rows.
 */
export function recordSelfObservation(workspace, input) {
  const root = requireSelfHostWorkspace(workspace);
  const observation = summarizeSelfObservation(input);
  const lock = acquireObservationLock(root);
  try {
    const prior = loadSelfObservations(root);
    const next = [...prior, observation].slice(-SELF_OBSERVATION_LIMIT);
    writeJsonAtomic(path.join(root, SELF_OBSERVATION_PATH), next);
    return observation;
  } finally {
    lock.release();
  }
}

/**
 * Turn repeated self-host outcomes into ordinary improvement candidates.
 * A single bad run is never enough: every emitted candidate is supported by at
 * least MIN_AFFECTED_RUNS independently recorded observations.
 */
export function deriveSelfImprovementCandidates(observations, {
  excessiveTurns = EXCESSIVE_TURNS_THRESHOLD,
} = {}) {
  if (!Array.isArray(observations)) {
    throw new TypeError("self-observations must be an array");
  }
  const turnThreshold = positiveInteger(excessiveTurns, "excessiveTurns");
  const rows = observations.map((observation, index) => validateObservation(observation, index));
  if (rows.length === 0) return [];

  const candidates = [];
  const verifier = aggregate(rows, (row) => {
    if (!row.result.verification.attempted) return null;
    const status = row.result.verification.status;
    return status === "pass" ? null : {
      occurrences: 1,
      breakdown: status === "fail" ? { failed: 1 } : { unverified: 1 },
    };
  });
  if (verifier.affectedRuns >= MIN_AFFECTED_RUNS) {
    candidates.push(candidate({
      id: "observed-verifier-reliability",
      area: "reliability",
      problem: `${verifier.affectedRuns} of ${rows.length} self-host runs failed verification or remained unverified.`,
      proposal: "Harden terminal verification so every edited run executes a fresh, authoritative verifier and treats timeout, signal, and missing verdicts as unverified.",
      targets: ["verification-reliability.js", "agent.js", "executor.js", "verifier-detect.js"],
      occurrences: verifier.occurrences,
      effort: 2,
      impact: 5,
      aggregate: verifier,
      totalRuns: rows.length,
    }));
  }

  const edits = aggregate(rows, (row) => {
    const failures = row.metrics.editFailures;
    const occurrences = failures.total;
    return occurrences > 0 ? {
      occurrences,
      breakdown: {
        replace: failures.replace.total,
        patch: failures.patch.total,
        fileOperations: failures.fileOperations.total,
      },
    } : null;
  });
  if (edits.affectedRuns >= MIN_AFFECTED_RUNS) {
    candidates.push(candidate({
      id: "observed-edit-retries",
      area: "tooling",
      problem: `${edits.affectedRuns} of ${rows.length} self-host runs incurred ${edits.occurrences} rejected edit or file-operation attempt(s).`,
      proposal: "Improve edit grounding and recovery by refreshing exact file context after a rejected replace or patch and measuring first-try edit success.",
      targets: ["edit-recovery.js", "edit-actions.js", "edit-context.js", "executor.js"],
      occurrences: edits.occurrences,
      effort: 2,
      impact: 4,
      aggregate: edits,
      totalRuns: rows.length,
    }));
  }

  const protocol = aggregate(rows, (row) => {
    const invalid = row.metrics.invalid;
    const violations = row.metrics.protocolViolations;
    const occurrences = invalid + violations;
    return occurrences > 0 ? {
      occurrences,
      breakdown: { invalid, protocolViolations: violations },
    } : null;
  });
  if (protocol.affectedRuns >= MIN_AFFECTED_RUNS) {
    candidates.push(candidate({
      id: "observed-protocol-invalids",
      area: "reliability",
      problem: `${protocol.affectedRuns} of ${rows.length} self-host runs produced ${protocol.occurrences} invalid output or protocol violation(s).`,
      proposal: "Tighten action-schema steering and focused repair feedback so malformed model output is corrected once instead of consuming repeated attempts.",
      targets: ["protocol-repair.js", "action-protocol.js", "grammar.js", "agent.js"],
      occurrences: protocol.occurrences,
      effort: 2,
      impact: 4,
      aggregate: protocol,
      totalRuns: rows.length,
    }));
  }

  const repetition = aggregate(rows, (row) => {
    const duplicateActions = row.metrics.duplicateActionRejections;
    const duplicateShell = row.metrics.duplicateShellRejections;
    const repeatEscapes = row.metrics.repeatEscapeMasks;
    const noOpEdits = row.metrics.noOpEdits;
    const occurrences = duplicateActions + duplicateShell + repeatEscapes + noOpEdits;
    return occurrences > 0 ? {
      occurrences,
      breakdown: { duplicateActions, duplicateShell, repeatEscapes, noOpEdits },
    } : null;
  });
  if (repetition.affectedRuns >= MIN_AFFECTED_RUNS) {
    candidates.push(candidate({
      id: "observed-repeat-waste",
      area: "performance",
      problem: `${repetition.affectedRuns} of ${rows.length} self-host runs wasted ${repetition.occurrences} action(s) on duplicates, repeat escapes, or no-op edits.`,
      proposal: "Strengthen repeated-action detection and inject a concrete state-changing alternative before another duplicate action is attempted.",
      targets: ["repeat-recovery.js", "action-sequence.js", "agent.js", "turn-mask.js"],
      occurrences: repetition.occurrences,
      effort: 2,
      impact: 3,
      aggregate: repetition,
      totalRuns: rows.length,
    }));
  }

  const turns = aggregate(rows, (row) => {
    const observed = row.metrics.turns;
    return observed > turnThreshold ? {
      occurrences: observed - turnThreshold,
      breakdown: { turns: observed },
    } : null;
  });
  if (turns.affectedRuns >= MIN_AFFECTED_RUNS) {
    candidates.push(candidate({
      id: "observed-excessive-turns",
      area: "performance",
      problem: `${turns.affectedRuns} of ${rows.length} self-host runs exceeded ${turnThreshold} turns.`,
      proposal: "Bound reconnaissance and progressless loops, then trigger a focused implementation or verification step once the turn threshold is reached.",
      targets: ["turn-budget.js", "progress-awareness.js", "agent.js", "turn-mask.js"],
      occurrences: turns.occurrences,
      effort: 2,
      impact: 3,
      aggregate: turns,
      totalRuns: rows.length,
      extraEvidence: { threshold: turnThreshold },
    }));
  }

  return candidates.sort((left, right) => (
    (right.impact / right.effort) - (left.impact / left.effort)
    || right.evidence.affectedRate - left.evidence.affectedRate
    || right.occurrences - left.occurrences
    || left.id.localeCompare(right.id)
  ));
}

function requireSelfHostWorkspace(workspace) {
  if (!isBantamSelfHostWorkspace(workspace)) {
    throw new Error(`self-observation requires a Bantam self-host workspace: ${workspace ?? ""}`);
  }
  const resolved = path.resolve(workspace);
  const rootStat = fs.lstatSync(resolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`self-observation requires a real workspace directory: ${resolved}`);
  }
  const root = fs.realpathSync(resolved);
  const stateRoot = path.join(root, ".bantam");
  try {
    const stateStat = fs.lstatSync(stateRoot);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      throw new Error(`self-observation refuses non-directory or symlinked state root: ${stateRoot}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return root;
}

function acquireObservationLock(root) {
  const stateRoot = path.join(root, ".bantam");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const stateStat = fs.lstatSync(stateRoot);
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new Error(`self-observation refuses non-directory or symlinked state root: ${stateRoot}`);
  }

  try {
    return acquireExclusiveFileLock(path.join(stateRoot, "self-observations.lock"), {
      kind: "bantam-self-observations",
      staleAfterMs: OBSERVATION_LOCK_STALE_MS,
      initializeGraceMs: OBSERVATION_LOCK_STALE_MS,
      waitMs: OBSERVATION_LOCK_WAIT_MS,
      pollMs: OBSERVATION_LOCK_POLL_MS,
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      throw new Error("self-observation store is busy; outcome was not recorded");
    }
    throw error;
  }
}

function normalizeVerification(verification, artifactResult) {
  const rawStatus = verification?.status ?? artifactResult?.status ?? "unverified";
  const status = VERIFICATION_STATUSES.has(rawStatus) ? rawStatus : "unverified";
  const attempted = Boolean(
    verification && typeof verification === "object" && !Array.isArray(verification),
  ) || Boolean(
    artifactResult && (
      typeof artifactResult.pass === "boolean"
      || Number.isInteger(artifactResult.exitCode)
      || artifactResult.verifyDetail !== null && artifactResult.verifyDetail !== undefined
      || status === "pass"
      || status === "fail"
    ),
  );
  return {
    attempted,
    status,
    exitCode: integerOrNull(verification?.exitCode ?? artifactResult?.exitCode),
    timedOut: Boolean(verification?.timedOut),
    bufferExceeded: Boolean(verification?.bufferExceeded),
    aborted: Boolean(verification?.aborted),
    signaled: Boolean(verification?.signal),
    flaky: Boolean(verification?.flaky),
  };
}

function normalizeResultStatus(outcome, verificationStatus) {
  if (outcome.interrupted) return "interrupted";
  if (outcome.blocked) return "blocked";
  const declared = outcome.finalStatus ?? outcome.status;
  if (declared === "pass") return "pass";
  if (declared === "unverified") return "unverified";
  if (typeof declared === "string" && declared.length > 0) return "fail";
  return verificationStatus;
}

function normalizeActions(actions) {
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) return {};
  return Object.fromEntries(
    Object.entries(actions)
      .filter(([name, value]) => ACTION_NAMES.has(name) && finiteNonNegative(value))
      .map(([name, value]) => [name, count(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeEditFailures(metrics) {
  const normalized = {};
  for (const [group, fields] of Object.entries(EDIT_FAILURE_FIELDS)) {
    const sourceName = group === "fileOperations" ? "fileOperationFailures" : `${group}Failures`;
    const source = metrics[sourceName];
    normalized[group] = Object.fromEntries(fields.map((field) => [field, count(source?.[field])]));
    if (source?.total === undefined || source?.total === null) {
      normalized[group].total = fields
        .filter((field) => field !== "total")
        .reduce((total, field) => total + normalized[group][field], 0);
    }
  }
  normalized.total = normalized.replace.total
    + normalized.patch.total
    + normalized.fileOperations.total;
  return normalized;
}

function validateObservation(value, index) {
  const label = `self-observation entry ${index}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is corrupt: expected an object`);
  }
  assertExactKeys(
    value,
    ["schema", "kind", "recordedAt", "taskSha256", "result", "metrics"],
    label,
  );
  if (![1, 2].includes(value.schema) || value.kind !== OBSERVATION_KIND) {
    throw new Error(`${label} is corrupt: unsupported schema or kind`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.taskSha256 ?? "")) {
    throw new Error(`${label} is corrupt: invalid task digest`);
  }
  if (normalizeTimestamp(value.recordedAt) !== value.recordedAt) {
    throw new Error(`${label} is corrupt: recordedAt is not canonical`);
  }
  if (!value.result || !value.metrics) {
    throw new Error(`${label} is corrupt: missing result or metrics`);
  }
  assertExactKeys(
    value.result,
    ["status", "verification", "interrupted", "blocked"],
    `${label}.result`,
  );
  if (!RESULT_STATUSES.has(value.result.status)) {
    throw new Error(`${label} is corrupt: invalid result status`);
  }
  const verificationKeys = [
    ...(value.schema === 2 ? ["attempted"] : []),
    "status",
    "exitCode",
    "timedOut",
    "bufferExceeded",
    "aborted",
    "signaled",
    "flaky",
  ];
  assertExactKeys(value.result.verification, verificationKeys, `${label}.result.verification`);
  if (!VERIFICATION_STATUSES.has(value.result?.verification?.status)) {
    throw new Error(`${label} is corrupt: invalid verification status`);
  }
  if (value.result.verification.exitCode !== null
      && !Number.isInteger(value.result.verification.exitCode)) {
    throw new Error(`${label} is corrupt: invalid verification exit code`);
  }
  for (const field of ["timedOut", "bufferExceeded", "aborted", "signaled", "flaky"]) {
    if (typeof value.result.verification[field] !== "boolean") {
      throw new Error(`${label} is corrupt: verification ${field} must be boolean`);
    }
  }
  if (value.schema === 2 && typeof value.result.verification.attempted !== "boolean") {
    throw new Error(`${label} is corrupt: verification attempted must be boolean`);
  }
  for (const field of ["interrupted", "blocked"]) {
    if (typeof value.result[field] !== "boolean") {
      throw new Error(`${label} is corrupt: ${field} must be boolean`);
    }
  }
  assertExactKeys(
    value.metrics,
    [
      "turns",
      ...COUNT_FIELDS,
      "durationMs",
      "actions",
      "editFailures",
    ],
    `${label}.metrics`,
  );
  for (const field of ["turns", ...COUNT_FIELDS]) {
    if (!nonNegativeInteger(value.metrics[field])) {
      throw new Error(`${label} is corrupt: ${field} must be a non-negative integer`);
    }
  }
  if (value.metrics.durationMs !== null && !nonNegativeInteger(value.metrics.durationMs)) {
    throw new Error(`${label} is corrupt: durationMs must be null or a non-negative integer`);
  }
  if (!value.metrics.actions || typeof value.metrics.actions !== "object"
      || Array.isArray(value.metrics.actions)) {
    throw new Error(`${label} is corrupt: actions must be an object`);
  }
  for (const [name, actionCount] of Object.entries(value.metrics.actions)) {
    if (!ACTION_NAMES.has(name) || !nonNegativeInteger(actionCount)) {
      throw new Error(`${label} is corrupt: invalid action count`);
    }
  }
  validateEditFailures(value.metrics.editFailures, label);
  const normalized = JSON.parse(JSON.stringify(value));
  if (normalized.schema === 1) {
    normalized.schema = 2;
    normalized.result.verification.attempted = legacyVerificationWasAttempted(
      normalized.result.verification,
    );
  }
  return normalized;
}

function legacyVerificationWasAttempted(verification) {
  return verification.status === "pass"
    || verification.status === "fail"
    || verification.exitCode !== null
    || verification.timedOut
    || verification.bufferExceeded
    || verification.aborted
    || verification.signaled
    || verification.flaky;
}

function validateEditFailures(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is corrupt: editFailures must be an object`);
  }
  assertExactKeys(value, ["replace", "patch", "fileOperations", "total"], `${label}.editFailures`);
  let total = 0;
  for (const [group, fields] of Object.entries(EDIT_FAILURE_FIELDS)) {
    const observed = value[group];
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
      throw new Error(`${label} is corrupt: missing ${group} failure counts`);
    }
    assertExactKeys(observed, fields, `${label}.editFailures.${group}`);
    for (const field of fields) {
      if (!nonNegativeInteger(observed[field])) {
        throw new Error(`${label} is corrupt: invalid ${group}.${field} count`);
      }
    }
    total += observed.total;
  }
  if (!nonNegativeInteger(value.total) || value.total !== total) {
    throw new Error(`${label} is corrupt: invalid edit failure total`);
  }
}

function aggregate(rows, measure) {
  let affectedRuns = 0;
  let occurrences = 0;
  const breakdown = {};
  const taskSha256 = [];
  for (const row of rows) {
    const measured = measure(row);
    if (!measured) continue;
    affectedRuns++;
    occurrences += measured.occurrences;
    taskSha256.push(row.taskSha256);
    for (const [name, value] of Object.entries(measured.breakdown ?? {})) {
      breakdown[name] = (breakdown[name] ?? 0) + count(value);
    }
  }
  return { affectedRuns, occurrences, breakdown, taskSha256 };
}

function candidate({
  id,
  area,
  problem,
  proposal,
  targets,
  occurrences,
  effort,
  impact,
  aggregate: measured,
  totalRuns,
  extraEvidence = {},
}) {
  return {
    id,
    area,
    problem,
    proposal,
    targets: [...targets],
    occurrences,
    effort,
    impact,
    evidence: {
      affectedRuns: measured.affectedRuns,
      totalRuns,
      affectedRate: measured.affectedRuns / totalRuns,
      counts: { ...measured.breakdown },
      taskSha256: [...measured.taskSha256],
      ...extraEvidence,
    },
  };
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("self-observation recordedAt must be an ISO timestamp");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError("self-observation recordedAt must be an ISO timestamp");
  }
  return new Date(time).toISOString();
}

function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return numeric;
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function nullableCount(value) {
  return value === null || value === undefined ? null : count(value);
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function finiteNonNegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is corrupt: expected an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} is corrupt: fields do not match schema`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
