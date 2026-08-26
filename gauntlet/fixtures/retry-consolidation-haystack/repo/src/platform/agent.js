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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatEdgeSmoke } from "./edge-smoke.js";
import { formatSpecExamples } from "./spec-examples.js";
import { formatLexicalSmoke } from "./logic/lexical-smoke.js";
import { formatTypeContractSmoke } from "./logic/type-contract-smoke.js";
import { GATE_ENGAGEMENT_METRIC } from "./logic/gate-engagement.js";
import { ModelClient } from "./model.js";
import { Executor, runShellProcess, withNodeTestTimeout, START_WINDOW } from "./executor.js";
import { isGeneratedPath, isTestPath, snapshotTree } from "./scope-guard.js";
import { isDeliverableRun, isInlineEvalProbe } from "./logic/deliverable-signals.js";
import { shellContainsExactCommandSegment } from "./shell-lex.js";
import { symbolsIn } from "./collateral.js";
import { impactFooter, familyFooter, familyFindings, familyBlocks, crossScopeUsageFooter, peerFunctionFooter } from "./edit-context.js";
import { detectSiblings } from "./logic/completeness-critic.js";
import { continuityAnchors, renderContinuityAnchors } from "./logic/continuity-anchors.js";
import { formatFailingTestFocus, workspaceTestReader, parseTestCounts, parseTestFailures, extractTestDiagnosticContext, diagnosedImplementationPath, diagnoseFailingTest } from "./logic/test-focus.js";
import { teacherFromEnv, askTeacher } from "./teacher-assist.js";
import { buildPrompt, slimSuccessfulShellReplay, SUPERSEDED_EDIT } from "./prompt.js";
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
  if (action?.a !== "write_file" || typeof action.content !== "string") return null;
  const c = action.content;
  if (c.length < 120 || c.includes("\n")) return null;
  const literals = (c.match(/\\n/g) || []).length;
  if (literals < 3) return null;
  return `[rejected] That write_file content is one single line of ${c.length} characters containing ${literals} literal backslash-n sequences and ZERO real newlines — your JSON string escaping is doubled (you emitted \\\\n where you meant a newline). The file was NOT written. Re-emit the write_file with the same code but ACTUAL newlines in the JSON string (single \\n escapes), and it will be written correctly.`;
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
  enabledActionDefinitions,
  FILE_OPS_FEATURE,
  PATCH_ACTION_FEATURE,
  LINE_EDIT_FEATURE,
} from "./action-protocol.js";
import { decidePatchAction } from "./patch-policy.js";
import { decideFileOperations } from "./file-op-policy.js";
import { parseAction } from "./actions.js";
import { editMadeNoChange, editPaths, editSucceeded, isEditAction, turnEditApplied } from "./edit-actions.js";
import { blastRadiusNote, dependentsOf } from "./logic/blast-radius.js";
import { deriveThinkPrefills, shouldThink } from "./thinking.js";
import { loadLibrary, retrieveSkills, formatSkills, distillSkill, saveSkill, promotePlanToSkill } from "./skills.js";
import { makePlan, formatPlan, isStuck, rePlan } from "./plan.js";
import { staticCheck } from "./pregate.js";
import { OutcomeCycleTracker, repeatedFailureDiagnostic, repeatedEditFailureDiagnostic, missingCapabilityHint } from "./failure-diagnostics.js";
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
  STATE_AUDIT_DEFERRAL,
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
import { forgetOpenFile, fullyRenderedPaths, noteOpenFile, renderOpenFiles, renderedOpenPaths } from "./open-files.js";
import { evaluateDoneGates } from "./done-gates.js";
import { taskRequiresVisualPreview } from "./logic/preview-evidence.js";
import { deliveryFor, BLOCK, WARN } from "./gate-policy.js";
import { promptVersion } from "./prompt-rules.js";
import { asyncAssertionGuard } from "./async-test-guard.js";
import { extractImmutable, immutableViolations } from "./logic/self-check.js";
import { buildGrounding, codeMap, groundAction, refreshGrounding } from "./logic/grounding.js";
import { scopedVerifyPlan } from "./logic/scoped-verify.js";
import { buildToolRegistry, historyTool } from "./logic/tools.js";
import { recordTurns, repositoryQueryTool, stateAsOf } from "./logic/runlog.js";
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
  shouldNudgeProgress,
  snapshotWorkspaceFiles,
  workspaceFileChanges,
} from "./progress-awareness.js";
import { RepetitionGuard } from "./repetition.js";
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
const WRAP_UP_NOTE = "[wrap up] You have gathered enough context — reading and shell are disabled now. Answer the user directly with a `respond` action using what you have already seen, or make the edit they asked for. Do not say you need to look at more files.";
// Autonomous (eval/benchmark) analog: a build task has no user to answer — the model must EDIT. Used
// when the autonomous force-edit mask fires after too many progressless recon turns.
const AUTO_EDIT_NOTE = "[commit] You have investigated enough — reading and shell are now disabled. Write your first real implementation NOW with write_file or replace, using the current file shown in <open_files> below. A rough first version is progress: make the edit, then run the tests and iterate on the failures. Do NOT respond with a plan or say you need to read more.";
// Source-code extensions. A shell command that rewrites one of these (and isn't touching generated
// output) is a real code edit the completion gates must account for — see the shell-mutation guard.
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql)$/i;
// verify_red done-gate: red bounces before a done is accepted as-is. Three gives
// a model that keeps insisting two more looks at the failing output; past that,
// bouncing only burns the remaining turns on a claim the grade will refute anyway.
const VERIFY_DONE_GATE_MAX = 3;

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

export async function runAgent(options = {}) {
  const model = options.model ?? new ModelClient();
  const runToken = model.beginAgentRun?.() ?? null;
  try {
    return await runAgentCore({ ...options, model });
  } finally {
    model.endAgentRun?.(runToken);
  }
}

async function runAgentCore({
  task,
  workspace,
  model = new ModelClient(),
  maxTurns = 30,
  maxInvalidPerTurn = 3,
  verificationScript = null,
  // Evaluators grade the final tree unconditionally. Interactive callers can
  // select after_edit so questions do not pay for a project-wide verifier.
  verificationPolicy = "always", // "always" | "after_edit"
  verificationTimeoutMs = positiveInt(process.env.BANTAM_VERIFY_TIMEOUT_MS, 120000),
  // Re-run a passing terminal verify once to catch a flaky/nondeterministic green (off by default —
  // it doubles the passing-verify cost; enable with BANTAM_FLAKY_VERIFY=1 on flaky-prone suites).
  flakyVerify = envTruthy(process.env.BANTAM_FLAKY_VERIFY),
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
  dockerImage = undefined,
  readOnlyWorkspacePaths = null,
  verificationWorkspaceReadOnly = false,
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
  thinkMode = "off",       // "off" | "auto" | "always"
  thinkNPredict = positiveInt(process.env.BANTAM_THINK_N_PREDICT, 4096),
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
  // Candidate: once a run is a few turns deep, restate the objective in the cache-safe volatile slot
  // so a long, multi-requirement task does not drift out of focus (lost-in-the-middle). A paired A/B
  // (docs/superpowers/reports/2026-07-11-goal-reanchor.md) was INCONCLUSIVE — the fixture suite is at
  // ceiling and could not discriminate it — so it stays off by default; enable with
  // BANTAM_GOAL_REANCHOR=1, tune the threshold with BANTAM_GOAL_REANCHOR_AFTER (default 3).
  goalReanchor = envTruthy(process.env.BANTAM_GOAL_REANCHOR),
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
  // After the first green test following an edit, ask for one explicit requirement-to-code audit.
  // A paired cohort preserved 8/8 strict passes and improved unseen checks from 8/18 to 14/18.
  completionAudit = completionAuditEnabled(undefined, { codex: model?.codex === true }),
  visualCompletionAudit = visualCompletionAuditEnabled(),
  // Reinterpret only task-named accepted string languages at the post-green
  // boundary. Exact-turn replay improved 0/3 -> 3/3 and a rotated full-task
  // GPT-5.5 trial improved 0/2 -> 2/2 while reducing turns and requests.
  lexicalContractAudit = lexicalContractAuditEnabled(),
  // Candidate: after an authored HTML alt, compare only against explicit
  // Moon/Birds sections already present in saved view_image evidence.
  visualAltCoverage = visualAltCoverageEnabled(),
  // Specialize the post-green audit for high-confidence concurrent lifecycle
  // tasks. Conservative auto-selection is the production default; explicit
  // BANTAM_STATE_AUDIT=0/off remains the rollback.
  stateAudit = process.env.BANTAM_STATE_AUDIT ?? "auto",
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
  const lineEditEnabled = /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_LINE_EDIT ?? ""));
  const baseActionFeatures = [
    ...(lineEditEnabled ? [LINE_EDIT_FEATURE] : []),
    ...(patchActionPolicy.enabled ? [PATCH_ACTION_FEATURE] : []),
    ...(fileOperationPolicy.enabled ? [FILE_OPS_FEATURE] : []),
  ];
  // Is this a "build/create something" request (vs a question or a small edit)? On these the
  // deliverable is running code, so a plan-only answer before any file exists is premature —
  // the build-first guard below pushes the model to start writing instead of describing.
  const buildRequest = interactive && !advisoryMode
    && /\b(build|create|implement|rebuild|remake|recreate|scaffold|port|generate|make)\b/i.test(String(task))
    && !/^\s*(what|why|how|is|are|should|could|can|do|does|where|when|which|who)\b/i.test(String(task).trim());
  let buildRespondRejections = 0;
  const exec = new Executor(workspace, {
    noopEditGuard,
    shellSandbox,
    shellNetwork,
    dockerImage,
    readOnlyWorkspacePaths,
    shellEnvOverrides,
    processRunner: shellProcessRunner,
    onShellOutput: ({ stream, text }) => onEvent({ type: "shell_output", stream, text }),
  });
  // Self-check arm phase: snapshot instruction-named immutable files BEFORE the first write, so
  // the done-gate can prove they are untouched. Off (mode "none") for tasks that name none.
  const immutableInv = extractImmutable(task);
  const immutableSnap = immutableInv.mode !== "none" ? immutableViolations.snapshot(workspace, immutableInv) : null;
  // Symbolic grounding context (datalog KB of the workspace). `true` => build it now.
  const ground = grounding === true ? buildGrounding(workspace) : (grounding || null);
  const visualTask = taskRequiresVisualPreview(task);
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
      ? `\nA live \`map brief\` is already supplied in the repository context below. Do not query \`brief\` or \`arch\` again; use a targeted map query only when you need a specific flow, caller, symbol, or impact.\nFor feature analysis, the tool menu above is authoritative current capability: do not propose a listed tool (including \`concept\` meaning search) as missing. Do not invent percentages or benchmark claims; use a number only when repository evidence supplied it.`
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
  let env = safeListing(workspace);
  if (map) env = `${map}\n\n${env}`;
  const thinkP = deriveThinkPrefills(model.assistantPrefill, model.thinkMarkers);
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
        ...(t.sourceEditedByShell === true ? { sourceEditedByShell: true } : {}),
        ...(Array.isArray(t.shellChangedPaths) ? { shellChangedPaths: t.shellChangedPaths.slice() } : {}),
        ...(t.shellScopeRollback ? { shellScopeRollback: structuredClone(t.shellScopeRollback) } : {}),
        ...(t.scopedVerify ? { scopedVerify: t.scopedVerify } : {}),
        ...(t.environmentVerification ? { environmentVerification: t.environmentVerification } : {}),
        ...(t.preview ? { preview: t.preview } : {}),
        ...(t.stateAudit ? { stateAudit: { ...t.stateAudit } } : {}),
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
  let recentReads = [];    // exact seams recently inspected; edited files still take priority
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
    for (const readPath of successfulReadPaths(turn)) {
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
  const metrics = {
    turns: 0,
    invalid: 0,
    outputLimitRecoveries: 0,
    protocolViolations: 0,
    thinkPhases: 0,
    emptyThinkDisables: 0,
    emptyThinkTransients: 0,
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
    fileOperationPolicy,
    verificationPolicy,
    verificationTriggered: false,
    workspaceChanged: false,
    externalWorkspaceMutationEvents: 0,
    externalWorkspaceMutationPaths: 0,
    externalWorkspaceMutationBlockedActions: 0,
    repeatedFailureHints: 0,
    outcomeCycleEvents: 0,
    outcomeCycleHints: 0,
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
  const visitedPaths = new Set(); // files the model actually opened or edited (sibling-definition done-gate)
  const editedSymbolSites = new Map(); // symbol -> file of the model's own edit (sibling-definition done-gate)
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
  let revertsOfThisSnapshot = 0; // stand-down counter: the guard must not suppress repeated repair attempts
  let editsSinceBestSnapshot = 0; // no edits since the snapshot => a lower count is FLAKE, not regression
  let bestCommand = null;         // counts from a DIFFERENT test command are not comparable
  const failStreak = new Map();   // failing test name -> consecutive verifications it has failed
  const diagnosed = new Map();    // stuck test name -> failStreak value at its last diagnostic call
  const teacherEscalated = new Set(); // stuck test names already escalated to the teacher (fire once each)
  let lastInteractiveNudge = 0;
  // Recon allowances scale with repo size (env overrides always win): the
  // fixture-tuned floors push toward editing before a large codebase's seams
  // have been located. workspaceSourceFiles is computed once at loop setup.
  const interactiveReconLimit = process.env.BANTAM_INTERACTIVE_RECON_LIMIT !== undefined
    ? positiveInt(process.env.BANTAM_INTERACTIVE_RECON_LIMIT, 14)
    // A seeded repository brief has already paid for whole-tree discovery.
    // Six targeted follow-ups are enough to check the proposed seam; applying
    // the ordinary large-repo allowance here recreated the 30+ turn analysis
    // spiral the automatic brief exists to remove.
    : (automaticRepositoryBriefEnabled ? 6 : scaledReconLimit(14, workspaceSourceFiles));
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
  const repetition = new RepetitionGuard({ enabled: dedupeActions, dedupeShell, dedupeQuery });
  const readLedger = new ReadLedger();  // union of line ranges already read, per file
  for (const turn of turns) restoreReadLedgerTurn(readLedger, turn);
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
  const outcomeCycles = new OutcomeCycleTracker();
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
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const prior = turns[i];
    if (turnEditApplied(prior)) break;
    if (String(prior?.observation ?? "").includes("[edit-recovery]")) {
      editRecoveryPath = editPaths(prior.action || prior.parsedAction).at(-1) ?? null;
      break;
    }
  }
  let workspaceChangedDuringRun = false;
  const knownArtifacts = new Set(extractTaskOutputPaths(task));
  // Rewind restores controller obligations as well as transcript prose. A
  // post-green document audit must still require its revision when execution
  // resumes at that exact decision point.
  for (const turn of turns) {
    const prior = turn?.action;
    const changedPaths = [
      ...(turnEditApplied(turn) ? editPaths(prior) : []),
      ...(Array.isArray(turn?.shellChangedPaths) ? turn.shellChangedPaths : []),
    ];
    if (changedPaths.length) workspaceChangedDuringRun = true;
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
  artifactNeedsVerification = nonDocumentArtifactNeedsVerification || pendingDocumentArtifacts.size > 0;
  let lastEditRegion = null;  // {path, start, lines} — where the last edit_lines landed
  const deliverable = deliverableCommand(task);   // the command the task asks us to BUILD
  let ranDeliverable = false;

  let smokeNudged = false;
  let editCount = 0;
  // History is evidence, not a second repository copy. Current seams live in
  // the bounded file panel below; keeping the entire old 180KB transcript made
  // the useful fact progressively harder for a small model to see.
  const historyCharBudget = positiveInt(process.env.BANTAM_HISTORY_CHAR_BUDGET, 36000);
  // Turn-level replay capture: with BANTAM_SAVE_PROMPTS=1 every turn records
  // its exact assembled prompt, so `bantam replay <artifact> --turn N` can
  // rewind to the precise moment of a failure and test context adjustments.
  const savePrompts = /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_SAVE_PROMPTS ?? ""));
  let lastPromptForTurn = null;
  const capTurns = (h) => budgetTurns(
    Number.isFinite(historyCap) ? h.slice(-Math.max(1, historyCap)) : h,
    { charBudget: historyCharBudget },
  );
  const safeComplete = async (makePrompt, completeOpts) => {
    for (let shrink = 0; shrink < 8; shrink++) {
      try {
        return await model.complete(makePrompt(), signal ? { ...completeOpts, signal } : completeOpts);
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
      if (groundingMap) map = codeMap(ground);
    }
    const listing = safeListing(workspace);
    env = map ? `${map}\n\n${listing}` : listing;
    onEvent({ type: "external_workspace_change", phase, paths: changed });
    return changed;
  };

  while (turns.length < maxTurns && !done && !interrupted) {
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
        turns.push({ action: null, observation: `[The user interjected while you were working — take this into account and adjust course now]: ${m}` });
        onEvent({ type: "injection", message: m });
      }
    }
    onEvent({ type: "turn_start", turn: metrics.turns });
    detectExternalWorkspaceChanges("turn_start");
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
    const autoForceEdit = !interactive && useGrammar && progressAwareness
      && autoForceEditAfter > 0 && progresslessTurns >= autoForceEditAfter;
    // A hard duplicate spiral (the SAME action deduped 3+ times in a row) engages the wrap-up mask
    // immediately — text steering escalated 13 times without effect in the observed case, and each
    // ignored repeat costs a full model call.
    // The 3-bounce duplicate breaker applies in BOTH modes: the autonomous
    // self-hosting runs looped on deduped repeats with the breaker gated
    // interactive-only (v2: 15 bounces; v3: 10 subrange re-reads).
    const forceWrapUp = (useGrammar && consecutiveDuplicates >= 3)
      || (interactive && useGrammar && interactiveReconStreak >= interactiveReconLimit)
      || (useGrammar && callerInvestigationActionLimit !== null
        && investigationActionCount >= callerInvestigationActionLimit)
      || autoForceEdit;
    // Compose every active per-turn mask into one exclusion set (turn-mask.js). The composition is
    // pure and unit-tested there; the anti-trap invariant that keeps read_file available on
    // document-only turns lives there too, so a co-active wrap-up mask can no longer re-exclude it.
    const requestedExclusions = composeExcludeVerbs({
      useGrammar,
      baseExcludeVerbs: callerExcludedActions,
      forceWrapUp,
      forceBuildEdit,
      documentRevisionTurn,
      documentReviewTurn,
      lineEditRecoveryTurn,
      maskedVerbForTurn,
      patchEnabled: patchActionPolicy.enabled,
    });
    // Caller policy is expressed against the complete protocol so dynamically
    // enabled verbs (patch/edit_lines/file ops) cannot escape it. Grammar/schema
    // generation is stricter: it rejects exclusions for verbs that are not
    // enabled on this exact turn. Intersect only for schema construction; the
    // full callerExcludedActions list still guards parsed actions at execution.
    const enabledTurnVerbs = new Set(
      enabledActionDefinitions({ features: turnActionFeatures })
        .map((definition) => definition.verb),
    );
    const excludeThisTurn = requestedExclusions.filter((verb) => enabledTurnVerbs.has(verb));
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
    // One context panel owns current source truth. Keep edited files first, then
    // the most recent inspected seams, so locating a dispatch/parser/result
    // connection once does not vanish into transcript history before it is wired.
    const contextOpenList = [...new Set([...openList, ...recentReads])].slice(0, 4);
    const panelOptions = { focusByPath, mutationFocusByPath };
    const temporalState = stateAsOf(recordTurns(turns), turns.length);
    const repositoryState = tools?.get("map") ? temporalState.repositoryQuery : null;
    const workingNoteReanchor = formatWorkingNoteReanchor(temporalState);
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
    const openFilesText = compileContextPacket({
      repository: repositoryText,
      blocker: lociText,
      ledger: ledgerText,
      renderSource: openFilesView
        ? (maxBytes) => renderOpenFiles(workspace, contextOpenList, { ...panelOptions, maxBytes })
        : null,
    });
    const openPaths = openFilesView ? renderedOpenPaths(workspace, contextOpenList, panelOptions) : [];
    const completeReadPaths = openFilesView
      ? [...fullyRenderedPaths(workspace, contextOpenList, panelOptions).keys()]
      : [];

    for (let attempt = 0; attempt <= maxInvalidPerTurn; attempt++) {
      const historyForPrompt = repairObs
        ? [...turns, { observation: repairObs }]
        : (forceWrapUp ? [...turns, { observation: autoForceEdit ? AUTO_EDIT_NOTE : WRAP_UP_NOTE }] : turns);

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
      const documentRevisionReanchor = documentRevisionTurn && revisionGaps.length
        ? [
            "DOCUMENT REVISION RECOVERY: close the explicit audited gaps below in the pending document now.",
            "Use edit_lines with the visible start/end line numbers for a bounded correction, or one intentional write_file rewrite when the gaps span the document. Exact-match replace is unavailable at this checkpoint.",
            "If the exact current bytes are clipped or stale, use read_file on that document once; otherwise edit it now.",
            "Do not inspect unrelated files, polish unrelated prose, or change bytes without reducing this list.",
            ...revisionGaps.map((gap) => `- ${gap}`),
          ].join("\n")
        : "";
      const editRecoveryReanchor = lineEditRecoveryTurn
        ? [
            `EDIT RECOVERY ACTIVE: repeated exact-match edits to ${editRecoveryPath} failed even though the semantic fix is known.`,
            "Do not reconstruct old text. Use edit_lines with line numbers from the current file panel, or use one intentional write_file rewrite if the correction spans multiple sections.",
            "This recovery stays active until a real edit lands.",
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
      const finalDecisionReanchor = [documentReviewCompleteReanchor, previewFailureReanchor]
        .filter(Boolean)
        .join("\n\n");
      const decHintText = decHint
        ? `[integrated-decider] Recommended next action: ${decHint.action} (strategy: ${decHint.strategy}, score: ${decHint.score.toFixed(2)}${decHint.plan ? `, plan-ahead: ${decHint.plan.join(' → ')}` : ''})`
        : "";
      const externalMutationReanchor = pendingExternalChanges.size
        ? [
            "EXTERNAL WORKSPACE CHANGE: files BANTAM previously read changed outside this agent.",
            "The current disk and <open_files> panel are authoritative; earlier read observations, test proofs, and edit assumptions for these paths are stale.",
            "Re-read a clipped changed path before editing it. If its current contents are fully visible, act from those exact bytes. Never overwrite it from remembered text.",
            ...[...pendingExternalChanges].map((changedPath) => `- ${changedPath}`),
          ].join("\n")
        : "";
      const reanchorText = [baseReanchor, documentDraftReanchor, postGreenReanchor, documentRevisionReanchor, editRecoveryReanchor, documentReviewReanchor, externalMutationReanchor, workingNoteReanchor, decHintText]
        .filter(Boolean)
        .join("\n\n");

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
      const immutableHistory = envTruthy(process.env.BANTAM_IMMUTABLE_HISTORY);

      // Optional thinking phase: at critical moments, reason in an open <think>
      // block first, then seal it and generate the grammar-constrained action.
      let assistantPrefill = model.assistantPrefill;
      let turnReasoning = null;
      if (thinkingAvailable && shouldThink(thinkMode, { turnIndex: turns.length, lastObservation: prevObs, lastWasInvalid: attempt > 0 })) {
        onEvent({ type: "activity", label: "thinking" });
        const thought = await safeComplete(
          () => buildPrompt({ task, env, turns: capTurns(historyForPrompt), assistantPrefill: thinkP.openThink, historyPrefill: model.historyPrefill, skillsText, planText, reanchorText, finalReanchorText: finalDecisionReanchor, openFilesText, openPaths, readPaths: completeReadPaths, interactive, toolsText, actionFeatures: turnActionFeatures, unslimPaths: echoedPaths, repoContextTurn: repositoryTurnId, repoContextQuery: repositoryText ? repositoryState?.query : "", template: promptTemplate, thinkEnabled, slimSuccessfulShellActions: successfulShellReplaySlim, immutableHistory, everSlimmedPaths }),
          { stop: [...thinkP.stop, ...model.stop], nPredict: thinkNPredict,
            codexAdaptiveRebase: !completionAuditEmitted,
            ...(interactive ? { onProgress: (p) => onEvent({ type: "activity", label: "thinking", detail: `${p.tokens} tokens` }) } : {}) }
        );
        if (interrupted) break;
        if (thought) {
          metrics.tokens += thought.tokens;
          metrics.thinkTokens += thought.tokens;
          // Gemma writes its own `<|channel>thought` opener in phase 1; strip it
          // so only the reasoning itself is sealed into the closed block.
          turnReasoning = thinkP.cleanReasoning(thought.content);
          if (turnReasoning) {
            thinkingProven = true;
            metrics.thinkPhases++;
            onEvent({ type: "thinking", text: turnReasoning });
            assistantPrefill = thinkP.closeThink(turnReasoning);
          } else if (!thinkingProven) {
            // An empty first probe means this profile/model is not supplying a
            // usable think block. Stop paying for a capability it has not shown.
            thinkingAvailable = false;
            metrics.emptyThinkDisables++;
            onEvent({ type: "thinking_disabled", reason: "empty_completion" });
          } else {
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
          const built = buildPrompt({ task, env, turns: capTurns(historyForPrompt), assistantPrefill, historyPrefill: model.historyPrefill, skillsText, planText, reanchorText, finalReanchorText: finalDecisionReanchor, openFilesText, openPaths, readPaths: completeReadPaths, interactive, toolsText, actionFeatures: turnActionFeatures, unslimPaths: echoedPaths, repoContextTurn: repositoryTurnId, repoContextQuery: repositoryText ? repositoryState?.query : "", template: promptTemplate, thinkEnabled, slimSuccessfulShellActions: successfulShellReplaySlim, immutableHistory, everSlimmedPaths });
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
          ...(interactive ? { onProgress: (p) => onEvent({ type: "activity", label: "generating", detail: describePartialAction(p) }) } : {}),
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

      const parsed = parseAction(out.content);
      if (parsed.ok) {
        const normalizedAction = normalizeWorkspaceAction(parsed.action);
        if (callerExcludedActions.includes(normalizedAction.a)) {
          metrics.invalid++;
          const error = `Action "${normalizedAction.a}" is disabled by the caller policy.`;
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
      });
      if (outputLimit) {
        metrics.outputLimitRecoveries++;
        const subject = target ? ` for \`${target}\`` : "";
        repairObs = [
          `[output-limit] Your previous ${parsed.partialAction?.action || "action"}${subject} reached the model's output limit before its JSON object could close.`,
          "Do NOT regenerate the same monolithic action: it will hit the same fixed limit again.",
          "Emit one much smaller valid action now. For a large new program, write a compact runnable skeleton first, split substantial code into multiple files/modules, then extend it with bounded replace/edit_lines/patch actions.",
          "Keep this next action comfortably below the limit (roughly 2,000 output tokens).",
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
    let progressGate = progressAwareness
      ? progressGateFor(action, {
          progresslessTurns,
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
      || action.a === "search" || action.a === "inspect" || action.a === "shell" || action.a === "query";
    if (!gateRejection && investigativeAction) investigationActionCount++;
    const interactiveStop = (interactive && !gateRejection && investigativeAction
      && interactiveReconStreak >= interactiveReconLimit)
      ? "[investigation budget reached] You have investigated enough. Do NOT read files or run more commands. If the user asked a QUESTION, your next action must be \"respond\" with your answer. If they asked you to BUILD/CREATE/CHANGE something, do NOT respond with a plan — START WRITING it NOW with write_file (or replace); build the first runnable slice and keep going."
      : null;
    const beforeShellFiles = !gateRejection && !interactiveStop && action.a === "shell" ? snapshotWorkspaceFiles(workspace) : null;
    const shellScopeSnapshot = !gateRejection && !interactiveStop && action.a === "shell"
      && shellScopeGuard && typeof shellScopeGuard.capture === "function"
      ? shellScopeGuard.capture()
      : null;
    // Grounding: reject a read/edit of a file that provably doesn't exist, before it executes.
    const groundReject = ground ? groundAction(ground, action) : null;
    // Reject an edit that copies the history-slimming placeholder into a real file (would destroy it).
    const placeholderEcho = !gateRejection && !interactiveStop ? editEchoesPlaceholder(action) : null;
    // Reject a whole-file write with double-escaped newlines (once per path — a precise steer beats
    // letting the model burn its budget rediscovering the corruption byte-by-byte).
    const doubleEscape = !gateRejection && !interactiveStop && !placeholderEcho
      && !doubleEscapeWarned.has(action?.p) ? editDoubleEscapesNewlines(action) : null;
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
    const duplicate = !gateRejection && !interactiveStop && !groundReject
      && requestedDocumentReviews.length === 0
      ? repetition.check(action)
      : null;
    let panelRedirect = null;
    if (!duplicate && requestedDocumentReviews.length === 0
        && openFilesView && !gateRejection && !interactiveStop && !groundReject) {
      const complete = fullyRenderedPaths(workspace, contextOpenList, panelOptions);
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
      const targets = action.a === "read_file" && typeof action.p === "string" && !isNarrow(action)
        ? [action.p]
        : (action.a === "inspect" && Array.isArray(action.ops)
          ? action.ops.filter((op) => op?.a === "read_file" && typeof op.p === "string" && !isNarrow(op)).map((op) => op.p)
          : []);
      if (targets.length && targets.every((t) => complete.has(t))) {
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
      && inspectFullyInLedger(action, readLedger)
      ? ledgerReplayMessage(action, openFilesView)
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
      result = { observation: artifactGateTermination, done: true, summary: "Stopped by artifact verification gate; grading current workspace state." };
    } else if (progressGateTermination) {
      result = { observation: progressGateTermination, done: true, summary: "Stopped by progress gate; grading current workspace state." };
    } else if (interactiveStop) {
      consecutiveInteractiveStops++;
      if (consecutiveInteractiveStops >= interactiveStopMax) {
        // The model has ignored the investigation stop repeatedly. Hard-terminate so an
        // interactive session can't spin until maxTurns; hand control back to the user.
        metrics.interactiveStopTerminations++;
        result = { observation: interactiveStop, done: true, summary: "Stopped: I kept investigating after being asked to wrap up. Re-steer with a more specific instruction, or say \"keep going\"." };
        onEvent({ type: "interactive_budget_terminated", action, stops: consecutiveInteractiveStops });
      } else {
        result = { observation: interactiveStop };
        onEvent({ type: "interactive_budget", action });
      }
    } else if (gateRejection) {
      result = { observation: gateRejection };
    } else if (duplicate) {
      result = { observation: duplicate.observation };
      metrics.duplicateActionRejections = repetition.duplicateActionRejections;
      metrics.duplicateShellRejections = repetition.duplicateShellRejections;
      // The exact action is deterministic against this unchanged workspace, so
      // permitting the same verb immediately again only buys another API call.
      // Replay of the self-host failure's exact prompt changed a third identical
      // read into a targeted symbol search when read_file was masked.
      if (useGrammar) nextMaskedVerb = action.a;
      onEvent({ type: "duplicate_action", action, duplicateOfTurn: duplicate.duplicateOfTurn, message: duplicate.observation });
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
      doubleEscapeWarned.add(action?.p);
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
        result = await exec.execute(action, { signal });
      }
    }
    if (panelRedirect) {
      result = { observation: panelRedirect };
      insideLedgerReread = true;   // counts toward the duplicate breaker
      metrics.panelRedirects = (metrics.panelRedirects ?? 0) + 1;
      onEvent({ type: "panel_redirect", action, message: panelRedirect });
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
        ...(stateAuditIssued ? { stateAudit: stateAuditSnapshot() } : {}),
        rawObservation: null,
        tookMs: nowMs() - turnStart,
        ...(modelCallIndex !== null ? { modelCallIndex } : {}),
        ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
      });
      metrics.turns++;
      onEvent({ type: "observation", observation: result.observation, rawObservation: null });
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
    const directEditSucceeded = !gateRejection && !interactiveStop && !duplicate && !groundReject
      && editSucceeded(action, result.observation);
    const directEditPaths = directEditSucceeded ? editPaths(action) : [];
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
      const peer = peerFunctionFooter({ ground, action, editedFile, seen: impactSymbolsSeen });
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
    if (directEditSucceeded) editCount += 1;
    if (action.a === "shell" && invokesCommand(action.c, deliverable)) ranDeliverable = true;
    // Built it, never ran it: a green suite is not evidence that the COMMAND works.
    if (deliverable && !ranDeliverable && !smokeNudged && editCount >= 4) {
      result.observation += smokeNudge(deliverable, editCount);
      smokeNudged = true;
      metrics.smokeNudges = (metrics.smokeNudges ?? 0) + 1;
      onEvent({ type: "smoke_nudge", deliverable, edits: editCount });
    }
    if (directEditSucceeded || shellChangedWorkspace) {
      workspaceChangedDuringRun = true;
      workspaceEditGeneration++;
      if (previewFailureSequence) {
        previewFailureSequence = notePreviewFailureEdit(previewFailureSequence);
      }
      environmentVerificationProof = null;
      metrics.workspaceChanged = true;
      editsSinceBestSnapshot += 1;   // the regression guard only judges runs that follow an edit
      outcomeCycles.noteWorkspaceChanged();
    }
    if (editRecoveryPath && directEditSucceeded && directEditPaths.includes(editRecoveryPath)) {
      onEvent({ type: "edit_recovery_completed", path: editRecoveryPath, action: action.a });
      editRecoveryPath = null;
    }
    const groundingChangedPaths = [
      ...directEditPaths,
      ...shellChangedPaths,
    ];
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
          env = map ? `${map}\n\n${listing}` : listing;
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
      if (activeArtifactGateRejection) {
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
    if (readExecuted && action.a === "read_file" && typeof action.p === "string"
        && !String(result.observation ?? "").startsWith("ERROR:")) {
      recentReads = noteOpenFile(recentReads, action.p);
      noteInspectedPath(action.p);
      rememberReadFocus(action, result.observation);
      const readPath = normalizeWorkspaceRel(action.p);
      workspaceCoherence.watch(readPath);
      pendingExternalChanges.delete(readPath);
    } else if (readExecuted && action.a === "inspect" && Array.isArray(action.ops)) {
      for (const op of action.ops) {
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
      if (pages === 3 && totalLines && Number(totalLines[1]) > 400) {
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
      const shown = /\(\d+ lines, showing (\d+)-(\d+)\)/.exec(String(result.observation ?? ""));
      if (shown) {
        insideLedgerReread = readLedger.covers(action.p, Number(shown[1]), Number(shown[2]));
        readLedger.note(action.p, Number(shown[1]), Number(shown[2]));
      }
    } else if (!ledgerReplay && action.a === "inspect" && Array.isArray(action.ops)) {
      // Inspect wraps reads as sub-ops; without this the model can loop
      // through inspect variants the ledger never sees (observed: v5 climbed
      // to 8 bounces alternating inspects while the streak counter reset).
      // Skipped on a ledger veto: nothing was read, so there is no new range to
      // note, and allCovered=false must not clobber the veto's insideLedgerReread.
      const obsText = String(result.observation ?? "");
      const readOps = action.ops.filter((op) => op?.a === "read_file" && typeof op.p === "string");
      let allCovered = readOps.length > 0;
      for (const op of readOps) {
        const escaped = op.p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const shown = new RegExp(`${escaped} \\(\\d+ lines, showing (\\d+)-(\\d+)\\)`).exec(obsText);
        if (!shown) { allCovered = false; continue; }
        if (!readLedger.covers(op.p, Number(shown[1]), Number(shown[2]))) allCovered = false;
        readLedger.note(op.p, Number(shown[1]), Number(shown[2]));
      }
      insideLedgerReread = allCovered;
    }
    for (const editedPath of directEditPaths) readLedger.invalidate(editedPath);
    for (const changedPath of shellChangedPaths) readLedger.invalidate(changedPath);
    if (action.a === "delete_file" || action.a === "move_file") {
      readLedger.invalidate(action.p ?? action.from);
    }
    if (action.a === "replace") recordReplaceFailure(metrics, result.observation);
    if (action.a === "patch") recordPatchFailure(metrics, result.observation);
    if (action.a === "delete_file" || action.a === "move_file") {
      recordFileOperationFailure(metrics, action, result.observation);
    }
    if (editMadeNoChange(action, result.observation)) {
      metrics.noOpEdits++;
      if (useGrammar) nextMaskedVerb = action.a;
      onEvent({ type: "no_op_edit", action, message: result.observation });
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
    const editRecovery = repeatedEditFailureDiagnostic(turns, action, result.observation);
    if (editRecovery) {
      result.observation += editRecovery;
      metrics.editRecoveryHints = (metrics.editRecoveryHints ?? 0) + 1;
      editRecoveryPath = editPaths(action).at(-1) ?? editRecoveryPath;
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
    if (typeof observationTransform === "function") {
      const original = String(result.observation ?? "");
      const transformed = String(observationTransform(original, { action, workspace }) ?? "");
      if (transformed !== original) {
        rawObservation = original;
        result.observation = transformed;
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
          result.observation = `${STATE_AUDIT_DEFERRAL}${formatStateAuditRisks(currentRisks)}`;
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
          const verdict = r.timedOut ? "TIMED OUT" : (r.code === 0 ? "PASS" : "FAIL");
          const out = clip(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
          result.observation += `\n[scoped-verify] ${verdict} — ran the ${plan.tests.length} test(s) your edit affects (${plan.command}):\n${out}`;
          // Provenance stamp: the HARNESS ran these tests, so the verdict is trusted and unspoofable —
          // the model authors observation text but can never set a turn field. The done-gates honor
          // this stamp (a same-turn verification of the edit). A timeout is inconclusive -> no stamp.
          if (!r.timedOut) result.scopedVerify = { verdict: r.code === 0 ? "pass" : "fail", command: plan.command, tests: plan.tests };
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
    if (action.a === "shell" && isDeliverableRun(action.c)) { blindEditStreak = 0; probeStreak = 0; turnsSinceVerify = 0; }
    else if (result.scopedVerify) { blindEditStreak = 0; probeStreak = 0; turnsSinceVerify = 0; } // scoped verify already gave feedback
    else if (directEditSucceeded) blindEditStreak += 1;
    // Inline-eval probes (`python -c`, `node -e`) are NOT verification — they
    // test the cases the model already thought of. A streak of them without a
    // suite run trips the same breaker (swb2-sympy-rational, 2026-07-17:
    // 13 probes, zero suite runs, red baseline suite at the turn cap).
    else if (action.a === "shell" && !gateRejection && isInlineEvalProbe(action.c)) probeStreak += 1;
    turnsSinceVerify += 1; // counts every turn; only matters once an unverified edit exists
    const blindTrigger = autoVerifyBlindEdits > 0 && blindEditStreak >= autoVerifyBlindEdits;
    const probeTrigger = autoVerifyProbes > 0 && probeStreak >= autoVerifyProbes;
    // Staleness trigger: unverified edits exist (blindEditStreak > 0) and the
    // verify has not run in autoVerifyStaleTurns turns — catches the read-heavy
    // spiral the consecutive-edit streak cannot see.
    const staleTrigger = autoVerifyStaleTurns > 0 && blindEditStreak > 0 && turnsSinceVerify >= autoVerifyStaleTurns;
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
        const verdict = r.timedOut ? "TIMED OUT" : (r.code === 0 ? "PASS" : "FAIL");
        const out = clip(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
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
        result.observation += `\n[auto-verify] ${reason}, so I ran them for you — ${verdict}:\n${out}\n${close}`;
        if (!r.timedOut) result.scopedVerify = { verdict: r.code === 0 ? "pass" : "fail", command: verificationScript, tests: [] };
        metrics.autoVerifies = (metrics.autoVerifies ?? 0) + 1;
        onEvent({ type: "auto_verify", command: verificationScript, verdict, streak: blindTrigger ? blindEditStreak : (staleTrigger ? turnsSinceVerify : probeStreak), trigger: blindTrigger ? "edits" : (staleTrigger && !probeTrigger ? "stale" : "probes") });
        blindEditStreak = 0;
        probeStreak = 0;
        turnsSinceVerify = 0;
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
      },
      task,
      visualAudit: visualCompletionAudit,
      lexicalAudit: lexicalContractAudit,
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
    const landingWindow = Math.max(3, Math.round(maxTurns * 0.1));
    if (!interactive && !result.done && !interrupted && turnsRemaining >= 0 && turnsRemaining <= landingWindow) {
      let landingNote = `\n[budget] ${turnsRemaining} turn${turnsRemaining === 1 ? "" : "s"} left after this one.`;
      if (turnsRemaining <= 2 && verificationScript) {
        const cached = doneVerificationProof
          && doneVerificationProof.generation === workspaceEditGeneration
          && doneVerificationProof.command === verificationScript
          ? doneVerificationProof.verification
          : null;
        let proof = cached;
        if (!proof) {
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
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript, verification: proof };
          metrics.landingVerifies = (metrics.landingVerifies ?? 0) + 1;
        }
        // A landing verify is real regression evidence. If the model reached a
        // fully green snapshot, edited again, and spent its last turn without
        // re-verifying, preserve the known-good work instead of ending red.
        const landingRegression = proof.status !== "pass"
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
            metrics.regressionReverts = (metrics.regressionReverts ?? 0) + 1;
            metrics.landingReverts = (metrics.landingReverts ?? 0) + 1;
            revertsOfThisSnapshot += 1;
            editsSinceBestSnapshot = 0;
            // The failed proof described the pre-restore generation.
            workspaceEditGeneration++;
            doneVerificationProof = null;
            onEvent({
              type: "landing_revert",
              from: bestPassed,
              to: 0,
              files: [...bestSnapshot.keys()],
            });
          }
        }
        landingNote += proof.status === "pass"
          ? " The verify command PASSES on the current tree. Remove any scratch files you created, then emit done — an unlanded run scores zero even with working code."
          : landingRestored
            ? ` The verify command FAILS on the current tree:\n${proof.detail ?? ""}\nYou broke working code with edits you never re-verified, and the budget is nearly gone — I restored your best-passing version of ${[...bestSnapshot.keys()].join(", ")} (now shown in <open_files>). Run the verify command to confirm it is green, then emit done. Do NOT re-apply the change that broke it.`
            : ` The verify command FAILS on the current tree:\n${proof.detail ?? ""}\nFix exactly this, then emit done.`;
      } else {
        landingNote += " Wrap up: converge on the smallest correct change, run the tests once, remove scratch files, and emit done before the budget ends.";
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
    if (testFocus && /^\s*not ok \d+ - |^FAILED\s+\S+::|={3,}\s*FAILURES\s*={3,}|^\s*--- FAIL: |^\s*FAIL\s+\S+\s+>\s|^\s*●\s+\S|^test \S+ \.\.\. FAILED$|^#\s+Failed test\b|^\(fail\) /m.test(String(result.observation || ""))
        && !String(result.observation).includes("[fix-tests]")) {
      const focus = formatFailingTestFocus(result.observation, workspaceTestReader(workspace));
      if (focus) {
        result.observation += `\n\n${focus}`;
        metrics.testFocusHints = (metrics.testFocusHints ?? 0) + 1;
        onEvent({ type: "test_focus" });
      }

      // Track per-test failure streaks; when one test stays stuck despite repeated focused feedback,
      // sharp feedback is exhausted — spawn ONE focused diagnostic reasoning call on just that test.
      const fails = parseTestFailures(result.observation);
      const nowFailing = new Set(fails.map((f) => f.name));
      for (const k of [...failStreak.keys()]) if (!nowFailing.has(k)) { failStreak.delete(k); diagnosed.delete(k); teacherEscalated.delete(k); }
      for (const failure of fails) {
        if (!priorDiagnosisWasFalsified(turns, failure)) continue;
        result.observation += `\n\n[diagnosis-falsified "${failure.name}"] The previous focused diagnosis was applied, but this exact failure did not change. Discard its assumed trace. Expand every test helper/wrapper and retrace from the real function or executable entrypoint with the concrete arguments and environment. Verify every branch is reachable before the next edit; do not keep changing the same surface.`;
        metrics.falsifiedDiagnoses = (metrics.falsifiedDiagnoses ?? 0) + 1;
        onEvent({ type: "test_diagnosis_falsified", test: failure.name });
        break;
      }
      if (diagnoseStuckTests) {
        const readTest = workspaceTestReader(workspace);
        let implementation = null;
        for (const f of fails) {
          const n = (failStreak.get(f.name) ?? 0) + 1;
          failStreak.set(f.name, n);
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
              });
              if (diag) {
                const diagnosedPath = diagnosedImplementationPath(diag, implementation.paths);
                if (diagnosedPath) openList = noteOpenFile(openList, diagnosedPath);
                const applySteer = diagnosedPath
                  ? `Apply this fix to ${diagnosedPath} with a targeted edit, then re-run the tests.`
                  : implementation.paths.length === 1
                    ? `Apply this fix to ${implementation.paths[0]} with a targeted edit, then re-run the tests.`
                  : "Apply the exact diagnosed change to the relevant implementation file above, then re-run the tests.";
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
          if (teacherAssist && n >= teacherAfter && !teacherEscalated.has(f.name) && f.file && f.line) {
            teacherEscalated.add(f.name);
            implementation ??= buildDiagnosticImplementationContext(openList, (p) => exec.resolveExisting(p));
            if (implementation.source) {
              let testSource = null;
              try { const s = readTest(f.file); if (s) testSource = extractTestDiagnosticContext(s, f.line); } catch { /* skip */ }
              const diff = f.diff.length ? f.diff.join("  ") : `${f.actual ?? "?"} vs expected ${f.expected ?? "?"}`;
              onEvent({ type: "activity", label: "consulting teacher" });
              const cause = await askTeacher({
                testName: f.name, testSource, implSource: implementation.source, diff,
                invoke: teacherAssist.invoke, signal,
              });
              if (cause) {
                const diagnosedPath = diagnosedImplementationPath(cause, implementation.paths);
                if (diagnosedPath) openList = noteOpenFile(openList, diagnosedPath);
                const applySteer = diagnosedPath
                  ? `Apply this fix to ${diagnosedPath} with a targeted edit, then re-run the tests.`
                  : implementation.paths.length === 1
                    ? `Apply this fix to ${implementation.paths[0]} with a targeted edit, then re-run the tests.`
                  : "Apply the exact diagnosed change to the relevant implementation file above, then re-run the tests.";
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
      const counts = parseTestCounts(result.observation);
      // Only compare like with like. Running ONE test file after a full-suite
      // baseline is not a regression — v13 ran `node --test test/exec.test.js`
      // (2 tests, 0 passing), the guard compared that to 705/790 from the full
      // suite, called it catastrophic, and reverted the model's working CLI
      // wiring. A narrower check must never be read as a broken build.
      const thisCommand = action.a === "shell" ? String(action.c ?? "").trim() : null;
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
            result.observation += `\n[flaky-suite] This run reports ${counts.passed}/${counts.total} passing but the previous run of the SAME files reported ${bestPassed}/${bestTotal}, and you have made no edit since. The difference is test flakiness, not a regression you caused. Do not "fix" it: identify the unstable test if you need to, otherwise continue with the task.`;
            metrics.flakySuiteNotices = (metrics.flakySuiteNotices ?? 0) + 1;
            onEvent({ type: "flaky_suite", best: bestPassed, observed: counts.passed });
          }
        } else if (bestSnapshot && bestSnapshot.size && revertsOfThisSnapshot >= 2) {
          // Stand down. Observed (self-hosting v8): SEVEN reverts of the same
          // snapshot suppressed seven distinct repair attempts — a fix often
          // requires passing through a temporary dip, and after the seventh
          // rollback the model stopped editing the file entirely. Two
          // restores is catastrophic-regression protection; more is the
          // guard fighting the repair.
          bestSnapshot = null;
          result.observation += `\n[regression-guard] Standing down after 2 restores of the same base: your repair attempts keep dipping the suite and reverting them is now blocking the fix. No more automatic restores this run — work THROUGH the dip: make the fix, re-run the tests, and climb back above ${bestPassed}/${bestTotal} on your own.`;
          onEvent({ type: "regression_guard_standdown", bestPassed, bestTotal });
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
            if (ground) { const r = refreshGrounding(ground, [...bestSnapshot.keys()]); metrics.groundingRefreshMs += r.ms ?? 0; }
            result.observation += `\n[reverted] Those edits regressed you from ${bestPassed}/${bestTotal} passing to ${counts.passed}/${counts.total} — you broke working code. I restored your best-passing version of ${[...bestSnapshot.keys()].join(", ")} (now shown in <open_files>). Re-run the tests to confirm, then try a DIFFERENT fix for the ones still failing — do NOT repeat the change that broke it.`;
            metrics.regressionReverts = (metrics.regressionReverts ?? 0) + 1;
            revertsOfThisSnapshot += 1;
            onEvent({ type: "regression_revert", from: bestPassed, to: counts.passed, files: [...bestSnapshot.keys()] });
          }
        }
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
      || !callerExcludedActions.includes("replace")
      || !callerExcludedActions.includes("shell");
    if (isDisguisedDone && autonomousImplementationRouteAvailable) {
      metrics.implementationRespondRejections++;
      result.done = false;
      result.summary = undefined;
      result.responded = false;
      result.observation = "[implementation-response] This is an autonomous implementation task, so there is no user to answer with `respond`. Do not describe a bug, plan, or next step: make the required edit now, run the configured verification after your latest edit, then emit `done` only when the implementation is complete.";
      forceBuildEdit = true;
      onEvent({ type: "implementation_respond_rejected" });
    } else if (action.a === "done" && result.done) {
      const decision = evaluateDoneGates({
        turns,
        task,
        workspace,
        interactive,
        immutableInv,
        immutableSnap,
        ledgerMax: requirementLedgerMax,
        latestPreview: latestPreviewProof,
        workspaceGeneration: workspaceEditGeneration,
        visualTask,
        summary: result.summary,
        count: (name) => gateCounts[name] ?? 0,
      });
      if (decision) {
        const delivery = deliveryFor(decision.gate, { interactive, visualTask });
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
            || deliveryFor(name, { interactive, visualTask }) !== BLOCK
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
      await applyExpensiveDoneGate("verify_red", VERIFY_DONE_GATE_MAX, async () => {
        if (!verificationScript) return null;
        const cached = doneVerificationProof
          && doneVerificationProof.generation === workspaceEditGeneration
          && doneVerificationProof.command === verificationScript
          ? doneVerificationProof.verification
          : null;
        let proof = cached;
        if (!proof) {
          metrics.verifyDoneGateRuns++;
          onEvent({ type: "activity", label: "verifying" });
          proof = await runVerification(workspace, verificationScript, signal, verificationTimeoutMs, {
            doubleCheck: flakyVerify,
            envOverrides: shellEnvOverrides,
            shellSandbox,
            shellNetwork,
            dockerImage,
            readOnlyWorkspacePaths,
            workspaceReadOnly: verificationWorkspaceReadOnly,
            processRunner: shellProcessRunner,
          });
          if (proof.interrupted || abortRequested()) markInterrupted("verification");
          doneVerificationProof = { generation: workspaceEditGeneration, command: verificationScript, verification: proof };
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
      await applyExpensiveDoneGate("edge_smoke", 1, () => {
        let findings = [];
        try {
          const out = execFileSync("node", [EDGE_SMOKE_CLI, workspace], {
            encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
          });
          findings = JSON.parse(out || "[]");
        } catch (e) {
          // A subprocess TIMEOUT means a candidate function did not terminate on a degenerate
          // input — the worst degenerate-input failure, and exactly what this gate exists to catch.
          // Swallowing it as null accepted a non-terminating `done` silently (template-engine
          // s2, 2026-07-20: render() looped forever on an unclosed block). Bounce it instead.
          // Any other spawn error (can't introspect) stays a silent null, as before.
          const timedOut = e?.code === "ETIMEDOUT" || (e?.killed && (e?.signal === "SIGTERM" || e?.signal === "SIGKILL"));
          return timedOut
            ? "[edge-smoke] one of your exported functions DID NOT TERMINATE on a degenerate edge input (an empty or blank string). An unbounded loop that hangs on trivial input is a bug the visible tests didn't cover — find the loop that never advances and bound it before finishing."
            : null;
        }
        return findings.length ? formatEdgeSmoke(findings) : null;
      });

      // spec_example: the code disagrees with a concrete example STATED in the
      // task spec. Parses `fn(args) -> expected` lines from the spec, runs the
      // model's exported function against them (subprocess-isolated), and bounces
      // the done WITH the mismatch. The oracle is the task author, not the model,
      // so this catches false beliefs the model's own thin tests miss (the
      // template-engine run "verified" if([]) was falsy in JS and shipped it).
      // Opt-in via BANTAM_SPEC_EXAMPLE_GATE=1.
      await applyExpensiveDoneGate("spec_example", 1, () => {
        if (!task) return null;
        let specFile;
        try {
          specFile = path.join(os.tmpdir(), `bantam-spec-${crypto.randomBytes(6).toString("hex")}.txt`);
          fs.writeFileSync(specFile, typeof task === "string" ? task : JSON.stringify(task));
          const out = execFileSync("node", [SPEC_EXAMPLE_CLI, workspace, specFile], {
            encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
          });
          const findings = JSON.parse(out || "[]");
          return findings.length ? formatSpecExamples(findings) : null;
        } catch { return null; }
        finally { try { if (specFile) fs.unlinkSync(specFile); } catch { /* ignore */ } }
      });

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
      await applyExpensiveDoneGate("lexical_smoke", 1, () => {
        if (!task) return null;
        let taskFile;
        try {
          taskFile = path.join(os.tmpdir(), `bantam-lexical-${crypto.randomBytes(6).toString("hex")}.txt`);
          fs.writeFileSync(taskFile, typeof task === "string" ? task : JSON.stringify(task));
          const out = execFileSync("node", [LEXICAL_SMOKE_CLI, workspace, taskFile], {
            encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
          });
          const findings = JSON.parse(out || "[]");
          return findings.length ? formatLexicalSmoke(findings) : null;
        } catch { return null; }
        finally { try { if (taskFile) fs.unlinkSync(taskFile); } catch { /* ignore */ } }
      });

      // type_contract: the mirror of lexical_smoke. The code ACCEPTS a value the
      // task's stated type excludes -- coercing where the contract requires a
      // throw. All six lexical-smoke-gate-ab runs wrote a correct parseEnabled and
      // still failed the hidden contract 6/6 here; the visible suite only ever
      // passes well-formed input, so being helpful is never contradicted.
      // Opt-in via BANTAM_TYPE_CONTRACT_GATE=1.
      await applyExpensiveDoneGate("type_contract", 1, () => {
        if (!task) return null;
        let taskFile;
        try {
          taskFile = path.join(os.tmpdir(), `bantam-typecontract-${crypto.randomBytes(6).toString("hex")}.txt`);
          fs.writeFileSync(taskFile, typeof task === "string" ? task : JSON.stringify(task));
          const out = execFileSync("node", [TYPE_CONTRACT_CLI, workspace, taskFile], {
            encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
          });
          const findings = JSON.parse(out || "[]");
          return findings.length ? formatTypeContractSmoke(findings) : null;
        } catch { return null; }
        finally { try { if (taskFile) fs.unlinkSync(taskFile); } catch { /* ignore */ } }
      });

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
    const progress = classifyProgress(action, result.observation, {
      workspaceChanged: shellChangedWorkspace,
      doneAccepted: action.a === "done" && result.done,
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
        const nudge = formatProgressNudge(progresslessTurns);
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
    const producedOutputArtifact = directArtifactPaths.length > 0
      || shellArtifactPaths.length > 0
      || (action.a === "shell" && shellChangedWorkspace && isArtifactPath(action.c, { knownArtifacts: [...knownArtifacts] }));
    const producedNonDocumentArtifact = producedArtifactPaths.some((file) => !isDocumentArtifactPath(file))
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

    // Raw model output stays separate from the parsed action — critical for
    // replay/debugging/training. `action`+`observation` are kept for prompt reuse.
    turns.push({
      i: turns.length,
      rawOutput,
      reasoning,
      action,
      parsedAction: action,
      ...(savePrompts ? { prompt: lastPromptForTurn } : {}),
      ...(modelCallIndex !== null ? { modelCallIndex } : {}),
      protocolViolation,
      observation: result.observation,
      ...(action.a === "query" ? { queryExecuted, queryTool: queryToolUsed } : {}),
      ...(queryOutcome ? { toolOutcome: queryOutcome } : {}),
      ...(queryPreviewProof ? { preview: queryPreviewProof } : {}),
      ...(isEditAction(action) ? { editApplied: directEditSucceeded } : {}),
      scopedVerify: result.scopedVerify,   // trusted harness-run verdict (undefined if none)
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
        || action.a === "search" || action.a === "inspect" || action.a === "shell" || action.a === "query";
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

// Path to the edge-smoke CLI, spawned by the edge_smoke done-gate so the
// candidate's code runs out of the harness process.
const EDGE_SMOKE_CLI = fileURLToPath(new URL("./edge-smoke.js", import.meta.url));
const SPEC_EXAMPLE_CLI = fileURLToPath(new URL("./spec-examples.js", import.meta.url));
const LEXICAL_SMOKE_CLI = fileURLToPath(new URL("./logic/lexical-smoke.js", import.meta.url));
const TYPE_CONTRACT_CLI = fileURLToPath(new URL("./logic/type-contract-smoke.js", import.meta.url));

export const GATE_METRIC = {
  empty_done: "emptyDoneRejections",
  premature_done: "doneRejections",
  continuity_reconcile: "continuityReconcileRejections",
  notes_documentation: "notesDocumentationRejections",
  verify_red: "verifyRedDoneRejections",
  sibling_symbol: "siblingSymbolRejections",
  family_convention: "familyConventionRejections",
  edge_smoke: "edgeSmokeRejections",
  spec_example: "specExampleRejections",
  lexical_smoke: "lexicalSmokeRejections",
  type_contract: "typeContractRejections",
  unverified_edit: "unverifiedEditRejections",
  secret_cleanup: "secretAuditRejections",
  immutable_file: "selfCheckRejections",
  evidence: "evidenceGateRejections",
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

function priorDiagnosisWasFalsified(turns, failure) {
  if (!failure?.name || !Array.isArray(turns) || !turns.length) return false;
  const diagnosisTag = `[diagnosis of "${failure.name}"]`;
  const falsifiedTag = `[diagnosis-falsified "${failure.name}"]`;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const observation = String(turns[i]?.observation ?? "");
    if (!observation.includes(diagnosisTag)) continue;
    const later = turns.slice(i + 1);
    if (later.some((turn) => String(turn?.observation ?? "").includes(falsifiedTag))) return false;
    const prior = parseTestFailures(observation).find((entry) => entry.name === failure.name);
    if (!prior || testFailureSignature(prior) !== testFailureSignature(failure)) return false;
    const editedPaths = [...new Set(later.flatMap((turn) => [
      ...(turnEditApplied(turn) ? editPaths(turn?.action ?? turn?.parsedAction) : []),
      ...(Array.isArray(turn?.shellChangedPaths) ? turn.shellChangedPaths : []),
    ]))];
    const diagnosedPath = diagnosedImplementationPath(observation, editedPaths);
    return diagnosedPath !== null;
  }
  return false;
}

function testFailureSignature(failure) {
  return JSON.stringify([
    failure?.name ?? null,
    failure?.expected ?? null,
    failure?.actual ?? null,
    Array.isArray(failure?.diff) ? failure.diff : [],
  ]);
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
  }
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
  return action.p === from ? { ...action, p: to } : action;
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
function formatWorkingNoteReanchor(state) {
  const note = state?.workingNote;
  if (!note?.text) return "";
  if (Number(state?.editsSinceWorkingNote ?? 0) > WORKING_NOTE_EDIT_CARRY) return "";
  return `[working-checkpoint from turn ${note.turn + 1}] Keep this bounded checklist active across its edit sequence:\n${note.text}\nRe-evaluate every item against the CURRENT source before acting. Continue only unfinished items in the stated direction; never restore an older value merely because it appears in this note. Then verify before done.`;
}

function restoreReadLedgerTurn(ledger, turn) {
  const action = turn?.action;
  const observation = String(turn?.observation ?? "");
  const note = (file, { allowGeneric = false } = {}) => {
    if (!file) return;
    const escaped = String(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`${escaped} \\(\\d+ lines, showing (\\d+)-(\\d+)\\)`).exec(observation);
    // A direct read has only one range, so legacy observations that omitted
    // the filename remain recoverable. An inspect can contain several reads;
    // never assign its first generic range to every requested file.
    const shown = named || (allowGeneric ? /\(\d+ lines, showing (\d+)-(\d+)\)/.exec(observation) : null);
    if (shown) ledger.note(file, Number(shown[1]), Number(shown[2]));
  };
  if (action?.a === "read_file") note(action.p, { allowGeneric: true });
  else if (action?.a === "inspect") {
    for (const op of action.ops ?? []) if (op?.a === "read_file") note(op.p);
  }
  if (turnEditApplied(turn)) {
    for (const file of editPaths(action)) ledger.invalidate(file);
  }
  if (Array.isArray(turn?.shellChangedPaths)) {
    for (const file of turn.shellChangedPaths) ledger.invalidate(file);
  } else if (turn?.sourceEditedByShell === true) {
    ledger.clear();
  }
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
function inspectFullyInLedger(action, ledger) {
  if (action?.a !== "inspect" || !Array.isArray(action.ops) || action.ops.length === 0) return false;
  let sawRead = false;
  for (const op of action.ops) {
    if (op?.a !== "read_file" || typeof op.p !== "string") return false; // mixed batch — execute
    const start = Number.isInteger(op.start) ? op.start : 1;
    let end;
    if (Number.isInteger(op.limit)) end = start + op.limit - 1;
    else if (Number.isInteger(op.start)) end = op.start + START_WINDOW - 1;
    else return false; // whole-file read: extent unknown without reading — let it execute
    if (!ledger.covers(op.p, start, end)) return false;
    sawRead = true;
  }
  return sawRead;
}

// Compact pointer that REPLACES a fully-covered inspect batch (see inspectFullyInLedger).
// It states only verifiable truths — the exact ranges are in the read map (which is
// non-empty and lists them whenever covers() held), and the files are unchanged since,
// so nothing new would return — and carries the correction: where the content already
// is, and the productive next moves. The <open_files> panel can clip large files, so it
// is named only as a maybe, never asserted to hold the range.
function ledgerReplayMessage(action, openFilesView) {
  const paths = [...new Set(action.ops.map((op) => op.p))].join(", ");
  const panelHint = openFilesView ? " (whole files also appear in <open_files> above)" : "";
  return `[ledger] Not re-read: every range in this inspect (${paths}) is already recorded in your read map ("Already read this run"), and nothing in these files has changed since you read them this run${panelHint} — re-running it would return only lines you have already seen, so it was not executed. To make progress: inspect an UNREAD range, run a \`search\` for the exact identifier you need (it answers with file:line), request a \`map\` overview you have not fetched yet, or — if you already have enough — answer now.`;
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
    const why = reason === "grader"
      ? "it is part of the grader for this task"
      : reason === "runner-config"
        ? "it configures the test runner for this task"
        : "it is outside the paths this task may edit";
    const redirect = reason === "out-of-scope"
      ? "Make the change inside the editable paths instead."
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
  } = {},
) {
  const root = path.resolve(workspace);
  const res = await runShellProcess(root, withNodeTestTimeout(script, timeoutMs), {
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
  });
  const first = classifyVerificationResult(res);
  if (first.status !== "pass") return first;
  // A single verify run is a coin-flip on a flaky/nondeterministic suite, and a flaky PASS is the
  // dangerous case — a false green that certifies broken work. When enabled, re-run a pass once: if it
  // doesn't reproduce, report "unverified (flaky)" instead of a trustworthy green. Off by default (it
  // doubles the cost of a passing verify); enable with BANTAM_FLAKY_VERIFY=1 on flaky-prone suites.
  if (doubleCheck) {
    const res2 = await runShellProcess(root, script, {
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
    });
    const second = classifyVerificationResult(res2);
    if (second.status === "fail") {
      return {
        status: "unverified",
        flaky: true,
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

export function classifyVerificationResult(result = {}) {
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
  return {
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    detail: clip(output),
  };
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

function clip(s, n = 2000) {
  if (s.length <= n) return s;
  // Test runners put the useful failure summary at the end. Keeping only the
  // first passing TAP cases turns a concrete verifier failure into an opaque
  // `exit 1`, exactly when the run artifact is needed for offline diagnosis.
  const marker = `\n... (verification output clipped; tail preserved) ...\n`;
  const kept = Math.max(0, n - marker.length);
  const head = Math.floor(kept / 2);
  return s.slice(0, head) + marker + s.slice(-(kept - head));
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
