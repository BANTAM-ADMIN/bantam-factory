import { analyzeRunTiming, formatRunTiming } from "./run-timing.js";
import { analyzePromptBloat, formatPromptBloat } from "./prompt-bloat.js";
import { analyzePrefixStability, formatPrefixStability } from "./prefix-stability.js";
import { analyzeThinkTruncation, formatThinkTruncation } from "./think-truncation.js";
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
  constantGroundingRejections: "constant_grounding",
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

// The authoritative prefix-cache metric, learned the hard way (2026-08-18,
// twice): llama's streamed `tokens_evaluated` is the request's TOTAL prompt
// tokens; only `timings.prompt_n` is what the slot actually processed.
// Reading the former as the latter declared a working cache dead.
function cacheReuseOf(artifact) {
  let processed = 0, total = 0, calls = 0;
  for (const call of artifact.modelCalls ?? []) {
    const raw = call?.response?.rawBody;
    if (typeof raw !== "string") continue;
    const p = /"timings":\{[^}]*"prompt_n":(\d+)/.exec(raw);
    const t = /"tokens_evaluated":(\d+)/.exec(raw);
    if (!p || !t) continue;
    processed += Number(p[1]);
    total += Number(t[1]);
    calls += 1;
  }
  if (calls < 3 || total === 0) return null;
  return { calls, processed, total, reusePct: Math.round(100 * (1 - processed / total)) };
}

// The 8-wastes ledger (operator's lean/TPS document, 2026-08-18). Four
// incidents this week were waste discovered only by manual archaeology: a
// ~20-turn gilding tail, window-creep, lock-wait contention, and
// full-suite-for-two-lines. Classify what the artifact already records so
// the next one announces itself. Mechanically-certain categories only.
function wasteLedger(artifact) {
  const turns = artifact.turns ?? [];
  if (!turns.length) return null;
  const events = artifact.events ?? [];
  const count = (type) => events.filter((e) => e?.type === type).length;
  const acts = turns.map((t) => (t.parsedAction ?? t.action ?? {}).a);
  const value = acts.filter((a) => ["replace", "write_file", "patch", "edit_lines", "move_file"].includes(a)).length
    + turns.filter((t) => (t.parsedAction ?? t.action ?? {}).a === "shell").length;
  const recon = acts.filter((a) => ["read_file", "search", "inspect", "list_dir", "query"].includes(a)).length;
  const motion = count("duplicate_action") + count("ledger_replay")
    + count("paging_steer") + count("inspect_shuffle_steer");
  const waiting = count("model_lock_wait");
  const defects = (artifact.rejectedOutputs ?? []).length
    + count("done_rejected") + count("protocol_violation");
  return { turns: turns.length, value, recon, motion, waiting, defects };
}

/** Summarize an artifact into a plain object (also the --json output). */
export function analyze(artifact) {
  const m = artifact.metrics || {};
  const r = artifact.result || {};
  const turns = m.turns ?? (Array.isArray(artifact.turns) ? artifact.turns.length : 0);
  const actions = (m.actions && typeof m.actions === "object") ? m.actions : histogramFromTurns(artifact.turns);

  const outcome = r.interrupted ? "interrupted"
    : (r.reachedDone || artifact.done) ? "done"
    // Chat evidence artifacts carry their outcome as a disposition string.
    : artifact.disposition ?? "incomplete";

  const gateRejections = Object.entries(GATE_METRICS)
    .map(([key, gate]) => ({ gate, count: Number(m[key] || 0) }))
    .filter((g) => g.count > 0);

  const contract = r.contract || {};
  const verify = (r.status || r.pass !== undefined)
    ? { status: r.status ?? (r.pass ? "pass" : "fail"), passed: contract.passed, tests: contract.tests }
    : (artifact.verification ?? null);

  return {
    runId: artifact.runId
      ?? (artifact.kind === "bantam-chat-run"
        ? `chat r${artifact.requestIndex ?? "?"} @ ${artifact.startedAt ?? "?"}`
        : undefined),
    task: artifact.task ?? artifact.request,
    model: artifact.modelId ?? artifact.model ?? artifact.endpoint,
    turns,
    tokens: Number(m.genTok || 0) + Number(m.promptTok || 0) || (m.tokens ?? 0),
    durationMs: m.totalMs ?? m.durationMs ?? artifact.durationMs ?? 0,
    outcome,
    actions,
    gateRejections,
    cache: cacheReuseOf(artifact),
    waste: wasteLedger(artifact),
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
  if (s.cache) {
    out.push(`cache: ${s.cache.reusePct}% prefix reuse (${s.cache.processed} of ${s.cache.total} prompt tokens processed across ${s.cache.calls} calls)`);
  }
  if (s.waste) {
    const w = s.waste;
    out.push(`ledger: ${w.value} value · ${w.recon} recon · ${w.motion} motion-refused · ${w.waiting} waiting · ${w.defects} defect-rework (of ${w.turns} turns)`);
  }
  out.push("");

  out.push("actions:");
  for (const [v, n] of Object.entries(s.actions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push(`  ${v.padEnd(12)} ${n}`);
  }
  out.push("");

  // Station wall-clock. tookMs alone cannot tell a slow model from a slow test
  // suite; this splits the run so the next choke is visible.
  const timing = analyzeRunTiming(artifact);
  for (const line of formatRunTiming(timing)) out.push(line);
  for (const line of formatPromptBloat(analyzePromptBloat(artifact))) out.push(line);
  for (const line of formatPrefixStability(analyzePrefixStability(artifact))) out.push(line);
  for (const line of formatThinkTruncation(analyzeThinkTruncation(artifact), artifact)) out.push(line);
  if (timing) out.push("");

  out.push("timeline:");
  for (const t of artifact.turns || []) {
    const verb = (t.parsedAction?.a ?? t.action?.a) || "?";
    const p = (t.parsedAction?.p ?? t.action?.p) ? ` ${t.parsedAction?.p ?? t.action?.p}` : "";
    const obs = oneLine(t.observation);
    const bounced = /\bbounced\b|done_rejected|^\[[a-z_]+\] .*finish/i.test(String(t.observation || "")) ? "  ✗" : "";
    const took = Number(t.tookMs) > 0 ? `${(t.tookMs / 1000).toFixed(1)}s`.padStart(6) : "     -";
    out.push(`  t${t.i}${took}  ${verb}${p}${bounced}  — ${obs}`);
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
