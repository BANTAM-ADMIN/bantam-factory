// governor.js — the spend governor (P1 of the frontier-orchestration spec).
//
// Frontier workers (codex errands, claude delegates) spend the operator's
// metered quota. The governor stands between any auto-spend path and the
// vendor: a kill switch the operator owns, reserve envelopes over the fuel
// gauge, and a quote line so every spend is announced before it happens.
//
// Two-inks doctrine applies: verdicts cite vendor-reported readings when one
// exists and say NO-READING when none does — the governor never invents a
// percentage. With no reading, policy decides (default: allow with an
// UNMETERED stamp; strict shops set onNoReading: "refuse").
//
// Precedence: kill switch > force > thresholds. The kill switch is the
// operator's hand on the belt — no flag argues with it.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_POLICY = {
  codex: {
    // Refuse auto-spend past these, leaving the rest as the operator's own
    // reserve. Readings carry ONE window; windowMinutes decides which cap.
    weeklyStopPct: 85,
    fiveHourStopPct: 70,
    warnMarginPct: 10, // within this of a cap -> allow, but say so
  },
  onNoReading: "warn", // "warn" | "refuse"
};

export function policyPath(root) { return path.join(root, ".bantam", "governor.json"); }
export function haltPath(root) { return path.join(root, ".bantam", "no-spend"); }

/** Operator policy: .bantam/governor.json shallow-merged over defaults. */
export function loadPolicy(root) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(policyPath(root), "utf8")); } catch { /* defaults */ }
  return {
    ...DEFAULT_POLICY,
    ...(raw ?? {}),
    codex: { ...DEFAULT_POLICY.codex, ...(raw?.codex ?? {}) },
  };
}

/** The kill switch: env beats file; either halts every auto-spend path. */
export function haltState(root, env = process.env) {
  if (env.BANTAM_NO_SPEND === "1") return { halted: true, source: "env BANTAM_NO_SPEND=1", note: null };
  try {
    const note = fs.readFileSync(haltPath(root), "utf8").trim();
    return { halted: true, source: haltPath(root), note: note || null };
  } catch { return { halted: false, source: null, note: null }; }
}

export function haltSpend(root, reason = "") {
  fs.mkdirSync(path.dirname(haltPath(root)), { recursive: true });
  fs.writeFileSync(haltPath(root), `${new Date().toISOString()} ${reason}`.trim() + "\n");
}

export function resumeSpend(root) {
  try { fs.rmSync(haltPath(root)); return true; } catch { return false; }
}

/** Which envelope a reading's window falls under. */
function capFor(policy, reading) {
  const mins = reading?.windowMinutes;
  if (typeof mins === "number" && mins >= 6000) return { cap: policy.codex.weeklyStopPct, window: "weekly" };
  return { cap: policy.codex.fiveHourStopPct, window: "5h" };
}

/**
 * The ruling. reading is latestCodexReading()'s result ({status:"OK",...} or
 * {status:"NO-READING",...}) or null when the gauge could not be consulted.
 */
export function governorVerdict({ policy = DEFAULT_POLICY, reading = null, halt = { halted: false }, force = false } = {}) {
  if (halt.halted) {
    return { allow: false, level: "halt", reasons: [`kill switch is on (${halt.source})${halt.note ? `: ${halt.note}` : ""}`], meter: null };
  }
  if (!reading || reading.status !== "OK") {
    const why = reading?.reason ?? "fuel gauge unavailable";
    if (policy.onNoReading === "refuse" && !force) {
      return { allow: false, level: "refuse", reasons: [`NO-READING (${why}) and policy says refuse unmetered spend`], meter: null };
    }
    return { allow: true, level: "unmetered", reasons: [`NO-READING (${why}) — spending unmetered${force ? " (forced)" : ""}`], meter: null };
  }
  const { cap, window } = capFor(policy, reading);
  const meter = `${window} window at ${reading.usedPercent.toFixed(1)}% (cap ${cap}%, resets ${reading.resetsAt})`;
  if (reading.usedPercent >= cap) {
    if (force) return { allow: true, level: "forced", reasons: [`OVER CAP and forced: ${meter}`], meter };
    return { allow: false, level: "refuse", reasons: [`${meter} — the rest is the operator's reserve`], meter };
  }
  if (reading.usedPercent >= cap - policy.codex.warnMarginPct) {
    return { allow: true, level: "warn", reasons: [`approaching cap: ${meter}`], meter };
  }
  return { allow: true, level: "ok", reasons: [meter], meter };
}

export function renderGovernorLine(v) {
  const badge = { ok: "⛽ governor: OK", warn: "⛽ governor: WARN", unmetered: "⛽ governor: UNMETERED",
    forced: "⛽ governor: FORCED", refuse: "⛔ governor: REFUSED", halt: "⛔ governor: HALTED" }[v.level] ?? "⛽ governor";
  return `${badge} — ${v.reasons.join("; ")}`;
}
