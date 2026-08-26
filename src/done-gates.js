// The done-gate chain: the pure-sync gates, declared once and evaluated by
// `evaluateDoneGates` in precedence order. Every gate declares its own bound, so no
// gate may ever trap a run.
//
// Three more done-gates run AFTER this loop, inline in agent.js via
// `applyExpensiveDoneGate`, because they need a KB query (sibling_symbol,
// family_convention) or a verify subprocess (verify_red) that doesn't belong in a
// pure-sync check — and running them last means an empty or already-rejected done
// never pays for that cost. They share the same policy (`gate-policy.js`), bounds,
// and metrics as the gates here; only their evaluation lives with the loop state
// they need. `gate-policy.js` classifies all of them together.

import {
  emptyDoneObjection,
  prematureDoneObjection,
  refactorSurfaceObjection,
  requirementLedgerObjection,
  secretCleanupObjection,
  unverifiedEditObjection,
} from "./done-guard.js";
import { missingOutputsObjection } from "./logic/missing-outputs.js";
import { placeholderDoneObjection } from "./logic/placeholder-done.js";
import { unresolvedEvidenceObjection } from "./logic/evidence-guard.js";
import { visionUnverifiedObjection } from "./logic/vision-ground.js";
import { unsearchedChoiceObjection } from "./logic/unsearched-choice.js";
import { unsimulatedTargetObjection } from "./logic/simulate-to-target.js";
import { isComputeShellCommand } from "./progress-awareness.js";
import {
  taskRequiresInteractivePreview,
  unresolvedPreviewObjection,
} from "./logic/preview-evidence.js";
import { immutableViolations } from "./logic/self-check.js";
import { taskCoverageObjection, taskCoverageScope } from "./logic/task-coverage.js";
import { probeDemandObjection } from "./logic/probe-demand.js";
import { contractCoverageObjection } from "./logic/contract-coverage.js";
import { constantGroundingObjection } from "./logic/constant-grounding.js";
import { editedLinesFromTurns, siblingSweepObjection } from "./logic/sibling-site-sweep.js";
import { continuityReconcileObjection, notesDocumentationObjection } from "./logic/continuity-anchors.js";
import { reportShapeObjection } from "./report-guard.js";
import { BLOCK, deliveryFor, OFF } from "./gate-policy.js";

export const DONE_GATES = [
  {
    // First, because nothing downstream matters if the working tree is untouched.
    name: "empty_done",
    max: 2,
    evaluate: (c) => emptyDoneObjection(c.turns, c.count("empty_done"), { task: c.task }),
  },
  {
    // Right after empty_done and before anything that inspects the WORK: a stub
    // summary is decided by one string, and mailman (2026-08-21) showed every
    // work-inspecting gate downstream declining to look at it — empty_done saw a
    // touched tree, premature_done saw no test verdict and returned null, and a
    // run ended on turn 10 of 200 with the summary "placeholder".
    name: "placeholder_done",
    max: 2,
    evaluate: (c) => placeholderDoneObjection(c.turns, c.count("placeholder_done"), { maxRejections: 2 }),
  },
  {
    name: "premature_done",
    max: 2,
    evaluate: (c) => prematureDoneObjection(c.turns, c.count("premature_done"), { maxRejections: 2, workspace: c.workspace }),
  },
  {
    name: "unverified_edit",
    max: 1,
    evaluate: (c) => unverifiedEditObjection(c.turns, c.count("unverified_edit"), {
      latestPreview: c.latestPreview,
      workspaceGeneration: c.workspaceGeneration,
      // Missing (older callers) must mean "verifier exists" — the hard line.
      verifierConfigured: c.verifierConfigured !== false,
    }),
  },
  {
    // After unverified_edit: that gate asks "did you run anything at all";
    // this one asks "did you run it more than one way" — refactors only.
    name: "refactor_surface",
    max: 1,
    evaluate: (c) => refactorSurfaceObjection(c.turns, c.count("refactor_surface"), {
      task: c.task,
      verifierConfigured: c.verifierConfigured !== false,
    }),
  },
  {
    name: "secret_cleanup",
    max: 1,
    evaluate: (c) => secretCleanupObjection(c.turns, c.count("secret_cleanup"), { task: c.task }),
  },
  {
    name: "immutable_file",
    max: 1,
    evaluate: (c) => (c.immutableSnap
      ? immutableViolations(c.workspace, c.immutableInv, c.immutableSnap)[0] ?? null
      : null),
  },
  {
    name: "evidence",
    max: 1,
    evaluate: (c) => unresolvedEvidenceObjection(c.turns, c.count("evidence")),
  },
  {
    // Beside `evidence`, and for the same reason: this one asks whether the
    // evidence is a GAUGE. An answer read out of a machine-rendered image by the
    // vision model, with the pixels never opened, is a guess wearing the clothes
    // of a fact (TB2 chess-best-move, ~1-in-6 exact on the live server).
    name: "vision_unverified",
    max: 1,
    evaluate: (c) => visionUnverifiedObjection(c.turns, c.count("vision_unverified"), { task: c.task }),
  },
  {
    // The task states the END STATE and the run never reproduced it. Checking
    // the rules an answer should satisfy is a proxy; the grader derives its own
    // quantities and yours can measure something else entirely while every
    // number looks right (dna-insert: every stated constraint green, the
    // grader's annealed region 2nt against a floor of 15).
    name: "unsimulated_target",
    max: 1,
    evaluate: (c) => unsimulatedTargetObjection(c.turns, c.count("unsimulated_target"), { task: c.task }),
  },
  {
    // A decidable search — earliest/best/all over a handed candidate space —
    // answered without executing anything that could decide it
    // (constraints-scheduling picked 09:00 by argument and missed a stated
    // 10 AM floor). The RULE was in its prompt bytes and was waved past.
    name: "unsearched_choice",
    max: 1,
    evaluate: (c) => unsearchedChoiceObjection(c.turns, c.count("unsearched_choice"), {
      task: c.task,
      isCompute: isComputeShellCommand,
    }),
  },
  {
    // Done while the task's own "every module in <dir>" quantifier still has
    // modules this run never read or edited (both prompt trajectories lost
    // adapter-migration runs to exactly this early-done on 2026-08-12; the
    // advisory form of the same fact measured ignored 3/3 on that fixture).
    // Repo facts only, one bounce, and no scope means no evaluation.
    name: "task_coverage",
    max: 1,
    evaluate: (c) => taskCoverageObjection(
      taskCoverageScope(c.task, c.workspace),
      c.turns,
      c.count("task_coverage"),
      { panelComplete: c.panelComplete },
    ),
  },
  {
    // Sweep films + A/B (2026-08-26): enumerated contracts get implemented in
    // full and tested in part; the untested entries are where the misses live.
    // The advisory station compiles ~50% — this is its enforcement half.
    name: "contract_coverage",
    max: 1,
    evaluate: (c) => contractCoverageObjection({ task: c.task, workspace: c.workspace, count: c.count("contract_coverage") }),
  },
  {
    // A done after verify-green on a task that names explicit bounds, with no
    // inline probe ever executed. The checklist HINT of the same fact measured
    // inert (2026-08-15); the bounce form follows the 2026-08-12 finding that
    // gate bounces get repaired where hints get waved past. Opt-in
    // (BANTAM_PROBE_DEMAND=1), one bounce maximum, prereg:
    // docs/superpowers/reports/2026-08-15-probe-demand-gate-preregistration.md
    name: "probe_demand",
    max: 1,
    evaluate: (c) => probeDemandObjection(c.task, c.turns, c.count("probe_demand"), {
      enabled: Boolean(c.probeDemand),
      auditEmitted: Boolean(c.completionAuditEmitted),
    }),
  },
  {
    // An int-keyed constant table landed by this run's edits with no source
    // sighting in any observation. Three arms, three different hallucinated
    // enum tables (2026-08-18 bake-off); the provenance HINT measured inert
    // the same night, so this is the bounce form the 08-15 finding calls
    // for. Opt-in (BANTAM_CONSTANT_GROUNDING=1), one bounce.
    name: "constant_grounding",
    max: 1,
    evaluate: (c) => (c.constantGrounding
      ? constantGroundingObjection(c.turns, c.count("constant_grounding"))
      : null),
  },
  {
    // A fix applied at one of several structurally identical sites. SWE-bench
    // v2 autopsy (2026-08-15): django-15572's patch was the gold patch's first
    // hunk verbatim, missing the twin comprehension three lines below; the
    // same shape lost channel-filter and list-ops. Opt-in
    // (BANTAM_SIBLING_SWEEP=1), one bounce, at most 3 named sites. Prereg:
    // docs/superpowers/reports/2026-08-15-sibling-site-sweep-preregistration.md
    name: "sibling_sweep",
    max: 1,
    evaluate: (c) => siblingSweepObjection(c.turns, c.count("sibling_sweep"), {
      enabled: Boolean(c.siblingSweep),
      readFile: c.readWorkspaceFile,
      editedLinesFor: (p, content) => editedLinesFromTurns(c.turns, p, content),
    }),
  },
  {
    name: "preview",
    max: 2,
    evaluate: (c) => unresolvedPreviewObjection(
      c.latestPreview,
      c.workspaceGeneration,
      c.count("preview"),
      {
        maxRejections: 2,
        requireInteraction: taskRequiresInteractivePreview(c.task),
      },
    ),
  },
  {
    name: "requirement_ledger",
    max: Number.MAX_SAFE_INTEGER,
    evaluate: (c) => (c.ledgerMax > 0
      ? requirementLedgerObjection(c.turns, c.count("requirement_ledger"), { maxRejections: c.ledgerMax })
      : null),
  },
  {
    // Prose continuity: a finish while the narrative still describes one thing two
    // ways (same-attribute conflict). The read-time advisory did not lift the pass
    // rate (ON 3/5 = OFF 3/5) because it under-catches the HALF-fixed conflict; a
    // gate re-checks the FINAL text and catches both the missed and half-fixed
    // cases. Candidate, opt-in (BANTAM_CONTINUITY_GATE=1), bounded to two bounces.
    name: "continuity_reconcile",
    max: 2,
    evaluate: (c) => continuityReconcileObjection(c.workspace, c.count("continuity_reconcile")),
  },
  {
    // Notes deliverable that doesn't document a repair the model actually made — the
    // measured continuity-repair failure where the chapter is fixed but NOTES.md
    // confabulates. Derived from the model's own edits, not the grader's assertion.
    // Candidate, opt-in (BANTAM_NOTES_GATE=1), bounded to two bounces.
    name: "notes_documentation",
    max: 2,
    evaluate: (c) => notesDocumentationObjection(c.turns, c.workspace, c.count("notes_documentation")),
  },
  {
    // Last by precedence: shape only matters once the substantive gates are satisfied.
    name: "report_shape",
    max: 1,
    evaluate: (c) => reportShapeObjection(c.summary, c.count("report_shape")),
  },
  {
    // LAST, deliberately. "The file the grader reads is not there" is a
    // SYMPTOM; every gate above names a cause — the pixels were never opened,
    // the choice was never searched, the tests are red. Those are the useful
    // things to say first, and the file usually appears once they are answered.
    // This is the backstop that catches a run which satisfied everything else
    // and still never wrote the deliverable.
    //
    // rstan-to-pystan (2026-08-21) is the case: it ran
    // `ls -la /app/alpha_est.csv …`, saw nothing, and called done three times
    // with 100 of its 120 minutes unspent. The grader's first assertion is that
    // those four files exist. verify-outputs says exactly this as advice, and
    // was in the rule set at the time.
    name: "missing_outputs",
    max: 2,
    evaluate: (c) => missingOutputsObjection(c.turns, c.count("missing_outputs"), {
      maxRejections: 2, task: c.task, workspace: c.workspace, runStartedAt: c.runStartedAt,
    }),
  },

];

/**
 * First blocking gate, otherwise the first warning gate, by declared precedence.
 * A warning must never mask a later block: editing an immutable file is also unverified, but the
 * user's explicit instruction still has to block the run.
 * @returns {{gate: string, message: string}|null}
 */
export function evaluateDoneGates(ctx) {
  const warnings = [];
  for (const gate of DONE_GATES) {
    const delivery = deliveryFor(gate.name, ctx);
    if (delivery === OFF) continue;
    if (ctx.count(gate.name) >= gate.max) continue;
    const message = gate.evaluate(ctx);
    if (!message) continue;
    const decision = { gate: gate.name, message: String(message) };
    // A block short-circuits: the model is going to retry, and the remaining
    // conditions are its problem to fix on the way back, not news for a human.
    if (delivery === BLOCK) return { ...decision, warnings: [] };
    warnings.push(decision);
  }
  // `warnings` carries every warning, not only the first. A warned done is
  // ACCEPTED and the run ends, so a warning dropped here is dropped for good:
  // when preview moved to interactive WARN (2026-07-16) a RED render vanished
  // behind unverified_edit's earlier slot, and the human — one deliveryFor away
  // from being told the page throws — was advised to go run a test instead.
  // `gate`/`message` stay the first warning so existing callers are unchanged.
  return warnings.length ? { ...warnings[0], warnings } : null;
}
