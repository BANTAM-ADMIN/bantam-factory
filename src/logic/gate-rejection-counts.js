// Canonical compact gate-intervention shape for experiment rows. Run artifacts
// retain the individual metric fields; experiments need one mergeable map so a
// pass-rate delta cannot be mistaken for an intervention that never happened.

export const GATE_REJECTION_METRICS = {
  emptyDoneRejections: "empty_done",
  doneRejections: "premature_done",
  verifyRedDoneRejections: "verify_red",
  taskCoverageRejections: "task_coverage",
  probeDemandRejections: "probe_demand",
  constantGroundingRejections: "constant_grounding",
  siblingSweepRejections: "sibling_sweep",
  unverifiedEditRejections: "unverified_edit",
  siblingSymbolRejections: "sibling_symbol",
  familyConventionRejections: "family_convention",
  edgeSmokeRejections: "edge_smoke",
  specExampleRejections: "spec_example",
  // Both of these were counted by the agent and written into run artifacts, but
  // missing from THIS map -- the one experiments merge. So an experiment running
  // either gate saw a pass-rate delta with no recorded intervention, which is the
  // exact confusion the header above says this map exists to prevent.
  //
  // Found 2026-08-01 while measuring type_contract on Codex: it turned a 0/3
  // hidden-contract failure into 3/3, and there was no counter in the experiment
  // view to attribute the win to. The artifact had it (1 fire on each passing run,
  // 0 on each failing one); the aggregate did not.
  lexicalSmokeRejections: "lexical_smoke",
  typeContractRejections: "type_contract",
  ledgerRejections: "requirement_ledger",
  secretAuditRejections: "secret_cleanup",
  evidenceGateRejections: "evidence",
  visionUnverifiedRejections: "vision_unverified",
  unsearchedChoiceRejections: "unsearched_choice",
  unsimulatedTargetRejections: "unsimulated_target",
  previewGateRejections: "preview",
  selfCheckRejections: "immutable_file",
  continuityReconcileRejections: "continuity_reconcile",
  notesDocumentationRejections: "notes_documentation",
  reportShapeRejections: "report_shape",
  progressGateRejections: "progress_gate",
  artifactVerificationGateRejections: "artifact_verification",
};

export const OPT_IN_GATE_ENV = {
  BANTAM_PROBE_DEMAND: "probe_demand",
  BANTAM_CONSTANT_GROUNDING: "constant_grounding",
  BANTAM_SIBLING_SWEEP: "sibling_sweep",
  BANTAM_UNVERIFIED_GATE: "unverified_edit",
  BANTAM_PREVIEW_GATE: "preview",
  BANTAM_CONTINUITY_GATE: "continuity_reconcile",
  BANTAM_TASK_COVERAGE: "task_coverage",
  BANTAM_NOTES_GATE: "notes_documentation",
  BANTAM_EDGE_SMOKE_GATE: "edge_smoke",
  BANTAM_SPEC_EXAMPLE_GATE: "spec_example",
  BANTAM_TYPE_CONTRACT_GATE: "type_contract",
  BANTAM_LEXICAL_SMOKE_GATE: "lexical_smoke",
  BANTAM_LEDGER_GATE: "requirement_ledger",
};

export function gateRejectionCounts(metrics) {
  const counts = {};
  for (const [metric, gate] of Object.entries(GATE_REJECTION_METRICS)) {
    const count = Number(metrics?.[metric] ?? 0);
    if (Number.isFinite(count) && count > 0) counts[gate] = count;
  }
  return counts;
}

export function enabledOptInGateChanges(referenceArm, candidateArm) {
  const referenceEnv = referenceArm?.env ?? {};
  const candidateEnv = candidateArm?.env ?? {};
  return Object.entries(OPT_IN_GATE_ENV)
    .filter(([name]) => !optInEnabled(referenceEnv[name]) && optInEnabled(candidateEnv[name]))
    .map(([env, gate]) => ({ env, gate }));
}

export function optInEnabled(value) {
  if (/^(1|true|yes|on)$/i.test(String(value ?? ""))) return true;
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
