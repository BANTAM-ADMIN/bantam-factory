// Durable run artifacts — Bantam's evidence layer.
//
// A Bantam run that isn't serialized to disk didn't happen. Every `--save-run`
// writes one raw-output-preserving JSON per run: enough to replay, debug, or
// mine as training signal. Schema agreed with Codex (CODEXNOTES 2026-07-07):
//
//   { schema: 2, kind: "bantam-run", runId, stamp, fixture, workspaceSnapshot?,
//     endpoint, modelId, sampling, model, modelCalls, harnessGit, experiment,
//     turns: [{ i, reasoning, rawOutput, parsedAction, protocolViolation, observation, rawObservation, tookMs }],
//     rejectedOutputs: [{ turn, attempt, rawOutput, error, reasoning }],
//     result: { pass, verifyDetail, exitCode },
//     metrics: { turns, modelRequests, auxiliaryModelRequests, modelRequestsPerTurn, invalid, protocolViolations, thinkPhases, thinkTok, actionTok, thinkTokenBudget, rePlans, preGateFails, shellCwdGuards, workspaceAliasNormalizations, shellReadGuards, testPipeGuards, testDigestHits, repeatedFailureHints, outcomeCycleEvents, outcomeCycleHints, completionAuditHints, stateAuditHints, stateAuditPolicy, planAuditHints, capabilityHints, infrastructureBlocks, duplicateActionRejections, duplicateShellRejections, noOpEdits, repeatEscapeMasks, doneRejections, ledgerRejections, secretAuditRejections, evidenceGateRejections, selfCheckRejections, groundingRejects, queries, queryBudgetBlocks, lessonHits, lessonTools, progressNudges, progressGateRejections, progressGateTerminations, artifactVerificationNudges, artifactVerificationGateRejections, artifactVerificationGateTerminations, maxProgresslessTurns, replaceFailures, patchFailures, patchActionPolicy, promptTok, genTok, totalMs },
//     finalDiff: { status, format, bytes, sha256, truncated, text },
//     attachments: { schema, status, policy, files, totalBytes, omitted, indexPath } }
//
// Raw model output is stored SEPARATELY from the parsed action, on purpose.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { auditCodexPromptDelivery } from "./codex-artifact-audit.js";
import { attachPromptTelemetry, summarizePromptTelemetry } from "./prompt-telemetry.js";
import { buildContextFlightRecorder } from "./context-flight-recorder.js";

/**
 * Best-effort model id from the llama.cpp server. Returns null on any failure
 * rather than guessing — an honest artifact records what it actually knows.
 */
export async function fetchModelId(endpoint, timeoutMs = 5000) {
  const base = String(endpoint || "").replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const id = data?.data?.[0]?.id;
    return typeof id === "string" && id.length ? id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the artifact object from an agent run result + its model client.
 * Pure (no I/O) so it is trivially unit-testable.
 *
 * @param {object} p
 * @param {string} p.runId
 * @param {string} p.stamp        ISO-ish timestamp string
 * @param {string|null} p.fixture fixture name, or null for an ad-hoc run
 * @param {string|null} p.task exact user/fixture task, or null when unavailable
 * @param {object} p.model        ModelClient (public endpoint/sampling fields)
 * @param {string|null} p.modelId resolved served model id, or null
 * @param {object} p.result       runAgent() return value
 * @param {object|null} p.finalDiff final workspace diff capture, or null
 * @param {object|null} p.harnessGit git/dirty-tree provenance for the harness code
 * @param {object|null} p.fixtureProvenance exact task/repository/grader content roots
 * @param {object|null} p.experiment optional experiment/arm/round provenance
 * @param {object|null} p.continuation optional standalone continuation provenance
 */
export function buildArtifact({
  runId,
  stamp,
  fixture,
  task = null,
  model,
  modelId = null,
  result,
  finalDiff = null,
  graderTampering = null,   // grader files modified/deleted during a --verify run
  harnessGit = null,
  fixtureProvenance = null,
  experiment = null,
  continuation = null,
  // Agent-authored workspace files, so `--resume-run` can rebuild the tree in a
  // fresh container. Without this an artifact restores the DIALOGUE and none of
  // the work, which is why every budget-truncated run had to start from zero.
  workspaceSnapshot = null,
}) {
  requireNonEmptyString(runId, "runId");
  requireNonEmptyString(stamp, "stamp");
  requireRecord(result, "result");
  requireOptionalArray(result.turns, "result.turns");
  requireOptionalArray(result.rejectedOutputs, "result.rejectedOutputs");
  requireOptionalArray(result.warnings, "result.warnings");

  const m = result.metrics ?? {};
  const verification = result.verification ?? null;
  const modelMetadata = normalizeModelMetadata(model);
  const modelCalls = attachPromptTelemetry(normalizeModelCalls(model, result));
  const promptChurn = summarizePromptTelemetry(modelCalls);
  const codexThreads = summarizeCodexThreads(modelCalls);
  const codexPromptDelivery = summarizeCodexPromptDelivery(modelCalls);
  const codexPromptIntegrity = auditCodexPromptDelivery({
    model: { metadata: modelMetadata },
    modelCalls,
  });
  const contextFlightRecorder = buildContextFlightRecorder({
    turns: result.turns ?? [],
    modelCalls,
  });
  return {
    schema: 2,
    kind: "bantam-run",
    runId,
    stamp,
    // Present only when the caller captured one. `--resume-run` rebuilds these
    // files into a fresh workspace, which is what makes a truncated run
    // continuable instead of restartable.
    ...(workspaceSnapshot && Array.isArray(workspaceSnapshot.files) && workspaceSnapshot.files.length
      ? { workspaceSnapshot }
      : {}),
    fixture: fixture ?? null,
    task: typeof task === "string" ? task : null,
    endpoint: model?.endpoint ?? null,
    modelId: modelId ?? null,
    sampling: {
      profile: model?.profileName ?? null,
      temperature: model?.temperature ?? null,
      act_temperature: model?.actTemperature ?? null,
      top_p: model?.topP ?? null,
      top_k: model?.topK ?? null,
      seed: model?.seed ?? null,
    },
    // Schema 1 exposed endpoint/modelId/sampling at top level. Keep those fields
    // indefinitely for readers, while schema 2 adds the restorable model identity
    // and every exact serialized completion request/response exchange.
    model: {
      id: modelId ?? null,
      fingerprint: modelMetadata ? modelFingerprint(modelMetadata, modelId) : null,
      metadata: modelMetadata,
    },
    modelCalls,
    contextFlightRecorder,
    harnessGit: normalizeHarnessGit(harnessGit),
    ...(fixtureProvenance ? { fixtureProvenance: serializableCopy(fixtureProvenance) } : {}),
    experiment: normalizeExperiment(experiment),
    ...(continuation ? { continuation: serializableCopy(continuation) } : {}),
    turns: (result.turns ?? []).map((t, idx) => ({
      i: t.i ?? idx,
      reasoning: t.reasoning ?? null,
      rawOutput: t.rawOutput ?? null,
      parsedAction: serializableCopy(t.parsedAction ?? t.action ?? null),
      protocolViolation: Boolean(t.protocolViolation),
      observation: t.observation ?? null,
      rawObservation: t.rawObservation ?? null,
      tookMs: t.tookMs ?? null,
      // Present only when BANTAM_SAVE_PROMPTS=1: the exact assembled prompt
      // for this turn, enabling turn-level counterfactual replay.
      ...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
      ...(Number.isInteger(t.modelCallIndex) ? { modelCallIndex: t.modelCallIndex } : {}),
      ...(t.modelRequest !== undefined ? { modelRequest: serializableCopy(t.modelRequest) } : {}),
      ...(typeof t.queryExecuted === "boolean" ? { queryExecuted: t.queryExecuted } : {}),
      ...(Object.prototype.hasOwnProperty.call(t, "queryTool") ? { queryTool: t.queryTool ?? null } : {}),
      ...(t.toolOutcome !== undefined ? { toolOutcome: serializableCopy(t.toolOutcome) } : {}),
      ...(t.preview !== undefined ? { preview: serializableCopy(t.preview) } : {}),
      ...(typeof t.editApplied === "boolean" ? { editApplied: t.editApplied } : {}),
      ...(typeof t.doneAccepted === "boolean" ? { doneAccepted: t.doneAccepted } : {}),
      ...(t.controllerStop ? { controllerStop: serializableCopy(t.controllerStop) } : {}),
      // Presence is meaningful: explicit null means no execution proof; an
      // absent field belongs to a legacy film whose prose may be consulted.
      ...(Object.hasOwn(t, "verificationEvidence") ? { verificationEvidence: serializableCopy(t.verificationEvidence) } : {}),
      ...(Object.hasOwn(t, "verificationReceipts") ? { verificationReceipts: serializableCopy(t.verificationReceipts) } : {}),
      ...(Object.hasOwn(t, "shellExecution") ? { shellExecution: serializableCopy(t.shellExecution) } : {}),
      ...(Object.hasOwn(t, "probeEvidence") ? { probeEvidence: serializableCopy(t.probeEvidence) } : {}),
      ...(Object.hasOwn(t, "editOutcome") ? { editOutcome: serializableCopy(t.editOutcome) } : {}),
      ...(Object.hasOwn(t, "contractStateAudit") ? { contractStateAudit: serializableCopy(t.contractStateAudit) } : {}),
      ...(Object.hasOwn(t, "contractAssertion") ? { contractAssertion: serializableCopy(t.contractAssertion) } : {}),
      ...(Object.hasOwn(t, "contextBasis") ? { contextBasis: serializableCopy(t.contextBasis) } : {}),
      ...(Object.hasOwn(t, "contextUpdates") ? { contextUpdates: serializableCopy(t.contextUpdates) } : {}),
      ...(t.scopedVerify !== undefined ? { scopedVerify: serializableCopy(t.scopedVerify) } : {}),
      ...(t.environmentVerification !== undefined
        ? { environmentVerification: serializableCopy(t.environmentVerification) }
        : {}),
      ...(typeof t.sourceEditedByShell === "boolean"
        ? { sourceEditedByShell: t.sourceEditedByShell }
        : {}),
      ...(Array.isArray(t.shellChangedPaths) ? { shellChangedPaths: [...t.shellChangedPaths] } : {}),
      ...(t.shellScopeRollback !== undefined ? { shellScopeRollback: serializableCopy(t.shellScopeRollback) } : {}),
      ...(t.stateAudit !== undefined ? { stateAudit: serializableCopy(t.stateAudit) } : {}),
      ...(t.workspaceCoherence !== undefined
        ? { workspaceCoherence: serializableCopy(t.workspaceCoherence) }
        : {}),
    })),
    rejectedOutputs: (result.rejectedOutputs ?? []).map((r) => ({
      turn: r.turn ?? null,
      attempt: r.attempt ?? null,
      rawOutput: r.rawOutput ?? null,
      error: r.error ?? null,
      reasoning: r.reasoning ?? null,
      ...(r.kind !== undefined ? { kind: r.kind } : {}),
      ...(r.target !== undefined ? { target: r.target } : {}),
      ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
      ...(r.stoppedLimit !== undefined ? { stoppedLimit: Boolean(r.stoppedLimit) } : {}),
    })),
    result: {
      pass: result.finalStatus ? result.finalStatus === "pass" : verification ? verification.status === "pass" : null,
      status: result.finalStatus ?? (verification ? verification.status : "unverified"),
      // Present only for fixtures that declare an expected outcome: how the raw
      // public/contract results graded against it. The raw evidence stays in
      // verifyDetail/exitCode/contract below, unchanged.
      ...(result.expectation ? { expectation: serializableCopy(result.expectation) } : {}),
      verifyDetail: verification ? (verification.detail ?? null) : null,
      exitCode: verification && verification.exitCode !== undefined ? verification.exitCode : null,
      verificationWorkspaceReadOnly: typeof verification?.workspaceReadOnly === "boolean" ? verification.workspaceReadOnly : null,
      reachedDone: Boolean(result.reachedDone),
      controllerStop: serializableCopy(result.controllerStop ?? null),
      interrupted: Boolean(result.interrupted),
      summary: result.summary ?? null,
      blocked: normalizeInfrastructureBlock(result.blocked),
      modelFailure: normalizeModelFailure(result.modelFailure),
      contract: normalizeContractVerification(result.contractVerification),
      warnings: (result.warnings ?? []).map((warning) => ({
        gate: String(warning?.gate ?? ""),
        message: String(warning?.message ?? ""),
      })),
    },
    metrics: {
      // Every counter the run kept, verbatim, BEFORE the curated fields below.
      // Those rename, default and reshape a chosen few; this captures the rest.
      // The curated list silently dropped 34 of the agent's 42 counters -- among
      // them capabilityHints, stuckDiagnoses, teacherDiagnoses, crossFileUsageNotes
      // and editRecoveryHints. A mechanism whose counter never reaches the artifact
      // cannot be shown to fire, which is indistinguishable from one that never
      // does, and that exact ambiguity let the anti-spiral gate look alive for
      // weeks while being structurally unreachable.
      //
      // Spread FIRST so every curated field still wins on name collisions and the
      // existing schema is unchanged.
      ...serializableCopy(m ?? {}),
      turns: m.turns ?? 0,
      modelRequests: m.modelRequests ?? null,
      auxiliaryModelRequests: m.auxiliaryModelRequests ?? null,
      modelRequestsPerTurn: m.modelRequestsPerTurn ?? null,
      usage: normalizeUsage(result.usage),
      usageBySource: normalizeUsageBySource(result.usageBySource),
      toolOutcomeCounts: serializableCopy(m.toolOutcomeCounts ?? {}),
      promptChurn,
      codexThreads,
      codexPromptDelivery,
      codexPromptIntegrity,
      autoPreviews: m.autoPreviews ?? 0,
      invalid: m.invalid ?? 0,
      outputLimitRecoveries: m.outputLimitRecoveries ?? 0,
      protocolViolations: m.protocolViolations ?? 0,
      thinkPhases: m.thinkPhases ?? 0,
      thinkTok: m.thinkTokens ?? 0,
      actionTok: m.actionTokens ?? 0,
      thinkTokenBudget: m.thinkTokenBudget ?? null,
      rePlans: m.rePlans ?? 0,
      preGateFails: m.preGateFails ?? 0,
      shellCwdGuards: m.shellCwdGuards ?? 0,
      workspaceAliasNormalizations: m.workspaceAliasNormalizations ?? 0,
      shellReadGuards: m.shellReadGuards ?? 0,
      testPipeGuards: m.testPipeGuards ?? 0,
      testDigestHits: m.testDigestHits ?? 0,
      repeatedFailureHints: m.repeatedFailureHints ?? 0,
      outcomeCycleEvents: m.outcomeCycleEvents ?? 0,
      outcomeCycleHints: m.outcomeCycleHints ?? 0,
      derivedFailureContextHints: m.derivedFailureContextHints ?? 0,
      lifecycleContractHints: m.lifecycleContractHints ?? 0,
      lifecycleContractDoneRejections: m.lifecycleContractDoneRejections ?? 0,
      completionAuditHints: m.completionAuditHints ?? 0,
      visualCompletionAuditHints: m.visualCompletionAuditHints ?? 0,
      visualCompletionAuditRevisions: m.visualCompletionAuditRevisions ?? 0,
      lexicalContractAuditHints: m.lexicalContractAuditHints ?? 0,
      visualAltCoverageHints: m.visualAltCoverageHints ?? 0,
      visualAltCoverageRevisions: m.visualAltCoverageRevisions ?? 0,
      stateAuditHints: m.stateAuditHints ?? 0,
      stateAuditEngagements: m.stateAuditEngagements ?? 0,
      stateAuditDoneDeferrals: m.stateAuditDoneDeferrals ?? 0,
      stateAuditProbeDiagnostics: m.stateAuditProbeDiagnostics ?? 0,
      planAuditHints: m.planAuditHints ?? 0,
      stateAuditPolicy: normalizePatchActionPolicy(m.stateAuditPolicy),
      capabilityHints: m.capabilityHints ?? 0,
      infrastructureBlocks: m.infrastructureBlocks ?? 0,
      duplicateActionRejections: m.duplicateActionRejections ?? 0,
      duplicateShellRejections: m.duplicateShellRejections ?? 0,
      scopeMismatchNotices: m.scopeMismatchNotices ?? 0,
      embeddedBaselineRecognitions: m.embeddedBaselineRecognitions ?? 0,
      successfulShellReplaySlims: m.successfulShellReplaySlims ?? 0,
      successfulShellReplayOmittedChars: m.successfulShellReplayOmittedChars ?? 0,
      immutableEditRejections: m.immutableEditRejections ?? 0,
      shellScopeRollbacks: m.shellScopeRollbacks ?? 0,
      shellScopeViolationFiles: m.shellScopeViolationFiles ?? 0,
      noOpEdits: m.noOpEdits ?? 0,
      repeatEscapeMasks: m.repeatEscapeMasks ?? 0,
      doneRejections: m.doneRejections ?? 0,
      ledgerRejections: m.ledgerRejections ?? 0,
      secretAuditRejections: m.secretAuditRejections ?? 0,
      evidenceGateRejections: m.evidenceGateRejections ?? 0,
      previewGateRejections: m.previewGateRejections ?? 0,
      environmentVerificationRuns: m.environmentVerificationRuns ?? 0,
      environmentVerificationPasses: m.environmentVerificationPasses ?? 0,
      environmentVerificationRejections: m.environmentVerificationRejections ?? 0,
      verifyDoneGateRuns: m.verifyDoneGateRuns ?? 0,
      verifyRedDoneRejections: m.verifyRedDoneRejections ?? 0,
      siblingSymbolRejections: m.siblingSymbolRejections ?? 0,
      edgeSmokeRejections: m.edgeSmokeRejections ?? 0,
      specExampleRejections: m.specExampleRejections ?? 0,
      lexicalSmokeRejections: m.lexicalSmokeRejections ?? 0,
      typeContractRejections: m.typeContractRejections ?? 0,
      verifyRedGateEvaluations: m.verifyRedGateEvaluations ?? 0,
      siblingSymbolGateEvaluations: m.siblingSymbolGateEvaluations ?? 0,
      familyConventionGateEvaluations: m.familyConventionGateEvaluations ?? 0,
      edgeSmokeGateEvaluations: m.edgeSmokeGateEvaluations ?? 0,
      specExampleGateEvaluations: m.specExampleGateEvaluations ?? 0,
      lexicalSmokeGateEvaluations: m.lexicalSmokeGateEvaluations ?? 0,
      typeContractGateEvaluations: m.typeContractGateEvaluations ?? 0,
      emptyDoneRejections: m.emptyDoneRejections ?? 0,
      continuityReconcileRejections: m.continuityReconcileRejections ?? 0,
      notesDocumentationRejections: m.notesDocumentationRejections ?? 0,
      unverifiedEditRejections: m.unverifiedEditRejections ?? 0,
      reportShapeRejections: m.reportShapeRejections ?? 0,
      stuckDiagnoses: m.stuckDiagnoses ?? 0,
      falsifiedDiagnoses: m.falsifiedDiagnoses ?? 0,
      teacherDiagnoses: m.teacherDiagnoses ?? 0,
      shellCreatedFileNotes: m.shellCreatedFileNotes ?? 0,
      landingNotes: m.landingNotes ?? 0,
      landingVerifies: m.landingVerifies ?? 0,
      impactFooters: m.impactFooters ?? 0,
      familyFooters: m.familyFooters ?? 0,
      familyConventionRejections: m.familyConventionRejections ?? 0,
      crossFileUsageNotes: m.crossFileUsageNotes ?? 0,
      peerFunctionFooters: m.peerFunctionFooters ?? 0,
      autoVerifies: m.autoVerifies ?? 0,
      selfCheckRejections: m.selfCheckRejections ?? 0,
      groundingRejects: m.groundingRejects ?? 0,
      groundingStaleFiles: m.groundingStaleFiles ?? 0,
      groundingRefreshes: m.groundingRefreshes ?? 0,
      groundingRefreshFailures: m.groundingRefreshFailures ?? 0,
      groundingRefreshMs: m.groundingRefreshMs ?? 0,
      externalWorkspaceMutationEvents: m.externalWorkspaceMutationEvents ?? 0,
      externalWorkspaceMutationPaths: m.externalWorkspaceMutationPaths ?? 0,
      externalWorkspaceMutationBlockedActions: m.externalWorkspaceMutationBlockedActions ?? 0,
      queries: m.queries ?? 0,
      previewRuns: m.previewRuns ?? 0,
      previewPasses: m.previewPasses ?? 0,
      previewFailures: m.previewFailures ?? 0,
      queryBudgetBlocks: m.queryBudgetBlocks ?? 0,
      lessonHits: m.lessonHits ?? 0,
      lessonTools: Array.isArray(m.lessonTools) ? [...m.lessonTools] : [],
      progressNudges: m.progressNudges ?? 0,
      progressGateRejections: m.progressGateRejections ?? 0,
      progressGateTerminations: m.progressGateTerminations ?? 0,
      artifactVerificationNudges: m.artifactVerificationNudges ?? 0,
      artifactVerificationGateRejections: m.artifactVerificationGateRejections ?? 0,
      artifactVerificationGateTerminations: m.artifactVerificationGateTerminations ?? 0,
      maxProgresslessTurns: m.maxProgresslessTurns ?? 0,
      replaceFailures: normalizeReplaceFailures(m.replaceFailures),
      patchFailures: normalizePatchFailures(m.patchFailures),
      patchActionPolicy: normalizePatchActionPolicy(m.patchActionPolicy),
      fileOperationFailures: normalizeFileOperationFailures(m.fileOperationFailures),
      fileOperationPolicy: normalizePatchActionPolicy(m.fileOperationPolicy),
      // llama.cpp /completion does not report prompt tokens on our path — null, not a guess.
      promptTok: null,
      genTok: m.tokens ?? 0,
      totalMs: m.durationMs ?? null,
      actions: serializableCopy(m.actions ?? {}) ?? {},
    },
    finalDiff: finalDiff === null ? null : serializableCopy(finalDiff),
    graderTampering: graderTampering === null ? null : serializableCopy(graderTampering),
  };
}

function normalizeModelMetadata(model) {
  if (!model) return null;
  if (typeof model.metadata === "function") {
    try {
      const metadata = serializableCopy(model.metadata());
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        return metadata;
      }
    } catch { /* fall through to public fields */ }
  }
  return {
    endpoint: model.endpoint ?? null,
    profile: model.profileName ?? null,
    sampling: {
      temperature: model.temperature ?? null,
      act_temperature: model.actTemperature ?? null,
      top_p: model.topP ?? null,
      top_k: model.topK ?? null,
      seed: model.seed ?? null,
    },
    nPredict: model.nPredict ?? null,
    stop: Array.isArray(model.stop) ? [...model.stop] : (model.stop ?? null),
    completionIndex: model.completionIndex ?? null,
  };
}

function normalizeModelCalls(model, result) {
  if (Array.isArray(result?.modelCalls)) {
    return result.modelCalls.map((call) => serializableCopy(call)).filter(Boolean);
  }
  let calls = [];
  try {
    if (typeof model?.requestLog === "function") {
      const from = Number.isInteger(result?.modelCallStart) ? result.modelCallStart : 0;
      const to = Number.isInteger(result?.modelCallEnd) ? result.modelCallEnd : Infinity;
      calls = model.requestLog({ from, to });
    }
    else if (Array.isArray(model?.requestRecords)) calls = model.requestRecords;
  } catch { return []; }
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => serializableCopy(call)).filter(Boolean);
}

function normalizeUsageBySource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([source, usage]) => /^[a-z][a-z0-9_]*$/.test(source)
      && usage && typeof usage === "object" && !Array.isArray(usage))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, usage]) => [source, serializableCopy(usage)]));
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = [
    "requests",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheHitTokens",
    "cacheMissTokens",
    "reasoningTokens",
    "costUsd",
    "codexRequests",
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    Number.isFinite(Number(value[field])) && Number(value[field]) >= 0
      ? Number(value[field])
      : 0,
  ]));
}

function summarizeCodexThreads(calls) {
  const evidence = [];
  for (const [callIndex, call] of calls.entries()) {
    const candidates = [
      call?.response?.normalized?.codexThread,
      ...(Array.isArray(call?.attempts)
        ? call.attempts.map((attempt) => attempt?.response?.normalized?.codexThread)
        : []),
    ];
    const found = candidates.find((entry) => entry && typeof entry.threadId === "string");
    if (found) evidence.push({ ...found, callIndex });
  }
  if (evidence.length === 0) return null;
  const threadIds = [...new Set(evidence.map((entry) => entry.threadId))];
  const rebases = evidence.filter(
    (entry) => typeof entry.threadRebaseReason === "string" && entry.threadRebaseReason,
  );
  const rebaseReasons = evidence
    .map((entry) => entry.threadRebaseReason)
    .filter((value) => typeof value === "string" && value);
  const finalCallIndex = evidence.at(-1).callIndex;
  return {
    mode: evidence.some((entry) => entry.threadMode === "run") ? "run" : "ephemeral",
    calls: evidence.length,
    uniqueThreads: threadIds.length,
    reusedCalls: evidence.filter((entry) => entry.threadReused === true).length,
    rebasedCalls: rebaseReasons.length,
    terminalRebasedCalls: rebases.filter((entry) => entry.callIndex === finalCallIndex).length,
    postRebaseCalls: rebases.reduce(
      (sum, entry) => sum + evidence.filter((later) => later.callIndex > entry.callIndex).length,
      0,
    ),
    rebaseCallIndices: rebases.map((entry) => entry.callIndex + 1),
    rebaseReasons: Object.fromEntries(
      [...new Set(rebaseReasons)].sort().map((reason) => [
        reason,
        rebaseReasons.filter((value) => value === reason).length,
      ]),
    ),
  };
}

function summarizeCodexPromptDelivery(calls) {
  const evidence = [];
  for (const call of calls) {
    const candidates = [
      call?.response?.normalized?.codexPromptDelivery,
      ...(Array.isArray(call?.attempts)
        ? call.attempts.map((attempt) => attempt?.response?.normalized?.codexPromptDelivery)
        : []),
    ];
    const found = candidates.find((entry) => entry && Number.isFinite(entry.deliveredChars));
    if (found) evidence.push(found);
  }
  if (evidence.length === 0) return null;
  const canonicalChars = evidence.reduce((sum, entry) => sum + (entry.canonicalChars ?? 0), 0);
  const deliveredChars = evidence.reduce((sum, entry) => sum + (entry.deliveredChars ?? 0), 0);
  const deltaSavedRatios = evidence
    .filter((entry) => entry.mode === "delta" && entry.canonicalChars > 0)
    .map((entry) => Math.max(0, entry.savedChars ?? 0) / entry.canonicalChars);
  return {
    calls: evidence.length,
    fullCalls: evidence.filter((entry) => entry.mode === "full").length,
    deltaCalls: evidence.filter((entry) => entry.mode === "delta").length,
    fallbackCalls: evidence.filter((entry) => entry.mode === "full-fallback").length,
    rebaseCalls: evidence.filter((entry) => typeof entry.rebaseReason === "string").length,
    canonicalChars,
    deliveredChars,
    savedChars: Math.max(0, canonicalChars - deliveredChars),
    savedRatio: canonicalChars > 0
      ? Math.max(0, canonicalChars - deliveredChars) / canonicalChars
      : null,
    minDeltaSavedRatio: deltaSavedRatios.length ? Math.min(...deltaSavedRatios) : null,
    lowSavingsDeltaCalls: deltaSavedRatios.filter((ratio) => ratio < 0.2).length,
  };
}

function serializableCopy(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function modelFingerprint(metadata, modelId) {
  const stable = serializableCopy(metadata) ?? {};
  // completionIndex is resumable run state, not model identity. Including it
  // would make the same endpoint/profile fingerprint differently after every call.
  delete stable.completionIndex;
  return sha256(canonicalJson({ modelId: modelId ?? null, metadata: stable }));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function normalizeInfrastructureBlock(blocked) {
  if (!blocked || typeof blocked !== "object") return null;
  return {
    kind: blocked.kind ?? null,
    ecosystem: blocked.ecosystem ?? null,
    operation: blocked.operation ?? null,
    reason: blocked.reason ?? null,
    message: blocked.message ?? null,
  };
}

function normalizeModelFailure(failure) {
  if (!failure || typeof failure !== "object") return null;
  return {
    message: typeof failure.message === "string" ? failure.message : null,
    code: typeof failure.code === "string" ? failure.code : null,
    provider: typeof failure.provider === "string" ? failure.provider : null,
    timeoutKind: typeof failure.timeoutKind === "string" ? failure.timeoutKind : null,
    retryable: typeof failure.retryable === "boolean" ? failure.retryable : null,
  };
}

export function buildLedgerRow({ artifact, artifactPath, harnessGit = {} }) {
  requireArtifactIdentity(artifact);
  requireNonEmptyString(artifactPath, "artifactPath");
  const diff = artifact.finalDiff ?? {};
  const git = normalizeHarnessGit(
    hasHarnessFields(harnessGit) ? harnessGit : artifact.harnessGit,
  ) ?? normalizeHarnessGit({});
  return {
    schema: 1,
    runId: artifact.runId,
    stamp: artifact.stamp,
    fixture: artifact.fixture,
    status: artifact.result?.status ?? "unverified",
    pass: artifact.result?.pass ?? null,
    // Expectation-graded fixtures keep their raw public verdict here so downstream
    // analysis never loses it: `status` above is what the run scored, `publicStatus`
    // is what the verifier actually printed.
    expectation: artifact.result?.expectation ? (artifact.result.expectation.met ? "met" : "missed") : null,
    publicStatus: artifact.result?.expectation?.publicStatus ?? null,
    exitCode: artifact.result?.exitCode ?? null,
    contractStatus: artifact.result?.contract?.status ?? null,
    contractTests: artifact.result?.contract?.tests ?? null,
    contractPassed: artifact.result?.contract?.passed ?? null,
    contractFailed: artifact.result?.contract?.failed ?? null,
    contractDurationMs: artifact.result?.contract?.durationMs ?? null,
    autoPreviews: artifact.metrics?.autoPreviews ?? 0,
    artifactPath,
    modelId: artifact.modelId ?? null,
    profile: artifact.sampling?.profile ?? null,
    experimentId: artifact.experiment?.id ?? null,
    experimentArm: artifact.experiment?.arm ?? null,
    experimentRound: artifact.experiment?.round ?? null,
    experimentSequence: artifact.experiment?.sequence ?? null,
    experimentSeed: artifact.experiment?.seed ?? null,
    samplingSeed: artifact.sampling?.seed ?? null,
    turns: artifact.metrics?.turns ?? 0,
    modelRequests: artifact.metrics?.modelRequests ?? null,
    auxiliaryModelRequests: artifact.metrics?.auxiliaryModelRequests ?? null,
    modelRequestsPerTurn: artifact.metrics?.modelRequestsPerTurn ?? null,
    promptCalls: artifact.metrics?.promptChurn?.callsWithPrompt ?? 0,
    promptChars: artifact.metrics?.promptChurn?.totalChars ?? 0,
    promptCommonPrefixRatio: artifact.metrics?.promptChurn?.commonPrefixRatio ?? null,
    promptAddedSuffixChars: artifact.metrics?.promptChurn?.addedSuffixChars ?? 0,
    promptReplacedSuffixChars: artifact.metrics?.promptChurn?.replacedSuffixChars ?? 0,
    invalid: artifact.metrics?.invalid ?? 0,
    outputLimitRecoveries: artifact.metrics?.outputLimitRecoveries ?? 0,
    rejectedOutputs: artifact.rejectedOutputs?.length ?? 0,
    protocolViolations: artifact.metrics?.protocolViolations ?? 0,
    thinkPhases: artifact.metrics?.thinkPhases ?? 0,
    thinkTok: artifact.metrics?.thinkTok ?? 0,
    actionTok: artifact.metrics?.actionTok ?? 0,
    thinkTokenBudget: artifact.metrics?.thinkTokenBudget ?? null,
    rePlans: artifact.metrics?.rePlans ?? 0,
    preGateFails: artifact.metrics?.preGateFails ?? 0,
    shellCwdGuards: artifact.metrics?.shellCwdGuards ?? 0,
    workspaceAliasNormalizations: artifact.metrics?.workspaceAliasNormalizations ?? 0,
    shellReadGuards: artifact.metrics?.shellReadGuards ?? 0,
    testPipeGuards: artifact.metrics?.testPipeGuards ?? 0,
    testDigestHits: artifact.metrics?.testDigestHits ?? 0,
    repeatedFailureHints: artifact.metrics?.repeatedFailureHints ?? 0,
    outcomeCycleEvents: artifact.metrics?.outcomeCycleEvents ?? 0,
    outcomeCycleHints: artifact.metrics?.outcomeCycleHints ?? 0,
    derivedFailureContextHints: artifact.metrics?.derivedFailureContextHints ?? 0,
    lifecycleContractHints: artifact.metrics?.lifecycleContractHints ?? 0,
    lifecycleContractDoneRejections: artifact.metrics?.lifecycleContractDoneRejections ?? 0,
    completionAuditHints: artifact.metrics?.completionAuditHints ?? 0,
    lexicalContractAuditHints: artifact.metrics?.lexicalContractAuditHints ?? 0,
    stateAuditHints: artifact.metrics?.stateAuditHints ?? 0,
    stateAuditEngagements: artifact.metrics?.stateAuditEngagements ?? 0,
    stateAuditDoneDeferrals: artifact.metrics?.stateAuditDoneDeferrals ?? 0,
    stateAuditProbeDiagnostics: artifact.metrics?.stateAuditProbeDiagnostics ?? 0,
    planAuditHints: artifact.metrics?.planAuditHints ?? 0,
    stateAuditMode: artifact.metrics?.stateAuditPolicy?.mode ?? "off",
    stateAuditEnabled: Boolean(artifact.metrics?.stateAuditPolicy?.enabled),
    stateAuditReason: artifact.metrics?.stateAuditPolicy?.reason ?? null,
    capabilityHints: artifact.metrics?.capabilityHints ?? 0,
    infrastructureBlocks: artifact.metrics?.infrastructureBlocks ?? 0,
    duplicateActionRejections: artifact.metrics?.duplicateActionRejections ?? 0,
    duplicateShellRejections: artifact.metrics?.duplicateShellRejections ?? 0,
    noOpEdits: artifact.metrics?.noOpEdits ?? 0,
    repeatEscapeMasks: artifact.metrics?.repeatEscapeMasks ?? 0,
    doneRejections: artifact.metrics?.doneRejections ?? 0,
    ledgerRejections: artifact.metrics?.ledgerRejections ?? 0,
    secretAuditRejections: artifact.metrics?.secretAuditRejections ?? 0,
    evidenceGateRejections: artifact.metrics?.evidenceGateRejections ?? 0,
    previewGateRejections: artifact.metrics?.previewGateRejections ?? 0,
    environmentVerificationRuns: artifact.metrics?.environmentVerificationRuns ?? 0,
    environmentVerificationPasses: artifact.metrics?.environmentVerificationPasses ?? 0,
    environmentVerificationRejections: artifact.metrics?.environmentVerificationRejections ?? 0,
    selfCheckRejections: artifact.metrics?.selfCheckRejections ?? 0,
    groundingRejects: artifact.metrics?.groundingRejects ?? 0,
    groundingStaleFiles: artifact.metrics?.groundingStaleFiles ?? 0,
    groundingRefreshes: artifact.metrics?.groundingRefreshes ?? 0,
    groundingRefreshFailures: artifact.metrics?.groundingRefreshFailures ?? 0,
    groundingRefreshMs: artifact.metrics?.groundingRefreshMs ?? 0,
    externalWorkspaceMutationEvents: artifact.metrics?.externalWorkspaceMutationEvents ?? 0,
    externalWorkspaceMutationPaths: artifact.metrics?.externalWorkspaceMutationPaths ?? 0,
    externalWorkspaceMutationBlockedActions: artifact.metrics?.externalWorkspaceMutationBlockedActions ?? 0,
    queries: artifact.metrics?.queries ?? 0,
    previewRuns: artifact.metrics?.previewRuns ?? 0,
    previewPasses: artifact.metrics?.previewPasses ?? 0,
    previewFailures: artifact.metrics?.previewFailures ?? 0,
    queryBudgetBlocks: artifact.metrics?.queryBudgetBlocks ?? 0,
    lessonHits: artifact.metrics?.lessonHits ?? 0,
    lessonTools: Array.isArray(artifact.metrics?.lessonTools) ? [...artifact.metrics.lessonTools] : [],
    progressNudges: artifact.metrics?.progressNudges ?? 0,
    progressGateRejections: artifact.metrics?.progressGateRejections ?? 0,
    progressGateTerminations: artifact.metrics?.progressGateTerminations ?? 0,
    artifactVerificationNudges: artifact.metrics?.artifactVerificationNudges ?? 0,
    artifactVerificationGateRejections: artifact.metrics?.artifactVerificationGateRejections ?? 0,
    artifactVerificationGateTerminations: artifact.metrics?.artifactVerificationGateTerminations ?? 0,
    maxProgresslessTurns: artifact.metrics?.maxProgresslessTurns ?? 0,
    replaceFailures: artifact.metrics?.replaceFailures?.total ?? 0,
    replaceOldNotFound: artifact.metrics?.replaceFailures?.oldNotFound ?? 0,
    replaceAmbiguous: artifact.metrics?.replaceFailures?.ambiguous ?? 0,
    replaceLineStale: artifact.metrics?.replaceFailures?.lineStale ?? 0,
    patchActions: artifact.metrics?.actions?.patch ?? 0,
    patchFailures: artifact.metrics?.patchFailures?.total ?? 0,
    patchOldNotFound: artifact.metrics?.patchFailures?.oldNotFound ?? 0,
    patchAmbiguous: artifact.metrics?.patchFailures?.ambiguous ?? 0,
    patchOverlap: artifact.metrics?.patchFailures?.overlap ?? 0,
    patchActionMode: artifact.metrics?.patchActionPolicy?.mode ?? "off",
    patchActionAvailable: Boolean(artifact.metrics?.patchActionPolicy?.enabled),
    patchActionReason: artifact.metrics?.patchActionPolicy?.reason ?? null,
    deleteFileActions: artifact.metrics?.actions?.delete_file ?? 0,
    moveFileActions: artifact.metrics?.actions?.move_file ?? 0,
    fileOperationFailures: artifact.metrics?.fileOperationFailures?.total ?? 0,
    fileOperationDeleteFailures: artifact.metrics?.fileOperationFailures?.delete_file ?? 0,
    fileOperationMoveFailures: artifact.metrics?.fileOperationFailures?.move_file ?? 0,
    fileOperationMode: artifact.metrics?.fileOperationPolicy?.mode ?? "off",
    fileOperationAvailable: Boolean(artifact.metrics?.fileOperationPolicy?.enabled),
    fileOperationReason: artifact.metrics?.fileOperationPolicy?.reason ?? null,
    genTok: artifact.metrics?.genTok ?? 0,
    totalMs: artifact.metrics?.totalMs ?? null,
    diffStatus: diff.status ?? null,
    diffSha256: diff.sha256 ?? null,
    diffBytes: diff.bytes ?? null,
    diffFileCount: diff.fileCount ?? null,
    diffTruncated: diff.truncated ?? null,
    harnessGitSha: git.sha,
    harnessGitDirty: git.dirty,
    harnessGitDirtyHash: git.dirtyHash,
    harnessGitStatusSha256: git.statusSha256,
  };
}

function normalizeContractVerification(value) {
  if (!value) return null;
  return {
    status: value.status ?? "error",
    pass: Boolean(value.pass),
    tests: value.tests ?? null,
    passed: value.passed ?? null,
    failed: value.failed ?? null,
    exitCode: value.exitCode ?? null,
    signal: value.signal ?? null,
    durationMs: value.durationMs ?? null,
    detail: value.detail ?? null,
  };
}

function normalizePatchActionPolicy(raw) {
  return {
    mode: raw?.mode ?? "off",
    enabled: Boolean(raw?.enabled),
    reason: raw?.reason ?? null,
  };
}

function normalizeHarnessGit(raw = null) {
  if (!raw) return null;
  return {
    schema: raw.schema ?? 1,
    sha: raw.sha ?? null,
    dirty: raw.dirty ?? null,
    dirtyHash: raw.dirtyHash ?? null,
    statusSha256: raw.statusSha256 ?? null,
    worktreeDiffSha256: raw.worktreeDiffSha256 ?? null,
    stagedDiffSha256: raw.stagedDiffSha256 ?? null,
    untrackedSha256: raw.untrackedSha256 ?? null,
    status: Array.isArray(raw.status) ? [...raw.status] : [],
    statusTruncated: Boolean(raw.statusTruncated),
  };
}

function normalizeExperiment(raw = null) {
  if (!raw) return null;
  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    arm: raw.arm ?? null,
    round: raw.round ?? null,
    sequence: raw.sequence ?? null,
    seed: raw.seed ?? null,
  };
}

function hasHarnessFields(raw = {}) {
  return raw && Object.keys(raw).some((key) => raw[key] !== undefined);
}

function normalizeReplaceFailures(raw = {}) {
  return {
    total: raw.total ?? 0,
    oldNotFound: raw.oldNotFound ?? 0,
    ambiguous: raw.ambiguous ?? 0,
    lineStale: raw.lineStale ?? 0,
    other: raw.other ?? 0,
  };
}

function normalizePatchFailures(raw = {}) {
  return {
    total: raw.total ?? 0,
    oldNotFound: raw.oldNotFound ?? 0,
    ambiguous: raw.ambiguous ?? 0,
    overlap: raw.overlap ?? 0,
    other: raw.other ?? 0,
  };
}

function normalizeFileOperationFailures(raw = {}) {
  return {
    total: raw.total ?? 0,
    delete_file: raw.delete_file ?? 0,
    move_file: raw.move_file ?? 0,
  };
}

export function appendLedgerRow(ledgerPath, row) {
  const snapshot = serializableRecordSnapshot(row, "ledger row");
  requireLedgerRow(snapshot);
  const serialized = JSON.stringify(snapshot);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  appendLineNoFollow(ledgerPath, serialized + "\n");
  return ledgerPath;
}

function appendLineNoFollow(filePath, line) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  if (!noFollow) {
    try {
      const existing = fs.lstatSync(filePath);
      if (!existing.isFile()) {
        throw new Error(`ledger destination is not a regular file: ${filePath}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const flags = fs.constants.O_WRONLY
    | fs.constants.O_APPEND
    | fs.constants.O_CREAT
    | noFollow
    | (fs.constants.O_NONBLOCK ?? 0);
  const descriptor = fs.openSync(filePath, flags, 0o666);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`ledger destination is not a regular file: ${filePath}`);
    }
    const bytes = Buffer.from(line, "utf8");
    const written = fs.writeSync(descriptor, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new Error(`ledger append was incomplete: wrote ${written} of ${bytes.length} bytes`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Write the artifact to disk, creating parent dirs. Returns the path written.
 */
export function saveArtifact(filePath, artifact) {
  const snapshot = serializableRecordSnapshot(artifact, "artifact");
  requirePersistableArtifact(snapshot);
  return writeJsonAtomic(filePath, snapshot);
}

/**
 * Filesystem-safe timestamp, e.g. 2026-07-07T15-04-05-123Z.
 */
export function makeStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Short, collision-resistant run id from a stamp.
 */
export function makeRunId(stamp) {
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `run-${stamp}-${rand}`;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requireArtifactIdentity(artifact) {
  requireRecord(artifact, "artifact");
  requireNonEmptyString(artifact.runId, "artifact.runId");
  requireNonEmptyString(artifact.stamp, "artifact.stamp");
}

function requirePersistableArtifact(artifact) {
  requireArtifactIdentity(artifact);
  if (!Number.isInteger(artifact.schema) || artifact.schema < 1) {
    throw new TypeError("artifact.schema must be a positive integer");
  }
  if (artifact.kind !== "bantam-run") {
    throw new TypeError('artifact.kind must be "bantam-run"');
  }
  requireOptionalArray(artifact.turns, "artifact.turns");
  if (!Array.isArray(artifact.turns)) {
    throw new TypeError("artifact.turns must be an array");
  }
  requireOptionalArray(artifact.rejectedOutputs, "artifact.rejectedOutputs");
  if (!Array.isArray(artifact.rejectedOutputs)) {
    throw new TypeError("artifact.rejectedOutputs must be an array");
  }
  requireOptionalArray(artifact.modelCalls, "artifact.modelCalls");
  if (artifact.modelCalls !== undefined && !Array.isArray(artifact.modelCalls)) {
    throw new TypeError("artifact.modelCalls must be an array when provided");
  }
  requireRecord(artifact.result, "artifact.result");
  requireNonEmptyString(artifact.result.status, "artifact.result.status");
  requireRecord(artifact.metrics, "artifact.metrics");
  requireAttachments(artifact.attachments);
}

function requireAttachments(value) {
  if (value === undefined) return;
  requireRecord(value, "artifact.attachments");
  if (value.schema !== 1) throw new TypeError("artifact.attachments.schema must be 1");
  if (!["captured", "partial", "none", "error"].includes(value.status)) {
    throw new TypeError("artifact.attachments.status is invalid");
  }
  requireOptionalArray(value.files, "artifact.attachments.files");
  requireOptionalArray(value.omitted, "artifact.attachments.omitted");
  if (!Array.isArray(value.files) || !Array.isArray(value.omitted)) {
    throw new TypeError("artifact attachment files and omissions must be arrays");
  }
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) {
    throw new TypeError("artifact.attachments.totalBytes must be a nonnegative safe integer");
  }
  for (const [index, file] of value.files.entries()) {
    requireRecord(file, `artifact.attachments.files[${index}]`);
    requireSafeRelativePath(file.sourcePath, `artifact attachment source path ${index}`);
    requireSafeRelativePath(file.path, `artifact attachment path ${index}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new TypeError(`artifact attachment bytes ${index} must be a nonnegative safe integer`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 ?? ""))) {
      throw new TypeError(`artifact attachment sha256 ${index} is invalid`);
    }
  }
  if (value.indexPath !== null && value.indexPath !== undefined) {
    requireSafeRelativePath(value.indexPath, "artifact attachment index path");
  }
}

function requireSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty relative path`);
  }
  const normalized = value.split("\\").join("/");
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new TypeError(`${label} must not contain traversal or empty segments`);
  }
}

function requireLedgerRow(row) {
  requireRecord(row, "ledger row");
  if (row.schema !== 1) {
    throw new TypeError("ledger row.schema must be 1");
  }
  requireNonEmptyString(row.runId, "ledger row.runId");
  requireNonEmptyString(row.stamp, "ledger row.stamp");
  requireNonEmptyString(row.status, "ledger row.status");
  requireNonEmptyString(row.artifactPath, "ledger row.artifactPath");
}

function serializableRecordSnapshot(value, label) {
  requireRecord(value, label);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (typeof serialized !== "string") {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  const snapshot = JSON.parse(serialized);
  requireRecord(snapshot, label);
  return snapshot;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireOptionalArray(value, label) {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new TypeError(`${label} must be an array when provided`);
  }
}
