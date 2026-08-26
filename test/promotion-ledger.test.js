import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  codexPreviewVisionEnabled,
  previewPointerHitTestEnabled,
  taskAwarePreviewVisionEnabled,
} from "../src/logic/preview.js";
import { imagePixelFactsEnabled } from "../src/logic/vision.js";
import { lexicalContractAuditEnabled } from "../src/completion-audit.js";
import { decideStateAudit } from "../src/state-audit-policy.js";
import { visualAltCoverageEnabled } from "../src/visual-alt-coverage.js";

const ledger = JSON.parse(
  fs.readFileSync(new URL("../creative-suite/promotion-ledger.json", import.meta.url), "utf8"),
);

test("creative feature defaults agree with evidence-backed promotion decisions", () => {
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.policy.rawArtifactsAreImmutable, true);
  assert.equal(ledger.policy.postHocEvaluatorCorrectionsMustBeExplicit, true);

  const byId = new Map(ledger.candidates.map((candidate) => [candidate.id, candidate]));
  assert.equal(byId.size, ledger.candidates.length, "candidate ids must be unique");

  const pixels = byId.get("deterministic-png-pixel-facts");
  assert.equal(pixels.decision, "promoted");
  assert.equal(pixels.default, "on");
  assert.equal(imagePixelFactsEnabled({}), true);
  assert.equal(imagePixelFactsEnabled({ BANTAM_IMAGE_PIXEL_FACTS: "0" }), false);
  assert.ok(
    pixels.targetStudy.treatment.strictPasses > pixels.targetStudy.control.strictPasses,
    "a promoted correctness feature must beat its target control",
  );
  assert.ok(
    pixels.targetStudy.treatment.requests <= pixels.targetStudy.control.requests,
    "this promoted feature must retain its measured request non-regression",
  );
  assert.equal(
    pixels.nonTargetStudy.treatmentEvaluatorCorrectedStrictPasses,
    pixels.nonTargetStudy.controlStrictPasses,
  );

  const preview = byId.get("codex-rendered-preview-vision");
  assert.equal(preview.decision, "experimental");
  assert.equal(preview.default, "off");
  assert.equal(codexPreviewVisionEnabled({}), false);
  assert.equal(codexPreviewVisionEnabled({ BANTAM_CODEX_PREVIEW_VISION: "1" }), true);
  assert.match(preview.reason, /not causally attributable/i);

  const previewProof = byId.get("task-aware-preview-proof-linkage");
  assert.equal(previewProof.decision, "promoted");
  assert.equal(previewProof.default, "on-within-preview-vision-opt-in");
  assert.equal(taskAwarePreviewVisionEnabled({}), false);
  assert.equal(taskAwarePreviewVisionEnabled({ BANTAM_CODEX_PREVIEW_VISION: "1" }), true);
  assert.equal(taskAwarePreviewVisionEnabled({
    BANTAM_CODEX_PREVIEW_VISION: "1",
    BANTAM_CODEX_PREVIEW_TASK_REVIEW: "0",
  }), false);
  assert.equal(previewProof.proof.targetTaskAwareCausalRepairs, 4);
  assert.equal(previewProof.proof.clearTaskAwareFalseRepairs, 0);

  const pointerHitTest = byId.get("deterministic-preview-pointer-hit-test");
  assert.equal(pointerHitTest.decision, "promoted");
  assert.equal(pointerHitTest.default, "on");
  assert.equal(previewPointerHitTestEnabled({}), true);
  assert.equal(previewPointerHitTestEnabled({ BANTAM_PREVIEW_POINTER_HIT_TEST: "0" }), false);
  assert.equal(pointerHitTest.targetStudy.rollbackStrictPasses, 0);
  assert.equal(pointerHitTest.targetStudy.treatmentStrictPasses, 4);
  assert.equal(pointerHitTest.nonTargetStudy.treatmentEdits, 0);
  assert.equal(pointerHitTest.nonTargetStudy.falsePointerObstructions, 0);

  const visualAlt = byId.get("visual-alt-coverage-advisory");
  assert.equal(visualAlt.decision, "experimental");
  assert.equal(visualAlt.default, "off");
  assert.equal(visualAltCoverageEnabled({}), false);
  assert.equal(
    visualAltCoverageEnabled({ BANTAM_VISUAL_ALT_COVERAGE: "1" }),
    true,
  );
  assert.equal(visualAlt.fullTaskStudy.treatment.revisions, 0);
  assert.match(visualAlt.reason, /not promotion-grade/i);

  const replay = byId.get("counterbalanced-semantic-replay-evidence");
  assert.equal(replay.decision, "promoted");
  assert.equal(replay.default, "operator-command");
  assert.equal(replay.proof.providerReportedUsageCallsReconciled, 2);
  assert.equal(replay.proof.singleSampleOrderLabeledNotApplicable, true);
  assert.equal(replay.proof.positionSpecificCallReceipts, "sha256-v1");
  assert.equal(replay.proof.coordinatedArmAndTotalTamperingRejected, true);
  assert.equal(replay.proof.resealedForgedRequestHashRejected, true);
  assert.equal(replay.proof.requestProvenanceReconstructedFromSource, true);
  assert.equal(replay.proof.legacyReceiptlessEvidenceCompatible, true);
  assert.equal(replay.proof.fullRegressionTestsPassed, 103);

  const preflight = byId.get("model-free-replay-budget-preflight");
  assert.equal(preflight.decision, "promoted");
  assert.equal(preflight.liveProof.threeSampleRequests, 6);
  assert.equal(preflight.liveProof.threeSampleSerializedBytes, 109761);
  assert.equal(preflight.liveProof.maxCallsFiveBlocksSixCallLaunch, true);
  assert.equal(preflight.liveProof.dryRunStartsModel, false);
  assert.equal(preflight.liveProof.dryRunWritesEvidence, false);
  assert.equal(preflight.liveProof.priorSameTurnStudies, 5);
  assert.equal(preflight.liveProof.threeSampleExactDesignStudies, 1);
  assert.equal(preflight.liveProof.oneSampleExactDesignStudies, 2);
  assert.equal(preflight.liveProof.alternateSameTurnRemedyAllowed, true);
  assert.match(preflight.liveProof.priorStudyBoundary, /not current audit/i);
  assert.equal(preflight.liveProof.fullRegressionTestsPassed, 103);
  assert.match(preflight.liveProof.sourceUsageBoundary, /telemetry only/i);

  const miner = byId.get("model-free-replay-specimen-miner");
  assert.equal(miner.decision, "promoted");
  assert.equal(miner.default, "operator-command");
  assert.equal(miner.liveProof.startsModel, false);
  assert.equal(miner.liveProof.taskDriftNegativeControlExcluded, true);
  assert.equal(miner.liveProof.indexedArtifactTurns, 1);
  assert.equal(miner.liveProof.duplicateStudyArtifacts, 4);
  assert.equal(miner.liveProof.priorStudyTurnsExcluded, 1);
  assert.equal(miner.liveProof.wrongArtifactStudyDoesNotSuppress, true);
  assert.equal(miner.liveProof.priorityTurnShortlist, 135);
  assert.equal(miner.liveProof.knownMoonrootInterventionRank, 1);
  assert.equal(miner.liveProof.fullCandidateSetPreserved, true);
  assert.match(miner.liveProof.rankingBoundary, /not causal/i);
  assert.equal(miner.liveProof.replayableFailureArtifacts, 27);
  assert.equal(miner.liveProof.verifierBackedFailureModes, 16);
  assert.equal(miner.liveProof.representativeFailureArtifacts, 16);
  assert.equal(miner.liveProof.allFailureArtifactsRetainedInJson, true);
  assert.equal(miner.liveProof.passingContractScopeMislabelsCorrected, 7);
  assert.equal(miner.liveProof.assertionStackLocationPreferred, true);
  assert.match(miner.liveProof.failureModeBoundary, /not shared causality/i);
  assert.match(miner.liveProof.stableFailureModeAddress, /sha256-v1/i);
  assert.equal(miner.liveProof.liveLargestModeArtifacts, 3);
  assert.equal(miner.liveProof.liveLargestModePassingReferencesRetained, 9);
  assert.equal(miner.liveProof.liveSelectedModePayloadReductionPercent, 94.0);
  assert.ok(
    miner.liveProof.liveSelectedModeJsonBytes < miner.liveProof.liveFullJsonBytes,
  );
  assert.equal(miner.liveProof.ambiguousModeSelectorRejected, true);
  assert.equal(miner.liveProof.distinctModeNegativeControlExcluded, true);
  assert.equal(miner.liveProof.largeJsonStdoutDrainedBeforeExit, true);
  assert.equal(miner.liveProof.largeJsonCliFixtureFailures, 120);
  assert.equal(miner.liveProof.machineReadableLivePipeValid, true);
  assert.equal(miner.liveProof.crossExperimentGraderDriftNegativeControlExcluded, true);
  assert.equal(miner.liveProof.constellationFalseCohortsAfter, 0);
  assert.ok(
    miner.liveProof.replayableFailureArtifactsAfterEvaluatorIdentity
      < miner.liveProof.replayableFailureArtifactsBeforeEvaluatorIdentity,
  );
  assert.ok(miner.liveProof.fixtureProvenanceWorstMedianMs < 5);
  assert.equal(miner.liveProof.nativeProvenanceSmokeStrictPasses, 2);
  assert.equal(miner.liveProof.nativeProvenanceRootsIdentical, true);
  assert.equal(miner.liveProof.nativeProvenanceArtifactAuditsPassed, 2);
  assert.equal(miner.liveProof.crossArmExperimentContrastsDetected, 10);
  assert.equal(miner.liveProof.uncontrastedCohortsAfterFilter, 0);
  assert.equal(miner.liveProof.uncontrastedFilterStartsModel, false);
  assert.match(miner.liveProof.experimentContrastBoundary, /does not.*causality/i);
  assert.equal(miner.liveProof.fullRegressionTestsPassed, 103);
  assert.match(miner.liveProof.boundary, /witness-only/);

  const scopeRollback = byId.get("atomic-eval-scope-rollback");
  assert.equal(scopeRollback.decision, "experimental");
  assert.equal(scopeRollback.default, "off");
  assert.equal(scopeRollback.observedFailureFamily.historicalScopeFailureArtifacts, 7);
  assert.equal(scopeRollback.causalControl.controlStatus, "cheated");
  assert.equal(scopeRollback.causalControl.treatmentStatus, "pass");
  assert.equal(scopeRollback.causalControl.legitimateSourceEditPreserved, true);
  assert.equal(scopeRollback.causalControl.tamperedGreenVerificationInvalidated, true);
  assert.equal(scopeRollback.nativeNonRegression.strictPasses, 4);
  assert.equal(scopeRollback.nativeNonRegression.treatmentInterventions, 0);
  assert.equal(scopeRollback.nativeNonRegression.independentArtifactAuditsPassed, 4);
  assert.ok(scopeRollback.snapshotCost.largestCatalogFixtureP95Ms < 5);
  assert.equal(scopeRollback.fullRegressionTestsPassed, 103);
  assert.match(scopeRollback.promotionBoundary, /keep opt-in/i);

  const launcherParity = byId.get("experiment-launcher-runtime-parity");
  assert.equal(launcherParity.decision, "promoted");
  assert.equal(launcherParity.before.turns, 0);
  assert.equal(launcherParity.before.modelErrors, 4);
  assert.equal(launcherParity.after.nativeCodexRuns, 4);
  assert.equal(launcherParity.after.codexPromptCallsExact, 42);
  assert.equal(launcherParity.proof.headlessDryRunBypassesAmbientModelStartup, true);

  const lexicalAudit = byId.get("lexical-contract-completion-audit");
  assert.equal(lexicalAudit.decision, "promoted");
  assert.equal(lexicalAudit.default, "on");
  assert.equal(lexicalContractAuditEnabled(undefined), true);
  assert.equal(lexicalContractAuditEnabled("0"), false);
  assert.equal(lexicalAudit.exactTurnReplay.baselinePasses, 0);
  assert.equal(lexicalAudit.exactTurnReplay.candidatePasses, 3);
  assert.equal(lexicalAudit.fullTaskStudy.control.strictPasses, 0);
  assert.equal(lexicalAudit.fullTaskStudy.treatment.strictPasses, 2);
  assert.equal(lexicalAudit.fullTaskStudy.treatment.lexicalAuditHints, 2);
  assert.ok(
    lexicalAudit.fullTaskStudy.treatment.requests
      < lexicalAudit.fullTaskStudy.control.requests,
  );
  assert.equal(lexicalAudit.activationBreadth.matchingFixtures, 1);
  assert.equal(lexicalAudit.proof.fullRegressionTestsPassed, 103);

  const stateAuditExclusion = byId.get("state-audit-completion-order-exclusion");
  assert.equal(stateAuditExclusion.decision, "promoted");
  assert.equal(stateAuditExclusion.default, "on");
  assert.equal(stateAuditExclusion.observedRegression.asyncApisConvertedToSync, 2);
  assert.equal(stateAuditExclusion.nativeStudy.legacy.strictPasses, 2);
  assert.equal(stateAuditExclusion.nativeStudy.corrected.strictPasses, 2);
  assert.ok(
    stateAuditExclusion.nativeStudy.corrected.requests
      < stateAuditExclusion.nativeStudy.legacy.requests,
  );
  assert.equal(
    decideStateAudit(
      "Preserve input order regardless of completion order in this concurrent map.",
      "auto",
    ).enabled,
    false,
  );
  assert.equal(
    decideStateAudit(
      "An async loader must prevent an older stale completion from replacing the latest result.",
      "auto",
    ).enabled,
    true,
  );
  assert.equal(stateAuditExclusion.proof.asyncThrowProbeDiagnostic, true);
  assert.equal(stateAuditExclusion.proof.fullRegressionTestsPassed, 103);

  const stateAuditProofCredit = byId.get("state-audit-inline-proof-credit");
  assert.equal(stateAuditProofCredit.decision, "promoted");
  assert.equal(stateAuditProofCredit.default, "on");
  assert.deepEqual(
    stateAuditProofCredit.discoveryStudy.models,
    ["gpt-5.6-terra", "gpt-5.6-sol"],
  );
  assert.equal(stateAuditProofCredit.discoveryStudy.gpt55EvidenceExcluded, true);
  assert.equal(stateAuditProofCredit.failedIntermediate.promotionRejected, true);
  assert.equal(stateAuditProofCredit.nativeSolBeforeAfter.beforeDoneDeferrals, 2);
  assert.equal(stateAuditProofCredit.nativeSolBeforeAfter.afterDoneDeferrals, 0);
  assert.ok(
    stateAuditProofCredit.nativeSolBeforeAfter.afterTurns
      < stateAuditProofCredit.nativeSolBeforeAfter.beforeTurns,
  );
  assert.equal(stateAuditProofCredit.proof.laterEditInvalidatesProof, true);
  assert.equal(stateAuditProofCredit.proof.fullRegressionTestsPassed, 1168);
});
