// run-timing.js — station wall-clock, from the artifact BANTAM already writes.
//
// A run reported two numbers: `tookMs` per turn and `durationMs` for the whole
// run. Both are true and neither is actionable. A 9-second turn might be nine
// seconds of prefill on a cold cache, or one second of model and eight of a test
// suite — the same number, opposite remedies. "Measure station wall-clock to
// find the next choke" needs the split, not the total.
//
// Nothing new has to be captured to get it. Turns already carry `tookMs` and
// `modelCallIndex`; model calls already carry `startedAt`/`completedAt` and the
// server's own `prompt_ms` / `predicted_ms`. This reads what is there:
//
//   total   = the run's wall clock
//   model   = time inside model calls (measured client-side, so it includes
//             queueing and transport, which is what an operator waits through)
//   prefill = the server's own prompt_ms — the part --ubatch-size governs
//   gen     = the server's own predicted_ms — the part tok/s governs
//   other   = total - model — actions and harness, the part BANTAM controls
//
// Stations rank on `other`, not on total: a station is not slow because the
// prompt before it was long.

const iso = (value) => {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Which model calls belong to which turn.
 *
 * A turn can issue more than one call — the thinking phase and the action are
 * separate completions — and `modelCallIndex` records the turn's LAST call, not
 * its first. So a turn owns everything after the previous turn's index, up to
 * and including its own.
 *
 * That was measured, not assumed. Attributing forward (from its own index to
 * the next turn's) put 28 of 100 turns over their own wall clock by 356s in
 * total; attributing backward leaves 3 turns over by 16s, the residue of
 * retries straddling a boundary. The forward reading also contradicts the data
 * directly: turn 0 carries index 1 and owns calls #0 and #1, whose 2326ms and
 * 588ms sum to its 3375ms.
 */
function callsForTurns(turns, calls) {
  const owned = new Map();
  const marked = turns.filter((t) => Number.isInteger(t?.modelCallIndex));
  for (let i = 0; i < marked.length; i += 1) {
    const to = marked[i].modelCallIndex;
    const from = i > 0 ? marked[i - 1].modelCallIndex : Number.NEGATIVE_INFINITY;
    owned.set(marked[i].i, calls.filter((c) => {
      const index = Number.isInteger(c?.index) ? c.index : null;
      return index !== null && index > from && index <= to;
    }));
  }
  return owned;
}

function callTiming(call) {
  const started = iso(call?.startedAt);
  const finished = iso(call?.completedAt);
  const timings = call?.response?.normalized?.timings ?? {};
  return {
    wallMs: started !== null && finished !== null ? Math.max(0, finished - started) : 0,
    prefillMs: num(timings.prompt_ms),
    genMs: num(timings.predicted_ms),
  };
}

/** The whole breakdown. Returns null when there is nothing to measure. */
export function analyzeRunTiming(artifact) {
  const turns = Array.isArray(artifact?.turns) ? artifact.turns : [];
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  if (!turns.length) return null;

  const owned = callsForTurns(turns, calls);
  const perTurn = turns.map((t) => {
    const mine = owned.get(t.i) ?? [];
    const timing = mine.map(callTiming);
    const modelMs = timing.reduce((sum, x) => sum + x.wallMs, 0);
    const tookMs = num(t.tookMs);
    return {
      i: t.i,
      verb: t?.parsedAction?.a ?? "(none)",
      tookMs,
      calls: mine.length,
      modelMs,
      prefillMs: timing.reduce((sum, x) => sum + x.prefillMs, 0),
      genMs: timing.reduce((sum, x) => sum + x.genMs, 0),
      // Never negative: a turn's model call can outlive the turn's own window
      // when a retry straddles the boundary.
      otherMs: Math.max(0, tookMs - modelMs),
    };
  });

  const sum = (key) => perTurn.reduce((acc, t) => acc + t[key], 0);
  // A run killed mid-flight (an agent timeout) is assembled from a checkpoint:
  // no turn carries tookMs and metrics.durationMs is absent. That is precisely
  // the run worth profiling, so fall back to the span the model calls actually
  // cover — first start to last finish — and SAY it is inferred.
  let totalMs = sum("tookMs");
  let estimated = false;
  if (!totalMs && calls.length) {
    const starts = calls.map((c) => iso(c?.startedAt)).filter((x) => x !== null);
    const ends = calls.map((c) => iso(c?.completedAt)).filter((x) => x !== null);
    if (starts.length && ends.length) {
      totalMs = Math.max(0, Math.max(...ends) - Math.min(...starts));
      estimated = true;
    }
  }
  // Per-turn `otherMs` is clamped at zero, so summing it would not reconcile
  // with the total when a call straddles a turn boundary — the shares would add
  // to more than 100%, which is how this attribution bug was caught in the
  // first place. The run-level split is derived from the totals instead.
  const modelMsTotal = Math.min(totalMs, sum("modelMs"));
  const overAttributed = perTurn.filter((t) => t.modelMs > t.tookMs).length;

  const byVerb = new Map();
  for (const t of perTurn) {
    const row = byVerb.get(t.verb) ?? { verb: t.verb, calls: 0, totalMs: 0, otherMs: 0 };
    row.calls += 1;
    row.totalMs += t.tookMs;
    row.otherMs += t.otherMs;
    byVerb.set(t.verb, row);
  }
  const stations = [...byVerb.values()]
    .map((row) => ({
      ...row,
      meanMs: Math.round(row.totalMs / row.calls),
      meanOtherMs: Math.round(row.otherMs / row.calls),
      pct: totalMs ? Math.round((100 * row.totalMs) / totalMs) : 0,
    }))
    .sort((a, b) => b.otherMs - a.otherMs || b.totalMs - a.totalMs);

  return {
    totalMs,
    modelMs: modelMsTotal,
    prefillMs: sum("prefillMs"),
    genMs: sum("genMs"),
    otherMs: Math.max(0, totalMs - modelMsTotal),
    overAttributed,
    estimated,
    turns: perTurn,
    stations,
    slowestTurns: [...perTurn].sort((a, b) => b.tookMs - a.tookMs).slice(0, 5),
  };
}

const secs = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
const share = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "0%");

/** The human report block, for `bantam runlens`. */
export function formatRunTiming(analysis) {
  if (!analysis) return [];
  const a = analysis;
  const out = [];
  out.push(`wall clock: ${secs(a.totalMs)} total${a.estimated ? "  (estimated from model-call timestamps — this run did not finish cleanly)" : ""}`);
  out.push(
    `  model  ${secs(a.modelMs).padStart(7)} (${share(a.modelMs, a.totalMs).padStart(3)})`
    + `  — prefill ${secs(a.prefillMs)} · generate ${secs(a.genMs)}`,
  );
  out.push(
    `  other  ${secs(a.otherMs).padStart(7)} (${share(a.otherMs, a.totalMs).padStart(3)})`
    + "  — actions and harness",
  );
  if (a.stations.length) {
    out.push("stations (ranked by time OUTSIDE the model — the part BANTAM controls):");
    for (const s of a.stations.slice(0, 8)) {
      out.push(
        `  ${String(s.verb).padEnd(12)} ×${String(s.calls).padEnd(3)}`
        + ` ${secs(s.totalMs).padStart(7)} total (${String(s.pct).padStart(2)}%)`
        + ` · ${secs(s.meanMs).padStart(6)} mean`
        + ` · ${secs(s.otherMs).padStart(7)} outside the model`,
      );
    }
  }
  if (a.slowestTurns.length) {
    const worst = a.slowestTurns
      .filter((t) => t.tookMs > 0)
      .map((t) => `t${t.i} ${t.verb} ${secs(t.tookMs)} (model ${secs(t.modelMs)})`);
    if (worst.length) out.push(`slowest turns: ${worst.join(" · ")}`);
  }
  return out;
}
