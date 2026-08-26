// Governed, end-to-end self-improvement.
//
// This is intentionally separate from self-improve-runner.js's legacy template
// writers.  One cycle freezes one observed weakness, builds it in an immutable
// channel-derived lane, requires baseline/candidate/protected/deployed evidence,
// and only then moves the dev + regular channel refs and the live checkout.

import crypto from "node:crypto";
import { auditIntegration } from "./logic/integration-audit.js";
import fs from "node:fs";
import path from "node:path";

import { runAgent } from "./agent.js";
import { makeRunId, makeStamp } from "./artifact.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { runShellProcess } from "./executor.js";
import { acquireExclusiveFileLock } from "./exclusive-file-lock.js";
import { LaneRunBridge } from "./lane-run.js";
import { LaneStore } from "./lane-store.js";
import { ObservationParser } from "./observation-parser.js";
import { RunCheckpoint, attachModelRequestCheckpoint } from "./run-checkpoint.js";
import {
  deriveSelfImprovementCandidates,
  isBantamSelfHostWorkspace,
  loadSelfObservations,
} from "./self-observation.js";
import {
  ImprovementScheduler,
  scanWeaknesses,
} from "./self-improve.js";
import { requireFrozenCandidateChanges } from "./self-improve-change-policy.js";
import {
  isPackageManagerConfigPath,
  isRunnerConfigPath,
  isTestPath,
} from "./scope-guard.js";
import { detectVerifier } from "./verifier-detect.js";
import {
  recoverWorkspaceTransactions,
  WorkspaceTransaction,
} from "./workspace-transaction.js";
import { loadTeacherCandidates } from "./teacher-collaboration.js";

const ATTEMPT_KIND = "bantam.self-improvement-attempt";
const EVIDENCE_KIND = "bantam.self-improvement-evidence";
const LEDGER_FILE = "self-improve-attempts.json";
const LOCK_INITIALIZE_GRACE_MS = 30_000;
const RUNTIME_PROMOTION_BLOCKER = (
  "runtime telemetry has no replayable task inputs; a preregistered paired "
  + "behavioral benchmark is required to measure lift"
);
const TEACHER_PROMOTION_BLOCKER = (
  "teacher consensus is a hypothesis, not behavioral lift; replay and a "
  + "preregistered paired experiment are required"
);
const DEFAULT_MAX_TURNS = 120;
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MANAGED_READ_ONLY_PATHS = Object.freeze([".git", ".bantam", "node_modules"]);
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const PROTECTED_ROOT_FILES = new Set([
  ...DEPENDENCY_FILES,
  "pytest.ini",
  "tox.ini",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "vitest.config.js",
  "vitest.config.ts",
]);

export function parseSelfImproveRequest(value) {
  const request = String(value ?? "").trim();
  if (!request) return null;

  const explicit = /^:self-improve\b(.*)$/i.exec(request);
  if (explicit) {
    const tail = explicit[1].trim();
    const parsed = parseExplicitSelfImproveTail(tail);
    return {
      explicit: true,
      planOnly: parsed.planOnly,
      apply: parsed.apply,
      candidateId: parsed.candidateId,
      help: parsed.help,
      error: parsed.error,
      operatorRequest: request,
    };
  }

  const lower = request.toLowerCase();
  const selfImprovement = /\bself[- ]improv(?:e|ement)\b/.exec(lower);
  if (!selfImprovement) return null;
  if (/\?\s*$/.test(request)) return null;
  if (/^\s*(?:what|why|how|when|where|who|is|are|does|should|can|could|would|do you think|tell me|explain)\b/.test(lower)) {
    return null;
  }
  const clauseStart = Math.max(
    lower.lastIndexOf(".", selfImprovement.index),
    lower.lastIndexOf("!", selfImprovement.index),
    lower.lastIndexOf("?", selfImprovement.index),
    lower.lastIndexOf("\n", selfImprovement.index),
  ) + 1;
  const lead = lower.slice(clauseStart, selfImprovement.index);
  if (/\b(?:not|never|don'?t|do\s+not|avoid|without|stop)\b/.test(lead)) {
    return null;
  }
  if (
    /\b(?:tell|explain|describe|discuss|summarize|understand|teach|learn|about|through\s+how)\b/
      .test(lead)
  ) return null;

  // Natural-language execution is deliberately narrow. Generic words such as
  // "please" or "do" do not authorize mutation unless their direct object is
  // the self-improvement action/cycle.
  const imperative = [
    /^\s*(?:please\s+)?(?:go(?:\s+ahead(?:\s+and)?)?\s+)?self[- ]improve\b/,
    /\b(?:i\s+(?:want|need)\s+you\s+to|let'?s)\s+(?:please\s+)?self[- ]improve\b/,
    /\b(?:start|begin|run|perform|do|try)\s+(?:(?:a|an|the|some|another|little|full|governed|new)\s+)*self[- ]improvement(?:\s+(?:run|cycle|effort))?(?=\s*(?:[.!]|$)|\s+(?:now|please)\b)/,
    /\blet'?s\s+(?:go\s+ahead\s+and\s+)?(?:start|begin|run|perform|do|try)\s+(?:(?:a|an|the|some|another|little|full|governed|new)\s+)*self[- ]improvement(?:\s+(?:run|cycle|effort))?(?=\s*(?:[.!]|$)|\s+(?:now|please)\b)/,
  ].some((pattern) => pattern.test(lower));
  if (!imperative) return null;
  return {
    explicit: false,
    planOnly: false,
    apply: true,
    candidateId: null,
    help: false,
    error: null,
    operatorRequest: request,
  };
}

function parseExplicitSelfImproveTail(tail) {
  const result = {
    planOnly: false,
    apply: true,
    candidateId: null,
    help: false,
    error: null,
  };
  if (!tail) return result;

  const tokens = tail.split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (["plan", "--plan", "dry-run", "--dry-run"].includes(lower)) {
      result.planOnly = true;
      continue;
    }
    if (["no-apply", "--no-apply"].includes(lower)) {
      result.apply = false;
      continue;
    }
    if (["help", "--help"].includes(lower)) {
      result.help = true;
      continue;
    }
    if (lower === "--candidate") {
      const candidate = tokens[index + 1];
      if (!candidate || !/^[A-Za-z0-9._-]+$/.test(candidate)) {
        result.error = ":self-improve --candidate requires an id";
        return result;
      }
      result.candidateId = candidate;
      index++;
      continue;
    }
    const candidateAssignment = /^candidate=([A-Za-z0-9._-]+)$/i.exec(token);
    if (candidateAssignment) {
      result.candidateId = candidateAssignment[1];
      continue;
    }
    result.error = `unknown :self-improve option: ${token}`;
    return result;
  }
  if (result.help && tokens.length > 1) {
    result.error = ":self-improve help does not accept other options";
  }
  return result;
}

export function isSelfImproveRequest(value) {
  return parseSelfImproveRequest(value) !== null;
}

export async function runGovernedSelfImprove({
  workspace = process.cwd(),
  model = null,
  verificationScript = null,
  candidateId = null,
  operatorRequest = "",
  planOnly = false,
  apply = true,
  maxTurns = DEFAULT_MAX_TURNS,
  verificationTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  stateHome = null,
  signal = null,
  onEvent = () => {},
  implement = null,
  verify = runManagedVerifier,
  afterDeploy = null,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const root = requireDirectory(workspace, "self-improvement workspace");
  if (!isBantamSelfHostWorkspace(root)) {
    throw new Error(
      "governed self-improvement requires the exact Bantam development checkout "
      + "(package identity and local launcher markers did not match)",
    );
  }
  assertPrivatePathComponents(root, path.join(root, ".bantam"), "self-improvement state root");
  // Nested implementation/verifier processes may inspect a plan (it is
  // model-free and state-free), but they can never start another managed loop.
  if (planOnly) {
    const verifier = verificationScript || detectVerifier(root)?.command || null;
    const candidates = observedCandidates(root);
    const selected = selectCandidate(candidates, candidateId);
    return {
      mode: "plan",
      status: selected ? "planned" : "no-candidates",
      workspace: root,
      verifier,
      selected,
      candidates,
      // Read-only: counts import edges, writes nothing. Plan mode promises no
      // source or state writes and this keeps that promise.
      integrationAudit: safeIntegrationAudit(root),
      applied: false,
    };
  }
  assertNotNested(env);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new TypeError("managed self-improvement maxTurns must be a positive integer");
  }
  if (typeof verify !== "function") throw new TypeError("managed verifier must be a function");
  if (afterDeploy !== null && typeof afterDeploy !== "function") {
    throw new TypeError("managed post-deploy check port must be a function");
  }
  if (implement !== null && typeof implement !== "function") {
    throw new TypeError("managed implementation port must be a function");
  }
  const resolvedStateHome = path.resolve(stateHome ?? path.join(root, ".bantam", "state"));
  assertStateInsideWorkspace(root, resolvedStateHome);
  const controllerRoot = path.join(root, ".bantam", "self-improve");
  assertPrivatePathComponents(root, resolvedStateHome, "self-improvement state home");
  assertPrivatePathComponents(root, controllerRoot, "self-improvement controller state");
  const transactionRoot = path.join(controllerRoot, "transactions");
  const lock = acquireControllerLock(path.join(controllerRoot, "controller.lock"));
  let attempt = null;
  let store = null;
  let ledger = null;

  try {
    store = new LaneStore(resolvedStateHome);
    recoverWorkspaceTransactions({
      workspace: root,
      transactionRoot,
      wasPromoted: (manifest) => {
        const candidateRef = manifest?.metadata?.candidateVersionRef;
        return typeof candidateRef === "string"
          && store.readChannel("regular")?.versionRef === candidateRef;
      },
    });

    // Recovery, scan, selection, and ledger loading all happen under the same
    // controller lock. A second process cannot act on a pre-promotion scan or
    // later persist a stale in-memory ledger over the first process's result.
    ledger = new AttemptLedger(path.join(controllerRoot, LEDGER_FILE));
    let baseline = observeBaseline(store, root);
    const verifier = verificationScript || detectVerifier(root)?.command || null;
    const candidates = observedCandidates(root);
    assertWorkspaceTree(
      store,
      root,
      baseline.checkpoint,
      "live workspace moved while selecting the self-improvement candidate",
    );
    let selected = selectCandidate(candidates, candidateId);
    if (!selected) {
      return {
        mode: "managed",
        status: "no-candidates",
        workspace: root,
        verifier,
        selected: null,
        candidates: [],
        applied: false,
      };
    }
    if (!candidateId && selected.promotionEligible === false && verifier) {
      selected = candidates.find((candidate) => {
        if (candidate.promotionEligible !== false) return false;
        const frozenCandidate = freezeCandidate(candidate);
        const candidateFingerprint = selfImproveFingerprint({
          baseline,
          candidate: frozenCandidate,
          verifier,
        });
        return !validStagedAttempt(
          ledger.entries,
          candidateFingerprint,
          store,
          { requireCurrentDev: false },
        );
      }) ?? null;
      if (!selected) {
        return {
          mode: "managed",
          status: "all-staged",
          workspace: root,
          verifier,
          selected: null,
          candidates,
          applied: false,
          restartRequired: false,
        };
      }
    }
    if (!verifier) {
      throw new Error("managed self-improvement requires a configured or auto-detected verifier");
    }
    if (!model && !implement) {
      throw new Error("managed self-improvement requires a model or injected implementation port");
    }
    const frozen = freezeCandidate(selected);
    const requestedApply = Boolean(apply);
    const effectiveApply = requestedApply && frozen.promotionEligible;
    const fingerprint = selfImproveFingerprint({
      baseline,
      candidate: frozen,
      verifier,
    });
    const attemptId = uniqueAttemptId(ledger.entries, fingerprint, now());
    const laneId = `self-improve-${attemptId}`;
    const staged = reusableStagedAttempt(ledger.entries, fingerprint, store);
    if (staged) {
      return {
        mode: "managed",
        status: "staged",
        workspace: root,
        selected: frozen,
        attempt: publicAttempt(staged),
        candidateVersionRef: staged.candidateVersionRef,
        evidenceRef: staged.evidenceRef,
        applied: false,
        requestedApply,
        promotionEligible: false,
        promotionBlocker: frozen.promotionBlocker,
        restartRequired: false,
        reused: true,
      };
    }
    attempt = ledger.begin({
      schema: 1,
      kind: ATTEMPT_KIND,
      id: attemptId,
      fingerprint,
      phase: "selected",
      workspace: root,
      candidate: frozen,
      verifier,
      requestedApply,
      apply: effectiveApply,
      baseline: {
        versionRef: baseline.versionRef,
        workspaceCommit: baseline.checkpoint.commit,
        workspaceTree: baseline.checkpoint.tree,
      },
      laneId,
    });
    emit(onEvent, "self_improve_phase", { phase: "selected", attempt: publicAttempt(attempt) });

    abortIfRequested(signal, "before baseline verification");
    ledger.phase(attemptId, "baseline-testing");
    const baselineEvaluation = materializeCandidateEvaluation({
      store,
      stateHome: resolvedStateHome,
      attemptId: `${attemptId}-baseline`,
      candidateCommit: baseline.checkpoint.commit,
      dependencyRoot: root,
    });
    let baselineVerification;
    try {
      baselineVerification = await verify(baselineEvaluation.workspace, verifier, {
        signal,
        timeoutMs: verificationTimeoutMs,
        phase: "baseline",
        onEvent,
        shellSandbox: "docker",
        envOverrides: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      });
      requireGreenVerification(baselineVerification, "baseline");
      assertWorkspaceTree(
        store,
        baselineEvaluation.workspace,
        baseline.checkpoint,
        "baseline verifier changed its immutable evaluation tree",
      );
    } finally {
      baselineEvaluation.cleanup();
    }
    assertWorkspaceTree(
      store,
      root,
      baseline.checkpoint,
      "live workspace moved during baseline verification",
    );
    baseline = activateVerifiedBaseline(store, baseline, root);
    ledger.phase(attemptId, "baseline-verified", {
      baselineVerification: summarizeVerification(baselineVerification),
      regularEventRef: baseline.regular?.eventRef ?? null,
      devEventRef: baseline.dev?.eventRef ?? null,
    });

    abortIfRequested(signal, "before lane creation");
    const lane = store.createLaneFromChannel({
      laneId,
      channel: "dev",
      controllerState: {
        schema: 1,
        kind: ATTEMPT_KIND,
        attemptId,
        phase: "selected",
        fingerprint,
      },
      metadata: {
        source: "self-improve-controller",
        attemptId,
        fingerprint,
        candidateId: frozen.id,
      },
    });
    if (
      lane.workspaceTree !== baseline.checkpoint.tree
      || lane.channelVersionRef !== baseline.versionRef
    ) {
      throw new Error("implementation lane is not pinned to the exact observed baseline");
    }
    prepareRuntimeDependencies(root, lane.workspacePath);

    const implementationTask = buildImplementationTask({
      candidate: frozen,
      verifier,
      operatorRequest,
    });
    ledger.phase(attemptId, "implementing", {
      laneEventId: lane.eventId,
      laneWorkspace: lane.workspacePath,
    });
    emit(onEvent, "self_improve_phase", {
      phase: "implementing",
      attempt: publicAttempt(ledger.get(attemptId)),
    });

    let implementationResult;
    try {
      implementationResult = implement
        ? await implement({
            attemptId,
            candidate: frozen,
            task: implementationTask,
            workspace: lane.workspacePath,
            verifier,
            maxTurns,
            signal,
            onEvent,
            store,
            lane,
          })
        : await runImplementationAgent({
            stateHome: resolvedStateHome,
            laneId,
            task: implementationTask,
            model,
            verifier,
            maxTurns,
            verificationTimeoutMs,
            stateAudit: frozen.source === "teacher-collaboration" ? "off" : "auto",
            signal,
            onEvent,
          });
    } finally {
      removeRuntimeDependencies(lane.workspacePath);
    }

    requireSuccessfulImplementation(implementationResult, verifier);
    // The lane is materialized from the captured Git-style tree, which
    // intentionally omits ignored ambient files (local reports, secrets,
    // caches). Compare it with the same immutable baseline representation,
    // not the live checkout, or every ignored live file looks spuriously
    // deleted even though deployment will never touch it.
    const scopeBaseline = materializeCandidateEvaluation({
      store,
      stateHome: resolvedStateHome,
      attemptId: `${attemptId}-pre-scope`,
      candidateCommit: baseline.checkpoint.commit,
      dependencyRoot: root,
    });
    let changeScope;
    try {
      requireDependencyManifestsUnchanged(scopeBaseline.workspace, lane.workspacePath);
      requireIgnoreRulesUnchanged(scopeBaseline.workspace, lane.workspacePath);
      requirePackageManagerConfigUnchanged(scopeBaseline.workspace, lane.workspacePath);
      changeScope = requireFrozenCandidateChanges({
        baselineWorkspace: scopeBaseline.workspace,
        candidateWorkspace: lane.workspacePath,
        candidate: frozen,
        verifier,
      });
    } finally {
      scopeBaseline.cleanup();
    }

    const candidateSnapshot = checkpointImplementedLane(store, laneId, attemptId, {
      implementation: summarizeImplementation(implementationResult, verifier),
      fingerprint,
      changeScope,
    });
    if (candidateSnapshot.workspaceTree === baseline.checkpoint.tree) {
      throw new Error("implementation produced no captured workspace change");
    }

    // The lane remains a mutable working directory. Re-run the complete scope
    // policy over materializations of the exact captured baseline/candidate
    // commits and require it to match the pre-capture verdict. Nothing promoted
    // later can therefore have entered between policy scan and checkpoint.
    const scopeEvaluation = materializeVersionsForDeployment({
      store,
      stateHome: resolvedStateHome,
      attemptId: `${attemptId}-scope`,
      baselineCommit: baseline.checkpoint.commit,
      candidateCommit: candidateSnapshot.workspaceCommit,
    });
    let capturedChangeScope;
    try {
      capturedChangeScope = requireFrozenCandidateChanges({
        baselineWorkspace: scopeEvaluation.baseline,
        candidateWorkspace: scopeEvaluation.candidate,
        candidate: frozen,
        verifier,
      });
    } finally {
      scopeEvaluation.cleanup();
    }
    if (hashJson(capturedChangeScope) !== hashJson(changeScope)) {
      throw new Error(
        "captured candidate tree does not match the pre-checkpoint scope attestation",
      );
    }
    ledger.phase(attemptId, "implemented", {
      laneEventId: candidateSnapshot.eventId,
      candidateCommit: candidateSnapshot.workspaceCommit,
      candidateTree: candidateSnapshot.workspaceTree,
      changeScope: capturedChangeScope,
      implementation: summarizeImplementation(implementationResult, verifier),
    });

    abortIfRequested(signal, "before immutable candidate verification");
    const candidateEvaluation = materializeCandidateEvaluation({
      store,
      stateHome: resolvedStateHome,
      attemptId,
      candidateCommit: candidateSnapshot.workspaceCommit,
      dependencyRoot: root,
    });
    let metric;
    let candidateVerification;
    try {
      metric = evaluateSelectedWeakness(frozen, candidateEvaluation.workspace);
      if (frozen.promotionEligible && !metric.improved) {
        throw new Error(`candidate did not measurably improve ${frozen.id}: ${metric.reason}`);
      }
      candidateVerification = await verify(candidateEvaluation.workspace, verifier, {
        signal,
        timeoutMs: verificationTimeoutMs,
        phase: "candidate-snapshot",
        onEvent,
        shellSandbox: "docker",
        envOverrides: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      });
      requireGreenVerification(candidateVerification, "immutable candidate");
      assertWorkspaceTree(
        store,
        candidateEvaluation.workspace,
        candidateSnapshot,
        "candidate verifier changed the immutable evaluation tree",
      );
      const verifiedMetric = evaluateSelectedWeakness(frozen, candidateEvaluation.workspace);
      if (frozen.promotionEligible && !verifiedMetric.improved) {
        throw new Error(`candidate verification invalidated its measured improvement: ${verifiedMetric.reason}`);
      }
      metric = verifiedMetric;
    } finally {
      candidateEvaluation.cleanup();
    }
    ledger.phase(attemptId, "metric-verified", {
      metric,
      candidateVerification: summarizeVerification(candidateVerification),
    });

    abortIfRequested(signal, "before protected verification");
    const evaluation = materializeProtectedEvaluation({
      store,
      stateHome: resolvedStateHome,
      attemptId,
      baselineCommit: baseline.checkpoint.commit,
      candidateCommit: candidateSnapshot.workspaceCommit,
      dependencyRoot: root,
    });
    let protectedVerification;
    const protectedTree = {
      workspaceCommit: candidateSnapshot.workspaceCommit,
      ...store.workspaces.treeForWorkspace(evaluation.workspace, {
        baselineCommit: candidateSnapshot.workspaceCommit,
      }),
    };
    try {
      protectedVerification = await verify(evaluation.workspace, verifier, {
        signal,
        timeoutMs: verificationTimeoutMs,
        phase: "protected-baseline-suite",
        onEvent,
        shellSandbox: "docker",
        envOverrides: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      });
      requireGreenVerification(protectedVerification, "protected baseline suite");
      assertWorkspaceTree(
        store,
        evaluation.workspace,
        protectedTree,
        "protected verifier changed its evaluation tree",
      );
    } finally {
      evaluation.cleanup();
    }
    requireTestCountAtLeast(
      protectedVerification,
      baselineVerification,
      "protected baseline suite",
      "baseline",
    );
    requireTestCountAtLeast(
      candidateVerification,
      protectedVerification,
      "immutable candidate",
      "protected baseline suite",
    );
    if (capturedChangeScope.testPaths.length > 0) {
      requireTestCountGreaterThan(
        candidateVerification,
        protectedVerification,
        "immutable candidate",
        "protected baseline suite",
      );
    }
    ledger.phase(attemptId, "evaluated", {
      protectedVerification: summarizeVerification(protectedVerification),
      candidateVerification: summarizeVerification(candidateVerification),
      metric,
    });

    const candidateVersion = {
      kind: "bantam.harness-workspace",
      workspaceCommit: candidateSnapshot.workspaceCommit,
      workspaceTree: candidateSnapshot.workspaceTree,
      files: null,
    };
    const candidateVersionRef = store.putVersion(candidateVersion, {
      parentVersionRef: baseline.versionRef,
    });
    const preliminaryEvidence = improvementEvidence({
      attemptId,
      fingerprint,
      candidate: frozen,
      verifier,
      baseline,
      candidateSnapshot,
      candidateVersionRef,
      baselineVerification,
      implementationResult,
      candidateVerification,
      protectedVerification,
      metric,
      changeScope: capturedChangeScope,
    });
    const preliminaryEvidenceRef = store.blobs.putJson(preliminaryEvidence);
    let dev;
    try {
      dev = store.advanceChannel("dev", baseline.versionRef, candidateVersionRef, {
        operation: "channel.self_improvement_candidate",
        metadata: {
          source: "self-improve-controller",
          attemptId,
          fingerprint,
          candidateId: frozen.id,
          lanePolicy: frozen.lanePolicy,
          promotionEligible: frozen.promotionEligible,
          baselineVersionRef: baseline.versionRef,
          evidenceRef: preliminaryEvidenceRef,
        },
      });
    } catch (error) {
      try {
        rollbackOwnedDev(store, candidateVersionRef, baseline.versionRef, attemptId, error.message);
      } catch (rollbackError) {
        error.message += `; dev-channel rollback failed: ${rollbackError.message}`;
      }
      throw error;
    }
    let materialized = null;
    let transaction = null;
    let evidenceRef = null;
    let regular = null;
    let deployedVerification;
    try {
      ledger.phase(attemptId, "dev-checkpointed", {
        candidateVersionRef,
        preliminaryEvidenceRef,
        devEventRef: dev.eventRef,
      });

      if (!effectiveApply) {
        const status = frozen.promotionEligible ? "accepted" : "staged";
        ledger.phase(attemptId, status, {
          applied: false,
          requestedApply,
          promotionEligible: frozen.promotionEligible,
          promotionBlocker: frozen.promotionBlocker,
          candidateVersionRef,
          evidenceRef: preliminaryEvidenceRef,
        });
        emit(onEvent, "self_improve_phase", {
          phase: status,
          attempt: publicAttempt(ledger.get(attemptId)),
        });
        return {
          mode: "managed",
          status,
          workspace: root,
          selected: frozen,
          attempt: publicAttempt(ledger.get(attemptId)),
          candidateVersionRef,
          evidenceRef: preliminaryEvidenceRef,
          applied: false,
          requestedApply,
          promotionEligible: frozen.promotionEligible,
          promotionBlocker: frozen.promotionBlocker,
          restartRequired: false,
        };
      }

      abortIfRequested(signal, "before deployment");
      assertWorkspaceTree(store, root, baseline.checkpoint, "live workspace moved before deployment");
      materialized = materializeVersionsForDeployment({
        store,
        stateHome: resolvedStateHome,
        attemptId,
        baselineCommit: baseline.checkpoint.commit,
        candidateCommit: candidateSnapshot.workspaceCommit,
      });
      transaction = new WorkspaceTransaction({
        workspace: root,
        baselineRoot: materialized.baseline,
        candidateRoot: materialized.candidate,
        transactionRoot,
        id: attemptId,
        metadata: {
          attemptId,
          baselineVersionRef: baseline.versionRef,
          candidateVersionRef,
          baselineTree: baseline.checkpoint.tree,
          candidateTree: candidateSnapshot.workspaceTree,
        },
      });
      transaction.prepare();
      ledger.phase(attemptId, "applying", { transaction: transaction.directory });
      transaction.apply();
      emit(onEvent, "self_improve_phase", {
        phase: "deployed",
        attempt: publicAttempt(ledger.get(attemptId)),
      });
      if (afterDeploy) {
        await afterDeploy({
          workspace: root,
          attemptId,
          candidateVersionRef,
          candidateSnapshot,
          transaction,
        });
      }
      assertWorkspaceTree(store, root, candidateSnapshot, "deployed bytes do not match candidate");
      const protectedRuntimeState = snapshotManagedRuntimeState(root);
      deployedVerification = await verify(root, verifier, {
        signal,
        timeoutMs: verificationTimeoutMs,
        phase: "deployed-live",
        onEvent,
        shellSandbox: "docker",
        envOverrides: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      });
      requireGreenVerification(deployedVerification, "deployed live");
      assertManagedRuntimeStateUnchanged(root, protectedRuntimeState);
      requireTestCountAtLeast(
        deployedVerification,
        candidateVerification,
        "deployed live",
        "immutable candidate",
      );
      assertWorkspaceTree(
        store,
        root,
        candidateSnapshot,
        "deployed live verifier changed the promoted workspace",
      );
      const deployedMetric = evaluateSelectedWeakness(frozen, root);
      if (!deployedMetric.improved) {
        throw new Error(`deployed candidate lost its measured improvement: ${deployedMetric.reason}`);
      }
      deployedVerification = {
        ...deployedVerification,
        attestation: "content-addressed-live-verification",
      };
      transaction.markVerified({
        ...summarizeVerification(deployedVerification),
        attestation: deployedVerification.attestation,
        workspaceTree: candidateSnapshot.workspaceTree,
      });

      const finalEvidence = {
        ...preliminaryEvidence,
        deployment: {
          ...summarizeVerification(deployedVerification),
          attestation: deployedVerification.attestation,
          workspaceTree: candidateSnapshot.workspaceTree,
          metric: deployedMetric,
        },
      };
      evidenceRef = store.blobs.putJson(finalEvidence);
      // Evidence serialization and blob persistence are intentionally outside
      // the live transaction. Re-attest after them so regular's CAS never
      // promotes a candidate over a concurrent live-tree edit in that window.
      assertWorkspaceTree(
        store,
        root,
        candidateSnapshot,
        "live workspace moved immediately before regular promotion",
      );
      regular = store.advanceChannel("regular", baseline.versionRef, candidateVersionRef, {
        operation: "channel.self_improvement_promoted",
        metadata: {
          source: "self-improve-controller",
          attemptId,
          fingerprint,
          candidateId: frozen.id,
          baselineVersionRef: baseline.versionRef,
          candidateVersionRef,
          evidenceRef,
          evidenceSha256: hashJson(finalEvidence),
        },
      });
      transaction.markPromoted({
        regularEventRef: regular.eventRef,
        candidateVersionRef,
        evidenceRef,
      });
      transaction.commit();
      ledger.phase(attemptId, "promoted", {
        applied: true,
        candidateVersionRef,
        evidenceRef,
        regularEventRef: regular.eventRef,
        deploymentVerification: summarizeVerification(deployedVerification),
      });
      emit(onEvent, "self_improve_phase", {
        phase: "promoted",
        attempt: publicAttempt(ledger.get(attemptId)),
      });
      return {
        mode: "managed",
        status: "promoted",
        workspace: root,
        selected: frozen,
        attempt: publicAttempt(ledger.get(attemptId)),
        candidateVersionRef,
        evidenceRef,
        applied: true,
        restartRequired: true,
      };
    } catch (error) {
      // The regular-channel CAS is the durable point of no return. Once it
      // owns this candidate, rolling live bytes or dev backward would create
      // split-brain state. Finish/recover bookkeeping and report promotion.
      if (store.readChannel("regular")?.versionRef === candidateVersionRef) {
        let recoveryWarning = error.message;
        try {
          if (transaction?.manifest?.state === "verified") {
            transaction.markPromoted({
              regularEventRef: regular?.eventRef ?? null,
              candidateVersionRef,
              evidenceRef,
              recovered: true,
            });
          }
          if (transaction?.manifest?.state === "promoted") transaction.commit();
        } catch (recoveryError) {
          recoveryWarning += `; promotion bookkeeping recovery failed: ${recoveryError.message}`;
        }
        try {
          ledger.phase(attemptId, "promoted", {
            applied: true,
            candidateVersionRef,
            evidenceRef,
            regularEventRef: regular?.eventRef ?? null,
            deploymentVerification: summarizeVerification(deployedVerification),
            recoveryWarning,
          });
        } catch {
          // The regular ref and verified transaction remain sufficient for
          // deterministic recovery on the next controller invocation.
        }
        return {
          mode: "managed",
          status: "promoted",
          workspace: root,
          selected: frozen,
          attempt: publicAttempt(ledger.get(attemptId)),
          candidateVersionRef,
          evidenceRef,
          applied: true,
          restartRequired: true,
          warning: recoveryWarning,
        };
      }
      try {
        const state = transaction?.manifest?.state;
        if (state && !["rolled_back", "committed", "promoted"].includes(state)) {
          transaction.rollback({ reason: error.message });
        }
      } catch (rollbackError) {
        error.message += `; workspace rollback failed: ${rollbackError.message}`;
      }
      try {
        rollbackOwnedDev(store, candidateVersionRef, baseline.versionRef, attemptId, error.message);
      } catch (rollbackError) {
        error.message += `; dev-channel rollback failed: ${rollbackError.message}`;
      }
      throw error;
    } finally {
      materialized?.cleanup();
    }
  } catch (error) {
    if (attempt) {
      ledger.fail(attempt.id, error, signal?.aborted ? "interrupted" : "failed");
    }
    throw error;
  } finally {
    lock.release();
  }
}

export async function runManagedVerifier(workspace, script, {
  signal = null,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  phase = "verification",
  onEvent = () => {},
  shellSandbox = undefined,
  envOverrides = null,
  workspaceReadOnly = true,
  readOnlyWorkspacePaths = MANAGED_READ_ONLY_PATHS,
} = {}) {
  const startedAt = Date.now();
  emit(onEvent, "self_improve_verification", { phase, status: "running", command: script });
  const result = await runShellProcess(workspace, script, {
    signal,
    timeoutMs,
    pipefail: true,
    shellSandbox,
    envOverrides,
    workspaceReadOnly,
    readOnlyWorkspacePaths,
    onOutput: ({ stream, text }) => emit(onEvent, "shell_output", { stream, text }),
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  let status;
  let reason = null;
  if (result.aborted) {
    status = "unverified";
    reason = "aborted";
  } else if (result.timedOut) {
    status = "unverified";
    reason = "timed out";
  } else if (result.bufferExceeded) {
    status = "unverified";
    reason = "output limit exceeded";
  } else if (result.error) {
    status = "unverified";
    reason = result.error.message ?? String(result.error);
  } else if (result.signal) {
    status = "unverified";
    reason = `terminated by ${result.signal}`;
  } else if (!Number.isInteger(result.code)) {
    status = "unverified";
    reason = "missing exit code";
  } else {
    status = result.code === 0 ? "pass" : "fail";
  }
  const tests = parseTestCounts(script, output);
  const verification = {
    status,
    reason,
    exitCode: Number.isInteger(result.code) ? result.code : null,
    signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    aborted: Boolean(result.aborted),
    bufferExceeded: Boolean(result.bufferExceeded),
    durationMs: Date.now() - startedAt,
    tests,
    output,
  };
  emit(onEvent, "self_improve_verification", {
    phase,
    status,
    exitCode: verification.exitCode,
    tests,
  });
  return verification;
}

// Never let an advisory audit break a plan: any failure yields no note at all.
function safeIntegrationAudit(root) {
  try { return auditIntegration(root); } catch { return null; }
}

export function formatGovernedSelfImproveResult(result) {
  if (!result || typeof result !== "object") return "Self-improvement did not return a result.";
  if (result.mode === "plan") {
    if (!result.selected) return "No self-improvement candidates are currently observable.";
    const rows = result.candidates.map((candidate, index) => (
      `${index + 1}. [${candidate.id}]${candidate.promotionEligible === false ? " [build-only]" : ""} `
      + candidate.problem
    ));
    const nextPolicy = result.selected.promotionEligible === false
      ? " (build/test and stage on dev only)"
      : "";
    // Before proposing another module, say how many previously generated ones
    // never reached the agent loop. A remedy with no call site cannot change a
    // run, so building a new one on top of a shelf of them is the wrong next
    // move (audited 2026-07-30: 3 of 29 wired, 4,336 lines never executed).
    const audit = result.integrationAudit;
    const shelved = audit ? audit.testOnly.length + audit.unreferenced.length : 0;
    const integrationNote = shelved
      ? [
        `Note: ${shelved} previously generated module(s) (${audit.totals.shelvedLines} lines) `
        + "are not wired into the agent loop and so never reach a run. Prefer wiring or "
        + "retiring one over generating another; `node src/logic/integration-audit.js` lists them.",
      ]
      : [];
    return [
      `Self-improvement plan (${result.candidates.length} candidate(s)); `
      + "no source or self-improvement state files were changed.",
      ...rows,
      `Next managed candidate: ${result.selected.id}${nextPolicy}`,
      ...integrationNote,
    ].join("\n");
  }
  if (result.status === "no-candidates") {
    return "No self-improvement candidates are currently observable; "
      + "no source or self-improvement state files were changed.";
  }
  if (result.status === "all-staged") {
    return "Every currently observable build-only candidate already has a verified "
      + "checkpoint for this exact baseline. Use --candidate <id> to rebuild a specific "
      + "candidate; the live checkout was not changed.";
  }
  if (result.status === "accepted") {
    return [
      `Candidate ${result.selected.id} was built and verified in an isolated dev lane.`,
      `Version: ${result.candidateVersionRef}`,
      "It was not applied to the live checkout.",
    ].join("\n");
  }
  if (result.status === "staged") {
    if (result.reused) {
      return [
        `Candidate ${result.selected.id} already has a verified build-only checkpoint for this exact baseline.`,
        `Version: ${result.candidateVersionRef}`,
        `Evidence: ${result.evidenceRef}`,
        "It was reused without rebuilding or changing the live checkout.",
      ].join("\n");
    }
    return [
      `Build-only candidate ${result.selected.id} was built and verified in an isolated dev lane.`,
      `Version: ${result.candidateVersionRef}`,
      `Evidence: ${result.evidenceRef}`,
      "It was staged on dev only and was not applied to the live checkout.",
      "Passing the project suite is regression evidence, not promotion evidence; a preregistered paired behavioral benchmark is still required.",
    ].join("\n");
  }
  if (result.status === "promoted") {
    return [
      `Self-improvement ${result.selected.id} passed every gate and was promoted.`,
      `Version: ${result.candidateVersionRef}`,
      `Evidence: ${result.evidenceRef}`,
      "The live checkout now contains the candidate. Restart Bantam to load the promoted code.",
    ].join("\n");
  }
  return `Self-improvement finished with status: ${result.status ?? "unknown"}`;
}

function observedCandidates(workspace) {
  const scheduler = new ImprovementScheduler(workspace);
  const staticCandidates = scheduler.rankCandidates(scanWeaknesses(workspace))
    .map((candidate) => {
      const promotionEligible = candidate.promotionEligible !== false;
      return {
        ...candidate,
        source: "static-scan",
        promotionEligible,
        lanePolicy: promotionEligible ? "promotable" : "build-only",
        promotionBlocker: promotionEligible
          ? null
          : String(candidate.promotionBlocker ?? RUNTIME_PROMOTION_BLOCKER),
      };
    });
  let telemetry = [];
  let teacherCandidates = [];
  if (isBantamSelfHostWorkspace(workspace)) {
    telemetry = deriveSelfImprovementCandidates(loadSelfObservations(workspace))
      .map((candidate) => ({
        ...candidate,
        source: "runtime-observation",
        promotionEligible: false,
        lanePolicy: "build-only",
        promotionBlocker: RUNTIME_PROMOTION_BLOCKER,
      }));
    teacherCandidates = loadTeacherCandidates(workspace).map((candidate) => ({
      ...candidate,
      source: "teacher-collaboration",
      promotionEligible: false,
      lanePolicy: "build-only",
      promotionBlocker: TEACHER_PROMOTION_BLOCKER,
    }));
  }
  const seen = new Set();
  return [...staticCandidates, ...telemetry, ...teacherCandidates].filter((candidate) => {
    if (!candidate?.id || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function selectCandidate(candidates, id) {
  if (id) {
    const selected = candidates.find((candidate) => candidate.id === id);
    if (!selected) {
      throw new Error(
        `self-improvement candidate not found: ${id}; available: `
        + `${candidates.map((candidate) => candidate.id).join(", ") || "none"}`,
      );
    }
    return selected;
  }
  return candidates.find((candidate) => candidate.promotionEligible !== false)
    ?? candidates[0]
    ?? null;
}

function observeBaseline(store, workspace) {
  const checkpoint = store.workspaces.capture(workspace, {
    message: "BANTAM observed self-improvement baseline",
  });
  const regular = store.readChannel("regular");
  const dev = store.readChannel("dev");

  const regularTree = regular?.version?.value?.workspaceTree;
  const devTree = dev?.version?.value?.workspaceTree;
  let versionRef;
  if (regularTree === checkpoint.tree) {
    versionRef = regular.versionRef;
  } else if (devTree === checkpoint.tree) {
    versionRef = dev.versionRef;
  } else {
    versionRef = store.putVersion(harnessVersion(checkpoint), {
      parentVersionRef: regular?.versionRef ?? dev?.versionRef ?? null,
    });
  }
  return {
    checkpoint,
    versionRef,
    regular,
    dev,
    observedRegularRef: regular?.versionRef ?? null,
    observedDevRef: dev?.versionRef ?? null,
  };
}

function activateVerifiedBaseline(store, baseline, workspace) {
  let regular = store.readChannel("regular");
  let dev = store.readChannel("dev");
  if ((regular?.versionRef ?? null) !== baseline.observedRegularRef) {
    throw new Error("regular channel moved during baseline verification");
  }
  if ((dev?.versionRef ?? null) !== baseline.observedDevRef) {
    throw new Error("dev channel moved during baseline verification");
  }

  if (!regular) {
    regular = store.initChannel("regular", baseline.versionRef);
  }
  if (!dev) {
    dev = store.initChannel("dev", baseline.versionRef);
  }
  if (regular.versionRef !== baseline.versionRef) {
    regular = store.advanceChannel("regular", regular.versionRef, baseline.versionRef, {
      operation: "channel.verified_workspace_observed",
      metadata: { source: "self-improve-controller", workspace, verifiedBaseline: true },
    });
  }
  if (dev.versionRef !== baseline.versionRef) {
    dev = store.advanceChannel("dev", dev.versionRef, baseline.versionRef, {
      operation: "channel.verified_workspace_observed",
      metadata: { source: "self-improve-controller", workspace, verifiedBaseline: true },
    });
  }
  return { ...baseline, regular, dev };
}

async function runImplementationAgent({
  stateHome,
  laneId,
  task,
  model,
  verifier,
  maxTurns,
  verificationTimeoutMs,
  stateAudit,
  signal,
  onEvent,
}) {
  const stamp = makeStamp();
  const runId = makeRunId(stamp);
  const bridge = new LaneRunBridge({ stateHome, laneId, runId, stamp, task, model });
  const checkpoint = new RunCheckpoint({
    dest: null,
    autosaveEvery: 0,
    meta: { runId, stamp, laneId, task, kind: "bantam-self-improvement-run" },
    initialEvidence: bridge.resumeEvidence,
  });
  const detachModel = attachModelRequestCheckpoint(model, checkpoint);
  try {
    const result = await runAgent({
      task,
      workspace: bridge.workspace,
      model,
      maxTurns,
      verificationScript: verifier,
      verificationPolicy: "always",
      verificationTimeoutMs,
      planMode: true,
      preGate: true,
      // Teacher packets deliberately contain several independent adversarial
      // hypotheses. Auto-routing over that meta-text can combine words from
      // unrelated hypotheses and activate a task-specific audit (for example,
      // the keyed-Promise lifecycle audit) even when the selected slice is
      // synchronous. The council's explicit falsification plan is authoritative
      // for this lane; ordinary self-improvement candidates retain auto policy.
      stateAudit,
      ...(stateAudit === "off" ? {
        // Teacher implementation is already fed a bounded, cross-reviewed
        // falsification packet. Give it a deliberately tighter discovery
        // budget so large-repo scaling cannot turn that packet into another
        // dozen reconnaissance turns before the first candidate edit.
        progressNudgeAfter: 6,
        autoForceEditAfter: 6,
      } : {}),
      interactive: false,
      grounding: true,
      shellSandbox: "docker",
      shellNetwork: false,
      readOnlyWorkspacePaths: MANAGED_READ_ONLY_PATHS,
      verificationWorkspaceReadOnly: true,
      shellEnvOverrides: { BANTAM_SELF_IMPROVE_CHILD: "1" },
      signal,
      resumeTurns: bridge.resumeTurns,
      onEvent: (event) => {
        checkpoint.note(event);
        bridge.note(event, checkpoint, { model });
        onEvent(event);
      },
    });
    bridge.finish({ checkpoint, result, model });
    checkpoint.complete();
    return result;
  } catch (error) {
    bridge.abort({ checkpoint, error, model });
    throw error;
  } finally {
    detachModel();
    bridge.close();
  }
}

function checkpointImplementedLane(store, laneId, attemptId, state) {
  const current = store.status(laneId);
  const writer = store.acquireLane(laneId, {
    expectedEventId: current.eventId,
    allowWorkspaceDrift: true,
    metadata: { source: "self-improve-controller", attemptId },
  });
  try {
    return writer.checkpoint({
      schema: 1,
      kind: ATTEMPT_KIND,
      attemptId,
      phase: "implemented",
      ...state,
    }, {
      source: "self-improve-controller",
      phase: "implemented",
      attemptId,
    });
  } finally {
    writer.close();
  }
}

function materializeCandidateEvaluation({
  store,
  stateHome,
  attemptId,
  candidateCommit,
  dependencyRoot,
}) {
  const root = fs.mkdtempSync(
    path.join(ensureDirectory(path.join(stateHome, "candidate-evaluations")), `${attemptId}-`),
  );
  const workspace = path.join(root, "candidate");
  try {
    store.workspaces.materialize(candidateCommit, workspace);
    prepareRuntimeDependencies(dependencyRoot, workspace);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    workspace,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function materializeProtectedEvaluation({
  store,
  stateHome,
  attemptId,
  baselineCommit,
  candidateCommit,
  dependencyRoot,
}) {
  const root = fs.mkdtempSync(path.join(ensureDirectory(path.join(stateHome, "evaluations")), `${attemptId}-`));
  const baseline = path.join(root, "baseline");
  const workspace = path.join(root, "candidate");
  try {
    store.workspaces.materialize(baselineCommit, baseline);
    store.workspaces.materialize(candidateCommit, workspace);
    restoreProtectedBaseline(baseline, workspace);
    prepareRuntimeDependencies(dependencyRoot, workspace);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    workspace,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function materializeVersionsForDeployment({
  store,
  stateHome,
  attemptId,
  baselineCommit,
  candidateCommit,
}) {
  const root = fs.mkdtempSync(path.join(ensureDirectory(path.join(stateHome, "deployments")), `${attemptId}-`));
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "candidate");
  try {
    store.workspaces.materialize(baselineCommit, baseline);
    store.workspaces.materialize(candidateCommit, candidate);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    baseline,
    candidate,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function restoreProtectedBaseline(baseline, candidate) {
  const baselineFiles = listRegularFiles(baseline);
  const candidateFiles = listRegularFiles(candidate);
  for (const relative of candidateFiles) {
    if (!isProtectedPath(relative)) continue;
    fs.rmSync(safeJoin(candidate, relative), { force: true });
  }
  for (const relative of baselineFiles) {
    if (!isProtectedPath(relative)) continue;
    const source = safeJoin(baseline, relative);
    const destination = safeJoin(candidate, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  }
}

function evaluateSelectedWeakness(candidate, workspace) {
  if (!candidate.promotionEligible) {
    return {
      measured: false,
      improved: null,
      promotionEligible: false,
      reason: candidate.promotionBlocker ?? RUNTIME_PROMOTION_BLOCKER,
    };
  }
  const after = scanWeaknesses(workspace).find((entry) => entry.id === candidate.id);
  if (!after) {
    return { improved: true, reason: "candidate signal disappeared", before: candidate.occurrences ?? null, after: 0 };
  }
  const beforeOccurrences = Number(candidate.occurrences);
  const afterOccurrences = Number(after.occurrences);
  if (
    Number.isFinite(beforeOccurrences)
    && Number.isFinite(afterOccurrences)
    && afterOccurrences < beforeOccurrences
  ) {
    return {
      improved: true,
      reason: "observable occurrence count decreased",
      before: beforeOccurrences,
      after: afterOccurrences,
    };
  }
  if (candidate.id === "test-coverage" && Array.isArray(candidate.targets)) {
    const remaining = new Set(after.targets ?? []);
    const fixed = candidate.targets.filter((target) => !remaining.has(target));
    if (fixed.length > 0) {
      return {
        improved: true,
        reason: `${fixed.length} frozen coverage target(s) gained direct tests`,
        fixed,
      };
    }
  }
  return {
    improved: false,
    reason: Number.isFinite(beforeOccurrences) && Number.isFinite(afterOccurrences)
      ? `occurrences stayed at ${afterOccurrences} (baseline ${beforeOccurrences})`
      : "the frozen weakness predicate remains present",
  };
}

function improvementEvidence({
  attemptId,
  fingerprint,
  candidate,
  verifier,
  baseline,
  candidateSnapshot,
  candidateVersionRef,
  baselineVerification,
  implementationResult,
  candidateVerification,
  protectedVerification,
  metric,
  changeScope,
}) {
  return {
    schema: 1,
    kind: EVIDENCE_KIND,
    attemptId,
    fingerprint,
    candidate,
    verifier: {
      command: verifier,
      sha256: sha256(verifier),
    },
    baseline: {
      versionRef: baseline.versionRef,
      workspaceCommit: baseline.checkpoint.commit,
      workspaceTree: baseline.checkpoint.tree,
      verification: summarizeVerification(baselineVerification),
    },
    implementation: {
      laneCommit: candidateSnapshot.workspaceCommit,
      laneTree: candidateSnapshot.workspaceTree,
      result: summarizeImplementation(implementationResult, verifier),
      changeScope,
    },
    candidateVersionRef,
    immutableCandidateSuite: summarizeVerification(candidateVerification),
    protectedBaselineSuite: summarizeVerification(protectedVerification),
    metric,
  };
}

function requireSuccessfulImplementation(result, verifier) {
  if (!result || typeof result !== "object") {
    throw new Error("implementation runner returned no result");
  }
  if (result.interrupted) throw new Error("implementation was interrupted");
  if (result.blocked) throw new Error(`implementation was blocked: ${result.blocked.operation ?? "infrastructure"}`);
  if (!result.reachedDone && !result.done) throw new Error("implementation did not reach done");
  const verification = normalizeImplementationVerification(result.verification, verifier);
  requireGreenVerification(verification, "implementation");
}

function normalizeImplementationVerification(verification, verifier = "npm test") {
  if (!verification || typeof verification !== "object") return verification;
  if (verification.tests) return verification;
  const output = String(verification.detail ?? "");
  return {
    ...verification,
    tests: parseTestCounts(verifier, output),
    output,
  };
}

function requireGreenVerification(verification, label) {
  if (!verification || verification.status !== "pass") {
    throw new Error(
      `${label} verification is not green: ${verification?.reason ?? verification?.status ?? "missing"}`,
    );
  }
  if (verification.exitCode !== undefined && verification.exitCode !== null && verification.exitCode !== 0) {
    throw new Error(`${label} verifier returned exit ${verification.exitCode}`);
  }
  if (
    verification.timedOut
    || verification.aborted
    || verification.bufferExceeded
    || verification.signal
  ) {
    throw new Error(`${label} verification ended without trustworthy process evidence`);
  }
  const tests = verification.tests;
  if (!tests || !Number.isFinite(Number(tests.passed)) || !Number.isFinite(Number(tests.failed))) {
    throw new Error(`${label} verifier did not report trustworthy test counts`);
  }
  if (Number(tests.failed) > 0) {
    throw new Error(`${label} verifier reported ${tests.failed} failing test(s)`);
  }
  if (Number(tests.passed) <= 0) {
    throw new Error(`${label} verifier discovered no passing tests`);
  }
}

function parseTestCounts(command, output) {
  const text = String(output ?? "");
  // Canonical reporter summaries are authoritative. ObservationParser's
  // generic checkmark fallback counts glyphs, not tests, and can otherwise
  // collapse a full nested TAP run to "1 passed".
  const tapPass = lastIntegerMatch(text, /^# pass\s+(\d+)\s*$/gmi);
  const tapFail = lastIntegerMatch(text, /^# fail\s+(\d+)\s*$/gmi);
  if (tapPass !== null || tapFail !== null) {
    return normalizedTestCounts(tapPass ?? 0, tapFail ?? 0);
  }
  const pytestPass = lastIntegerMatch(text, /(?:^|\s)(\d+)\s+passed\b/gmi);
  const pytestFail = lastIntegerMatch(text, /(?:^|\s)(\d+)\s+failed\b/gmi);
  if (pytestPass !== null || pytestFail !== null) {
    return normalizedTestCounts(pytestPass ?? 0, pytestFail ?? 0);
  }
  const cargo = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed\b/i.exec(text);
  if (cargo) return normalizedTestCounts(cargo[1], cargo[2]);
  const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i.exec(text);
  if (jest) return normalizedTestCounts(jest[2] ?? 0, jest[1] ?? 0);
  try {
    const parsed = new ObservationParser().parse({ a: "shell", c: command }, text);
    const tests = parsed?.data?.tests ?? parsed?.extracted?.tests ?? null;
    if (tests) return normalizedTestCounts(tests.passed, tests.failed);
  } catch {
    // No trustworthy reporter-specific or structured count evidence.
  }
  return null;
}

function lastIntegerMatch(text, expression) {
  let value = null;
  for (const match of text.matchAll(expression)) value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) ? value : null;
}

function normalizedTestCounts(passedValue, failedValue) {
  const passed = Number(passedValue);
  const failed = Number(failedValue);
  return {
    passed: Number.isFinite(passed) && passed >= 0 ? Math.floor(passed) : 0,
    failed: Number.isFinite(failed) && failed >= 0 ? Math.floor(failed) : 0,
  };
}

function requireTestCountAtLeast(actual, expected, actualLabel, expectedLabel) {
  const actualPassed = Number(actual?.tests?.passed);
  const expectedPassed = Number(expected?.tests?.passed);
  if (!Number.isFinite(actualPassed) || !Number.isFinite(expectedPassed)) {
    throw new Error(`${actualLabel} and ${expectedLabel} must report comparable test counts`);
  }
  if (actualPassed < expectedPassed) {
    throw new Error(
      `${actualLabel} ran only ${actualPassed} passing test(s); `
      + `${expectedLabel} established ${expectedPassed}`,
    );
  }
}

function requireTestCountGreaterThan(actual, expected, actualLabel, expectedLabel) {
  const actualPassed = Number(actual?.tests?.passed);
  const expectedPassed = Number(expected?.tests?.passed);
  if (!Number.isFinite(actualPassed) || !Number.isFinite(expectedPassed)) {
    throw new Error(`${actualLabel} and ${expectedLabel} must report comparable test counts`);
  }
  if (actualPassed <= expectedPassed) {
    throw new Error(
      `${actualLabel} added no executed passing test `
      + `(${actualPassed} versus ${expectedPassed} in ${expectedLabel})`,
    );
  }
}

function summarizeVerification(verification) {
  const output = String(verification?.output ?? verification?.detail ?? "");
  return {
    status: verification?.status ?? "unverified",
    reason: verification?.reason ?? null,
    exitCode: Number.isInteger(verification?.exitCode) ? verification.exitCode : null,
    signal: verification?.signal ?? null,
    timedOut: Boolean(verification?.timedOut),
    aborted: Boolean(verification?.aborted),
    bufferExceeded: Boolean(verification?.bufferExceeded),
    durationMs: Number(verification?.durationMs ?? 0),
    tests: verification?.tests ?? parseTestCounts("npm test", output),
    outputSha256: sha256(output),
    outputTail: output.slice(-4000),
  };
}

function summarizeImplementation(result, verifier = "npm test") {
  return {
    reachedDone: Boolean(result?.reachedDone ?? result?.done),
    interrupted: Boolean(result?.interrupted),
    blocked: result?.blocked ?? null,
    summary: String(result?.summary ?? "").slice(0, 1000),
    verification: summarizeVerification(normalizeImplementationVerification(result?.verification, verifier)),
    metrics: {
      turns: Number(result?.metrics?.turns ?? 0),
      invalid: Number(result?.metrics?.invalid ?? 0),
      protocolViolations: Number(result?.metrics?.protocolViolations ?? 0),
      durationMs: Number(result?.metrics?.durationMs ?? 0),
    },
  };
}

export function buildImplementationTask({ candidate, verifier, operatorRequest }) {
  const buildOnly = !candidate.promotionEligible;
  const teacherTests = candidate.source === "teacher-collaboration"
    ? formatTeacherTestPlan(candidate.evidence?.adversarialTests)
    : [];
  return [
    "Implement exactly one governed self-improvement in this private BANTAM checkout.",
    `Candidate: ${candidate.id}`,
    `Area: ${candidate.area}`,
    `Observed problem: ${candidate.problem}`,
    `Proposal: ${candidate.proposal}`,
    buildOnly
      ? "Lane policy: build-only. Repeated runtime telemetry is a problem signal, not proof that this remedy improves behavior."
      : "",
    candidate.targets?.length
      ? `Frozen source targets (the ONLY existing source files you may edit): ${candidate.targets.join(", ")}`
      : "",
    ...teacherTests,
    operatorRequest ? `Operator context: ${String(operatorRequest).slice(0, 1000)}` : "",
    "",
    "Required boundaries:",
    buildOnly
      ? "- Build the smallest independently useful remedy with deterministic tests for one intended mechanism; do not claim the project suite measures runtime lift."
      : "- Make a focused implementation that measurably reduces the stated weakness.",
    candidate.source === "teacher-collaboration"
      ? "- Treat the council list as a falsification menu, not a mandate to implement every idea. Select one task-general vertical slice, keep the change narrow, and leave the remaining hypotheses for later cycles."
      : "",
    candidate.source === "teacher-collaboration"
      ? "- Source-scope contract: edit only the frozen source targets named above. You may add at most one small helper imported by an edited target and focused new tests discovered by the verifier. Do not search for or edit alternative integration files."
      : "",
    candidate.source === "teacher-collaboration"
      ? "- Reconnaissance budget: batch independent reads with inspect, choose the slice within six read/query actions, then implement or report a genuine blocker."
      : "",
    candidate.id === "test-coverage"
      ? "- Keep this cycle atomic: add one focused test file with 1-3 high-value cases for the frozen module; do not exhaustively duplicate its whole API."
      : "",
    "- Add or strengthen meaningful tests; do not weaken, delete, skip, or bypass existing tests.",
    "- Do not change package.json, dependency lockfiles, package-manager config, .bantam state, credentials, or generated artifacts.",
    `- Run the verifier exactly as configured (${verifier}); do not pipe/filter it or append success-forcing shell controls.`,
    "- Finish only after the verifier passes on the final tree.",
    buildOnly
      ? "- This run may checkpoint the tested build on dev, but cannot deploy it or promote regular without a preregistered paired behavioral benchmark."
      : "",
  ].filter(Boolean).join("\n");
}

function formatTeacherTestPlan(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return [];
  return [
    "",
    "Teacher-council falsification plan (hypotheses, not hidden answers):",
    ...tests.slice(0, 8).flatMap((test, index) => [
      `${index + 1}. ${String(test.name ?? "unnamed").slice(0, 120)} — ${String(test.purpose ?? "").slice(0, 500)}`,
      `   Setup: ${String(test.setup ?? "").slice(0, 800)}`,
      `   Assertion: ${String(test.assertion ?? "").slice(0, 800)}`,
      `   Guards against: ${String(test.guardsAgainst ?? "").slice(0, 500)}`,
    ]),
    "Implement only task-general harness behavior and deterministic tests. Do not encode benchmark-specific cases or reference source.",
  ];
}

function prepareRuntimeDependencies(source, destination) {
  const from = path.join(source, "node_modules");
  const to = path.join(destination, "node_modules");
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`dependency root is not a real directory: ${from}`);
  }
  const staging = path.join(
    destination,
    `.bantam-runtime-deps-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    fs.cpSync(from, staging, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(staging, to);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function removeRuntimeDependencies(workspace) {
  const target = path.join(workspace, "node_modules");
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing unexpected lane dependency path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function requireDependencyManifestsUnchanged(baseline, candidate) {
  const predicate = (relative) => DEPENDENCY_FILES.includes(path.posix.basename(relative));
  const before = matchingWorkspaceFiles(baseline, predicate, "dependency manifest");
  const after = matchingWorkspaceFiles(candidate, predicate, "dependency manifest");
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const relative of names) {
    if (!buffersEqual(before.get(relative) ?? null, after.get(relative) ?? null)) {
      throw new Error(
        "self-improvement cannot change dependency manifest without a provisioned "
        + `dependency evaluation: ${relative}`,
      );
    }
  }
}

function requireIgnoreRulesUnchanged(baseline, candidate) {
  const before = matchingWorkspaceFiles(
    baseline,
    (relative) => path.posix.basename(relative) === ".gitignore",
    "capture policy",
  );
  const after = matchingWorkspaceFiles(
    candidate,
    (relative) => path.posix.basename(relative) === ".gitignore",
    "capture policy",
  );
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const relative of names) {
    if (!buffersEqual(before.get(relative) ?? null, after.get(relative) ?? null)) {
      throw new Error(
        `self-improvement cannot change capture policy during evaluation: ${relative}`,
      );
    }
  }
}

function requirePackageManagerConfigUnchanged(baseline, candidate) {
  const before = matchingWorkspaceFiles(
    baseline,
    isPackageManagerConfigPath,
    "package-manager execution config",
  );
  const after = matchingWorkspaceFiles(
    candidate,
    isPackageManagerConfigPath,
    "package-manager execution config",
  );
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const relative of names) {
    if (!buffersEqual(before.get(relative) ?? null, after.get(relative) ?? null)) {
      throw new Error(
        `self-improvement cannot change package-manager execution config during evaluation: ${relative}`,
      );
    }
  }
}

function matchingWorkspaceFiles(workspace, predicate, label) {
  const root = path.resolve(workspace);
  const files = new Map();
  const skip = new Set([".git", ".bantam", "node_modules"]);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        if (predicate(relative)) {
          throw new Error(`self-improvement ${label} refuses symlink: ${relative}`);
        }
        continue;
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(relative)) {
        files.set(relative, fs.readFileSync(full));
      }
    }
  };
  visit(root);
  return files;
}

function assertWorkspaceTree(store, workspace, expected, message) {
  const baselineCommit = expected.workspaceCommit ?? expected.commit;
  if (typeof baselineCommit !== "string" || !baselineCommit) {
    throw new Error(`${message}: missing immutable baseline commit`);
  }
  const actual = store.workspaces.treeForWorkspace(workspace, {
    baselineCommit,
  });
  const tree = expected.workspaceTree ?? expected.tree;
  if (actual.tree !== tree) {
    throw new Error(`${message}: expected ${tree}, found ${actual.tree}`);
  }
}

function rollbackOwnedDev(store, candidateVersionRef, baselineVersionRef, attemptId, reason) {
  const dev = store.readChannel("dev");
  if (dev?.versionRef !== candidateVersionRef) return false;
  store.rollbackChannel("dev", candidateVersionRef, baselineVersionRef, {
    source: "self-improve-controller",
    attemptId,
    reason: String(reason).slice(0, 1000),
  });
  return true;
}

function selfImproveFingerprint({ baseline, candidate, verifier }) {
  return hashJson({
    schema: 1,
    baselineVersionRef: baseline.versionRef,
    baselineTree: baseline.checkpoint.tree,
    candidate,
    verifier,
  });
}

function validStagedAttempt(
  entries,
  fingerprint,
  store,
  { requireCurrentDev = true } = {},
) {
  const devVersionRef = requireCurrentDev
    ? (store.readChannel("dev")?.versionRef ?? null)
    : null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.phase !== "staged"
      || entry.fingerprint !== fingerprint
      || typeof entry.candidateVersionRef !== "string"
      || typeof entry.evidenceRef !== "string"
      || (requireCurrentDev && entry.candidateVersionRef !== devVersionRef)
    ) continue;
    try {
      store.readVersion(entry.candidateVersionRef);
      const evidence = store.blobs.getJson(entry.evidenceRef);
      if (
        evidence?.kind !== EVIDENCE_KIND
        || evidence.fingerprint !== fingerprint
        || evidence.candidateVersionRef !== entry.candidateVersionRef
      ) continue;
      return entry;
    } catch {
      // Missing/corrupt staged state cannot suppress a fresh governed build.
    }
  }
  return null;
}

function reusableStagedAttempt(entries, fingerprint, store) {
  return validStagedAttempt(entries, fingerprint, store, { requireCurrentDev: true });
}

class AttemptLedger {
  constructor(file) {
    this.file = path.resolve(file);
    this.entries = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) { throw new Error(`self-improvement attempt ledger is corrupt: ${error.message}`); }
    if (!Array.isArray(value)) throw new Error("self-improvement attempt ledger is corrupt: expected an array");
    return value;
  }

  begin(value) {
    if (this.entries.some((entry) => entry.id === value.id)) {
      throw new Error(`self-improvement attempt already exists: ${value.id}`);
    }
    const entry = {
      ...jsonCopy(value, "self-improvement attempt"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ phase: value.phase, at: new Date().toISOString() }],
    };
    this.entries = [...this.entries, entry];
    this.persist();
    return entry;
  }

  get(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`self-improvement attempt not found: ${id}`);
    return entry;
  }

  phase(id, phase, fields = {}) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`self-improvement attempt not found: ${id}`);
    const current = this.entries[index];
    const at = new Date().toISOString();
    const next = {
      ...current,
      ...jsonCopy(fields, "self-improvement attempt fields"),
      phase,
      updatedAt: at,
      history: [...(current.history ?? []), { phase, at }],
    };
    this.entries = this.entries.map((entry, item) => item === index ? next : entry);
    this.persist();
    return next;
  }

  fail(id, error, phase) {
    try {
      return this.phase(id, phase, {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      return null;
    }
  }

  persist() {
    writeJsonAtomic(this.file, this.entries.slice(-200));
  }
}

function acquireControllerLock(file) {
  try {
    return acquireExclusiveFileLock(file, {
      kind: "bantam-self-improvement-controller",
      staleAfterMs: LOCK_INITIALIZE_GRACE_MS,
      initializeGraceMs: LOCK_INITIALIZE_GRACE_MS,
      waitMs: 0,
    });
  } catch (error) {
    if (error?.code !== "ELOCKED") throw error;
    const owner = Number.isInteger(error.owner?.pid)
      ? ` (pid ${error.owner.pid})`
      : " (lock is being initialized)";
    throw new Error(`another self-improvement controller is active${owner}`);
  }
}

function uniqueAttemptId(entries, fingerprint, date) {
  const stamp = makeStamp(date).replace(/^run-/, "");
  const base = `${fingerprint.slice(0, 12)}-${stamp}`;
  let id = base;
  let suffix = 1;
  const used = new Set(entries.map((entry) => entry.id));
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}

function publicAttempt(attempt) {
  return {
    id: attempt.id,
    fingerprint: attempt.fingerprint,
    phase: attempt.phase,
    candidateId: attempt.candidate?.id ?? null,
    baseline: attempt.baseline,
    candidateVersionRef: attempt.candidateVersionRef ?? null,
    evidenceRef: attempt.evidenceRef ?? null,
    error: attempt.error ?? null,
  };
}

function freezeCandidate(candidate) {
  const value = jsonCopy(candidate, "self-improvement candidate");
  const source = value.source === "static-scan"
    ? "static-scan"
    : value.source === "teacher-collaboration"
      ? "teacher-collaboration"
      : "runtime-observation";
  // Fail closed: only scanner-derived candidates are eligible for the existing
  // structural metric + promotion path. Runtime evidence can drive a build,
  // but the redacted ledger cannot reconstruct a paired behavioral verifier.
  const promotionEligible = source === "static-scan" && value.promotionEligible === true;
  return {
    id: String(value.id),
    area: String(value.area ?? "unknown"),
    problem: String(value.problem ?? ""),
    proposal: String(value.proposal ?? ""),
    effort: Number(value.effort ?? 1),
    impact: Number(value.impact ?? 1),
    occurrences: value.occurrences ?? null,
    targets: Array.isArray(value.targets) ? [...value.targets] : [],
    patternEvidence: Array.isArray(value.patternEvidence) ? value.patternEvidence : [],
    evidence: value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? value.evidence
      : null,
    source,
    promotionEligible,
    lanePolicy: promotionEligible ? "promotable" : "build-only",
    promotionBlocker: promotionEligible
      ? null
      : String(value.promotionBlocker ?? RUNTIME_PROMOTION_BLOCKER).slice(0, 1000),
  };
}

function harnessVersion(checkpoint) {
  return {
    kind: "bantam.harness-workspace",
    workspaceCommit: checkpoint.commit,
    workspaceTree: checkpoint.tree,
    files: checkpoint.files,
  };
}

function listRegularFiles(root) {
  const base = path.resolve(root);
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(base, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`protected evaluation refuses symlink: ${relative}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) output.push(relative);
      else throw new Error(`protected evaluation refuses special file: ${relative}`);
    }
  };
  visit(base);
  return output.sort();
}

function snapshotManagedRuntimeState(workspace) {
  const root = path.resolve(workspace);
  const entries = [];
  for (const relativeRoot of MANAGED_READ_ONLY_PATHS) {
    const start = path.join(root, relativeRoot);
    let startStat;
    try {
      startStat = fs.lstatSync(start);
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries.push([relativeRoot, "missing"]);
        continue;
      }
      throw error;
    }
    const visit = (full, relative) => {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push([relative, "symlink", fs.readlinkSync(full)]);
        return;
      }
      if (stat.isFile()) {
        entries.push([
          relative,
          "file",
          stat.mode & 0o777,
          sha256(fs.readFileSync(full)),
        ]);
        return;
      }
      if (!stat.isDirectory()) {
        entries.push([relative, "special", stat.mode & 0o777]);
        return;
      }
      entries.push([relative, "directory", stat.mode & 0o777]);
      for (const entry of fs.readdirSync(full).sort()) {
        visit(path.join(full, entry), `${relative}/${entry}`);
      }
    };
    visit(start, relativeRoot);
    if (!startStat.isDirectory()) continue;
  }
  return hashJson(entries);
}

function assertManagedRuntimeStateUnchanged(workspace, expectedDigest) {
  const actualDigest = snapshotManagedRuntimeState(workspace);
  if (actualDigest !== expectedDigest) {
    throw new Error(
      "deployed live verifier changed protected .git, .bantam, or node_modules state",
    );
  }
}

function isProtectedPath(relative) {
  const normalized = String(relative).split(path.sep).join("/");
  return PROTECTED_ROOT_FILES.has(normalized)
    || isTestPath(normalized)
    || isRunnerConfigPath(normalized);
}

function buffersEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function safeJoin(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(relative));
  if (!target.startsWith(base + path.sep)) throw new Error(`path escapes workspace: ${relative}`);
  return target;
}

function requireDirectory(value, label) {
  const resolved = path.resolve(String(value ?? ""));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) { throw new Error(`${label} is unavailable: ${error.message}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a real directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
}

function assertStateInsideWorkspace(workspace, stateHome) {
  const relative = path.relative(workspace, stateHome);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("self-improvement state home must be a private subdirectory of the workspace");
  }
}

function assertPrivatePathComponents(workspace, target, label) {
  const root = fs.realpathSync(workspace);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain inside the Bantam workspace`);
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(`${label} is unavailable: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} refuses symlink path component: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} path component is not a directory: ${current}`);
    }
    const real = fs.realpathSync(current);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${label} resolves outside the Bantam workspace: ${current}`);
    }
  }
}

function assertNotNested(env) {
  if (String(env?.BANTAM_SELF_IMPROVE_CHILD ?? "")) {
    throw new Error("recursive self-improvement is not allowed");
  }
}

function abortIfRequested(signal, phase) {
  if (signal?.aborted) throw new Error(`self-improvement interrupted ${phase}`);
}

function emit(handler, type, fields) {
  try { handler({ type, ...fields }); }
  catch { /* presentation observers cannot change controller outcome */ }
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonCopy(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new TypeError(`${label} must be JSON-serializable: ${error.message}`); }
  if (typeof serialized !== "string") throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(serialized);
}

export const SELF_IMPROVE_DEFAULTS = Object.freeze({
  maxTurns: DEFAULT_MAX_TURNS,
  verificationTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
});
