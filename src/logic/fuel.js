// Fuel metering (P0 of the frontier-orchestration spec): read what the
// provider logs on THIS machine already record about quota state, with the
// basis and age stamped on every number. Doctrine (spec §6): measured and
// vendor-reported never blend; absent is not zero; a failed parse is
// NO-READING, never a stale number presented as fresh.
//
// Two regimes, deliberately different because the sources are:
//  - codex: rollout logs stream vendor-reported rate_limits snapshots
//    (used_percent, window, resets_at, plan). Authoritative for the account.
//  - claude: local session logs carry raw per-message token usage only.
//    There is NO vendor meter on disk, so the reading is measured token
//    volume on this machine, in trailing windows — an estimate of activity,
//    never a percentage of a plan we cannot see.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parse one codex rollout line; return a reading or null (not a snapshot). */
export function parseCodexRateLimitLine(line) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const p = d?.payload ?? d;
  const rl = p?.rate_limits ?? p?.info?.rate_limits;
  const prim = rl?.primary;
  if (!rl || typeof prim?.used_percent !== "number" || typeof prim?.resets_at !== "number") return null;
  return {
    provider: "codex",
    pool: rl.limit_id ?? "codex",
    usedPercent: prim.used_percent,
    windowMinutes: prim.window_minutes ?? null,
    resetsAt: new Date(prim.resets_at * 1000).toISOString(),
    plan: rl.plan_type ?? null,
    credits: rl.credits?.has_credits ? rl.credits.balance : null,
    basis: "vendor-reported (codex session log)",
    readAt: d?.timestamp ?? null,
  };
}

const TAIL_BYTES = 262144;

/** Newest codex reading across recent rollouts; NO-READING when none parses. */
export function latestCodexReading({
  sessionsDir = path.join(os.homedir(), ".codex", "sessions"),
  now = () => Date.now(),
  maxFiles = 8,
} = {}) {
  let files = [];
  try {
    const stack = [sessionsDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".jsonl")) files.push(full);
      }
    }
  } catch { return { status: "NO-READING", provider: "codex", reason: "no codex session logs found" }; }
  files = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, maxFiles);
  for (const { f } of files) {
    let text;
    try {
      const size = fs.statSync(f).size;
      const fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      fs.closeSync(fd);
      text = buf.toString("utf8");
    } catch { continue; }
    const lines = text.split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      const reading = parseCodexRateLimitLine(line);
      if (reading) {
        const ageMs = reading.readAt ? now() - Date.parse(reading.readAt) : null;
        return { status: "OK", ...reading, ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000) };
      }
      return { status: "NO-READING", provider: "codex", reason: "rate_limits present but format not understood (file an issue card; do not guess)" };
    }
  }
  return { status: "NO-READING", provider: "codex", reason: "no rate_limits snapshot in recent session logs" };
}

/** Measured claude token volume on THIS machine over a trailing window. */
export function claudeLocalUsage({
  projectsDir = path.join(os.homedir(), ".claude", "projects"),
  now = () => Date.now(),
  windowMs = 5 * 3600 * 1000,
} = {}) {
  const cutoff = now() - windowMs;
  const sums = { outputTokens: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, messages: 0 };
  const sessions = new Set();
  let sawAny = false;
  let files = [];
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, proj);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const full = path.join(dir, name);
        try { if (fs.statSync(full).mtimeMs >= cutoff) files.push(full); } catch { /* skip */ }
      }
    }
  } catch { return { status: "NO-READING", provider: "claude", reason: "no claude project logs found" }; }
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(d?.timestamp ?? "");
      const u = d?.message?.usage;
      if (!u || Number.isNaN(ts) || ts < cutoff) continue;
      sawAny = true;
      sums.outputTokens += u.output_tokens ?? 0;
      sums.inputTokens += u.input_tokens ?? 0;
      sums.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      sums.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      sums.messages += 1;
      sessions.add(f);
    }
  }
  return {
    status: sawAny ? "OK" : "NO-READING",
    provider: "claude",
    ...(sawAny ? { ...sums, sessions: sessions.size } : { reason: "no usage records in the window" }),
    windowHours: windowMs / 3600000,
    basis: "measured on this machine only (no vendor meter in local logs)",
    regime: "per-box estimate: other devices on the account are invisible here",
  };
}

/** The morning-report fuel block, rendered. */
export function renderFuelReport({ codex = latestCodexReading(), claude5h = claudeLocalUsage(), claude7d = claudeLocalUsage({ windowMs: 7 * 24 * 3600 * 1000 }) } = {}) {
  const lines = ["fuel — every number carries its basis; absent is not zero"];
  if (codex.status === "OK") {
    lines.push(`  codex (${codex.plan ?? "?"}): ${codex.usedPercent.toFixed(1)}% of ${Math.round((codex.windowMinutes ?? 0) / 1440)}d window used · resets ${codex.resetsAt}`);
    lines.push(`    basis: ${codex.basis} · reading age ${codex.ageSeconds}s`);
  } else {
    lines.push(`  codex: NO-READING — ${codex.reason}`);
  }
  for (const [label, r] of [["5h", claude5h], ["7d", claude7d]]) {
    if (r.status === "OK") {
      lines.push(`  claude (${label}, this box): ${r.outputTokens.toLocaleString()} out / ${(r.inputTokens + r.cacheCreationTokens).toLocaleString()} in+cache-write · ${r.messages.toLocaleString()} messages · ${r.sessions} session file(s)`);
    } else {
      lines.push(`  claude (${label}, this box): NO-READING — ${r.reason}`);
    }
  }
  lines.push(`    basis: ${claude5h.basis}; ${claude5h.regime}`);
  return lines.join("\n");
}

// ---- Morning report: the fuel block composed with what ran locally. ----

/** Local llama-server counters — the $0 side of the ledger. Injectable fetcher for tests. */
export async function localServerReading({
  endpoint = process.env.BANTAM_ENDPOINT || "http://127.0.0.1:8085",
  fetchText = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? r.text() : null; },
} = {}) {
  let metrics, props;
  try {
    metrics = await fetchText(`${endpoint.replace(/\/$/, "")}/metrics`);
    props = JSON.parse((await fetchText(`${endpoint.replace(/\/$/, "")}/props`)) ?? "null");
  } catch { /* fall through */ }
  if (!metrics) return { status: "NO-READING", provider: "local", reason: `no model server reachable at ${endpoint}` };
  const num = (name) => {
    const m = metrics.match(new RegExp(`^llamacpp:${name} ([0-9.e+]+)$`, "m"));
    return m ? Math.round(Number(m[1])) : null;
  };
  const promptTokens = num("prompt_tokens_total");
  const genTokens = num("tokens_predicted_total");
  if (promptTokens === null || genTokens === null) {
    return { status: "NO-READING", provider: "local", reason: "metrics format not understood (file an issue card; do not guess)" };
  }
  return {
    status: "OK", provider: "local",
    model: String(props?.model_path ?? "?").split("/").pop(),
    promptTokens, genTokens,
    basis: "llama-server counters since its last restart (restart resets them)",
  };
}

/** Run artifacts under the given roots with mtime in the window. */
export function localRunsInWindow({ roots = [process.cwd()], windowMs = 24 * 3600 * 1000, now = () => Date.now() } = {}) {
  const cutoff = now() - windowMs;
  let runs = 0, done = 0;
  for (const root of roots) {
    const dir = path.join(root, ".bantam", "runs");
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
        runs += 1;
        const d = JSON.parse(fs.readFileSync(full, "utf8"));
        const disp = d.disposition ?? (d.result?.reachedDone ? "done" : null);
        if (disp === "done") done += 1;
      } catch { /* unreadable artifact still counts as a run */ }
    }
  }
  return { runs, done, windowHours: windowMs / 3600000, basis: "run artifacts under the given workspace roots — not a global census" };
}

/** The whole morning line: local work vs metered frontier, bases everywhere. */
export async function renderMorningReport({ roots, endpoint } = {}) {
  const [server, fuelText] = [await localServerReading({ endpoint }), renderFuelReport()];
  const work = localRunsInWindow({ roots: roots ?? [process.cwd()] });
  const lines = ["morning report — local work first, metered frontier second", ""];
  if (server.status === "OK") {
    lines.push(`  local model (${server.model}): ${server.genTokens.toLocaleString()} tokens generated · ${server.promptTokens.toLocaleString()} prompt tokens processed · $0`);
    lines.push(`    basis: ${server.basis}`);
  } else {
    lines.push(`  local model: NO-READING — ${server.reason}`);
  }
  lines.push(`  runs (last ${work.windowHours}h, this workspace): ${work.runs} run(s), ${work.done} landed done`);
  lines.push(`    basis: ${work.basis}`);
  lines.push("");
  lines.push(fuelText);
  lines.push("");
  lines.push("  No dollar figure is invented for the local work: plans price tokens differently.");
  lines.push("  The honest sentence is: everything above the fuel block cost $0 and stayed on this machine.");
  return lines.join("\n");
}
