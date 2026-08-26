// The supervisor's analyzers: the byte-level audits the factory's operators
// performed by hand, encoded. Each is a pure function over a saved run film
// (--save-run JSON) returning findings — a finding is a DRAFT with evidence
// attached, never a verdict: the judgment stays with a human.
//
// Provenance: every analyzer here is a generalization of a real audit that
// found a real mechanism (see src/supervisor/jig-catalog.json).

function ts(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }

function requestPrompt(c) {
  let body = c?.request?.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return ""; } }
  return String(body?.prompt ?? "");
}

// A turn has TWO prompt shapes: the think phase ends open at `<think>`, the
// action phase carries the chosen action instead. They are different by
// design, so cache_n legitimately resets between them — comparing across
// phases produced a false "rewrite" on a film whose frozen renders were
// proven working (post-fix timegrid, 2026-08-26). Compare like with like.
function callPhase(c) {
  const p = requestPrompt(c);
  if (!p) return "unknown";
  return /<think>\s*$/.test(p.slice(-400)) ? "think" : "action";
}

function callTimings(film) {
  const out = [];
  for (const [i, c] of (film.modelCalls ?? []).entries()) {
    const a = ts(c.startedAt), b = ts(c.completedAt);
    let t = null;
    try { t = JSON.parse(c.response?.rawBody ?? "null")?.timings ?? null; } catch { t = null; }
    out.push({ i, wallMs: a != null && b != null ? b - a : null, timings: t, phase: callPhase(c), prompt: requestPrompt(c) });
  }
  return out;
}

/** Where the wall went: model vs harness, and the slow calls with their cache state. */
export function wallDecomposition(film, { slowMs = 10000 } = {}) {
  const calls = callTimings(film);
  const modelMs = calls.reduce((n, c) => n + (c.wallMs ?? 0), 0);
  const slow = calls.filter((c) => (c.wallMs ?? 0) >= slowMs)
    .map((c) => ({ call: c.i, wallMs: c.wallMs, cache_n: c.timings?.cache_n ?? null, prompt_n: c.timings?.prompt_n ?? null, gen_n: c.timings?.predicted_n ?? null }));
  const promptProcessed = calls.reduce((n, c) => n + (c.timings?.prompt_n ?? 0), 0);
  const generated = calls.reduce((n, c) => n + (c.timings?.predicted_n ?? 0), 0);
  return { calls: calls.length, modelMs, promptProcessed, generated, slow };
}

/** Prefix-reuse collapses: cache_n falling sharply while prompt_n balloons —
 * the checkpoint-or-nothing signature of a retroactive history rewrite. */
export function prefixBreaks(film) {
  const all = callTimings(film).filter((c) => c.timings);
  // Per-phase: think prompts and action prompts are different documents.
  const byPhase = new Map();
  for (const c of all) { const k = c.phase; if (!byPhase.has(k)) byPhase.set(k, []); byPhase.get(k).push(c); }
  const breaks = [];
  for (const [, calls] of byPhase) {
  let prevCache = null; let prevPrompt = "";
  for (const c of calls) {
    const cn = c.timings.cache_n ?? null, pn = c.timings.prompt_n ?? null;
    // A true collapse reprocesses roughly the LOST region: prompt_n on the
    // broken call ~= (prevCache - cn) + the turn's new content. (First
    // version demanded 4x the loss and missed the real timegrid break.)
    if (prevCache != null && cn != null && pn != null && cn < prevCache * 0.5 && pn > (prevCache - cn) * 0.9 && pn > 5000) {
      // Definitive check when the film carries prompts: a real rewrite means
      // this prompt does NOT byte-extend the previous same-phase prompt.
      let extended = null; let divergeAt = null;
      if (prevPrompt && c.prompt) {
        extended = c.prompt.startsWith(prevPrompt);
        if (!extended) { let k = 0; const n = Math.min(prevPrompt.length, c.prompt.length); while (k < n && prevPrompt[k] === c.prompt[k]) k += 1; divergeAt = k; }
      }
      if (extended !== true) breaks.push({ call: c.i, cache_n: cn, prevCache, prompt_n: pn, costMs: c.wallMs, phase: c.phase, ...(divergeAt != null ? { divergeAtChar: divergeAt, promptChars: c.prompt.length } : {}) });
    }
    if (cn != null) prevCache = Math.max(prevCache ?? 0, cn);
    if (c.prompt) prevPrompt = c.prompt;
  }
  }
  breaks.sort((x, y) => x.call - y.call);
  const gauged = film.metrics?.extensionPrefixBreaks ?? 0;
  return { detected: breaks, gaugedBreaks: gauged };
}

const RED_RE = /# fail [1-9]\d*|\bFAILED\b|AssertionError|\bnot ok\b|Traceback/;

/** Same-file patch chains inside red spans — the repour signature. */
export function thrashAudit(film, { threshold = 4 } = {}) {
  const chains = new Map(); let red = false; const spans = [];
  for (const t of film.turns ?? []) {
    const a = t.parsedAction ?? {}; const obs = String(t.observation ?? "");
    if (a.a === "shell" && /# (pass|fail)|not ok|passed|failed/.test(obs)) red = RED_RE.test(obs);
    if (a.a === "replace" && red) {
      const n = (chains.get(a.p) ?? 0) + 1; chains.set(a.p, n);
      if (n === threshold) spans.push({ path: a.p, reachedAtTurn: t.i ?? null });
    }
    if (a.a === "shell" && !red) chains.clear();
  }
  return { chains: [...chains.entries()].filter(([, n]) => n >= threshold).map(([p, n]) => ({ path: p, replaces: n })), spans };
}

/** Did fired stations change behavior? Advice that didn't compile is escalation fuel. */
export function steerEfficacy(film) {
  const m = film.metrics ?? {};
  const fired = Object.entries(m).filter(([k, v]) => /Steers|Notes|Arbitrations|Stops|Grants/.test(k) && Number(v) > 0)
    .map(([k, v]) => ({ metric: k, count: Number(v) }));
  const thrash = thrashAudit(film);
  const flags = [];
  if ((m.repourSteers ?? 0) > 0 && thrash.chains.length) {
    flags.push({ family: "ignored-advice", detail: `repour fired ${m.repourSteers}x yet same-file chains persisted (${thrash.chains.map((c) => `${c.path}:${c.replaces}`).join(", ")})` });
  }
  return { fired, flags };
}

/** Oracle strength: verifier configured? suite run? how big did self-tests get? */
export function oracleAudit(film) {
  const m = film.metrics ?? {};
  let suiteRuns = 0, lastCounts = null, probeOnly = 0;
  for (const t of film.turns ?? []) {
    const a = t.parsedAction ?? {}; const obs = String(t.observation ?? "");
    if (a.a === "shell" && /# pass \d+/.test(obs)) { suiteRuns += 1; lastCounts = /# pass (\d+)\n# fail (\d+)/.exec(obs.replace(/\r/g, "")) ?? lastCounts; }
    if (a.a === "shell" && /\b(?:python3?\s+-c|node\s+(?:-e|--eval))\b/.test(String(a.c ?? ""))) probeOnly += 1;
  }
  return { suiteRuns, probeOnly, lastPass: lastCounts ? Number(lastCounts[1]) : null, lastFail: lastCounts ? Number(lastCounts[2]) : null, verifyCadenceSteers: m.verifyCadenceSteers ?? 0 };
}

/** Think economics: budget pressure and truncation cost. */
export function thinkAudit(film) {
  const m = film.metrics ?? {};
  return { phases: m.thinkPhases ?? 0, truncations: m.thinkTruncations ?? 0, budget: m.thinkTokenBudget ?? null, grants: m.deepThinkGrants ?? 0 };
}
