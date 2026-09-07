// The Bantam agent loop.
//
//   build prompt -> constrained completion -> parse+validate action
//     -> execute in workspace -> append observation -> repeat until done
//
// Invalid model output does not crash the loop; it becomes a repair turn (the
// model is told what was wrong and tries again). An optional hidden
// verificationScript grades the run at the end against ground truth the model
// never sees — this is what makes a Bantam run objectively pass/fail.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runWorkspaceProbe } from "./workspace-probe.js";
import { formatEdgeSmoke } from "./edge-smoke.js";
import { formatSpecExamples } from "./spec-examples.js";
import { formatLexicalSmoke } from "./logic/lexical-smoke.js";
import { formatTypeContractSmoke } from "./logic/type-contract-smoke.js";
import { numericContractWitness, formatNumericContractWitness } from "./logic/numeric-contract-witness.js";
import { GATE_ENGAGEMENT_METRIC } from "./logic/gate-engagement.js";
import { ModelClient } from "./model.js";
import { acquireModelLock } from "./model-lock.js";
import { frameInjection } from "./logic/attendant.js";
import { Executor, runShellProcess, withNodeTestTimeout, START_WINDOW } from "./executor.js";
import { isGeneratedPath, isTestPath, snapshotTree } from "./scope-guard.js";
import { isTestCommand, isDeliverableRun, isInlineEvalProbe } from "./logic/deliverable-signals.js";
import { importDontRetypeSteer, greenfieldBuildShapeNote, selfInverseProbeSteer, unicodeUnitGauge, shipTheGeneratorSteer, enumerateContractNote } from "./logic/probe-discipline.js";
import { shellContainsExactCommandSegment } from "./shell-lex.js";
import { verificationEvidence, verificationReceipt, shellExecutionReceipt } from "./verification-evidence.js";
import { latestVerificationRecovery, verificationRecoveryNote, latestUnresolvedFocusedFailure, focusedFailureReminder } from "./verification-recovery.js";
import { terminalClosureAllowance, terminalClosureEligible, terminalClosureNote } from "./terminal-closure.js";
import { createTestProvenance } from "./test-provenance.js";
import { priorDiagnosisFollowup } from "./diagnosis-evidence.js";
import { contractStateAuditEnabled, collectionContractAuditApplies, collectContractAuditSources, runContractStateAudit, formatContractStateAudit } from "./contract-state-audit.js";
import { pendingContractAudit, currentFocusedAuditWitness, contractAuditRecoveryNote, isFocusedAuditCommand, VERIFICATION_RECEIPTS_SCHEMA } from "./contract-audit-recovery.js";
import { contractAuditPhaseState, contractAuditDecisionContext } from "./contract-audit-phase.js";
import { compoundAuditCleanupRefusal } from "./contract-audit-workflow.js";
import { protectedAuditWitnessCleanupRefusal } from "./contract-audit-witness-retention.js";
import { currentConfiguredFailure, verificationFailureContext } from "./verification-failure-context.js";
import { collectObjectConstructionFacts, formatObjectConstructionFacts } from "./object-construction-facts.js";
import { directNodeCheckScript, nodeCheckSelfSpawnRefusal } from "./node-check-self-spawn.js";
import { runContractAssertionStation, formatContractAssertionStation } from "./contract-assertion-station.js";
import { deriveCliContract } from "./contract-cli-assertion-spec.js";
import { runContractCliStation, formatContractCliStation } from "./contract-cli-station.js";
import { cliVerificationPassed, cliVerificationDecisionContext } from "./contract-cli-verification.js";
import { collectNodeCliRoutingFacts, formatNodeCliRoutingFacts } from "./node-cli-routing-facts.js";
import { composeInstructionGuards } from "./instruction-guard.js";
import { symbolsIn } from "./collateral.js";
import { impactFooter, familyFooter, familyFindings, familyBlocks, constantTableFooter, crossScopeUsageFooter, peerFunctionFooter, trimSiteList } from "./edit-context.js";
import { detectSiblings } from "./logic/completeness-critic.js";
import { continuityAnchors, renderContinuityAnchors } from "./logic/continuity-anchors.js";
import { formatFailingTestFocus, workspaceTestReader, parseTestCounts, parseTestFailures, renderFailingTests, extractTestDiagnosticContext, diagnosedImplementationPath, diagnoseFailingTest } from "./logic/test-focus.js";
import { SELF_TEACHER_PERSONA, teacherDue, teacherFromEnv, askTeacher } from "./teacher-assist.js";
import { buildPrompt, contextUpdatePromptText, slimSuccessfulShellReplay, SUPERSEDED_EDIT } from "./prompt.js";
import { createContextUpdate, createActionContractUpdate } from "./context-updates.js";
import { requiredOutputPaths } from "./logic/missing-outputs.js";
import { deliverableNotice } from "./logic/deliverable-watch.js";
import { providedOracleNotice } from "./logic/provided-oracle-watch.js";
import { thinkBudget } from "./logic/think-budget.js";
import { FROZEN_STABLE_END } from "./prompt.js";
import { wallBudgetLine } from "./logic/wall-budget.js";
import { rewriteGate } from "./logic/rewrite-gate.js";
import { CHATML_TEMPLATE } from "./profiles.js";
import { TurnAnalyzer, ImprovementLog } from "./self-improve.js";
import {
  actionName,
  completedActionOutcome,
  createIntegratedPlanner,
} from "./action-sequence-integration.js";
import { createObservationParser } from "./observation-parser.js";
import { WorkspaceCoherenceTracker } from "./workspace-coherence.js";
import {
  visualAltCoverageEnabled,
  visualAltCoverageGap,
  visualAltCoverageHint,
} from "./visual-alt-coverage.js";

// History-slimming (slimReplayedAction) collapses a replayed edit body to SUPERSEDED_EDIT in the
// prompt when the file is shown live in <open_files>. A small model can misread that placeholder as
// "the content I wrote" and copy it verbatim into a NEW edit — overwriting real code with the
// placeholder string (a guaranteed SyntaxError that silently destroys the file). No legitimate code
// contains this exact harness string, so an edit whose body includes it is always this echo. Reject
// it before it executes and point the model back to <open_files>.
function editEchoesPlaceholder(action) {
  if (!isEditAction(action)) return null;
  const bodies = [];
  if (action.a === "write_file") bodies.push(action.content);
  else if (action.a === "write_batch" && Array.isArray(action.files)) {
    for (const file of action.files) bodies.push(file?.content);
  }
  else if (action.a === "replace") bodies.push(action.new, action.old);
  else if (action.a === "patch" && Array.isArray(action.edits)) {
    for (const e of action.edits) bodies.push(e?.new, e?.old);
  }
  if (!bodies.some((b) => typeof b === "string" && b.includes(SUPERSEDED_EDIT))) return null;
  return `[rejected] That edit's body is the "${SUPERSEDED_EDIT}" placeholder from your slimmed history — not real code. Your earlier edit's content was collapsed in the history to save space; the CURRENT file contents are shown in <open_files> above. Copy the actual code from there. Never write the placeholder text into a file.`;
}

// A whole-file write whose content has NO real newlines but is riddled with literal backslash-n
// sequences is a double-escaped JSON string (the model emitted \\n where it meant \n) — a source file
// never legitimately has that shape. Observed on a tight-budget run: the generic "[pre-gate] syntax
// error" named the symptom, and the model spent its remaining 13 turns doing byte-level forensics
// (cat -A, xxd, repr dumps) to rediscover what the harness could see at the write. Name the disease
// precisely instead. Bounded once per path: if the model re-emits the same shape after being told,
// it goes through (a deliberate one-line file with escaped newlines stays writable).
function editDoubleEscapesNewlines(action) {
  const candidates = action?.a === "write_file"
    ? [{ p: action.p, content: action.content }]
    : action?.a === "write_batch" && Array.isArray(action.files)
      ? action.files
      : [];
  for (const candidate of candidates) {
    const c = candidate?.content;
    if (typeof c !== "string" || c.length < 120 || c.includes("\n")) continue;
    const literals = (c.match(/\\n/g) || []).length;
    if (literals < 3) continue;
    return `[rejected] The whole-file content for ${candidate.p} is one single line of ${c.length} characters containing ${literals} literal backslash-n sequences and ZERO real newlines — your JSON string escaping is doubled (you emitted \\\\n where you meant a newline). No file in this action was written. Re-emit the write with the same code but ACTUAL newlines in the JSON string (single \\n escapes), and it will be written correctly.`;
  }
  return null;
}

const VISUAL_ALT_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte"]);

function visualAltSnapshot(workspace, candidates) {
  const rows = [];
  for (const relative of [...new Set(candidates)].sort()) {
    if (!VISUAL_ALT_SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    try {
      const source = fs.readFileSync(path.resolve(workspace, relative), "utf8");
      const alt = [...source.matchAll(/\balt\s*=\s*(["'])(.*?)\1/gis)]
        .map((match) => match[2].replace(/\s+/g, " ").trim());
      if (alt.length) rows.push([relative, alt]);
    } catch {
      // A path may be renamed or removed during remediation; its absence is
      // represented by the missing row in the resulting snapshot.
    }
  }
  return JSON.stringify(rows);
}
import { ACTION_GRAMMAR, ACTION_JSON_SCHEMA, actionGrammar, actionJsonSchema } from "./grammar.js";
import {
  ALL_ACTION_VERBS,
  actionPromptMenuLine,
  enabledActionDefinitions,
  FILE_OPS_FEATURE,
  PATCH_ACTION_FEATURE,
  WRITE_BATCH_FEATURE,
  LINE_EDIT_FEATURE,
  PROBE_ACTION_FEATURE,
} from "./action-protocol.js";
import { decidePatchAction } from "./patch-policy.js";
import { decideFileOperations } from "./file-op-policy.js";
import { parseAction } from "./actions.js";
import { editMadeNoChange, editPaths, editSucceeded, isEditAction, isSourcePath, shellWritesSourceFile, turnEditApplied } from "./edit-actions.js";
import { namedDeliverables, assessDeliverable, createDeliverableState } from "./deliverable.js";
import { assessScaffold, createScaffoldState, workspaceOracleExists } from "./scaffold-gate.js";
import { assessBugStall, createBugStallState } from "./bug-stall.js";
import { assessScriptChurn, createChurnState } from "./script-churn.js";
import { assessBulkEdit, createBulkEditState } from "./bulk-edit-gate.js";
import { degenerateRepairMessage, degenerateTail } from "./logic/degenerate-output.js";
import { shellSyntaxHint } from "./logic/shell-syntax-guard.js";
import { blastRadiusNote, dependentsOf } from "./logic/blast-radius.js";
import { compactActionReasoning, deriveThinkPrefills, shouldThink } from "./thinking.js";
import { requirementChecklistEnabled } from "./requirement-checklist.js";
import { loadLibrary, retrieveSkills, formatSkills, distillSkill, saveSkill, promotePlanToSkill } from "./skills.js";
import { makePlan, formatPlan, isStuck, rePlan } from "./plan.js";
import { staticCheck } from "./pregate.js";
import { OutcomeCycleTracker, failedEditPath, repeatedFailureDiagnostic, repeatedEditFailureDiagnostic, repeatedRefusedEditDiagnostic, missingCapabilityHint } from "./failure-diagnostics.js";
import { deriveRepeatedFailureContext } from "./logic/derived-failure-context.js";
import {
  formatLifecycleContractViolations,
  lifecycleContractViolations,
} from "./logic/lifecycle-contract-logic.js";
import {
  completionAuditEnabled,
  completionAuditHint,
  completionAuditReanchor,
  lexicalContractAuditEnabled,
  LEXICAL_CONTRACT_AUDIT_MARKER,
  visualCompletionAuditEnabled,
  VISUAL_ALT_AUDIT_MARKER,
  extractMissingEnvironmentVariables,
  stateAuditEngagement,
  stateAuditProbeDiagnostic,
  stateAuditProbePassed,
  stateAuditDeferral,
  STATE_AUDIT_MARKER,
  taskExplicitSpecDocumentPaths,
  taskRequiresVisualAltAudit,
} from "./completion-audit.js";
import { decideStateAudit } from "./state-audit-policy.js";
import { decidePlanAudit, repositoryDocumentContractCue } from "./plan-audit-policy.js";
import { decideSeamSteer, SEAM_STEER_TIP } from "./seam-steer.js";
import { scaledReconLimit, scaledProgressNudgeAfter } from "./recon-budget.js";
import { ReadLedger } from "./read-ledger.js";
import { budgetTurns } from "./history-budget.js";
import { extractLoci, renderLoci, isUnbalanced, renderEditRegion } from "./failure-locus.js";
import { deliverableCommand, invokesCommand, smokeNudge } from "./smoke-run.js";
import { checkEditedApi } from "./api-check.js";
import { sourceFileCount } from "./logic/repomap.js";
import { findStateAuditRisks, formatStateAuditRisks } from "./state-audit-risk.js";
import { forgetOpenFile, noteOpenFile, renderOpenFiles } from "./open-files.js";
import { evaluateDoneGates } from "./done-gates.js";
import { unresolvedRunFailure } from "./logic/evidence-guard.js";
import { verificationVerdict } from "./done-guard.js";
import { taskRequiresVisualPreview } from "./logic/preview-evidence.js";
import { deliveryFor, BLOCK, WARN } from "./gate-policy.js";
import { detectSpecGap, formatSpecGap } from "./logic/spec-gap-detector.js";
import { workspaceExports } from "./logic/workspace-exports.js";
import { promptVersion } from "./prompt-rules.js";
import { asyncAssertionGuard } from "./async-test-guard.js";
import { immutableViolations } from "./logic/self-check.js";
import { buildGrounding, codeMap, groundAction, refreshGrounding } from "./logic/grounding.js";
import { scopedVerifyPlan } from "./logic/scoped-verify.js";
import { buildToolRegistry, historyTool } from "./logic/tools.js";
import { recordTurns, repositoryQueryTool, stateAsOf } from "./logic/runlog.js";
import { deriveExecutionStateShadow } from "./logic/execution-state-shadow.js";
import {
  deriveSourceProvenanceObligation,
  sourceProvenanceGateRejection,
} from "./logic/source-provenance.js";
import { evaluateSearchStrategyProposal } from "./logic/search-strategy.js";
import { ContextAuditSentinel } from "./logic/context-audit.js";
import { VerifyCadenceSentinel } from "./logic/verify-cadence.js";
import { SeeYourWorkSentinel } from "./logic/see-your-work.js";
import { RepourSentinel } from "./logic/repour.js";
import { ContractArbitrationPin } from "./logic/contract-arbitration.js";
import { WalledGardenGauge } from "./logic/walled-garden.js";
import { taskNamedSourcePaths, untouchedNamedPaths } from "./logic/task-context.js";
import { panelRedirectReadTargets } from "./panel-read-redirect.js";
import {
  artifactVerificationGateRejection,
  classifyProgress,
  documentArtifactReviewGaps,
  documentArtifactReviewHasGaps,
  documentArtifactReviewPaths,
  extractTaskOutputPaths,
  formatDocumentArtifactReviewContext,
  formatArtifactVerificationGateTermination,
  formatArtifactVerificationNudge,
  formatProgressNudge,
  isArtifactPath,
  isDocumentArtifactPath,
  isVerificationQueryAction,
  normalizeDocumentArtifactReviewAction,
  progressGateFor,
  shouldForceDraftEdit,
  shouldNudgeProgress,
  snapshotWorkspaceFiles,
  workspaceFileChanges,
} from "./progress-awareness.js";
import { RepetitionGuard } from "./repetition.js";
import { assessThroughput, createThroughputAndonState } from "./throughput-andon.js";
import { QueryProgressBudget } from "./query-budget.js";
import { normalizeWorkspaceAction } from "./workspace-alias.js";
import { compileContextPacket } from "./context-packet.js";
import { composeExcludeVerbs } from "./turn-mask.js";
import {
  formatPreviewFailureReanchor,
  notePreviewFailureEdit,
  refreshPreviewFailureSequence,
} from "./preview-failure-sequence.js";

// The per-turn grammar masks (WRAP_UP_MASK, DOCUMENT_REVISION_MASK, DOCUMENT_REVIEW_MASK) and the
// pure exclusion-set composition live in turn-mask.js so the composed set is unit-testable in
// isolation — the masks overlap on a single turn, and a composed set silently re-excluded a verb a
// document-only protocol required (Task-3 mask-composition bug). read_file appears in WRAP_UP_MASK but
// is deliberately absent from the two document masks; composeExcludeVerbs enforces that exemption last.
// Name the verbs that REMAIN, not only the ones that don't: the owed-work run
// (chat r0 @ 2026-08-17T22:47) hit this mask mid-build and wrapped up claiming
// "I'm blocked from writing files this turn" — write_file/replace were
// available the whole time (WRAP_UP_MASK excludes only the recon verbs), and
// the run ended with a plan instead of the README it could have written.
const WRAP_UP_NOTE = "[wrap up] You have gathered enough context — reading, shell, and query are disabled now, but `write_file`, `replace`, `done`, and `respond` all remain AVAILABLE. If the task asks you to build, fix, or document something, do it NOW from what you have already seen — write the file, make the edit — then finish with done. If it was a question, answer with `respond`. Do not say you need to look at more files, and never claim you cannot write files: you can.";
// Autonomous (eval/benchmark) analog: a build task has no user to answer — the model must EDIT. Used
// when the autonomous force-edit mask fires after too many progressless recon turns.
const AUTO_EDIT_NOTE = "[commit] You have investigated enough — reading and shell are now disabled. Write your first real implementation NOW with write_file or replace, using the current file shown in <open_files> below. A rough first version is progress: make the edit, then run the tests and iterate on the failures. Do NOT respond with a plan or say you need to read more.";
// Extension trajectory renders no <open_files> panel; the model's own reads in
// history are the source of truth, so the commit nudge points there instead.
const AUTO_EDIT_NOTE_EXTENSION = "[commit] You have investigated enough — reading and shell are now disabled. Write your first real implementation NOW with write_file or replace, using the file contents already shown in your reads above. A rough first version is progress: make the edit, then run the tests and iterate on the failures. Do NOT respond with a plan or say you need to read more.";
// Source-code extensions. A shell command that rewrites one of these (and isn't touching generated
// output) is a real code edit the completion gates must account for — see the shell-mutation guard.
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql)$/i;
// verify_red done-gate: red bounces before a done is accepted as-is. Three gives
// a model that keeps insisting two more looks at the failing output; past that,
// bouncing only burns the remaining turns on a claim the grade will refute anyway.
const VERIFY_DONE_GATE_MAX = 3;
// Total automatic restores allowed in one run, regardless of how many times the
// best snapshot is retaken. tb5 (2026-08-16,
// .bantam/runs/2026-08-16T16-58-16-359Z.json) took four: the baseline suite was
// FULLY green, so every intermediate state of a multi-edit change counted as a
// regression, and each new passing test the model added raised bestPassed and
// reset the per-snapshot stand-down. The model noticed — "the auto-verify has
// been reverting my changes" — and spent its endgame re-reading a file the
// harness kept rewriting underneath it.
const RUN_REVERT_CEILING = 3;

const DIAGNOSTIC_IMPL_MAX_FILES = 3;
const DIAGNOSTIC_IMPL_MAX_FILE_BYTES = 5000;
const DIAGNOSTIC_IMPL_MAX_TOTAL_BYTES = 12000;
const DIAGNOSTIC_DOC_RE = /\.(?:md|mdx|rst|adoc|txt)$/i;

// Whole-repository maps pay for themselves on comprehension and feature-ideation
// questions, but are needless latency on a bounded fix/build request. Keep this
// classifier deliberately narrow: a hypothetical "what feature could we add?"
// is analysis, while an imperative "add/build/fix ..." remains the ordinary
// implementation path.
export function shouldSeedRepositoryBrief(task) {
  // The interactive frontend prepends prior session requests as context. They
  // must not vote on routing the current request: a past architecture question
  // cannot turn today's parser fix into a map task (and vice versa).
  const raw = String(task ?? "");
  const requestMarkers = [...raw.matchAll(/(?:^|\n)New request:\s*/g)];
  const current = requestMarkers.length
    ? raw.slice(requestMarkers.at(-1).index + requestMarkers.at(-1)[0].length)
    : raw;
  const text = current.replace(/\s+/g, " ").trim();
  if (!text) return false;

  const featureIdeation = [
    /\b(?:what|which)\b.{0,120}\b(?:next|new|big|major|best|highest[- ]impact)\b.{0,80}\b(?:feature|capabilit(?:y|ies)|improvement|upgrade)s?\b/i,
    /\b(?:what|which)\b.{0,100}\b(?:feature|capabilit(?:y|ies)|improvement|upgrade)s?\b.{0,100}\b(?:could|should|would|might)\b.{0,40}\b(?:add|build|pursue|make|implement)\b/i,
    /\b(?:suggest|recommend|identify|propose|brainstorm)\b.{0,100}\b(?:feature|capabilit(?:y|ies)|improvement|upgrade)s?\b/i,
  ].some((pattern) => pattern.test(text));
  if (featureIdeation) return true;

  const repositorySubject = /\b(?:repo(?:sitory)?|codebase|architecture|project structure|module structure|startup flow|control flow|entrypoints?|(?:your|our|the|this)\s+code)\b/i.test(text);
  const comprehension = /\b(?:understand|explain|analy[sz]e|assess|review|study|explore|inspect|map|break down|take (?:a )?look|look (?:at|through|over))\b/i.test(text);
  const architectureQuestion = /\b(?:what|how|where|which|why)\b.{0,120}\b(?:architecture|structure|modules?|entrypoints?|startup flow|control flow|design)\b/i.test(text);
  if (!repositorySubject || (!comprehension && !architectureQuestion)) return false;

  const imperativeMutation = [
    /^(?:please\s+)?(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)\b/i,
    /\b(?:please|can you|could you|i want you to|go ahead and|now)\s+(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)\b/i,
    /\b(?:and|then)\s+(?:then\s+)?(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)\b/i,
  ].some((pattern) => pattern.test(text));
  return !imperativeMutation;
}

/**
 * Does the CURRENT request ask for a change or a bug fix (vs an answer)?
 *
 * Diagnosis IS reconnaissance: the TILDE iOS replay localized a real bug to
 * exact line ranges and was then wrap-up-masked at a 14-recon streak — turn 15
 * of a 60-turn budget — and spent its forced respond asking permission to keep
 * reading (chat r0 @ 2026-08-17, tilde). The recon-streak guard exists for
 * answer-shaped asks that spiral; change-shaped asks get double the streak
 * allowance, with the turn budget still the hard ceiling.
 */
export function isChangeShapedRequest(task) {
  const raw = String(task ?? "");
  const markers = [...raw.matchAll(/(?:^|\n)New request:\s*/g)];
  const current = markers.length ? raw.slice(markers.at(-1).index + markers.at(-1)[0].length) : raw;
  const text = current.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const imperative = [
    /^(?:please\s+)?(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)\b/i,
    /\b(?:please|can you|could you|i want you to|go ahead and|now)\s+(?:build|implement|create|add|fix|change|modify|update|refactor|rewrite|remove|delete|rename|wire|integrate|ship|write|patch)\b/i,
  ].some((pattern) => pattern.test(text));
  // A bug report is an implicit fix request even with no imperative verb:
  // "When I try to delete a book ... I don't see a confirmation popup and
  // can't delete" names a behavior and its failure, not a question.
  const bugReport = /\b(?:when|if|after|every time)\b.{0,160}\b(?:doesn'?t|does not|can'?t|cannot|won'?t|isn'?t|fails?|broken|nothing happens|no longer)\b/i.test(text)
    || /\b(?:bug|broken|regression|stopped working|not working)\b/i.test(text);
  return imperative || bugReport;
}

// The steer for an autonomous respond. Card 20 (ledgerd): sol opened with
// "I can't inspect or modify the workspace in this session" — a FALSE belief
// about access — and the base steer, which says what to do but not that it is
// possible, bounced off; the next turn was done("Blocked:") on an untouched
// tree. When the respond text claims inability, rebut the belief by name
// before repeating the instruction.
export function implementationResponseObservation(text = "") {
  const base = "[implementation-response] This is an autonomous implementation task, so there is no user to answer with `respond`. Do not describe a bug, plan, or next step: make the required edit now, run the configured verification after your latest edit, then emit `done` only when the implementation is complete.";
  if (/\b(?:can['’]?t|cannot|unable to|no way to|not able to)\b[^.!?]{0,60}\b(?:inspect|read|modify|edit|access|change|run|execute|see)\b/i.test(String(text))) {
    return base + " You DO have workspace access: the Workspace section of your prompt is the real tree, and your actions — inspect, write_file, replace, shell — ARE that access; no other channel is coming. Emit an inspect action now and the file contents will be in your next observation.";
  }
  return base;
}

export async function runAgent(options = {}) {
  const model = options.model ?? new ModelClient();
  // The local model serves one slot; concurrent runs thrash its KV cache into
  // pure re-prefill. Hold the endpoint's single-flight lock for the whole run
  // (see src/model-lock.js). Remote/API endpoints return null and never wait.
  const lock = await acquireModelLock({
    endpoint: model.apiMode ? null : model.endpoint,
    onWait: (info) => options.onEvent?.({
      type: "model_lock_wait",
      holderPid: info.holderPid,
      waitedMs: info.heldForMs,
    }),
  });
  const runToken = model.beginAgentRun?.() ?? null;
  try {
    return await runAgentCore({ ...options, model });
  } finally {
    await model.endAgentRun?.(runToken);
    lock?.release();
  }
}

async function runAgentCore({
  task,
  workspace,
  model = new ModelClient(),
  maxTurns = 30,
  terminalClosureTurns = process.env.BANTAM_TERMINAL_CLOSURE === "1" ? 1 : 0,
  maxInvalidPerTurn = 3,
  verificationScript = null,
  profileText = null,   // standing operator preferences (see src/operator-profile.js)
  // Evaluators grade the final tree unconditionally. Interactive callers can
  // select after_edit so questions do not pay for a project-wide verifier.
  verificationPolicy = "always", // "always" | "after_edit"
  verificationTimeoutMs = positiveInt(process.env.BANTAM_VERIFY_TIMEOUT_MS, 120000),
  // Re-run a passing terminal verify once to catch a flaky/nondeterministic green (off by default —
  // it doubles the passing-verify cost; enable with BANTAM_FLAKY_VERIFY=1 on flaky-prone suites).
  flakyVerify = envTruthy(process.env.BANTAM_FLAKY_VERIFY),
  // Prompt trajectory. "rebuild" reassembles volatile sections every turn.
  // "extension" makes each prompt a byte-level extension of the previous one —
  // frozen head, append-only immutable history, no volatile tail — so a local
  // llama.cpp slot (including hybrid-attention models, which restore saved
  // checkpoints rather than rewinding to arbitrary prefixes) reuses nearly the
  // entire prior state each call. Changing guidance folds into the newest
  // observation; the open-files panel is not rendered. Unset means "default by
  // transport" — resolved against the model client below.
  promptTrajectory = process.env.BANTAM_PROMPT_TRAJECTORY || null,
  // Extension-mode remedy for the think-rail collapse measured on Qwen 3.8
  // (2026-08-14): replaying the profile's empty closed think block on every
  // historical assistant turn teaches the model in context that turns here do
  // not reason (12 of 13 phase-1 completions returned empty in the failing
  // dependency-scheduler run). With this flag, extension-mode assistant turns
  // render bare — the shape the gemma profile already uses for prior turns —
  // and the think rail still derives from the profile's standard prefill and
  // seals real reasoning. Default-on for extension mode per the preregistered
  // A/B of 2026-08-14 (bare 6/9 vs control 4/9; think restored in 9/9 runs,
  // empty think completions 29 -> 0):
  // docs/superpowers/reports/2026-08-14-extension-bare-history-results.md
  // BANTAM_EXTENSION_BARE_HISTORY=0 restores the closed-think history form.
  extensionBareHistory = envTruthy(process.env.BANTAM_EXTENSION_BARE_HISTORY || "1"),
  // After an edit, run just the tests that edit could affect and feed the trusted result back —
  // scaffolds verification for a small model that might not run tests itself. Off by default (runs
  // tests each edit turn); enable with BANTAM_SCOPED_VERIFY=1. Needs grounding for the impact graph.
  scopedVerify = envTruthy(process.env.BANTAM_SCOPED_VERIFY),
  // Blind-edit spiral breaker: after this many consecutive successful edits with NO test/verify run in
  // between, the harness runs the configured verify itself and feeds the real result back. Targets the
  // observed failure where a small model runs its tests once, then edits blindly until the turn cap.
  // Promoted to default-on (4): a held-out async A/B moved BANTAM from never reaching a green public
  // suite (baseline) to converging whenever it fired, with zero cost on tasks the model tests itself on
  // (it never triggers there — self-testing resets the streak). `BANTAM_AUTOVERIFY_BLIND_EDITS=0` off.
  autoVerifyBlindEdits = thresholdInt(process.env.BANTAM_AUTOVERIFY_BLIND_EDITS, 4),
  // Same breaker, probe-shaped trigger: N consecutive inline-eval probes
  // (`python -c`, `node -e`) with no suite/deliverable run in between.
  // BANTAM_AUTOVERIFY_PROBES=0 disables.
  autoVerifyProbes = thresholdInt(process.env.BANTAM_AUTOVERIFY_PROBES, 6),
  // Same breaker, staleness-shaped trigger: the blind-edit streak counts only
  // CONSECUTIVE edits, so a read-heavy spiral evades it — the model edits a few
  // times then re-reads and reasons for dozens of turns, never verifying (observed
  // swb3-migreduce, 2026-07-17: 6 edits over 50 turns, ~44 spent reading, one
  // auto-verify total, a correct fix reached only at the cap and never landed).
  // This fires when unverified edits exist AND this many turns have elapsed since
  // the last verification, regardless of what filled them. BANTAM_AUTOVERIFY_STALE_TURNS=0 off.
  autoVerifyStaleTurns = thresholdInt(process.env.BANTAM_AUTOVERIFY_STALE_TURNS, 8),
  // Explicit executor controls make integration tests hermetic and let callers
  // choose the already-confined host of an outer sandbox instead of accidentally
  // attempting Docker-inside-Docker.
  shellSandbox = undefined,
  shellNetwork = undefined,
  onNetRequest = null,        // interactive net-access approval hook (executor.js)
  dockerImage = undefined,
  readOnlyWorkspacePaths = null,
  verificationWorkspaceReadOnly = envTruthy(process.env.BANTAM_VERIFY_WORKSPACE_READ_ONLY),
  shellEnvOverrides = null,
  // Subprocess dependency injection for embedders/tests. The same runner sees
  // implementation shells and harness-owned verifiers, while their mount
  // policies remain distinct.
  shellProcessRunner = undefined,
  // Sharp test feedback (default on): when a test run shows failures, extract the failing test's
  // source + the exact expected-vs-actual and steer the model to fix THAT test, instead of leaving
  // it to find the signal in a wall of raw TAP. Pure feedback (no extra run) — set 0/false to disable.
  testFocus = process.env.BANTAM_TEST_FOCUS !== "0",
  // Regression guard (default on): track the best-passing version of the edited files, and when the
  // model SEVERELY breaks its own working code (drops several tests from a strong base), restore that
  // best version and steer it to try a different fix — the variance-killer for runs that reach a
  // green-ish state then thrash backward and never recover. BANTAM_REGRESSION_GUARD=0 disables.
  regressionGuard = process.env.BANTAM_REGRESSION_GUARD !== "0",
  // Count an exact baseline verifier embedded as one standalone segment of a
  // broader probe as comparable evidence. Default-on, explicit rollback.
  embeddedBaselineScope = process.env.BANTAM_EMBEDDED_BASELINE_SCOPE !== "0",
  // Experimental: omit duplicated bodies of long successful inline shell
  // probes from later model prompts. Raw run evidence remains exact.
  successfulShellReplaySlim = envTruthy(process.env.BANTAM_SUCCESSFUL_SHELL_REPLAY_SLIM),
  // Stuck-test diagnosis (default on): when the SAME test keeps failing despite repeated focused
  // feedback (sharp feedback exhausted → a plateau), spawn a focused LLM reasoning call on just that
  // test + the current code to decompose the hard sub-step, and inject the diagnosis. 0 disables.
  diagnoseStuckTests = process.env.BANTAM_DIAGNOSE_STUCK !== "0",
  diagnoseAfter = positiveInt(process.env.BANTAM_DIAGNOSE_AFTER, 3),
  // Teacher-assist escalation: when self-diagnosis has already fired and a test is STILL
  // stuck, hand a stronger model the test+function for a root cause. OFF unless a teacher
  // is configured (BANTAM_TEACHER=1). Fires later than diagnoseAfter — self-diagnosis first,
  // teacher only when the residual is model reasoning the 27B can't supply itself.
  teacherAssist = teacherFromEnv(process.env),
  teacherAfter = positiveInt(process.env.BANTAM_TEACHER_AFTER, diagnoseAfter + 2),
  teacherStuckTurns = positiveInt(process.env.BANTAM_TEACHER_STUCK_TURNS, 24),
  thinkMode = "off",       // "off" | "auto" | "always"
  thinkNPredict = positiveInt(process.env.BANTAM_THINK_N_PREDICT, 4096),
  thinkNPredictFirst = positiveInt(process.env.BANTAM_THINK_N_PREDICT_FIRST, 0),
  reasoningEffort = (process.env.BANTAM_REASONING_EFFORT ?? "").trim() || null,
  skills = null,           // { library, retrieve?, distill?, language? }
  // Experimental next-action hints remain an evidence candidate, not default
  // agent behavior. Enable explicitly for a paired run.
  integratedDecider = envTruthy(process.env.BANTAM_INTEGRATED_DECIDER),
  // Observation evidence is in-memory unless a caller explicitly supplies a
  // path. Normal/question/read-only runs must not dirty their workspace.
  improvementLogPath = process.env.BANTAM_IMPROVEMENT_LOG_PATH || null,
  planMode = false,        // author a plan up front and keep it pinned (workflow)
  preGate = true,          // syntax-check edits immediately and feed errors back
  openFilesView = true,    // keep current contents of edited files in context (favors surgical replace)
  useGrammar = true,       // constrain actions with the GBNF grammar (false = raw, for benchmarking)
  // Caller-owned hard policy. Unlike prompt instructions, excluded actions are
  // removed from grammar mode and rejected at runtime in raw/fallback mode.
  excludeActions = null,
  // Optional caller-owned reconnaissance budget. After this many investigative
  // actions, the next turn masks every recon verb so a read-only specialist
  // must return a response instead of spending its entire turn budget reading.
  investigationActionLimit = null,
  // Explicit caller-owned advisory intent for unattended orchestration lanes.
  // A Team scout can contain the original implementation request as quoted
  // context, but its own deliverable is still a read-only response. Do not
  // route that response through implementation-only empty/done gates.
  advisoryMode = false,
  dedupeActions = process.env.BANTAM_NO_DEDUPE !== "1", // replay, don't re-execute, identical recon
  // Replay an exact shell result only when its prior execution made no
  // workspace change. A balanced hard-tier A/B improved strict passes from
  // 6/8 to 8/8; set BANTAM_SHELL_REPEAT_GUARD=0 to restore re-execution.
  dedupeShell = process.env.BANTAM_SHELL_REPEAT_GUARD === undefined
    ? true
    : envTruthy(process.env.BANTAM_SHELL_REPEAT_GUARD),
  // Identical `query` actions are replayable: map/KB queries are deterministic on an unchanged
  // workspace, so a repeated map query is replayed from cache instead of re-shelling the extractor.
  // A 6-seed A/B (interactive "break down this repo" on the 35B) showed this keeps the model ON the
  // map tool (mean reads 3.2 -> 1.8, keyholes 2/6 -> 1/6) and wraps up faster (15 -> 12.8 turns) with
  // no loss of answer rate. Default on; disable with 0.
  dedupeQuery = process.env.BANTAM_DEDUPE_QUERY === undefined
    ? true
    : envTruthy(process.env.BANTAM_DEDUPE_QUERY),
  // Once a run is a few turns deep, restate the exact objective in the
  // cache-safe volatile slot. Full API traces from the 12-module migration show
  // the local model preserving broad intent while dropping clause-level
  // witnesses ("exactly one @", plain-object preconditions) when the sole task
  // copy is tens of thousands of characters behind the action boundary.
  // Default-on; set BANTAM_GOAL_REANCHOR=0 for the historical control.
  goalReanchor = process.env.BANTAM_GOAL_REANCHOR === undefined
    ? true
    : envTruthy(process.env.BANTAM_GOAL_REANCHOR),
  goalReanchorAfter = positiveInt(process.env.BANTAM_GOAL_REANCHOR_AFTER, 3),
  // Content-identical edit actions return NO_CHANGE and do not reset
  // progress/repetition state. Natural v19 document trajectories supplied the
  // previously missing live opportunities: false-success no-ops prolonged both
  // canonicalization and POV loops. Default on; disable with 0 for replay.
  noopEditGuard = process.env.BANTAM_NOOP_EDIT_GUARD === undefined
    ? true
    : envTruthy(process.env.BANTAM_NOOP_EDIT_GUARD),
  // Candidate: surface one concise signal when the same test command produces
  // the exact same failure outcome after a successful edit. Shadow metrics run
  // in both arms; only this flag changes the model-facing observation.
  outcomeCycleAwareness = envTruthy(process.env.BANTAM_OUTCOME_CYCLE_GUARD),
  // A repeated verifier fingerprint after an edit is a decision boundary, not
  // a request for more generic prose. Compile the task contract through
  // Datalog and inject one bounded lifecycle card. Default on; an experiment
  // control can disable it without disabling shadow outcome-cycle metrics.
  derivedFailureContext = process.env.BANTAM_DERIVED_FAILURE_CONTEXT === undefined
    ? true
    : envTruthy(process.env.BANTAM_DERIVED_FAILURE_CONTEXT),
  lifecycleContractLogic = process.env.BANTAM_LIFECYCLE_CONTRACT_LOGIC === undefined
    ? true
    : envTruthy(process.env.BANTAM_LIFECYCLE_CONTRACT_LOGIC),
  lifecycleContractMaxRejections = positiveInt(process.env.BANTAM_LIFECYCLE_CONTRACT_MAX_REJECTIONS, 2),
  // Observe-only execution state. This value may change telemetry and events,
  // but is forbidden from changing prompts, grammars, or controller authority.
  executionStateShadow = process.env.BANTAM_EXECUTION_STATE_SHADOW === undefined
    ? true
    : envTruthy(process.env.BANTAM_EXECUTION_STATE_SHADOW),
  // Candidate: spend one reasoning pass after all literal task-named source
  // paths are resident and before the first edit. This moves synthesis to the
  // source-grounded decision boundary without encoding a task family.
  preEditSynthesis = envTruthy(process.env.BANTAM_PREEDIT_SYNTHESIS),
  // After the first green test following an edit, ask for one explicit requirement-to-code audit.
  // A paired cohort preserved 8/8 strict passes and improved unseen checks from 8/18 to 14/18.
  completionAudit = completionAuditEnabled(undefined, { codex: model?.codex === true }),
  visualCompletionAudit = visualCompletionAuditEnabled(),
  // Reinterpret only task-named accepted string languages at the post-green
  // boundary. Exact-turn replay improved 0/3 -> 3/3 and a rotated full-task
  // GPT-5.5 trial improved 0/2 -> 2/2 while reducing turns and requests.
  lexicalContractAudit = lexicalContractAuditEnabled(),
  requirementChecklistAudit = requirementChecklistEnabled(),
  probeDemandGate = envTruthy(process.env.BANTAM_PROBE_DEMAND),
  constantGroundingGate = envTruthy(process.env.BANTAM_CONSTANT_GROUNDING),
  siblingSweepGate = envTruthy(process.env.BANTAM_SIBLING_SWEEP),
  // Candidate: after an authored HTML alt, compare only against explicit
  // Moon/Birds sections already present in saved view_image evidence.
  visualAltCoverage = visualAltCoverageEnabled(),
  // Specialize the post-green audit for high-confidence concurrent lifecycle
  // tasks. Conservative auto-selection is the production default; explicit
  // BANTAM_STATE_AUDIT=0/off remains the rollback.
  stateAudit = process.env.BANTAM_STATE_AUDIT ?? "auto",
  contractStateAudit = process.env.BANTAM_CONTRACT_STATE_AUDIT ?? "auto",
  contractAssertionStation = process.env.BANTAM_CONTRACT_ASSERTION_STATION ?? "off",
  // Two bounded objections prevent an immediate second-done bypass while the
  // global turn budget remains a hard escape from a heuristic audit.
  stateAuditMaxDeferrals = positiveInt(process.env.BANTAM_STATE_AUDIT_MAX_DEFERRALS, 2),
  // Optional specialized checklist for document-only plans/reports. The
  // ordinary artifact path already supplies exact-task context and a mandatory
  // whole-document reread; keep this extra prompt off unless an experiment asks for it.
  planAudit = process.env.BANTAM_PLAN_AUDIT ?? "off",
  // Expose one atomic 1-16 edit action when task text declares batch-safe work.
  // The conservative default passed a balanced live A/B; `true`/`1` forces it
  // on for every task and `false`/`0` restores serialized replaces.
  patchAction = process.env.BANTAM_PATCH_ACTION ?? "auto",
  // Codex-oriented whole-file transaction. Opt-in until paired evidence shows
  // that fewer physical calls outweigh the larger single completion on the
  // target worker. Legacy one-file writes remain available in either arm.
  writeBatch = envTruthy(process.env.BANTAM_WRITE_BATCH),
  // Candidate fixture experiments remain opt-in until downstream qualification.
  probeEnabled = envTruthy(process.env.BANTAM_PROBE),
  // Direct delete/move actions only for tasks that explicitly name those file
  // operations. A balanced local-Qwen A/B preserved 8/8 strict passes, used
  // both verbs with zero failures, and reduced summed task time by 3.1%.
  fileOperations = process.env.BANTAM_FILE_OPS ?? "auto",
  progressAwareness = true, // nudge after many recon-only turns with no deliverable progress
  progressNudgeAfter = positiveInt(process.env.BANTAM_PROGRESS_NUDGE_AFTER, 8),
  progressNudgeCooldown = positiveInt(process.env.BANTAM_PROGRESS_NUDGE_COOLDOWN, progressNudgeAfter),
  artifactVerifyAfter = positiveInt(process.env.BANTAM_ARTIFACT_VERIFY_AFTER, 2),
  artifactVerifyMaxRejections = positiveInt(process.env.BANTAM_ARTIFACT_VERIFY_MAX_REJECTIONS, 4),
  // Candidate: stop crediting a rerun of an unchanged, already-passing suite as
  // progress. Default-on preserves today's behaviour (the recorded bug); set
  // BANTAM_UNCHANGED_VERIFY_PROGRESS=0 to arm the fix. keyed-task-pool round-03
  // (2026-07-30) spent 26 of 40 turns in a read -> test loop the gate could not
  // reach, because each rerun reset progresslessTurns against a threshold of 8.
  unchangedVerifyEarnsProgress = process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS !== "0",
  progressGateMaxRejections = positiveInt(process.env.BANTAM_PROGRESS_GATE_MAX_REJECTIONS, 8),
  progressGateAllowEvery = positiveInt(process.env.BANTAM_PROGRESS_GATE_ALLOW_EVERY, 4),
  // Autonomous force-edit: in a non-interactive run the progress gate only SOFT-rejects recon — a
  // model that has read enough but won't commit just re-emits blocked reads until the run terminates
  // (observed: read the whole source+tests by turn 4, then 20 dithering reads, terminated with the
  // file untouched). After this many progressless turns, MASK the recon verbs in grammar mode so the
  // model cannot read and must make its first edit. Defaults to the gate's own recon threshold; 0 off.
  autoForceEditAfter = positiveInt(process.env.BANTAM_AUTO_FORCE_EDIT_AFTER, progressNudgeAfter),
  // Pre-done grounding audit: on the first clean `done`, force a one-shot requirement
  // ledger (restate each requirement + the SOURCE of its expected value) so a self-check
  // that asserts its own premise is caught. Default OFF — it adds a turn to every run, so
  // it is opt-in (BANTAM_LEDGER_GATE=1) and A/B-measured before becoming a default.
  requirementLedgerMax = positiveInt(process.env.BANTAM_LEDGER_GATE, 0),
  // Resume/replay: seed the trajectory with prior {action, observation} turns so a fix can be
  // tested surgically FROM a captured break point (e.g. the moment a saved run called `done`),
  // instead of regenerating the whole task from turn 0. maxTurns still bounds total length.
  resumeTurns = null,
  postVerifyIntegrity = null, // optional async clean/violations check before learning from a pass
  // Optional in-loop scope gate: (relPath) => reason|null. When it returns a
  // reason the edit is refused and the reason is fed back as the observation.
  // Null (the default) leaves every existing caller's behavior unchanged.
  editGuard = null,
  // Optional transactional companion to editGuard for shell actions. The guard
  // captures authored bytes immediately before a shell command and restores
  // only immutable-path mutations afterward. Kept caller-controlled because
  // full-workspace byte snapshots have an evaluation cost.
  shellScopeGuard = null,
  // Interactive mode: a human is driving and steers turn-by-turn, so the autonomous-run
  // guardrails (progress gate/nudges, premature-done veto, ledger audit) — which exist to keep
  // an UNSUPERVISED run from spiraling — only get in the way. Turn them off for a clean,
  // do-what-I-ask loop. Headless/benchmark callers leave this false to keep the safety nets.
  interactive = false,
  // An interactive operator can resolve an infrastructure block (install dependencies, opt into
  // networked Docker, change credentials); the model cannot. Pause instead of retrying or wandering.
  // Autonomous callers keep the actionable observation and may choose an offline route.
  pauseOnInfrastructureBlock = interactive,
  // Symbolic grounding: build a datalog KB of the workspace, inject a code map into context, and
  // reject reads/edits of files that provably don't exist. `true` builds it here; pass a prebuilt
  // context to share one. Off by default (measured A/B before becoming a default).
  grounding = null,
  // Inject the full code map into context. OFF by default: an A/B showed always-on injection is
  // a net cost (bigger prompt, more thinking) with no benefit when the model can just search —
  // the KB is better queried on demand than force-fed. The cheap path gate stays on with `grounding`.
  groundingMap = false,
  // Extra {name,describe,answer} tools to register on the query socket.
  extraTools = null,
  // Live control (interactive): signal cancels in-flight model/shell work, while
  // shouldAbort() preserves the older between-turn callback API;
  // drainInjections() returns any messages the user typed mid-run so the model can adjust
  // course. Unset controls have no effect on autonomous/benchmark runs.
  signal = null,
  shouldAbort = null,
  drainInjections = null,
  // Evaluators can remove volatile paths/timings from model-facing observations while
  // artifacts retain the original. Interactive callers leave this unset.
  observationTransform = null,
  onEvent = () => {},
}) {
  terminalClosureAllowance(terminalClosureTurns);
  if (verificationPolicy !== "always" && verificationPolicy !== "after_edit") {
    throw new TypeError(`unknown verification policy: ${verificationPolicy}`);
  }
  const callerExcludedActions = normalizeExcludedActions(excludeActions);
  const callerInvestigationActionLimit = investigationActionLimit === null
    || investigationActionLimit === undefined
    ? null
    : positiveInt(investigationActionLimit, null);
  if (investigationActionLimit !== null
      && investigationActionLimit !== undefined
      && callerInvestigationActionLimit === null) {
    throw new TypeError("investigationActionLimit must be a positive integer");
  }
  // Scope exact request evidence to this invocation even when a long-lived
  // interactive ModelClient has already served earlier requests.
  const modelCallStart = typeof model?.requestCursor === "function" ? model.requestCursor() : null;
  // Promoted after local-context-authority-ab-v1 (same seed, three held-out
  // fixtures): 2/3 -> 3/3 strict and 52 -> 47 turns. Explicit =0 retains the
  // historical behavior for controls and emergency rollback.
  const preserveSlimmedControlAnnotations = process.env.BANTAM_PRESERVE_SLIMMED_CONTROL === undefined
    ? true
    : envTruthy(process.env.BANTAM_PRESERVE_SLIMMED_CONTROL);
  const retireVerifiedCheckpoint = process.env.BANTAM_RETIRE_VERIFIED_CHECKPOINT === undefined
    ? true
    : envTruthy(process.env.BANTAM_RETIRE_VERIFIED_CHECKPOINT);
  // General execution-state work starts observe-only. The shadow compiler sees
  // controller facts, emits telemetry, and has no prompt/grammar authority.
  // Explicit task-path preloading remains an unpromoted A/B candidate.
  const taskPathPreloadEnabled = envTruthy(process.env.BANTAM_TASK_PATH_PRELOAD);
  // Unpromoted candidate. Suppression helped a shaped three-fixture cohort,
  // but full keyed-pool API logs show the pre-edit checkpoint carrying a useful
  // requirement ledger. Keep historical behavior unless an A/B explicitly
  // enables suppression.
  const suppressPreEditCheckpoint = envTruthy(process.env.BANTAM_SUPPRESS_PREEDIT_CHECKPOINT);
  const requestedReasoningChars = Number(process.env.BANTAM_ACTION_REASONING_MAX_CHARS ?? 0);
  const actionReasoningMaxChars = Number.isInteger(requestedReasoningChars)
    && requestedReasoningChars >= 200 ? requestedReasoningChars : 0;
  if (interactive) { progressAwareness = false; requirementLedgerMax = 0; }
  // Source-file count for repo-scaled budgets; one directory walk, done once.
  const workspaceSourceFiles = workspace ? sourceFileCount(workspace) : 0;
  // Feature-integration patch exposure only on real codebases (>30 source
  // files), so fixture-measured auto-policy behavior is unchanged.
  const patchActionPolicy = decidePatchAction(task, patchAction, { largeRepo: workspaceSourceFiles > 30 });
  const fileOperationPolicy = decideFileOperations(task, fileOperations);
  const stateAuditPolicy = decideStateAudit(task, stateAudit);
  const planAuditPolicy = decidePlanAudit(task, planAudit);
  const repositoryDocumentCue = repositoryDocumentContractCue(task);
  if (process.env.BANTAM_PROGRESS_NUDGE_AFTER === undefined && progressNudgeAfter === 8) {
    progressNudgeAfter = scaledProgressNudgeAfter(8, workspaceSourceFiles);
  }
  // Line-pointer editing (BANTAM_LINE_EDIT=1): measured failure rates for
  // exact-match replace climb from 4% (<200 chars) to 85% (5k+) — a
  // reproduction problem, not a knowledge problem. Off until its own A/B.
  if (promptTrajectory !== null && !["rebuild", "extension"].includes(promptTrajectory)) {
    throw new Error(`unknown promptTrajectory: ${promptTrajectory} (expected "rebuild" or "extension")`);
  }
  // Rebuild is the default for every transport. The extension trajectory won
  // its four-fixture flip on 2026-08-12 (strict 11/12 vs 10/12, fresh prefill
  // at 8% of control) and lost the default the same day at higher n: the
  // preregistered strictness routing decision measured rebuild 10/10 against
  // extension 7/10 on the compact-strictness family — the missing panel makes
  // post-bounce repairs land on stale self-knowledge — and its ordered rule
  // reverted the default. Extension remains one explicit choice away
  // (promptTrajectory / BANTAM_PROMPT_TRAJECTORY) with its efficiency intact:
  // 92% slot reuse and less than half the wall time on the same workloads.
  // See docs/superpowers/reports/2026-08-12-strictness-routing-results.md.
  const resolvedPromptTrajectory = promptTrajectory ?? "rebuild";
  const extensionTrajectory = resolvedPromptTrajectory === "extension";
  // Opt-in (2026-08-22). Extension keeps a byte-stable prefix, which is right,
  // but its history budget still EVICTS from the front when edit bodies push it
  // past the cap — and a front eviction rewrites the prompt just after the
  // system block, resetting the slot cache to the head checkpoint. Measured
  // across 63 local runs: 62 broke the extension invariant, 1,103 breaks,
  // 10,725s of wasted prefill (87% of all prefill time). This mode removes the
  // CAUSE rather than widening the cap: bodies never enter history, and the
  // panel carries current truth instead.
  const extensionWorkingSet = extensionTrajectory
    && /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_EXTENSION_WORKING_SET ?? ""));
  // Bare assistant turns are meaningful only where history is immutable and
  // replayed byte-for-byte; the rebuild panel re-renders history anyway.
  const bareHistory = extensionTrajectory && Boolean(extensionBareHistory);
  const lineEditEnabled = /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_LINE_EDIT ?? ""));
  const baseActionFeatures = [
    ...(lineEditEnabled ? [LINE_EDIT_FEATURE] : []),
    ...(patchActionPolicy.enabled ? [PATCH_ACTION_FEATURE] : []),
    ...(writeBatch ? [WRITE_BATCH_FEATURE] : []),
    ...(fileOperationPolicy.enabled ? [FILE_OPS_FEATURE] : []),
    ...(probeEnabled ? [PROBE_ACTION_FEATURE] : []),
  ];
  // Is this a "build/create something" request (vs a question or a small edit)? On these the
  // deliverable is running code, so a plan-only answer before any file exists is premature —
  // the build-first guard below pushes the model to start writing instead of describing.
  const buildRequest = interactive && !advisoryMode
    && /\b(build|create|implement|rebuild|remake|recreate|scaffold|port|generate|make)\b/i.test(String(task))
    && !/^\s*(what|why|how|is|are|should|could|can|do|does|where|when|which|who)\b/i.test(String(task).trim());
  let buildRespondRejections = 0;
  // Mirror the executor's sandbox resolution so the prompt teaches the physics
  // the shell will actually have (per-action docker container vs host shell).
  const sandboxedShell = (shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker") === "docker";
  if (typeof verificationWorkspaceReadOnly !== "boolean") throw new TypeError("verificationWorkspaceReadOnly must be a boolean");
  if (verificationWorkspaceReadOnly && !sandboxedShell) {
    throw new Error("read-only configured verification requires the Docker shell sandbox; host mode cannot enforce it");
  }
  const verificationEnvironmentMatches = proof => verificationWorkspaceReadOnly
    ? proof?.workspaceReadOnly === true : proof?.workspaceReadOnly !== true;
  const resumingContext = Array.isArray(resumeTurns) && resumeTurns.length > 0;
  const savedContextBasis = resumingContext
    ? resumeTurns.findLast((turn) => turn?.contextBasis?.schema === 1)?.contextBasis : null;
  const instructionGuards = composeInstructionGuards({
    workspace, instruction: task, editGuard, shellScopeGuard,
    frozenTests: savedContextBasis?.frozenTests ?? null,
  });
  ({ editGuard, shellScopeGuard } = instructionGuards);
  // Only exact invocation-frozen files, never the whole test directory: new
  // worker tests stay writable, supplied tests are read-only in Docker too.
  if (instructionGuards.protectedExistingTests?.length) {
    readOnlyWorkspacePaths = [...new Set([...(readOnlyWorkspacePaths ?? []),
      ...instructionGuards.protectedExistingTests])];
  }
  const exec = new Executor(workspace, {
    probeEnabled,
    noopEditGuard,
    shellSandbox,
    shellNetwork,
    onNetRequest,
    dockerImage,
    readOnlyWorkspacePaths,
    shellEnvOverrides,
    processRunner: shellProcessRunner,
    onShellOutput: ({ stream, text }) => onEvent({ type: "shell_output", stream, text }),
  });
  // Self-check arm phase: snapshot instruction-named immutable files BEFORE the first write, so
  // the done-gate can prove they are untouched. Off (mode "none") for tasks that name none.
  const immutableInv = instructionGuards.invariants;
  const immutableSnap = immutableInv.mode !== "none" ? immutableViolations.snapshot(workspace, immutableInv) : null;
  if (immutableSnap && instructionGuards.frozenTestCheckpoint) {
    Object.assign(immutableSnap.hashes, instructionGuards.frozenTestCheckpoint.hashes);
  }
  const testProvenance = createTestProvenance(workspace, {
    protectedPath: (relative) => Boolean(editGuard?.(relative)),
    ...(resumingContext ? { snapshot: savedContextBasis?.testProvenance ?? null } : {}),
  });
  // A pointer to REQUIREMENTS.md is not the requirement itself. Auxiliary
  // diagnosis must see the original supplied contract, not an edited document
  // or only its filename. Capture bounded, workspace-confined bytes up front.
  const suppliedTaskDocuments = resumingContext
    ? (Array.isArray(savedContextBasis?.suppliedTaskDocuments) ? savedContextBasis.suppliedTaskDocuments : [])
      .filter((document) => typeof document?.path === "string" && typeof document?.text === "string")
      .slice(0, 4).map((document) => ({ path: document.path, text: document.text.slice(0, 12000), truncated: document.truncated === true || document.text.length > 12000 }))
    : uneditedTaskSpecDocuments(task, [], exec).slice(0, 4)
      .map((document) => ({ path: document.path, text: document.text.slice(0, 12000), truncated: document.text.length > 12000 }));
  const contextBasis = { schema: 1, testProvenance: testProvenance.snapshot(), suppliedTaskDocuments,
    ...(instructionGuards.frozenTestCheckpoint ? { frozenTests: instructionGuards.frozenTestCheckpoint } : {}) };
  let contextBasisRecorded = Boolean(savedContextBasis)
    && (!instructionGuards.frozenTestCheckpoint || savedContextBasis.frozenTests?.instructionSha256 === instructionGuards.frozenTestCheckpoint.instructionSha256);
  const contractAuditEnabled = !interactive && !advisoryMode
    && contractStateAuditEnabled(contractStateAudit, task, suppliedTaskDocuments);
  const collectionAuditEnabled = contractAuditEnabled
    && collectionContractAuditApplies(task, suppliedTaskDocuments);
  // Only checks created during this invocation can become retained witnesses
  // or trigger the self-launch diagnostic guard. The latter also applies when
  // semantic collection audits are disabled.
  // Never infer ownership from a test-like filename or protect a user's
  // pre-existing source against requested cleanup. Resumes start conservatively.
  const auditInitialFiles = snapshotWorkspaceFiles(workspace);
  // An incomplete inventory is unknown ownership, not an empty workspace.
  const auditInitialSourcePaths = auditInitialFiles ? [...auditInitialFiles.keys()] : null;
  // Reuse the explicitly enabled, isolated probe machinery. This checkpoint
  // owns the assertion procedure, never its model-designed expected outcome.
  const assertionStationEnabled = collectionAuditEnabled && probeEnabled
    && (shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker") === "docker"
    && !callerExcludedActions.includes("probe") && !callerExcludedActions.includes("shell")
    && !/^(?:0|false|no|off)$/i.test(String(contractAssertionStation));
  const diagnosticTaskContract = [String(task ?? ""),
    ...suppliedTaskDocuments.map((document) =>
      `SUPPLIED DOCUMENT ${document.path}:\n${document.text.slice(0, 12000)}${document.truncated || document.text.length > 12000 ? "\n[document truncated; do not infer omitted requirements]" : ""}`),
  ].join("\n\n");
  // Symbolic grounding context (datalog KB of the workspace). `true` => build it now.
  const groundStartedAt = Date.now();
  let ground = grounding === true
    ? buildGrounding(workspace, { onProgress: (p) => onEvent({ type: "grounding_progress", ...p }) })
    : (grounding || null);
  // Say whether the code KB is live. An operator reading a run log could not
  // tell (2026-08-16): the header printed the model and endpoint but nothing
  // about a capability that decides whether `query` has any tools behind it —
  // and twelve parity runs went by with the verb advertised and the KB unbuilt.
  const tooLarge = ground?.stats?.tooLarge ?? null;
  onEvent({
    type: "grounding_state",
    enabled: Boolean(ground) && !tooLarge,
    files: ground?.stats?.files ?? 0,
    buildMs: ground ? Date.now() - groundStartedAt : 0,
    tooLarge,
    workspace,
  });
  // Over the ceiling the KB is empty by construction. Offering `query` against
  // it would be the 2026-08-16 failure again — the verb advertised, nothing
  // behind it — so downstream the honest state is: no grounding.
  if (tooLarge) ground = null;
  const visualTask = taskRequiresVisualPreview(task);
  // Does this task declare accepted input types without saying what falls outside
  // them? That is the one condition the type_contract gate is measured to convert
  // (0/3 -> 3/3 on channel-filter), and the condition under which it is otherwise
  // pure cost. Computed once here rather than per done, since neither the task nor
  // the export surface moves during a run.
  // BANTAM_SPEC_GAP_AUTO=0 suppresses the auto-enable entirely, so an A/B arm can
  // measure the harness without it. Added after a control arm was run with this
  // exact variable set and turned out to be a no-op -- both arms were identical and
  // the "comparison" measured nothing. An unimplemented kill switch is worse than
  // none: it silently produces a control that is a copy of the treatment.
  const specGapAuto = !/^(0|false|no|off)$/i.test(String(process.env.BANTAM_SPEC_GAP_AUTO ?? ""));
  const specGapInfo = specGapAuto
    ? detectSpecGap(task, workspaceExports(workspace))
    : { underSpecified: false, functions: [] };
  const specGap = specGapInfo.underSpecified;
  if (specGap) onEvent({ type: "spec_gap", detail: formatSpecGap(specGapInfo), functions: specGapInfo.functions });
  const tools = ground ? buildToolRegistry(ground, {
    endpoint: model?.endpoint,
    task,
    visualTask,
    onEvent,
    codex: model?.codex,
    codexModel: model?.modelName,
    codexEffort: model?.codexEffort,
    signal,
    onExternalUsage: (usage, meta) => model?.recordExternalUsage?.(usage, meta),
  }) : null;
  // The history tool reads the LIVE trajectory (`turns` is declared below; the closure defers to
  // query time, so it always reflects the current run).
  if (tools) tools.register(historyTool(() => turns));
  // Auto-preview state (eyes before done): if web-surface files changed and were never
  // rendered, the FIRST done attempt is bounced once with a real preview report.
  let webEditedUnpreviewed = false;
  let autoPreviewFired = false;
  if (tools && Array.isArray(extraTools)) {
    for (const t of extraTools) tools.register(t);
  }
  const automaticRepositoryBriefEnabled = Boolean(
    tools?.get("map") && shouldSeedRepositoryBrief(task),
  );
  let automaticRepositoryBrief = "";
  let automaticRepositoryBriefRevision = null;
  // When the code map is registered, steer comprehension tasks toward it — a small model otherwise
  // brute-forces dozens of read_file/inspect calls to learn a repo it could grasp in one query.
  const mapNudge = tools?.get("map")
    ? (automaticRepositoryBriefEnabled
      ? `\nA live \`map brief\` is already supplied in the repository context below. Do not query \`brief\` or \`arch\` again; use a targeted \`query\` only for a specific file, symbol, or flow the menu above can answer.\nFor feature analysis, the tool menu above is authoritative current capability: do not propose a listed tool (including \`concept\` meaning search) as missing. Do not invent percentages or benchmark claims; use a number only when repository evidence supplied it.`
      : `\nTip: for "understand / explain / break down this codebase" tasks, prefer one \`query\` to the \`map\` tool (\`brief\` or \`arch\`) over many read_file/inspect calls.`)
    : "";
  // Map availability doubles as the "large repo" signal: it registers only past the
  // source-file floor, which is the same territory where seam-first integration pays.
  const seamSteer = decideSeamSteer(task, { largeRepo: Boolean(tools?.get("map")) });
  const seamNudge = seamSteer.enabled ? SEAM_STEER_TIP : "";
  const toolsText = tools
    ? `You can ask local retrieval and reasoning tools with the "query" action instead of reading/searching blindly. Structural tools return exact facts; ranked tools label their evidence. Menu:\n${tools.describe()}${mapNudge}${seamNudge}`
    : "";
  let map = (ground && groundingMap) ? codeMap(ground) : "";
  // Name the verification command. The harness runs it for the model
  // ("reading and reasoning is not verification, so I ran them for you") and
  // the implementation-response steer says "run the configured verification
  // after your latest edit" — while no prompt ever stated WHAT it is. tb6
  // (2026-08-16, .bantam/runs/2026-08-16T17-22-16-517Z.json) made zero shell
  // calls across 60 turns: `node --test …` appears in none of its 82 prompts.
  // An instruction the model cannot follow is not an instruction.
  const numericWitness = numericContractWitness(task);
  const numericWitnessText = formatNumericContractWitness(numericWitness);
  if (numericWitness) onEvent({ type: "numeric_contract_witness", witness: numericWitness });
  const withVerificationNote = (text) => (verificationScript
    ? `${text}\n\nVerification for this task — run it yourself with shell after an edit, do not wait to be told:\n  ${verificationScript}`
      + (verificationWorkspaceReadOnly ? "\nConfigured acceptance verification runs in Docker with the entire source workspace READ-ONLY and a fresh writable /tmp. Tests must create temporary fixtures with the platform temp directory (for Node: os.tmpdir() + fs.mkdtempSync), not inside the source workspace, and must not depend on scratch files from earlier shell actions. Ordinary edits and manual shell commands remain writable; their green results do not substitute for this read-only configured check. The harness runs the configured check before accepting done." : "")
    : text) + (numericWitnessText ? `\n\n${numericWitnessText}` : "");
  let env = withVerificationNote(map ? `${map}\n\n${safeListing(workspace)}` : safeListing(workspace));
  const thinkP = deriveThinkPrefills(model.assistantPrefill, model.thinkMarkers);
  // The bare assistant-turn opener for this template family (`<|im_start|>assistant\n`
  // for ChatML). Used as both the action prefill and the history prefill under
  // bareHistory so request-tip bytes equal appended-history bytes — which is what
  // keeps the byte-extension invariant, and with it checkpoint alignment, intact.
  const bareTemplate = model.template ?? CHATML_TEMPLATE;
  const bareTurnPrefill = bareTemplate.open(bareTemplate.assistantRole);
  const taskNamedPaths = taskNamedSourcePaths(task, workspace);
  const taskOutputPaths = extractTaskOutputPaths(task);
  const cliContract = !interactive && !advisoryMode && probeEnabled
    && (shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker") === "docker"
    && !callerExcludedActions.includes("probe") && !callerExcludedActions.includes("shell")
    ? deriveCliContract(task) : null;
  if (cliContract) {
    env += `\n[public CLI verification] ${cliContract.module} has a separate required process contract. The controller will check the actual CLI after green verification or proposed completion, using a bounded declarative input and expected result. API-only assertions and printed statuses cannot discharge this CLI obligation.\n`;
    onEvent({ type: "cli_contract", contract: structuredClone(cliContract) });
  }
  const sourceProvenance = deriveSourceProvenanceObligation(task, { outputPaths: taskOutputPaths });
  // Source deliverable(s) the task NAMES (e.g. "call your program /app/gpt2.c").
  // Unlike taskNamedPaths, these need not exist yet — the commit-to-deliverable
  // gauge nudges when they are still MISSING after prolonged probing.
  const deliverables = namedDeliverables(task);
  // The preload note promises panel-resident bytes; without a rendered panel
  // (extension trajectory) that promise would be false, so the model reads the
  // named paths normally and the bytes land in immutable history instead.
  const taskPreloadedPaths = taskPathPreloadEnabled && !extensionTrajectory ? taskNamedPaths : [];
  const preloadedContextNote = taskPreloadedPaths.length
    ? `[preloaded-sources] These named implementation paths are already placed in <open_files> below: ${taskPreloadedPaths.join(", ")}. A fully rendered panel satisfies the investigate-before-edit rule: do not emit read_file/inspect for that path again. If a panel is clipped, read only its omitted range.`
    : "";
  const taskContractText = [preloadedContextNote, sourceProvenance?.message]
    .filter(Boolean)
    .join("\n\n");
  // Gemma 4 gates its reasoning channel with a `<|think|>` flag at the top of
  // the system turn. Think mode is fixed for the run, so resolving it once here
  // keeps the prompt prefix stable (and llama.cpp's cache reusable) turn to turn.
  const thinkEnabled = thinkP.canThink && thinkMode !== "off";
  const promptTemplate = model.template;
  // Some model/profile combinations immediately close an open <think> block.
  // Probe once, then stop paying for an empty reasoning request on every later
  // correction in the same run.
  let thinkingAvailable = thinkP.canThink;
  let thinkingProven = false;
  // A turn-zero think with literal source preloaded already crosses the same
  // boundary; do not pay for a duplicate post-read synthesis in that arm.
  let preEditSynthesisSpent = taskPreloadedPaths.length > 0;
  let interrupted = false; // the user asked to stop mid-run (clean pause, not a crash)
  let interruptionEventSent = false;
  const abortRequested = () => Boolean(signal?.aborted || (shouldAbort && shouldAbort()));
  const markInterrupted = (phase) => {
    interrupted = true;
    if (!interruptionEventSent) {
      interruptionEventSent = true;
      onEvent({ type: "interrupted", phase });
    }
  };

  // Optional workflow: author a plan up front and pin it in context for every turn.
  let plan = null;
  let planText = "";
  if (planMode) {
    plan = await makePlan({ model, task, env, signal, buildRawPrompt: (i) => buildAuxPrompt(i, model.assistantPrefill, model.template) });
    if (abortRequested()) markInterrupted("planning");
    if (plan) { planText = formatPlan(plan); onEvent({ type: "plan_made", plan }); }
  }
  let planAnchor = 0;   // turn index when the current plan was set
  let rePlans = 0;      // adaptive re-plans so far (capped)

  // Self-building skills: proven approaches retrieved FRESH each turn, so a symptom
  // seen in an observation (a NaN, an error, a failing assertion) can trigger the
  // right skill even when the initial task text is generic ("fix the failing test").
  const skillsCfg = skills || {};
  const library = skillsCfg.library ? loadLibrary(skillsCfg.library) : [];
  const skillRetrieve = skillsCfg.retrieve !== false && library.length > 0;
  const announcedSkills = new Set();

  // Seed from a resumed trajectory when replaying from a captured break point. Each seed turn
  // needs { action, observation }; anything else (rawOutput/reasoning) is ignored for the prompt.
  const turns = Array.isArray(resumeTurns)
    ? resumeTurns.map((t, i) => ({
        i: Number.isInteger(t.i) ? t.i : i,
        action: t.action ?? t.parsedAction ?? null,
        observation: t.observation ?? "",
        // Reasoning is not replayed as transcript prose. It is retained as a
        // bounded EAVT working note so a rewind at an audit/read boundary does
        // not forget the conclusion that motivated the next action.
        ...(typeof t.reasoning === "string" && t.reasoning.trim() ? { reasoning: t.reasoning } : {}),
        queryTool: Object.prototype.hasOwnProperty.call(t, "queryTool") ? t.queryTool : repositoryQueryTool(t),
        ...(typeof t.queryExecuted === "boolean" ? { queryExecuted: t.queryExecuted } : {}),
        ...(typeof t.editApplied === "boolean" ? { editApplied: t.editApplied } : {}),
        ...(typeof t.doneAccepted === "boolean" ? { doneAccepted: t.doneAccepted } : {}),
        ...(t.controllerStop ? { controllerStop: structuredClone(t.controllerStop) } : {}),
        ...(t.sourceEditedByShell === true ? { sourceEditedByShell: true } : {}),
        ...(Array.isArray(t.shellChangedPaths) ? { shellChangedPaths: t.shellChangedPaths.slice() } : {}),
        ...(t.shellScopeRollback ? { shellScopeRollback: structuredClone(t.shellScopeRollback) } : {}),
        ...(t.scopedVerify ? { scopedVerify: t.scopedVerify } : {}),
        ...(Object.hasOwn(t, "verificationEvidence") ? { verificationEvidence: t.verificationEvidence } : {}),
        ...(Object.hasOwn(t, "verificationReceipts") ? { verificationReceipts: structuredClone(t.verificationReceipts) } : {}),
        ...(Object.hasOwn(t, "shellExecution") ? { shellExecution: t.shellExecution } : {}),
        ...(Object.hasOwn(t, "probeEvidence") ? { probeEvidence: structuredClone(t.probeEvidence) } : {}),
        ...(Object.hasOwn(t, "editOutcome") ? { editOutcome: t.editOutcome } : {}),
        ...(t.environmentVerification ? { environmentVerification: t.environmentVerification } : {}),
        ...(t.preview ? { preview: t.preview } : {}),
        ...(t.stateAudit ? { stateAudit: { ...t.stateAudit } } : {}),
        ...(t.contractStateAudit ? { contractStateAudit: { ...t.contractStateAudit } } : {}),
        ...(t.contractAssertion ? { contractAssertion: structuredClone(t.contractAssertion) } : {}),
        ...(t.verificationWorkflow ? { verificationWorkflow: structuredClone(t.verificationWorkflow) } : {}),
        ...(t.cliVerification ? { cliVerification: structuredClone(t.cliVerification) } : {}),
        ...(t.contextBasis ? { contextBasis: t.contextBasis } : {}),
        ...(Object.hasOwn(t, "contextUpdates") ? { contextUpdates: structuredClone(t.contextUpdates) } : {}),
        ...(t.workspaceCoherence ? {
          workspaceCoherence: {
            fingerprints: { ...(t.workspaceCoherence.fingerprints ?? {}) },
            pendingPaths: Array.isArray(t.workspaceCoherence.pendingPaths)
              ? t.workspaceCoherence.pendingPaths.slice()
              : [],
          },
        } : {}),
      }))
    : [];
  let latestPreviewProof = [...turns].reverse().find((turn) => turn?.preview)?.preview ?? null;
  // A rewind keeps the bounded reasoning checkpoint as datalog state. Treat
  // that captured success as proof that this model/profile can think too; one
  // empty completion after resume must not erase a capability already observed.
  thinkingProven = turns.some((turn) => typeof turn.reasoning === "string" && turn.reasoning.trim());
  let openList = [];       // recency of files the model has edited
  // Explicit task paths are trustworthy turn-zero context. Seed them without a
  // synthetic transcript action so the first API call can act from relevant
  // source and the bytes remain in the stable live-panel suffix.
  let recentReads = [...taskPreloadedPaths];
  // Keep a wider, path-only inventory than the four-file live source panel. A
  // repository-grounded document may depend on many small consumers; dropping
  // their names after eight reads leaves the model with the right facts in old
  // history but no concise checklist beside the final draft review.
  let inspectedPaths = [];
  const noteInspectedPath = (p) => {
    if (!p || typeof p !== "string") return;
    inspectedPaths = [p, ...inspectedPaths.filter((entry) => entry !== p)].slice(0, 48);
  };
  const forgetInspectedPath = (p) => {
    inspectedPaths = inspectedPaths.filter((entry) => entry !== p);
  };
  const moveInspectedPath = (from, to) => {
    const wasInspected = inspectedPaths.includes(from);
    forgetInspectedPath(from);
    if (wasInspected) noteInspectedPath(to);
  };
  const focusByPath = new Map(); // last explicitly inspected line window for each live seam
  // Explicit edit loci cannot rely on `git diff`: a lane materialization may
  // be an untracked tree below an ancestor repository, where Git reports every
  // file as `??` and emits no hunks. Keep accepted mutation anchors separately
  // so a later read of parser/help cannot erase the code the model just wrote.
  const mutationFocusByPath = new Map();
  // Resume reconstructs against the final restored tree. If a file was edited
  // and later moved, its old path no longer exists when the earlier turn is
  // replayed; retain the edit action so the anchor can be relocated at `to`.
  const resumedMutationActionByPath = new Map();
  const rememberReadFocus = (op, observation = "") => {
    if (op?.a !== "read_file" || typeof op.p !== "string") return;
    const shown = /\(\d+ lines, showing (\d+)-(\d+)\)/.exec(String(observation));
    const start = shown ? Number(shown[1]) : (Number.isInteger(op.start) ? op.start : 1);
    const end = shown
      ? Number(shown[2])
      : start + Math.max(1, Number.isInteger(op.limit) ? op.limit : 80) - 1;
    focusByPath.set(op.p, [{ start, end }]);
  };
  // A rewind must restore working context, not only transcript prose. Rebuild
  // the bounded file recency from recorded actions; the files themselves are
  // always re-read from the restored workspace, so stale historical bytes do
  // not come back.
  for (const turn of turns) {
    const prior = turn?.action;
    // noteOpenFile prepends. Replay a batch in reverse so its first authored
    // read remains the highest-priority seam, matching the model's own order.
    // A refused re-read promises "these bytes are already in your context".
    // Keep that promise true: refresh the file's panel recency even though the
    // read did not execute. Without this the refused file ages out of the open
    // list, leaves the panel, has its history reads collapsed by the sticky
    // rule, and is then nowhere at all — measured 2026-08-15, gate-policy.js
    // refused, evicted, and re-read 54 times in one run.
    for (const readPath of refusedResidentReadPaths(turn).slice().reverse()) {
      recentReads = noteOpenFile(recentReads, readPath);
    }
    for (const readPath of successfulReadPaths(turn).slice().reverse()) {
      recentReads = noteOpenFile(recentReads, readPath);
      noteInspectedPath(readPath);
      const readAction = prior?.a === "read_file"
        ? prior
        : prior?.ops?.find((op) => op?.a === "read_file"
            && normalizedLoggedReadPath(op.p) === normalizedLoggedReadPath(readPath));
      rememberReadFocus(readAction, prior?.a === "read_file" ? turn.observation : "");
    }
    if (turnEditApplied(turn)) {
      const restoredFocus = currentEditFocus(prior, workspace);
      if (prior.a === "delete_file") {
        openList = forgetOpenFile(openList, prior.p);
        recentReads = forgetOpenFile(recentReads, prior.p);
        forgetInspectedPath(prior.p);
        focusByPath.delete(prior.p);
        mutationFocusByPath.delete(prior.p);
        resumedMutationActionByPath.delete(prior.p);
      } else if (prior.a === "move_file") {
        const readFocus = focusByPath.get(prior.from);
        const mutationAction = resumedMutationActionByPath.get(prior.from);
        let mutationFocus = mutationFocusByPath.get(prior.from);
        if (!mutationFocus && mutationAction) {
          mutationFocus = currentEditFocus(retargetEditAction(mutationAction, prior.from, prior.to), workspace).get(prior.to);
        }
        openList = noteOpenFile(forgetOpenFile(openList, prior.from), prior.to);
        recentReads = noteOpenFile(forgetOpenFile(recentReads, prior.from), prior.to);
        moveInspectedPath(prior.from, prior.to);
        focusByPath.delete(prior.from);
        mutationFocusByPath.delete(prior.from);
        resumedMutationActionByPath.delete(prior.from);
        if (readFocus) focusByPath.set(prior.to, readFocus);
        else focusByPath.delete(prior.to);
        if (mutationFocus) mutationFocusByPath.set(prior.to, mutationFocus);
        else mutationFocusByPath.delete(prior.to);
        if (mutationAction) resumedMutationActionByPath.set(prior.to, retargetEditAction(mutationAction, prior.from, prior.to));
        else resumedMutationActionByPath.delete(prior.to);
      } else {
        for (const editedPath of editPaths(prior)) {
          openList = noteOpenFile(openList, editedPath);
          focusByPath.delete(editedPath);
          if (restoredFocus.has(editedPath)) mutationFocusByPath.set(editedPath, restoredFocus.get(editedPath));
          else mutationFocusByPath.delete(editedPath);
          resumedMutationActionByPath.set(editedPath, prior);
        }
      }
    }
  }
  const lifecycleContractPaths = new Set(openList);
  let pendingLifecycleContractViolations = lifecycleContractLogic
    ? lifecycleContractViolations({ task, workspace, paths: [...lifecycleContractPaths] })
    : [];
  const rejectedOutputs = [];
  const deciderEnabled = integratedDecider === true || envTruthy(integratedDecider);
  const resolvedImprovementLogPath = improvementLogPath
    ? (path.isAbsolute(improvementLogPath)
      ? improvementLogPath
      : path.join(workspace, improvementLogPath))
    : null;
  const improvementLog = resolvedImprovementLogPath
    ? new ImprovementLog(resolvedImprovementLogPath)
    : null;
  const sequenceDecider = deciderEnabled
    ? createIntegratedPlanner({ mode: "adaptive", overrideThreshold: 0.15 })
    : null;
  // createIntegratedPlanner auto-seeds exactly once. Do not seed again here.
  const runtimeAnalysisEnabled = Boolean(improvementLog || sequenceDecider);
  const turnAnalyzer = runtimeAnalysisEnabled ? new TurnAnalyzer() : null;
  const obsParser = runtimeAnalysisEnabled ? createObservationParser() : null;
  let decHint = null; // persisted across iterations — last decider recommendation fed into the prompt
  let observedActionSequence = [];
  const recordObservedSequence = (outcome) => {
    if (!sequenceDecider || !outcome || observedActionSequence.length === 0) return false;
    const sequence = observedActionSequence;
    observedActionSequence = [];
    sequenceDecider.recordOutcome(sequence, outcome.success);
    metrics.sequenceOutcomes = (metrics.sequenceOutcomes ?? 0) + 1;
    onEvent({
      type: "sequence_outcome",
      sequence,
      success: outcome.success,
      evidence: outcome.evidence,
    });
    return true;
  };
  // Wall-clock start of this run. missing_outputs compares a required output's
  // mtime against it, to tell a deliverable this run WROTE from one the image
  // merely shipped.
  const runStartedAt = Date.now();

  const metrics = {
    turns: 0,
    terminalClosure: { workTurnLimit: maxTurns, allowance: terminalClosureTurns,
      granted: false, used: false, grantedTurn: null, usedTurn: null, generation: null },
    contextUpdatesIncluded: 0,
    contextUpdatesOmitted: 0,
    contextUpdatePromptReceipts: [],
    invalid: 0,
    outputLimitRecoveries: 0,
    protocolViolations: 0,
    thinkPhases: 0,
    emptyThinkDisables: 0,
    emptyThinkTransients: 0,
    actionReasoningCompactions: 0,
    actionReasoningChars: 0,
    actionReasoningOmittedChars: 0,
    preEditSynthesisAttempts: 0,
    preEditSynthesisThinks: 0,
    executionStateShadow,
    executionStateShadowPhases: {},
    executionStateShadowTransitions: {},
    executionStateShadowBoundaries: {},
    taskPreloadedPaths: [...taskPreloadedPaths],
    thinkTokens: 0,
    actionTokens: 0,
    thinkTokenBudget: thinkNPredict,
    skillsUsed: 0,
    shellCwdGuards: 0,
    workspaceAliasNormalizations: 0,
    shellReadGuards: 0,
    testDigestHits: 0,
    testPipeGuards: 0,
    actions: {},
    replaceFailures: { total: 0, oldNotFound: 0, ambiguous: 0, lineStale: 0, other: 0 },
    patchFailures: { total: 0, oldNotFound: 0, ambiguous: 0, overlap: 0, other: 0 },
    fileOperationFailures: { total: 0, delete_file: 0, move_file: 0 },
    sequenceStrategyDecisions: { recommender: 0, planner: 0, total: 0 },
    patchActionPolicy,
    writeBatchEnabled: Boolean(writeBatch),
    probeEnabled: Boolean(probeEnabled),
    contractAssertionStationEnabled: assertionStationEnabled,
    cliVerificationEnabled: Boolean(cliContract),
    fileOperationPolicy,
    verificationPolicy,
    verificationTriggered: false,
    workspaceChanged: false,
    editedPaths: [],          // paths this run's edit actions changed, in first-touch order
    externalWorkspaceMutationEvents: 0,
    externalWorkspaceMutationPaths: 0,
    externalWorkspaceMutationBlockedActions: 0,
    repeatedFailureHints: 0,
    outcomeCycleEvents: 0,
    outcomeCycleHints: 0,
    derivedFailureContextHints: 0,
    lifecycleContractHints: 0,
    lifecycleContractDoneRejections: 0,
    completionAuditHints: 0,
    visualCompletionAuditHints: 0,
    visualCompletionAuditRevisions: 0,
    lexicalContractAuditHints: 0,
    visualAltCoverageHints: 0,
    visualAltCoverageRevisions: 0,
    stateAuditHints: 0,
    stateAuditEngagements: 0,
    stateAuditDoneDeferrals: 0,
    stateAuditProbeDiagnostics: 0,
    stateAuditPolicy,
    progressNudges: 0,
    progressGateRejections: 0,
    progressGateTerminations: 0,
    interactiveStopTerminations: 0,
    duplicateActionRejections: 0,
    duplicateShellRejections: 0,
    scopeMismatchNotices: 0,
    embeddedBaselineRecognitions: 0,
    successfulShellReplaySlims: 0,
    successfulShellReplayOmittedChars: 0,
    noOpEdits: 0,
    noOpStreak: 0,
    throughputAndons: 0,
    deliverableSteers: 0,
    repeatEscapeMasks: 0,
    wrapUpMasks: 0,
    capabilityHints: 0,
    infrastructureBlocks: 0,
    queryBudgetBlocks: 0,
    evidenceGateRejections: 0,
    previewGateRejections: 0,
    environmentVerificationRuns: 0,
    environmentVerificationPasses: 0,
    environmentVerificationRejections: 0,
    verifyDoneGateRuns: 0,
    verifyRedDoneRejections: 0,
    siblingSymbolRejections: 0,
    edgeSmokeRejections: 0,
    specExampleRejections: 0,
    lexicalSmokeRejections: 0,
    typeContractRejections: 0,
    verifyRedGateEvaluations: 0,
    siblingSymbolGateEvaluations: 0,
    familyConventionGateEvaluations: 0,
    edgeSmokeGateEvaluations: 0,
    specExampleGateEvaluations: 0,
    lexicalSmokeGateEvaluations: 0,
    typeContractGateEvaluations: 0,
    shellCreatedFileNotes: 0,
    landingNotes: 0,
    landingVerifies: 0,
    impactFooters: 0,
    familyFooters: 0,
    familyConventionRejections: 0,
    crossFileUsageNotes: 0,
    peerFunctionFooters: 0,
    selfCheckRejections: 0,
    implementationRespondRejections: 0,
    doneRejections: 0,
    ledgerRejections: 0,
    unverifiedEditRejections: 0,
    secretAuditRejections: 0,
    groundingRejects: 0,
    groundingStaleFiles: 0,
    groundingRefreshes: 0,
    groundingRefreshFailures: 0,
    groundingRefreshMs: 0,
    queries: 0,
    previewRuns: 0,
    previewPasses: 0,
    previewFailures: 0,
    artifactVerificationNudges: 0,
    artifactVerificationGateRejections: 0,
    artifactVerificationGateTerminations: 0,
    progresslessTurns: 0,
    maxProgresslessTurns: 0,
    tokens: 0,
    startedAt: nowMs(),
  };

  let done = false;
  let summary = null;
  let responded = false;   // the run ended with a conversational `respond`, not a task `done`
  let blocked = null;      // structured environment/policy block; distinct from done/interrupted
  let controllerStop = null; // a bounded controller stop is never accepted completion
  // Resilience: a model error must never crash the run. Transient errors are
  // retried in model.complete(); here we (a) shrink the included history on a
  // context-window overflow and retry, and (b) on any unrecoverable error end the
  // run cleanly so the workspace is still graded on the work done so far.
  let historyCap = Infinity;   // prompt turns to include; shrinks (monotonic) on overflow
  let modelError = null;       // set once when a completion is unrecoverable
  let lastCompleteError = null;
  let lastCompleteFailure = null;
  let terminalModelFailure = null;
  let completionAuditEmitted = turns.some((turn) => String(turn.observation ?? "").includes("[completion-audit]"));
  let visualCompletionAuditSnapshot = null;
  let visualCompletionAuditPaths = [];
  const visualAltCoverageHintedPaths = new Set();
  const visualAltCoverageSnapshots = new Map();
  const restoredStateAudit = [...turns].reverse().find((turn) => turn?.stateAudit)?.stateAudit ?? null;
  const legacyStateAuditIndex = turns.findLastIndex((turn) =>
    String(turn?.observation ?? "").includes(STATE_AUDIT_MARKER));
  let stateAuditIssued = Boolean(restoredStateAudit) || legacyStateAuditIndex >= 0;
  let stateAuditPending = restoredStateAudit
    ? restoredStateAudit.pending === true
    : legacyStateAuditIndex >= 0;
  let stateAuditTriggerCommand = restoredStateAudit?.triggerCommand ?? null;
  let stateAuditRiskPaths = Array.isArray(restoredStateAudit?.riskPaths)
    ? [...new Set(restoredStateAudit.riskPaths.filter((value) => typeof value === "string"))]
    : [];
  let stateAuditInitialRiskCount = Number.isInteger(restoredStateAudit?.initialRiskCount)
    ? Math.max(0, restoredStateAudit.initialRiskCount)
    : 0;
  let stateAuditEvidence = typeof restoredStateAudit?.evidence === "string"
    ? restoredStateAudit.evidence
    : null;
  let stateAuditDeferralsUsed = Number.isInteger(restoredStateAudit?.deferralsUsed)
    ? Math.max(0, restoredStateAudit.deferralsUsed)
    : turns.filter((turn) =>
        String(turn?.observation ?? "").startsWith(`${STATE_AUDIT_MARKER} Reading the source`)).length;
  metrics.stateAuditHints = Number.isInteger(restoredStateAudit?.hints)
    ? Math.max(0, restoredStateAudit.hints)
    : turns.filter((turn) => {
        const observation = String(turn?.observation ?? "");
        return observation.includes("[completion-audit]") && observation.includes(STATE_AUDIT_MARKER);
      }).length;
  metrics.stateAuditEngagements = Number.isInteger(restoredStateAudit?.engagements)
    ? Math.max(0, restoredStateAudit.engagements)
    : 0;
  metrics.stateAuditDoneDeferrals = stateAuditDeferralsUsed;
  if (!restoredStateAudit && legacyStateAuditIndex >= 0) {
    for (const turn of turns.slice(legacyStateAuditIndex + 1)) {
      if (stateAuditProbePassed(turn.action, {
        observation: turn.observation,
        configuredVerification: verificationScript,
        triggerCommand: stateAuditTriggerCommand,
        task,
      })) {
        stateAuditPending = false;
        stateAuditEvidence = "focused-probe";
      } else if (turnChangedWorkspace(turn)) {
        stateAuditPending = true;
        stateAuditEvidence = null;
      }
    }
  }
  const stateAuditSnapshot = () => ({
    pending: stateAuditPending,
    deferralsUsed: stateAuditDeferralsUsed,
    triggerCommand: stateAuditTriggerCommand,
    riskPaths: [...stateAuditRiskPaths],
    initialRiskCount: stateAuditInitialRiskCount,
    evidence: stateAuditEvidence,
    hints: metrics.stateAuditHints,
    engagements: metrics.stateAuditEngagements,
  });
  const gateCounts = Object.create(null);
  const unfinishedWorkspaceProbes = new Set();
  const warnings = [];
  const warned = new Set();
  let interactiveReconStreak = 0; // consecutive investigative turns (interactive spiral backstop)
  let investigationActionCount = 0; // caller-bounded read-only specialist reconnaissance
  let consecutiveDuplicates = 0;  // identical-action repeats in a row — a hard spiral signal that
                                  // should not wait out the full recon budget (observed: 13 deduped
                                  // identical inspects on an empty workspace before the mask engaged)
  for (let i = turns.length - 1; i >= 0
      && /\[(?:repetition|ledger)\]/.test(String(turns[i]?.observation ?? "")); i--) {
    consecutiveDuplicates++;
  }
  let forceBuildEdit = false;     // one-turn edit-only mask after the build-first veto: the veto is
                                  // capped, and a model that ate both vetoes just responded a third
                                  // time — masking respond for one turn makes write_file the only exit
  let documentRevisionRequired = false; // a concrete document audit gap becomes an edit, not advice
  let documentRevisionAfterAudit = false;
  let documentAuditRemediationActive = false;
  let blindEditStreak = 0; // consecutive successful edits with no verification run since (edit-blind spiral)
  let probeStreak = 0; // consecutive inline-eval probes with no suite/deliverable run (probe-blind spiral)
  let turnsSinceVerify = 0; // turns elapsed since the last verification, however filled (read-heavy spiral)
  let unverifiedEditSteerGiven = false; // the no-verify-command steer fires once per streak
  const visitedPaths = new Set(); // files the model actually opened or edited (sibling-definition done-gate)
  for (const preloadedPath of taskPreloadedPaths) visitedPaths.add(normalizeWorkspaceRel(preloadedPath));
  const editedSymbolSites = new Map(); // symbol -> file of the model's own edit (sibling-definition done-gate)
  let provenanceFooterFired = false;
  const impactSymbolsSeen = new Set(); // symbols already given an [impact]/[family] footer (once per run)
  const pendingFamilyFindings = new Map(); // added name -> family finding (family-convention done-gate)
  const echoedPaths = new Set(); // files whose slimmed placeholder the model copied — stop slimming them
  // Slimming an earlier read is keyed on the open-files panel, which is a SLIDING
  // WINDOW. Without this memo a file that leaves the window has its full body
  // RESTORED into history, so the transcript oscillates and the provider prefix
  // cache dies on almost every turn. Measured on a recorded gpt-5.6-terra run:
  // 10 un-slim events in 10 turns, 60,803 characters of prefix discarded, ~26% of
  // all cache misses. Once a body has been omitted it stays omitted; read_file
  // remains available, and the body was already hidden while the file was in-panel,
  // so nothing the model was relying on is taken away.
  const everSlimmedPaths = new Set();
  // Dependency index for blast-radius context, built once on first successful edit.
  // buildDependencyGraph walks and parses the whole tree, far too expensive to
  // repeat per write. Null until needed; false once a build fails, so it is not
  // retried every turn.
  let dependencyIndex = null;
  const blastRadiusEnabled = !/^(0|false|no|off)$/i.test(
    String(process.env.BANTAM_BLAST_RADIUS ?? ""),
  );
  const doubleEscapeWarned = new Set(); // paths already warned about double-escaped newlines (guard fires once per path)
  let bestPassed = -1, bestTotal = 0, bestSnapshot = null; // best-passing edited-file snapshot (regression guard)
  // Reverts across the WHOLE run, not just the current snapshot. The
  // per-snapshot counter resets every time a new best is taken, and on a task
  // whose deliverable IS new tests the passing count keeps rising, so the
  // stand-down never accumulates and the guard fights the repair forever.
  let regressionRevertsThisRun = 0;
  let revertsOfThisSnapshot = 0; // stand-down counter: the guard must not suppress repeated repair attempts
  let editsSinceBestSnapshot = 0; // no edits since the snapshot => a lower count is FLAKE, not regression
  let bestCommand = null;         // counts from a DIFFERENT test command are not comparable
  let firstMeasurementNoticeGiven = false;   // the run has said its first suite result cannot be attributed
  const failStreak = new Map();   // failing test name -> consecutive verifications it has failed
  const diagnosed = new Map();    // stuck test name -> failStreak value at its last diagnostic call
  const firstRedTurn = new Map(); // test name -> turn index when it FIRST went red (teacher turn-clock)
  let deepThinkGrant = false; // one-shot: a test stuck red x3 hands the NEXT think the deep budget (think-budget.js grant path)
  const turnRenderCache = new Map();  // frozen per-turn renders under the extension invariant (see prompt.js)
  let lastStableBuild = null;   // {prompt, end} of the previous build — the extension-invariant gauge compares against it
  const gaugeExtensionPrefix = (built) => {
    // Extension invariant, instrumented (timegrid five-whys, 2026-08-25):
    // under the extension trajectory every build must byte-extend the stable
    // (frozen) head of the previous one. A break is a retroactive history
    // rewriter — the class that cost two 43k re-prefills on card 15. Counted
    // and evented, never fatal: the gauge reads; the andon decides.
    const extensionOn = String(process.env.BANTAM_PROMPT_TRAJECTORY ?? "").toLowerCase() === "extension";
    if (!extensionOn) return built;
    const prev = lastStableBuild;
    const stableEnd = turnRenderCache.get(FROZEN_STABLE_END);
    if (prev && prev.end > 0) {
      const head = prev.prompt.slice(0, Math.min(prev.end, prev.prompt.length));
      if (!built.startsWith(head)) {
        let i = 0; const n = Math.min(head.length, built.length);
        while (i < n && head[i] === built[i]) i += 1;
        metrics.extensionPrefixBreaks = (metrics.extensionPrefixBreaks ?? 0) + 1;
        onEvent({ type: "extension_prefix_break", offset: i, stableEnd: prev.end });
      }
    }
    lastStableBuild = { prompt: built, end: Number.isInteger(stableEnd) ? stableEnd : 0 };
    return built;
  };
  const contextAuditSentinel = new ContextAuditSentinel(); // "context is always the problem" as a station
  const verifyCadenceSentinel = new VerifyCadenceSentinel({ threshold: positiveInt(process.env.BANTAM_VERIFY_CADENCE, 6) }); // 7R: sixty turns, zero suite runs
  let probeSteerCount = 0;
  const editedSourcePaths = new Set(); // for probe-discipline: has the run been editing source?
  const seeYourWorkSentinel = new SeeYourWorkSentinel(); // card 7: print the picture before editing it
  const repourSentinel = new RepourSentinel(); // maze films: stop patching, rewrite from the formula
  const contractArbitrationPin = new ContractArbitrationPin(); // falsefriend: name the contract owner before weakening a red assertion
  const walledGardenGauge = new WalledGardenGauge(); // no-net sandbox: recognize the wall, stop installing, adapt
  const teacherEscalated = new Set(); // stuck test names already escalated to the teacher (fire once each)
  let lastInteractiveNudge = 0;
  // Recon allowances scale with repo size (env overrides always win): the
  // fixture-tuned floors push toward editing before a large codebase's seams
  // have been located. workspaceSourceFiles is computed once at loop setup.
  const baseReconLimit = process.env.BANTAM_INTERACTIVE_RECON_LIMIT !== undefined
    ? positiveInt(process.env.BANTAM_INTERACTIVE_RECON_LIMIT, 14)
    // A seeded repository brief has already paid for whole-tree discovery.
    // Six targeted follow-ups are enough to check the proposed seam; applying
    // the ordinary large-repo allowance here recreated the 30+ turn analysis
    // spiral the automatic brief exists to remove.
    : (automaticRepositoryBriefEnabled ? 6 : scaledReconLimit(14, workspaceSourceFiles));
  // Diagnosis is reconnaissance. A change-shaped request (fix/build verbs, or
  // a bug report naming a behavior and its failure) gets double the streak
  // allowance before the wrap-up mask — the turn budget stays the ceiling.
  const interactiveReconLimit = isChangeShapedRequest(task) ? baseReconLimit * 2 : baseReconLimit;
  let consecutiveInteractiveStops = 0; // consecutive turns the model ignored the investigation stop
  const interactiveStopMax = positiveInt(process.env.BANTAM_INTERACTIVE_STOP_MAX, 6); // then hard-stop
  let progresslessTurns = 0;   // consecutive turns without edit/artifact/verification progress
  // Whether anything has been edited since the last credited verification. Rerunning
  // an unchanged suite is not new evidence; crediting it as progress resets
  // progresslessTurns and makes the anti-spiral gate unreachable in a read -> test
  // loop. Starts true so the first verification of a run is always credited.
  let workspaceChangedSinceVerification = true;
  let lastProgressNudgeAt = 0;
  let artifactNeedsVerification = false;
  let nonDocumentArtifactNeedsVerification = false;
  const pendingDocumentArtifacts = new Set();
  let turnsSinceArtifact = 0;
  const repetition = new RepetitionGuard({
    enabled: dedupeActions, dedupeShell, dedupeQuery,
    // The dedup steer may only name `map` when the registry has it.
    mapAvailable: Boolean(tools?.get("map")),
  });
  // Live andon on prompt-prefix cache reuse. Feeds telemetry, not the model: a
  // KV-cache miss is a harness/context problem the model cannot fix (see
  // throughput-andon.js and the 2026-08-20 immutable-history audit).
  const throughputAndon = createThroughputAndonState();
  // Commit-to-deliverable gauge: steer when the task's named source file still
  // does not exist after prolonged probing (TB2 gpt2: 227 fast actions on a
  // throwaway inspect.c, gpt2.c never written → 0). See deliverable.js.
  const deliverableState = createDeliverableState();
  // Wheelbarrow gauge: steer when the model has run the whole deliverable many
  // times with no separate verifier/oracle in the workspace (scaffold-gate.js).
  const scaffoldState = createScaffoldState();
  // Many point edits to ONE file: a loop run by hand, where no single edit can
  // check the whole-file invariant the grader applies (bulk-edit-gate.js).
  const bulkEditState = createBulkEditState();
  // Same-bug stall gauge: after the identical sanitizer bug recurs N times, steer
  // to isolate+unit-test that exact function (bug-stall.js).
  const bugStallState = createBugStallState();
  // Throwaway-script churn gauge: steer when the model hand-cranks an iteration by
  // writing dbg1/dbg2/... one per turn instead of scripting the loop (script-churn.js).
  const churnState = createChurnState();
  const readLedger = new ReadLedger();  // union of line ranges already read, per file
  const recordReadDelivery = (turn, observation, panelText) => {
    // Only the newest turn can add coverage: older snapshots may predate an
    // edit. This callback receives the scrubbed, clipped model-facing body,
    // not an executor header promising a range that clipping removed.
    const latest = turns.at(-1);
    if (turn !== latest && !(Number.isInteger(turn?.i) && turn.i === latest?.i)) return;
    const action = turn.action ?? turn.parsedAction;
    const ops = action?.a === "inspect" ? action.ops : [action];
    const panel = panelRenderedRanges(panelText);
    for (const op of ops ?? []) {
      if (op?.a !== "read_file") continue;
      const range = deliveredReadRange(op, observation);
      if (range) readLedger.note(op.p, range.start, range.end, range.total);
      // A slimmed read can be supplied by the actual current panel instead.
      // Credit only this requested region, not every file the panel happens
      // to contain. WS0 supplies no panelText and cannot enter this route.
      const entry = panel.get(op.p);
      if (!entry) continue;
      const start = Number.isInteger(op.start) ? op.start : 1;
      const end = Math.min(entry.total, Number.isInteger(op.limit)
        ? start + op.limit - 1 : (Number.isInteger(op.start) ? start + START_WINDOW - 1 : entry.total));
      for (const [from, to] of entry.ranges) {
        if (Math.max(start, from) <= Math.min(end, to)) {
          readLedger.note(op.p, Math.max(start, from), Math.min(end, to), entry.total);
        }
      }
    }
  };
  // A resumed observation is pre-render text, not a delivery receipt. Start
  // coverage empty; the next actual render records what is available now.
  const workspaceCoherence = new WorkspaceCoherenceTracker(workspace);
  const pendingExternalChanges = new Set();
  const restoredWorkspaceCoherence = [...turns].reverse()
    .find((turn) => turn?.workspaceCoherence)?.workspaceCoherence ?? null;
  if (restoredWorkspaceCoherence) {
    workspaceCoherence.restore(restoredWorkspaceCoherence.fingerprints);
    for (const changedPath of restoredWorkspaceCoherence.pendingPaths ?? []) {
      if (typeof changedPath === "string") pendingExternalChanges.add(normalizeWorkspaceRel(changedPath));
    }
  } else if (turns.length) {
    // Legacy checkpoints predate byte fingerprints. Their old observations
    // cannot prove the current files are unchanged, so discard restored read
    // coverage and require current-state reasoning for every prior read path.
    readLedger.clear();
    const legacyReadPaths = [...new Set(turns.flatMap(successfulReadPaths))]
      .map(normalizeWorkspaceRel)
      .filter(Boolean);
    workspaceCoherence.watch(legacyReadPaths);
    for (const changedPath of legacyReadPaths) pendingExternalChanges.add(changedPath);
  }
  const pagedReads = new Map();         // path -> windowed reads (sequential-paging detector)
  let staleInspectStreak = 0;           // consecutive mostly-ledger-covered inspect batches (shuffle detector)
  const outcomeCycles = new OutcomeCycleTracker();
  const derivedFailureFingerprints = new Set();
  const capabilityHints = new Set();   // one substrate nudge per capability, per run
  const queryBudget = new QueryProgressBudget();   // bounded progress credit for substrate queries
  let consecutiveProgressGateRejections = 0;
  let consecutiveArtifactVerificationGateRejections = 0;
  // One-turn grammar correction after a provably zero-information move. Text
  // alone did not break recorded duplicate/paging loops; removing the rejected
  // verb once makes the next action choose a different source of information.
  const resumedCorrection = turns.at(-1);
  let nextMaskedVerb = useGrammar
    && /\[(?:repetition|paging|ledger)\]/.test(String(resumedCorrection?.observation ?? ""))
    && typeof resumedCorrection?.action?.a === "string"
    ? resumedCorrection.action.a
    : null;
  // A repeated exact-match failure is a byte-reproduction problem, not a
  // reasoning problem. Preserve that controller fact across the next read (and
  // across rewind/resume) until an edit really lands. While active, the prompt
  // exposes line-pointer editing and the grammar removes the failed
  // exact-match route.
  let editRecoveryPath = null;
  // The target of ANY refused edit, pinned into the panel until an edit lands.
  //
  // editRecoveryPath is deliberately narrower — it means "an exact-match edit
  // failed", and drives the stale-anchor grammar and the EDIT RECOVERY ACTIVE
  // notice, neither of which is true of a syntax refusal. But the panel
  // consequence is identical: a file the model is trying to edit and cannot see
  // is one it must edit blind, and the seam focus set for a refused edit has no
  // entry to attach to when the file is not in the packet at all.
  //
  // tb23 (2026-08-17) refused six consecutive edit_lines on src/fixture-runner.js
  // for syntax while that file was absent from the panel on every one of those
  // turns. Every edit it made to a file IN the panel landed; every edit to a
  // file outside it failed. The run reached its test suite once in 60 turns.
  let refusedEditPin = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const prior = turns[i];
    if (turnEditApplied(prior)) break;
    const priorAction = prior.action || prior.parsedAction;
    const failedPath = failedEditPath(priorAction, prior.observation);
    if (failedPath) {
      editRecoveryPath = failedPath;
      refusedEditPin = refusedEditPin ?? failedPath;
      break;
    }
    if (!refusedEditPin && isEditAction(priorAction) && typeof priorAction?.p === "string"
        && /^ERROR\b/.test(String(prior.observation ?? ""))) {
      refusedEditPin = priorAction.p;
    }
  }
  let workspaceChangedDuringRun = false;
  let hasAuthoredWork = false;
  const knownArtifacts = new Set(taskOutputPaths);
  // Frozen copy: what the TASK itself names as its output. knownArtifacts grows
  // as the run produces likely-artifact files, which is right for relevance
  // (isVerificationShellCommand) and wrong for ENFORCEMENT — the artifact
  // verification gate must only arm over deliverables the task asked for. Two
  // arms of the budget A/B were terminated over a baseline capture the task
  // told the model to make: the second had its write_file src/*.js — the actual
  // refactor — rejected four times as "avoiding validating the draft artifact".
  const taskNamedArtifacts = new Set(knownArtifacts);
  // Rewind restores controller obligations as well as transcript prose. A
  // post-green document audit must still require its revision when execution
  // resumes at that exact decision point.
  for (const turn of turns) {
    const prior = turn?.action;
    const changedPaths = [
      ...(turnEditApplied(turn) ? editPaths(prior) : []),
      ...(Array.isArray(turn?.shellChangedPaths) ? turn.shellChangedPaths : []),
    ];
    if (changedPaths.length) {
      workspaceChangedDuringRun = true;
      hasAuthoredWork = true;
    }
    const changedDocuments = changedPaths
      .filter((candidate) => knownArtifacts.has(candidate) && isDocumentArtifactPath(candidate));
    if (changedDocuments.length) {
      if (documentRevisionRequired) documentRevisionRequired = false;
      for (const document of changedDocuments) pendingDocumentArtifacts.add(document);
    }

    const observation = String(turn?.observation ?? "");
    if (observation.includes("[completion-audit]")) {
      for (const document of knownArtifacts) {
        if (isDocumentArtifactPath(document)) pendingDocumentArtifacts.add(document);
      }
      if (planAuditPolicy.enabled && pendingDocumentArtifacts.size) {
        documentRevisionAfterAudit = true;
        documentAuditRemediationActive = true;
      }
    }

    if (observation.includes("Document review context:")) {
      const reviewed = documentArtifactReviewPaths(prior, {
        knownArtifacts: [...pendingDocumentArtifacts],
      });
      for (const document of reviewed) pendingDocumentArtifacts.delete(document);
      if (reviewed.length && pendingDocumentArtifacts.size === 0) {
        const reviewHasGaps = documentArtifactReviewHasGaps(observation);
        if (documentRevisionAfterAudit) documentRevisionAfterAudit = false;
        if (reviewHasGaps) {
          documentAuditRemediationActive = true;
          documentRevisionRequired = true;
        } else if (documentAuditRemediationActive) {
          documentAuditRemediationActive = false;
        }
      }
    }
  }
  let workspaceEditGeneration = turns.reduce(
    (generation, turn) => generation + (turnChangedWorkspace(turn) ? 1 : 0),
    0,
  );
  // Restore the same serial browser-defect obligation on rewind/resume. The
  // preview proof is trusted state; later edits merely make it due for a
  // recheck, while a later preview rebuilds or closes the queue.
  let previewFailureSequence = null;
  for (const turn of turns) {
    if (turn?.preview) {
      previewFailureSequence = refreshPreviewFailureSequence(
        turn.preview,
        turn.action?.q,
        previewFailureSequence,
      );
    } else if (previewFailureSequence && turnChangedWorkspace(turn)) {
      previewFailureSequence = notePreviewFailureEdit(previewFailureSequence);
    }
  }
  let environmentVerificationProof = [...turns].reverse().find((turn) =>
    turn?.environmentVerification?.generation === workspaceEditGeneration
  )?.environmentVerification ?? null;
  // Latest verify_red done-gate run: { generation, command, verification }.
  // Lets a repeat done on an untouched tree bounce without re-paying the suite,
  // and lets the terminal verification reuse a gate result instead of rerunning.
  let doneVerificationProof = null;
  const repeatedSymbolSearches = new Map();   // bare identifier -> times searched this run
  // The landing window is ~10% of the budget, so the untouched-requirement
  // clause below would otherwise repeat on every one of the last ~7 turns.
  // tb24 (2026-08-17) spent its endgame being told seven times that "the task
  // names src/agent.js and this run has not edited it yet" — a path the ticket
  // mentions once, parenthetically, describing what ALREADY exists ("the first
  // refusal now names the editable paths (src/agent.js editScopeRefusal)").
  // The model had built its fix as a new module plus fixture-runner wiring,
  // which was a legitimate reading. Say it when the landing window opens and
  // once more on the final turn; the countdown itself still comes every turn.
  let untouchedNoticeGiven = false;
  artifactNeedsVerification = nonDocumentArtifactNeedsVerification || pendingDocumentArtifacts.size > 0;
  let lastEditRegion = null;  // {path, start, lines} — where the last edit_lines landed
  const deliverable = deliverableCommand(task);   // the command the task asks us to BUILD
  let ranDeliverable = false;

  let smokeNudged = false;
  let editCount = 0;
  let midpointNoticeGiven = false;
  let connectRetries = 0;   // run-level reconnects: one flaky TCP moment must not kill a 60-turn run
  let editsSinceFullVerify = 0;   // edits the configured verifier has not run against
  const editedPathsThisRun = new Set();   // for the landing note's untouched-requirement check
  let contractAudits = turns.filter((turn) => turn.contractStateAudit).length;
  // A resumed film is retained for audit, but does not grant live CLI authority.
  // Obtain a fresh isolated receipt on the current invocation/tree.
  let cliVerification = null;
  const cliStationGenerations = new Set();
  const auditRecoveryVerifications = new Set(turns.flatMap(turn =>
    (Array.isArray(turn.verificationReceipts?.entries) ? turn.verificationReceipts.entries : []).flatMap(entry => {
      const proof = entry?.verificationEvidence;
      return proof?.source === "automatic" && proof.auditPromptSha256
        ? [`${proof.auditPromptSha256}:${proof.generation}:${proof.configuredCommand}`] : [];
    })));
  let lastContractAuditGeneration = turns.filter((turn) => turn.contractStateAudit).at(-1)?.contractStateAudit?.generation ?? -1;
  // History is evidence, not a second repository copy. Current seams live in
  // the bounded file panel below; keeping the entire old 180KB transcript made
  // the useful fact progressively harder for a small model to see.
  // The extension trajectory has no panel and trades prompt size for byte-
  // stable prefixes, so its default budget is wider: an eviction slides the
  // history window and silently resets the slot cache to the head checkpoint.
  const historyCharBudget = positiveInt(
    process.env.BANTAM_HISTORY_CHAR_BUDGET,
    extensionTrajectory ? 120000 : 36000,
  );
  // Turn-level replay capture: with BANTAM_SAVE_PROMPTS=1 every turn records
  // its exact assembled prompt, so `bantam replay <artifact> --turn N` can
  // rewind to the precise moment of a failure and test context adjustments.
  const savePrompts = /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_SAVE_PROMPTS ?? ""));
  let lastPromptForTurn = null;
  // Set only after a generation has been SEEN to collapse into a repeated
  // fragment; cleared as soon as a valid action parses. A first attempt is
  // never penalised, because repeated tokens are correct in code.
  let degeneratePenalty = 0;
  const capTurns = (h) => budgetTurns(
    Number.isFinite(historyCap) ? h.slice(-Math.max(1, historyCap)) : h,
    { charBudget: historyCharBudget, pinHead: extensionTrajectory },
  );
  // Count the rendered bytes, not an annotation that might have been clipped.
  // This boundary is the exact prompt passed to ModelClient, NOT evidence that
  // a remote server accepted or attended to it. Raw request films independently
  // establish transport delivery. Bound receipts and only record status changes.
  const contextUpdateStatuses = new Map();
  const includedContextUpdates = new Set();
  const noteContextUpdatePrompt = (prompt) => {
    let promptSha256 = null;
    for (const turn of turns) {
      for (const update of Array.isArray(turn.contextUpdates) ? turn.contextUpdates.slice(0, 2) : []) {
        const block = contextUpdatePromptText(update, promptTemplate);
        if (!block) continue;
        const status = prompt.includes(block) ? "included" : "not-in-prompt";
        if (contextUpdateStatuses.get(update.id) === status) continue;
        contextUpdateStatuses.set(update.id, status);
        if (status === "included" && !includedContextUpdates.has(update.id)) {
          includedContextUpdates.add(update.id);
          metrics.contextUpdatesIncluded++;
        }
        if (status !== "included") metrics.contextUpdatesOmitted++;
        if (metrics.contextUpdatePromptReceipts.length >= 256) continue;
        promptSha256 ??= crypto.createHash("sha256").update(prompt).digest("hex");
        const receipt = {
          id: update.id, kind: update.kind, generation: update.generation,
          status, boundary: "prepared-prompt", chars: block.length, promptSha256,
          modelCallIndex: typeof model.requestCursor === "function" ? model.requestCursor() : null,
        };
        metrics.contextUpdatePromptReceipts.push(receipt);
        onEvent({ type: "context_update_prompt", ...receipt });
      }
    }
  };
  const safeComplete = async (makePrompt, completeOpts) => {
    for (let shrink = 0; shrink < 8; shrink++) {
      try {
        const withPenalty = degeneratePenalty
          ? { ...completeOpts, presencePenalty: degeneratePenalty }
          : completeOpts;
        const prompt = makePrompt();
        noteContextUpdatePrompt(prompt);
        const out = await model.complete(prompt, signal ? { ...withPenalty, signal } : withPenalty);
        // The server does not THROW when the prompt overruns the slot — it
        // silently trims the prompt to fit and returns a generation cut short,
        // flagged only by `truncated: true`. So the context_overflow shrink below
        // never fired for the failure it exists for: tune-mjcf reached turn 76
        // with a 47.8k prompt on a 48k slot and every generation thereafter was
        // cut after a few hundred tokens, each one rejected as unterminated JSON,
        // ~2.5 minutes apiece, with no signal anywhere bantam could see.
        // Treat the flag exactly as the thrown error is treated: halve history.
        if (out?.truncated && shrink < 7) {
          const base = Number.isFinite(historyCap) ? historyCap : turns.length + 1;
          historyCap = Math.max(1, Math.floor(base / 2));
          metrics.contextTrims = (metrics.contextTrims ?? 0) + 1;
          onEvent({ type: "context_trim", historyCap, cause: "truncated", promptTokens: out.promptTokens ?? null });
          continue;
        }
        return out;
      } catch (e) {
        lastCompleteError = e.message;
        lastCompleteFailure = {
          message: e?.message ?? String(e),
          code: typeof e?.code === "string" ? e.code : null,
          provider: typeof e?.provider === "string" ? e.provider : null,
          timeoutKind: typeof e?.timeoutKind === "string" ? e.timeoutKind : null,
          retryable: typeof e?.retryable === "boolean" ? e.retryable : null,
        };
        if (e.code === "aborted" || signal?.aborted) {
          markInterrupted("model");
          return null;
        }
        if (e.code === "context_overflow") {
          const base = Number.isFinite(historyCap) ? historyCap : turns.length + 1;
          historyCap = Math.max(1, Math.floor(base / 2));
          metrics.contextTrims = (metrics.contextTrims ?? 0) + 1;
          onEvent({ type: "context_trim", historyCap });
          continue;
        }
        // Connection-shaped failure with a server that may be back in seconds:
        // two runs died tonight (2026-08-18) on a single "fetch failed" — one
        // to a real OOM'd server, one to a transient blip while the server log
        // showed continuous uptime. Back off and re-ask up to three times at
        // run level before giving up; a real outage still fails in ~35s.
        if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(e?.message)) && connectRetries < 3) {
          connectRetries += 1;
          const waitMs = 5000 * 2 ** (connectRetries - 1);
          onEvent({ type: "model_reconnect_wait", attempt: connectRetries, waitMs });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        return null; // transient/unrecoverable after model.complete()'s own retries
      }
    }
    return null; // still overflowing at minimum history
  };

  const detectExternalWorkspaceChanges = (phase) => {
    const changed = workspaceCoherence.scan()
      .map(normalizeWorkspaceRel)
      .filter(Boolean);
    if (!changed.length) return [];

    for (const changedPath of changed) {
      pendingExternalChanges.add(changedPath);
      readLedger.invalidate(changedPath);
      pagedReads.delete(changedPath);
      focusByPath.delete(changedPath);
      mutationFocusByPath.delete(changedPath);
    }
    repetition.noteWorkspaceChanged();
    workspaceChangedDuringRun = true;
    workspaceEditGeneration++;
    metrics.workspaceChanged = true;
    metrics.externalWorkspaceMutationEvents++;
    metrics.externalWorkspaceMutationPaths += changed.length;
    outcomeCycles.noteWorkspaceChanged();

    // These proofs and rollback bytes describe the prior filesystem state.
    // Never let a cached green result or regression restore overwrite a human
    // edit that arrived outside BANTAM's executor.
    environmentVerificationProof = null;
    doneVerificationProof = null;
    latestPreviewProof = null;
    bestSnapshot = null;
    bestPassed = -1;
    bestTotal = 0;
    bestCommand = null;
    editsSinceBestSnapshot = 0;
    automaticRepositoryBriefRevision = null;
    if (previewFailureSequence) {
      previewFailureSequence = notePreviewFailureEdit(previewFailureSequence);
    }

    if (ground) {
      const refreshed = refreshGrounding(ground, changed);
      metrics.groundingRefreshMs += refreshed.ms ?? 0;
      metrics.groundingStaleFiles = ground.staleFiles.size;
      if (refreshed.ok) {
        if (refreshed.refreshed.length) metrics.groundingRefreshes++;
      } else {
        metrics.groundingRefreshFailures++;
      }
      if (groundingMap && !extensionTrajectory) map = codeMap(ground);
    }
    // The environment listing lives in the frozen head under the extension
    // invariant; the external-change observation and reanchor carry the news
    // instead of a head rewrite that would invalidate the whole cached prefix.
    if (!extensionTrajectory) {
      const listing = safeListing(workspace);
      env = withVerificationNote(map ? `${map}\n\n${listing}` : listing);
    }
    onEvent({ type: "external_workspace_change", phase, paths: changed });
    return changed;
  };

  // Extension-trajectory fold state: guidance that would render in the (absent)
  // volatile tail is appended once to the newest observation when it changes;
  // the head's plan/skills text is frozen at the first build so the shared
  // prefix never rewrites.
  let lastFoldedGuidance = "";
  // The task's named outputs, read once from its literal text. Empty for tasks
  // that name none, which is most of them.
  const requiredOutputs = requiredOutputPaths(task);
  // The wall-clock budget this run is actually killed on. Harbor enforces it and
  // BANTAM never knew it existed; the adapter passes it in.
  const wallBudgetMs = positiveInt(process.env.BANTAM_WALL_BUDGET_MS, 0);
  const runStartedAtMs = Date.now();
  let deliverableNotices = 0;
  let providedOracleNoticed = false;
  const rewriteRefusedOnce = new Set();
  let lastThinkSevered = false;
  let extensionHeadSkillsText = null;
  let extensionHeadPlanText = null;
  let extensionHeadRepositoryText = null;
  // Decision snapshot (opt-in candidate, extension mode): at verify-green,
  // fold the current bytes of the files this run edited back into view. The
  // 2026-08-12 channel-filter forensics found the failing decision had the
  // contract 680 chars away but the model's own edited code nowhere in recent
  // context — rebuild's panel supplies exactly that adjacency, and both its
  // runs caught the residual coercion where both extension runs missed it.
  const decisionSnapshot = envTruthy(process.env.BANTAM_DECISION_SNAPSHOT);
  const restoredContextUpdates = turns.flatMap((turn) => Array.isArray(turn.contextUpdates) ? turn.contextUpdates : [])
    .filter((update) => contextUpdatePromptText(update, promptTemplate));
  let lastSnapshotGeneration = restoredContextUpdates
    .filter((update) => update?.kind === "decision").at(-1)?.generation ?? null;
  const recoverySnapshotKeys = new Set(restoredContextUpdates
    .filter((update) => update?.kind === "edit-recovery")
    .flatMap((update) => (update.paths ?? []).map((entry) => `${entry.path}:${update.generation}`)));
  let terminalClosureAvailable = false;
  while ((turns.length < maxTurns || terminalClosureAvailable) && !done && !interrupted) {
    const terminalClosureTurn = turns.length >= maxTurns && terminalClosureAvailable;
    if (terminalClosureTurn) terminalClosureAvailable = false;
    let executionShadowPhaseForTurn = null;
    let executionShadowBoundariesForTurn = [];
    // Context recovery (AIMD): if a past overflow trimmed history (historyCap went finite), gently
    // probe for more each turn. The overflow handler's multiplicative halving is the backstop if we
    // overreach — so one transient overflow no longer cripples the rest of a long run permanently.
    if (Number.isFinite(historyCap)) {
      const next = historyCap + 2;
      historyCap = next >= turns.length ? Infinity : next;   // reached full history -> uncap
      onEvent({ type: "context_grow", historyCap: Number.isFinite(historyCap) ? historyCap : null });
    }
    // Live control: let the user stop, or steer, between turns.
    if (abortRequested()) { markInterrupted("between_turns"); break; }
    if (drainInjections) {
      const msgs = drainInjections();
      for (const m of (msgs || [])) {
        if (!m) continue;
        // Kind-aware framing: the attendant's own replies must not read as
        // user text, or the worker re-answers and the single-agent illusion
        // tears (operator design, 2026-08-19).
        turns.push({ action: null, observation: frameInjection(m) });
        onEvent({ type: "injection", message: typeof m === "string" ? m : m.text, kind: typeof m === "string" ? "user" : m.kind });
      }
      if (terminalClosureTurn && (msgs || []).some(Boolean)) break;
    }
    onEvent({ type: "turn_start", turn: metrics.turns });
    detectExternalWorkspaceChanges("turn_start");
    if (terminalClosureTurn) {
      if (workspaceEditGeneration !== metrics.terminalClosure.generation || pendingExternalChanges.size
          || doneVerificationProof?.verification?.status !== "pass") {
        onEvent({ type: "terminal_closure", phase: "revoked", reason: "verification-generation-changed" });
        break;
      }
      metrics.terminalClosure.used = true;
      metrics.terminalClosure.usedTurn = turns.length;
      onEvent({ type: "terminal_closure", phase: "used", ...metrics.terminalClosure });
    }
    const maskedVerbForTurn = nextMaskedVerb;
    nextMaskedVerb = null;
    const documentRevisionTurn = documentRevisionRequired;
    const documentReviewTurn = pendingDocumentArtifacts.size > 0 && !documentRevisionTurn;
    const lineEditRecoveryTurn = Boolean(editRecoveryPath);
    const turnActionFeatures = [
      ...baseActionFeatures,
      ...(!baseActionFeatures.includes(LINE_EDIT_FEATURE)
        && (documentRevisionTurn || lineEditRecoveryTurn)
        ? [LINE_EDIT_FEATURE]
        : []),
    ];
    // Once the interactive investigation budget is spent, drop the investigative verbs from the
    // grammar so the model CANNOT read another file — it must answer or edit. A message the model
    // can ignore becomes a grammar it cannot; this ends the "reads everything, never answers"
    // spiral, and since it can no longer investigate, the budget notice and hard-stop stop firing.
    // Autonomous force-edit: mask recon verbs once the model has spent too many progressless turns,
    // so it commits to a first edit instead of re-emitting blocked reads until the gate terminates it.
    const autoForceEdit = shouldForceDraftEdit({
      interactive,
      useGrammar,
      progressAwareness,
      autoForceEditAfter,
      progresslessTurns,
      sourceProvenanceRequired: Boolean(sourceProvenance),
      hasAuthoredWork,
    });
    // A hard duplicate spiral (the SAME action deduped 3+ times in a row) engages the wrap-up mask
    // immediately — text steering escalated 13 times without effect in the observed case, and each
    // ignored repeat costs a full model call.
    // The 3-bounce duplicate breaker applies in BOTH modes: the autonomous
    // self-hosting runs looped on deduped repeats with the breaker gated
    // interactive-only (v2: 15 bounces; v3: 10 subrange re-reads).
    const recoveryEvidence = latestVerificationRecovery(turns);
    const auditRecovery = collectionAuditEnabled
      ? pendingContractAudit(turns, { generation: workspaceEditGeneration,
        configuredCommand: verificationScript, verificationWorkspaceReadOnly, workspace: exec.realWorkspace }) : null;
    const cliDecision = cliContract ? cliVerificationDecisionContext(cliContract, cliVerification, {
      generation: workspaceEditGeneration,
    }) : null;
    const contractAuditPhase = contractAuditPhaseState(cliDecision
      ? { ...auditRecovery, needsCli: true, configuredCommand: verificationScript } : auditRecovery, {
      useGrammar, interactive, advisoryMode, writeBatch, callerExcludedActions,
    });
    const auditWitness = collectionAuditEnabled && !auditRecovery
      ? currentFocusedAuditWitness(turns, { generation: workspaceEditGeneration,
        configuredCommand: verificationScript, verificationWorkspaceReadOnly, workspace: exec.realWorkspace }) : null;
    const currentFailure = currentConfiguredFailure(turns, {
      generation: workspaceEditGeneration, configuredCommand: verificationScript, workspace: exec.realWorkspace,
    });
    // Measured failure outranks model hypotheses, even hypotheses written later.
    // Structural facts explain current source only: they supply no expected
    // values, candidate edits, successful evidence, or completion authority.
    const failureSourceFacts = currentFailure ? currentFailureSourceFacts(turns, exec) : [];
    const currentCliFailed = cliVerification?.generation === workspaceEditGeneration && cliVerification?.status === "failed";
    let verificationWorkflow = currentFailure && !currentCliFailed
      ? { ...verificationFailureContext(currentFailure, { facts: failureSourceFacts.map(formatObjectConstructionFacts) }),
        sourceFacts: failureSourceFacts }
      : cliDecision ?? (collectionAuditEnabled ? contractAuditDecisionContext(auditRecovery, auditWitness) : null);
    if (cliDecision && verificationWorkflow === cliDecision) {
      try {
        const filename = exec.resolveExisting(cliContract.module), stat = fs.lstatSync(filename);
        if (stat.isFile() && stat.size <= 256 * 1024) {
          const facts = collectNodeCliRoutingFacts({ source: fs.readFileSync(filename, "utf8"), path: cliContract.module });
          const note = facts ? formatNodeCliRoutingFacts(facts) : "";
          if (note && verificationWorkflow.text.length + note.length + 1 <= 2400)
            verificationWorkflow = { ...verificationWorkflow, text: verificationWorkflow.text + "\n" + note, sourceFacts: [facts] };
        }
      } catch { /* Source facts are advisory, never acceptance authority. */ }
    }
    const stalledAfterAuthoredWork = hasAuthoredWork && progressAwareness
      && autoForceEditAfter > 0 && progresslessTurns >= autoForceEditAfter;
    const callerInvestigationLimitReached = useGrammar && callerInvestigationActionLimit !== null
      && investigationActionCount >= callerInvestigationActionLimit;
    const verificationRecoveryTurn = useGrammar && (consecutiveDuplicates >= 3 || stalledAfterAuthoredWork)
      && Boolean(recoveryEvidence || auditRecovery) && !autoForceEdit && !forceBuildEdit
      && !documentRevisionTurn && !documentReviewTurn
      && !callerInvestigationLimitReached && !callerExcludedActions.includes("shell")
      && !(interactive && interactiveReconStreak >= interactiveReconLimit)
      && maskedVerbForTurn !== "shell";
    const forceWrapUp = (useGrammar && consecutiveDuplicates >= 3)
      || verificationRecoveryTurn
      || (interactive && useGrammar && interactiveReconStreak >= interactiveReconLimit)
      // The last two turns of an interactive budget are for LANDING, not
      // looking. The typewriter PWA replay got six advisory countdown notes
      // and was still grepping at t60, then paused with no summary and no
      // "Next:" line (chat r1 @ 2026-08-17T23:24). Words steer 1/3 of the
      // time; the mask lands 3/3 — recon off, write/done/respond stay live.
      || (interactive && useGrammar && maxTurns - turns.length - 1 <= 1)
      || callerInvestigationLimitReached
      || autoForceEdit;
    // Compose every active per-turn mask into one exclusion set (turn-mask.js). The composition is
    // pure and unit-tested there; the anti-trap invariant that keeps read_file available on
    // document-only turns lives there too, so a co-active wrap-up mask can no longer re-exclude it.
    const requestedExclusions = composeExcludeVerbs({
      useGrammar,
      baseExcludeVerbs: callerExcludedActions,
      forceWrapUp,
      verificationRecoveryTurn,
      forceBuildEdit,
      documentRevisionTurn,
      documentReviewTurn,
      lineEditRecoveryTurn,
      maskedVerbForTurn,
      patchEnabled: patchActionPolicy.enabled,
    });
    // A fixture experiment is investigation, never an escape from edit-only,
    // source-review, or wrap-up masks. Keep this candidate opt-in and local.
    if (useGrammar && ((forceWrapUp && !verificationRecoveryTurn) || forceBuildEdit || documentRevisionTurn
        || documentReviewTurn || (lineEditRecoveryTurn && !verificationRecoveryTurn))) requestedExclusions.push("probe");
    // Caller policy is expressed against the complete protocol so dynamically
    // enabled verbs (patch/edit_lines/file ops) cannot escape it. Grammar/schema
    // generation is stricter: it rejects exclusions for verbs that are not
    // enabled on this exact turn. Intersect only for schema construction; the
    // full callerExcludedActions list still guards parsed actions at execution.
    const enabledTurnVerbs = new Set(
      enabledActionDefinitions({ features: turnActionFeatures })
        .map((definition) => definition.verb),
    );
    const excludeThisTurn = [...new Set([...(terminalClosureTurn
      ? [...callerExcludedActions, ...[...enabledTurnVerbs].filter(verb => verb !== "done")]
      : requestedExclusions), ...contractAuditPhase.excludeVerbs])]
      .filter((verb) => enabledTurnVerbs.has(verb));
    // Never solve an empty intersection by restoring an impossible completion
    // or a caller-forbidden tool. inspect cannot act without a legal sub-verb.
    if (useGrammar && contractAuditPhase.active
        && ![...enabledTurnVerbs].some(verb => verb !== "inspect" && !excludeThisTurn.includes(verb))) {
      controllerStop = { kind: "contract-audit-no-action", reason: "No legal action remains while contract audit execution proof is pending." };
      summary = controllerStop.reason;
      onEvent({ type: "controller_stop", ...controllerStop });
      break;
    }
    // The forceBuildEdit veto is a single-turn escalation: consume it once the mask has been composed.
    if (forceBuildEdit && useGrammar) forceBuildEdit = false;
    if (documentRevisionTurn && useGrammar) {
      onEvent({ type: "document_revision_mask" });
    } else if (documentReviewTurn && useGrammar) {
      onEvent({ type: "document_review_mask", documents: [...pendingDocumentArtifacts] });
    }
    if (lineEditRecoveryTurn && useGrammar) {
      onEvent({ type: "edit_recovery_mask", path: editRecoveryPath });
    }
    const turnActionGrammar = excludeThisTurn.length || turnActionFeatures.length
      ? actionGrammar({ excludeVerbs: excludeThisTurn, features: turnActionFeatures })
      : ACTION_GRAMMAR;
    const turnActionJsonSchema = excludeThisTurn.length || turnActionFeatures.length
      ? actionJsonSchema({ excludeVerbs: excludeThisTurn, features: turnActionFeatures })
      : ACTION_JSON_SCHEMA;
    if (maskedVerbForTurn) {
      metrics.repeatEscapeMasks++;
      onEvent({ type: "verb_mask_applied", verb: maskedVerbForTurn });
    }
    if (forceWrapUp) {
      metrics.wrapUpMasks++;
      onEvent({ type: "wrap_up_mask" });
    }
    if (verificationRecoveryTurn) {
      metrics.verificationRecoveryMasks = (metrics.verificationRecoveryMasks ?? 0) + 1;
      onEvent({ type: "verification_recovery_mask", evidence: recoveryEvidence,
        ...(auditRecovery ? { contractAudit: { turn: auditRecovery.turn, promptSha256: auditRecovery.promptSha256 } } : {}) });
    }
    const turnStart = nowMs();
    // Pull one valid action, allowing a few repair attempts.
    let action = null;
    let rawOutput = null;      // accepted raw model output, preserved for the artifact
    let protocolViolation = false;
    let reasoning = null;      // reasoning that produced the accepted action, if any
    let repairObs = null;
    const prevObs = turns.length ? turns[turns.length - 1].observation : null;

    // Retrieve skills relevant to the task + recent observations (symptom-aware).
    let skillsText = "";
    if (skillRetrieve) {
      const recentObs = turns.slice(-3).map((t) => t.observation).join(" ");
      const hits = retrieveSkills(task, `${env} ${recentObs}`, library, { k: 2, language: skillsCfg.language });
      skillsText = formatSkills(hits);
      for (const s of hits) {
        if (!announcedSkills.has(s.id)) {
          announcedSkills.add(s.id);
          onEvent({ type: "skills_used", skills: [s.title] });
        }
      }
    }

    // Current, line-numbered contents of files the model is editing — refreshed
    // from disk each turn so a surgical "replace" is as easy as a full rewrite.
    const ledgerText = readLedger.render();
    // When the last observation NAMED a file:line (a failing test, a stack
    // trace, a syntax error), put that code in the prompt. The harness already
    // knows where the failure is; making the model spend a turn reading it is
    // a tax on information we are already holding.
    // Syntax-error locus, three cases:
    //   - EOF ("Unexpected end of input"): the parser's line is past the end and
    //     useless. Show the region the model just rewrote — that is where the
    //     unclosed delimiter is.
    //   - A named-line error (a failing test, a stack trace, `Unexpected token`):
    //     node names a REAL line. Show it. BUT a dropped brace makes the parser
    //     choke at an INNOCENT later line (v30: bug at the edit near 1193, blamed
    //     at 1241, then 1253 as edits shifted it). So when there's also a recent
    //     edit region, show BOTH — the bug is at one or the other, and the model
    //     was thrashing on the named line alone.
    const immediateCodeFailure = isUnbalanced(prevObs)
      || /\[pre-gate\]|SyntaxError|ReferenceError|TypeError|Unexpected token|unexpected EOF|location:\s*'/i.test(String(prevObs ?? ""));
    let lociText = "";
    if (prevObs || previewFailureSequence?.active) {
      // A multi-defect preview is a queue, not a wall. Keep exactly one
      // measured item (and therefore one exact source locus) fresh across the
      // read/edit turns until a new preview advances it. A concrete syntax
      // failure from the latest edit still wins because it blocks all further
      // execution and must be repaired first.
      const locusObservation = previewFailureSequence?.active && !immediateCodeFailure
        ? previewFailureSequence.active
        : prevObs;
      if (isUnbalanced(locusObservation) && lastEditRegion) {
        lociText = renderEditRegion(lastEditRegion, { workspace });
      } else {
        const named = renderLoci(extractLoci(locusObservation, { workspace }), { workspace });
        const isSyntax = /SyntaxError|Unexpected token/.test(String(locusObservation ?? ""));
        const editRegion = isSyntax && lastEditRegion
          ? renderEditRegion(lastEditRegion, { workspace })
          : "";
        // Only append the edit region when it's a DIFFERENT place than the named
        // line, else it's noise.
        const bothDiffer = editRegion && named && !named.includes(`:${lastEditRegion.start}`);
        lociText = bothDiffer ? `${named}\n\n${editRegion}` : (named || editRegion);
      }
    }
  // One context panel owns current source truth. An explicit inspection is the
  // model's current working set, so keep it ahead of older edited files. The old
  // edit-first order made every requested file vanish behind four completed
  // migration modules before the next action. Recovery remains absolute first.
    // A failed exact-match edit is an active source dependency, not ordinary
    // recency. Pin its actual executor-reported path ahead of the four-file
    // window until an edit lands, so recovery can never point to hidden bytes.
    const contextOpenList = [...new Set([
      ...(editRecoveryPath ? [editRecoveryPath] : []),
      ...(refusedEditPin ? [refusedEditPin] : []),
      ...recentReads,
      ...openList,
    ])];
    // editedPathsThisRun, not just mutationFocusByPath: a file loses its
    // mutation focus whenever currentEditFocus cannot locate the new text, and
    // with it the edit-target priority added for tb4. tb11 turn 62
    // (.bantam/runs/2026-08-16T19-21-23-939Z.json) edited src/fixture-runner.js
    // — already edited earlier in the same run — with the file ABSENT from the
    // panel. Having edited a file in this run is the durable signal; the seam
    // is the perishable one.
    const panelOptions = { focusByPath, mutationFocusByPath, editedPaths: editedPathsThisRun };
    const temporalState = stateAsOf(recordTurns(turns), turns.length);
    const repositoryState = tools?.get("map") ? temporalState.repositoryQuery : null;
    const workingNoteReanchor = formatWorkingNoteReanchor(temporalState, {
      retireAfterVerifiedPass: retireVerifiedCheckpoint,
      suppressBeforeFirstEdit: suppressPreEditCheckpoint,
      recoveryEvidence: recoveryEvidence ?? auditRecovery,
      suppressDuringCurrentFailure: Boolean(currentFailure || currentCliFailed),
    });
    let repositoryText = "";
    let repositoryTurnId = null;
    if (repositoryState) {
      const query = mapQueryPayload(repositoryState.query);
      const answer = query ? tools.get("map").answer(query) : "";
      if (answer && !/^\[map\] (?:unavailable|error)/.test(answer)) {
        repositoryText = `# Live repository map (query from turn ${repositoryState.turn + 1}, refreshed from the current tree)\n${answer}`;
        const retainedTurn = turns[repositoryState.turn];
        repositoryTurnId = Number.isInteger(retainedTurn?.i) ? retainedTurn.i : repositoryState.turn;
      }
    } else if (automaticRepositoryBriefEnabled) {
      // No synthetic turn is added: explicit query provenance/history semantics
      // remain unchanged. Retain the answer while the tree generation is
      // unchanged. Include the grounding/map revision because the regression
      // guard can restore bytes without incrementing workspaceEditGeneration.
      const liveRevision = `${workspaceEditGeneration}:${ground?.mapRevision ?? ground?.stats?.refreshes ?? 0}`;
      if (automaticRepositoryBriefRevision !== liveRevision) {
        let answer = "";
        try {
          answer = tools.get("map").answer("brief");
        } catch {
          // Third-party/injected tools do not necessarily have ToolRegistry's
          // normal error wrapper here. Repository context is an optimization;
          // a broken extension must not prevent the model's first turn.
        }
        automaticRepositoryBrief = answer
          && !/^\[map\] (?:unavailable|error)/.test(answer)
          ? answer
          : "";
        automaticRepositoryBriefRevision = liveRevision;
        if (automaticRepositoryBrief) {
          onEvent({
            type: "repository_context",
            source: "automatic",
            query: "brief",
            generation: workspaceEditGeneration,
          });
        }
      }
      if (automaticRepositoryBrief) {
        repositoryText = `# Live repository map (automatic brief, refreshed from the current tree)\n${automaticRepositoryBrief}`;
      }
    }
    // Under the extension invariant the packet is never rendered, so the first
    // repository text is frozen into the head; a later revision reaches the
    // model as guidance folded into the newest observation, like a plan update.
    if (extensionTrajectory && repositoryText) extensionHeadRepositoryText ??= repositoryText;
    // WINDOW-SAFE PANEL. Under extensionWorkingSet the panel re-renders every
    // turn, so the prompt diverges at the panel's start. On this hybrid
    // SWA+recurrent model reuse is checkpoint-or-nothing: llama.cpp offers only
    // the checkpoint at n_ubatch+4 tokens before the end. A tail SMALLER than
    // that window costs the tail; a tail LARGER gets no checkpoint at all and
    // re-prefills the WHOLE prompt.
    //
    // MEASURED: write-compressor's encode.py reached 8,584 chars (~2,940 tok).
    // With ~600 tokens of new turn content that is 3,540 against a 3,076 window
    // — over by 464, which would have turned every turn into a ~17s full
    // re-prefill (~816s over 48 turns) and made this mode far WORSE than the
    // eviction it replaces. So the packet is capped to fit the window with room
    // for a turn, and the cap is the safety gate, not a tuning knob.
    const workingSetChars = positiveInt(process.env.BANTAM_WORKING_SET_CHARS, 7000);
    const openFilesText = compileContextPacket({
      ...(extensionWorkingSet ? { maxChars: workingSetChars } : {}),
      repository: repositoryText,
      blocker: lociText,
      ledger: ledgerText,
      renderSource: openFilesView
        ? (maxBytes) => renderOpenFiles(workspace, contextOpenList, { ...panelOptions, maxBytes })
        : null,
    });
    // Read the OUTCOME, not the plan. renderedOpenPaths() answers "which
    // candidates exist and are readable" — it never sees the byte budget
    // compileContextPacket just chose, so a file the packet dropped is still
    // reported resident. readReplayIsContextSafe() trusts that list, so reads of
    // a dropped file were refused as already-present.
    //
    // tb21 (2026-08-17, run 06-25-11) deadlocked on exactly this: 22 of its 60
    // turns were read refusals, and in 9 of them the requested file was in
    // neither the panel nor history — src/fixture-runner.js was refused six
    // times while its only read had been stubbed away. The run reached the test
    // suite twice in 60 turns and hit the cap.
    //
    // Parsing the emitted packet is the one description that cannot drift from
    // what the model was actually sent.
    const panelIsRendered = openFilesView && (!extensionTrajectory || extensionWorkingSet);
    const openPaths = panelIsRendered ? panelEntryPaths(openFilesText) : [];
    // Same rule as openPaths above: the packet that shipped, not the plan that
    // preceded it. fullyRenderedPaths() re-runs the planner without the byte
    // budget compileContextPacket chose, so it can call a file complete that the
    // packet clipped or dropped.
    const completeOpenFiles = panelIsRendered ? completePanelEntries(openFilesText) : new Map();
    // Range-level residency for the read ledger. `end === null` asks the
    // whole-file question, which only a complete entry answers.
    const packetRanges = panelIsRendered ? panelRenderedRanges(openFilesText) : new Map();
    const packetResident = (rel, start, end) => {
      if (end === null) return completeOpenFiles.has(rel);
      const entry = packetRanges.get(rel);
      // Historical read headers do not prove residency: their numbered bytes
      // may have been clipped, slimmed, or frozen before later annotations.
      return Boolean(entry && packetCoversRange(entry.ranges, start, Math.min(end, entry.total)));
    };
    const completeReadPaths = [...completeOpenFiles.keys()];
    const preEditSynthesisTurn = preEditSynthesis
      && !preEditSynthesisSpent
      && turns.length > 0
      && editCount === 0
      && taskNamedPaths.length > 0
      && taskNamedPaths.every((namedPath) => completeOpenFiles.has(namedPath));
    if (executionStateShadow) {
      const executionShadow = deriveExecutionStateShadow({
        residentSourceCount: completeOpenFiles.size,
        namedSourceCount: taskNamedPaths.length,
        residentNamedSourceCount: taskNamedPaths.filter((namedPath) => completeOpenFiles.has(namedPath)).length,
        lastEditTurn: temporalState.lastEdit?.turn ?? null,
        lastVerdictTurn: temporalState.lastVerdict?.turn ?? null,
        lastVerdict: temporalState.lastVerdict?.result ?? null,
        pendingBlockerCount: pendingLifecycleContractViolations.length + (stateAuditPending ? 1 : 0),
      });
      metrics.executionStateShadowPhases[executionShadow.phase]
        = (metrics.executionStateShadowPhases[executionShadow.phase] ?? 0) + 1;
      executionShadowPhaseForTurn = executionShadow.phase;
      executionShadowBoundariesForTurn = [...executionShadow.boundaries];
      for (const boundary of executionShadow.boundaries) {
        metrics.executionStateShadowBoundaries[boundary]
          = (metrics.executionStateShadowBoundaries[boundary] ?? 0) + 1;
      }
      onEvent({ type: "execution_state_shadow", ...executionShadow });
    }

    for (let attempt = 0; attempt <= (terminalClosureTurn ? 0 : maxInvalidPerTurn); attempt++) {
      const historyForPrompt = terminalClosureTurn
        ? [...turns, { observation: terminalClosureNote(maxTurns) }]
        : repairObs
        ? [...turns, { observation: repairObs }]
        : (forceWrapUp
          ? [...turns, { observation: verificationRecoveryTurn
            ? [recoveryEvidence ? verificationRecoveryNote(recoveryEvidence) : "", contractAuditRecoveryNote(auditRecovery)].filter(Boolean).join("\n\n")
            : autoForceEdit
            ? (extensionTrajectory ? AUTO_EDIT_NOTE_EXTENSION : AUTO_EDIT_NOTE)
            : WRAP_UP_NOTE }]
          : turns);

      // Optional goal re-anchor (A/B): after a few turns, restate the objective
      // immediately before the model acts.
      const baseReanchor = (goalReanchor && turns.length >= goalReanchorAfter
          ? `Reminder — your objective (confirm EVERY requirement below is met before you call done):\nTask: ${task}`
          : "");
      const postGreenReanchor = completionAuditReanchor(task, prevObs);
      // Planning/report tasks need repository constraints while the first draft
      // is being formed, not a broad post-green rewrite after attention has
      // already settled. Keep this one sentence only until the first mutation;
      // the existing document-review nudge takes over after the draft lands.
      const documentDraftReanchor = !workspaceChangedDuringRun ? repositoryDocumentCue : "";
      const revisionGaps = documentRevisionTurn ? documentArtifactReviewGaps(prevObs) : [];
      // The system menu is rendered from the run-frozen base features, so a
      // turn-scoped line-edit grant must teach the action's exact shape here,
      // in appended per-turn text. Rendering it into the menu instead rewrote
      // the top of every prompt and invalidated the model server's entire
      // cached prefix (llama.cpp fell to its first checkpoint, or to zero).
      const lineEditSyntaxLine = (documentRevisionTurn || lineEditRecoveryTurn)
        && !baseActionFeatures.includes(LINE_EDIT_FEATURE)
        ? `Line-pointer edit syntax:\n${actionPromptMenuLine("edit_lines", { features: turnActionFeatures })}`
        : null;
      const documentRevisionReanchor = documentRevisionTurn && revisionGaps.length
        ? [
            "DOCUMENT REVISION RECOVERY: close the explicit audited gaps below in the pending document now.",
            "Use edit_lines with the visible start/end line numbers for a bounded correction, or one intentional write_file rewrite when the gaps span the document. Exact-match replace is unavailable at this checkpoint.",
            ...(lineEditSyntaxLine ? [lineEditSyntaxLine] : []),
            "If the exact current bytes are clipped or stale, use read_file on that document once; otherwise edit it now.",
            "Do not inspect unrelated files, polish unrelated prose, or change bytes without reducing this list.",
            ...revisionGaps.map((gap) => `- ${gap}`),
          ].join("\n")
        : "";
      const editRecoveryReanchor = lineEditRecoveryTurn
        ? [
            `EDIT RECOVERY ACTIVE: an exact-match edit to ${editRecoveryPath} failed. That proposal was NOT APPLIED; it is neither the current file nor a verified fix.`,
            "Do not reconstruct old text. Use the fresh line-numbered context update or current read_file output. If the required range is omitted, read_file that exact path and range before editing; never guess line numbers or overwrite unseen sections.",
            ...(lineEditSyntaxLine ? [lineEditSyntaxLine] : []),
            "This line-edit aid does not block executable verification. Repair a demonstrated defect using current bytes; do not make an unrelated edit just to clear recovery. If the current state needs no repair, verify it and finish accurately.",
          ].join("\n")
        : "";
      const documentReviewReanchor = documentReviewTurn
        ? [
            "DOCUMENT REVIEW CHECKPOINT: completion is waiting only for a whole-file read_file of each pending document below.",
            "Read each exact path without start or limit. Do not reread another file, make a no-op edit, run tests, or call done until this list is empty.",
            ...[...pendingDocumentArtifacts].map((document) => `- ${document}`),
          ].join("\n")
        : "";
      const documentReviewCompleteReanchor = prevObs
        && pendingDocumentArtifacts.size === 0
        && !artifactNeedsVerification
        && !documentRevisionTurn
        && /Document review context:/.test(prevObs)
        && !documentArtifactReviewHasGaps(prevObs)
        ? [
            "DOCUMENT REVIEW COMPLETE: the full current document was read after the last edit and the task-grounded audit found no mechanical gap.",
            "If the semantic comparison found one concrete unmet requirement, edit only that requirement; otherwise run required verification once if it is not current, or emit done.",
            "Do not reread the document, rerun unchanged checks, or resume reconnaissance.",
          ].join("\n")
        : "";
      // A syntax/import pre-gate from the latest edit outranks browser
      // re-verification. Repair that concrete break first; the sequence remains
      // active and will ask for its preview again after the corrective edit.
      const previewFailureReanchor = immediateCodeFailure
        ? ""
        : formatPreviewFailureReanchor(previewFailureSequence);
      const lifecycleContractReanchor = pendingLifecycleContractViolations.length
        ? [
            "LIFECYCLE CONTRACT BLOCKER: public tests and unchanged verification do not discharge these contradictions in the current edited bytes.",
            ...pendingLifecycleContractViolations.map((violation) => `- ${violation.path}:${violation.line} ${violation.message}`),
            "Your next action must edit one of these exact sites. Do not reread unchanged source, rerun the broad suite, or call done while this list is non-empty.",
          ].join("\n")
        : "";
      const stateAuditReanchor = stateAuditPending && !pendingLifecycleContractViolations.length
        ? [
            "STATE AUDIT BLOCKER: this obligation remains pending; reads and the unchanged broad suite cannot discharge it.",
            stateAuditDeferral(stateAuditPolicy.reason, task),
            "Follow the ordering literally in the next assertion-bearing probe. In particular, capture the returned Promise, trigger abort/reset while work is blocked, and only then await the Promise.",
          ].join("\n")
        : "";
      const finalDecisionReanchor = [lifecycleContractReanchor, stateAuditReanchor, documentReviewCompleteReanchor, previewFailureReanchor]
        .filter(Boolean)
        .join("\n\n");
      const decHintText = decHint
        ? `[integrated-decider] Recommended next action: ${decHint.action} (strategy: ${decHint.strategy}, score: ${decHint.score.toFixed(2)}${decHint.plan ? `, plan-ahead: ${decHint.plan.join(' → ')}` : ''})`
        : "";
      const externalMutationReanchor = pendingExternalChanges.size
        ? [
            "EXTERNAL WORKSPACE CHANGE: files BANTAM previously read changed outside this agent.",
            "The current disk is authoritative; earlier read observations, test proofs, and edit assumptions for these paths are stale. Use a fresh read_file or a current displayed source view.",
            "Re-read a clipped changed path before editing it. If its current contents are fully visible, act from those exact bytes. Never overwrite it from remembered text.",
            ...[...pendingExternalChanges].map((changedPath) => `- ${changedPath}`),
          ].join("\n")
        : "";
      // Re-rendered every turn, so it belongs with the volatile tail.
      const budgetText = wallBudgetLine({
        budgetMs: wallBudgetMs,
        elapsedMs: Date.now() - runStartedAtMs,
      });
      const reanchorText = [budgetText, baseReanchor, documentDraftReanchor, postGreenReanchor, documentRevisionReanchor, editRecoveryReanchor, documentReviewReanchor, externalMutationReanchor, workingNoteReanchor, decHintText]
        .filter(Boolean)
        .join("\n\n");

      // Newly enabled grammar is not a model-visible action manual. In the
      // extension path [guidance] can be swallowed into a preceding controller
      // block's 700-character clip, losing syntax after a long task restatement.
      // Reserve one existing typed-context slot before optional source views;
      // render/record the whole exact interface after ordinary output clipping.
      if (turns.length && (lineEditRecoveryTurn || documentRevisionTurn)
          && enabledTurnVerbs.has("edit_lines") && !excludeThisTurn.includes("edit_lines")
          && !callerExcludedActions.includes("edit_lines")) {
        const last = turns.at(-1);
        const update = createActionContractUpdate({ generation: workspaceEditGeneration,
          turn: turns.length,
          availableVerbs: [...enabledTurnVerbs].filter(verb => !excludeThisTurn.includes(verb)
            && !callerExcludedActions.includes(verb)),
          reason: documentRevisionTurn ? "document-revision" : "edit-recovery",
          recoveryPath: documentRevisionTurn ? null : editRecoveryPath,
        });
        const existing = (Array.isArray(last.contextUpdates) ? last.contextUpdates : [])
          .filter(entry => contextUpdatePromptText(entry, promptTemplate));
        if (update && !existing.some(entry => entry.id === update.id) && existing.length < 2) {
          last.contextUpdates = [...existing, update];
          onEvent({ type: "context_update_created", id: update.id, kind: update.kind, paths: update.paths });
          if (!extensionTrajectory) onEvent({ type: "observation_annotated", turn: turns.length - 1,
            observation: last.observation, contextUpdates: last.contextUpdates });
        }
      }

      // This is current state, not change-only guidance. It must survive long
      // tool output and identical read turns, and must follow the task/audit
      // restatement. Render it as a bounded typed block on the newest fragment.
      // Earlier fragments stay byte-identical for extension prefix reuse.
      if (turns.length) {
        if (verificationWorkflow) turns.at(-1).verificationWorkflow = verificationWorkflow;
        else delete turns.at(-1).verificationWorkflow;
        if (!extensionTrajectory) onEvent({ type: "observation_annotated", turn: turns.length - 1,
          observation: turns.at(-1).observation, verificationWorkflow });
      }
      if (extensionTrajectory) {
        // A failed anchor is a specific freshness boundary. Supply actual disk
        // bytes once per path/generation, not an instruction pointing to a panel
        // extension does not display. Typed context bypasses tool-output clipping.
        if (editRecoveryPath && turns.length) {
          const key = `${editRecoveryPath}:${workspaceEditGeneration}`;
          if (!recoverySnapshotKeys.has(key)) {
            const focus = focusByPath.get(editRecoveryPath)?.[0];
            const update = createContextUpdate(workspace, {
              kind: "edit-recovery", paths: [editRecoveryPath], generation: workspaceEditGeneration,
              focusLine: focus ? Math.floor((focus.start + focus.end) / 2) : undefined,
            });
            const last = turns.at(-1);
            const existing = (Array.isArray(last.contextUpdates) ? last.contextUpdates : [])
              .filter((entry) => contextUpdatePromptText(entry, promptTemplate));
            if (update && existing.length < 2) {
              last.contextUpdates = [...existing, update];
              recoverySnapshotKeys.add(key);
              metrics.editRecoverySnapshots = (metrics.editRecoverySnapshots ?? 0) + 1;
              onEvent({ type: "context_update_created", id: update.id, kind: update.kind, paths: update.paths });
            }
          }
        }
        // Verify-green is the moment before done decisions happen. Fold the
        // edited files' current bytes in front of that decision — once per
        // converged state — so the contract restatement below and the code it
        // constrains are adjacent again, as rebuild's panel made them.
        if (decisionSnapshot && turns.length) {
          const lastTurn = turns[turns.length - 1];
          const existing = (Array.isArray(lastTurn.contextUpdates) ? lastTurn.contextUpdates : [])
            .filter((entry) => contextUpdatePromptText(entry, promptTemplate));
          if (verificationVerdict(lastTurn) === "pass"
              && workspaceEditGeneration !== lastSnapshotGeneration
              && existing.length < 2) {
            const snapshot = renderDecisionSnapshot(workspace, turns, workspaceEditGeneration);
            if (snapshot) {
              lastTurn.contextUpdates = [...existing, snapshot];
              lastSnapshotGeneration = workspaceEditGeneration;
              metrics.decisionSnapshots = (metrics.decisionSnapshots ?? 0) + 1;
              onEvent({ type: "decision_snapshot", id: snapshot.id, paths: snapshot.paths.map((entry) => entry.path) });
            }
          }
        }
        // The volatile tail is not rendered under the extension invariant, so
        // guidance that would have lived there is appended once — immutably —
        // to the newest observation when its content changes. The equality
        // guard keeps repair-loop rebuilds and unchanged turns append-free.
        extensionHeadSkillsText ??= skillsText;
        extensionHeadPlanText ??= planText;
        const guidanceParts = [reanchorText, finalDecisionReanchor];
        if (planText && planText !== extensionHeadPlanText) guidanceParts.push(`PLAN UPDATE:\n${planText}`);
        if (skillsText && skillsText !== extensionHeadSkillsText) guidanceParts.push(`SKILL NOTES UPDATE:\n${skillsText}`);
        if (repositoryText && extensionHeadRepositoryText && repositoryText !== extensionHeadRepositoryText) guidanceParts.push(`REPOSITORY MAP UPDATE:\n${repositoryText}`);
        const guidance = guidanceParts.filter(Boolean).join("\n\n").trim();
        if (guidance && guidance !== lastFoldedGuidance && turns.length) {
          const last = turns[turns.length - 1];
          last.observation = `${String(last.observation ?? "")}\n\n[guidance]\n${guidance}`;
          lastFoldedGuidance = guidance;
        }
        if (turns.length) {
          const last = turns.at(-1);
          onEvent({ type: "observation_annotated", turn: turns.length - 1, observation: last.observation,
            verificationWorkflow: last.verificationWorkflow ?? null,
            ...(Object.hasOwn(last, "contextUpdates") ? { contextUpdates: last.contextUpdates } : {}) });
        }
      }

      // The task's named deliverable, checked DURING the run. done-gates already
      // runs this check, but only for a run that REACHES done -- a run that times
      // out is never checked at all. write-compressor (2026-08-22, local) spent
      // 48 turns and 24 shell commands and ended with data.txt / debug.py /
      // decomp.c / encode.py on disk: data.comp, the one file the task asks for,
      // was never created, and nothing ever said so. It had been grading itself
      // against its own Python re-implementation of the decompressor and never
      // once ran the real binary.
      // The program the task GAVE the model, never run. write-compressor (2026-08-23):
      // 24 turns of verifying against a self-written decoder with the real
      // ./decomp never invoked, while the rule saying to run it sat at 11% of the
      // prompt. Advisory ignored; this is the gate's sensor -- once, at the Nth
      // self-only verify. See logic/provided-oracle-watch.js.
      if (!providedOracleNoticed && turns.length) {
        const po = providedOracleNotice({ task, turns });
        if (po) {
          providedOracleNoticed = true;
          metrics.providedOracleNotices = (metrics.providedOracleNotices ?? 0) + 1;
          onEvent({ type: "provided_oracle_missing", executables: po.executables, turn: turns.length });
          const last = turns[turns.length - 1];
          last.observation = `${String(last.observation ?? "")}\n\n${po.text}`;
          onEvent({ type: "observation_annotated", turn: turns.length - 1, observation: last.observation });
        }
      }
      if (requiredOutputs.length && turns.length) {
        let absent = [];
        try {
          absent = requiredOutputs.filter((rel) => {
            const abs = path.resolve(workspace, rel.replace(/^\/app\//, ""));
            return !fs.existsSync(abs);
          });
        } catch { absent = []; }
        const notice = deliverableNotice({
          missing: absent,
          turnsUsed: turns.length,
          noticesSoFar: deliverableNotices,
          firstTurn: positiveInt(process.env.BANTAM_DELIVERABLE_FIRST_TURN, 8),
        });
        if (notice) {
          deliverableNotices += 1;
          metrics.deliverableNotices = deliverableNotices;
          onEvent({ type: "deliverable_missing", paths: notice.paths, turn: turns.length });
          const last = turns[turns.length - 1];
          last.observation = `${String(last.observation ?? "")}\n\n${notice.text}`;
          onEvent({ type: "observation_annotated", turn: turns.length - 1, observation: last.observation });
        }
      }

      // Rewriting a superseded observation in place invalidates the provider
      // prefix cache from the rewrite point onward. Measured on a recorded
      // gpt-5.6-terra run: 63,082 already-cached characters discarded across ten
      // turns (~29% of all cache misses) to save a few hundred characters of
      // length. Frontier models take the appended staleness notice instead; a
      // local 27B keeps the in-place rewrite, which exists so it is never handed
      // a stale dump beside a clipped live panel.
      // MEASURED AND REJECTED as a default, 2026-07-31. Clean A/B on
      // adapter-migration with gpt-5.6-terra, 10 turns each way:
      //
      //                     immutable ON   OFF
      //   worst prefix        78.7%        34.7%   <- the mechanism worked
      //   prefix discarded    43,187       60,803  <- and worked well
      //   final prompt        50,155 ch    34,795  <- but 44% bigger
      //   CACHE MISS          72,654       58,372  <- and lost anyway
      //
      // Keeping superseded bodies more than doubled prefix stability and still
      // cost 24% MORE cache misses, because re-sending a 44%-larger prompt every
      // turn outweighs the stability it buys. The in-place rewrite is not a bug
      // to fix; it is a correct optimisation. Left switchable because the
      // measurement is cheap to repeat and the balance may differ for a provider
      // with different cache pricing or a task with smaller files.
      //
      // The extension trajectory forces immutability: a local llama.cpp slot
      // serving a hybrid-attention model has no partial-prefix reuse to lose
      // (it restores saved checkpoints or nothing — measured on the 2026-08-12
      // dependency-scheduler run, 16 of 21 calls pinned at the 1,804-token
      // head checkpoint), so prefix stability is the only thing that pays and
      // the 44%-bigger-prompt penalty is prefill the cache now absorbs.
      const immutableHistory = extensionTrajectory || envTruthy(process.env.BANTAM_IMMUTABLE_HISTORY);

      // Optional thinking phase: at critical moments, reason in an open <think>
      // block first, then seal it and generate the grammar-constrained action.
      let assistantPrefill = bareHistory ? bareTurnPrefill : model.assistantPrefill;
      let turnReasoning = null;
      const synthesisThisAttempt = preEditSynthesisTurn && attempt === 0;
      if (!terminalClosureTurn && thinkingAvailable && shouldThink(thinkMode, {
        turnIndex: turns.length,
        lastObservation: prevObs,
        lastWasInvalid: attempt > 0,
        preEditSynthesis: synthesisThisAttempt,
      })) {
        if (synthesisThisAttempt) {
          preEditSynthesisSpent = true;
          metrics.preEditSynthesisAttempts++;
          onEvent({
            type: "pre_edit_synthesis_attempt",
            paths: [...taskNamedPaths],
            authority: "reasoning-only",
          });
        }
        onEvent({ type: "activity", label: "thinking" });
        let thinkTruncatedThisTurn = false;
        const grantedDeepThink = deepThinkGrant;
        if (grantedDeepThink) {
          deepThinkGrant = false;   // consumed by this think, success or not
          metrics.deepThinkGrants = (metrics.deepThinkGrants ?? 0) + 1;
          onEvent({ type: "deep_think_grant", turn: turns.length });
        }
        const thought = await safeComplete(
          () => buildPrompt({ onRenderedObservation: recordReadDelivery, task, env, maxTurns, profileText, sandboxedShell, turns: capTurns(historyForPrompt), assistantPrefill: thinkP.openThink, historyPrefill: bareHistory ? bareTurnPrefill : model.historyPrefill, skillsText: extensionTrajectory ? extensionHeadSkillsText : skillsText, planText: extensionTrajectory ? extensionHeadPlanText : planText, contractText: taskContractText, extensionTrajectory, extensionWorkingSet, outputTokenCap: model?.nPredict ?? null, reasoningEffort, reanchorText, finalReanchorText: finalDecisionReanchor, openFilesText, openPaths, readPaths: completeReadPaths, interactive, toolsText, actionFeatures: baseActionFeatures, unslimPaths: echoedPaths, repoContextTurn: repositoryTurnId, repoContextQuery: repositoryText ? repositoryState?.query : "", repositoryHeadText: extensionTrajectory ? (extensionHeadRepositoryText ?? "") : "", template: promptTemplate, thinkEnabled, slimSuccessfulShellActions: successfulShellReplaySlim, immutableHistory, everSlimmedPaths, preserveSlimmedControlAnnotations, renderCache: extensionTrajectory ? turnRenderCache : null }),
          { stop: [...thinkP.stop, ...model.stop], nPredict: thinkBudget({ normal: thinkNPredict, deep: thinkNPredictFirst, editCount, grant: grantedDeepThink }),
            codexAdaptiveRebase: !completionAuditEmitted,
            ...(interactive ? { onProgress: (p) => { onEvent({ type: "model_stream", phase: "thinking", tokens: p.tokens, content: p.content ?? "" }); onEvent({ type: "activity", label: "thinking", detail: `${p.tokens} tokens` }); } } : {}) }
        );
        if (interrupted) break;
        if (thought) {
          metrics.tokens += thought.tokens;
          metrics.thinkTokens += thought.tokens;
          // A think that spends its ENTIRE budget did not finish; it was severed.
          // Nothing used to notice. MEASURED on write-compressor (2026-08-22,
          // local): 9 of 19 think calls returned exactly 4096 tokens, ending
          // mid-sentence ("Initially all counts are 0. So"), and SIX of the nine
          // full rewrites of encode.py were the very next action after one. The
          // model reasons toward a plan, gets cut, and then acts on the fragment
          // — and the cheapest action to take from an incomplete plan is to
          // rewrite the whole file again. That is the thrash engine.
          //
          // The remedy is not a bigger budget (that buys the same fragment later
          // at more cost). It is to TELL the action phase what happened, and to
          // name the move that a severed plan must not license.
          const activeThinkBudget = thinkBudget({ normal: thinkNPredict, deep: thinkNPredictFirst, editCount, grant: grantedDeepThink });
          if (thought.tokens >= activeThinkBudget) {
            metrics.thinkTruncations = (metrics.thinkTruncations ?? 0) + 1;
            onEvent({
              type: "think_truncated",
              turn: turns.length,
              tokens: thought.tokens,
              budget: activeThinkBudget,
            });
            thinkTruncatedThisTurn = true;
          }
          lastThinkSevered = thinkTruncatedThisTurn;
          // Gemma writes its own `<|channel>thought` opener in phase 1; strip it
          // so only the reasoning itself is sealed into the closed block.
          turnReasoning = thinkP.cleanReasoning(thought.content);
          if (thinkTruncatedThisTurn && turnReasoning) {
            turnReasoning += "\n\n[reasoning-budget] This thought was cut off at the budget"
              + " before it reached a conclusion — what is above is a fragment, not a finished plan."
              + " Do NOT start a full-file rewrite from it. Take the smallest step that TESTS the"
              + " hypothesis you were forming (a focused probe, a targeted read, or one surgical"
              + " edit), and let the result finish the reasoning.";
          }
          if (turnReasoning) {
            if (synthesisThisAttempt) {
              metrics.preEditSynthesisThinks++;
              onEvent({
                type: "pre_edit_synthesis",
                paths: [...taskNamedPaths],
                reasoningChars: turnReasoning.length,
                authority: "reasoning-only",
              });
            }
            thinkingProven = true;
            metrics.thinkPhases++;
            onEvent({ type: "thinking", text: turnReasoning });
            const actionReasoning = compactActionReasoning(turnReasoning, actionReasoningMaxChars);
            metrics.actionReasoningChars += actionReasoning.length;
            metrics.actionReasoningOmittedChars += Math.max(0, turnReasoning.length - actionReasoning.length);
            if (actionReasoning.length < turnReasoning.length) metrics.actionReasoningCompactions++;
            assistantPrefill = thinkP.closeThink(actionReasoning);
          } else if (!thinkingProven) {
            if (synthesisThisAttempt) onEvent({ type: "pre_edit_synthesis_empty", paths: [...taskNamedPaths] });
            // An empty first probe means this profile/model is not supplying a
            // usable think block. Stop paying for a capability it has not shown.
            thinkingAvailable = false;
            metrics.emptyThinkDisables++;
            onEvent({ type: "thinking_disabled", reason: "empty_completion" });
          } else {
            if (synthesisThisAttempt) onEvent({ type: "pre_edit_synthesis_empty", paths: [...taskNamedPaths] });
            // Once thinking has worked, one empty generation is transient—not
            // evidence that the capability vanished. Keep the fast action for
            // this turn and allow the next critical boundary to reason again.
            metrics.emptyThinkTransients++;
            onEvent({ type: "thinking_empty_transient" });
          }
        }
      }

      onEvent({ type: "activity", label: "generating" });
      const out = await safeComplete(
        () => {
          const built = gaugeExtensionPrefix(buildPrompt({ onRenderedObservation: recordReadDelivery, task, env, maxTurns, profileText, sandboxedShell, turns: capTurns(historyForPrompt), assistantPrefill, historyPrefill: bareHistory ? bareTurnPrefill : model.historyPrefill, skillsText: extensionTrajectory ? extensionHeadSkillsText : skillsText, planText: extensionTrajectory ? extensionHeadPlanText : planText, contractText: taskContractText, extensionTrajectory, extensionWorkingSet, outputTokenCap: model?.nPredict ?? null, reasoningEffort, reanchorText, finalReanchorText: finalDecisionReanchor, openFilesText, openPaths, readPaths: completeReadPaths, interactive, toolsText, actionFeatures: baseActionFeatures, unslimPaths: echoedPaths, repoContextTurn: repositoryTurnId, repoContextQuery: repositoryText ? repositoryState?.query : "", repositoryHeadText: extensionTrajectory ? (extensionHeadRepositoryText ?? "") : "", template: promptTemplate, thinkEnabled, slimSuccessfulShellActions: successfulShellReplaySlim, immutableHistory, everSlimmedPaths, preserveSlimmedControlAnnotations, renderCache: extensionTrajectory ? turnRenderCache : null }));
          if (savePrompts) lastPromptForTurn = typeof built === "string" ? built : JSON.stringify(built);
          return built;
        },
        {
          ...(useGrammar ? { grammar: turnActionGrammar, jsonSchema: turnActionJsonSchema } : {}),
          temperature: model.actTemperature ?? undefined,
          // The bounded post-green audit is a terminal phase, even when it
          // finds one correction and re-verifies it. Keep exact deltas, but do
          // not rotate the native thread merely because savings have decayed.
          codexAdaptiveRebase: !completionAuditEmitted,
          // Interactive: stream so the heartbeat can say WHAT is being generated as it grows —
          // once the action head appears in the partial JSON, name the verb and target.
          ...(interactive ? { onProgress: (p) => { onEvent({ type: "model_stream", phase: "action", tokens: p.tokens, content: p.content ?? "" }); onEvent({ type: "activity", label: "generating", detail: describePartialAction(p) }); } } : {}),
        }
      );
      if (!out) {
        if (!interrupted) {
          metrics.modelErrors = (metrics.modelErrors ?? 0) + 1;
          modelError = lastCompleteError;
          terminalModelFailure = lastCompleteFailure;
        }
        break;
      }
      metrics.tokens += out.tokens;
      metrics.actionTokens += out.tokens;

      // Live throughput andon: if the prompt-prefix cache stops reusing, every
      // turn reprocesses the near-full context and generation crawls toward a
      // timeout (the 2026-08-20 gpt2 45-min death). Surface it WHILE the run is
      // going — a post-hoc metric is an autopsy. Operator/self-improve signal
      // only; never a model steer (the model cannot fix a KV-cache miss).
      {
        const andon = assessThroughput(out.usage, throughputAndon, { remote: Boolean(model?.chatDialect || model?.provider === "codex") });
        if (andon.andon) {
          metrics.throughputAndons++;
          onEvent({
            type: "throughput_andon",
            reuseRatio: andon.reuseRatio,
            streak: andon.streak,
            promptTokens: andon.promptTokens,
            message: andon.message,
          });
        }
      }

      const parsed = parseAction(out.content);
      if (parsed.ok) {
        degeneratePenalty = 0;
        const normalizedAction = normalizeWorkspaceAction(parsed.action);
        if (callerExcludedActions.includes(normalizedAction.a)
            || (normalizedAction.a === "probe" && !probeEnabled)) {
          metrics.invalid++;
          const error = normalizedAction.a === "probe" && !probeEnabled
            ? 'Action "probe" is disabled. Enable the fixture-probe feature explicitly before using it.'
            : `Action "${normalizedAction.a}" is disabled by the caller policy.`;
          rejectedOutputs.push({
            turn: turns.length,
            attempt,
            rawOutput: out.content,
            error,
            reasoning: turnReasoning,
            kind: "caller_policy",
            target: normalizedAction.path ?? null,
            tokens: out.tokens,
            stoppedLimit: Boolean(out.stoppedLimit),
          });
          onEvent({ type: "invalid_action", error, raw: out.content });
          repairObs = error;
          continue;
        }
        action = normalizedAction;
        if (action !== parsed.action) {
          metrics.workspaceAliasNormalizations++;
          onEvent({ type: "workspace_alias_normalized", original: parsed.action, action });
        }
        rawOutput = out.content;
        reasoning = turnReasoning;
        protocolViolation = !parsed.strictJson;
        if (protocolViolation) {
          metrics.protocolViolations++;
          onEvent({ type: "protocol_violation", raw: out.content, repairedJson: parsed.repairedJson });
        }
        break;
      }

      metrics.invalid++;
      const outputLimit = parsed.kind === "unterminated_json"
        && (out.stoppedLimit === true
          || (Number.isFinite(Number(model?.nPredict))
            && Number(out.tokens) >= Math.max(1, Number(model.nPredict) - 8)));
      const target = parsed.partialAction?.path ?? null;
      rejectedOutputs.push({
        turn: turns.length,
        attempt,
        rawOutput: out.content,
        error: parsed.error,
        reasoning: turnReasoning,
        kind: outputLimit ? "output_limit" : parsed.kind,
        target,
        tokens: out.tokens,
        stoppedLimit: Boolean(out.stoppedLimit),
        truncated: Boolean(out.truncated),
        promptTokens: out.promptTokens ?? null,
      });
      // A repetition loop and an oversized action both surface as unterminated
      // JSON, and they need OPPOSITE advice. Check for degeneration first:
      // telling a run that looped to "emit a smaller action" makes it loop again.
      const degenerate = parsed.kind === "unterminated_json" ? degenerateTail(out.content) : null;
      // Advice alone cannot stop a sampler that has collapsed. Ask the RETRY to
      // sample with a small presence penalty — enough to break the loop, applied
      // only after one has actually been observed, so ordinary code generation
      // (where repeated tokens are correct) is never penalised.
      if (degenerate) degeneratePenalty = 0.6;
      if (degenerate) {
        metrics.degenerateOutputRecoveries = (metrics.degenerateOutputRecoveries ?? 0) + 1;
        repairObs = degenerateRepairMessage(degenerate, target);
        onEvent({ type: "degenerate_output", unit: degenerate.unit, repeats: degenerate.repeats, tokens: out.tokens });
      } else if (outputLimit) {
        metrics.outputLimitRecoveries++;
        const subject = target ? ` for \`${target}\`` : "";
        repairObs = [
          `[output-limit] Your previous ${parsed.partialAction?.action || "action"}${subject} reached the model's output limit before its JSON object could close.`,
          "Do NOT regenerate the same monolithic action: it will hit the same fixed limit again.",
          "Emit one much smaller valid action now. For a large new program, write a compact runnable skeleton first, split substantial code into multiple files/modules, then extend it with bounded replace/edit_lines/patch actions.",
          `Keep this next action comfortably below the limit (under ~${Math.max(500, Math.floor((Number(model?.nPredict) || 8192) * 0.75)).toLocaleString()} output tokens).`,
        ].join(" ");
      } else {
        repairObs = `Your previous output was rejected: ${parsed.error}. Emit exactly one valid action JSON object.`;
      }
      onEvent({
        type: "invalid",
        error: parsed.error,
        kind: outputLimit ? "output_limit" : parsed.kind,
        target,
        tokens: out.tokens,
        stoppedLimit: Boolean(out.stoppedLimit),
        raw: out.content,
      });
    }

    if (!action) {
      if (!interrupted) onEvent({ type: modelError ? "model_error" : "give_up", reason: modelError || "too many invalid outputs" });
      break;
    }

    const requestedAction = action;
    action = normalizeDocumentArtifactReviewAction(action, {
      knownArtifacts: [...pendingDocumentArtifacts],
    });

    metrics.actions[action.a] = (metrics.actions[action.a] ?? 0) + 1;
    if (executionShadowPhaseForTurn) {
      const transition = `${executionShadowPhaseForTurn}->${action.a}`;
      metrics.executionStateShadowTransitions[transition]
        = (metrics.executionStateShadowTransitions[transition] ?? 0) + 1;
      onEvent({
        type: "execution_state_shadow_action",
        phase: executionShadowPhaseForTurn,
        boundaries: executionShadowBoundariesForTurn,
        reasoningPresent: Boolean(reasoning),
        action: action.a,
        authority: "observe-only",
      });
    }
    // Carry the turn's prompt on the event when capture is on, so the crash
    // CHECKPOINT (the artifact every killed run leaves behind) is replayable
    // too — not just cleanly-finished runs.
    const modelCallIndex = Number.isInteger(model?.lastRequestRecord?.index)
      ? model.lastRequestRecord.index
      : null;
    const actionEvent = {
      type: "action",
      action,
      rawOutput,
      reasoning,
      protocolViolation,
      ...(modelCallIndex !== null ? { modelCallIndex } : {}),
      ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
    };
    onEvent(actionEvent);
    // A grammar-free caller or noncompliant sampler must not turn the closing
    // allowance into one more tool action. Stop before any executor/query or
    // automatic post-action verification path can run it.
    if (terminalClosureTurn && action.a !== "done") {
      const observation = "[terminal-closure] Closing allowance refused: only done was permitted. No tool or mutation executed; completion remains unresolved.";
      turns.push({ i: turns.length, action, parsedAction: action, rawOutput, reasoning, protocolViolation,
        observation, verificationEvidence: null, shellExecution: null, tookMs: nowMs() - turnStart,
        ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
        ...(modelCallIndex !== null ? { modelCallIndex } : {}) });
      metrics.turns++;
      onEvent({ type: "terminal_closure", phase: "refused", action: action.a });
      onEvent({ type: "observation", ...turns.at(-1) });
      break;
    }
    if (action.a === "write_batch") {
      onEvent({
        type: "write_batch_manifest",
        files: action.files.map((file) => ({
          path: file.p,
          bytes: Buffer.byteLength(file.content),
          sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
        })),
      });
    }
    // The model may have spent seconds or minutes choosing this action. Scan
    // again after its completion (and after event observers) so an external
    // edit made during inference cannot be overwritten by a stale write.
    const midTurnExternalPaths = detectExternalWorkspaceChanges("before_action");
    const externalMutationRejection = midTurnExternalPaths.length
      ? [
          "[external-workspace-change] The workspace changed while this action was being chosen, so this stale action was NOT executed.",
          `Changed: ${midTurnExternalPaths.join(", ")}.`,
          "Use the current <open_files> bytes or re-read the changed path before proposing an edit. Do not reconstruct or overwrite the external change from earlier context.",
        ].join(" ")
      : null;
    if (externalMutationRejection) metrics.externalWorkspaceMutationBlockedActions++;
    if (action !== requestedAction) {
      onEvent({
        type: "document_review_read_normalized",
        requestedAction,
        action,
        documents: documentArtifactReviewPaths(action, {
          knownArtifacts: [...pendingDocumentArtifacts],
        }),
      });
    }
    const requestedDocumentReviews = documentArtifactReviewPaths(action, {
      knownArtifacts: [...pendingDocumentArtifacts],
    });

    // Exact source-derived scalar tasks are evidence acquisition, not ordinary
    // draft authoring. Refuse a short output value until the same value has
    // appeared in a successful source-linked observation. This catches an
    // unsupported placeholder at the actual decision boundary: the proposed
    // value appeared only in filenames, never in source-derived evidence.
    const sourceProvenanceRejection = sourceProvenance
      ? sourceProvenanceGateRejection(action, { obligation: sourceProvenance, turns })
      : null;

    // A changed wrapper is not necessarily a changed hypothesis. Preserve the
    // semantic search axis across turns so timeout/fork/length variations of an
    // already-failed solver domain cannot consume the run as apparently novel
    // commands. The station is deliberately high precision and fails open for
    // search tools/modes it cannot classify.
    const searchStrategyDecision = evaluateSearchStrategyProposal(action, { turns });
    const searchStrategyRejection = searchStrategyDecision.rejection;

    // A task-grounded document coverage gap already is the verification
    // failure, and the document-revision grammar intentionally permits only
    // edits. Let that correction land before the generic artifact gate asks
    // for another review; after the edit, the pending-document state requires
    // a whole-file reread normally. Without this precedence the two masks can
    // deadlock, rejecting every verb available to the model.
    const artifactGateRejection = progressAwareness && !documentRevisionTurn
      ? artifactVerificationGateRejection(action, {
          needsVerification: artifactNeedsVerification,
          turnsSinceArtifact,
          threshold: artifactVerifyAfter,
          knownArtifacts: [...knownArtifacts],
          pendingDocumentArtifacts: [...pendingDocumentArtifacts],
        })
      : null;
    let artifactGateTermination = null;
    let activeArtifactGateRejection = artifactGateRejection;
    if (activeArtifactGateRejection && consecutiveArtifactVerificationGateRejections >= artifactVerifyMaxRejections) {
      artifactGateTermination = formatArtifactVerificationGateTermination(consecutiveArtifactVerificationGateRejections, turnsSinceArtifact);
      activeArtifactGateRejection = null;
    }
    const verifyingArtifact = artifactNeedsVerification
      && isVerificationQueryAction(action, { knownArtifacts: [...knownArtifacts] });
    // The ordinary anti-recon gate exits through "write a rough draft." Exact
    // source-derived tasks have no valid draft before the source value exists,
    // and their necessary work includes capability discovery (`list john/run`,
    // inspect a decoder's API) that is intentionally not classified as compute.
    // Applying the generic gate here creates an impossible choice: fabricate
    // the scalar or be terminated. Source provenance already rejects guesses,
    // repetition/search-strategy stations bound loops, and the normal artifact
    // verification gate re-arms after a real output exists, so leave evidence
    // acquisition executable while continuing to emit source-specific nudges.
    let progressGate = progressAwareness && !sourceProvenance
      ? progressGateFor(action, {
          progresslessTurns,
          hasAuthoredWork,
          threshold: progressNudgeAfter,
          knownArtifacts: [...knownArtifacts],
          pendingDocumentArtifacts: [...pendingDocumentArtifacts],
          budgetSpent: queryBudget.remaining <= 0,
          needsVerification: artifactNeedsVerification,
        })
      : null;
    let progressGateTermination = null;
    if (!activeArtifactGateRejection && !artifactGateTermination && progressGate) {
      if (consecutiveProgressGateRejections >= progressGateMaxRejections) {
        progressGateTermination = formatProgressGateTermination(consecutiveProgressGateRejections, progresslessTurns);
      } else if (progressGateAllowEvery > 0
          && consecutiveProgressGateRejections > 0
          && consecutiveProgressGateRejections % progressGateAllowEvery === 0) {
        onEvent({ type: "progress_gate_bypass", progresslessTurns, consecutiveProgressGateRejections, action });
        progressGate = null;
        // Keep the counter climbing on a bypass too. Otherwise it sticks at the first
        // allowEvery multiple (e.g. 4), the bypass re-fires every turn, and the
        // >= maxRejections termination path becomes unreachable — the gate silently
        // degenerates into "allow every recon action" (the recon-spiral-to-maxTurns bug).
        // No double-count: on a bypass, progressGate is now null, so the counter is not
        // also incremented in the gateRejection branch below.
        consecutiveProgressGateRejections++;
      }
    }
    const gateRejection = externalMutationRejection
      || sourceProvenanceRejection
      || searchStrategyRejection
      || artifactGateTermination
      || activeArtifactGateRejection
      || progressGateTermination
      || progressGate;
    // Interactive investigation budget: after a generous streak of investigating (reads or
    // shell) without editing or answering, stop further investigation and require the model to
    // wrap up. This is what keeps "take a look and tell me what you think" from spiralling — a
    // soft note gets ignored, so once the budget is spent the action is not executed and the
    // model is told its next move must be `respond` (or an edit). A task that reads-then-edits
    // resets the streak and never hits this.
    const investigativeAction = action.a === "read_file" || action.a === "list_dir"
      || action.a === "search" || action.a === "inspect" || action.a === "shell" || action.a === "query" || action.a === "probe";
    if (!gateRejection && investigativeAction) investigationActionCount++;
    const interactiveStop = (interactive && !gateRejection && investigativeAction
      && interactiveReconStreak >= interactiveReconLimit)
      ? "[investigation budget reached] You have investigated enough. Do NOT read files or run more commands. If the user asked a QUESTION, your next action must be \"respond\" with your answer. If they asked you to BUILD/CREATE/CHANGE something, do NOT respond with a plan — START WRITING it NOW with write_file (or replace); build the first runnable slice and keep going."
      : null;
    const beforeShellFiles = !gateRejection && !interactiveStop && action.a === "shell" ? snapshotWorkspaceFiles(workspace) : null;
    const auditCleanupRefusal = beforeShellFiles ? compoundAuditCleanupRefusal(action.c, {
      pending: auditRecovery, workspace: exec.realWorkspace,
      sourcePaths: [...beforeShellFiles.keys()].filter(p => SOURCE_EXT_RE.test(p) && !isGeneratedPath(p)),
    }) : null;
    const auditWitnessRefusal = beforeShellFiles && auditWitness ? protectedAuditWitnessCleanupRefusal(action.c, {
      witness: auditWitness, workspace: exec.realWorkspace, initialSourcePaths: auditInitialSourcePaths,
      sourcePaths: [...beforeShellFiles.keys()].filter(p => SOURCE_EXT_RE.test(p) && !isGeneratedPath(p)
        && (() => { try { return fs.lstatSync(path.resolve(workspace, p)).isFile(); } catch { return false; } })()),
    }) : null;
    let nodeCheckRefusal = null;
    if (beforeShellFiles && isFocusedAuditCommand(action.c, verificationScript)) {
      const script = directNodeCheckScript(action.c);
      if (script) {
        try {
          const filename = exec.resolveExisting(script);
          const stat = fs.lstatSync(filename);
          if (stat.isFile() && stat.size <= 256 * 1024) {
            nodeCheckRefusal = nodeCheckSelfSpawnRefusal(action.c, {
              workspace: exec.realWorkspace, path: script, source: fs.readFileSync(filename, "utf8"),
              isCheck: true, initialSourcePaths: auditInitialSourcePaths,
              sourcePaths: [...beforeShellFiles.keys()].filter(p => {
                try { return fs.lstatSync(exec.resolveExisting(p)).isFile(); } catch { return false; }
              }),
            });
          }
        } catch { /* Unresolved or opaque checks remain subject to the executor deadline. */ }
      }
    }
    const shellScopeSnapshot = !gateRejection && !interactiveStop && action.a === "shell"
      && shellScopeGuard && typeof shellScopeGuard.capture === "function"
      ? shellScopeGuard.capture()
      : null;
    // Grounding: reject a read/edit of a file that provably doesn't exist, before it executes.
    const groundReject = ground ? groundAction(ground, action) : null;
    // Reject an edit that copies the history-slimming placeholder into a real file (would destroy it).
    const placeholderEcho = !gateRejection && !interactiveStop ? editEchoesPlaceholder(action) : null;
    // A full rewrite proposed by a SEVERED thought, of a file the panel is
    // showing, is refused once -- see logic/rewrite-gate.js for the measurement.
    const severedRewrite = !gateRejection && !interactiveStop && !placeholderEcho
      ? rewriteGate({
        action,
        thinkSevered: lastThinkSevered,
        panelPaths: new Set(openPaths),
        refusedOnce: rewriteRefusedOnce,
        fileExists: (rel) => { try { return fs.existsSync(path.resolve(workspace, rel)); } catch { return false; } },
      })
      : null;
    if (severedRewrite) {
      rewriteRefusedOnce.add(severedRewrite.path);
      metrics.severedRewriteRefusals = (metrics.severedRewriteRefusals ?? 0) + 1;
      onEvent({ type: "severed_rewrite_refused", path: severedRewrite.path, turn: turns.length });
    }
    // Reject a whole-file write with double-escaped newlines (once per path — a precise steer beats
    // letting the model burn its budget rediscovering the corruption byte-by-byte).
    const doubleEscapeKey = editPaths(action).join("\u0000");
    const doubleEscape = !gateRejection && !interactiveStop && !placeholderEcho && !severedRewrite
      && !doubleEscapeWarned.has(doubleEscapeKey) ? editDoubleEscapesNewlines(action) : null;
    // Exact-duplicate recon: a read-only action already run against an unchanged workspace cannot
    // return anything new. Replay its prior observation instead of executing it again. This fires
    // on the FIRST repeat — the progress gate only reacts after `progressNudgeAfter` turns, and a
    // gate rejection returns no information, so a looping model just re-issues the same action.
    // Panel short-circuit: a read of a file whose CURRENT contents are already
    // rendered whole in <open_files> returns nothing new. v10 spent 63 of its
    // 89 reads this way — 71% of its recon budget re-fetching its own context.
    // A true exact duplicate gets the compact turn pointer first. The live
    // panel then handles broader variants (for example a whole-file read after
    // an earlier range read) without copying source into another observation.
    // A historical read is reusable only while its exact current bytes are
    // resident in this prompt. Prompt slimming may have replaced the old body
    // with a pointer after the path slid out of <open_files>; in that state a
    // duplicate/ledger rejection creates an information-deadlocked model.
    // A newly delivered audit requests a new execution receipt. Permit one
    // execution of a required check after that audit even if this exact command
    // was green beforehand. This is not a workspace mutation or blanket reset:
    // reads, unrelated commands, subsequent repeats and caller guards stay put.
    const auditCheckRepeat = auditRecovery && action.a === "shell"
      && ((auditRecovery.needsFocused && isFocusedAuditCommand(action.c, verificationScript))
        || (auditRecovery.needsProject && verificationScript && String(action.c).trim() === verificationScript.trim()))
      && !turns.slice(Math.max(auditRecovery.turn,
        auditRecovery.needsProject && String(action.c).trim() === String(verificationScript).trim()
          ? (auditRecovery.focusedTurn ?? auditRecovery.turn) : auditRecovery.turn) + 1).some(turn =>
        turn.shellExecution && (turn.shellExecution.command === action.c || turn.shellExecution.executedCommand === action.c));
    const duplicate = !gateRejection && !interactiveStop && !groundReject && !auditCheckRepeat && !auditCleanupRefusal && !auditWitnessRefusal && !nodeCheckRefusal
      && requestedDocumentReviews.length === 0
      && readReplayIsContextSafe(action, completeOpenFiles, new Set(openPaths), packetResident)
      ? repetition.check(action)
      : null;
    let panelRedirect = null;
    // No rendered panel under the extension trajectory — the redirect's promise
    // ("already shown in <open_files> above") would be false there.
    if (!duplicate && requestedDocumentReviews.length === 0 && !extensionTrajectory
        && openFilesView && !gateRejection && !interactiveStop && !groundReject) {
      const complete = completeOpenFiles;
      // Only BROAD re-reads are the waste: a whole-file fetch of something the
      // panel already shows. A NARROW slice (a few dozen lines to author an
      // exact replace) is cheap and precisely useful — refusing it sent v12
      // into a three-turn loop asking for ten lines it could not find in a
      // 1,200-line panel. Serve those; refuse the dumps.
      const NARROW_LINES = 80;
      // A narrow read is a FOCUS request, not a wasteful whole-file re-fetch:
      // either an explicit small limit, OR a start anchor (the model wants to
      // look AT a line, e.g. `read @46`). The executor now bounds a start read
      // to a window, so serving it is cheap — and refusing it is what sent v36
      // into an eleven-turn loop on line 46, re-asking for the one line it
      // could not pick out of a 1,200-line panel.
      const isNarrow = (op) =>
        (Number.isInteger(op?.limit) && op.limit <= NARROW_LINES)
        || Number.isInteger(op?.start);
      const targets = panelRedirectReadTargets(action, complete, { narrowLines: NARROW_LINES });
      if (targets.length) {
        const listed = targets.map((t) => `${t} (${complete.get(t)} lines)`).join(", ");
        panelRedirect = `[open_files] Not re-read: ${listed} — the CURRENT, complete contents are already shown in <open_files> above, refreshed from disk every turn. Reading them again returns exactly what you can already see. Copy exact text from that panel for your next replace, or act.`;
      }
    }
    // Inspect-batch ledger veto: an `inspect` whose EVERY read sub-op re-requests a
    // line range already inside the read ledger (workspace unchanged since) would
    // return only bytes the model has already seen. Wobbled ranges evade the
    // byte-identical duplicate guard (incident 2026-07-16: overlapping inspect
    // batches of src/agent.js, ~30s of recon burned). Replay a compact pointer
    // instead of re-executing. Ordered AFTER groundReject and duplicate (and gated
    // on them) so it can never shadow a grounding reject or the exact-duplicate
    // replay; gated on !panelRedirect so the two replacement observations can't
    // both fire. New/mixed territory (any sub-op outside the ledger, or a whole-file
    // read whose extent we can't bound without reading) falls through and executes.
    const ledgerReplay = !gateRejection && !interactiveStop && !groundReject
      && !duplicate && !panelRedirect && requestedDocumentReviews.length === 0
      && readReplayIsContextSafe(action, completeOpenFiles, new Set(openPaths), packetResident)
      && (inspectFullyInLedger(action, readLedger) || readFullyInLedger(action, readLedger))
      ? ledgerReplayMessage(action, panelIsRendered)
      : null;
    let insideLedgerReread = false; // a subrange re-read evades the byte-identical dedup but is the same stall
    let result;
    let stateAuditJustEmitted = false;
    let rawObservation = null;
    let queryToolUsed = null;
    let queryOutcome = null;
    let queryExecuted = false;
    let queryPreviewProof = null;
    if (externalMutationRejection) {
      result = { observation: externalMutationRejection };
    } else if (artifactGateTermination) {
      result = { observation: artifactGateTermination, done: true, controllerStop: { kind: "artifact-verification-gate", turn: turns.length }, summary: "Stopped by artifact verification gate; grading current workspace state." };
    } else if (progressGateTermination) {
      result = { observation: progressGateTermination, done: true, controllerStop: { kind: "progress-gate", turn: turns.length }, summary: "Stopped by progress gate; grading current workspace state." };
    } else if (interactiveStop) {
      consecutiveInteractiveStops++;
      if (consecutiveInteractiveStops >= interactiveStopMax) {
        // The model has ignored the investigation stop repeatedly. Hard-terminate so an
        // interactive session can't spin until maxTurns; hand control back to the user.
        metrics.interactiveStopTerminations++;
        result = { observation: interactiveStop, done: true, controllerStop: { kind: "interactive-budget", turn: turns.length }, summary: "Stopped: I kept investigating after being asked to wrap up. Re-steer with a more specific instruction, or say \"keep going\"." };
        onEvent({ type: "interactive_budget_terminated", action, stops: consecutiveInteractiveStops });
      } else {
        result = { observation: interactiveStop };
        onEvent({ type: "interactive_budget", action });
      }
    } else if (gateRejection) {
      result = { observation: gateRejection };
    } else if (auditCleanupRefusal) {
      result = { observation: auditCleanupRefusal.correction, auditCleanupRefusal };
      metrics.compoundAuditCleanupRefusals = (metrics.compoundAuditCleanupRefusals ?? 0) + 1;
      onEvent({ type: "verification_workflow_refusal", turn: turns.length, ...auditCleanupRefusal });
    } else if (auditWitnessRefusal) {
      result = { observation: auditWitnessRefusal.correction, auditWitnessRefusal };
      metrics.auditWitnessRetentionRefusals = (metrics.auditWitnessRetentionRefusals ?? 0) + 1;
      onEvent({ type: "verification_workflow_refusal", turn: turns.length, ...auditWitnessRefusal });
    } else if (nodeCheckRefusal) {
      result = { observation: nodeCheckRefusal.correction, nodeCheckRefusal };
      metrics.nodeCheckSelfSpawnRefusals = (metrics.nodeCheckSelfSpawnRefusals ?? 0) + 1;
      onEvent({ type: "diagnostic_self_spawn_refused", turn: turns.length, ...nodeCheckRefusal });
    } else if (duplicate) {
      // Repetition is not completion authority. A pending review may require
      // a DIFFERENT shell command, so do not tell the worker DONE or mask its
      // only route to the outstanding execution.
      const auditShellRecovery = action.a === "shell" && auditRecovery;
      result = { observation: auditShellRecovery
        ? `[repetition] This identical command was not executed again (previous execution: turn ${duplicate.duplicateOfTurn}). No new receipt was created.\n${contractAuditRecoveryNote(auditRecovery)}`
        : duplicate.observation };
      metrics.duplicateActionRejections = repetition.duplicateActionRejections;
      metrics.duplicateShellRejections = repetition.duplicateShellRejections;
      metrics.inverseEditStops = repetition.inverseEditStops;
      // The exact action is deterministic against this unchanged workspace, so
      // permitting the same verb immediately again only buys another API call.
      // Replay of the self-host failure's exact prompt changed a third identical
      // read into a targeted symbol search when read_file was masked.
      if (useGrammar && !auditShellRecovery) nextMaskedVerb = action.a;
      onEvent({ type: "duplicate_action", action, duplicateOfTurn: duplicate.duplicateOfTurn, message: result.observation });
    } else if (panelRedirect) {
      // Replacement observation, not a rejection loop: the covered broad read is
      // never executed — the <open_files> panel already holds the current bytes,
      // so executing it would only re-fetch what the model can already see.
      result = { observation: panelRedirect };
      insideLedgerReread = true;   // counts toward the duplicate breaker
      metrics.panelRedirects = (metrics.panelRedirects ?? 0) + 1;
      onEvent({ type: "panel_redirect", action, message: panelRedirect });
    } else if (ledgerReplay) {
      // Replacement observation, not a rejection loop: the covered inspect is not
      // executed; the pointer stands in for it and escalates exactly like the
      // duplicate path — it counts toward the duplicate breaker (insideLedgerReread)
      // and masks the covered verb for one turn so the model must pick a different
      // source of information (an unread range, search, map, or answer).
      result = { observation: ledgerReplay };
      insideLedgerReread = true;
      metrics.ledgerReplays = (metrics.ledgerReplays ?? 0) + 1;
      if (useGrammar) nextMaskedVerb = action.a;
      onEvent({ type: "ledger_replay", action, message: ledgerReplay });
    } else if (groundReject) {
      result = { observation: groundReject };
      metrics.groundingRejects = (metrics.groundingRejects ?? 0) + 1;
      onEvent({ type: "grounding_reject", action, message: groundReject });
    } else if (severedRewrite) {
      result = { observation: severedRewrite.text };
    } else if (placeholderEcho) {
      result = { observation: placeholderEcho };
      metrics.placeholderEchoRejects = (metrics.placeholderEchoRejects ?? 0) + 1;
      // Stop slimming ENTIRELY: the placeholder the model copied lives in some other file's slimmed
      // history, so un-slimming only this edit's target leaves the temptation. Once it echoes, disable
      // slimming globally (the "*" sentinel) so no placeholder remains to re-copy.
      echoedPaths.add("*");
      for (const p of editPaths(action)) echoedPaths.add(p);
      onEvent({ type: "placeholder_echo_reject", action });
    } else if (doubleEscape) {
      result = { observation: doubleEscape };
      doubleEscapeWarned.add(doubleEscapeKey);
      metrics.doubleEscapeRejects = (metrics.doubleEscapeRejects ?? 0) + 1;
      onEvent({ type: "double_escape_reject", action });
    } else if (action.a === "query") {
      // Symbolic-tool query: answered by the KB (or a registered engine), not the shell.
      queryExecuted = true;
      const answer = tools ? await tools.answer(action.q) : "[query] grounding is not enabled — read or search the workspace instead.";
      queryToolUsed = tools?.lastTool ?? null;
      queryOutcome = tools?.lastOutcome ?? null;
      if (queryToolUsed === "preview") {
        queryPreviewProof = queryOutcome?.proof ?? tools?.get("preview")?.lastResult ?? null;
        if (queryPreviewProof) {
          queryPreviewProof = { ...queryPreviewProof, generation: workspaceEditGeneration };
          latestPreviewProof = queryPreviewProof;
          const priorActivePreviewFailure = previewFailureSequence?.active ?? null;
          previewFailureSequence = refreshPreviewFailureSequence(
            queryPreviewProof,
            action.q,
            previewFailureSequence,
          );
          if (previewFailureSequence) {
            onEvent({
              type: "preview_failure_focus",
              active: previewFailureSequence.active,
              total: previewFailureSequence.items.length,
              advanced: priorActivePreviewFailure !== previewFailureSequence.active,
            });
          }
          webEditedUnpreviewed = queryPreviewProof.status !== "pass";
          metrics.previewRuns++;
          if (queryPreviewProof.status === "pass") metrics.previewPasses++;
          else metrics.previewFailures++;
        }
      }
      result = {
        observation: answer,
        ...(queryOutcome?.blocked ? { blocked: queryOutcome.blocked } : {}),
      };
      metrics.queries = (metrics.queries ?? 0) + 1;
      if (queryOutcome?.status) {
        metrics.toolOutcomeCounts ??= {};
        metrics.toolOutcomeCounts[queryOutcome.status]
          = (metrics.toolOutcomeCounts[queryOutcome.status] ?? 0) + 1;
      }
      onEvent({
        type: "query",
        q: action.q,
        answer,
        tool: tools?.lastTool,
        ...(queryOutcome ? { outcome: queryOutcome } : {}),
        ...(queryPreviewProof ? { preview: queryPreviewProof } : {}),
      });
    } else {
      // Refuse an edit that would breach the task's immutable boundary BEFORE it
      // lands, so the model can redirect instead of building on a change that has
      // already disqualified the run (see immutableEditReason).
      const scopeRefusal = editScopeRefusal(action, editGuard);
      if (scopeRefusal) {
        result = { observation: scopeRefusal };
        metrics.immutableEditRejections = (metrics.immutableEditRejections ?? 0) + 1;
        onEvent({ type: "immutable_edit_blocked", action, message: scopeRefusal });
      } else {
        if (action.a === "shell") onEvent({ type: "activity", label: "running", detail: String(action.c || "").replace(/\s+/g, " ") });
        // Run only the parts of an inspect batch the ledger does not already
        // cover. The whole-batch guards above handle "all covered"; this is the
        // shape they miss — one new op carrying two repeats.
        const ledgerSplit = splitInspectByLedger(action, readLedger, packetResident);
        if (ledgerSplit.covered.length) {
          result = await exec.execute({ ...action, ops: ledgerSplit.remaining }, { signal });
          result.observation = `${coveredOpsNote(ledgerSplit.covered)}${result.observation ?? ""}`;
          metrics.ledgerPartialReplays = (metrics.ledgerPartialReplays ?? 0) + 1;
          metrics.ledgerPartialOpsSkipped = (metrics.ledgerPartialOpsSkipped ?? 0) + ledgerSplit.covered.length;
          onEvent({ type: "ledger_partial_replay", skipped: ledgerSplit.covered.length, ran: ledgerSplit.remaining.length });
        } else {
          result = await exec.execute(action, { signal });
        }
      }
    }
    if (action.a === "probe" && result.probeEvidence) {
      onEvent({ type: "probe", probeEvidence: structuredClone(result.probeEvidence) });
    }
    if (shellScopeSnapshot && shellScopeGuard && typeof shellScopeGuard.rollback === "function") {
      const rollback = shellScopeGuard.rollback(shellScopeSnapshot);
      if (rollback.violations.length) {
        const list = rollback.violations
          .map((violation) => `${violation.change} ${violation.path}`)
          .join(", ");
        result.shellScopeRollback = {
          clean: rollback.clean,
          violations: rollback.violations,
          restored: rollback.restored,
          remaining: rollback.remaining,
        };
        result.observation += `\n[scope] This shell action changed immutable task evidence: ${list}. `
          + `${rollback.clean ? "The protected paths were restored byte-for-byte." : "Rollback did not fully restore the protected paths."} `
          + "Any verification output from this command is invalid. Fix the source without changing tests or runner configuration, then run the original verification again.";
        metrics.shellScopeRollbacks = (metrics.shellScopeRollbacks ?? 0) + 1;
        metrics.shellScopeViolationFiles = (metrics.shellScopeViolationFiles ?? 0)
          + rollback.violations.length;
        onEvent({
          type: "shell_scope_rollback",
          action,
          violations: rollback.violations,
          restored: rollback.restored,
          clean: rollback.clean,
        });
      }
    }
    // Asking the same question a third time by regex, when the KB answers it once.
    //
    // 34 of 42 stored runs issued ZERO `query` actions, and 332 of 1,464 search
    // ops (23%) were the third-or-later search for the SAME bare identifier
    // within one run — `editScopeRefusal`, `editGuard`, `OPT_IN_GATE_ENV`. One
    // run made 81 searches, 37 of them against a single file. tb26 searched for
    // `impossibleScope` six times: a symbol it had introduced itself, whose
    // definition and call sites `defines`/`uses` return in one turn.
    //
    // Fires once per identifier, and only where the KB can actually answer —
    // advice to run a query is worse than silence when there is no query tool.
    // Count every search OP, not only a top-level `search` action: 1,324 of the
    // corpus's 1,466 search ops are sub-ops of an `inspect` batch, and one batch
    // routinely repeats an identifier twice inside itself.
    const searchedIdentifiers = (action.a === "search" ? [action] : (action.a === "inspect" ? (action.ops ?? []) : []))
      .filter((op) => op?.a === "search" && typeof op.q === "string" && /^[A-Za-z_$][\w$]{3,}$/.test(op.q))
      .map((op) => op.q);
    if (searchedIdentifiers.length && tools?.get("code") && typeof result.observation === "string"
        && !result.interrupted && !panelRedirect) {
      for (const symbol of searchedIdentifiers) {
        const seen = (repeatedSymbolSearches.get(symbol) ?? 0) + 1;
        repeatedSymbolSearches.set(symbol, seen);
        if (seen !== 3) continue;
        // Deliver the answer, do not prescribe the action. `query` is the one
        // read-only action `inspect` cannot batch, so three searches cost one
        // turn and the recommended query costs another — and ta4 ran ticket A
        // for 48 turns on the improved query example and issued zero queries.
        // Nothing else in the harness consumes `defines`/`uses` (the model's own
        // query action is the only caller), so an advised answer is one that
        // never arrives. The steer already holds both the symbol and the
        // registry; delivering costs the model nothing.
        // Direct, not through the registry: routing there would work, but it
        // records lastTool/lastOutcome, and a steer must not overwrite the
        // outcome of what the model actually asked for. That also means the
        // registry's error wrapping does not apply, so guard here — an
        // observation footer is never worth failing a turn over.
        const kb = tools.get("code");
        const ask = (verb) => { try { return String(kb.answer(`${verb} ${symbol}`) ?? ""); } catch { return ""; } };
        const defined = ask("defines");
        if (!defined) continue;
        // Silence only where the KB knows nothing: stale after edits (it will
        // not make structural claims from a pre-edit snapshot) or empty.
        // A symbol that is genuinely ABSENT still gets delivered — that is the
        // strongest answer available and the one tb27 needed, having searched a
        // name it had invented seven times with nothing to settle it.
        if (/^\[code\]/.test(defined) || /the code KB is empty/.test(defined)) continue;
        const used = ask("uses");
        // `uses` lists up to 60 sites, and pasting all of them would spend more
        // of the prompt than the repeated searches did. The count is the part
        // that changes a decision — "this is a 14-site contract, not a 1-site
        // fix" — and the first few sites are where to start; the rest stay one
        // query away.
        const usedLine = /^\[code\]/.test(used) ? "" : trimSiteList(used.split("\n")[0], symbol);
        result.observation += `\n[capability] That is your ${seen}rd search for \`${symbol}\`.`
          + ` The code KB already holds the answer, so here it is —`
          + ` \`query uses ${symbol}\` and \`query defines ${symbol}\` are how to ask it directly:\n`
          + `${defined}${usedLine ? `\n${usedLine}` : ""}`;
        metrics.repeatedSymbolSearchHints = (metrics.repeatedSymbolSearchHints ?? 0) + 1;
        onEvent({ type: "repeated_symbol_search", symbol });
        break;   // one steer per turn, however many ops tripped it
      }
    }
    // A file-scoped search for a KB symbol hides its cross-file readers; surface
    // the usage sites outside the searched scope so the symbol's role is visible.
    if (!panelRedirect && !result.interrupted && action.a === "search" && ground?.db
        && typeof result.observation === "string") {
      const usage = crossScopeUsageFooter({ action, ground });
      if (usage) {
        result.observation += usage;
        metrics.crossFileUsageNotes = (metrics.crossFileUsageNotes ?? 0) + 1;
      }
    }
    // Prose continuity aid: when the model reads a prose file, surface same-noun /
    // same-attribute disagreements as candidate continuity errors. Hypothesis: a
    // 27B under-enumerates planted inconsistencies, so a checklist helps.
    //
    // OPT-IN (=1), because a controlled same-harness A/B did not support it: on
    // continuity-repair, ON 3/5 vs OFF 3/5 — no pass-rate lift (the done-turn
    // engagement bump never converted to outcomes). The "0/5" that motivated this
    // was the frozen peer-v8 harness, not the current tree, which already passes
    // ~3/5. Kept off the hot path by default; the module/tests remain for a future
    // done-GATE experiment (delivery-voice: an advisory footer gets ignored).
    // Evidence: comparison/runs/harness-ab-continuity-repair/ab.json.
    if (process.env.BANTAM_CONTINUITY_ANCHORS === "1"
        && !panelRedirect && !result.interrupted && action.a === "read_file"
        && typeof result.observation === "string" && typeof action.p === "string"
        && /\.(md|markdown|txt)$/i.test(action.p)) {
      try {
        const proseFull = fs.readFileSync(path.join(workspace, action.p), "utf8");
        const anchorBlock = renderContinuityAnchors(continuityAnchors(proseFull));
        if (anchorBlock) {
          result.observation += `\n${anchorBlock}`;
          metrics.continuityAnchorNotes = (metrics.continuityAnchorNotes ?? 0) + 1;
        }
      } catch { /* unreadable / binary — skip the aid */ }
    }
    if (result.interrupted) {
      markInterrupted(action.a === "shell" ? "shell" : "action");
      turns.push({
        i: turns.length,
        rawOutput,
        reasoning,
        action,
        parsedAction: action,
        protocolViolation,
        observation: result.observation,
        ...(action.a === "query"
          ? { queryExecuted, queryTool: queryToolUsed, toolOutcome: queryOutcome }
          : {}),
        ...(isEditAction(action) ? { editApplied: false } : {}),
        verificationEvidence: null,
        shellExecution: null,
        ...(Object.hasOwn(result, "probeEvidence") ? { probeEvidence: structuredClone(result.probeEvidence) } : {}),
        ...(result.editOutcome ? { editOutcome: result.editOutcome } : {}),
        ...(stateAuditIssued ? { stateAudit: stateAuditSnapshot() } : {}),
        rawObservation: null,
        tookMs: nowMs() - turnStart,
        ...(modelCallIndex !== null ? { modelCallIndex } : {}),
        ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
      });
      metrics.turns++;
      onEvent({ type: "observation", ...turns.at(-1) });
      break;
    }
    const afterShellFiles = !gateRejection && !interactiveStop && action.a === "shell"
      ? snapshotWorkspaceFiles(workspace)
      : null;
    const shellChangedPaths = afterShellFiles
      ? workspaceFileChanges(beforeShellFiles, afterShellFiles)
        // Restoring byte-identical protected evidence updates filesystem mtimes.
        // Those paths were rolled back, not changed by the surviving shell
        // transaction, so keep them out of mutation provenance.
        .filter((rel) => !result.shellScopeRollback?.restored?.includes(rel))
      : [];
    const shellChangedWorkspace = shellChangedPaths.length > 0;
    // A shell command that rewrites SOURCE (sed -i, >>, tee, git apply, a codegen script) is a real
    // edit the completion gates must see — otherwise a model can regress just-verified code via shell
    // and `done` over it, since the edit-action gates only key on write_file/replace/patch/etc. Filter
    // to code files that aren't generated/cache output so an incidental log write or a build artifact
    // in a cache dir doesn't count. (A build emitting source after the last test getting one bounded
    // "re-verify" nudge is correct, not a false positive.)
    if (shellChangedPaths.some((p) => SOURCE_EXT_RE.test(p) && !isGeneratedPath(p))) {
      result.sourceEditedByShell = true;
    }
    // Files a command CREATES are visible to the harness the moment it happens.
    // Say so then — not at grading. (swb2-sympy-unitdim, 2026-07-17: one stray
    // `python -m pytest` at the root wrote .pytest_cache/ plus a rewritten
    // conftest pyc; the fix graded 2/2 hidden and the run failed on those five
    // out-of-scope files the model was never told about.)
    if (afterShellFiles && beforeShellFiles) {
      const created = shellChangedPaths.filter((p) => !beforeShellFiles.has(p));
      if (created.length) {
        const shown = created.slice(0, 8).join(", ");
        const more = created.length > 8 ? ` (+${created.length - 8} more)` : "";
        result.observation += `\n[fs] This command created ${created.length} new file(s): ${shown}${more}.`
          + " If any are caches or litter rather than intended deliverables, remove them before finishing.";
        metrics.shellCreatedFileNotes = (metrics.shellCreatedFileNotes ?? 0) + 1;
      }
    }
    for (const review of result.editOutcome?.preservationReviews ?? []) {
      metrics.editPreservationReviews = (metrics.editPreservationReviews ?? 0) + 1;
      onEvent({ type: "edit_preservation_review", turn: turns.length, review });
    }
    const directEditSucceeded = !gateRejection && !interactiveStop && !duplicate && !groundReject
      && (result.editOutcome ? result.editOutcome.applied : editSucceeded(action, result.observation));
    const directEditPaths = directEditSucceeded ? editPaths(action) : [];
    if (directEditSucceeded && action.a === "write_batch") {
      onEvent({ type: "write_batch_committed", files: directEditPaths });
    }
    // Sibling-definition done-gate bookkeeping: which files has the model
    // actually looked at, and which symbols did its own edits touch.
    if (!gateRejection && typeof action?.p === "string"
        && (action.a === "read_file" || action.a === "inspect")) {
      visitedPaths.add(normalizeWorkspaceRel(action.p));
    }
    if (Array.isArray(action?.ops)) {
      for (const op of action.ops) {
        if (op?.a === "read_file" && typeof op.p === "string") visitedPaths.add(normalizeWorkspaceRel(op.p));
      }
    }
    for (const editedPath of directEditPaths) {
      visitedPaths.add(normalizeWorkspaceRel(editedPath));
      recordEditedSymbols(editedSymbolSites, {
        file: normalizeWorkspaceRel(editedPath),
        action,
        observation: result.observation,
        workspace,
      });
    }
    // Edit-time context enrichment (both KB-derived, both bounded, both
    // once-per-symbol): cross-file reference maps for symbols this edit
    // mentions, and family conventions for a newly added affix-variant name.
    // Provenance note for literal constant tables — needs no KB, fires once
    // per run: the first int-keyed table an edit lands earns the read-your-
    // constants-from-a-source note (arm-C's shifted quant enum, 2026-08-18).
    if (directEditSucceeded && !provenanceFooterFired) {
      const provenance = constantTableFooter(action);
      if (provenance) {
        result.observation += provenance;
        provenanceFooterFired = true;
        metrics.provenanceFooters = (metrics.provenanceFooters ?? 0) + 1;
      }
    }
    if (directEditSucceeded && ground?.db && directEditPaths.length) {
      const editedFile = normalizeWorkspaceRel(directEditPaths[0]);
      const impact = impactFooter({ ground, action, editedFile, seen: impactSymbolsSeen });
      if (impact) {
        result.observation += impact;
        metrics.impactFooters = (metrics.impactFooters ?? 0) + 1;
      }
      const family = familyFooter({ ground, action, editedFile, seen: impactSymbolsSeen, symbolsIn });
      if (family) {
        result.observation += family;
        metrics.familyFooters = (metrics.familyFooters ?? 0) + 1;
      }
      for (const finding of familyFindings({ ground, action, editedFile, symbolsIn })) {
        if (!pendingFamilyFindings.has(finding.name)) pendingFamilyFindings.set(finding.name, finding);
      }
      const peer = peerFunctionFooter({ ground, action, editedFile, seen: impactSymbolsSeen,
        readSource: (rel) => exec.safeReadText(exec.resolveExisting(rel)) });
      if (peer) {
        result.observation += peer;
        metrics.peerFunctionFooters = (metrics.peerFunctionFooters ?? 0) + 1;
      }
    }
    // Web-surface edits arm the auto-preview (shell-driven edits are out of scope v1:
    // a shell build step usually precedes a test run, not a silent done).
    if (directEditPaths.some((p) => /\.(html?|css|js|mjs)$/i.test(p))) webEditedUnpreviewed = true;

    // Where the model last wrote — the only useful locus when a delimiter it
    // opened is never closed and the parser blames EOF.
    if (directEditSucceeded && action?.a === "edit_lines" && Number.isInteger(action.start)) {
      lastEditRegion = {
        path: action.p,
        start: action.start,
        lines: String(action.new ?? "").split("\n").length,
      };
    } else if (action?.a === "patch" && Array.isArray(action.edits) && directEditSucceeded) {
      // patch locates by content, not line — but for the EOF-locus rescue we need
      // a line. Find where the last patch edit's `old` text sits in the file now,
      // so a patch that drops a brace still gets an edit-region panel (v37 broke
      // via patch and had none).
      const last = action.edits[action.edits.length - 1];
      const rel = last?.p;
      try {
        const src = fs.readFileSync(exec.resolve(rel), "utf8");
        const anchor = String(last?.new ?? "").split("\n")[0];
        const idx = anchor ? src.indexOf(anchor) : -1;
        if (idx >= 0) {
          lastEditRegion = { path: rel, start: src.slice(0, idx).split("\n").length, lines: String(last?.new ?? "").split("\n").length };
        }
      } catch { /* file gone or unreadable; leave lastEditRegion as-is */ }
    }
    const freshEditFocus = directEditSucceeded
      ? currentEditFocus(action, workspace)
      : new Map();
    if (directEditSucceeded) {
      editCount += 1;
      for (const editedPath of directEditPaths) editedPathsThisRun.add(editedPath);
      // Say WHICH files the run changed, not merely that it changed something.
      // `bantam run` works on the operator's real workspace, so it cannot
      // capture a git diff the way the delegates do (preparing that baseline
      // commits), and the artifact recorded only workspaceChanged: true. tb4
      // (2026-08-16) rewrote src/fixture-runner.js and added a test file, and
      // its artifact named neither.
      metrics.editedPaths = [...editedPathsThisRun];
    }
    if (action.a === "shell" && invokesCommand(action.c, deliverable)) ranDeliverable = true;
    // Built it, never ran it: a green suite is not evidence that the COMMAND works.
    if (deliverable && !ranDeliverable && !smokeNudged && editCount >= 4) {
      result.observation += smokeNudge(deliverable, editCount);
      smokeNudged = true;
      metrics.smokeNudges = (metrics.smokeNudges ?? 0) + 1;
      onEvent({ type: "smoke_nudge", deliverable, edits: editCount });
    }
    if (directEditSucceeded || shellChangedWorkspace) {
      const priorVerifiedGeneration = doneVerificationProof?.generation === workspaceEditGeneration
        && doneVerificationProof.verification?.status === "pass"
        && doneVerificationProof.evidence?.status === "pass" ? workspaceEditGeneration : null;
      workspaceChangedDuringRun = true;
      hasAuthoredWork = true;
      workspaceEditGeneration++;
      if (priorVerifiedGeneration !== null) {
        const changed = [...new Set([...directEditPaths, ...shellChangedPaths])];
        const shown = changed.slice(0, 2).map(p => JSON.stringify(String(p).slice(0, 90))).join(", ");
        result.observation += `\n[scope] Verification invalidated: workspace generation ${priorVerifiedGeneration} -> ${workspaceEditGeneration}; changed ${shown || "workspace files"}${changed.length > 2 ? ` (+${changed.length - 2} more)` : ""}.`
          + ` Earlier PASS receipts describe generation ${priorVerifiedGeneration}, not this tree. Deleting a check script also changes the verified workspace. Finish necessary cleanup BEFORE the final focused check and configured project check; keep intended checks. Obtain fresh receipts before DONE.`;
      }
      if (previewFailureSequence) {
        previewFailureSequence = notePreviewFailureEdit(previewFailureSequence);
      }
      environmentVerificationProof = null;
      metrics.workspaceChanged = true;
      editsSinceBestSnapshot += 1;   // the regression guard only judges runs that follow an edit
      outcomeCycles.noteWorkspaceChanged();
    }
    if (result.shellExecution) result.shellExecution.workspaceReadOnly = false; // Ordinary worker shells keep their writable workspace.
    result.verificationEvidence = verificationEvidence({
      execution: result.shellExecution,
      configuredCommand: verificationScript,
      generation: workspaceEditGeneration,
      // A compound test+edit command cannot prove whether its test output
      // describes the before or after tree. A separate verifier settles it.
      invalidated: shellChangedWorkspace || Boolean(result.shellScopeRollback?.violations?.length),
    });
    if (result.verificationEvidence?.uncertainty) {
      result.observation += `\n[verification uncertainty] ${result.verificationEvidence.uncertainty}. This is not a passing check. Run the executable check directly, without output filters or shell control that can mask its exit status.`;
    }
    if (shellChangedWorkspace && result.verificationEvidence) {
      result.observation += "\n[verification-scope] This command also changed source files, so its test output is not proof of the final file state. Run the verifier separately, without source writes, to obtain current evidence.";
    }
    const shellReceipt = shellExecutionReceipt(result.shellExecution, {
      generation: workspaceEditGeneration,
      invalidated: shellChangedWorkspace || Boolean(result.shellScopeRollback?.violations?.length),
    });
    // Preserve every actual execution in controller order. A landing/project
    // check may follow a focused worker assertion in this very turn; the last
    // verificationEvidence alias alone cannot express those two facts. Cached
    // results are never appended as new executions.
    const verificationReceipts = {
      schema: VERIFICATION_RECEIPTS_SCHEMA, authority: "controller-execution-order",
      turn: turns.length, entries: [],
    };
    const recordVerification = (evidence, shell = null) => {
      if (!evidence && !shell) return;
      verificationReceipts.entries.push({ sequence: verificationReceipts.entries.length,
        verificationEvidence: verificationReceipt(evidence), shellExecution: shell });
    };
    recordVerification(result.verificationEvidence, shellReceipt);
    const currentAuditState = () => pendingContractAudit([...turns, {
      verificationEvidence: verificationReceipt(result.verificationEvidence),
      shellExecution: shellReceipt,
      ...(verificationReceipts.entries.length ? { verificationReceipts } : {}),
      contractStateAudit: result.contractStateAudit, contractAssertion: result.contractAssertion,
      controllerStop: result.controllerStop, shellScopeRollback: result.shellScopeRollback,
    }], { generation: workspaceEditGeneration, configuredCommand: verificationScript,
      verificationWorkspaceReadOnly, workspace: exec.realWorkspace });
    if (refusedEditPin && directEditSucceeded && directEditPaths.includes(refusedEditPin)) refusedEditPin = null;
    if (editRecoveryPath && directEditSucceeded && directEditPaths.includes(editRecoveryPath)) {
      onEvent({ type: "edit_recovery_completed", path: editRecoveryPath, action: action.a });
      editRecoveryPath = null;
    }
    const groundingChangedPaths = [
      ...directEditPaths,
      ...shellChangedPaths,
    ];
    for (const changedPath of groundingChangedPaths) lifecycleContractPaths.add(changedPath);
    if (lifecycleContractLogic && groundingChangedPaths.length) {
      pendingLifecycleContractViolations = lifecycleContractViolations({
        task,
        workspace,
        paths: [...lifecycleContractPaths],
      });
      if (pendingLifecycleContractViolations.length) {
        result.observation += formatLifecycleContractViolations(pendingLifecycleContractViolations);
        metrics.lifecycleContractHints++;
        onEvent({ type: "lifecycle_contract_hint", violations: pendingLifecycleContractViolations });
      }
    }
    if (groundingChangedPaths.length) {
      const normalizedOwnedPaths = groundingChangedPaths
        .map(normalizeWorkspaceRel)
        .filter(Boolean);
      workspaceCoherence.refresh(normalizedOwnedPaths);
      for (const changedPath of normalizedOwnedPaths) {
        pendingExternalChanges.delete(changedPath);
      }
    }
    if (ground && groundingChangedPaths.length) {
      const refreshed = refreshGrounding(ground, groundingChangedPaths);
      metrics.groundingRefreshMs += refreshed.ms ?? 0;
      metrics.groundingStaleFiles = ground.staleFiles.size;
      if (refreshed.ok && refreshed.refreshed.length) {
        metrics.groundingRefreshes++;
        onEvent({
          type: "grounding_refreshed",
          files: refreshed.refreshed,
          removed: refreshed.removed,
          ms: refreshed.ms,
        });
        if (groundingMap) {
          map = codeMap(ground);
          const listing = safeListing(workspace);
          env = withVerificationNote(map ? `${map}\n\n${listing}` : listing);
        }
      } else if (!refreshed.ok) {
        metrics.groundingRefreshFailures++;
        onEvent({
          type: "grounding_stale",
          files: refreshed.stale,
          error: refreshed.error,
        });
      }
    }
    if (externalMutationRejection) {
      onEvent({
        type: "external_workspace_action_blocked",
        action,
        paths: midTurnExternalPaths,
        message: externalMutationRejection,
      });
    } else if (artifactGateTermination) {
      metrics.artifactVerificationGateTerminations++;
      onEvent({ type: "artifact_verification_gate_terminated", turnsSinceArtifact, consecutiveArtifactVerificationGateRejections, action, message: artifactGateTermination });
    } else if (progressGateTermination) {
      metrics.progressGateTerminations++;
      onEvent({ type: "progress_gate_terminated", progresslessTurns, consecutiveProgressGateRejections, action, message: progressGateTermination });
    } else if (gateRejection) {
      if (sourceProvenanceRejection) {
        metrics.evidenceGateRejections++;
        if (useGrammar) nextMaskedVerb = action.a;
        onEvent({
          type: "source_provenance_gate",
          action,
          outputs: sourceProvenance?.outputs ?? [],
          sources: sourceProvenance?.sources ?? [],
          message: sourceProvenanceRejection,
        });
      } else if (searchStrategyRejection) {
        // Do not mask shell: the required escape is another shell command with
        // a genuinely different search axis (or a cheap capability/show query).
        metrics.evidenceGateRejections++;
        onEvent({
          type: "search_strategy_gate",
          action,
          strategy: searchStrategyDecision.strategy,
          failures: searchStrategyDecision.failures,
          proof: searchStrategyDecision.proof,
          message: searchStrategyRejection,
        });
      } else if (activeArtifactGateRejection) {
        metrics.artifactVerificationGateRejections++;
        consecutiveArtifactVerificationGateRejections++;
        onEvent({ type: "artifact_verification_gate", turnsSinceArtifact, action, message: gateRejection });
      } else {
        metrics.progressGateRejections++;
        consecutiveProgressGateRejections++;
        onEvent({ type: "progress_gate", progresslessTurns, action, message: gateRejection });
      }
    }
    if (directEditSucceeded && action.a === "delete_file") {
      openList = forgetOpenFile(openList, action.p);
      recentReads = forgetOpenFile(recentReads, action.p);
      forgetInspectedPath(action.p);
      focusByPath.delete(action.p);
      mutationFocusByPath.delete(action.p);
    } else if (directEditSucceeded && action.a === "move_file") {
      const priorFocus = focusByPath.get(action.from);
      const priorMutationFocus = mutationFocusByPath.get(action.from);
      openList = noteOpenFile(forgetOpenFile(openList, action.from), action.to);
      recentReads = noteOpenFile(forgetOpenFile(recentReads, action.from), action.to);
      moveInspectedPath(action.from, action.to);
      focusByPath.delete(action.from);
      mutationFocusByPath.delete(action.from);
      if (priorFocus) focusByPath.set(action.to, priorFocus);
      else focusByPath.delete(action.to);
      if (priorMutationFocus) mutationFocusByPath.set(action.to, priorMutationFocus);
      else mutationFocusByPath.delete(action.to);
    } else {
      for (const editedPath of directEditPaths) {
        openList = noteOpenFile(openList, editedPath);
        // Current edited bytes supersede an older read window. Prefer the
        // exact action seam; only fall back to a fresh Git hunk when a content
        // deletion gives us no surviving anchor.
        focusByPath.delete(editedPath);
        if (freshEditFocus.has(editedPath)) mutationFocusByPath.set(editedPath, freshEditFocus.get(editedPath));
        else if (directEditSucceeded) mutationFocusByPath.delete(editedPath);
      }
    }
    for (const shellPath of shellChangedPaths) {
      focusByPath.delete(shellPath);
      mutationFocusByPath.delete(shellPath);
    }
    // A read is useful context, not merely historical prose. Retain the exact
    // current file behind a successful read in the same bounded panel, behind
    // edited files. This is the generic replacement for one-off dispatch and
    // recovery pointers: once a seam is found, it stays visible long enough to
    // connect it.
    const readExecuted = !gateRejection && !interactiveStop && !duplicate
      && !groundReject && !panelRedirect && !ledgerReplay;
    // A refusal ("[open_files]/[ledger] Not re-read — you already have it") is
    // honest only while the file stays in the panel. The read did not execute,
    // so nothing below refreshes its recency: refresh it here, or the refused
    // file ages out of the open list, leaves the panel, and the promise expires.
    // Measured 2026-08-15 (parity8/9): done-gates.js and gate-policy.js were
    // refused, evicted, and the gate report was then written by a model that
    // could no longer see the gate table.
    if (panelRedirect || ledgerReplay) {
      const refusedPaths = action.a === "read_file" && typeof action.p === "string"
        ? [action.p]
        : (action.a === "inspect" && Array.isArray(action.ops)
          ? action.ops.filter((op) => op?.a === "read_file" && typeof op.p === "string").map((op) => op.p)
          : []);
      for (const refusedPath of refusedPaths.slice().reverse()) {
        recentReads = noteOpenFile(recentReads, refusedPath);
        noteInspectedPath(refusedPath);
      }
    }
    if (readExecuted && action.a === "read_file" && typeof action.p === "string"
        && !String(result.observation ?? "").startsWith("ERROR:")) {
      recentReads = noteOpenFile(recentReads, action.p);
      noteInspectedPath(action.p);
      rememberReadFocus(action, result.observation);
      const readPath = normalizeWorkspaceRel(action.p);
      workspaceCoherence.watch(readPath);
      pendingExternalChanges.delete(readPath);
    } else if (readExecuted && action.a === "inspect" && Array.isArray(action.ops)) {
      // The first inspect op is normally the immediate target. Since
      // noteOpenFile prepends, process in reverse to retain that priority.
      for (const op of action.ops.slice().reverse()) {
        if (op?.a === "read_file" && typeof op.p === "string") {
          recentReads = noteOpenFile(recentReads, op.p);
          noteInspectedPath(op.p);
          rememberReadFocus(op);
          const readPath = normalizeWorkspaceRel(op.p);
          workspaceCoherence.watch(readPath);
          pendingExternalChanges.delete(readPath);
        }
      }
    }
    // Sequential paging is the slowest way to find a symbol: v11 scrolled
    // src/agent.js (1,500 lines) in 100-line windows to locate one signature,
    // where the cloud arms grep the identifier and jump. After three windowed
    // reads of one large file, name the faster tools.
    if (action.a === "read_file" && typeof action.p === "string" && (action.limit || action.start)) {
      const pages = (pagedReads.get(action.p) ?? 0) + 1;
      pagedReads.set(action.p, pages);
      const totalLines = /\((\d+) lines,/.exec(String(result.observation ?? ""));
      // Re-arm on every third window, not once per run: the cellui correction
      // replay paged one 1,008-line file ~10 windows across 60 turns and met
      // this steer exactly once, at turn 17 (chat r0 artifact, 2026-08-17).
      if (pages >= 3 && pages % 3 === 0 && totalLines && Number(totalLines[1]) > 400) {
        // Replayed against the recorded turn (v11 t21): advisory phrasing
        // flipped the model to `search` 1/3 of the time, imperative 2/3. Words
        // alone don't bind it — so the next turn also loses `read_file` from
        // the grammar, leaving search/query as the way to find the symbol.
        result.observation += `\n[paging] STOP paging ${action.p} (${totalLines[1]} lines): ${pages} windowed reads and counting. Do not read another window of this file. Your next action must be a "search" for the exact identifier you need (it answers with file:line), or a "query" for the file's symbols — then read only that range.`;
        nextMaskedVerb = "read_file";
        metrics.pagingSteers = (metrics.pagingSteers ?? 0) + 1;
        onEvent({ type: "paging_steer", path: action.p, reads: pages });
      }
    }
    if (action.a === "read_file" && typeof action.p === "string") {
      const range = deliveredReadRange(action, result.observation);
      if (range) insideLedgerReread = readLedger.covers(action.p, range.start, range.end);
    } else if (!ledgerReplay && action.a === "inspect" && Array.isArray(action.ops)) {
      // Inspect wraps reads as sub-ops; without this the model can loop
      // through inspect variants the ledger never sees (observed: v5 climbed
      // to 8 bounces alternating inspects while the streak counter reset).
      // Skipped on a ledger veto: nothing was read, so there is no new range to
      // note, and allCovered=false must not clobber the veto's insideLedgerReread.
      const obsText = String(result.observation ?? "");
      const readOps = action.ops.filter((op) => op?.a === "read_file" && typeof op.p === "string");
      let allCovered = readOps.length > 0;
      let coveredOps = 0;
      let inspectPagingSteer = null;   // fire at most once per batch
      for (const op of readOps) {
        // Match this op's start as well as its path. A header alone is not
        // coverage; only intact, consecutive numbered lines qualify.
        const range = deliveredReadRange(op, obsText);
        if (!range) { allCovered = false; continue; }
        if (readLedger.covers(op.p, range.start, range.end)) coveredOps += 1;
        else allCovered = false;
        // Coverage is recorded by recordReadDelivery after prompt clipping.
        // Windowed sub-ops are pages too. The carve-off retry (chat r0 @
        // 2026-08-17T22:29) grew the same five files' windows 80→120→150→200→250
        // entirely inside inspect batches; pagedReads keyed on bare read_file
        // actions never saw a single page, so nine growing re-reads drew no
        // steer. Same counter, same threshold, one firing per batch.
        if ((op.limit || op.start) && Number(range.total) > 400) {
          const pages = (pagedReads.get(op.p) ?? 0) + 1;
          pagedReads.set(op.p, pages);
          if (pages >= 3 && pages % 3 === 0 && !inspectPagingSteer) {
            inspectPagingSteer = { path: op.p, pages, total: range.total };
          }
        }
      }
      if (inspectPagingSteer) {
        result.observation += `\n[paging] STOP paging ${inspectPagingSteer.path} (${inspectPagingSteer.total} lines): ${inspectPagingSteer.pages} windowed reads and counting, now through inspect batches. Do not read another window of this file. Your next action must be a "search" for the exact identifier you need (it answers with file:line), or a "query" for the file's symbols — then read only that range.`;
        nextMaskedVerb = "inspect";
        metrics.pagingSteers = (metrics.pagingSteers ?? 0) + 1;
        onEvent({ type: "paging_steer", path: inspectPagingSteer.path, reads: inspectPagingSteer.pages, via: "inspect" });
      }
      insideLedgerReread = allCovered;
      // Cross-file shuffle detector — the batched cousin of the paging steer.
      // The carve-off replay (chat r0 @ 2026-08-17T22:22) spent turns 6-14 on
      // SEVEN consecutive inspect batches with zero fresh sub-ops: reshuffled
      // start:1 windows of six already-read files. The exact-dupe guard can't
      // key a wobbled batch and the ledger veto rightly stands down when the
      // files exceed the panel — so nothing pushed back. Two consecutive
      // mostly-covered batches now draw a steer and mask `inspect` for a turn.
      const staleBatch = readOps.length >= 2 && coveredOps / readOps.length >= 2 / 3;
      staleInspectStreak = staleBatch ? staleInspectStreak + 1 : 0;
      // Precedence: one steer speaks at a time. A batch can qualify for both
      // this and the inspect-paging steer; stacked coaching paragraphs give
      // conflicting remedies. The more SPECIFIC steer (paging — one file, one
      // remedy) wins; shuffle stands down this turn and keeps its streak, so
      // a further stale batch without paging still earns it.
      if (staleInspectStreak >= 2 && !inspectPagingSteer) {
        result.observation += `\n[shuffle] STOP re-opening these files: ${coveredOps} of ${readOps.length} reads in this batch showed only lines already seen this run, and this is consecutive stale batch ${staleInspectStreak}. Cycling file openings is not deciding. Your next action must not be another inspect: use "query" (\`uses X\`, \`deps X\`, or a \`map arch\` overview) to map relationships across files, "search" for the exact symbol you need, or begin the actual work.`;
        nextMaskedVerb = "inspect";
        metrics.inspectShuffleSteers = (metrics.inspectShuffleSteers ?? 0) + 1;
        onEvent({ type: "inspect_shuffle_steer", staleBatches: staleInspectStreak });
        staleInspectStreak = 0;   // re-arm: two more stale batches earn the next steer
      }
    }
    for (const editedPath of directEditPaths) readLedger.invalidate(editedPath);
    for (const changedPath of shellChangedPaths) readLedger.invalidate(changedPath);
    if (action.a === "delete_file" || action.a === "move_file") {
      readLedger.invalidate(action.p ?? action.from);
    }
    if (action.a === "replace") recordReplaceFailure(metrics, result.observation);
    if (action.a === "patch") recordPatchFailure(metrics, result.observation);
    // Card 1 (Quiet Line) null-control: BANTAM_RESCUE_QUIESCENT=1 disarms the
    // rescue steers but records every would-fire — the A/B the growing steer
    // ensemble needs. Delivery is one seam so quiescence cannot half-apply.
    const steerDelivery = (name, note, deliver) => {
      if (!note) return;
      if (process.env.BANTAM_RESCUE_QUIESCENT === "1") {
        metrics.steerWouldFire = metrics.steerWouldFire ?? {};
        metrics.steerWouldFire[name] = (metrics.steerWouldFire[name] ?? 0) + 1;
        onEvent({ type: "steer_would_fire", steer: name });
        return;
      }
      deliver(note);
    };
    {
      // Struggle → audit the CONTEXT (bytes, evidence), not the effort. See
      // src/logic/context-audit.js for the measured shapes behind the triggers.
      const contextAuditNote = contextAuditSentinel.note({ action, observation: result.observation, editOutcome: result.editOutcome, now: Date.now() });
      steerDelivery("context-audit", contextAuditNote, (n) => {
        result.observation = `${result.observation ?? ""}\n\n${n}`;
        metrics.contextAudits = (metrics.contextAudits ?? 0) + 1;
        onEvent({ type: "context_audit" });
      });
    }
    {
      // 7R round 2: a probe-edit spiral ran sixty turns with no verification,
      // and every verdict-driven escalation slept. See src/logic/verify-cadence.js.
      const editApplied = turnEditApplied({ action, observation: result.observation });
      if (editApplied && (action.a === "write_file" || action.a === "replace")) {
        const unitNote = unicodeUnitGauge(task, String(action.content ?? action.new ?? ""), { priorSteers: metrics.unicodeUnitGauges ?? 0 });
        const genNote = shipTheGeneratorSteer(task, String(action.content ?? action.new ?? ""), { priorSteers: metrics.shipGeneratorSteers ?? 0 });
        steerDelivery("ship-the-generator", genNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.shipGeneratorSteers = (metrics.shipGeneratorSteers ?? 0) + 1;
        });
        steerDelivery("unicode-unit", unitNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.unicodeUnitGauges = (metrics.unicodeUnitGauges ?? 0) + 1;
        });
      }
      if (editApplied) for (const p of editPaths(action)) editedSourcePaths.add(p);
      const ranVerification = Boolean(result.verificationEvidence);
      const probeOnly = action.a === "shell" && !ranVerification && /\b(?:python3?\s+-c|node\s+(?:-e|--eval))\b/.test(String(action.c ?? ""));
      const cadenceNote = verifyCadenceSentinel.note({ editApplied, ranVerification, probeOnly });
      {
        // Maze films: sub-function patch chains at full context cost while
        // the suite stays red. See src/logic/repour.js for the shape.
        const verificationRed = result.verificationEvidence?.status === "fail";
        const repourNote = repourSentinel.note({
          replacedPath: (action.a === "replace" && editApplied) ? (action.p ?? null) : null,
          ranVerification, verificationRed,
        });
        steerDelivery("regenerate-from-formula", repourNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.repourSteers = (metrics.repourSteers ?? 0) + 1;
          onEvent({ type: "repour_steer", path: action.p });
        });
        // Falsefriend (card 27): weakening a red self-authored assertion is
        // either the correct arbitration or the classic oracle-tamper — the
        // pin demands the ruling be stated. See src/logic/contract-arbitration.js.
        const arbitrationNote = contractArbitrationPin.note({
          action, ranVerification, verificationRed,
          declared: /\bDECISION\b|contract|spec says|header says/i.test(String(action.why ?? action.reason ?? "")),
        });
        steerDelivery("contract-arbitration", arbitrationNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.contractArbitrations = (metrics.contractArbitrations ?? 0) + 1;
          onEvent({ type: "contract_arbitration", path: action.p });
        });
      }
      if (probeOnly) {
        const retypeNote = importDontRetypeSteer(String(action.c ?? ""), { editedSourceFiles: editedSourcePaths.size, priorSteers: probeSteerCount });
        steerDelivery("import-dont-retype", retypeNote, (n) => {
          probeSteerCount += 1;
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.probeDisciplineSteers = (metrics.probeDisciplineSteers ?? 0) + 1;
        });
        const tautoNote = selfInverseProbeSteer(String(action.c ?? ""), { priorSteers: metrics.tautologyProbeSteers ?? 0 });
        steerDelivery("tautological-probe", tautoNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.tautologyProbeSteers = (metrics.tautologyProbeSteers ?? 0) + 1;
        });
      }
      if (turns.length === 0) {
        const shapeNote = greenfieldBuildShapeNote(task, exec.listWorkspaceTop?.() ?? fs.readdirSync(workspace));
        steerDelivery("build-shape", shapeNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.buildShapeNotes = (metrics.buildShapeNotes ?? 0) + 1;
        });
        const enumNote = enumerateContractNote(task);
        steerDelivery("enumerate-the-contract", enumNote, (n) => {
          result.observation = `${result.observation ?? ""}\n\n${n}`;
          metrics.contractEnumNotes = (metrics.contractEnumNotes ?? 0) + 1;
        });
      }
      steerDelivery("verify-cadence", cadenceNote, (n) => {
        result.observation = `${result.observation ?? ""}\n\n${n}`;
        metrics.verifyCadenceSteers = (metrics.verifyCadenceSteers ?? 0) + 1;
        onEvent({ type: "verify_cadence" });
      });
    }
    if (action.a === "shell") {
      // Card 7: a string-shaped test failing repeatedly means the model is
      // editing a drawing it has not looked at. See src/logic/see-your-work.js.
      // No-network sandbox: distinct failed acquisition commands mean the WALL
      // is the environment. Recognize it fast instead of flailing through
      // every installer known to man (operator report, 2026-08-25).
      const wall = walledGardenGauge.note({ action, observation: result.observation });
      steerDelivery("walled-garden", wall?.note, (n) => {
        result.observation = `${result.observation ?? ""}\n\n${n}`;
        metrics.walledGardenSteers = (metrics.walledGardenSteers ?? 0) + 1;
        onEvent({ type: "walled_garden", attempts: wall.count });
      });
      const seeNote = seeYourWorkSentinel.note({ verificationEvidence: result.verificationEvidence });
      steerDelivery("see-your-work", seeNote, (n) => {
        result.observation = `${result.observation ?? ""}\n\n${n}`;
        metrics.seeYourWorkSteers = (metrics.seeYourWorkSteers ?? 0) + 1;
        onEvent({ type: "see_your_work" });
      });
    }
    if (action.a === "delete_file" || action.a === "move_file") {
      recordFileOperationFailure(metrics, action, result.observation);
    }
    if (editMadeNoChange(action, result.observation)) {
      metrics.noOpEdits++;
      metrics.noOpStreak++;
      if (useGrammar) nextMaskedVerb = action.a;
      onEvent({ type: "no_op_edit", action, message: result.observation });
      // Flail-breaker (TB2 gpt2-codegolf audit, 2026-08-20): a run of edits
      // that change nothing means the model can't localize the defect and is
      // editing blind. Steer it to DIAGNOSE — run the artifact, read its real
      // output, compare to expected — before touching the code again.
      if (metrics.noOpStreak >= 3) {
        result.observation += `\n\n[flail] ${metrics.noOpStreak} edits in a row changed NOTHING — you are editing blind, not fixing a located defect. STOP editing. RUN the program/tests now, read the ACTUAL output, and compare it line-by-line to the expected result to find the ONE specific wrong value or line. Only edit once you can name exactly what is wrong and why. Re-writing the same bytes cannot fix a numerical or logic bug.`;
      }
    } else if (action.a === "shell" || editSucceeded(action, result.observation)) {
      // Running the program (or landing a real edit) is the progress we want —
      // clear the flail streak.
      metrics.noOpStreak = 0;
    }
    // Write-without-build gate (TB2 gpt2-codegolf audit, 2026-08-20): the model
    // wrote/rewrote its code 24 times and BUILT it zero times — accumulating
    // elaborate untested code while flailing on a missing inspector tool. The
    // correctness-before-constraint RULE is advisory; this is the enforced gauge.
    // A build/run/test shell RESETS the count (the model verified its code); a
    // source write by EITHER mechanism INCREMENTS it. Counting shell heredoc/
    // redirect writes (not just write_file/replace actions) closes the hole that
    // let the 24-rewrite/0-compile run slip past: the model had gone around the
    // edit actions and written via `rm -f f.c; cat > f.c << EOF`, which the
    // action-only counter never saw. Build/run wins over write, so a combined
    // `cat > f.c; gcc f.c` still resets.
    const builtOrRan = action.a === "shell"
      && /\b(gcc|g\+\+|clang|cc|make|cmake|cargo|go\s+(build|run|test)|pytest|python3?|node|npm\s+(test|run)|\.\/[a-z_.]+|bash\s|sh\s)\b/i.test(String(action.c ?? ""));
    const wroteSource = (editSucceeded(action, result.observation) && editPaths(action).some(isSourcePath))
      || (action.a === "shell" && shellWritesSourceFile(action.c));
    if (builtOrRan) {
      metrics.editsSinceBuild = 0;
    } else if (wroteSource) {
      metrics.editsSinceBuild = (metrics.editsSinceBuild ?? 0) + 1;
      if (metrics.editsSinceBuild >= 6) {
        result.observation += `\n\n[build-gate] You have written code ${metrics.editsSinceBuild} times (including via shell heredocs/redirects) without ONCE building or running it. You are accumulating untested code — you cannot know any of it works. STOP writing. Compile and run it NOW (e.g. build it, then execute against the real inputs) and read the actual result. Get one runnable version working before writing more; a large edit tower on never-run code is almost all wrong.`;
        metrics.editsSinceBuild = 0;
      }
    }
    // Commit-to-deliverable gauge (deliverable.js): the task named a source file
    // to produce, and the model is still probing without having created it. Nudge
    // it to write the real thing before it burns its whole budget on inspection.
    if (deliverables.length && workspace) {
      const deliverableExists = (p) => fs.existsSync(path.isAbsolute(p) ? p : path.resolve(workspace, p));
      const dv = assessDeliverable(turns.length, deliverables, deliverableExists, deliverableState);
      if (dv.steer) {
        metrics.deliverableSteers++;
        result.observation += dv.message;
        onEvent({ type: "deliverable_stall", target: dv.target, turns: turns.length });
      }
      // Wheelbarrow gate (scaffold-gate.js): the model is running the whole
      // deliverable over and over with no separate verifier — the exponential
      // guess-and-check trap. An oracle is ANY code/script file in the workspace
      // that is not itself a deliverable (a numpy reference, a stage-test .c).
      const oracleExists = () => workspaceOracleExists(workspace, deliverables);
      const sc = assessScaffold(action, { deliverables, oracleExists,
        execution: result.shellExecution ?? null,
        outcome: verificationEvidence({ execution: result.shellExecution,
          invalidated: Boolean(result.shellExecution?.invalidated || result.shellScopeRollback?.violations?.length),
        })?.status ?? null,
      }, scaffoldState);
      if (sc.steer) {
        metrics.scaffoldSteers = (metrics.scaffoldSteers ?? 0) + 1;
        result.observation += `\n\n${sc.message}`;
        onEvent({ type: "scaffold_stall", runs: scaffoldState.deliverableRuns, turns: turns.length });
      }
    }
    // Same-bug stall (bug-stall.js): fires regardless of named deliverables — when
    // the identical sanitizer bug recurs, steer to isolate+unit-test that function.
    {
      const bs = assessBugStall(result.observation, bugStallState);
      if (bs.steer) {
        metrics.bugStallSteers = (metrics.bugStallSteers ?? 0) + 1;
        result.observation += bs.message;
        onEvent({ type: "bug_stall", signature: bs.signature, turns: turns.length });
      }
      const bulk = assessBulkEdit(action, {
        // A script that performs the edits is the thing being asked for; if one
        // exists in the workspace, the run already took the advice.
        // A script THIS RUN authored, not merely one present in the workspace.
        // The readdir version silenced the gate on any task that happens to ship
        // a .py — which is most of them — so the suppressor was broader than the
        // gate it guarded. What earns silence is the run having written the loop.
        scriptedEdit: () => [...editedPathsThisRun].some((n) => /\.(py|js|mjs|sh|pl|rb)$/i.test(n)),
      }, bulkEditState);
      if (bulk.steer) {
        metrics.bulkEditSteers = (metrics.bulkEditSteers ?? 0) + 1;
        result.observation += bulk.message;
        onEvent({ type: "bulk_edit", path: bulk.path, count: bulk.count, turns: turns.length });
      }
      const churn = assessScriptChurn(action, churnState);
      if (churn.steer) {
        metrics.churnSteers = (metrics.churnSteers ?? 0) + 1;
        result.observation += churn.message;
        onEvent({ type: "script_churn", family: churn.family, count: churn.count, turns: turns.length });
      }
    }
    for (const changedPath of [...new Set([...directEditPaths, ...shellChangedPaths])]) {
      if (!visualAltCoverageSnapshots.has(changedPath)) continue;
      const before = visualAltCoverageSnapshots.get(changedPath);
      const after = visualAltSnapshot(workspace, [changedPath]);
      if (after !== before) {
        metrics.visualAltCoverageRevisions++;
        visualAltCoverageSnapshots.delete(changedPath);
        onEvent({ type: "visual_alt_coverage_revision", path: changedPath });
      }
    }
    if (directEditSucceeded) {
      // A shell script the run just wrote, parse-checked before it is ever run.
      // compile-compcert authored build_compcert.sh with an unbalanced quote and
      // learned about it only at execution, as "line 101: unexpected EOF" — a
      // line number pointing where bash gave up, not where the quote opened.
      for (const editedPath of directEditPaths) {
        const hint = shellSyntaxHint(editedPath, {
          workspace,
          readFile: (rel) => { try { return fs.readFileSync(path.resolve(workspace, rel), "utf8"); } catch { return null; } },
        });
        if (hint) {
          result.observation += hint;
          metrics.shellSyntaxHints = (metrics.shellSyntaxHints ?? 0) + 1;
          onEvent({ type: "shell_syntax", path: editedPath });
          break;
        }
      }
      const asyncTestHint = asyncAssertionGuard(action, result.observation);
      if (asyncTestHint) {
        result.observation += asyncTestHint;
        metrics.asyncTestGuardHints = (metrics.asyncTestGuardHints ?? 0) + 1;
        onEvent({ type: "async_test_guard", hint: asyncTestHint.trim() });
      }
      if (visualAltCoverage && taskRequiresVisualAltAudit(task)) {
        const candidate = directEditPaths.find((editedPath) =>
          VISUAL_ALT_SOURCE_EXTENSIONS.has(path.extname(editedPath).toLowerCase())
          && !visualAltCoverageHintedPaths.has(editedPath));
        const viewObservation = [...turns].reverse()
          .find((turn) => String(turn.observation ?? "").includes("[view_image:"))
          ?.observation;
        if (candidate && viewObservation) {
          let source = "";
          try {
            source = fs.readFileSync(path.resolve(workspace, candidate), "utf8");
          } catch {
            source = "";
          }
          const gap = visualAltCoverageGap({ viewObservation, source });
          if (gap) {
            const hint = visualAltCoverageHint(gap);
            result.observation += hint;
            visualAltCoverageHintedPaths.add(candidate);
            visualAltCoverageSnapshots.set(candidate, visualAltSnapshot(workspace, [candidate]));
            metrics.visualAltCoverageHints++;
            onEvent({ type: "visual_alt_coverage_hint", path: candidate, missing: gap.missing });
          }
        }
      }
    }
    if (action.a === "shell" && /^ERROR: shell already runs in workspace/.test(result.observation)) {
      metrics.shellCwdGuards++;
    }
    if (action.a === "shell" && /^ERROR: shell file inspection is disabled/.test(result.observation)) {
      metrics.shellReadGuards++;
    }
    if (action.a === "shell" && /^(ERROR: run test commands directly|\[pipe-guard\] Ran your test WITHOUT)/.test(result.observation)) {
      metrics.testPipeGuards++;
    }
    if (action.a === "shell" && /test output digest:/.test(result.observation)) {
      metrics.testDigestHits++;
    }
    if (action.a === "shell") {
      const cycle = outcomeCycles.observe(action, result.observation, { turn: metrics.turns + 1 });
      if (cycle) {
        metrics.outcomeCycleEvents++;
        onEvent({ type: "outcome_cycle_event", ...cycle });
        if (outcomeCycleAwareness) {
          const hint = outcomeCycles.hintFor(cycle);
          if (hint) {
            result.observation += hint;
            metrics.outcomeCycleHints++;
            onEvent({ type: "outcome_cycle_hint", ...cycle, hint });
          }
        }
        if (derivedFailureContext && !derivedFailureFingerprints.has(cycle.fingerprint)) {
          const derived = deriveRepeatedFailureContext({
            task,
            fingerprint: cycle.fingerprint,
            occurrence: cycle.occurrence,
            stateAuditReason: stateAuditPolicy.reason,
          });
          if (derived) {
            derivedFailureFingerprints.add(cycle.fingerprint);
            result.observation += derived.message;
            metrics.derivedFailureContextHints++;
            onEvent({
              type: "derived_failure_context",
              remedies: derived.remedies,
              proofs: derived.proofs,
              occurrence: cycle.occurrence,
            });
          }
        }
      }
      const diagnostic = repeatedFailureDiagnostic(turns, action, result.observation);
      if (diagnostic) {
        result.observation += diagnostic;
        metrics.repeatedFailureHints++;
        onEvent({ type: "repeated_failure", diagnostic });
      }
      // The container may simply not have the thing the model is reaching for. If a registered
      // substrate provides that capability offline, name it here at the dead end, where the model
      // is looking, rather than only in the prompt's tool menu.
      const capHint = missingCapabilityHint(result.observation, tools, { command: action.c, seen: capabilityHints });
      if (capHint) {
        result.observation += `\n${capHint}`;
        metrics.capabilityHints = (metrics.capabilityHints ?? 0) + 1;
        onEvent({ type: "capability_hint", hint: capHint });
      }
    }
    // Repeated failed edits (replace/patch whose "old" didn't match) get no shell-failure diagnostic —
    // the model retries remembered text and burns turns to the cap. Escalate once per streak: the
    // current file is already in <open_files>; copy from it or rewrite with write_file.
    const failedPath = failedEditPath(action, result.observation);
    // Pin the seam for ANY refused edit, not only an anchor mismatch.
    //
    // failedEditPath answers a narrower question — did "old" fail to match —
    // and drives the stale-anchor diagnostics, so its definition stays as it
    // is. But a syntax refusal and a collateral refusal leave the model in
    // exactly the same position: it must look at the seam it just failed on.
    // tb15 (.bantam/runs/2026-08-16T21-48-38-604Z.json) refused eight edits
    // that way and the panel showed lines 256-391 on every recovery turn while
    // the edits targeted the imports and line ~5300.
    const refusedEditPath = !directEditSucceeded && isEditAction(action) && typeof action.p === "string"
      && /^ERROR\b/.test(String(result.observation ?? ""))
      ? action.p
      : null;
    const seamPath = failedPath ?? refusedEditPath;
    if (seamPath) {
      // Prioritizing the FILE is not enough when the file is 5,533 lines: the
      // recovery turn has to see the seam the edit was aiming at, or the retry
      // is authored blind against remembered structure.
      const seam = refusedEditFocus(action, workspace).get(seamPath);
      if (seam?.length) {
        focusByPath.set(seamPath, seam);
        onEvent({ type: "edit_recovery_seam", path: seamPath, ranges: seam });
      }
    }
    if (failedPath) {
      editRecoveryPath = failedPath;
      onEvent({ type: "edit_recovery_started", path: editRecoveryPath, action: action.a });
    }
    if (seamPath) refusedEditPin = seamPath;
    // The anchor streak and the refusal streak are mutually exclusive by
    // construction: an observation is one or the other, never both.
    const editRecovery = repeatedEditFailureDiagnostic(turns, action, result.observation)
      ?? repeatedRefusedEditDiagnostic(turns, action, result.observation);
    if (editRecovery) {
      result.observation += editRecovery;
      metrics.editRecoveryHints = (metrics.editRecoveryHints ?? 0) + 1;
      editRecoveryPath = failedPath ?? editRecoveryPath;
      onEvent({ type: "edit_recovery", path: editRecoveryPath });
    }
    if (stateAuditPending && action.a === "shell") {
      const probeDiagnostic = stateAuditProbeDiagnostic(action, result.observation);
      if (probeDiagnostic) {
        result.observation += probeDiagnostic;
        metrics.stateAuditProbeDiagnostics = (metrics.stateAuditProbeDiagnostics ?? 0) + 1;
        onEvent({ type: "state_audit_probe_invalid", diagnostic: probeDiagnostic.trim() });
      }
    }
    // Blast-radius CONTEXT, not a gate. Across 383 measured Codex turns not one of
    // BANTAM's sixteen defect gates ever fired -- Codex does not make the mistakes
    // they were built from. What it can still do is edit a module without knowing
    // what imports it, and the expert failure mode is confidence, not ignorance.
    // This refuses nothing; it states a fact when the fact becomes relevant.
    if (blastRadiusEnabled && turnEditApplied({ action, observation: result.observation })) {
      if (dependencyIndex === null) {
        try {
          const impact = await import("./dependency-impact.js");
          dependencyIndex = {
            ...impact.buildDependencyGraph(workspace),
            find: impact.findAffectedFiles,
          };
        } catch {
          dependencyIndex = false;
        }
      }
      if (dependencyIndex) {
        for (const edited of editPaths(action)) {
          const note = blastRadiusNote(
            edited,
            dependentsOf(edited, dependencyIndex, dependencyIndex.find),
          );
          if (note) {
            result.observation += `\n${note}`;
            metrics.blastRadiusNotes = (metrics.blastRadiusNotes ?? 0) + 1;
            break;
          }
        }
      }
    }
    const successfulShellReplay = slimSuccessfulShellReplay(
      action,
      rawObservation ?? result.observation,
      { enabled: successfulShellReplaySlim },
    );
    if (successfulShellReplay.slimmed) {
      metrics.successfulShellReplaySlims++;
      metrics.successfulShellReplayOmittedChars += successfulShellReplay.omittedCommandChars;
      onEvent({
        type: "successful_shell_replay_slim",
        omittedCommandChars: successfulShellReplay.omittedCommandChars,
      });
    }

    // Any later source mutation invalidates earlier dynamic proof. A static
    // remediation can still discharge the episode at done once the normal
    // verification gates establish that the edited generation is green.
    if (stateAuditIssued && !stateAuditJustEmitted && directEditSucceeded) {
      stateAuditPending = true;
      stateAuditEvidence = null;
    }

    if (stateAuditPending && !stateAuditJustEmitted && action.a !== "done") {
      const auditEngaged = stateAuditEngagement(action, {
          duplicate: Boolean(duplicate),
          directEditSucceeded,
          observation: result.observation,
        });
      if (auditEngaged) {
        metrics.stateAuditEngagements++;
        const probePassed = stateAuditProbePassed(action, {
          duplicate: Boolean(duplicate),
          blocked: result.blocked ?? null,
          observation: rawObservation ?? result.observation,
          configuredVerification: verificationScript,
          triggerCommand: stateAuditTriggerCommand,
          task,
        });
        if (probePassed) {
          const structuralRisks = stateAuditRiskPaths.length
            ? findStateAuditRisks(workspace, { paths: stateAuditRiskPaths })
                .filter((risk) =>
                  risk.kind === "shared-result-wrapper"
                  || risk.kind === "loop-scoped-parameter-validation")
            : [];
          stateAuditPending = structuralRisks.length > 0;
          stateAuditEvidence = stateAuditPending
            ? "focused-probe-partial"
            : "focused-probe";
          if (stateAuditPending) {
            result.observation += formatStateAuditRisks(structuralRisks);
          }
        }
        onEvent({ type: "state_audit_engaged", action: action.a, resolved: !stateAuditPending });
      }
    }

    const stateAuditTerminal = action.a === "done"
      || (action.a === "respond" && !interactive);
    // Advice that is mechanically contradicted by the final edited bytes must
    // not disappear merely because the model repeats `done`. Re-evaluate the
    // small task-derived contract over the edited-source inventory and provide
    // a bounded, exact-site rejection before the broader state audit runs.
    if (lifecycleContractLogic
        && stateAuditTerminal
        && result.done
        && metrics.lifecycleContractDoneRejections < lifecycleContractMaxRejections) {
      const contractPaths = [...lifecycleContractPaths].filter(Boolean);
      const violations = lifecycleContractViolations({ task, workspace, paths: contractPaths });
      pendingLifecycleContractViolations = violations;
      if (violations.length) {
        result.done = false;
        result.summary = undefined;
        result.observation = `[contract-logic-done] Completion is blocked while the current edited bytes contradict a task-derived lifecycle obligation.${formatLifecycleContractViolations(violations)}`;
        metrics.lifecycleContractDoneRejections++;
        onEvent({
          type: "lifecycle_contract_done_rejected",
          attempt: metrics.lifecycleContractDoneRejections,
          violations,
        });
      }
    }
    if (stateAuditPending && stateAuditTerminal && result.done) {
      const riskScope = stateAuditRiskPaths.length ? stateAuditRiskPaths : openList;
      const currentRisks = stateAuditInitialRiskCount > 0
        ? findStateAuditRisks(workspace, { paths: riskScope })
        : [];
      if (stateAuditInitialRiskCount > 0 && currentRisks.length === 0) {
        stateAuditPending = false;
        stateAuditEvidence = "static-remediation";
        onEvent({ type: "state_audit_resolved", evidence: stateAuditEvidence });
      } else {
        const futureTurns = maxTurns - turns.length - 1;
        const canDefer = stateAuditDeferralsUsed < stateAuditMaxDeferrals && futureTurns > 0;
        if (canDefer) {
          result.done = false;
          result.summary = undefined;
          result.observation = `${stateAuditDeferral(stateAuditPolicy.reason, task)}${formatStateAuditRisks(currentRisks)}`;
          stateAuditDeferralsUsed++;
          metrics.stateAuditDoneDeferrals = stateAuditDeferralsUsed;
          onEvent({
            type: "state_audit_done_deferred",
            attempt: stateAuditDeferralsUsed,
            risks: currentRisks,
          });
        } else {
          stateAuditPending = false;
          stateAuditEvidence = "bounded-exhaustion";
          const warning = {
            gate: "state_audit",
            message: "The bounded async lifecycle audit ended without focused dynamic proof; final verification still applies.",
          };
          warnings.push(warning);
          onEvent({ type: "state_audit_exhausted", risks: currentRisks, futureTurns });
        }
      }
    }

    // Static pre-gate: a syntax-broken edit is caught in ms and fed straight back,
    // instead of costing a whole test cycle. Not the hidden grader — just "does it parse".
    if (preGate && isEditAction(action)
        && result.observation && !/^ERROR/.test(result.observation)) {
      for (const editedPath of directEditPaths) {
        if (!fs.existsSync(exec.resolve(editedPath))) continue;
        const check = staticCheck(workspace, editedPath);
        if (!check.ok) {
          result.observation += `\n[pre-gate] ${editedPath} has a syntax error:\n${check.error}`;
          metrics.preGateFails = (metrics.preGateFails ?? 0) + 1;
          onEvent({ type: "pregate_fail", path: editedPath, error: check.error });
        } else if (/\.(js|mjs)$/.test(editedPath)) {
          // Fabricated-API warning: imports/method calls that the real target
          // modules cannot satisfy. Advisory — a test would catch it later,
          // but twenty turns later (self-hosting v8) is twenty turns too late.
          for (const warning of checkEditedApi(workspace, editedPath)) {
            result.observation += `\n[api-check] ${editedPath}: ${warning}`;
            onEvent({ type: "api_check_warn", path: editedPath, warning });
          }
        }
        // Broken relative imports (a typo'd / missing / renamed module) — the just-refreshed KB knows
        // exactly. WARN, don't block (it may be a forward reference the model is about to create), and
        // only when the KB is fresh for this file (a failed refresh leaves it stale, so don't guess).
        if (ground?.db && !(ground.staleFiles && [...ground.staleFiles].includes(editedPath))) {
          const broken = ground.db.query("unresolved", editedPath, "?").map((r) => r[1]);
          if (broken.length) {
            result.observation += `\n[pre-gate] ${editedPath} imports files that don't exist: ${broken.join(", ")} — fix the path or create the module.`;
            metrics.preGateFails = (metrics.preGateFails ?? 0) + 1;
            onEvent({ type: "pregate_broken_import", path: editedPath, specs: broken });
          }
        }
      }
    }

    // Optional harness-run scoped verify: after an edit, run only the tests that edit could affect
    // (test-impact graph + framework registry) and feed the trusted result back — so a small model gets
    // fast, targeted verification it didn't have to run itself. Informative, not a formal verdict; the
    // hidden terminal --verify is unchanged. Off by default (runs tests each edit turn).
    if (scopedVerify && ground?.db && directEditPaths.length
        && !(ground.staleFiles && directEditPaths.some((p) => [...ground.staleFiles].includes(p)))) {
      const plan = scopedVerifyPlan(workspace, directEditPaths, ground.db);
      if (plan) {
        onEvent({ type: "activity", label: "verifying" });
        const r = await runShellProcess(path.resolve(workspace), withNodeTestTimeout(plan.command, verificationTimeoutMs), {
          timeoutMs: verificationTimeoutMs,
          envOverrides: shellEnvOverrides,
          shellSandbox,
          shellNetwork,
          dockerImage,
          readOnlyWorkspacePaths,
          workspaceReadOnly: verificationWorkspaceReadOnly,
          signal,
          processRunner: shellProcessRunner,
        });
        if (!r.aborted) {
          result.verificationEvidence = verificationEvidence({
            execution: { ...r, workspaceReadOnly: verificationWorkspaceReadOnly }, command: plan.command, configuredCommand: verificationScript,
            generation: workspaceEditGeneration, source: "scoped",
          });
          recordVerification(result.verificationEvidence);
          verifyCadenceSentinel.note({ ranVerification: true });
          repourSentinel.note({ ranVerification: true, verificationRed: result.verificationEvidence?.status === "fail" });
          const verdict = r.timedOut ? "TIMED OUT" : (r.code === 0 ? "PASS" : "FAIL");
          const out = clip(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
          result.observation += `\n[scoped-verify] ${verdict} — ran the ${plan.tests.length} test(s) your edit affects (${plan.command}):\n${out}`;
          // Provenance stamp: the HARNESS ran these tests, so the verdict is trusted and unspoofable —
          // the model authors observation text but can never set a turn field. The done-gates honor
          // this stamp (a same-turn verification of the edit). A timeout is inconclusive -> no stamp.
          if (result.verificationEvidence?.status !== "unverified") result.scopedVerify = { verdict: result.verificationEvidence.status, command: plan.command, tests: plan.tests };
          metrics.scopedVerifies = (metrics.scopedVerifies ?? 0) + 1;
          onEvent({ type: "scoped_verify", command: plan.command, verdict, tests: plan.tests });
        }
      }
    }

    // Blind-edit spiral breaker: a small model often runs its tests once, then edits many times WITHOUT
    // re-running them (observed: one `node --test`, then ~33 edits blind, then the turn cap) — so its
    // edits are unguided and it never converges. Count consecutive edits with no verification; the model
    // running its own tests (or scoped verify feeding a result) resets the count. Once the streak hits
    // the threshold, run the configured verify ourselves and inject the real result so the next edit is
    // guided. Candidate, off by default; needs no code graph (unlike scoped verify).
    if (directEditSucceeded) editsSinceFullVerify += 1;   // what the CONFIGURED verifier has not seen
    if (action.a === "shell" && isDeliverableRun(action.c)) { blindEditStreak = 0; probeStreak = 0; turnsSinceVerify = 0; editsSinceFullVerify = 0; unverifiedEditSteerGiven = false; }
    // A scoped verify answers "you have edited without running anything", so it
    // clears the edit and probe streaks. It does NOT clear the staleness clock:
    // scoped-verify.js promises a scoped green "is always a genuine subset of a
    // full green, never a claim beyond it", and standing in for the full verify
    // is exactly a claim beyond it. Resetting turnsSinceVerify meant the
    // configured verify never went stale, never ran, and the regression guard
    // never obtained the comparable pass counts it protects with — so turning on
    // per-edit feedback silently disabled the thing that restores a broken tree.
    // BANTAM_SCOPED_VERIFY=1 broke test/agent.test.js on exactly that.
    else if (result.scopedVerify) { blindEditStreak = 0; probeStreak = 0; }
    else if (directEditSucceeded) blindEditStreak += 1;
    // Inline-eval probes (`python -c`, `node -e`) are NOT verification — they
    // test the cases the model already thought of. A streak of them without a
    // suite run trips the same breaker (swb2-sympy-rational, 2026-07-17:
    // 13 probes, zero suite runs, red baseline suite at the turn cap).
    else if (action.a === "shell" && !gateRejection && isInlineEvalProbe(action.c)) probeStreak += 1;
    turnsSinceVerify += 1; // counts every turn; only matters once an unverified edit exists
    const blindTrigger = autoVerifyBlindEdits > 0 && blindEditStreak >= autoVerifyBlindEdits;
    const probeTrigger = autoVerifyProbes > 0 && probeStreak >= autoVerifyProbes;
    // Staleness trigger: edits the CONFIGURED verifier has not seen exist, and it
    // has not run in autoVerifyStaleTurns turns — catches the read-heavy spiral
    // the consecutive-edit streak cannot see.
    //
    // Keyed on editsSinceFullVerify rather than blindEditStreak because a scoped
    // verify zeroes the streak on every edit turn, so with BANTAM_SCOPED_VERIFY=1
    // the streak never reached 1 and this never fired. The two move together
    // when scoped verify is off, which is the default.
    const staleTrigger = autoVerifyStaleTurns > 0 && editsSinceFullVerify > 0 && turnsSinceVerify >= autoVerifyStaleTurns;
    // No verification command configured — SWE-bench withholds its graders by
    // design, so the whole auto-verify block below is inert there. The triggers
    // still fire; only the ACTION needs a script. django-11211 (2026-08-17) made
    // 14 edits across 40 turns with ZERO shell calls and was never told, because
    // the one thing that says "you have edited without running anything" is
    // gated on a command the benchmark deliberately does not provide.
    //
    // The harness cannot run the tests here. It can say so, once per streak, and
    // the task text names the repo's runner.
    if ((blindTrigger || staleTrigger) && !verificationScript && !unverifiedEditSteerGiven
        && !interrupted && !result.done && !result.scopedVerify) {
      result.observation += `\n[auto-verify] You have made ${blindEditStreak} edit(s) and gone ${turnsSinceVerify} turn(s) without running anything.`
        + " No verify command is configured for this run, so nothing is checking your work but you."
        + " Run the project's own tests for the code you changed — the task names the runner — and read the result before editing further.";
      unverifiedEditSteerGiven = true;
      metrics.unverifiedEditSteers = (metrics.unverifiedEditSteers ?? 0) + 1;
      onEvent({ type: "unverified_edit_steer", edits: blindEditStreak, turns: turnsSinceVerify });
    }
    if ((blindTrigger || probeTrigger || staleTrigger) && verificationScript && !result.scopedVerify
        && !interrupted && !result.done) {
      onEvent({ type: "activity", label: "verifying" });
      const r = await runShellProcess(path.resolve(workspace), withNodeTestTimeout(verificationScript, verificationTimeoutMs), {
        timeoutMs: verificationTimeoutMs,
        envOverrides: shellEnvOverrides,
        shellSandbox,
        shellNetwork,
        dockerImage,
        readOnlyWorkspacePaths,
        workspaceReadOnly: verificationWorkspaceReadOnly,
        signal,
        processRunner: shellProcessRunner,
      });
      if (!r.aborted) {
        result.verificationEvidence = verificationEvidence({
          execution: { ...r, workspaceReadOnly: verificationWorkspaceReadOnly }, command: verificationScript, configuredCommand: verificationScript,
          generation: workspaceEditGeneration, source: "automatic",
        });
        recordVerification(result.verificationEvidence);
        verifyCadenceSentinel.note({ ranVerification: true });
        repourSentinel.note({ ranVerification: true, verificationRed: result.verificationEvidence?.status === "fail" });
        const verdict = r.timedOut ? "TIMED OUT" : (r.code === 0 ? "PASS" : "FAIL");
        // Lead with WHICH tests failed. clip() keeps the HEAD of the output,
        // and the head of a 2,000-test TAP stream is a wall of "ok 1, ok 2 …"
        // with the failures thousands of lines down. tb4 (2026-08-16) ran
        // auto-verify on turns 8, 17, 40 and 49: each told the model FAIL and
        // then showed it nothing but PASSING tests, so it could not tell what
        // broke. The shell path already solves this (executor.js, same
        // renderFailingTests); auto-verify was the path that did not.
        const rawOut = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
        let digest = "";
        if (result.verificationEvidence?.status !== "unverified") {
          const counts = result.verificationEvidence.counts;
          if (counts && counts.failed > 0) {
            digest = `VERDICT: ${counts.failed} of ${counts.total} tests FAILED (${counts.passed} passed).\n`
              + renderFailingTests(rawOut, {
                root: path.resolve(workspace),
                suspects: editedPathsThisRun,   // whose parse to check first
              });
          } else if (counts) {
            digest = `VERDICT: all ${counts.total} tests passed.\n`;
          }
        }
        const out = `${digest}${clip(rawOut)}`;
        const reason = blindTrigger
          ? `You have made ${blindEditStreak} edits without running the tests`
          : staleTrigger && !probeTrigger
            ? `You have edited but not run the tests in ${turnsSinceVerify} turns — reading and reasoning is not verification`
            : `You have run ${probeStreak} one-off eval probes without running the tests — probes only exercise the cases you already thought of`;
        // Verdict-aware close: a PASS means the model can LAND (the migreduce
        // spiral reached green mid-run but kept editing); only a non-pass says "fix".
        const close = r.code === 0
          ? `The tests PASS. If your change is complete, remove any scratch files and emit done — do not keep editing a green tree.`
          : `Use this result to fix what is still failing; do not keep editing blindly.`;
        // On green, the close LEADS: it is the only actionable sentence, and
        // trailing it after ~2,000 chars of ok-lines buried it — tb33 received
        // it at char 2,436 of 2,469, twice, and made nine more edits to the
        // cap. Red keeps the failures first for the same reason.
        result.observation += r.code === 0
          ? `\n[auto-verify] ${reason}, so I ran them for you — ${verdict}: ${digest.trim()} ${close}\n${clip(rawOut)}`
          : `\n[auto-verify] ${reason}, so I ran them for you — ${verdict}:\n${out}\n${close}`;
        if (result.verificationEvidence?.status !== "unverified") result.scopedVerify = { verdict: result.verificationEvidence.status, command: verificationScript, tests: [] };
        metrics.autoVerifies = (metrics.autoVerifies ?? 0) + 1;
        const verifyTrigger = blindTrigger ? "edits" : (staleTrigger && !probeTrigger ? "stale" : "probes");
        onEvent({ type: "auto_verify", command: verificationScript, verdict, streak: blindTrigger ? blindEditStreak : (staleTrigger ? turnsSinceVerify : probeStreak), trigger: verifyTrigger });
        blindEditStreak = 0;
        probeStreak = 0;
        turnsSinceVerify = 0;
        editsSinceFullVerify = 0;
      }
    }

    if (
      visualCompletionAuditSnapshot !== null
      && (directEditSucceeded || shellChangedPaths.length > 0)
    ) {
      visualCompletionAuditPaths = [...new Set([
        ...visualCompletionAuditPaths,
        ...directEditPaths,
        ...shellChangedPaths,
      ])];
      const nextVisualAltSnapshot = visualAltSnapshot(workspace, visualCompletionAuditPaths);
      if (nextVisualAltSnapshot !== visualCompletionAuditSnapshot) {
        metrics.visualCompletionAuditRevisions++;
        onEvent({
          type: "visual_completion_audit_revision",
          paths: visualCompletionAuditPaths,
        });
        visualCompletionAuditSnapshot = null;
      }
    }

    // Decide the post-green audit only after every harness verification path
    // has had a chance to attach its trusted scopedVerify stamp. In particular,
    // auto-verify runs after an edit rather than inside the shell-action branch.
    const stateRisks = stateAuditPolicy.enabled
      ? findStateAuditRisks(workspace, { paths: openList })
      : [];
    const auditHint = completionAuditHint({
      enabled: completionAudit,
      workspaceChanged: workspaceChangedDuringRun,
      emitted: completionAuditEmitted,
      turn: {
        action,
        observation: result.observation,
        scopedVerify: result.scopedVerify,
        verificationEvidence: verificationReceipt(result.verificationEvidence),
        shellExecution: shellReceipt,
      },
      task,
      visualAudit: visualCompletionAudit,
      lexicalAudit: lexicalContractAudit,
      requirementChecklist: requirementChecklistAudit,
      stateAudit: stateAuditPolicy.enabled,
      stateAuditReason: stateAuditPolicy.reason,
      stateRisks,
      planAudit: planAuditPolicy.enabled,
    });
    if (auditHint) {
      result.observation += auditHint;
      completionAuditEmitted = true;
      metrics.completionAuditHints++;
      if (auditHint.includes(LEXICAL_CONTRACT_AUDIT_MARKER)) {
        metrics.lexicalContractAuditHints++;
        onEvent({ type: "lexical_contract_audit" });
      }
      if (auditHint.includes(VISUAL_ALT_AUDIT_MARKER)) {
        metrics.visualCompletionAuditHints++;
        visualCompletionAuditPaths = [...new Set([...knownArtifacts, ...openList])];
        visualCompletionAuditSnapshot = visualAltSnapshot(workspace, visualCompletionAuditPaths);
      }
      const documentArtifacts = [...knownArtifacts].filter(isDocumentArtifactPath);
      if (documentArtifacts.length) {
        for (const document of documentArtifacts) pendingDocumentArtifacts.add(document);
        artifactNeedsVerification = true;
        if (planAuditPolicy.enabled) documentRevisionAfterAudit = true;
        if (planAuditPolicy.enabled) documentAuditRemediationActive = true;
        turnsSinceArtifact = 0;
        consecutiveArtifactVerificationGateRejections = 0;
        onEvent({ type: "document_review_rearmed", documents: documentArtifacts });
      }
      if (planAuditPolicy.enabled) {
        metrics.planAuditHints = (metrics.planAuditHints ?? 0) + 1;
      } else if (stateAuditPolicy.enabled) {
        metrics.stateAuditHints++;
        stateAuditIssued = true;
        stateAuditPending = true;
        stateAuditJustEmitted = true;
        stateAuditTriggerCommand = String(action.c ?? "").trim() || null;
        stateAuditRiskPaths = [...new Set(stateRisks.map((risk) => risk.path).filter(Boolean))];
        stateAuditInitialRiskCount = stateRisks.length;
        stateAuditEvidence = null;
      }
      onEvent({
        type: "completion_audit_hint",
        hint: auditHint.trim(),
        stateAudit: !planAuditPolicy.enabled && stateAuditPolicy.enabled,
        planAudit: planAuditPolicy.enabled,
      });
    }

    // Landing window: three v3-t50 runs burned their entire budget without
    // ever emitting done (rational: auto-verify fired four times and the model
    // kept polishing; aliasin: F2P green and still digging at the cap). An
    // unlanded run grades exactly like a failure, so the closing turns say so
    // out loud, and two turns from the cap the harness pays for one real
    // verify: green means the instruction is "land now"; red means the model
    // spends its final turns on the one failure that matters.
    const turnsRemaining = maxTurns - turns.length - 1;
    // One mark at the midpoint, long before the landing window: the up-front
    // budget line says the edge exists, this says where the run stands against
    // it while there is still time to change course. Once, non-interactive,
    // and never on a turn that already carries the landing countdown.
    if (!interactive && !result.done && !interrupted && !midpointNoticeGiven
        && turns.length + 1 >= Math.ceil(maxTurns / 2) && turnsRemaining > Math.max(3, Math.round(maxTurns * 0.1))) {
      midpointNoticeGiven = true;
      result.observation = `${result.observation ?? ""}
[budget] halfway: ${turns.length + 1} of ${maxTurns} turns used. If reconnaissance is still the bulk of what you have done, start converging on the deliverable now.`;
    }
    const landingWindow = Math.max(3, Math.round(maxTurns * 0.1));
    let landingPassNote = null;
    // Interactive runs land too. The carve-off's TDD turn ran to its 60-turn
    // cap with no countdown (both notes were !interactive), wrapped up with a
    // trailing promise instead of a "Next:" line, and the REPL's
    // Enter-continuation had nothing to offer (chat r0 @ 2026-08-17T22:29).
    if (interactive && !result.done && !interrupted && turnsRemaining >= 0 && turnsRemaining <= landingWindow) {
      // "Land now" over a RED check is a contradiction the model resolves by
      // obeying the louder instruction: fair-bantam (2026-08-18) held a visible
      // SyntaxError through its landing window and shipped a false done under
      // this exact note. When the deliverable channel is red, the landing
      // instruction must be fix-first, in so many words.
      const redCheck = unresolvedRunFailure(turns);
      result.observation = `${result.observation ?? ""}
[budget] ${turnsRemaining} turn${turnsRemaining === 1 ? "" : "s"} left after this one. ${redCheck
        ? `Your last check of the deliverable FAILED (${String(redCheck.reason)}). Fix that error FIRST — a done over a red check will be refused. Then land with what IS done.`
        : `Land now: finish the smallest complete piece, then wrap up with what IS done and what remains, ending with "Next: <the one step you would take next>" — the user can accept it with a single Enter.`}`;
    }
    if (!interactive && !result.done && !interrupted && turnsRemaining >= 0 && turnsRemaining <= landingWindow) {
      let landingNote = `\n[budget] ${turnsRemaining} turn${turnsRemaining === 1 ? "" : "s"} left after this one.`;
      // Name the requirement still untouched, not just the countdown.
      const untouched = untouchedNamedPaths(taskNamedPaths, editedPathsThisRun);
      if (untouched.length && (!untouchedNoticeGiven || turnsRemaining === 0)) {
        untouchedNoticeGiven = true;
        landingNote += ` The task names ${untouched.slice(0, 3).join(", ")}`
          + `${untouched.length > 3 ? ` (+${untouched.length - 3} more)` : ""}`
          + ` and this run has not edited ${untouched.length === 1 ? "it" : "them"} yet.`
          + ` If that is deliberate, say so in your done summary; otherwise do it now.`;
      }
      if (turnsRemaining <= 2 && verificationScript) {
        // The model/automatic path may already have run this configured suite
        // on this exact generation. Preserve that execution's source and full
        // command instead of erasing compound-scope evidence with a repeat.
        const currentEvidence = result.verificationEvidence;
        const currentProof = currentEvidence?.generation === workspaceEditGeneration
          && currentEvidence.configuredCommand === verificationScript
          && verificationEnvironmentMatches(currentEvidence)
          && (currentEvidence.status === "pass"
            || (currentEvidence.status === "fail" && currentEvidence.command === verificationScript))
          ? { status: currentEvidence.status, exitCode: currentEvidence.exitCode, workspaceReadOnly: currentEvidence.workspaceReadOnly,
            detail: clip(currentEvidence.rawOutput) }
          : null;
        const auditBeforeLanding = collectionAuditEnabled ? currentAuditState() : null;
        const needsPostFocusedProject = auditBeforeLanding
          && !auditBeforeLanding.needsFocused && auditBeforeLanding.needsProject;
        const cached = !needsPostFocusedProject && doneVerificationProof
          && doneVerificationProof.generation === workspaceEditGeneration
          && doneVerificationProof.command === verificationScript
          && verificationEnvironmentMatches(doneVerificationProof.verification)
          ? doneVerificationProof
          : null;
        let proof = currentProof ?? cached?.verification;
        let landingEvidence = currentProof ? currentEvidence : cached?.evidence ?? null;
        let ranLandingVerification = false;
        if (currentProof) {
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
            verification: currentProof, evidence: currentEvidence };
        }
        // A classified/clipped verdict is not raw execution evidence. Older
        // gate caches lack the receipt, so run once to obtain it rather than
        // synthesizing stdout from rendered detail.
        if (!proof || !landingEvidence) {
          onEvent({ type: "activity", label: "verifying" });
          proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
            doubleCheck: false,
            envOverrides: shellEnvOverrides,
            shellSandbox,
            shellNetwork,
            dockerImage,
            readOnlyWorkspacePaths,
            workspaceReadOnly: verificationWorkspaceReadOnly,
            processRunner: shellProcessRunner,
            onExecution: (execution) => {
              landingEvidence = verificationEvidence({
                execution, command: verificationScript, configuredCommand: verificationScript,
                generation: workspaceEditGeneration, source: "landing",
              });
              recordVerification(landingEvidence);
            },
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          // Exit zero alone does not establish a passing suite (for example,
          // empty discovery). Use the same evidence rules as automatic checks.
          if (landingEvidence && proof.status !== landingEvidence.status) {
            proof = { ...proof, status: landingEvidence.status,
              detail: `Verification did not establish a passing suite.\n${proof.detail ?? ""}` };
          }
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
            verification: proof, evidence: landingEvidence };
          ranLandingVerification = true;
          metrics.landingVerifies = (metrics.landingVerifies ?? 0) + 1;
        }
        // Keep the focused worker alias when all we did was consult an older
        // cached project check. Reusing a cache is not a new execution.
        if (ranLandingVerification) result.verificationEvidence = landingEvidence;
        delete result.scopedVerify;
        if (landingEvidence && landingEvidence.status !== "unverified") {
          result.scopedVerify = { verdict: landingEvidence.status, command: verificationScript, tests: [] };
        }
        // A landing verify is real regression evidence. If the model reached a
        // fully green snapshot, edited again, and spent its last turn without
        // re-verifying, preserve the known-good work instead of ending red.
        const landingComparable = bestCommand !== null && landingEvidence
          && (landingEvidence.command === bestCommand
            || (embeddedBaselineScope && shellContainsExactCommandSegment(landingEvidence.command, bestCommand)));
        const landingRegression = landingEvidence?.status === "fail"
          && landingComparable
          && regressionGuard
          && bestSnapshot && bestSnapshot.size
          && bestTotal > 0 && bestPassed === bestTotal
          && editsSinceBestSnapshot > 0
          && revertsOfThisSnapshot < 2;
        let landingRestored = 0;
        if (landingRegression) {
          for (const [p, content] of bestSnapshot) {
            try {
              fs.writeFileSync(exec.resolve(p), content);
              landingRestored++;
            } catch { /* best-effort restore; unchanged files remain safe */ }
          }
          if (landingRestored) {
            if (ground) {
              const refreshed = refreshGrounding(ground, [...bestSnapshot.keys()]);
              metrics.groundingRefreshMs += refreshed.ms ?? 0;
            }
            // Same promise as the regression revert below, made on the last
            // turns of the run where the model has the least room to recover
            // from a panel that does not hold what it was pointed at.
            for (const restoredPath of [...bestSnapshot.keys()].reverse()) {
              openList = noteOpenFile(openList, restoredPath);
              recentReads = noteOpenFile(recentReads, restoredPath);
            }
            metrics.regressionReverts = (metrics.regressionReverts ?? 0) + 1;
            metrics.landingReverts = (metrics.landingReverts ?? 0) + 1;
            revertsOfThisSnapshot += 1;
            editsSinceBestSnapshot = 0;
            // The failed proof described the pre-restore generation.
            workspaceEditGeneration++;
            doneVerificationProof = null;
            environmentVerificationProof = null;
            // Keep the original output identity and generation for the film,
            // but never certify the restored tree with its pre-restore check.
            if (landingEvidence) {
              result.verificationEvidence = Object.freeze({ ...landingEvidence,
                status: "unverified", invalidated: true, counts: null,
                failingTests: [], failingTestsComplete: false,
                uncertainty: "workspace restored after verification" });
            }
            delete result.scopedVerify;
            editsSinceFullVerify = Math.max(1, editsSinceFullVerify);
            onEvent({
              type: "landing_revert",
              from: bestPassed,
              to: 0,
              files: [...bestSnapshot.keys()],
            });
          }
        }
        if (ranLandingVerification && !landingRestored && landingEvidence
            && landingEvidence.status !== "unverified") {
          verifyCadenceSentinel.note({ ranVerification: true });
          repourSentinel.note({ ranVerification: true, verificationRed: landingEvidence.status === "fail" });
          blindEditStreak = 0;
          probeStreak = 0;
          turnsSinceVerify = 0;
          editsSinceFullVerify = 0;
          unverifiedEditSteerGiven = false;
        }
        // Decide the green completion directive AFTER this turn's audit has
        // run. A suite pass alone cannot promise that its review gate is clear.
        if (proof.status === "pass") landingPassNote = turnsRemaining;
        landingNote += proof.status === "pass" ? " The configured project check passes."
          : landingRestored
            ? ` The verify command FAILS on the current tree:\n${proof.detail ?? ""}\nYou broke working code with edits you never re-verified, and the budget is nearly gone — I restored your best-passing version of ${[...bestSnapshot.keys()].join(", ")} (now shown in <open_files>). Run the verify command to confirm it is green, then emit done. Do NOT re-apply the change that broke it.`
            : proof.status === "unverified"
              ? ` The verify command did not establish a current passing result:\n${proof.detail ?? ""}\nResolve the verification problem and run a conclusive check before finishing.`
              : ` The verify command FAILS on the current tree:\n${proof.detail ?? ""}\nFix exactly this, then emit done.`;
      } else {
        landingNote += " Wrap up: converge on the smallest correct change and settle outstanding verification before done. Avoid optional cleanup or unrelated edits.";
      }
      result.observation += landingNote;
      metrics.landingNotes = (metrics.landingNotes ?? 0) + 1;
      if (turnsRemaining <= landingWindow && turnsRemaining === landingWindow) {
        onEvent({ type: "landing_window", turnsRemaining });
      }
    }

    // Sharp test feedback: when a test run (the model's own OR auto-verify) shows failures, extract
    // the failing tests + their source + the exact expected-vs-actual, so the model fixes THOSE
    // instead of re-reading a wall of passing output and editing blindly. This is the "read the
    // error, fix this test" steer that lets an iterative write→run→edit loop actually converge.
    if (testFocus && result.verificationEvidence?.status === "fail") {
      const testOutput = result.verificationEvidence.rawOutput;
      const focus = formatFailingTestFocus(testOutput, workspaceTestReader(workspace), { testProvenance });
      if (focus) {
        result.observation += `\n\n${focus}`;
        metrics.testFocusHints = (metrics.testFocusHints ?? 0) + 1;
        onEvent({ type: "test_focus" });
      }

      // Track per-test failure streaks; when one test stays stuck despite repeated focused feedback,
      // sharp feedback is exhausted — spawn ONE focused diagnostic reasoning call on just that test.
      const fails = parseTestFailures(testOutput);
      const nowFailing = new Set(fails.map((f) => f.name));
      for (const k of [...failStreak.keys()]) if (!nowFailing.has(k)) { failStreak.delete(k); diagnosed.delete(k); teacherEscalated.delete(k); }
      for (const failure of fails) {
        const followup = priorDiagnosisFollowup(turns, failure);
        if (!followup) continue;
        result.observation += `\n\n${followup}`;
        metrics.diagnosisFollowups = (metrics.diagnosisFollowups ?? 0) + 1;
        onEvent({ type: "test_diagnosis_followup", test: failure.name });
        break;
      }
      if (diagnoseStuckTests) {
        const readTest = workspaceTestReader(workspace);
        let implementation = null;
        for (const f of fails) {
          const n = (failStreak.get(f.name) ?? 0) + 1;
          failStreak.set(f.name, n);
          // The grant the module documents but no caller wired (2026-08-25
          // audit): three reds on ONE test means re-patching, not re-deriving —
          // the next think gets the deep budget to re-derive. One-shot.
          if (n >= 3) deepThinkGrant = true;
          // Evidence pinning (7R, turn 129: the prompt no longer contained the
          // stuck test's source or failure line — compaction evicted the
          // load-bearing bytes and the model edited a test it could not see).
          // While red, every failing verdict re-carries source + diff into
          // recent history, where compaction keeps it.
          if (n >= 2 && f.file && f.line) {
            let pinSource = null;
            try { const pinRaw = readTest(f.file); if (pinRaw) pinSource = extractTestDiagnosticContext(pinRaw, f.line); } catch { /* skip */ }
            if (pinSource) {
              const pinDiff = f.diff.length ? f.diff.join("  ") : `${f.actual ?? "?"} vs expected ${f.expected ?? "?"}`;
              result.observation += `\n\n[fix-tests] evidence pinned for "${f.name}" (red x${n}) — the test and its failure, verbatim:\n${String(pinSource).slice(0, 1400)}\nFAILURE: ${String(pinDiff).slice(0, 300)}`;
              metrics.evidencePins = (metrics.evidencePins ?? 0) + 1;
            }
          }
          // Diagnose once a test has been stuck for diagnoseAfter verifications. Re-diagnosis (a fresh
          // reasoning pass if it stays stuck) was A/B'd on async and was null-to-negative — the model
          // got up to 4 focused reasoning passes on the same test and still couldn't crack it, so the
          // residual is model reasoning, not a lack of attempts. Single-fire is the validated behavior.
          if (n >= diagnoseAfter && !diagnosed.has(f.name) && f.file && f.line) {
            // The failing behavior can cross a tiny implementation seam (CLI -> store, route -> service).
            // Lazily hand the auxiliary call the current edited code set, not one recency-guessed file.
            // Source wins over docs and both file count and bytes are hard-bounded.
            implementation ??= buildDiagnosticImplementationContext(openList, (p) => exec.resolveExisting(p));
            if (!implementation.source) continue;
            diagnosed.set(f.name, n);
            let testSource = null;
            try { const s = readTest(f.file); if (s) testSource = extractTestDiagnosticContext(s, f.line); } catch { /* skip */ }
            const diff = f.diff.length ? f.diff.join("  ") : `${f.actual ?? "?"} vs expected ${f.expected ?? "?"}`;
            if (testSource) {
              onEvent({ type: "activity", label: "diagnosing" });
              const diag = await diagnoseFailingTest({
                model, buildRawPrompt: (i) => buildAuxPrompt(i, model.assistantPrefill, model.template),
                testName: f.name, testSource, implSource: implementation.source, diff, signal,
                task: diagnosticTaskContract, testProvenance: testProvenance(f),
              });
              if (diag) {
                const diagnosedPath = diagnosedImplementationPath(diag, implementation.paths);
                if (diagnosedPath) openList = noteOpenFile(openList, diagnosedPath);
                const applySteer = diagnosedPath
                  ? `This is an unverified hypothesis about ${diagnosedPath}. Check its trace against the current code and task contract; apply a targeted correction only if supported, then re-run the tests.`
                  : testProvenance(f) !== "protected"
                    ? "Check the diagnosis against the task contract, make the justified implementation or test correction, and re-run. A failing assertion alone does not establish which side is wrong."
                  : implementation.paths.length === 1
                    ? `Check this unverified hypothesis against ${implementation.paths[0]} and the contract before editing; re-run tests after any justified correction.`
                  : "Check this unverified hypothesis against the implementation and contract before editing; re-run tests after any justified correction.";
                result.observation += `\n\n[diagnosis of "${f.name}"] ${diag}\n→ ${applySteer}`;
                metrics.stuckDiagnoses = (metrics.stuckDiagnoses ?? 0) + 1;
                onEvent({ type: "test_diagnosis", test: f.name, implementationPaths: implementation.paths, diagnosedPath });
              }
            }
          }
          // Teacher escalation. Self-diagnosis (above) is the 27B diagnosing itself, and more of it
          // was measured null-to-negative — a logic bug whose cause the model can't articulate stays
          // stuck no matter how many self-passes it gets. So once a test is STILL red past teacherAfter
          // (strictly later than self-diagnosis), hand a STRONGER model the same test+function for a
          // root cause and feed it back as a steer. Measured 2/5 -> 5/5 on gbnf-reach where the 27B's
          // own symptom localization left it thrashing. Fires once per test; OFF unless a teacher is
          // configured; a dead teacher returns null and this is a no-op (silence, never a false steer).
          if (!firstRedTurn.has(f.name)) firstRedTurn.set(f.name, turns.length);
          if (teacherAssist && teacherDue({ streak: n, teacherAfter, firstRedTurn: firstRedTurn.get(f.name) ?? null, turnIndex: turns.length, stuckTurns: teacherStuckTurns }) && !teacherEscalated.has(f.name) && f.file && f.line) {
            teacherEscalated.add(f.name);
            implementation ??= buildDiagnosticImplementationContext(openList, (p) => exec.resolveExisting(p));
            if (implementation.source) {
              let testSource = null;
              try { const s = readTest(f.file); if (s) testSource = extractTestDiagnosticContext(s, f.line); } catch { /* skip */ }
              const diff = f.diff.length ? f.diff.join("  ") : `${f.actual ?? "?"} vs expected ${f.expected ?? "?"}`;
              onEvent({ type: "activity", label: "consulting teacher" });
              // The same-weights persona teacher: fresh context, explicit
              // distrust of the author's assumptions. Primary when the
              // operator selected "self"; the fallback whenever an external
              // teacher goes dead — the seat always has SOMEONE to ask.
              const selfTeacherInvoke = async (teacherPrompt, { signal: s } = {}) => {
                try {
                  const out = await model.complete(buildAuxPrompt(`${SELF_TEACHER_PERSONA}\n\n${teacherPrompt}`, model.assistantPrefill, model.template), { nPredict: 640, signal: s ?? signal });
                  return String(out?.content || "").replace(/<\/?think>/g, "").trim() || null;
                } catch { return null; }
              };
              const cause = await askTeacher({
                testName: f.name, testSource, implSource: implementation.source, diff,
                task: diagnosticTaskContract, testProvenance: testProvenance(f),
                invoke: teacherAssist.invoke ?? selfTeacherInvoke,
                fallback: teacherAssist.invoke ? selfTeacherInvoke : null,
                signal,
              });
              if (cause) {
                const diagnosedPath = diagnosedImplementationPath(cause, implementation.paths);
                if (diagnosedPath) openList = noteOpenFile(openList, diagnosedPath);
                const applySteer = diagnosedPath
                  ? `This is an unverified hypothesis about ${diagnosedPath}. Check its trace against the current code and task contract; apply a targeted correction only if supported, then re-run the tests.`
                  : testProvenance(f) !== "protected"
                    ? "Check the diagnosis against the task contract, make the justified implementation or test correction, and re-run. A failing assertion alone does not establish which side is wrong."
                  : implementation.paths.length === 1
                    ? `Check this unverified hypothesis against ${implementation.paths[0]} and the contract before editing; re-run tests after any justified correction.`
                  : "Check this unverified hypothesis against the implementation and contract before editing; re-run tests after any justified correction.";
                result.observation += `\n\n[teacher diagnosis of "${f.name}"] ${cause}\n→ ${applySteer}`;
                metrics.teacherDiagnoses = (metrics.teacherDiagnoses ?? 0) + 1;
                onEvent({ type: "teacher_diagnosis", test: f.name, implementationPaths: implementation.paths, diagnosedPath });
              }
            }
          }
        }
      }
    }

    // Regression guard: track the best-passing version of the edited files. On a SEVERE regression
    // (the model broke several tests from a strong base and is digging deeper), restore that version
    // and steer it to a different fix. This turns "reaches green half the time" into reliable.
    if (regressionGuard) {
      const evidence = result.verificationEvidence;
      const counts = evidence?.generation === workspaceEditGeneration ? evidence.counts : null;
      // Only compare like with like. Running ONE test file after a full-suite
      // baseline is not a regression — v13 ran `node --test test/exec.test.js`
      // (2 tests, 0 passing), the guard compared that to 705/790 from the full
      // suite, called it catastrophic, and reverted the model's working CLI
      // wiring. A narrower check must never be read as a broken build.
      const thisCommand = evidence?.command ?? null;
      const embeddedBaseline = counts
        && embeddedBaselineScope
        && bestCommand !== null
        && thisCommand !== bestCommand
        && shellContainsExactCommandSegment(thisCommand, bestCommand);
      const comparable = counts && (
        bestCommand === null
        || thisCommand === bestCommand
        || embeddedBaseline
      );
      if (counts && counts.total > 0 && !comparable) {
        result.observation += `\n[scope] That was a different test command from the one your ${bestPassed}/${bestTotal} baseline came from, so its numbers are not comparable and nothing was judged against them. Run the SAME command as your baseline to compare, or treat this as a local check only.`;
        metrics.scopeMismatchNotices = (metrics.scopeMismatchNotices ?? 0) + 1;
      }
      if (embeddedBaseline) {
        result.observation += `\n[scope] The exact baseline verifier \`${bestCommand}\` ran as a standalone segment inside this compound check. Its ${counts.passed}/${counts.total} test counts are comparable; do not rerun it solely to establish scope comparability.`;
        metrics.embeddedBaselineRecognitions = (metrics.embeddedBaselineRecognitions ?? 0) + 1;
      }
      // The first comparable measurement becomes `bestPassed` — the standard the
      // guard protects for the rest of the run. In 39 of 39 stored runs that
      // measurement came AFTER the first edit, and in 29 of them it was red. So
      // the model routinely cannot tell inherited failures from its own, and the
      // guard routinely adopts a state the model has already damaged.
      //
      // Nothing here can attribute those failures without a pre-run measurement
      // the harness does not take. What it can state with certainty is that no
      // one measured the suite first, which is the fact the model is missing.
      if (counts && counts.total > 0 && comparable && bestCommand === null
          && counts.passed < counts.total && editCount > 0 && !firstMeasurementNoticeGiven) {
        firstMeasurementNoticeGiven = true;
        const failed = counts.total - counts.passed;
        result.observation += `\n[baseline] This is the first time this suite has been measured in this run,`
          + ` and ${editCount} edit${editCount === 1 ? "" : "s"} came before it — so nothing measured this suite before you changed it.`
          + ` These ${failed} failure(s) may be yours, may be pre-existing, or both, and this run cannot tell you which.`
          + ` If that distinction matters, check one out of the way (git stash, or revert your change in one file) and run the same command again.`
          + ` ${counts.passed}/${counts.total} is now the number later runs are compared against.`;
        metrics.firstMeasurementNotices = (metrics.firstMeasurementNotices ?? 0) + 1;
        onEvent({ type: "first_measurement_unattributable", passed: counts.passed, total: counts.total, edits: editCount });
      }
      if (counts && counts.total > 0 && comparable) {
        const edited = [...new Set(openList)].filter(Boolean);
        if (counts.passed > bestPassed) {
          bestPassed = counts.passed; bestTotal = counts.total;
          bestCommand = thisCommand ?? bestCommand;
          bestSnapshot = new Map();
          revertsOfThisSnapshot = 0;
          editsSinceBestSnapshot = 0;
          for (const p of edited) { try { bestSnapshot.set(p, fs.readFileSync(exec.resolve(p), "utf8")); } catch { /* skip */ } }
        } else if (editsSinceBestSnapshot === 0) {
          // The model has not edited anything since the snapshot was taken, so
          // a lower count cannot be its doing: the suite is FLAKY. Reverting
          // here restores files to what they already are and tells the model
          // "you broke working code" when it broke nothing (v12 t76-78 burned
          // its endgame chasing a phantom regression). Say what is true.
          if (counts.passed < bestPassed) {
            result.observation += `\n[flaky-suite] This run reports ${counts.passed}/${counts.total} passing but the previous comparable run reported ${bestPassed}/${bestTotal}, with no tracked edit since. The cause is not established: check nondeterminism, environment, and test discovery before attributing this difference to the implementation. Nothing was reverted.`;
            metrics.flakySuiteNotices = (metrics.flakySuiteNotices ?? 0) + 1;
            onEvent({ type: "flaky_suite", best: bestPassed, observed: counts.passed });
          }
        } else if (bestSnapshot && bestSnapshot.size
            && (revertsOfThisSnapshot >= 2 || regressionRevertsThisRun >= RUN_REVERT_CEILING)) {
          // Stand down. Observed (self-hosting v8): SEVEN reverts of the same
          // snapshot suppressed seven distinct repair attempts — a fix often
          // requires passing through a temporary dip, and after the seventh
          // rollback the model stopped editing the file entirely. Two
          // restores is catastrophic-regression protection; more is the
          // guard fighting the repair.
          bestSnapshot = null;
          const standDownReason = revertsOfThisSnapshot >= 2
            ? "after 2 restores of the same base"
            : `after ${regressionRevertsThisRun} restores in this run`;
          result.observation += `\n[regression-guard] Standing down ${standDownReason}: your repair attempts keep dipping the suite and reverting them is now blocking the fix. No more automatic restores this run — work THROUGH the dip: make the fix, re-run the tests, and climb back above ${bestPassed}/${bestTotal} on your own.`;
          onEvent({
            type: "regression_guard_standdown",
            bestPassed,
            bestTotal,
            revertsOfThisSnapshot,
            revertsThisRun: regressionRevertsThisRun,
          });
        } else if (bestSnapshot && bestSnapshot.size && (
            // Losing a FULLY-green state must always be restored, however small the drop — reaching
            // all-tests-passing is precious and easy to fumble one edit later (orbit: hit 3/3 then
            // slid to 2/3 with a follow-on edit).
            (bestPassed === bestTotal && counts.passed < bestPassed)
            // Otherwise, restore on a SEVERE regression from a strong base.
            || (bestPassed >= Math.ceil(bestTotal * 0.6) && (bestPassed - counts.passed) >= 3))) {
          let restored = 0;
          for (const [p, content] of bestSnapshot) {
            try { fs.writeFileSync(exec.resolve(p), content); restored++; } catch { /* skip */ }
          }
          if (restored) {
            workspaceEditGeneration++;
            doneVerificationProof = null;
            environmentVerificationProof = null;
            if (ground) { const r = refreshGrounding(ground, [...bestSnapshot.keys()]); metrics.groundingRefreshMs += r.ms ?? 0; }
            // "(now shown in <open_files>)" is a promise about the NEXT prompt,
            // and writing the file does not by itself put it in the panel — the
            // panel renders a recency list under a byte budget. Measured once
            // across 49 restore notices (2026-08-16T16-16-10-688Z), the named
            // file was absent from the panel the model read the notice against,
            // leaving it told its work was rolled back and unable to see to
            // what. Same fix the refused-read path already carries (fa3de36b):
            // refresh residency where the claim is made.
            for (const restoredPath of [...bestSnapshot.keys()].reverse()) {
              openList = noteOpenFile(openList, restoredPath);
              recentReads = noteOpenFile(recentReads, restoredPath);
            }
            result.observation += `\n[reverted] Those edits regressed you from ${bestPassed}/${bestTotal} passing to ${counts.passed}/${counts.total} — you broke working code. I restored your best-passing version of ${[...bestSnapshot.keys()].join(", ")} (now shown in <open_files>). Re-run the tests to confirm, then try a DIFFERENT fix for the ones still failing — do NOT repeat the change that broke it.`;
            metrics.regressionReverts = (metrics.regressionReverts ?? 0) + 1;
            revertsOfThisSnapshot += 1;
            regressionRevertsThisRun += 1;
            onEvent({ type: "regression_revert", from: bestPassed, to: counts.passed, files: [...bestSnapshot.keys()] });
          }
        }
      }
    }
    // A fresh, bounded auditor sees only the original contract and current code,
    // not accumulated failures, repair claims, or the primary agent's role.
    // State-machine audits run early, then once more after changed code is green.
    // Collection/API audits reserve the first review for green or proposed done:
    // an incomplete initial edit must not spend the zero-work boundary review.
    const postEditGreen = result.verificationEvidence?.status === "pass"
      && result.verificationEvidence.generation === workspaceEditGeneration;
    const contractAuditCheckpoint = collectionAuditEnabled
      ? hasAuthoredWork && (postEditGreen || (action.a === "done" && result.done && !result.controllerStop))
      : ((contractAudits === 0 && directEditSucceeded) || (contractAudits === 1 && postEditGreen));
    if (contractAuditEnabled && contractAudits < 2
        && workspaceEditGeneration !== lastContractAuditGeneration
        && contractAuditCheckpoint) {
      const auditSources = collectContractAuditSources([...editedPathsThisRun, ...openList],
        (relative) => exec.safeReadText(exec.resolveExisting(relative)));
      const previousAudit = turns.filter(turn => turn.contractStateAudit).at(-1)?.contractStateAudit;
      const sameAuditedSources = collectionAuditEnabled && previousAudit
        && JSON.stringify(previousAudit.sources) === JSON.stringify(auditSources.sources.map(({ path, sha256 }) => ({ path, sha256 })));
      if (auditSources.sources.some((source) => editedPathsThisRun.has(source.path))
          && !sameAuditedSources
          && auditSources.sources.reduce((total, source) => total + source.text.length, 0) >= (collectionAuditEnabled ? 1 : 400)) {
        contractAudits++;
        lastContractAuditGeneration = workspaceEditGeneration;
        onEvent({ type: "contract_state_audit_start", generation: workspaceEditGeneration, number: contractAudits });
        try {
          result.contractStateAudit = await runContractStateAudit({ model, task,
            documents: suppliedTaskDocuments, ...auditSources, generation: workspaceEditGeneration, signal });
        } catch (error) {
          if (signal?.aborted) { markInterrupted("contract_state_audit"); break; }
          throw error;
        }
        result.observation += `\n\n${formatContractStateAudit(result.contractStateAudit)}`;
        metrics.contractStateAudits = (metrics.contractStateAudits ?? 0) + 1;
        metrics.contractStateAuditTokens = (metrics.contractStateAuditTokens ?? 0) + (result.contractStateAudit.tokens ?? 0);
        onEvent({ type: "contract_state_audit", status: result.contractStateAudit.status, generation: workspaceEditGeneration });
        if (assertionStationEnabled && result.contractStateAudit.status === "report"
            && !excludeThisTurn.includes("probe") && !excludeThisTurn.includes("shell")
            && (callerInvestigationActionLimit === null || investigationActionCount < callerInvestigationActionLimit)
            && auditSources.sources.some(source => /\.[cm]?js$/i.test(source.path))) {
          onEvent({ type: "contract_assertion_start", generation: workspaceEditGeneration,
            auditPromptSha256: result.contractStateAudit.promptSha256 });
          try {
            result.contractAssertion = await runContractAssertionStation({ workspace, model, task,
              documents: suppliedTaskDocuments, sources: auditSources.sources,
              audit: result.contractStateAudit, generation: workspaceEditGeneration,
              signal, dockerImage, processRunner: shellProcessRunner });
          } catch (error) {
            if (signal?.aborted) { markInterrupted("contract_assertion"); break; }
            throw error;
          }
          metrics.contractAssertionStations = (metrics.contractAssertionStations ?? 0) + 1;
          metrics.contractAssertionTokens = (metrics.contractAssertionTokens ?? 0) + (result.contractAssertion.tokens ?? 0);
          if (result.contractAssertion.probeEvidence) onEvent({ type: "probe",
            probeEvidence: structuredClone(result.contractAssertion.probeEvidence) });
          if (result.contractAssertion.status === "assertion_passed" && verificationScript) {
            // A preceding green suite cannot establish the post-assertion
            // checkpoint. Run the selected verifier now, on the same tree.
            let evidence = null;
            const proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
              doubleCheck: flakyVerify, envOverrides: shellEnvOverrides, shellSandbox, shellNetwork, dockerImage,
              readOnlyWorkspacePaths, workspaceReadOnly: verificationWorkspaceReadOnly,
              processRunner: shellProcessRunner,
              onExecution: execution => { evidence = verificationEvidence({ execution, command: verificationScript,
                configuredCommand: verificationScript, generation: workspaceEditGeneration, source: "completion" });
                recordVerification(evidence); },
            });
            if (proof.interrupted || abortRequested()) markInterrupted("verification");
            // A double-check can downgrade a first pass. Do not serialize the
            // first execution's success as the combined acceptance result.
            if (evidence && proof.status !== "pass") evidence = { ...evidence, status: proof.status };
            result.contractAssertion.projectVerification = verificationReceipt(evidence);
            result.contractAssertion.projectDetail = proof.detail;
            if (evidence) result.verificationEvidence = evidence;
            doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
              verification: evidence?.status === "pass" ? proof : { ...proof, status: evidence?.status ?? "unverified" }, evidence };
          }
          result.observation += `\n\n${formatContractAssertionStation(result.contractAssertion)}`;
          onEvent({ type: "contract_assertion", contractAssertion: structuredClone(result.contractAssertion),
            status: result.contractAssertion.status, generation: workspaceEditGeneration });
        }
        if (result.done && result.contractStateAudit.status === "report") {
          result.done = false;
          result.summary = undefined;
          result.observation += "\nReview this newly supplied audit before requesting completion again.";
        }
      }
    }
    // The focused assertion is the model's work; choosing the already-bound
    // project command again is a controller obligation. Execute that next
    // station directly after a fresh focus, AFTER this turn's audit/restore
    // decisions. Never credit a pre-audit focus or an older cached project.
    const auditReadyForProject = collectionAuditEnabled && !interrupted && !result.done
      && !result.contractAssertion && verificationScript ? currentAuditState() : null;
    const auditVerificationKey = auditReadyForProject
      ? `${auditReadyForProject.promptSha256}:${workspaceEditGeneration}:${verificationScript}` : null;
    if (auditReadyForProject && !auditReadyForProject.needsFocused && auditReadyForProject.needsProject
        && auditReadyForProject.focusedTurn === turns.length
        && !auditRecoveryVerifications.has(auditVerificationKey)) {
      auditRecoveryVerifications.add(auditVerificationKey); // one automatic attempt per audit/generation
      onEvent({ type: "activity", label: "verifying" });
      let evidence = null;
      const proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
        doubleCheck: flakyVerify, envOverrides: shellEnvOverrides, shellSandbox, shellNetwork, dockerImage,
        readOnlyWorkspacePaths, workspaceReadOnly: verificationWorkspaceReadOnly,
        processRunner: shellProcessRunner,
        onExecution: execution => {
          evidence = { ...verificationEvidence({ execution, command: verificationScript,
            configuredCommand: verificationScript, generation: workspaceEditGeneration, source: "automatic" }),
            auditPromptSha256: auditReadyForProject.promptSha256 };
          recordVerification(evidence);
        },
      });
      if (proof.interrupted || abortRequested()) markInterrupted("verification");
      if (evidence && proof.status !== "pass") evidence = { ...evidence, status: proof.status };
      result.verificationEvidence = evidence;
      const status = evidence?.status ?? "unverified";
      doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
        verification: { ...proof, status }, evidence };
      delete result.scopedVerify;
      if (status !== "unverified") result.scopedVerify = { verdict: status, command: verificationScript, tests: [] };
      metrics.contractAuditRecoveryVerifies = (metrics.contractAuditRecoveryVerifies ?? 0) + 1;
      result.observation += `\n[contract-audit-check] Focused assertion accepted. The controller then executed the exact configured project check: ${verificationScript}. Result: ${status.toUpperCase()}.\n${clip(proof.detail ?? "")}`;
      onEvent({ type: "contract_audit_verification", auditTurn: auditReadyForProject.turn,
        generation: workspaceEditGeneration, command: verificationScript, status });
      verifyCadenceSentinel.note({ ranVerification: true });
      repourSentinel.note({ ranVerification: true, verificationRed: status === "fail" });
      if (status === "pass") {
        blindEditStreak = probeStreak = turnsSinceVerify = editsSinceFullVerify = 0;
        unverifiedEditSteerGiven = false;
        const focusedCommand = shellReceipt?.executedCommand;
        const focusedLabel = typeof focusedCommand === "string"
          ? ` Focused command${focusedCommand.length > 180 ? " (excerpt)" : ""}: ${JSON.stringify(focusedCommand.slice(0, 180))}.` : "";
        result.observation += `\n[auto-verify] The focused and configured project receipts are now complete on generation ${workspaceEditGeneration}.${focusedLabel}`
          + " No optional cleanup remains. Keep the passing check as regression coverage; it is not disposable scratch. If the task is complete, request DONE now on this unchanged tree. Repair a real unfinished requirement if needed, then reverify. Any workspace edit or deletion invalidates these receipts.";
      }
    }
    // CLI and API are separate surfaces. A successful API assertion or suite
    // must not silently replace the explicitly requested process contract.
    // Reuse the existing isolated probe/fact machinery; no candidate code is
    // imported by this controller and no fixture/expected value comes from a
    // hidden judge. One station attempt per current workspace generation.
    if (cliContract && hasAuthoredWork && !interrupted && !result.controllerStop
        && (result.verificationEvidence?.status === "pass" || action.a === "done")
        && !cliStationGenerations.has(workspaceEditGeneration)
        && (callerInvestigationActionLimit === null || investigationActionCount < callerInvestigationActionLimit)) {
      const sources = collectContractAuditSources([cliContract.module, ...editedPathsThisRun, ...openList],
        relative => exec.safeReadText(exec.resolveExisting(relative))).sources;
      if (sources.some(source => source.path === cliContract.module)) {
        cliStationGenerations.add(workspaceEditGeneration);
        onEvent({ type: "contract_cli_start", generation: workspaceEditGeneration, module: cliContract.module });
        try {
          cliVerification = await runContractCliStation({ workspace, model, task, documents: suppliedTaskDocuments,
            sources, generation: workspaceEditGeneration, signal, dockerImage,
            processRunner: shellProcessRunner, contract: cliContract });
        } catch (error) {
          if (signal?.aborted) { markInterrupted("contract_cli"); break; }
          throw error;
        }
        result.cliVerification = cliVerification;
        metrics.cliVerificationRuns = (metrics.cliVerificationRuns ?? 0) + 1;
        metrics.cliVerificationTokens = (metrics.cliVerificationTokens ?? 0) + (cliVerification.tokens ?? 0);
        if (cliVerification.probeEvidence) onEvent({ type: "probe", probeEvidence: structuredClone(cliVerification.probeEvidence) });
        result.observation += `\n\n${formatContractCliStation(cliVerification)}`;
        onEvent({ type: "contract_cli", cliVerification: structuredClone(cliVerification),
          generation: workspaceEditGeneration, status: cliVerification.status });
        if (cliVerificationPassed(cliContract, cliVerification, { generation: workspaceEditGeneration }) && verificationScript) {
          // Record a new configured execution AFTER this additional station.
          // A preceding green suite is not a substitute for this ordering.
          let evidence = null;
          const proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
            doubleCheck: flakyVerify, envOverrides: shellEnvOverrides, shellSandbox, shellNetwork, dockerImage,
            readOnlyWorkspacePaths, workspaceReadOnly: verificationWorkspaceReadOnly, processRunner: shellProcessRunner,
            onExecution: execution => {
              evidence = verificationEvidence({ execution, command: verificationScript,
                configuredCommand: verificationScript, generation: workspaceEditGeneration, source: "automatic" });
              recordVerification(evidence);
            },
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          if (evidence && proof.status !== "pass") evidence = { ...evidence, status: proof.status };
          cliVerification.projectVerification = verificationReceipt(evidence);
          result.verificationEvidence = evidence;
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
            verification: { ...proof, status: evidence?.status ?? "unverified" }, evidence };
          result.observation += `\n[cli-project-check] The configured verifier ran after the CLI station: ${evidence?.status ?? "unverified"}.\n${clip(proof.detail ?? "")}`;
        }
      }
    }
    if (landingPassNote !== null) {
      const pending = collectionAuditEnabled ? currentAuditState() : null;
      if (landingPassNote === 0 && terminalClosureEligible({
        allowance: terminalClosureTurns, used: metrics.terminalClosure.used,
        turnsUsed: turns.length + 1, workTurnLimit: maxTurns, action, proof: doneVerificationProof,
        generation: workspaceEditGeneration, configuredCommand: verificationScript, workspace: exec.realWorkspace,
        verificationWorkspaceReadOnly, pendingAudit: cliContract && !cliVerificationPassed(cliContract, cliVerification,
          { generation: workspaceEditGeneration }) ? { ...pending, needsCli: true } : pending, interrupted,
        controllerStopped: controllerStop || result.controllerStop, resultDone: result.done, callerExcludedActions,
        freshEvidence: verificationReceipts.entries.some(entry => entry.verificationEvidence?.status === "pass"
          && entry.verificationEvidence.generation === workspaceEditGeneration),
      })) {
        terminalClosureAvailable = true;
        Object.assign(metrics.terminalClosure, { granted: true, grantedTurn: turns.length, generation: workspaceEditGeneration });
        onEvent({ type: "terminal_closure", phase: "granted", ...metrics.terminalClosure });
      }
      result.observation += pending
        ? `\n[completion state] Project green is not yet completion: ${pending.missing.join(" + ")} remains. ${landingPassNote === 0 ? "No actions remain; completion is unresolved." : pending.needsFocused
          ? "Next action: run the focused API assertion directly, without pipes, status echoes or another command. Do not edit merely to satisfy a review; demonstrate or disprove its claim."
          : `Next action: run the configured project check directly (${verificationScript}) on this unchanged tree.`} Do not emit done while this evidence is missing.`
        : landingPassNote === 0
          ? terminalClosureAvailable ? `\n${terminalClosureNote(maxTurns)}`
            : "\n[completion state] Verification requirements are satisfied, but no actions remain for an accepted done."
          : landingPassNote <= 1
            ? "\n[completion state] The current checks and audit-recovery requirements are satisfied. Emit done now with the verified result and any remaining limitations. Disclose leftover scratch; do not spend the final action on optional cleanup. Any necessary edit still requires verification."
            : "\n[completion state] The current checks and audit-recovery requirements are satisfied. Finish without optional changes; any necessary edit requires fresh verification before done.";
    }
    if (collectionAuditEnabled && action.a === "done" && result.done && !result.controllerStop) {
      const pendingAudit = pendingContractAudit(turns, { generation: workspaceEditGeneration,
        configuredCommand: verificationScript, verificationWorkspaceReadOnly, workspace: exec.realWorkspace });
      if (pendingAudit) {
        result.done = false;
        result.summary = undefined;
        result.observation = contractAuditRecoveryNote(pendingAudit);
        metrics.contractAuditRecoveryRejections = (metrics.contractAuditRecoveryRejections ?? 0) + 1;
        onEvent({ type: "contract_audit_recovery", auditTurn: pendingAudit.turn,
          promptSha256: pendingAudit.promptSha256, generation: workspaceEditGeneration });
      }
    }
    // Done-gates. The check runs in every mode; delivery decides whether to block an
    // unattended run, block on the user's explicit instruction, or warn a human about a harness
    // suspicion. The old chain was skipped whenever interactive, which let the REPL print a green
    // check over work the model never verified.
    // `respond` returns done:true straight from the executor, bypassing this
    // whole chain. In autonomous mode that is a side door around every gate:
    // v26 did five queries, four reads, zero edits, then emitted
    //   respond: "I'll implement the exec mode. Let me first understand..."
    // — a PLAN, accepted as a finished answer, on an untouched tree. A build
    // task has no one to respond TO; treat an autonomous respond as a done and
    // make it face the same gates (empty_done catches exactly this).
    const isDisguisedDone = action.a === "respond" && result.done && !interactive && !advisoryMode;
    // Read-only autonomous specialists may need `respond` as their only legal
    // exit. Implementation runs still have edit/shell routes and must repair
    // the defect instead of describing it as a terminal response.
    const autonomousImplementationRouteAvailable = !callerExcludedActions.includes("write_file")
      || (writeBatch && !callerExcludedActions.includes("write_batch"))
      || !callerExcludedActions.includes("replace")
      || !callerExcludedActions.includes("shell");
    if (isDisguisedDone && autonomousImplementationRouteAvailable) {
      metrics.implementationRespondRejections++;
      result.done = false;
      result.summary = undefined;
      result.responded = false;
      result.observation = implementationResponseObservation(String(action.text ?? ""));
      forceBuildEdit = true;
      onEvent({ type: "implementation_respond_rejected" });
    } else if (action.a === "done" && result.done) {
      const decision = evaluateDoneGates({
        turns,
        task,
        workspace,
        // When the run began. missing_outputs needs it to tell a deliverable the
        // run WROTE from one the image merely shipped: query-optimize (2026-08-21)
        // develops in sol.sql while the grader reads my-sql-query.sql, which
        // exists and is non-empty because the task provided a stub.
        runStartedAt,
        interactive,
        immutableInv,
        immutableSnap,
        ledgerMax: requirementLedgerMax,
        latestPreview: latestPreviewProof,
        workspaceGeneration: workspaceEditGeneration,
        verifierConfigured: Boolean(verificationScript),
        visualTask,
        summary: result.summary,
        // Panel-resident files count as examined for coverage — but only when
        // the panel actually renders; the extension trajectory maintains the
        // map without showing it, and invisible bytes are not examination.
        panelComplete: extensionTrajectory ? new Set() : new Set(completeOpenFiles.keys()),
        probeDemand: probeDemandGate,
        constantGrounding: constantGroundingGate,
        siblingSweep: siblingSweepGate,
        readWorkspaceFile: (rel) => {
          try {
            const full = path.resolve(workspace, rel);
            if (!full.startsWith(path.resolve(workspace))) return null;
            return fs.readFileSync(full, "utf8");
          } catch { return null; }
        },
        completionAuditEmitted,
        count: (name) => gateCounts[name] ?? 0,
      });
      if (decision) {
        const delivery = deliveryFor(decision.gate, { interactive, visualTask, specGap });
        if (delivery === BLOCK) {
          gateCounts[decision.gate] = (gateCounts[decision.gate] ?? 0) + 1;
          metrics[GATE_METRIC[decision.gate]] = gateCounts[decision.gate];
          result.done = false;
          result.summary = undefined;
          result.observation = decision.message;
          onEvent({ type: "done_rejected", reason: decision.message, gate: decision.gate });
        } else if (delivery === WARN) {
          // Every warning this done earned, not just the first. A warned done is
          // ACCEPTED and the run ends here, so a warning dropped now is dropped
          // for good — and the one most worth hearing (a red render) sits late in
          // the precedence order, behind broader objections.
          for (const warning of decision.warnings ?? [decision]) {
            if (warned.has(warning.gate)) continue;
            warned.add(warning.gate);
            warnings.push({ gate: warning.gate, message: warning.message });
            onEvent({ type: "done_warning", gate: warning.gate, message: warning.message });
          }
        }
      }

      // The next three done-gates need a KB query or a verify subprocess, so they
      // run here — after the pure-sync DONE_GATES loop — rather than in the
      // registry. They share one shape: fire only while `done` still holds, honor
      // the gate's block/off policy and its rejection bound, and on an objection
      // flip the done, record the count + metric, and emit done_rejected.
      // `produceObjection` returns the message (or null for "nothing to object
      // to") and may be async (verify_red runs the suite). Because the bound and
      // policy are checked BEFORE the producer runs, an off or exhausted gate never
      // pays for its KB query or subprocess.
      const applyExpensiveDoneGate = async (name, max, produceObjection) => {
        if (!result.done
            || deliveryFor(name, { interactive, visualTask, specGap }) !== BLOCK
            || (gateCounts[name] ?? 0) >= max) return;
        // Count the ASK, not just the objection. A rejection counter answers "did
        // this gate object"; it cannot answer "was this gate ever consulted", and
        // without that a silent gate is indistinguishable from a dead one -- which
        // is exactly how the anti-spiral gate sat inert through a 26-turn spiral.
        const engagementMetric = GATE_ENGAGEMENT_METRIC[name];
        if (engagementMetric) metrics[engagementMetric] = (metrics[engagementMetric] ?? 0) + 1;
        const message = await produceObjection();
        if (!message) return;
        gateCounts[name] = (gateCounts[name] ?? 0) + 1;
        metrics[GATE_METRIC[name]] = gateCounts[name];
        result.done = false;
        result.summary = undefined;
        result.observation = message;
        onEvent({ type: "done_rejected", reason: message, gate: name });
      };

      // sibling_symbol: edited a symbol with same-named definitions in files never
      // opened — they frequently share the bug or the just-changed contract
      // (swb2-django-serializer: queryset_iterator fixed in python.py, the identical
      // twin in xml_serializer.py never opened). Replay showed the fact as an
      // advisory note was ignored and as a gate rejection acted on. Runs before
      // verify_red because it costs no subprocess. BANTAM_SIBLING_GATE=0 disables.
      await applyExpensiveDoneGate("sibling_symbol", 1, () => {
        if (!ground?.db) return null;
        const findings = siblingDefinitionFindings({ db: ground.db, editedSymbolSites, visitedPaths, workspace });
        return findings.length ? formatSiblingSymbolDone(findings) : null;
      });

      // family_convention: this run ADDED a name joining an existing affix family
      // whose implementations were never examined. The [family] footer showed them
      // once as information; measured twice (serializer advisory-vs-gate, escapeseq
      // v5 done-turn replay), this model acts on gate rejections and shrugs off FYIs
      // on success observations. BANTAM_FAMILY_GATE=0 disables.
      await applyExpensiveDoneGate("family_convention", 1, () => {
        if (!pendingFamilyFindings.size) return null;
        const unexamined = [...pendingFamilyFindings.values()].find((f) =>
          !visitedPaths.has(f.baseFile) && f.baseFile !== f.editedFile);
        if (!unexamined) return null;
        const { baseBlock, mateBlock } = familyBlocks(ground, unexamined, 12);
        return (baseBlock || mateBlock) ? formatFamilyConventionDone(unexamined, baseBlock, mateBlock) : null;
      });

      // verify_red: a done while the task's own verify still fails is bounced WITH
      // the failing output — the ground truth it's about to be graded on — instead
      // of accepted and graded red in silence (swb-sympy-prefix: done at 21/30, the
      // missing fact in the unshown terminal verify; replaying that turn with the
      // output injected produced the gold fix). Bounded by VERIFY_DONE_GATE_MAX so a
      // model that cannot recover never livelocks; a timeout/interrupt is infra, not
      // evidence, so only a real red bounces. Reuses the gate's cached proof when
      // the workspace is unchanged (the terminal verify reuses it too).
      // BANTAM_VERIFY_DONE_GATE=0 disables.
      // An operator-selected acceptance environment is authority, not a bounded
      // advisory objection. A writable manual check (or exhausted verify_red
      // budget) cannot certify this read-only configured verification.
      if (result.done && verificationScript && verificationWorkspaceReadOnly) {
        let cached = doneVerificationProof
          && doneVerificationProof.generation === workspaceEditGeneration
          && doneVerificationProof.command === verificationScript
          && verificationEnvironmentMatches(doneVerificationProof.verification)
          ? doneVerificationProof : null;
        if (!cached) {
          metrics.verifyDoneGateRuns++;
          let evidence = null;
          const proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
            doubleCheck: flakyVerify, envOverrides: shellEnvOverrides, shellSandbox, shellNetwork, dockerImage,
            readOnlyWorkspacePaths, workspaceReadOnly: true, processRunner: shellProcessRunner,
            onExecution: execution => { evidence = verificationEvidence({ execution, command: verificationScript,
              configuredCommand: verificationScript, generation: workspaceEditGeneration, source: "completion" });
              recordVerification(evidence); },
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          cached = doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript,
            verification: evidence?.status === "pass" ? proof : { ...proof, status: evidence?.status ?? "unverified" }, evidence };
        }
        if (cached.evidence && verificationReceipts.entries.length) result.verificationEvidence = cached.evidence;
        if (cached.verification.status !== "pass") {
          result.done = false;
          result.summary = undefined;
          gateCounts.verify_red = (gateCounts.verify_red ?? 0) + 1;
          metrics[GATE_METRIC.verify_red] = gateCounts.verify_red;
          result.observation = `[verification environment] The configured read-only check did not pass: ${verificationScript}. `
            + "The source workspace is read-only; create test fixtures in a fresh platform temporary directory (/tmp), not beside source files. "
            + "Writable manual-shell results do not certify this environment. Fix the reported issue before requesting done.\n"
            + cached.verification.detail;
          onEvent({ type: "done_rejected", gate: "verify_red", reason: result.observation });
        }
      }
      await applyExpensiveDoneGate("verify_red", VERIFY_DONE_GATE_MAX, async () => {
        if (!verificationScript) return null;
        const cached = doneVerificationProof
          && doneVerificationProof.generation === workspaceEditGeneration
          && doneVerificationProof.command === verificationScript
          && verificationEnvironmentMatches(doneVerificationProof.verification)
          ? doneVerificationProof.verification
          : null;
        let proof = cached;
        if (!proof) {
          metrics.verifyDoneGateRuns++;
          onEvent({ type: "activity", label: "verifying" });
          let evidence = null;
          proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
            doubleCheck: flakyVerify,
            envOverrides: shellEnvOverrides,
            shellSandbox,
            shellNetwork,
            dockerImage,
            readOnlyWorkspacePaths,
            workspaceReadOnly: verificationWorkspaceReadOnly,
            processRunner: shellProcessRunner,
            onExecution: execution => {
              evidence = verificationEvidence({ execution, command: verificationScript,
                configuredCommand: verificationScript, generation: workspaceEditGeneration, source: "completion" });
              recordVerification(evidence);
            },
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          if (evidence) result.verificationEvidence = evidence;
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript, verification: proof, evidence };
        }
        if (interrupted || proof.status !== "fail") return null;
        // gateCounts.verify_red is still the pre-increment value here; the helper
        // adds 1 after this returns, so subtract 1 to report the post-bounce remainder.
        return formatVerifyRedDone({
          command: verificationScript,
          detail: proof.detail,
          unchanged: Boolean(cached),
          remaining: VERIFY_DONE_GATE_MAX - (gateCounts.verify_red ?? 0) - 1,
        });
      });

      // edge_smoke: the code passes its visible tests but THROWS on a valid-shaped
      // edge input the examples never showed (an empty string, [], 0). A crash on a
      // valid-shaped input is almost never intended; the smoke check runs the
      // workspace's exports on degenerate inputs (in a subprocess) and bounces the
      // done WITH the exact throwing call. Mechanical, not advisory: replay of the
      // str-title-case failure showed the vague "consider edge cases" nudge moved
      // this 27B ~1/3 of the time, but the concrete "titleCase('') throws" fact
      // fixed it first try. Opt-in via BANTAM_EDGE_SMOKE_GATE=1.
      const applyWorkspaceProbe = async (name, format) => {
        // A bounded correction opportunity is not permission to accept missing
        // execution evidence. Retry an incomplete probe until it runs or the
        // overall turn budget expires, even after its ordinary bounce is spent.
        const max = unfinishedWorkspaceProbes.has(name) ? Number.MAX_SAFE_INTEGER : 1;
        await applyExpensiveDoneGate(name, max, async () => {
          const proof = await runWorkspaceProbe({
            workspace, kind: name, task, shellSandbox, dockerImage, signal,
            processRunner: shellProcessRunner,
          });
          onEvent({ type: "workspace_probe", gate: name, status: proof.status, sandbox: proof.sandbox, detail: proof.detail });
          if (proof.status !== "ok") {
            unfinishedWorkspaceProbes.add(name);
            if (proof.status === "interrupted") markInterrupted("workspace_probe");
            return `[${name.replaceAll("_", "-")}] The verification probe did not complete (${proof.status}); no passing proof was obtained. ${proof.detail ?? ""} Restore the probe's execution prerequisites or correct the reported failure before finishing.`;
          }
          unfinishedWorkspaceProbes.delete(name);
          return proof.findings.length ? format(proof.findings) : null;
        });
      };
      await applyWorkspaceProbe("edge_smoke", formatEdgeSmoke);

      // spec_example: the code disagrees with a concrete example STATED in the
      // task spec. Parses `fn(args) -> expected` lines from the spec, runs the
      // model's exported function against them (subprocess-isolated), and bounces
      // the done WITH the mismatch. The oracle is the task author, not the model,
      // so this catches false beliefs the model's own thin tests miss (the
      // template-engine run "verified" if([]) was falsy in JS and shipped it).
      // Opt-in via BANTAM_SPEC_EXAMPLE_GATE=1.
      if (task) await applyWorkspaceProbe("spec_example", formatSpecExamples);

      // lexical_smoke: the code narrows an accepted-string language the task
      // NAMED (a case-sensitive compare where the spec said case-insensitive).
      // The advisory [lexical-contract-audit] already states this fact and is
      // default-on -- and the 2026-07-30 local-27B multi-sample recorded it
      // firing in 3/3 adapter-migration runs and being ignored in 3/3, every one
      // ending in a confident done with 26-32 turns of budget left and the
      // byte-identical `trimmed === "true"`. This re-checks the named language
      // mechanically and bounces WITH the exact failing call, because the named
      // language is a real oracle: the variant is the same value spelled
      // differently, so it must neither throw nor return a different result.
      // Opt-in via BANTAM_LEXICAL_SMOKE_GATE=1.
      if (task) await applyWorkspaceProbe("lexical_smoke", formatLexicalSmoke);

      // type_contract: the mirror of lexical_smoke. The code ACCEPTS a value the
      // task's stated type excludes -- coercing where the contract requires a
      // throw. All six lexical-smoke-gate-ab runs wrote a correct parseEnabled and
      // still failed the hidden contract 6/6 here; the visible suite only ever
      // passes well-formed input, so being helpful is never contradicted.
      // Opt-in via BANTAM_TYPE_CONTRACT_GATE=1.
      if (task) await applyWorkspaceProbe("type_contract", formatTypeContractSmoke);

      // Final pre-accept proof for a narrow false-green class: a task-owned
      // test for "VAR missing/unset" must still pass when the verifier's parent
      // environment happens to define VAR. Ordinary done gates run first so an
      // empty/unverified tree never pays for this extra suite.
      const environmentVariables = result.done && verificationScript && workspaceChangedDuringRun
        ? extractMissingEnvironmentVariables({
            task,
            documents: uneditedTaskSpecDocuments(task, turns, exec),
          })
        : [];
      if (environmentVariables.length > 0) {
        const workspaceProofKey = environmentWorkspaceKey(workspace);
        const proofMatches = environmentVerificationProof
          && environmentVerificationProof.generation === workspaceEditGeneration
          && environmentVerificationProof.command === verificationScript
          && environmentVerificationProof.workspaceKey === workspaceProofKey
          && sameStrings(environmentVerificationProof.variables, environmentVariables);
        if (!proofMatches) {
          metrics.environmentVerificationRuns++;
          onEvent({
            type: "environment_verification_started",
            variables: environmentVariables,
            generation: workspaceEditGeneration,
          });
          environmentVerificationProof = await verifyWithEnvironmentPresent({
            workspace,
            command: verificationScript,
            variables: environmentVariables,
            generation: workspaceEditGeneration,
            workspaceKey: workspaceProofKey,
            timeoutMs: verificationTimeoutMs,
            signal,
            envOverrides: shellEnvOverrides,
            shellSandbox,
            shellNetwork,
            dockerImage,
            readOnlyWorkspacePaths,
            workspaceReadOnly: verificationWorkspaceReadOnly,
            processRunner: shellProcessRunner,
          });
          if (environmentVerificationProof.interrupted || abortRequested()) {
            markInterrupted("environment_verification");
          }
          if (environmentVerificationProof.verdict === "pass") {
            metrics.environmentVerificationPasses++;
          }
          onEvent({ type: "environment_verification", ...environmentVerificationProof });
        }
        result.environmentVerification = environmentVerificationProof;
        if (environmentVerificationProof.verdict !== "pass") {
          metrics.environmentVerificationRejections++;
          result.done = false;
          result.summary = undefined;
          result.observation = formatEnvironmentVerificationFailure(
            environmentVerificationProof,
            workspace,
          );
          onEvent({
            type: "done_rejected",
            reason: result.observation,
            gate: "environment_verification",
          });
        }
      }
    }

    // Eyes before done: web files changed, never rendered — bounce the done ONCE with an
    // actual preview report. OPT-IN (BANTAM_AUTOPREVIEW=1): two measured experiments
    // (preview-vision, preview-vision-hard; 36 runs) found no pass-rate benefit at any
    // tested difficulty and real turn/token cost — static previews are structurally
    // blind to interaction-dependent defects. Re-promote only if an interactive preview
    // earns it. The pull-based `preview` tool itself stays available regardless.
    if (action.a === "done" && result.done && webEditedUnpreviewed && !autoPreviewFired
        && tools?.get("preview")
        && (visualTask || /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_AUTOPREVIEW ?? "")))) {
      autoPreviewFired = true;
      webEditedUnpreviewed = false;
      metrics.autoPreviews = (metrics.autoPreviews ?? 0) + 1;
      const previewReport = await tools.answer("preview");
      const autoProof = tools?.lastOutcome?.proof ?? tools?.get("preview")?.lastResult ?? null;
      if (autoProof) {
        latestPreviewProof = { ...autoProof, generation: workspaceEditGeneration };
        webEditedUnpreviewed = autoProof.status !== "pass";
        metrics.previewRuns++;
        if (autoProof.status === "pass") metrics.previewPasses++;
        else metrics.previewFailures++;
      }
      result.done = false;
      result.summary = undefined;
      result.observation = [
        "You changed web files but never looked at the rendered result. The harness rendered it for you:",
        "",
        previewReport,
        "",
        'If this matches what the task asked for, emit "done" again. If it shows problems — errors, a blank render, wrong layout — fix them first, then run "preview" to confirm before finishing.',
      ].join("\n");
      onEvent({ type: "auto_preview" });
    }

    // Build-first guard: on a clear build request, don't let the model answer with a PLAN
    // before it has written a single file. Faced with a big task a small model will describe
    // what it "will" build and stop; veto that and make it create the first file. Bounded, so
    // a genuine clarifying question still gets through after a couple of pushes.
    if (interactive && buildRequest && action.a === "respond" && result.done
        && (metrics.actions.write_file ?? 0) === 0 && (metrics.actions.replace ?? 0) === 0
        && (metrics.actions.write_batch ?? 0) === 0
        && (metrics.actions.patch ?? 0) === 0
        && buildRespondRejections < 2) {
      buildRespondRejections++;
      result.done = false;
      result.summary = undefined;
      result.responded = false;
      result.observation = "You answered with a plan, but this is a BUILD request and you have not written any code yet. Do NOT describe what you will build. Your next action MUST be write_file — create the first runnable file now (even a minimal skeleton), then keep building it out. Only stop to ask if a real decision genuinely blocks you.";
      forceBuildEdit = true;   // next turn: mask investigative verbs AND respond — write_file is the exit
      onEvent({ type: "build_first_reject" });
    }

    const reviewedDocumentArtifacts = !gateRejection && !interactiveStop && !duplicate && !groundReject
      && readExecuted && !String(result.observation ?? "").startsWith("ERROR:")
      ? requestedDocumentReviews
      : [];
    if (documentRevisionTurn) {
      if (directEditSucceeded) {
        const revisedDocuments = directEditPaths
          .filter((candidate) => knownArtifacts.has(candidate) && isDocumentArtifactPath(candidate));
        const remainingGaps = revisedDocuments.flatMap((document) => {
          try {
            const current = fs.readFileSync(exec.resolve(document), "utf8");
            const context = formatDocumentArtifactReviewContext(task, {
              evidencePaths: inspectedPaths,
              documentText: current,
              revisionRequired: false,
            });
            return documentArtifactReviewGaps(context);
          } catch {
            return [`Mechanical path coverage gap — the pending document ${document} could not be loaded after the edit.`];
          }
        });
        documentRevisionRequired = revisedDocuments.length === 0 || remainingGaps.length > 0;
        if (documentRevisionRequired) {
          const gaps = remainingGaps.length
            ? remainingGaps
            : ["Mechanical path coverage gap — edit the pending document itself, not another file."];
          result.observation += `\n[document-revision] The edit landed, but audited obligations remain. The controller stays document-only. Reread the pending document if exact current bytes are clipped or stale; otherwise close ONLY:\n- ${gaps.join("\n- ")}`;
          onEvent({ type: "document_revision_gaps_remain", paths: directEditPaths, gaps });
        } else {
          onEvent({ type: "document_revision_completed", paths: directEditPaths });
        }
      } else {
        result.done = false;
        result.summary = undefined;
        result.observation += "\n[document-revision] The required post-green document revision did not land. The next action remains document-only: reread the pending document if exact current bytes are clipped or stale, then revise it before testing or done.";
        onEvent({ type: "document_revision_required" });
      }
    }
    if (reviewedDocumentArtifacts.length) {
      const remainingDocuments = [...pendingDocumentArtifacts]
        .filter((document) => !reviewedDocumentArtifacts.includes(document));
      const firstPostAuditReview = documentRevisionAfterAudit && remainingDocuments.length === 0;
      const initialReviewContext = formatDocumentArtifactReviewContext(task, {
        evidencePaths: inspectedPaths,
        documentText: result.observation,
        revisionRequired: false,
      });
      const reviewHasGaps = documentArtifactReviewHasGaps(initialReviewContext);
      if (reviewHasGaps && remainingDocuments.length === 0) {
        documentAuditRemediationActive = true;
      }
      // A concrete coverage diff is already the validation failure. Make its
      // correction mandatory immediately instead of allowing a test or a
      // completion audit to separate the diagnosis from the edit. Conversely,
      // a post-green reread with no gaps needs no ceremonial extra mutation.
      const revisionRequired = remainingDocuments.length === 0 && reviewHasGaps;
      result.observation += revisionRequired
          ? formatDocumentArtifactReviewContext(task, {
            evidencePaths: inspectedPaths,
            documentText: result.observation,
            revisionRequired: true,
          })
        : initialReviewContext;
      if (firstPostAuditReview) documentRevisionAfterAudit = false;
      if (revisionRequired) {
        documentRevisionRequired = true;
        onEvent({ type: "document_revision_required", documents: reviewedDocumentArtifacts, reviewHasGaps });
      } else if (documentAuditRemediationActive && remainingDocuments.length === 0) {
        documentAuditRemediationActive = false;
        onEvent({ type: "document_audit_remediation_closed", documents: reviewedDocumentArtifacts });
      }
    }
    if (result.done && !result.controllerStop && cliContract
        && !cliVerificationPassed(cliContract, cliVerification, { generation: workspaceEditGeneration })) {
      result.done = false;
      result.summary = undefined;
      result.observation += `\n${cliVerificationDecisionContext(cliContract, cliVerification,
        { generation: workspaceEditGeneration })?.text ?? "CLI verification is still unresolved."}`;
      metrics.cliCompletionRefusals = (metrics.cliCompletionRefusals ?? 0) + 1;
      onEvent({ type: "cli_completion_refused", generation: workspaceEditGeneration, module: cliContract.module });
    }
    const progress = classifyProgress(action, result.observation, {
      workspaceChanged: shellChangedWorkspace,
      doneAccepted: action.a === "done" && result.done && !result.controllerStop,
      knownArtifacts: [...knownArtifacts],
      toolUsed: queryToolUsed,
      queryValidatesArtifact: verifyingArtifact,
      workspaceChangedSinceVerification: unchangedVerifyEarnsProgress || workspaceChangedSinceVerification,
    });
    if (reviewedDocumentArtifacts.length) {
      progress.progress = true;
      progress.reason = "verification";
    }
    // Bound the progress credit a query can earn. Crediting every routed query removes anti-spiral
    // pressure when the model keeps investigating without writing. A query is untaxed, not infinitely
    // rewarded: past the budget it stops resetting progresslessTurns, so the nudge and then the gate
    // push the model to ship a draft. A deliverable action refills it, so an interleaved
    // query -> edit -> query loop is never throttled.
    if (progress.progress && progress.reason === "query") {
      if (!queryBudget.credit({ tool: queryToolUsed, query: action.q })) {
        progress.progress = false;
        progress.reason = "query_budget_spent";
        metrics.queryBudgetBlocks = (metrics.queryBudgetBlocks ?? 0) + 1;
        onEvent({ type: "query_budget_spent", query: action.q, tool: queryToolUsed });
      }
    } else if (progress.progress) {
      queryBudget.noteDeliverableProgress();
    }
    // Keep duplicate memory tied to observable filesystem state, not abstract progress. A passing
    // verifier or useful query does not make an unchanged read fresh; clearing on those signals let
    // the model alternate read -> test forever without ever registering a duplicate. Direct edits
    // and shell-observed file changes are the only events that invalidate prior read observations.
    if (directEditSucceeded || shellChangedWorkspace) repetition.noteWorkspaceChanged();
    // Same signal the duplicate memory above keys on: only an observed filesystem
    // change makes the next verification new evidence. Crediting one consumes it.
    if (directEditSucceeded || shellChangedWorkspace) {
      workspaceChangedSinceVerification = true;
    } else if (progress.reason === "verification") {
      workspaceChangedSinceVerification = false;
    }
    consecutiveDuplicates = (duplicate || insideLedgerReread) ? consecutiveDuplicates + 1 : 0;
    const executedNormally = !gateRejection && !interactiveStop && !duplicate && !groundReject;
    if (executedNormally) {
      repetition.record(action, result.observation, {
        turn: metrics.turns + 1,
        shellWorkspaceUnchanged: action.a === "shell" && !shellChangedWorkspace,
        result,
      });
    }

    if (progress.progress) {
      progresslessTurns = 0;
      consecutiveProgressGateRejections = 0;
    } else {
      progresslessTurns++;
      metrics.maxProgresslessTurns = Math.max(metrics.maxProgresslessTurns, progresslessTurns);
      if (!result.done && progressAwareness && shouldNudgeProgress(progresslessTurns, lastProgressNudgeAt, metrics.progressNudges, {
        threshold: progressNudgeAfter,
        cooldown: progressNudgeCooldown,
      })) {
        const nudge = formatProgressNudge(progresslessTurns, { sourceProvenance, hasAuthoredWork });
        result.observation += nudge;
        lastProgressNudgeAt = progresslessTurns;
        metrics.progressNudges++;
        onEvent({ type: "progress_nudge", progresslessTurns, nudge });
      }
    }
    for (const file of shellChangedPaths) {
      if (isArtifactPath(file, { knownArtifacts: [...knownArtifacts] })) knownArtifacts.add(file);
    }
    const directArtifactPaths = progress.reason === "edit"
      ? directEditPaths.filter((editedPath) => isArtifactPath(editedPath, { knownArtifacts: [...knownArtifacts] }))
      : [];
    const shellArtifactPaths = action.a === "shell"
      ? shellChangedPaths.filter((file) => isArtifactPath(file, { knownArtifacts: [...knownArtifacts] }))
      : [];
    const producedArtifactPaths = [...new Set([...directArtifactPaths, ...shellArtifactPaths])];
    const producedDocumentArtifacts = producedArtifactPaths.filter(isDocumentArtifactPath);
    // Enforcement arms only for task-named deliverables (or /app/ outputs, the
    // eval convention); a scratch capture the model invented can still be
    // NOTED, but must not put the run into artifact-verification mode.
    const taskNamed = (file) => taskNamedArtifacts.size > 0
      && (taskNamedArtifacts.has(file) || [...taskNamedArtifacts].some((artifact) => String(file).endsWith(artifact)));
    const producedOutputArtifact = directArtifactPaths.some(taskNamed)
      || shellArtifactPaths.some(taskNamed)
      || (action.a === "shell" && shellChangedWorkspace
        && isArtifactPath(action.c, { knownArtifacts: [...taskNamedArtifacts] })
        && taskNamedArtifacts.size > 0
        && [...taskNamedArtifacts].some((artifact) => String(action.c ?? "").includes(artifact)));
    const producedNonDocumentArtifact = producedArtifactPaths.filter(taskNamed).some((file) => !isDocumentArtifactPath(file))
      || (producedOutputArtifact && producedArtifactPaths.length === 0);
    if (action.a === "done" && result.done) {
      nonDocumentArtifactNeedsVerification = false;
      pendingDocumentArtifacts.clear();
      artifactNeedsVerification = false;
      turnsSinceArtifact = 0;
      consecutiveArtifactVerificationGateRejections = 0;
    } else if (producedOutputArtifact) {
      consecutiveArtifactVerificationGateRejections = 0;
      if (artifactNeedsVerification) turnsSinceArtifact++;
      if (producedNonDocumentArtifact) nonDocumentArtifactNeedsVerification = true;
      for (const document of producedDocumentArtifacts) pendingDocumentArtifacts.add(document);
      artifactNeedsVerification = nonDocumentArtifactNeedsVerification || pendingDocumentArtifacts.size > 0;
      if (!result.done && progressAwareness) {
        const nudge = formatArtifactVerificationNudge({ document: producedDocumentArtifacts.length > 0 });
        result.observation += nudge;
        metrics.artifactVerificationNudges++;
        onEvent({ type: "artifact_verification_nudge", turnsSinceArtifact, nudge });
      }
    } else if (artifactNeedsVerification) {
      for (const document of reviewedDocumentArtifacts) pendingDocumentArtifacts.delete(document);
      if (progress.reason === "verification" && reviewedDocumentArtifacts.length === 0) {
        nonDocumentArtifactNeedsVerification = false;
      }
      artifactNeedsVerification = nonDocumentArtifactNeedsVerification || pendingDocumentArtifacts.size > 0;
      if (artifactNeedsVerification) {
        turnsSinceArtifact++;
      } else {
        turnsSinceArtifact = 0;
        consecutiveArtifactVerificationGateRejections = 0;
      }
    }
    metrics.progresslessTurns = progresslessTurns;

    // Keep the failed focused command visible when later diagnostics or a
    // different suite go green. This is context only: it cannot change a gate,
    // action mask, execution budget, or acceptance result.
    if (!result.done && !result.controllerStop && !interrupted) {
      const failure = latestUnresolvedFocusedFailure([...turns, {
        verificationEvidence: verificationReceipt(result.verificationEvidence), shellExecution: shellReceipt,
        ...(verificationReceipts.entries.length ? { verificationReceipts } : {}),
        controllerStop: result.controllerStop, shellScopeRollback: result.shellScopeRollback,
      }], { generation: workspaceEditGeneration, workspace: exec.realWorkspace, configuredCommand: verificationScript });
      if (failure) result.observation += `\n${focusedFailureReminder(failure)}`;
    }
    if (result.auditCleanupRefusal && !result.observation.endsWith(result.auditCleanupRefusal.correction)) {
      result.observation += `\n${result.auditCleanupRefusal.correction}`;
    }
    if (result.auditWitnessRefusal && !result.observation.endsWith(result.auditWitnessRefusal.correction)) {
      result.observation += `\n${result.auditWitnessRefusal.correction}`;
    }
    if (result.nodeCheckRefusal && !result.observation.endsWith(result.nodeCheckRefusal.correction)) {
      result.observation += `\n${result.nodeCheckRefusal.correction}`;
    }

    // Normalize evaluator-only volatility only after every controller-owned
    // addition (auto-verification, completion audit, test focus, etc.). Doing
    // this immediately after execute() left later TAP durations and disposable
    // workspace paths in the next prompt, so nominally same-seed A/B arms saw
    // different bytes. Preserve the full pre-transform observation separately.
    if (typeof observationTransform === "function") {
      const original = String(result.observation ?? "");
      const transformed = String(observationTransform(original, { action, workspace }) ?? "");
      if (transformed !== original) {
        rawObservation = original;
        result.observation = transformed;
      }
    }

    // Raw model output stays separate from the parsed action — critical for
    // replay/debugging/training. `action`+`observation` are kept for prompt reuse.
    turns.push({
      i: turns.length,
      rawOutput,
      reasoning,
      action,
      parsedAction: action,
      ...(action.a === "done" ? { doneAccepted: Boolean(result.done && !result.controllerStop) } : {}),
      ...(result.controllerStop ? { controllerStop: result.controllerStop } : {}),
      ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
      ...(modelCallIndex !== null ? { modelCallIndex } : {}),
      protocolViolation,
      observation: result.observation,
      ...(action.a === "query" ? { queryExecuted, queryTool: queryToolUsed } : {}),
      ...(queryOutcome ? { toolOutcome: queryOutcome } : {}),
      ...(queryPreviewProof ? { preview: queryPreviewProof } : {}),
      ...(isEditAction(action) ? { editApplied: directEditSucceeded } : {}),
      scopedVerify: result.scopedVerify,   // trusted harness-run verdict (undefined if none)
      verificationEvidence: verificationReceipt(result.verificationEvidence),
      ...(verificationReceipts.entries.length ? { verificationReceipts } : {}),
      ...(result.contractStateAudit ? { contractStateAudit: result.contractStateAudit } : {}),
      ...(result.contractAssertion ? { contractAssertion: result.contractAssertion } : {}),
      ...(result.cliVerification ? { cliVerification: structuredClone(result.cliVerification) } : {}),
      ...(!contextBasisRecorded ? { contextBasis } : {}),
      shellExecution: shellReceipt,
      ...(Object.hasOwn(result, "probeEvidence") ? { probeEvidence: structuredClone(result.probeEvidence) } : {}),
      ...(result.editOutcome ? { editOutcome: result.editOutcome } : {}),
      environmentVerification: result.environmentVerification,
      sourceEditedByShell: result.sourceEditedByShell,  // shell command that rewrote source (undefined if not)
      ...(shellChangedPaths.length ? { shellChangedPaths } : {}),
      ...(result.shellScopeRollback ? { shellScopeRollback: result.shellScopeRollback } : {}),
      ...(stateAuditIssued ? { stateAudit: stateAuditSnapshot() } : {}),
      workspaceCoherence: {
        fingerprints: workspaceCoherence.snapshot(),
        pendingPaths: [...pendingExternalChanges],
      },
      rawObservation,
      tookMs: nowMs() - turnStart,
    });
    contextBasisRecorded = true;
    // Interactive backstop: the autonomous gates are off (the human steers), so nothing
    // otherwise stops an investigation spiral. Count ALL investigative turns — reads AND
    // shell commands (running tests / ls / wc is still investigating, not answering) — and
    // only an actual edit resets the streak. After enough investigation, nudge; escalate to a
    // firm "your next action must be respond". A message fed back, never a hard rejection.
    if (interactive && !result.done) {
      const isEdit = directEditSucceeded;
      // A `query` is exploration too — especially the `map` tool, which the model can spin on to learn
      // a repo. In interactive mode the query budget's gate is off (progressAwareness is disabled), so
      // if query didn't count here nothing would ever force a wrap-up: a model that only queries would
      // spiral to maxTurns. Count it like a read; only an actual edit (or answering) ends the streak.
      const isInvestigation = action.a === "read_file" || action.a === "list_dir"
        || action.a === "search" || action.a === "inspect" || action.a === "shell" || action.a === "query" || action.a === "probe";
      if (isEdit) {
        interactiveReconStreak = 0;
        lastInteractiveNudge = 0;
      } else if (isInvestigation) {   // respond doesn't count — that IS the answer
        interactiveReconStreak++;
        if (interactiveReconStreak >= 9 && interactiveReconStreak - lastInteractiveNudge >= 5) {
          result.observation += interactiveReconStreak >= 16
            ? "\n[STOP] You have investigated for many turns. Do NOT inspect anything further. Your NEXT action MUST be \"respond\" with your answer/assessment for the user (or an edit, if they asked you to change code)."
            : "\n[note] You've gathered plenty of context now. If the user asked a question or for your assessment, answer them with a \"respond\" action instead of investigating further.";
          lastInteractiveNudge = interactiveReconStreak;
        }
      }
    }

    // A turn that did not trip the interactive stop means the model complied (edited, answered,
    // or hadn't hit the budget yet) — reset the ignored-stop streak so only a SUSTAINED refusal
    // to wrap up triggers the hard stop above.
    if (!interactiveStop) consecutiveInteractiveStops = 0;

    metrics.turns++;
    const lastTurn = turns[turns.length - 1];
    if (runtimeAnalysisEnabled) {
      turnAnalyzer.recordTurn(lastTurn);
      const parsed = obsParser.parse(lastTurn.action, lastTurn.observation);
      turnAnalyzer.recordObservation(parsed);
      improvementLog?.recordObservation(parsed);

      const currentAction = actionName(lastTurn.action);
      const previousAction = actionName(turns[turns.length - 2]?.action);
      if (sequenceDecider && currentAction) observedActionSequence.push(currentAction);
      const observedOutcome = completedActionOutcome({
        action: currentAction,
        turn: lastTurn,
        result,
        parsed,
      });
      recordObservedSequence(observedOutcome);

      // There is no next action after an accepted done/block. Otherwise, pass
      // protocol verb strings—not action objects—into both rule and transition
      // scorers.
      if (sequenceDecider && !result.done && !result.blocked) {
        const decState = {
          turns: turns.length,
          task,
          lastAction: currentAction,
          lastLastAction: previousAction,
          lastFailed: observedOutcome?.success === false,
          lastObservation: result.observation,
          done: result.done,
          blocked: result.blocked,
        };
        const decResult = sequenceDecider.decide(decState);
        decHint = {
          action: decResult.action,
          strategy: decResult.strategy,
          score: decResult.score,
          plan: decResult.plan?.slice(0, 3),
        };
        if (decResult.strategy === "planner") {
          metrics.sequenceStrategyDecisions.planner++;
        } else {
          metrics.sequenceStrategyDecisions.recommender++;
        }
        metrics.sequenceStrategyDecisions.total++;
      } else {
        decHint = null;
      }
    }
    onEvent({
      type: "observation",
      // Preserve exactly the sealed turn's typed receipts in crash checkpoints,
      // including explicit null / false and bounded audit state for resume.
      ...Object.fromEntries([
        "verificationEvidence", "verificationReceipts", "shellExecution", "probeEvidence", "editOutcome", "contractStateAudit", "contractAssertion", "cliVerification",
        "contextBasis", "contextUpdates", "verificationWorkflow", "doneAccepted", "controllerStop",
        "editApplied", "scopedVerify", "sourceEditedByShell", "shellChangedPaths",
        "shellScopeRollback", "stateAudit", "toolOutcome", "preview", "queryExecuted", "queryTool",
      ].filter((key) => Object.hasOwn(lastTurn, key) && lastTurn[key] !== undefined)
        .map((key) => [key, lastTurn[key]])),
      observation: result.observation,
      rawObservation,
      workspaceCoherence: {
        fingerprints: workspaceCoherence.snapshot(),
        pendingPaths: [...pendingExternalChanges],
      },
      ...(result.environmentVerification
        ? { environmentVerification: result.environmentVerification }
        : {}),
    });

    if (result.blocked) metrics.infrastructureBlocks++;
    if (result.blocked && (pauseOnInfrastructureBlock || result.blocked.terminal)) {
      blocked = result.blocked;
      const ecosystem = blocked.ecosystem || "package";
      const operation = blocked.operation || "install";
      const subject = operation.startsWith(`${ecosystem} `) ? operation : `${ecosystem} ${operation}`;
      summary = blocked.reason
        ? `Blocked ${subject}: ${blocked.reason}`
        : `Blocked ${subject}; no command was run.`;
      onEvent({ type: "infrastructure_blocked", blocked });
      break;
    }

    // result.done also suppresses ordinary postprocessing on a settled stop
    // turn above. It must not become worker completion, release, or learning.
    if (result.controllerStop) {
      controllerStop = result.controllerStop;
      summary = result.summary;
      break;
    }
    if (result.done) { done = true; summary = result.summary; responded = Boolean(result.responded); }

    // Adaptive workflow: if the pinned plan keeps failing, reflect and revise it
    // (bounded). This is the model critiquing its own workflow and building on it.
    if (planMode && plan && !done && rePlans < 2 && (turns.length - planAnchor) >= 3 && isStuck(turns)) {
      const revised = await rePlan({ model, task, currentPlan: plan, turns, signal, buildRawPrompt: (i) => buildAuxPrompt(i, model.assistantPrefill, model.template) });
      if (abortRequested()) { markInterrupted("planning"); break; }
      if (revised) {
        plan = revised;
        planText = formatPlan(plan);
        planAnchor = turns.length;
        rePlans++;
        metrics.rePlans = rePlans;
        onEvent({ type: "plan_revised", plan });
      }
    }
  }

  metrics.skillsUsed = announcedSkills.size;
  metrics.durationMs = nowMs() - metrics.startedAt;

  // Hidden verification: the ground-truth grader the model never sees.
  let verification = null;
  // A verify_red gate result for the final tree IS the terminal verification:
  // done ends the loop, so the workspace generation cannot have moved since the
  // gate ran. Reuse it — whatever its verdict, including interrupted/flaky —
  // rather than paying for the suite twice or dropping a verdict already earned.
  const gateProof = doneVerificationProof
    && doneVerificationProof.generation === workspaceEditGeneration
    && doneVerificationProof.command === verificationScript
    && verificationEnvironmentMatches(doneVerificationProof.verification)
    ? doneVerificationProof.verification
    : null;
  const shouldVerify = verificationScript && !blocked
    && (gateProof || !interrupted)
    && (verificationPolicy === "always" || workspaceChangedDuringRun);
  if (shouldVerify) {
    metrics.verificationTriggered = true;
    if (gateProof) {
      verification = gateProof;
    } else {
      onEvent({ type: "activity", label: "verifying" });
      verification = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
        doubleCheck: flakyVerify,
        envOverrides: shellEnvOverrides,
        shellSandbox,
        shellNetwork,
        dockerImage,
        readOnlyWorkspacePaths,
        workspaceReadOnly: verificationWorkspaceReadOnly,
        processRunner: shellProcessRunner,
      });
      if (verification.interrupted || abortRequested()) markInterrupted("verification");
    }
    onEvent({ type: "verification", verification });
  } else if (verificationScript && !interrupted) {
    onEvent({ type: "verification_skipped", reason: blocked ? "infrastructure_blocked" : "workspace_unchanged" });
  }

  let integrity = null;
  if (postVerifyIntegrity && !interrupted && !blocked) {
    integrity = await runPostVerifyIntegrity(postVerifyIntegrity, { workspace, verification, done, signal });
    if (abortRequested()) markInterrupted("integrity");
    onEvent({ type: "integrity", integrity });
  }

  // Terminal hidden verification is the strongest available evidence for any
  // actions since the last in-loop test verdict. An accepted `done` without a
  // verifier remains inconclusive and is not learned as success.
  if (sequenceDecider && observedActionSequence.length > 0) {
    let terminalOutcome = null;
    if (verification?.status === "fail") {
      terminalOutcome = { success: false, evidence: "terminal_verify" };
    } else if (verification?.status === "pass" && integrity && !integrity.clean) {
      terminalOutcome = { success: false, evidence: "integrity" };
    } else if (verification?.status === "pass") {
      terminalOutcome = { success: true, evidence: "terminal_verify" };
    }
    recordObservedSequence(terminalOutcome);
  }

  // Self-building skills: only a run that actually PASSED and explicitly stayed
  // inside an integrity guard becomes a skill. Ad-hoc runs can retrieve skills,
  // but they do not mint persistent knowledge without a clean snapshot verdict.
  let skillLearned = null;
  const integrityClean = Boolean(integrity?.clean);
  if (!interrupted && skillsCfg.distill && skillsCfg.library && done && verification && verification.status === "pass" && integrityClean) {
    // A passing --plan run promotes its proven plan directly (the workflow IS the
    // verified approach — no model call, no near-clone of a distilled skill).
    const skill = plan
      ? promotePlanToSkill(plan, task, skillsCfg.language)
      : await distillSkill({
          model, task, turns, summary, language: skillsCfg.language, signal,
          buildRawPrompt: (instr) => buildDistillPrompt(instr, model.assistantPrefill, model.template),
        });
    if (abortRequested()) markInterrupted("skill_distillation");
    if (skill && !interrupted) {
      const res = saveSkill(skillsCfg.library, skill);
      if (res.saved) {
        skillLearned = skill;
        onEvent({ type: "skill_learned", skill: skill.title });
      }
    }
  }

  // Query substrates may own private extraction artifacts or browser state.
  // A frontend session constructs a fresh registry for each user request, so
  // release those resources here instead of retaining one copy per request.
  tools?.dispose?.();

  if (modelCallStart !== null && typeof model?.requestCursor === "function") {
    const modelCallEnd = model.requestCursor();
    const modelRequests = Math.max(0, modelCallEnd - modelCallStart);
    metrics.modelRequests = modelRequests;
    metrics.auxiliaryModelRequests = Math.max(0, modelRequests - metrics.turns);
    metrics.modelRequestsPerTurn = metrics.turns > 0
      ? modelRequests / metrics.turns
      : modelRequests;
  }

  return {
    done,
    summary,
    responded,
    interrupted,
    blocked,
    controllerStop,
    modelFailure: terminalModelFailure,
    warnings,
    reachedDone: done,
    verification, // { status: "pass"|"fail"|"unverified", detail } or null
    skillsUsed: [...announcedSkills],
    skillLearned,
    plan,
    turns,
    rejectedOutputs,
    integrity,
    metrics,
    promptVersion: promptVersion(), // ties this run's evidence to the exact active ruleset
    ...(modelCallStart !== null ? { modelCallStart } : {}),
    ...(typeof model?.requestCursor === "function" ? { modelCallEnd: model.requestCursor() } : {}),
  };
}

function normalizedLoggedReadPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/(?:app|workspace)\//, "");
}

/** Read paths a refusal declared already-resident (see the loop above). */
export const refusedResidentReadPathsForTest = (turn) => refusedResidentReadPaths(turn);
export const refusedEditFocusForTest = (action, workspace, pad) => refusedEditFocus(action, workspace, pad);
function refusedResidentReadPaths(turn) {
  const observation = String(turn?.observation ?? "");
  // BOTH refusals promise residency and so both must preserve it. Keying on
  // "[ledger]" alone left the panel-redirect case leaking: measured 2026-08-15
  // (parity8), src/done-gates.js and src/gate-policy.js were redirected with
  // "[open_files] Not re-read … already shown in <open_files>", never
  // refreshed, aged out of the open list, and left the panel — so the model
  // wrote the gate report at turn 60 unable to see the gate table, and omitted
  // the one gate (type_contract) the ticket singled out.
  if (!observation.includes("[ledger] Not re-read")
      && !observation.includes("[open_files] Not re-read")) return [];
  const action = turn?.action;
  if (action?.a === "read_file" && typeof action.p === "string") return [action.p];
  if (action?.a === "inspect" && Array.isArray(action.ops)) {
    return action.ops
      .filter((op) => op?.a === "read_file" && typeof op.p === "string")
      .map((op) => op.p);
  }
  return [];
}

function successfulReadPaths(turn) {
  const action = turn?.action;
  const requested = action?.a === "read_file" && typeof action.p === "string"
    ? [action.p]
    : (action?.a === "inspect" && Array.isArray(action.ops)
      ? action.ops.filter((op) => op?.a === "read_file" && typeof op.p === "string").map((op) => op.p)
      : []);
  if (!requested.length) return [];

  const rendered = new Set();
  for (const line of String(turn?.observation ?? "").split("\n")) {
    const match = /^(.+?) \(\d+ lines, showing \d+-\d+\):$/.exec(line);
    if (match) rendered.add(normalizedLoggedReadPath(match[1]));
  }
  return requested.filter((candidate) => rendered.has(normalizedLoggedReadPath(candidate)));
}

function turnChangedWorkspace(turn) {
  return turnEditApplied(turn)
    || (Array.isArray(turn?.shellChangedPaths) && turn.shellChangedPaths.length > 0);
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function environmentWorkspaceKey(workspace) {
  const entries = [...snapshotTree(path.resolve(workspace)).entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function uneditedTaskSpecDocuments(task, turns, exec) {
  const explicitPaths = taskExplicitSpecDocumentPaths(task);
  if (!explicitPaths.length) return [];
  const normalize = (value) => normalizedLoggedReadPath(value).toLowerCase();
  const edited = new Set(turns.flatMap((turn) => [
    ...(turnEditApplied(turn) ? editPaths(turn?.action ?? turn?.parsedAction) : []),
    ...(Array.isArray(turn?.shellChangedPaths) ? turn.shellChangedPaths : []),
  ]).map(normalize));

  const documents = [];
  for (const documentPath of explicitPaths) {
    const key = normalize(documentPath);
    if (edited.has(key)) continue;
    try {
      documents.push({
        path: documentPath,
        text: fs.readFileSync(exec.resolveExisting(documentPath), "utf8"),
        authoritative: true,
        edited: false,
      });
    } catch {
      // A task-named document that cannot be resolved inside the workspace is
      // not authoritative evidence for a completion probe.
    }
  }
  return documents;
}

async function verifyWithEnvironmentPresent({
  workspace,
  command,
  variables,
  generation,
  workspaceKey,
  timeoutMs,
  signal,
  envOverrides = null,
  shellSandbox = undefined,
  shellNetwork = undefined,
  onNetRequest = null,        // interactive net-access approval hook (executor.js)
  dockerImage = undefined,
  readOnlyWorkspacePaths = null,
  workspaceReadOnly = false,
  processRunner = undefined,
}) {
  const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-env-present-"));
  const sentinels = variables.map((name) => ({
    name,
    value: path.join(sentinelRoot, name),
  }));
  let shellResult;
  try {
    shellResult = await runShellProcess(
      path.resolve(workspace),
      withNodeTestTimeout(command, timeoutMs),
      {
        timeoutMs,
        envOverrides: {
          ...(envOverrides ?? {}),
          ...Object.fromEntries(sentinels.map(({ name, value }) => [name, value])),
        },
        shellSandbox,
        shellNetwork,
        dockerImage,
        readOnlyWorkspacePaths,
        workspaceReadOnly,
        signal,
        processRunner,
      },
    );
  } catch (error) {
    shellResult = {
      code: null,
      timedOut: false,
      aborted: false,
      sandbox: shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker",
      stdout: "",
      stderr: error?.message ?? String(error),
    };
  } finally {
    try { fs.rmSync(sentinelRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const detail = clip(
    `${shellResult.stdout}${shellResult.stderr ? `\n[stderr]\n${shellResult.stderr}` : ""}`,
    12000,
  );
  return {
    verdict: !shellResult.aborted && !shellResult.timedOut && shellResult.code === 0 ? "pass" : "fail",
    generation,
    workspaceKey,
    command,
    variables,
    sentinels,
    exitCode: shellResult.code,
    timedOut: Boolean(shellResult.timedOut),
    interrupted: Boolean(shellResult.aborted),
    sandbox: shellResult.sandbox,
    workspaceReadOnly,
    detail,
  };
}

function formatEnvironmentVerificationFailure(proof, workspace) {
  const names = proof.variables.join(", ");
  const state = proof.interrupted
    ? "was interrupted"
    : proof.timedOut
      ? "timed out"
      : `exited ${proof.exitCode}`;
  const focus = formatFailingTestFocus(proof.detail, workspaceTestReader(workspace));
  return [
    `[environment-verification] The configured verifier ${state} when the task-grounded environment variable(s) ${names} were PRESENT in its inherited environment.`,
    `The task/spec explicitly requires correct missing/unset behavior for ${names}. A test for that path is false-green if it only passes when the outer environment happens not to define the variable.`,
    "Fix the implementation or test isolation, then run the configured verifier again. In particular, spreading an env object cannot delete a key that is later inherited from process.env again; pass the explicitly modified child environment without re-merging the inherited key.",
    "",
    `$ ${proof.command}`,
    proof.detail,
    ...(focus ? ["", focus] : []),
  ].join("\n");
}

// Current bytes of the files this run edited, rendered read-style for the
// decision snapshot. Bounded: the four most recently edited files, 160
// numbered lines each — enough to re-expose a residual defect beside the
// folded contract without doubling the prompt.
function renderDecisionSnapshot(workspace, turns, generation) {
  const ordered = [];
  for (const turn of turns) {
    if (!turnEditApplied(turn)) continue;
    for (const edited of editPaths(turn.action ?? turn.parsedAction)) {
      const at = ordered.indexOf(edited);
      if (at >= 0) ordered.splice(at, 1);
      ordered.push(edited);
    }
  }
  return createContextUpdate(workspace, { kind: "decision", paths: ordered.slice(-4), generation });
}

export const GATE_METRIC = {
  empty_done: "emptyDoneRejections",
  premature_done: "doneRejections",
  continuity_reconcile: "continuityReconcileRejections",
  notes_documentation: "notesDocumentationRejections",
  verify_red: "verifyRedDoneRejections",
  sibling_symbol: "siblingSymbolRejections",
  task_coverage: "taskCoverageRejections",
  probe_demand: "probeDemandRejections",
  constant_grounding: "constantGroundingRejections",
  sibling_sweep: "siblingSweepRejections",
  family_convention: "familyConventionRejections",
  edge_smoke: "edgeSmokeRejections",
  spec_example: "specExampleRejections",
  lexical_smoke: "lexicalSmokeRejections",
  type_contract: "typeContractRejections",
  unverified_edit: "unverifiedEditRejections",
  secret_cleanup: "secretAuditRejections",
  immutable_file: "selfCheckRejections",
  evidence: "evidenceGateRejections",
  vision_unverified: "visionUnverifiedRejections",
  unsearched_choice: "unsearchedChoiceRejections",
  unsimulated_target: "unsimulatedTargetRejections",
  preview: "previewGateRejections",
  requirement_ledger: "ledgerRejections",
  report_shape: "reportShapeRejections",
};

async function runPostVerifyIntegrity(check, context) {
  try {
    const res = await check(context);
    return normalizeIntegrity(res);
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    return {
      clean: false,
      violations: [{
        path: "(integrity check)",
        kind: "integrity-error",
        change: "error",
        detail,
      }],
      error: detail,
    };
  }
}

function normalizeIntegrity(res) {
  if (!res || typeof res !== "object") return { clean: false, violations: [] };
  const violations = Array.isArray(res.violations) ? res.violations : [];
  return {
    ...res,
    clean: Boolean(res.clean),
    violations,
  };
}

function recordReplaceFailure(metrics, observation) {
  if (!/^ERROR:/.test(String(observation ?? ""))) return;
  const kind = classifyReplaceFailure(observation);
  metrics.replaceFailures.total++;
  metrics.replaceFailures[kind]++;
}

function recordPatchFailure(metrics, observation) {
  if (!/^ERROR:/.test(String(observation ?? ""))) return;
  const kind = classifyPatchFailure(observation);
  metrics.patchFailures.total++;
  metrics.patchFailures[kind]++;
}

function recordFileOperationFailure(metrics, action, observation) {
  if (!/^ERROR:/.test(String(observation ?? ""))) return;
  metrics.fileOperationFailures.total++;
  metrics.fileOperationFailures[action.a]++;
}

function formatProgressGateTermination(consecutiveRejections, progresslessTurns) {
  return `[progress-awareness] Progress gate termination: ${consecutiveRejections} consecutive recon actions were rejected after ${progresslessTurns} progressless turns. Ending the agent loop now so the hidden verifier can grade the current workspace instead of spending the remaining turn budget repeating blocked actions.`;
}

function classifyReplaceFailure(observation) {
  if (/"old" text not found/.test(observation)) return "oldNotFound";
  if (/"old" text appears more than once/.test(observation)) return "ambiguous";
  if (/line \d+ is out of range/.test(observation)) return "lineStale";
  return "other";
}

function classifyPatchFailure(observation) {
  if (/"old" text not found/.test(observation)) return "oldNotFound";
  if (/"old" text appears more than once/.test(observation)) return "ambiguous";
  if (/\boverlap\b/.test(observation)) return "overlap";
  return "other";
}

function currentEditFocus(action, workspace) {
  const focus = new Map();
  const add = (file, start, lineCount = 1) => {
    if (!file || !Number.isInteger(start) || start < 1) return;
    const end = start + Math.max(1, Number(lineCount) || 1) - 1;
    const ranges = focus.get(file) ?? [];
    ranges.push({ start, end });
    focus.set(file, ranges);
  };
  const locate = (file, replacement, fallbackLine) => {
    const text = String(replacement ?? "");
    if (text) {
      try {
        const source = fs.readFileSync(path.join(workspace, file), "utf8");
        const index = source.indexOf(text);
        if (index >= 0 && source.indexOf(text, index + Math.max(1, text.length)) === -1) {
          add(file, source.slice(0, index).split("\n").length, text.split("\n").length);
          return;
        }
      } catch { /* use a visible line anchor when available */ }
    }
    if (Number.isInteger(fallbackLine)) add(file, fallbackLine, text.split("\n").length);
  };

  if (action?.a === "edit_lines") {
    add(action.p, action.start, String(action.new ?? "").split("\n").length);
  } else if (action?.a === "replace") {
    locate(action.p, action.new, action.line);
  } else if (action?.a === "patch") {
    for (const edit of action.edits ?? []) locate(edit.p, edit.new, edit.line);
  } else if (action?.a === "write_file") {
    add(action.p, 1, String(action.content ?? "").split("\n").length);
  } else if (action?.a === "write_batch") {
    for (const file of action.files ?? []) {
      add(file.p, 1, String(file.content ?? "").split("\n").length);
    }
  }
  return focus;
}

// Where a REFUSED edit was aiming, in the file as it still stands.
//
// currentEditFocus locates the NEW text, which exists only after a write. A
// refusal wrote nothing, so the seam has to be anchored on the old side:
// edit_lines carries its own coordinates, an exact-text edit is found by `old`.
// Padded to expose the enclosing structure, because the usual reason an edit is
// refused is a delimiter left open — which is unreadable from the edited lines
// alone. Ticket B (2026-08-16): one edit_lines at src/agent.js:1513 re-sent
// nine times while the panel showed lines 257-342 and 530-543 of 5,533.
function refusedEditFocus(action, workspace, pad = 60) {
  const focus = new Map();
  const add = (file, start, end) => {
    if (!file || !Number.isInteger(start) || start < 1) return;
    const from = Math.max(1, start - pad);
    const to = Math.max(start, Number.isInteger(end) ? end : start) + pad;
    const ranges = focus.get(file) ?? [];
    ranges.push({ start: from, end: to });
    focus.set(file, ranges);
  };
  const anchor = (file, oldText, fallbackLine) => {
    const text = String(oldText ?? "");
    if (text) {
      try {
        const source = fs.readFileSync(path.join(workspace, file), "utf8");
        const index = source.indexOf(text);
        if (index >= 0) {
          const start = source.slice(0, index).split("\n").length;
          add(file, start, start + text.split("\n").length - 1);
          return;
        }
      } catch { /* fall through to the declared anchor */ }
    }
    if (Number.isInteger(fallbackLine)) add(file, fallbackLine, fallbackLine);
  };

  if (action?.a === "edit_lines") add(action.p, action.start, action.end);
  else if (action?.a === "replace") anchor(action.p, action.old, action.line);
  else if (action?.a === "patch") for (const edit of action.edits ?? []) anchor(edit.p, edit.old, edit.line);
  return focus;
}

function retargetEditAction(action, from, to) {
  if (!action || from === to) return action;
  if (action.a === "patch") {
    return {
      ...action,
      edits: (action.edits ?? []).map((edit) => edit?.p === from ? { ...edit, p: to } : edit),
    };
  }
  if (action.a === "write_batch") {
    return {
      ...action,
      files: (action.files ?? []).map((file) => file?.p === from ? { ...file, p: to } : file),
    };
  }
  return action.p === from ? { ...action, p: to } : action;
}

function currentFailureSourceFacts(turns, exec) {
  const candidates = [...new Set(turns.slice(-80).reverse().flatMap(turn => [
    ...(turnEditApplied(turn) ? editPaths(turn.action ?? turn.parsedAction) : []),
    ...(Array.isArray(turn.shellChangedPaths) ? turn.shellChangedPaths : []),
  ]))].filter(p => typeof p === "string" && /\.(?:js|mjs|cjs)$/i.test(p)
    && !isGeneratedPath(p) && !isTestPath(p)).slice(0, 3);
  const facts = [];
  for (const candidate of candidates) {
    try {
      const filename = exec.resolveExisting(candidate);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const receipt = collectObjectConstructionFacts({
        source: fs.readFileSync(filename, "utf8"), path: candidate,
      });
      if (receipt) facts.push(receipt);
    } catch { /* Advisory source inspection must not prevent ordinary recovery. */ }
  }
  return facts;
}

function mapQueryPayload(value) {
  const query = String(value ?? "").trim();
  if (/^map\s*:/i.test(query)) return query.replace(/^map\s*:\s*/i, "");
  if (/^map\s+/i.test(query)) return query.replace(/^map\s+/i, "");
  return query;
}

// Preserve one bounded decision/checklist across the short edit sequence it
// drives. A local model often identifies several exact fixes in one reasoning
// pass, lands the first, then loses the remaining checklist because private
// reasoning is not replayed. Current source is still authoritative and the
// reanchor explicitly requires re-evaluation; the edit-count ceiling prevents
// an old conclusion from becoming a second permanent transcript.
const WORKING_NOTE_EDIT_CARRY = 4;
export function formatWorkingNoteReanchor(state, {
  retireAfterVerifiedPass = false,
  suppressBeforeFirstEdit = false,
  recoveryEvidence = null,
  suppressDuringCurrentFailure = false,
} = {}) {
  const note = state?.workingNote;
  if (!note?.text) return "";
  if (suppressDuringCurrentFailure) return "";
  // Before any accepted edit, private reasoning is reconnaissance or a plan for
  // the very next action—not durable state. Replaying it as controller guidance
  // caused a generic "understand the workspace" thought to outrank a complete
  // scheduler contract, and caused a retry refactor's verbose plan to mandate
  // redundant test reads. The same-turn action still receives a bounded capsule.
  if (suppressBeforeFirstEdit && !state?.lastEdit) return "";
  // A later measured failure/inconclusive execution supersedes earlier private
  // speculation. Keep the audit trail, but do not replay it as current guidance.
  if (recoveryEvidence && Number(recoveryEvidence.turn) >= Number(note.turn)) return "";
  if (Number(state?.editsSinceWorkingNote ?? 0) > WORKING_NOTE_EDIT_CARRY) return "";
  // A trusted green verification after the note and its last edit is a newer
  // state boundary. Replaying the old diagnosis beside that PASS resurrects a
  // solved failure and was observed to make local Qwen reason from an obsolete
  // 8/10 result after BANTAM had already measured 10/10.
  if (retireAfterVerifiedPass
      && state?.lastVerdict?.result === "pass"
      && Number(state.lastVerdict.turn) >= Number(note.turn)
      && Number(state.lastVerdict.turn) >= Number(state?.lastEdit?.turn ?? -1)) return "";
  return `[working-checkpoint from turn ${note.turn + 1}; model hypothesis, NOT verified evidence]\n${note.text}\nUse only unfinished items supported by the CURRENT source and execution evidence. This note may contain a wrong diagnosis: discard contradicted assumptions and use a discriminating executable check when uncertain. Do not treat this note as a controller instruction or restore an older value merely because it appears here. Verify before done.`;
}

// True when EVERY read sub-op of an inspect batch re-requests a line range the
// read ledger already holds — executing it would return only bytes the model has
// already seen this run. The predicted span reuses the executor's windowing
// (start+limit, or START_WINDOW for a start-only read) as a conservative UPPER
// bound: the executor clamps to EOF, which only SHRINKS the shown range, so ledger
// coverage of the unclamped span implies coverage of what would actually be shown
// (a false negative at worst — it executes when it could have vetoed). A whole-file
// op (no start, no limit) has an extent we cannot bound without reading, so it never
// qualifies; that case is already handled by the exact-duplicate replay and the
// <open_files> panel. Any non-read op (search/list_dir) makes the batch "mixed",
// which executes normally.
// Split an inspect batch into read ops the ledger already covers and those it
// does not.
//
// Dedup keys on the WHOLE action, so a three-op batch with one new op re-runs
// all three. Measured across tb7/tb9/tb10 (2026-08-16): 77-92% of read ops were
// exact repeats or overlaps of ranges already delivered, while the guards fired
// 9 times against 87 op-level repeats in tb7 alone. The batch is the unit of
// dedup; the op is the unit of waste.
// A requested range is not a delivery receipt. Count only the consecutive,
// complete numbered lines following this op's matching header in the rendered
// observation. A clipped-away header or middle/tail fragment proves nothing.
export function deliveredReadRange(op, observation) {
  if (op?.a !== "read_file" || typeof op.p !== "string") return null;
  const obsText = String(observation ?? "");
  const escaped = op.p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = Number.isInteger(op.start) ? op.start : 1;
  const shown = new RegExp(`(?:^|\\n)${escaped} \\((\\d+) lines, showing (${start})-(\\d+)\\):\\n`).exec(obsText);
  if (!shown) return null;
  const lines = obsText.slice(shown.index + shown[0].length).split("\n");
  let end = start - 1;
  for (let i = 0; i < lines.length - 1 && end < Number(shown[3]); i += 1) {
    const line = /^(\d+)\t/.exec(lines[i]);
    if (!line || Number(line[1]) !== end + 1) break;
    // clipText may manufacture a newline after a half-line. Never credit that
    // boundary line, even when its line-number prefix survived.
    if (/^(?:\.\.\.|…) .*clipped/.test(lines[i + 1])) break;
    end += 1;
  }
  return end >= start ? { total: Number(shown[1]), start, end } : null;
}

function splitInspectByLedger(action, ledger, isResident) {
  const empty = { covered: [], remaining: [] };
  if (action?.a !== "inspect" || !Array.isArray(action.ops) || action.ops.length < 2) return empty;
  const covered = [];
  const remaining = [];
  for (const op of action.ops) {
    if (op?.a !== "read_file" || typeof op.p !== "string") { remaining.push(op); continue; }
    const start = Number.isInteger(op.start) ? op.start : 1;
    let end;
    if (Number.isInteger(op.limit)) end = start + op.limit - 1;
    else if (Number.isInteger(op.start)) end = op.start + START_WINDOW - 1;
    // A whole-file re-read is only redundant if the packet holds the whole file.
    else if (ledger.fullyRead(op.p) && isResident(op.p, null, null)) { covered.push(op); continue; }
    else { remaining.push(op); continue; }
    // Residency is asked of the RANGE, not the file: "you already read
    // src/agent.js 5485-5544" is no answer when the packet renders 1-600.
    if (!isResident(op.p, start, end)) { remaining.push(op); continue; }
    // Requests are written in REQUEST space and answered in SHOWN space; a
    // window past the end of the file is the norm. `satisfies` asks whether a
    // re-run could return anything new, which is the question that matters.
    if (ledger.satisfies(op.p, start, end)) covered.push(op);
    else remaining.push(op);
  }
  return covered.length && remaining.length ? { covered, remaining } : empty;
}

function coveredOpsNote(covered) {
  const list = covered
    .map((op) => {
      const start = Number.isInteger(op.start) ? op.start : 1;
      const end = Number.isInteger(op.limit) ? start + op.limit - 1 : null;
      return `${op.p}${end ? ` ${start}-${end}` : ""}`;
    })
    .join(", ");
  return `[ledger] Skipped ${covered.length} read op(s) already in your read history: ${list}. `
    + "Those bytes are already in this prompt — only the remaining ops ran. "
    + "Inspect an UNREAD range, or `search` for the exact identifier you need.\n\n";
}

function inspectFullyInLedger(action, ledger) {
  if (action?.a !== "inspect" || !Array.isArray(action.ops) || action.ops.length === 0) return false;
  let sawRead = false;
  for (const op of action.ops) {
    if (op?.a !== "read_file" || typeof op.p !== "string") return false; // mixed batch — execute
    const start = Number.isInteger(op.start) ? op.start : 1;
    let end;
    if (Number.isInteger(op.limit)) end = start + op.limit - 1;
    else if (Number.isInteger(op.start)) end = op.start + START_WINDOW - 1;
    else if (ledger.fullyRead(op.p)) { sawRead = true; continue; } // already read whole, unchanged since
    else return false; // never read whole: extent unknown without reading — let it execute
    if (!ledger.covers(op.p, start, end)) return false;
    sawRead = true;
  }
  return sawRead;
}

// Replaying a read as "already seen" is correct only when the exact current
// source it refers to is still present in the prompt. Historical execution and
// prompt residency are different facts: sticky history slimming deliberately
// removes old bodies after they have once appeared in <open_files>.
// The paths the assembled packet actually carries an entry for. Derived from the
// emitted text rather than from the panel's inputs, because everything upstream
// describes what the panel MEANT to render and the packet is what the model got.
export function panelEntryPaths(packetText) {
  return [...String(packetText ?? "").matchAll(/^# (\S+) \(current, \d+ lines\)/gm)].map((match) => match[1]);
}

// Entries the packet carries WHOLE, as path -> line count.
//
// fullyRenderedPaths() answers the same question against the panel's inputs: it
// re-runs the planner with panelOptions, which does not carry the byte budget
// compileContextPacket settles on afterwards. A file it judges complete can
// therefore be clipped, or absent, in the packet that ships — and this map
// decides both whether a read observation may be stubbed out of history
// (panelSubstitutableNow) and whether a re-read is refused as already-present.
// tb21 lost src/fixture-runner.js through exactly that pair: stubbed from
// history as substitutable, then refused as resident, with the bytes nowhere.
//
// Read the emitted text instead. An entry is whole when it renders every line
// from 1 to its stated length and carries no truncation marker.
// Which line numbers each packet entry actually renders, as sorted ranges.
//
// The ledger reasons about RANGES ("you already read src/agent.js 5485-5544")
// while residency was checked per FILE. On a 5,853-line file the packet holds a
// slice, so "src/agent.js is in the panel" is true while the wanted lines are
// nowhere in the prompt. Measured across the stored runs: 330 of 460
// ledger-refused read ops (71.7%) asked for a range that was in neither the
// packet nor history, and it fires in every recent run — tb25 refused
// src/agent.js 5485-5544 five times while the panel rendered a different slice
// and the original read had left history. That run ended at the cap with a
// green tree and no `done`.
export function panelRenderedRanges(packetText) {
  const byPath = new Map();
  for (const entry of String(packetText ?? "").split(/\n(?=# \S)/)) {
    const header = /^# (\S+) \(current, (\d+) lines\)/.exec(entry);
    if (!header) continue;
    const renderedLines = entry.split("\n");
    const lines = renderedLines.flatMap((line, index) => {
      const match = /^(\d+)\t/.exec(line);
      if (!match || /chars — read_file to page/.test(line)
          || /panel truncated/.test(renderedLines[index + 1] ?? "")) return [];
      return [Number(match[1])];
    }).sort((a, b) => a - b);
    const ranges = [];
    for (const n of lines) {
      const last = ranges[ranges.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else if (!last || n !== last[1]) ranges.push([n, n]);
    }
    // The total comes from the header so a request window longer than the file
    // can be clamped: a read of 1-200 in a 150-line file is answered
    // "showing 1-150", and demanding line 200 be rendered would never hold.
    byPath.set(header[1], { total: Number(header[2]), ranges });
  }
  return byPath;
}

// A requested range is reachable when the packet renders every line of it. A
// partly-rendered range is not: the model asked for the part it cannot see.
export function packetCoversRange(ranges, start, end) {
  if (!Array.isArray(ranges)) return false;
  let cursor = start;
  for (const [from, to] of ranges) {
    if (to < cursor) continue;
    if (from > cursor) return false;
    if (to >= end) return true;
    cursor = to + 1;
  }
  return cursor > end;
}

export function completePanelEntries(packetText) {
  const complete = new Map();
  for (const entry of String(packetText ?? "").split(/\n(?=# \S)/)) {
    const header = /^# (\S+) \(current, (\d+) lines\)/.exec(entry);
    if (!header) continue;
    if (/more lines omitted|panel truncated|chars — read_file to page|… \(lines \d+[–-]\d+ omitted\)/.test(entry)) continue;
    const claimed = Number(header[2]);
    const rendered = new Set([...entry.matchAll(/(?:^|\n)\s*(\d+)\t/g)].map((m) => Number(m[1])));
    if (rendered.size !== claimed) continue;
    complete.set(header[1], claimed);
  }
  return complete;
}

// "Listed in the panel" was taken to mean "its bytes are in this prompt",
// because prompt.js retains the newest live read of a file it cannot
// substitute. That holds for ONE range per file. tb25 read src/agent.js
// 5485-5544 early, read other ranges after, and the first observation was
// superseded and stubbed — so the range was in neither the packet nor history
// while the guard still called it resident, and the re-read was refused five
// times. Measured across the stored runs: 330 of 460 ledger-refused read ops
// (71.7%) named a range in neither place.
function readReplayIsContextSafe(action, completeOpenFiles, panelPaths = null, rangeResident = null) {
  const resident = (op) => {
    const path = op.p;
    if (completeOpenFiles.has(path)) return true;
    if (!panelPaths?.has(path)) return false;
    if (!rangeResident) return true;
    const start = Number.isInteger(op.start) ? op.start : 1;
    const end = Number.isInteger(op.limit) ? start + op.limit - 1 : null;
    return rangeResident(path, start, end);
  };
  if (action?.a === "read_file") return resident(action);
  if (action?.a !== "inspect") return true;
  const reads = (action.ops ?? []).filter((op) => op?.a === "read_file");
  return reads.length === 0 || reads.every((op) => resident(op));
}

/**
 * A plain whole-file read of a file already read in full and unedited since.
 *
 * The inspect path has had a ledger refusal for a while; a bare `read_file`
 * never did, and its only guard (the duplicate check) requires the panel to
 * render the file completely. Measured 2026-08-15 (ticket A, verifier
 * attached): 27 whole-file reads of src/gate-policy.js in one 30-turn run,
 * one edit, ticket unfinished.
 */
function readFullyInLedger(action, ledger) {
  if (action?.a !== "read_file" || typeof action.p !== "string") return false;
  // Whole-file re-read. A bare read does not return the whole file — it
  // returns the first window — so "covered" means either the file is on record
  // end to end OR that first window already is. Checking only fullyRead made
  // this branch unreachable for any file longer than the window, which is
  // every file the stall actually involves (measured 2026-08-15: 33 bare
  // rereads of a 178-line file, zero refusals).
  if (!Number.isInteger(action.start) && !Number.isInteger(action.limit)) {
    return ledger.fullyRead(action.p) || ledger.covers(action.p, 1, START_WINDOW);
  }
  // Ranged re-read: the same rule the inspect path already applies to its
  // sub-ops. Measured 2026-08-15 (ticket A, fifth parity run): after the
  // whole-file case was closed the model simply re-read `lines 1-100` twenty
  // times instead — the range form of the identical stall.
  const start = Number.isInteger(action.start) ? action.start : 1;
  const end = Number.isInteger(action.limit)
    ? start + action.limit - 1
    : start + START_WINDOW - 1;
  return ledger.covers(action.p, start, end);
}

// Compact pointer that REPLACES a fully-covered inspect batch (see inspectFullyInLedger).
// It states only verifiable truths — the exact ranges are in the read map (which is
// non-empty and lists them whenever covers() held), and the files are unchanged since,
// so nothing new would return — and carries the correction: where the content already
// is, and the productive next moves. The <open_files> panel can clip large files, so it
// is named only as a maybe, never asserted to hold the range.
function ledgerReplayMessage(action, openFilesView) {
  // Both shapes reach here: a fully-covered inspect batch and a bare whole-file
  // re-read of a file already on the ledger.
  const paths = Array.isArray(action.ops)
    ? [...new Set(action.ops.map((op) => op.p))].join(", ")
    : String(action.p ?? "");
  const panelHint = openFilesView ? " and the requested current ranges are visible in <open_files> above" : "";
  return `[ledger] Not re-read: every range in this inspect (${paths}) is already recorded in your read history${panelHint}. Re-running it would return only bytes already present in this prompt, so it was not executed. To make progress: inspect an UNREAD range, run a \`search\` for the exact identifier you need (it answers with file:line), request a \`map\` overview you have not fetched yet, or — if you already have enough — answer now.`;
}

// Minimal chat-format prompt for the skill-distillation call. The template
// comes from the model profile (ChatML by default, so callers that pass only a
// prefill are byte-identical to before).
function buildDistillPrompt(instruction, assistantPrefill, template = CHATML_TEMPLATE) {
  return `${template.open("system")}You distill reusable engineering skills from solved coding tasks. Output only the requested JSON object.\n${template.close}` +
    `${template.open("user")}${instruction}\n${template.close}${assistantPrefill}`;
}

// Neutral Qwen-format prompt for auxiliary side-calls (e.g. planning).
// Live progress detail for a streaming action generation: once the action head is visible in the
// partial JSON, name the verb (and target path) so the heartbeat says WHAT is being produced —
// "write_file index.html · 1.8k tokens" instead of a bare spinner for minutes on a big generation.
function describePartialAction({ tokens = 0, content = "" } = {}) {
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
  // Grammar-constrained generation is pure JSON from the first brace; a later brace would be
  // inside the content body of a big write, so take the FIRST one.
  const start = content.indexOf("{");
  const head = start === -1 ? "" : content.slice(start, start + 200);
  const verb = head.match(/"a"\s*:\s*"([a-z_]+)"/)?.[1];
  const path = head.match(/"p"\s*:\s*"([^"]{1,80})"/)?.[1];
  const cmd = head.match(/"c"\s*:\s*"([^"]{1,60})/)?.[1];
  if (verb === "shell" && cmd) return `shell: ${cmd} · ${tok}`;
  if (verb && path) return `${verb} ${path} · ${tok}`;
  if (verb) return `${verb} · ${tok}`;
  return tok;
}

// The refusal an in-loop scope gate produces for an edit action, or null to let
// it through. Phrased as a redirect: it names the boundary, says the edit did
// NOT land (so the model does not assume the file changed), and points at the
// legitimate way to get the same assurance — because the behavior this most
// often intercepts is a model trying to test its own work more thoroughly.
export function editScopeRefusal(action, guard) {
  if (typeof guard !== "function" || !isEditAction(action)) return null;
  for (const p of editPaths(action)) {
    const reason = guard(p);
    if (!reason) continue;
    if (reason === "outside-workspace") {
      return `[scope] ${p} is outside this workspace; direct file edits are confined to workspace paths. The edit was NOT applied.`
        + " Create any new check in a permitted workspace path. Let the check create temporary fixtures with os.tmpdir() or the runtime's equivalent; temporary fixtures are not the check script itself. Create the check separately, then run its launcher directly.";
    }
    const why = reason === "grader"
      ? "it is part of the grader for this task"
      : reason === "instruction-forbidden"
        ? "the task explicitly forbids changing it"
      : reason === "runner-config"
        ? "it configures the test runner for this task"
        : "it is outside the paths this task may edit";
    // Name the allowlist when the guard exposes it: the polyglot-js false start
    // (2026-08-15) spent 11 runs x 24 turns bouncing off "the editable paths"
    // with the model never told which paths those were. The bounce delivers
    // the fact (2026-08-12 mechanism finding) or it teaches nothing.
    const redirect = reason === "out-of-scope"
      ? (Array.isArray(guard.editable) && guard.editable.length
        ? `The editable paths for this task: ${guard.editable.join(", ")}. Make the change there instead.`
          + (guard.editableMatchesNothing
            ? " (Note: no existing file is under these paths — the task's editable configuration may be broken. If the task is impossible as scoped, say so in your done summary instead of retrying edits.)"
            : "")
        : "Make the change inside the editable paths instead.")
      : guard?.instruction?.preserveExistingTests
        ? "The edit was NOT applied. Existing supplied tests must stay unchanged. Add any extra checks in a NEW permitted test file, not by appending to or replacing a supplied file. Fix production source only where a check demonstrates a defect."
        : "The edit was NOT applied. Fix the source instead — and if you want stronger checks than the existing suite gives you, run them ad hoc with `shell` rather than adding them to the suite.";
    return `[scope] ${p} is immutable: ${why}. ${redirect}`;
  }
  return null;
}

function buildAuxPrompt(instruction, assistantPrefill, template = CHATML_TEMPLATE) {
  return `${template.open("system")}You are a careful senior engineer. Follow the instruction exactly and output only what is asked.\n${template.close}` +
    `${template.open("user")}${instruction}\n${template.close}${assistantPrefill}`;
}

function buildDiagnosticImplementationContext(openPaths, resolvePath) {
  const ranked = [...new Set(Array.isArray(openPaths) ? openPaths : [])]
    .filter((p) => typeof p === "string" && p && !isTestPath(p) && !isGeneratedPath(p))
    .map((p, recency) => ({
      p,
      recency,
      priority: SOURCE_EXT_RE.test(p) ? 0 : (DIAGNOSTIC_DOC_RE.test(p) ? 2 : 1),
    }))
    .sort((a, b) => a.priority - b.priority || a.recency - b.recency);

  const sections = [];
  const paths = [];
  let remaining = DIAGNOSTIC_IMPL_MAX_TOTAL_BYTES;
  for (const { p } of ranked) {
    if (paths.length >= DIAGNOSTIC_IMPL_MAX_FILES || remaining < 256) break;
    try {
      const abs = resolvePath(p);
      if (!fs.statSync(abs).isFile()) continue;
      const separatorBytes = sections.length ? 2 : 0;
      const header = `--- FILE: ${p} ---\n`;
      const headerBytes = Buffer.byteLength(header, "utf8");
      if (separatorBytes + headerBytes >= remaining) continue;
      const source = fs.readFileSync(abs, "utf8");
      const body = clipDiagnosticImplementationSource(
        source,
        Math.min(DIAGNOSTIC_IMPL_MAX_FILE_BYTES, remaining - separatorBytes - headerBytes),
      );
      const section = `${header}${body}`;
      sections.push(section);
      paths.push(p);
      remaining -= separatorBytes + Buffer.byteLength(section, "utf8");
    } catch { /* stale, unreadable, or escaped path: omit it */ }
  }
  return { source: sections.join("\n\n"), paths };
}

function clipDiagnosticImplementationSource(source, maxBytes) {
  const text = String(source ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const marker = "\n… [file clipped for focused diagnosis]\n";
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const head = bytes.subarray(0, room).toString("utf8").replace(/\uFFFD$/, "");
  return `${head}${marker}`;
}

async function runVerification(
  workspace,
  script,
  signal = null,
  timeoutMs = 120000,
  {
    doubleCheck = false,
    envOverrides = null,
    shellSandbox = undefined,
    shellNetwork = undefined,
    dockerImage = undefined,
    readOnlyWorkspacePaths = null,
    workspaceReadOnly = false,
    processRunner = undefined,
    onExecution = null,
  } = {},
) {
  if (workspaceReadOnly && (shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker") !== "docker") {
    throw new Error("read-only configured verification requires the Docker shell sandbox");
  }
  const root = path.resolve(workspace);
  const res = { ...await runShellProcess(root, withNodeTestTimeout(script, timeoutMs), {
    timeoutMs,
    signal,
    pipefail: true,
    envOverrides,
    shellSandbox,
    shellNetwork,
    dockerImage,
    readOnlyWorkspacePaths,
    workspaceReadOnly,
    processRunner,
  }), workspaceReadOnly };
  onExecution?.(res);
  const first = { ...classifyVerificationResult(res, { root: workspace }), workspaceReadOnly };
  if (first.status !== "pass") return first;
  // A single verify run is a coin-flip on a flaky/nondeterministic suite, and a flaky PASS is the
  // dangerous case — a false green that certifies broken work. When enabled, re-run a pass once: if it
  // doesn't reproduce, report "unverified (flaky)" instead of a trustworthy green. Off by default (it
  // doubles the cost of a passing verify); enable with BANTAM_FLAKY_VERIFY=1 on flaky-prone suites.
  if (doubleCheck) {
    // Byte-identical command to the first run: a re-run without the per-test
    // timeout is a different verifier, and a hanging test would outlive the
    // bound the first run promised.
    const res2 = { ...await runShellProcess(root, withNodeTestTimeout(script, timeoutMs), {
      timeoutMs,
      signal,
      pipefail: true,
      envOverrides,
      shellSandbox,
      shellNetwork,
      dockerImage,
      readOnlyWorkspacePaths,
      workspaceReadOnly,
      processRunner,
    }), workspaceReadOnly };
    onExecution?.(res2);
    const second = { ...classifyVerificationResult(res2, { root: workspace }), workspaceReadOnly };
    if (second.status === "fail") {
      return {
        status: "unverified",
        flaky: true,
        workspaceReadOnly,
        exitCode: second.exitCode,
        detail: clip(`verifier PASSED once but FAILED on a re-run — flaky/nondeterministic, not a trustworthy green.\n${second.detail}`),
      };
    }
    if (second.status === "unverified") {
      return {
        ...second,
        detail: clip(`verifier PASSED once but its re-run was inconclusive, so this is not a trustworthy green.\n${second.detail}`),
      };
    }
  }
  return first;
}

export function classifyVerificationResult(result = {}, { root = null } = {}) {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
  const exitCode = Number.isInteger(result.code) ? result.code : null;
  const withOutput = (message) => clip(`${message}${output ? `\n${output}` : ""}`);
  const base = exitCode === null ? {} : { exitCode };

  if (result.aborted) {
    return {
      status: "unverified",
      ...base,
      interrupted: true,
      detail: withOutput("verification interrupted by user"),
    };
  }
  if (result.timedOut) {
    return {
      status: "unverified",
      ...base,
      timedOut: true,
      detail: withOutput("verification timed out"),
    };
  }
  if (result.bufferExceeded) {
    return {
      status: "unverified",
      ...base,
      bufferExceeded: true,
      detail: withOutput("verification output exceeded the capture limit; the process was terminated before a trustworthy verdict"),
    };
  }
  if (result.signal) {
    return {
      status: "unverified",
      ...base,
      signal: result.signal,
      detail: withOutput(`verification terminated by signal ${result.signal}`),
    };
  }
  if (result.error) {
    const message = result.error?.message ?? String(result.error);
    return {
      status: "unverified",
      ...base,
      error: message,
      detail: withOutput(`verification process error: ${message}`),
    };
  }
  if (exitCode === null) {
    return {
      status: "unverified",
      detail: withOutput("verification process ended without an exit code"),
    };
  }
  // Lead with every failure by name. The clip below preserves the FIRST failure
  // region, which is what a 2,000-character budget can hold of a 2,000-test TAP
  // — so a run that ends FOUR tests short recorded one of them (tb30). The
  // digest names all of them with their assertions in a few hundred characters,
  // and this detail is the only record of why a run failed once its workspace
  // is gone.
  const focus = exitCode === 0 ? "" : safeFailingTests(output, root);
  return {
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    detail: focus ? `${focus}\n${clip(output, Math.max(800, 2000 - focus.length))}` : clip(output),
  };
}

// The record is worth more than the annotation: a parser throw must not cost the
// detail it was meant to improve.
function safeFailingTests(output, root) {
  try { return renderFailingTests(output, { max: 8, root }); } catch { return ""; }
}

function normalizeWorkspaceRel(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Names too generic to be a sibling-definition signal: a same-named `main` or
// `setup` elsewhere is convention, not shared implementation.
const SIBLING_SYMBOL_STOPLIST = new Set([
  "main", "run", "init", "setup", "teardown", "test", "tests", "index", "handle",
  "execute", "update", "create", "delete", "process", "format", "parse", "render",
  "load", "save", "clean", "build", "check", "start", "stop", "close", "open",
  "read", "write", "reset", "clear", "helper", "wrapper", "callback",
]);

function recordEditedSymbols(map, { file, action, observation, workspace }) {
  const candidates = new Set();
  for (const text of [action.old, action.new, action.content, action.text]) {
    if (typeof text === "string") for (const s of symbolsIn(text)) candidates.add(s);
  }
  // A narrow replacement rarely contains its own enclosing `def` line — the
  // serializer miss edited one line inside queryset_iterator and named nothing.
  // Recover the enclosing declaration from the file at the edit line.
  const lineMatch = /at line (\d+)/.exec(String(observation ?? ""));
  let startLine = Number.isInteger(action.start) ? action.start : (lineMatch ? Number(lineMatch[1]) : null);
  try {
    const lines = fs.readFileSync(path.join(workspace, file), "utf8").split("\n");
    if (!startLine) {
      // The replace observation does not always carry a line number — find the
      // replacement text in the post-edit file instead.
      const needle = String(action.new ?? action.content ?? action.text ?? "").split("\n")
        .map((l) => l.trim()).find((l) => l.length > 3);
      if (needle) {
        const at = lines.findIndex((l) => l.trim() === needle || l.includes(needle));
        if (at !== -1) startLine = at + 1;
      }
    }
    if (startLine) {
      for (let i = Math.min(startLine, lines.length) - 1; i >= 0; i--) {
        const m = /^\s*(?:async\s+)?(?:def|function|class)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
        if (m) { candidates.add(m[1]); break; }
      }
    }
  } catch { /* file moved/deleted since the edit: nothing to record */ }
  for (const s of candidates) {
    if (s.length < 4 || s.startsWith("__") || SIBLING_SYMBOL_STOPLIST.has(s.toLowerCase())) continue;
    if (!map.has(s)) map.set(s, file);
  }
}

function siblingDefinitionFindings({ db, editedSymbolSites, visitedPaths, workspace }) {
  // Delegates to the shared completeness-critic detector (one source of truth
  // for the KB query), then maps the returned challenges back to the shape
  // formatSiblingSymbolDone expects, recovering editedFile per symbol.
  const editedBySymbol = editedSymbolSites instanceof Map
    ? editedSymbolSites : new Map(editedSymbolSites);
  const challenges = detectSiblings({
    ground: { db }, editedSymbols: editedSymbolSites, visited: visitedPaths, workspace,
  });
  return challenges.map((c) => ({
    symbol: c.target,
    editedFile: editedBySymbol.get(c.target) ?? null,
    other: c.sites[0].file,
    line: c.sites[0].line,
  }));
}

function findDefinitionLine(file, symbol) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const re = new RegExp(`^\\s*(?:async\\s+)?(?:def|function|class)\\s+${symbol}\\b|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${symbol}\\s*=`);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  } catch { /* fall through */ }
  return null;
}

function formatFamilyConventionDone(f, baseBlock, mateBlock) {
  const shown = [
    baseBlock ? `— \`${f.base}\` (${f.baseFile}):\n${baseBlock}` : null,
    mateBlock ? `— \`${f.mate}\` (${f.mateFile}):\n${mateBlock}` : null,
  ].filter(Boolean).join("\n");
  return `[done-gate] Cannot accept done yet: you added \`${f.name}\`, which joins the naming family \`${f.base}\`/\`${f.mate}\`, and you never examined the family's implementations:\n${shown}\n`
    + `Align \`${f.name}\` with the family's conventions — including how they treat input that has already been processed — or verify the difference is intentional, then re-emit done. This gate fires only once.`;
}

function formatSiblingSymbolDone(findings) {
  const lines = findings.map(({ symbol, editedFile, other, line }) =>
    `  \`${symbol}\` (you changed it in ${editedFile}) is also defined in ${other}${line ? `:${line}` : ""} — a file you never examined.`);
  return "[done-gate] Cannot accept done yet: your change touched symbol(s) that have same-named definitions elsewhere in this repository, and same-named definitions frequently share the bug or depend on the contract you just changed:\n"
    + `${lines.join("\n")}\n`
    + "Examine each listed site and apply the equivalent change where it applies. If a site is genuinely unaffected, re-emit done — this gate fires only once.";
}

// The bounce carries its correction: the exact command and its full failing
// output, so the next turn starts from the ground truth instead of a bare "no".
function formatVerifyRedDone({ command, detail, unchanged, remaining }) {
  const head = unchanged
    ? "[done-gate] Still cannot accept done: the verify command is still failing and you have NOT changed the workspace since it last failed. Re-reading the failure below and editing the code is the only move that can change this result."
    : "[done-gate] Cannot accept done: the task's verify command is FAILING on the current tree.";
  return `${head}\n$ ${command}\n${detail}\nFix the code so this command passes, then emit done. (${remaining} rejection${remaining === 1 ? "" : "s"} left before the run is graded as-is.)`;
}

function safeListing(workspace) {
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.name !== "node_modules" && e.name !== ".git" && e.name !== ".bantam")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return entries.join("\n");
  } catch (e) {
    return `(could not list workspace: ${e.message})`;
  }
}

/**
 * Clip verifier output to a bounded record that still says what went wrong.
 *
 * Test runners put the summary COUNTS at the end, which is what makes a run
 * gradable — but node's TAP writes the failing case's name and its diagnostic
 * where the failure happened, which for a 2,000-test suite is the middle. A
 * head+tail clip therefore kept a thousand `ok` lines and the totals, and
 * dropped the one `not ok`.
 *
 * .bantam/runs/2026-08-17T12-06-25 is the case: a ticket-B run that ended
 * `# pass 2162 / # fail 1`, whose artifact could not say which test failed.
 * `verifyDetail` is the only record once the workspace is gone, so a failed run
 * became undiagnosable without re-running it.
 *
 * digestTestOutput solved the same problem for what the model sees mid-run
 * (tb24, 2026-08-17). This is its counterpart for the artifact.
 */
export function clipVerificationOutput(s, n = 2000) {
  const text = String(s ?? "");
  if (text.length <= n) return text;
  const marker = `\n... (verification output clipped; tail preserved) ...\n`;
  const failureMarker = `\n... (verification output clipped; failure region kept) ...\n`;
  const kept = Math.max(0, n - marker.length);
  const head = Math.floor(kept / 2);
  const tailLength = kept - head;
  // Where the first failure is reported. TAP's `not ok` is the common case;
  // the others cover runners that summarise instead.
  const at = (() => {
    for (const probe of ["\nnot ok ", "\nFAILURES", "\nFAILED", "\n=== FAILURES"]) {
      const i = text.indexOf(probe);
      if (i !== -1) return i + 1;
    }
    return -1;
  })();
  const tailStart = text.length - tailLength;
  if (at === -1 || at < head || at >= tailStart) {
    // No failure, or it already falls inside a slice being kept.
    return text.slice(0, head) + marker + text.slice(tailStart);
  }
  // Spend the head's budget on the failure instead: what failed and why beats
  // the preamble and the first few passing cases every time.
  const focus = Math.max(0, kept - tailLength - failureMarker.length + marker.length);
  const region = text.slice(at, Math.min(at + focus, tailStart));
  return `${text.slice(0, Math.max(0, head - focus))}${failureMarker}${region}${marker}${text.slice(tailStart)}`;
}

function clip(s, n = 2000) {
  return clipVerificationOutput(s, n);
}

// Wall clock without Date.now sugar so the module stays easy to test.
function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// For thresholds whose documented "=0" means OFF: positiveInt would silently
// turn an explicit 0 back into the default.
function thresholdInt(value, fallback) {
  if (String(value ?? "").trim() === "0") return 0;
  return positiveInt(value, fallback);
}

function normalizeExcludedActions(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("excludeActions must be an array");
  const known = new Set(ALL_ACTION_VERBS);
  const normalized = [...new Set(value.map((verb) => String(verb).trim()).filter(Boolean))];
  const unknown = normalized.filter((verb) => !known.has(verb));
  if (unknown.length) throw new TypeError(`unknown excluded action(s): ${unknown.join(", ")}`);
  return normalized;
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}
