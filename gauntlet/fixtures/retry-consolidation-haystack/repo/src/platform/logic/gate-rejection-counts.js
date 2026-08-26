// Canonical compact gate-intervention shape for experiment rows. Run artifacts
// retain the individual metric fields; experiments need one mergeable map so a
// pass-rate delta cannot be mistaken for an intervention that never happened.

export const GATE_REJECTION_METRICS = {
  emptyDoneRejections: "empty_done",
  doneRejections: "premature_done",
  verifyRedDoneRejections: "verify_red",
  unverifiedEditRejections: "unverified_edit",
  siblingSymbolRejections: "sibling_symbol",
  familyConventionRejections: "family_convention",
  edgeSmokeRejections: "edge_smoke",
  specExampleRejections: "spec_example",
  ledgerRejections: "requirement_ledger",
  secretAuditRejections: "secret_cleanup",
  evidenceGateRejections: "evidence",
  previewGateRejections: "preview",
  selfCheckRejections: "immutable_file",
  continuityReconcileRejections: "continuity_reconcile",
  notesDocumentationRejections: "notes_documentation",
  reportShapeRejections: "report_shape",
  progressGateRejections: "progress_gate",
  artifactVerificationGateRejections: "artifact_verification",
};

export const OPT_IN_GATE_ENV = {
  BANTAM_UNVERIFIED_GATE: "unverified_edit",
  BANTAM_PREVIEW_GATE: "preview",
  BANTAM_CONTINUITY_GATE: "continuity_reconcile",
  BANTAM_NOTES_GATE: "notes_documentation",
  BANTAM_EDGE_SMOKE_GATE: "edge_smoke",
  BANTAM_SPEC_EXAMPLE_GATE: "spec_example",
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
