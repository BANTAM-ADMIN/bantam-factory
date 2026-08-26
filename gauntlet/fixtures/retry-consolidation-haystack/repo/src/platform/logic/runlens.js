// runlens — summarize a BANTAM run artifact (`--save-run` output) into a readable
// report. Grew out of the 2026-07-19 three-way build-off task; this is the version
// wired against the REAL artifact schema (parsedAction, metrics counts, result),
// not the simplified task fixture.

// Gate-rejection metric names → the gate they count (metrics carry counts, not events).
const GATE_METRICS = {
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
  declarativeA11yRejections: "declarative_a11y",
  continuityReconcileRejections: "continuity_reconcile",
  notesDocumentationRejections: "notes_documentation",
  progressGateRejections: "progress_gate",
  artifactVerificationGateRejections: "artifact_verification",
};

function histogramFromTurns(turns) {
  const h = {};
  for (const t of turns || []) {
    const v = t.parsedAction?.a ?? t.action?.a;
    if (typeof v === "string") h[v] = (h[v] || 0) + 1;
  }
  return h;
}

/** Summarize an artifact into a plain object (also the --json output). */
export function analyze(artifact) {
  const m = artifact.metrics || {};
  const r = artifact.result || {};
  const turns = m.turns ?? (Array.isArray(artifact.turns) ? artifact.turns.length : 0);
  const actions = (m.actions && typeof m.actions === "object") ? m.actions : histogramFromTurns(artifact.turns);

  const outcome = r.interrupted ? "interrupted"
    : (r.reachedDone || artifact.done) ? "done"
    : "incomplete";

  const gateRejections = Object.entries(GATE_METRICS)
    .map(([key, gate]) => ({ gate, count: Number(m[key] || 0) }))
    .filter((g) => g.count > 0);

  const contract = r.contract || {};
  const verify = (r.status || r.pass !== undefined)
    ? { status: r.status ?? (r.pass ? "pass" : "fail"), passed: contract.passed, tests: contract.tests }
    : (artifact.verification ?? null);

  return {
    runId: artifact.runId,
    task: artifact.task,
    model: artifact.modelId ?? artifact.model,
    turns,
    tokens: Number(m.genTok || 0) + Number(m.promptTok || 0) || (m.tokens ?? 0),
    durationMs: m.totalMs ?? m.durationMs ?? 0,
    outcome,
    actions,
    gateRejections,
    verify,
  };
}

const OBS_MAX = 76;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, OBS_MAX);
const secs = (ms) => `${Math.round((Number(ms) || 0) / 1000)}s`;

/** The human report (default output). Takes the full artifact for the timeline. */
export function formatReport(artifact) {
  const s = analyze(artifact);
  const out = [];
  out.push(`runlens · ${s.runId ?? "(no runId)"}`);
  if (s.task) out.push(`task:  ${oneLine(s.task).slice(0, 120)}`);
  out.push(`model: ${s.model ?? "?"}`);
  out.push(`turns: ${s.turns}  tokens: ${s.tokens}  duration: ${secs(s.durationMs)}  outcome: ${s.outcome}`);
  out.push("");

  out.push("actions:");
  for (const [v, n] of Object.entries(s.actions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push(`  ${v.padEnd(12)} ${n}`);
  }
  out.push("");

  out.push("timeline:");
  for (const t of artifact.turns || []) {
    const verb = (t.parsedAction?.a ?? t.action?.a) || "?";
    const p = (t.parsedAction?.p ?? t.action?.p) ? ` ${t.parsedAction?.p ?? t.action?.p}` : "";
    const obs = oneLine(t.observation);
    const bounced = /\bbounced\b|done_rejected|^\[[a-z_]+\] .*finish/i.test(String(t.observation || "")) ? "  ✗" : "";
    out.push(`  t${t.i}  ${verb}${p}${bounced}  — ${obs}`);
  }
  out.push("");

  const total = s.gateRejections.reduce((a, g) => a + g.count, 0);
  out.push(`gate rejections: ${total}`);
  for (const g of s.gateRejections) out.push(`  ${g.gate}  ×${g.count}`);
  out.push("");

  const v = s.verify;
  out.push(v ? `verify: ${v.status}${v.passed != null && v.tests != null ? ` ${v.passed}/${v.tests}` : ""}` : "verify: none");
  return out.join("\n");
}
