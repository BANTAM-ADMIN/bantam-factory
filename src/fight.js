// fight.js — the chicken-fight arena (operator order, 2026-08-19).
//
// Several harnesses take the same task in isolated workspaces, live and
// side-by-side: BANTAM and Hermes on the SAME local 27B (the direct
// harness-vs-harness comparison), Codex and Claude as frontier corners.
// One tiny no-dependency HTTP server streams every lane to a single static
// page over SSE; the postmortem records wall time, exit, and workspace
// artifacts per corner. Fairness carries over from the bake-off protocol:
// same task bytes, same materials, per-arm workspace isolation.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFightReplay } from "./fight-replay.js";
import { resolveCodexapiConfig } from "./codexapi-bridge.js";
import { loadUserSettings } from "./logic/user-settings.js";
import { readJsonFile } from "./json-file.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Rival-harness isolation homes. Overridable; default under ~/.bantam so a
// fresh checkout works without touching the operator's own hermes/opencode
// configuration (isolation is the point — see the arena notes in fight-season-1).
const ARENAS = process.env.BANTAM_ARENAS_DIR ?? path.join(os.homedir(), ".bantam", "arenas");
const HERMES_ARENA_HOME = process.env.BANTAM_HERMES_ARENA_HOME ?? path.join(ARENAS, "hermes", "home");
const OPENCODE_ARENA = process.env.BANTAM_OPENCODE_ARENA ?? path.join(ARENAS, "opencode");

function bridgeArm({ model, effort, corner, sub, color }) {
  return {
    pool: "cloud",
    corner, sub, color,
    cmd: ({ task }) => {
      const cfg = resolveCodexapiConfig({ env: process.env, settings: loadUserSettings() });
      return {
        exe: "node",
        args: [path.join(REPO, "bin", "bantam.js"), "run", "--task", task, "--workspace", ".", "--autonomous",
          "--api-url", cfg.url, ...(cfg.key ? ["--api-key", cfg.key] : []), "--api-dialect", "chat",
          "--model", `${model}:${effort}`, "--save-run=../run.json"],
        env: {
          BANTAM_PROMPT_TRAJECTORY: "extension",
          BANTAM_CHAT_BODY_EXTRA: process.env.BANTAM_CHAT_BODY_EXTRA || '{"chat_preamble":false}',
        },
      };
    },
  };
}

export const ARMS = {
  bantam: {
    pool: "local",
    corner: "BANTAM", sub: "this harness · local 27B", color: "#e0a458",
    cmd: ({ task }) => {
      const cfg = resolveCodexapiConfig({ env: process.env, settings: loadUserSettings() });
      return {
        // Headless run mode, NOT chat: an intermediate respond in chat hands
        // control back and the piped exit kills the session mid-plan (card 3,
        // 2026-08-19 — bantam bailed at 4.5s narrating its intentions).
        exe: "node", args: [path.join(REPO, "bin", "bantam.js"), "run", "--task", task, "--workspace", ".", "--autonomous", "--save-run=../run.json"],
        // Extension trajectory: the mode that keeps the local slot's prefix
        // reusable. Card 8R ran the rebuild default and cache_n sat at the head
        // checkpoint on 6 of 8 calls (45% reuse) — a harness setting, not the model.
        env: {
          BANTAM_ENDPOINT: "http://127.0.0.1:8085", BANTAM_PROMPT_TRAJECTORY: "extension",
          // A local comparison must not silently consume a cloud account.
          BANTAM_TEACHER: "0", BANTAM_TEACHER_CMD: "",
          // Wall decomposition, cards 16/17: green-path thinks cost 8.6 s of a
          // 33.4 s run; one failure think burned its full 4,096-token allowance
          // for 45.8 s. TRIM is the measured-safe dial; the cap bounds repair
          // thinks without disabling them.
          BANTAM_THINK_TRIM: "1", BANTAM_THINK_N_PREDICT: "1024",
        },
      };
    },
  },
  "bantam-research": {
    pool: "local",
    corner: "BANTAM+NET", sub: "this harness · homework capability armed", color: "#e0c26a",
    cmd: ({ task }) => ({
      exe: "node", args: [path.join(REPO, "bin", "bantam.js")],
      stdinText: `${task}\nexit\n`,
      env: { BANTAM_STREAM: "1", BANTAM_ENDPOINT: "http://127.0.0.1:8085", BANTAM_DEEPRESEARCH: "1" },
    }),
  },
  opencode: {
    pool: "local",
    corner: "OPENCODE", sub: "opencode · SAME local 27B", color: "#d48a9c",
    // Isolated XDG config (OPENCODE_ARENA/config/opencode/opencode.json points
    // provider `local` at http://127.0.0.1:8085/v1) — the operator's own
    // opencode config is never touched, mirroring HERMES_ARENA_HOME.
    cmd: ({ task }) => ({
      exe: "opencode",
      args: ["run", "-m", "local/qwen", task],
      env: {
        XDG_CONFIG_HOME: path.join(OPENCODE_ARENA, "config"),
        // Data and cache too: a data dir shared with the operator's own opencode
        // (auth.json, a WAL db that had taken a hard kill) hung every arena run
        // at init until fully isolated (2026-08-25).
        XDG_DATA_HOME: path.join(OPENCODE_ARENA, "data"),
        XDG_CACHE_HOME: path.join(OPENCODE_ARENA, "cache"),
      },
    }),
  },
  hermes: {
    pool: "local",
    corner: "HERMES", sub: "hermes-agent · SAME local 27B", color: "#7ec07a",
    cmd: ({ task }) => ({
      // --no-restore-cwd: 7R round 3 caught hermes restoring a repo-root cwd
      // from an earlier session's snapshot and running our own npm suite from
      // inside its lane. Home isolation does not cover cwd restoration.
      exe: "hermes", args: ["-z", task, "--yolo", "--no-restore-cwd"],
      env: { HERMES_HOME: HERMES_ARENA_HOME, HERMES_ARENA_KEY: "none" },
    }),
  },
  "bantam-codex": {
    pool: "cloud",
    corner: "BANTAM×CODEX SOL", sub: "bantam-constrained · codex app-server · gpt-5.6-sol, effort high", color: "#8ad4c2",
    cmd: ({ task }) => ({
      // The harness-isolating corner: the SAME model as the codex-sol arm, but
      // reached through BANTAM's constrained action loop instead of the raw CLI.
      // Side by side, the difference between them is the harness, not the model
      // (docs/WHY-BANTAM-MAKES-CODEX-EFFICIENT.md is the argument this corner
      // exists to test). It also lets a whole fight run with no local GPU.
      exe: "node",
      args: [path.join(REPO, "bin", "bantam.js"), "run", "--task", task,
        "--workspace", ".", "--autonomous", "--codex", "--model", "gpt-5.6-sol", "--codex-effort", "high", "--save-run=../run.json"],
      env: { BANTAM_PROMPT_TRAJECTORY: "extension" },
    }),
  },
  // The bridge corners: the SAME models as the app-server corner, reached over
  // HTTP through codexapi (chat dialect, sessions held open, extension
  // trajectory so every turn is a delta). Beside bantam-codex the difference is
  // the transport; beside each other it is the model.
  "bantam-codexapi-spark": bridgeArm({ model: "gpt-5.3-codex-spark", effort: "low", corner: "BANTAM×SPARK", sub: "bantam-constrained · codexapi bridge · spark:low", color: "#f0c987" }),
  "bantam-codexapi-luna": bridgeArm({ model: "gpt-5.6-luna", effort: "medium", corner: "BANTAM×LUNA", sub: "bantam-constrained · codexapi bridge · luna:medium", color: "#9ad4f0" }),
  "bantam-codexapi-terra": bridgeArm({ model: "gpt-5.6-terra", effort: "medium", corner: "BANTAM×TERRA", sub: "bantam-constrained · codexapi bridge · terra:medium", color: "#a8e0a0" }),
  "bantam-codexapi-sol": bridgeArm({ model: "gpt-5.6-sol", effort: "high", corner: "BANTAM×SOL", sub: "bantam-constrained · codexapi bridge · sol:high", color: "#c9a0f0" }),
  "codex-sol": {
    pool: "cloud",
    corner: "CODEX CLI", sub: "raw codex CLI agent · gpt-5.6-sol, default effort — its own loop and tools", color: "#6aa0e0",
    cmd: ({ task }) => ({
      exe: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-m", "gpt-5.6-sol", task],
    }),
  },
  "bantam-codex-astra": {
    pool: "cloud",
    corner: "BANTAM×ASTRA", sub: "bantam-constrained · Codex app-server · gpt-6-astra, medium", color: "#8ad4c2",
    cmd: ({ task }) => ({
      exe: "node",
      args: [path.join(REPO, "bin", "bantam.js"), "run", "--task", task,
        "--workspace", ".", "--autonomous", "--codex", "--model", "gpt-6-astra",
        "--codex-effort", "medium", "--max-turns", "60", "--save-run=../run.json"],
      env: {
        BANTAM_PROMPT_TRAJECTORY: "extension", BANTAM_IMMUTABLE_HISTORY: "1",
        BANTAM_DECISION_SNAPSHOT: "0", BANTAM_EXTENSION_WORKING_SET: "0", BANTAM_TEACHER: "0",
      },
    }),
  },
  "codex-astra": {
    pool: "cloud",
    corner: "CODEX ASTRA", sub: "native Codex CLI tools · gpt-6-astra, medium", color: "#6aa0e0",
    cmd: ({ task }) => ({
      exe: "codex",
      args: ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
        "--ignore-rules", "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="medium"',
        "-c", 'web_search="disabled"', "--sandbox", "workspace-write", "--json", task],
    }),
  },
  "bantam-local-27b": {
    pool: "local",
    corner: "BANTAM 27B", sub: "local Qwen 27B · extension · no cloud teacher", color: "#e0a458",
    cmd: ({ task }) => ({
      exe: "node",
      args: [path.join(REPO, "bin", "bantam.js"), "run", "--task", task,
        "--workspace", ".", "--autonomous", "--endpoint", "http://127.0.0.1:8085", "--profile", "qwen",
        "--max-turns", "60", "--save-run=../run.json"],
      env: { BANTAM_PROMPT_TRAJECTORY: "extension", BANTAM_IMMUTABLE_HISTORY: "1",
        BANTAM_DECISION_SNAPSHOT: "0", BANTAM_EXTENSION_WORKING_SET: "0", BANTAM_TEACHER: "0" },
    }),
  },
  "claude-sonnet": claudeArm({ model: "sonnet", corner: "CLAUDE", sub: "sonnet · claude code CLI", color: "#b98ad4" }),
  "claude-opus": claudeArm({ model: "opus", corner: "CLAUDE OPUS", sub: "opus · claude code CLI", color: "#a078c8" }),
  "claude-fable": claudeArm({ model: "fable", corner: "CLAUDE FABLE", sub: "fable · claude code CLI", color: "#8f68bc" }),
};

/** The claude-cli corners share one shape; only the model differs (sweep 2026-08-25: 18/18 sealed EXACT). */
function claudeArm({ model, corner, sub, color }) {
  return {
    pool: "cloud",
    corner, sub, color,
    cmd: ({ task }) => ({
      exe: "claude", args: ["-p", task, "--model", model, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    }),
    transform: parseClaudeStreamLine,
  };
}

/**
 * The roster: every registered arm with a live availability probe, for the
 * corner picker. Probes are cheap and parallel: an exe on PATH for CLI
 * corners, the local 27B /health for same-weights corners, the bridge URL
 * for codexapi corners. A missing corner stays listed — visibly out — so the
 * picker teaches what COULD fight, not just what can.
 */
export async function armsRoster() {
  const hasExe = (exe) => { try { execFileSync("which", [exe], { stdio: "ignore" }); return true; } catch { return false; } };
  const probe = async (url) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
      return r.ok;
    } catch { return false; }
  };
  const local = await probe("http://127.0.0.1:8085/health");
  let bridge = false, bridgeWhy = "bridge not configured";
  try {
    const cfg = resolveCodexapiConfig({ env: process.env, settings: loadUserSettings() });
    if (cfg?.url) { bridge = await probe(`${cfg.url.replace(/\/$/, "")}/models`).catch(() => false) || await probe(cfg.url); bridgeWhy = bridge ? "" : `bridge at ${cfg.url} not answering`; }
  } catch { /* stays unavailable */ }
  return Object.entries(ARMS).map(([name, def]) => {
    let available = true, why = "";
    if (name === "bantam" || name === "bantam-research" || name === "bantam-local-27b") { available = local; why = local ? "" : "local 27B at :8085 not answering"; }
    else if (name === "hermes") { available = local && hasExe("hermes"); why = !hasExe("hermes") ? "hermes not on PATH" : (local ? "" : "local 27B at :8085 not answering"); }
    else if (name === "opencode") { available = local && hasExe("opencode"); why = !hasExe("opencode") ? "opencode not on PATH" : (local ? "" : "local 27B at :8085 not answering"); }
    else if (name.startsWith("bantam-codexapi")) { available = bridge; why = bridgeWhy; }
    else if (name === "bantam-codex" || name.startsWith("bantam-codex-") || name.startsWith("codex")) { available = hasExe("codex"); why = available ? "" : "codex not on PATH"; }
    else if (name.startsWith("claude")) { available = hasExe("claude"); why = available ? "" : "claude not on PATH"; }
    return { name, pool: def.pool, corner: def.corner, sub: def.sub, available, why };
  });
}

/** Claude's stream-json lines → human text; null hides pure plumbing. */
export function parseClaudeStreamLine(line) {
  let d;
  try { d = JSON.parse(line); } catch { return line.trim() || null; }
  if (d.type === "assistant") {
    const parts = [];
    for (const c of d.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) parts.push(c.text.trim());
      if (c.type === "tool_use") parts.push(`⏵ ${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 120)})`);
    }
    return parts.join("\n") || null;
  }
  if (d.type === "result") return `— result (${d.subtype ?? "done"}): ${(d.result ?? "").slice(0, 400)}`;
  return null;
}

export function buildArmCommand(name, { task }) {
  const def = ARMS[name];
  if (!def) throw new Error(`unknown arm "${name}" (have: ${Object.keys(ARMS).join(", ")})`);
  return { name, pool: def.pool ?? "cloud", corner: def.corner, sub: def.sub, color: def.color, transform: def.transform ?? null, ...def.cmd({ task }) };
}

export function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Everything a lane produced, measured — the scoreboard's raw material. */
export function assemblePostmortem({ task, startedAt, results }) {
  return {
    task, startedAt, finishedAt: new Date().toISOString(),
    corners: results.map((r) => ({
      arm: r.arm, wallMs: r.wallMs, exitCode: r.exitCode,
      lines: r.lines, artifacts: r.artifacts,
      ...(r.usage ? { usage: r.usage } : {}),
    })),
  };
}

/**
 * What the corner produced: files new or changed since the bell. With
 * materials copied in, mtime alone counts the whole package (card 11: every
 * corner "72 artifacts"), so a file identical to its material is not one.
 */
export function listArtifacts(ws, sinceMs, { materialsDir = null } = {}) {
  const sameAsMaterial = (rel, full) => {
    if (!materialsDir) return false;
    try {
      const a = fs.readFileSync(full);
      const b = fs.readFileSync(path.join(materialsDir, rel));
      return a.length === b.length && a.equals(b);
    } catch { return false; }
  };
  const out = [];
  const stack = [ws];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      try {
        const st = fs.statSync(full);
        const rel = path.relative(ws, full);
        if (st.mtimeMs >= sinceMs && !sameAsMaterial(rel, full)) out.push({ path: rel, bytes: st.size });
      } catch { /* raced */ }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Run the fight. Resolves with the postmortem once every corner exits.
 * The server keeps serving the final state until stop() is called.
 */
export function startFight({ task, arms, materialsDir = null, dir = null, port = 8377, narrate = true, onEvent = () => {} }) {
  const fightDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fight-"));
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const clients = new Set();
  const history = [];
  const cmds = arms.map((a) => buildArmCommand(a, { task }));

  const broadcast = (evt) => {
    const frame = sseFrame(evt);
    history.push(frame);
    for (const res of clients) res.write(frame);
    onEvent(evt);
  };

  const page = renderFightPage({ task, cmds });
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      for (const frame of history) res.write(frame);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  });
  server.listen(port);

  const results = [];
  const runArm = (c) => new Promise((resolve) => {
    const ws = path.join(fightDir, c.name, "ws");
    fs.mkdirSync(ws, { recursive: true });
    if (materialsDir) fs.cpSync(materialsDir, ws, { recursive: true });
    const armT0 = Date.now();
    broadcast({ arm: c.name, kind: "status", text: "fighting", t: 0 });
    // cwd alone is not enough: spawn inherits the driver's stale $PWD, and a
    // harness that trusts $PWD (opencode, card 12) then works the wrong tree.
    const child = spawn(c.exe, c.args, { cwd: ws, env: { ...process.env, PWD: ws, ...(c.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    if (c.stdinText) child.stdin.write(c.stdinText);
    child.stdin.end();
    let lineCount = 0;
    let buf = "";
    const rawLines = [];   // the tail of the corner's raw output, for usage probes
    const onChunk = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        rawLines.push(raw);
        if (rawLines.length > 600) rawLines.splice(0, rawLines.length - 600);
        const text = c.transform ? c.transform(raw) : (raw.trimEnd() || null);
        if (text) {
          lineCount++;
          broadcast({ arm: c.name, kind: "line", text: text.slice(0, 2000), t: Date.now() - armT0 });
        }
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("close", async (code) => {
      const wallMs = Date.now() - armT0;
      const artifacts = listArtifacts(ws, armT0 - 1000, { materialsDir });
      let usage = null;
      try { usage = await readCornerUsage(c.name, { armDir: path.dirname(ws), rawLines }); } catch { /* usage is evidence, never a blocker */ }
      results.push({ arm: c.name, wallMs, exitCode: code, lines: lineCount, artifacts, usage });
      broadcast({ arm: c.name, kind: "done", text: `finished — exit ${code}, ${(wallMs / 1000).toFixed(1)}s, ${artifacts.length} artifact(s)`, t: wallMs, wallMs, exitCode: code, artifacts });
      resolve();
    });
  });
  const cloud = cmds.filter((c) => c.pool !== "local");
  const locals = cmds.filter((c) => c.pool === "local");
  for (const c of locals.slice(1)) broadcast({ arm: c.name, kind: "status", text: "waiting for the ring (locals fight one at a time — full window each)", t: 0, queued: true });
  const done = Promise.all([
    ...cloud.map(runArm),
    (async () => { for (const c of locals) await runArm(c); })(),
  ]).then(() => {
    const post = assemblePostmortem({ task, startedAt, results });
    // Pin the harness build the card was fought on: "build <sha> tops the
    // field" stays defensible forever; an unpinned claim does not.
    try { post.build = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8", timeout: 5000 }).trim(); } catch { post.build = null; }
    fs.writeFileSync(path.join(fightDir, "fight.json"), JSON.stringify(post, null, 1));
    fs.writeFileSync(path.join(fightDir, "events.ndjson"), history.map((f) => f.slice(6).trimEnd()).join("\n"));
    // Every fight ships its replayable card automatically — the product, not a lab step.
    try { writeFightReplay({ fightDir, post }); } catch { /* replay page is best-effort */ }
    const laneText = {};
    for (const frame of history) {
      try { const e = JSON.parse(frame.slice(6)); if (e.kind === "line") laneText[e.arm] = (laneText[e.arm] ?? "") + e.text + "\n"; } catch { /* chrome */ }
    }
    let verdicts = {};
    try { verdicts = judgeFight({ fightDir, cmds, post, materialsDir }); } catch { /* card falls back to exit codes */ }
    post.verdicts = verdicts;
    return (narrate ? narratePostmortem({ task, cmds, post, verdicts, laneText }).catch(() => null) : Promise.resolve(null)).then((narrative) => {
      let card = null;
      try { card = finalizeFightCard({ fightDir, task, cmds, history, post, verdicts, narrative: narrative ?? undefined }); } catch { /* the live page and json remain */ }
      post.card = card;
      // The scoreboard: wall, turns, tokens, prefix reuse, success — one table
      // above the verdicts, from each corner's own evidence.
      try {
        const board = renderScoreboard(post, cmds, { verdicts });
        fs.writeFileSync(path.join(fightDir, "scoreboard.json"), JSON.stringify(post.corners.map((x) => ({ arm: x.arm, wallMs: x.wallMs, exitCode: x.exitCode, verdict: verdicts[x.arm]?.outcome ?? null, usage: x.usage ?? null })), null, 1));
        if (card) fs.writeFileSync(card, injectScoreboard(fs.readFileSync(card, "utf8"), board));
      } catch { /* the card stands without the table */ }
      fs.writeFileSync(path.join(fightDir, "fight.json"), JSON.stringify(post, null, 1));
      broadcast({ arm: "*", kind: "over", text: "fight over", post });
      return post;
    });
  });

  return { fightDir, port, done, stop: () => { server.close(); for (const r of clients) r.end(); } };
}

/** The fight card page — self-contained, dark, one lane per corner. */
export function renderFightPage({ task, cmds }) {
  const lanes = cmds.map((c) => `
    <section class="lane" id="lane-${c.name}" style="--c:${c.color}">
      <header><b>${c.corner}</b><span class="sub">${c.sub}</span><span class="chip" id="chip-${c.name}">waiting</span><span class="clock" id="clock-${c.name}">0:00</span></header>
      <pre id="log-${c.name}"></pre>
    </section>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Fight Card</title>
<style>
  :root { color-scheme: dark; --ink:#d8d4cc; --dim:#8a8578; --faint:#5a564e; --plume:#e0a458; --bg:#0e0e11; --panel:#15151b; --line:#26262e; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--ink); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; padding:18px; }
  .mast { display:flex; gap:16px; align-items:flex-end; flex-wrap:wrap; }
  .wordmark { color:var(--plume); font-size:8.5px; line-height:1.05; letter-spacing:0; white-space:pre; }
  .mast .r { color:var(--dim); font-size:12px; }
  .mast .r b { color:var(--ink); letter-spacing:.14em; }
  .rooster { color:var(--plume); }
  .task { color:var(--dim); margin:12px 0 4px; max-width:110ch; white-space:pre-wrap; }
  .task::before { content:"work order · "; color:var(--faint); letter-spacing:.08em; }
  .meta { color:var(--faint); font-size:11px; margin-bottom:14px; }
  h2 { font-size:11px; letter-spacing:.14em; color:var(--plume); margin:18px 0 8px; font-weight:normal; }
  h2::before { content:"── "; color:var(--line); } h2::after { content:" ──"; color:var(--line); }
  .verdicts { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; margin:14px 0 4px; }
  .verdict { border:1px solid var(--line); border-left:4px solid var(--c); background:var(--panel); border-radius:4px; padding:9px 11px; }
  .verdict b { color:var(--c); display:block; letter-spacing:.08em; font-size:12px; }
  .v-label { font-weight:bold; font-size:14px; letter-spacing:.04em; }
  .verdict.win .v-label::before { content:"✔ "; } .verdict.fail .v-label::before { content:"✗ "; } .verdict.partial .v-label::before { content:"⚠ "; }
  .verdict.win .v-label { color:#7ec07a; } .verdict.fail .v-label { color:#e07a6a; } .verdict.partial .v-label { color:#e0c26a; }
  .v-why { display:block; color:var(--dim); font-size:11px; margin-top:3px; }
  .story { color:#c2bcb0; max-width:100ch; margin-bottom:10px; }
  .accounts { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:8px; }
  .account { border:1px solid var(--line); border-left:3px solid var(--c); border-radius:4px; padding:8px 10px; background:#121218; }
  .account b { color:var(--c); font-size:11px; letter-spacing:.08em; }
  .account p { color:#a8a296; font-size:12px; margin-top:4px; }
  .note { color:var(--faint); font-size:10.5px; margin-top:10px; max-width:100ch; }
  .note::before { content:"· "; }
  .card { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:10px; }
  .lane { border:1px solid var(--line); border-top:3px solid var(--c); background:var(--panel); border-radius:4px; min-width:0; }
  summary { display:flex; gap:8px; align-items:baseline; padding:8px 10px; cursor:pointer; list-style:none; }
  summary::before { content:"▸ "; color:var(--faint); } details[open] summary::before { content:"▾ "; }
  .lane b { color:var(--c); letter-spacing:.08em; }
  .sub { color:var(--dim); font-size:11px; flex:1; }
  .chip { font-size:10px; padding:1px 7px; border-radius:3px; background:#26262e; }
  .chip.done { background:#1f3320; color:#7ec07a; } .chip.fail { background:#3a2020; color:#e07a6a; }
  .dl { color:#8ab4d8; font-size:11px; text-decoration:none; border:1px solid #2a3a4a; border-radius:3px; padding:1px 8px; }
  .arts { color:var(--dim); font-size:11px; padding:6px 10px; border-bottom:1px solid #1e1e26; }
  pre { max-height:70vh; overflow:auto; padding:8px 10px; white-space:pre-wrap; word-break:break-word; font-size:11.5px; color:#aaa49a; }
</style>
<h1>🐓 FIGHT CARD</h1>
<div class="task">${escapeHtml(task)}</div>
<div class="card">${lanes}</div>
<div id="over"><b style="color:#7ec07a">FIGHT OVER</b><table id="score"></table></div>
<script>
  const t0 = {}, timers = {};
  function fmt(ms) { const s = Math.floor(ms/1000); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); }
  const es = new EventSource("/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "status") {
      t0[e.arm] = Date.now();
      document.getElementById("chip-"+e.arm).textContent = e.text;
      document.getElementById("chip-"+e.arm).className = "chip fighting";
      timers[e.arm] = setInterval(() => { document.getElementById("clock-"+e.arm).textContent = fmt(Date.now()-t0[e.arm]); }, 1000);
    } else if (e.kind === "line") {
      const log = document.getElementById("log-"+e.arm);
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
      log.textContent += e.text + "\\n";
      if (stick) log.scrollTop = log.scrollHeight;
    } else if (e.kind === "done") {
      clearInterval(timers[e.arm]);
      const chip = document.getElementById("chip-"+e.arm);
      chip.textContent = "exit "+e.exitCode+" · "+fmt(e.wallMs);
      chip.className = "chip " + (e.exitCode === 0 ? "done" : "fail");
    } else if (e.kind === "over") {
      const over = document.getElementById("over");
      over.style.display = "block";
      const rows = e.post.corners.map(c =>
        "<tr><td><b>"+c.arm+"</b></td><td>"+fmt(c.wallMs)+"</td><td>exit "+c.exitCode+"</td><td>"+c.lines+" lines</td><td>"+c.artifacts.length+" artifact(s): "+c.artifacts.map(a=>a.path).join(", ").slice(0,140)+"</td></tr>");
      document.getElementById("score").innerHTML = "<tr><th>corner</th><th>wall</th><th>exit</th><th>output</th><th>artifacts</th></tr>" + rows.join("");
    }
  };
</script>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * Compose the fight brief from the live conversation: the operator fires
 * :fight mid-chat, and every corner receives the SAME bytes — recent session
 * context plus the current request. Fairness is the whole point: no corner
 * sees more than another.
 */
export function composeFightBrief({ sessionLog = [], request }) {
  const recent = sessionLog.slice(-6);
  const ctx = recent.length
    ? "CONTEXT — prior work in this conversation:\n" + recent.map((e, i) =>
        `${i + 1}. asked: ${String(e.request ?? "").slice(0, 200)} → outcome: ${String(e.summary ?? "").slice(0, 260)}`).join("\n") + "\n\n"
    : "";
  return `${ctx}TASK: ${request}`;
}

/**
 * The finished object (operator design, 2026-08-19): when a fight ends it
 * becomes ONE static HTML file — task, full lane transcripts, scorecard, and
 * every corner's built workspace embedded as a real downloadable zip (data
 * URI, no server, no libraries). A fight card you can share, save, or open
 * in a year.
 */
export function finalizeFightCard({ fightDir, task, cmds, history, post, ...opts }) {
  const laneText = {};
  for (const frame of history) {
    try {
      const e = JSON.parse(frame.slice(6));
      if (e.kind === "line") laneText[e.arm] = (laneText[e.arm] ?? "") + e.text + "\n";
    } catch { /* frame chrome */ }
  }
  const zips = {};
  for (const c of cmds) {
    const ws = path.join(fightDir, c.name, "ws");
    const zipPath = path.join(fightDir, `${c.name}.zip`);
    try {
      execFileSync("python3", ["-m", "zipfile", "-c", zipPath, ws], { timeout: 30000 });
      const buf = fs.readFileSync(zipPath);
      if (buf.length < 8 * 1024 * 1024) zips[c.name] = buf.toString("base64");
    } catch { /* corner keeps its transcript; zip is best-effort */ }
  }
  const verdicts = opts.verdicts ?? {};
  const narrative = opts.narrative ?? { accounts: {}, overall: null };
  const banner = cmds.map((c) => {
    const v = verdicts[c.name];
    const corner = post.corners.find((x) => x.arm === c.name);
    const cls = v ? v.outcome.toLowerCase() : (corner?.exitCode === 0 ? "win" : "fail");
    const label = v ? v.outcome : (corner?.exitCode === 0 ? "FINISHED" : "FAILED");
    return `<div class="verdict ${cls}" style="--c:${c.color}">
      <b>${c.corner}</b><span class="v-label">${label}</span>
      <span class="v-why">${escapeHtml(v?.reason ?? "")}</span>
    </div>`;
  }).join("\n");
  const story = (narrative.overall || Object.values(narrative.accounts ?? {}).some(Boolean)) ? `
  <h2>🐓 THE FIGHT, IN PLAIN LANGUAGE</h2>
  ${narrative.overall ? `<p class="story">${escapeHtml(narrative.overall)}</p>` : ""}
  <div class="accounts">${cmds.map((c) => narrative.accounts?.[c.name] ? `
    <div class="account" style="--c:${c.color}"><b>${c.corner}</b><p>${escapeHtml(narrative.accounts[c.name])}</p></div>` : "").join("")}</div>
  <p class="note">Verdicts above are mechanical — the judge reran every suite itself and checked provided tests against material hashes. This section is narrative, written by the house reporter (the local model), and never affects scoring.</p>` : "";
  const lanes = cmds.map((c) => {
    const corner = post.corners.find((x) => x.arm === c.name);
    const zip = zips[c.name];
    return `<details class="lane" style="--c:${c.color}">
      <summary><b>${c.corner}</b><span class="sub">${c.sub}</span>
        <span class="chip ${corner?.exitCode === 0 ? "done" : "fail"}">${corner ? `exit ${corner.exitCode} · ${(corner.wallMs / 1000).toFixed(1)}s` : "?"}</span>
        ${zip ? `<a class="dl" download="${c.name}-workspace.zip" href="data:application/zip;base64,${zip}">⬇ workspace.zip</a>` : ""}
      </summary>
      <div class="arts">${(corner?.artifacts ?? []).map((a) => `${escapeHtml(a.path)} (${a.bytes}b)`).join(" · ") || "no artifacts"}</div>
      <pre>${escapeHtml((laneText[c.name] ?? "").slice(0, 200000))}</pre>
    </details>`;
  }).join("\n");
  const wordmark = [
    "██████╗  █████╗ ███╗   ██╗████████╗ █████╗ ███╗   ███╗",
    "██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██╔══██╗████╗ ████║",
    "██████╔╝███████║██╔██╗ ██║   ██║   ███████║██╔████╔██║",
    "██╔══██╗██╔══██║██║╚██╗██║   ██║   ██╔══██║██║╚██╔╝██║",
    "██████╔╝██║  ██║██║ ╚████║   ██║   ██║  ██║██║ ╚═╝ ██║",
    "╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝     ╚═╝",
  ].join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Fight Card — ${escapeHtml(new Date(post.startedAt).toISOString().slice(0, 16))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing:border-box; margin:0; }
  body { background:#101014; color:#d8d4cc; font:13px/1.45 ui-monospace,monospace; padding:16px; }
  h1 { font-size:15px; letter-spacing:.08em; color:#e8e4da; }
  .task { color:#8a8578; margin:6px 0 6px; max-width:110ch; white-space:pre-wrap; }
  .meta { color:#5a564e; font-size:11px; margin-bottom:14px; }
  .card { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:10px; }
  .lane { border:1px solid #26262e; border-top:3px solid var(--c); background:#15151b; border-radius:6px; min-width:0; }
  .lane header { display:flex; gap:8px; align-items:baseline; padding:8px 10px; border-bottom:1px solid #22222a; flex-wrap:wrap; }
  .lane b { color:var(--c); letter-spacing:.06em; }
  .sub { color:#77726a; font-size:11px; flex:1; }
  .chip { font-size:10px; padding:1px 7px; border-radius:8px; background:#26262e; }
  .chip.done { background:#1f3320; color:#7ec07a; } .chip.fail { background:#3a2020; color:#e07a6a; }
  .dl { color:#8ab4d8; font-size:11px; text-decoration:none; border:1px solid #2a3a4a; border-radius:6px; padding:1px 8px; }
  .arts { color:#77726a; font-size:11px; padding:6px 10px; border-bottom:1px solid #1e1e26; }
  .verdicts { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; margin:12px 0; }
  .verdict { border:1px solid #26262e; border-left:4px solid var(--c); background:#15151b; border-radius:6px; padding:8px 10px; }
  .verdict b { color:var(--c); display:block; letter-spacing:.06em; }
  .v-label { font-weight:bold; font-size:14px; }
  .verdict.win .v-label { color:#7ec07a; } .verdict.fail .v-label { color:#e07a6a; } .verdict.partial .v-label { color:#e0c26a; }
  .v-why { display:block; color:#8a8578; font-size:11px; margin-top:2px; }
  h2 { font-size:12px; letter-spacing:.1em; color:#a89f8e; margin:16px 0 6px; }
  .story { color:#c8c3b8; max-width:100ch; margin-bottom:10px; }
  .accounts { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:8px; }
  .account { border:1px solid #22222a; border-left:3px solid var(--c); border-radius:6px; padding:8px 10px; background:#13131a; }
  .account b { color:var(--c); font-size:11px; letter-spacing:.06em; }
  .account p { color:#aaa49a; font-size:12px; margin-top:4px; }
  .note { color:#5a564e; font-size:10.5px; margin-top:8px; max-width:100ch; }
  summary { display:flex; gap:8px; align-items:baseline; padding:8px 10px; cursor:pointer; list-style:none; }
  summary::before { content:"▸ "; color:#5a564e; } details[open] summary::before { content:"▾ "; }
  pre { max-height:70vh; overflow:auto; padding:8px 10px; white-space:pre-wrap; word-break:break-word; font-size:11.5px; color:#b8b3a8; }
</style>
<div class="mast">
<pre class="wordmark">${wordmark}</pre>
<div class="r"><span class="rooster">( o› )</span> <b>FIGHT CARD</b><br>a scrappy little terminal agent · exhibition bout</div>
</div>
<div class="task">${escapeHtml(task)}</div>
<div class="meta">fought ${escapeHtml(post.startedAt)} → ${escapeHtml(post.finishedAt)} · verdicts mechanical, transcripts and workspaces embedded · single file, save or share as-is</div>
<div class="verdicts">${banner}</div>
${story}
<h2>🧾 FULL TRANSCRIPTS & WORKSPACES</h2>
<div class="card">${lanes}</div>`;
  const out = path.join(fightDir, "fight-card.html");
  fs.writeFileSync(out, html);
  return out;
}


/**
 * Mechanical verdicts — the judge trusts nothing a corner claimed. Reruns
 * the corner's own test suite in its workspace, checks test files against
 * the material hashes when materials were provided, and rules WIN / PARTIAL
 * / FAIL with a one-line reason a reader can verify.
 */
// Provided test files whose bytes a corner must not change, hashed from the
// materials. Covers pytest (test_*.py at the root) and Node (anything under
// test/), so a JS-package fight is judged like a python one.
function materialTestHashes(materialsDir) {
  const hashes = new Map();
  if (!materialsDir) return hashes;
  const add = (rel) => {
    try { hashes.set(rel, crypto.createHash("sha256").update(fs.readFileSync(path.join(materialsDir, rel))).digest("hex")); } catch { /* skip */ }
  };
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(materialsDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name === "test" || e.name === "tests" || !rel) walk(child); }
      else if (/^test_.*\.py$/.test(e.name) || /\.test\.[cm]?js$/.test(e.name) || rel.startsWith("test")) add(child);
    }
  };
  walk("");
  return hashes;
}

/** Run the corner's own suite: `npm test` for a Node package, else pytest. */
function runCornerSuite(ws) {
  let hasNode = false;
  try { hasNode = JSON.parse(fs.readFileSync(path.join(ws, "package.json"), "utf8"))?.scripts?.test != null; } catch { /* no package */ }
  const hasPy = (() => { try { return fs.readdirSync(ws).some((f) => /^test_.*\.py$/.test(f)); } catch { return false; } })();
  // The child suite must not inherit a parent node --test's context, or its own
  // `node --test` sees itself nested and skips ("run() called recursively"),
  // leaving no result to judge. Strip the test-runner env for the child.
  const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...cleanEnv } = process.env;
  const grab = (fn) => { try { return fn(); } catch (e) { return String(e.stdout ?? e.message); } };
  if (hasNode) {
    // node --test's summary is the "# tests/# pass/# fail" block, not the last line.
    const out = grab(() => execFileSync("npm", ["test", "--silent"], { cwd: ws, encoding: "utf8", timeout: 180000, env: cleanEnv }));
    const pass = /# pass (\d+)/.exec(out)?.[1]; const fail = /# fail (\d+)/.exec(out)?.[1];
    return pass != null ? `pass ${pass} · fail ${fail ?? "?"}` : null;
  }
  if (hasPy) return grab(() => execFileSync("python3", ["-m", "pytest", "-q"], { cwd: ws, encoding: "utf8", timeout: 120000, env: cleanEnv })).trim().split("\n").pop();
  return null;
}

export function judgeFight({ fightDir, cmds, post, materialsDir = null }) {
  const materialTests = materialTestHashes(materialsDir);
  const verdicts = {};
  for (const c of cmds) {
    const ws = path.join(fightDir, c.name, "ws");
    const corner = post.corners.find((x) => x.arm === c.name);
    let tampered = [];
    const tests = fs.existsSync(ws) ? runCornerSuite(ws) : null;
    for (const [f, hash] of materialTests) {
      try {
        const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(ws, f))).digest("hex");
        if (h !== hash) tampered.push(f);
      } catch { tampered.push(`${f} (missing)`); }
    }
    const green = tests ? /(?:\d+) passed|pass \d+ · fail 0/.test(tests) && !/failed|error|fail [1-9]/i.test(tests) : null;
    let outcome, reason;
    if (corner?.exitCode !== 0) { outcome = "FAIL"; reason = `exited ${corner?.exitCode}`; }
    else if (tampered.length) { outcome = "FAIL"; reason = `tampered with provided tests: ${tampered.join(", ")}`; }
    else if (green === true) { outcome = "WIN"; reason = `judge reran the suite: ${tests} · ${(corner.wallMs / 1000).toFixed(1)}s`; }
    else if (green === false) { outcome = "FAIL"; reason = `judge reran the suite: ${tests}`; }
    else if ((corner?.artifacts ?? []).length) { outcome = "PARTIAL"; reason = `produced ${corner.artifacts.length} artifact(s), no test suite to judge by`; }
    else { outcome = "FAIL"; reason = "no artifacts produced"; }
    verdicts[c.name] = { outcome, reason, tests, tampered };
  }
  return verdicts;
}

/**
 * Narrative postmortem, written by the house reporter (the local model —
 * free calls). Verdicts above are mechanical; this section exists so a
 * human can READ the fight: what each corner did, how, and how the field
 * compared. The reporter is a combatant's model, so the card labels the
 * section as narrative, never as scoring.
 */
export async function narratePostmortem({ task, cmds, post, verdicts, laneText, endpoint = "http://127.0.0.1:8085", callModel = null }) {
  const call = callModel ?? (async (prompt) => {
    const r = await fetch(`${endpoint}/completion`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, n_predict: 200, temperature: 0.3, cache_prompt: false }),
      signal: AbortSignal.timeout(120000),
    });
    return (await r.json()).content?.trim() ?? "";
  });
  const wrap = (q) => `<|im_start|>user\n${q}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  const accounts = {};
  for (const c of cmds) {
    const v = verdicts[c.name];
    const tail = (laneText[c.name] ?? "").slice(-3500);
    try {
      accounts[c.name] = await call(wrap(
        `You are the ringside reporter for a coding-agent exhibition. One competitor ("${c.corner}") attempted this task:\n${task.slice(0, 600)}\n\nThe judge's mechanical verdict: ${v.outcome} — ${v.reason}.\nThe tail of its work transcript:\n${tail}\n\nWrite a plain-language account for a general reader, 3-4 sentences: what approach it took, how the work went, and anything notable (good moves, stumbles, style). Do not re-judge; the verdict stands.`));
    } catch { accounts[c.name] = null; }
  }
  let overall = null;
  try {
    const table = cmds.map((c) => `${c.corner}: ${verdicts[c.name].outcome} — ${verdicts[c.name].reason}`).join("\n");
    overall = await call(wrap(
      `You are the ringside reporter closing an exhibition between coding agents. The task:\n${task.slice(0, 600)}\n\nFinal verdicts (mechanical, already decided):\n${table}\n\nWrite the closing summary for a general reader, 4-5 sentences: how the fight unfolded across the field, who stood out and why, and what the wall-clock spread says. Plain language, no bullet points.`));
  } catch { /* the card stands without a closer */ }
  return { accounts, overall };
}


// ---------------------------------------------------------------------------
// Scoreboard: what each corner cost, from its own evidence.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Usage for one corner. BANTAM arms: their run artifact. CLIs: their own tail. */
export function cornerUsage(name, { armDir = null, rawLines = [], run = undefined } = {}) {
  if (name.startsWith("bantam")) {
    let r = run;
    if (r === undefined) {
      if (!armDir) return null;
      try { r = JSON.parse(fs.readFileSync(path.join(armDir, "run.json"), "utf8")); } catch { return null; }
    }
    // Checkpoints written before final metrics are not zero-token runs.
    if (!r?.metrics?.usage) return null;
    const u = r.metrics.usage;
    const input = num(u.inputTokens) ?? 0;
    const hit = Math.min(input, num(u.cacheHitTokens) ?? 0);
    const calls = Array.isArray(r.modelCalls) ? r.modelCalls : null;
    const measured = calls?.filter(call => {
      const usage = call?.response?.normalized?.usage;
      return call?.status === 'ok' && !(call.attempts?.length > 1)
        && usage?.complete !== false
        && Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens > 0
        && ['outputTokens','cacheHitTokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
        && usage.cacheHitTokens <= usage.inputTokens;
    });
    const complete = calls && calls.length > 0 && calls.length === num(r.metrics.modelRequests)
      && measured.length === calls.length
      && ['inputTokens','outputTokens','cacheHitTokens'].every(key =>
        measured.reduce((sum, call) => sum + call.response.normalized.usage[key], 0) === u[key]);
    return {
      source: "run.json",
      ...(calls ? { complete: Boolean(complete), measuredRequests: measured.length } : {}),
      turns: num(r?.metrics?.turns),
      requests: num(r?.metrics?.modelRequests),
      inputTokens: input,
      outputTokens: num(u.outputTokens) ?? 0,
      cacheHitTokens: hit,
      reasoningTokens: num(u.reasoningTokens) ?? 0,
      prefixReuse: input ? Math.round((hit / input) * 100) / 100 : 0,
      // true/false only when a verifier ran; a fight arm without --verify is
      // "unverified", and unverified is not a failure.
      pass: r?.result?.pass === true ? true : (r?.result?.pass === false ? false : null),
      durationMs: num(r?.metrics?.durationMs),
      // A corner the provider stopped is out of budget, not out of skill
      // (card 11 attempt 1: spark hit its usage limit on turn 6).
      ...(r?.result?.modelFailure?.message ? {
        failure: String(r.result.modelFailure.message).slice(0, 300),
        stopped: /usage limit|rate limit|quota|insufficient_quota|429/i.test(r.result.modelFailure.message) ? "out-of-budget" : "model-error",
      } : {}),
    };
  }
  if (name.startsWith("codex")) {
    // New native corners emit structured usage; retain historical text support.
    const completed = rawLines.flatMap((line) => {
      try { const row = JSON.parse(line); return row?.type === "turn.completed" && row.usage ? [row.usage] : []; }
      catch { return []; }
    });
    if (completed.length) {
      const sum = (key) => completed.reduce((n, u) => n + (num(u[key]) ?? 0), 0);
      const input = sum("input_tokens"), hit = sum("cached_input_tokens"), output = sum("output_tokens");
      return { source: "codex-jsonl", turns: completed.length, inputTokens: input,
        outputTokens: output, cacheHitTokens: hit, reasoningTokens: sum("reasoning_output_tokens"),
        totalTokens: input + output, prefixReuse: input ? hit / input : 0 };
    }
    // `codex exec` ends with "tokens used" and the figure on the next line.
    const i = rawLines.findIndex((l) => /^\s*tokens used\s*$/i.test(l));
    const figure = i >= 0 ? rawLines.slice(i + 1).find((l) => /^\s*[\d,]+\s*$/.test(l)) : null;
    return figure ? { source: "cli", totalTokens: Number(figure.replace(/[^\d]/g, "")) } : null;
  }
  if (name.startsWith("claude")) {
    for (let i = rawLines.length - 1; i >= 0; i -= 1) {
      let d;
      try { d = JSON.parse(rawLines[i]); } catch { continue; }
      if (d?.type !== "result" || !d.usage) continue;
      const u = d.usage;
      const cached = num(u.cache_read_input_tokens) ?? 0;
      const input = (num(u.input_tokens) ?? 0) + cached + (num(u.cache_creation_input_tokens) ?? 0);
      return {
        source: "stream-json",
        inputTokens: input,
        outputTokens: num(u.output_tokens) ?? 0,
        cacheHitTokens: cached,
        prefixReuse: input ? Math.round((cached / input) * 100) / 100 : 0,
        turns: num(d.num_turns),
      };
    }
    return null;
  }
  return null;
}

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");

/** File-backed callers use a streaming read; a long run can exceed V8's string limit. */
export async function readCornerUsage(name, options = {}) {
  if (!name.startsWith("bantam") || options.run !== undefined) return cornerUsage(name, options);
  if (!options.armDir) return null;
  let run;
  try { run = await readJsonFile(path.join(options.armDir, "run.json")); } catch { return null; }
  return cornerUsage(name, { ...options, run });
}

/** One table: corner, verdict, wall, turns, input, output, prefix reuse. */
// Bench-fault vs harness-fault, from the lane's own artifacts. The operator's
// rule: a FAIL must mean the harness failed the TASK — never that the bench
// starved it. A lane is INVALID (bench) when its workspace was never
// materialized, or when a BANTAM-driven arm's recorded turn-0 request does not
// contain the task bytes it was owed. (Card-20 sol was audited this way and
// proved VALID — provisioned and prompted — so its FAIL stands as genuine.)
export function laneValidity({ armDir, task }) {
  try {
    const ws = path.join(armDir, "ws");
    const files = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
    if (!files.length) return { valid: false, reason: "bench fault: no workspace was materialized for this lane" };
    const runPath = path.join(armDir, "run.json");
    if (fs.existsSync(runPath)) {
      const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
      const first = (run.modelCalls ?? [])[0];
      const req = typeof first?.request === "string" ? first.request : JSON.stringify(first?.request ?? "");
      const probe = String(task ?? "").slice(0, 120);
      if (probe && !req.includes(probe)) return { valid: false, reason: "bench fault: turn-0 request does not contain the task" };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `validity check unreadable: ${String(error?.message ?? error).slice(0, 80)}` };
  }
}

export function renderScoreboard(post, cmds, { verdicts = {} } = {}) {
  const rows = cmds.map((c) => {
    const corner = post.corners.find((x) => x.arm === c.name) ?? {};
    const u = corner.usage ?? {};
    const verdict = u.stopped === "out-of-budget" ? "OUT-OF-BUDGET" : (verdicts[c.name]?.outcome ?? (corner.exitCode === 0 ? "FINISHED" : "FAILED"));
    const why = u.failure ? `<br><small>${escapeHtml(u.failure.replace(/^model returned HTTP \d+: /, "").slice(0, 160))}</small>` : "";
    const wall = Number.isFinite(corner.wallMs) ? `${(corner.wallMs / 1000).toFixed(1)}s` : "—";
    const turns = Number.isFinite(u.turns) ? `${u.turns} turns` : "—";
    const tokens = u.source === "cli"
      ? `<td colspan="4">${fmt(u.totalTokens)} total (CLI reports one combined figure)</td>`
      : `<td>${fmt(u.inputTokens)}</td><td>${fmt(u.outputTokens)}</td><td>${fmt(u.cacheHitTokens)}</td><td>${Number.isFinite(u.prefixReuse) ? `${Math.round(u.prefixReuse * 100)}%` : "—"}</td>`;
    return `<tr style="--c:${c.color}"><td class="corner"><b>${escapeHtml(c.corner)}</b><br><small>${escapeHtml(c.sub ?? c.name)}</small></td>`
      + `<td class="v ${String(verdict).toLowerCase()}">${escapeHtml(verdict)}${why}</td><td>${wall}</td><td>${turns}</td>${tokens}</tr>`;
  });
  // Operator ratchet: same weights must never lose on wall — a slower bantam
  // against hermes/opencode is a harness defect, and the card says so.
  const bantamRow = post.corners.find((x) => x.arm === "bantam");
  const ratchet = [];
  if (bantamRow && Number.isFinite(bantamRow.wallMs)) {
    for (const peer of post.corners) {
      if ((peer.arm === "hermes" || peer.arm === "opencode") && Number.isFinite(peer.wallMs) && peer.wallMs < bantamRow.wallMs) {
        ratchet.push({ text: `${peer.arm} by ${((bantamRow.wallMs - peer.wallMs) / 1000).toFixed(1)}s`, frac: (bantamRow.wallMs - peer.wallMs) / bantamRow.wallMs });
      }
    }
  }
  // A trailing wall always gets the banner (the operator's rule), but a margin
  // inside single-run noise must SAY so — flagging a 2% gap the same as a 47%
  // one invites refight-until-the-coin-lands, Deming's funnel (control-limits.js).
  const allNoise = ratchet.length > 0 && ratchet.every((r) => r.frac <= 0.10);
  const ratchetNote = ratchet.length
    ? `<p class="note" style="color:#e0c26a"><b>LOCAL RATCHET:</b> bantam trails ${ratchet.map((r) => r.text).join(", ")} on the same weights${allNoise
        ? " — a margin within single-run noise: verify with a rematch median before treating it as a seat defect."
        : " — a harness defect to fix, not a model result."}</p>`
    : "";
  return `${ratchetNote}<style>
  .scoreboard { width:100%; border-collapse:collapse; margin:12px 0; font-size:13px; }
  .scoreboard th, .scoreboard td { border-bottom:1px solid #26262e; padding:6px 8px; text-align:left; }
  .scoreboard td.corner { border-left:4px solid var(--c); }
  .scoreboard td.v.win { color:#7ec07a; } .scoreboard td.v.fail, .scoreboard td.v.failed { color:#e07a6a; } .scoreboard td.v.partial { color:#e0c26a; }
  .scoreboard small { color:#8a8a96; }
</style>
<table class="scoreboard"><thead><tr><th>corner</th><th>verdict</th><th>wall</th><th>turns</th><th>input tok</th><th>output tok</th><th>cache tok</th><th>prefix reuse</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table>
<p class="note">Wall from the arena clock; turns and tokens from each corner's own run artifact (BANTAM arms), the CLI's own "tokens used" tail (codex), or the stream-json result (claude). Prefix reuse = cache-hit input tokens ÷ input tokens.</p>`;
}

/** Place the scoreboard just above the verdict banner of a finished card. */
export function injectScoreboard(cardHtml, scoreboardHtml) {
  const marker = '<div class="verdicts">';
  const i = cardHtml.indexOf(marker);
  if (i === -1) return cardHtml.replace("</body>", `${scoreboardHtml}\n</body>`);
  return `${cardHtml.slice(0, i)}${scoreboardHtml}\n${cardHtml.slice(i)}`;
}
