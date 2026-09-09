// codexapi-bridge.js — codexapi (an OpenAI-compatible bridge over the codex
// CLI) as a startup option beside the local models and the Codex app-server.
//
// Selecting it brings the bridge up if it is down and leaves BANTAM on the chat
// dialect with sessions held open. Nothing here hardcodes one developer's
// paths: the checkout comes from BANTAM_CODEXAPI_DIR, the saved setting, or a
// `codexapi/` directory beside the repo or one of its parents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_CODEXAPI_URL = "http://127.0.0.1:8787/v1";

// Recommended bridge models, in menu order, with the effort each is for.
// Spark's server default is `high`; its point here is being dumb-fast.
const RECOMMENDED = [
  { id: "gpt-5.3-codex-spark", short: "spark", effort: "low", role: "fastest" },
  { id: "gpt-5.6-luna", short: "luna", effort: "medium", role: "fast" },
  { id: "gpt-5.6-terra", short: "terra", effort: "medium", role: "everyday" },
  { id: "gpt-5.6-sol", short: "sol", effort: "high", role: "hard" },
  { id: "gpt-6-astra", short: "astra", effort: "medium", role: "frontier" },
];

const stripSlash = (u) => String(u).replace(/\/+$/, "");

export function resolveCodexapiConfig({ env = process.env, settings = {} } = {}) {
  const saved = settings && typeof settings.codexapi === "object" && settings.codexapi ? settings.codexapi : {};
  if (env.BANTAM_CODEXAPI_URL || env.BANTAM_CODEXAPI_KEY || env.BANTAM_CODEXAPI_DIR) {
    return {
      url: stripSlash(env.BANTAM_CODEXAPI_URL || saved.url || DEFAULT_CODEXAPI_URL),
      key: env.BANTAM_CODEXAPI_KEY || saved.key || null,
      dir: env.BANTAM_CODEXAPI_DIR || saved.dir || null,
      source: "env",
    };
  }
  if (saved.url || saved.key || saved.dir) {
    return { url: stripSlash(saved.url || DEFAULT_CODEXAPI_URL), key: saved.key ?? null, dir: saved.dir ?? null, source: "settings" };
  }
  return { url: DEFAULT_CODEXAPI_URL, key: null, dir: null, source: "default" };
}

/** A `codexapi/` checkout beside the repo or one of its parents, or under home. */
export function findCodexapiCheckout({ repoRoot = process.cwd(), home = os.homedir(), depth = 4 } = {}) {
  const candidates = [];
  let dir = path.resolve(repoRoot);
  for (let i = 0; i < depth; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    candidates.push(path.join(parent, "codexapi"));
    dir = parent;
  }
  candidates.push(path.join(home, "codexapi"));
  for (const candidate of candidates) {
    try { if (fs.statSync(path.join(candidate, "bin", "codexapi.js")).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** Is the bridge answering, and which models does it serve? */
export async function bridgeStatus(url, key = null, { timeoutMs = 2500 } = {}) {
  try {
    const res = await fetch(`${stripSlash(url)}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, models: [], status: res.status };
    const data = await res.json();
    return { reachable: true, models: Array.isArray(data?.data) ? data.data : [] };
  } catch (error) {
    return { reachable: false, models: [], error: error?.message ?? String(error) };
  }
}

export function codexapiChoices({ status, config, preference = null } = {}) {
  const reachable = Boolean(status?.reachable);
  // Answering but refusing the key is UP, not down: launching a second
  // instance onto a busy port is the wrong lit button there.
  const needsKey = !reachable && (status?.status === 401 || status?.status === 403);
  if (!reachable && !needsKey && !config?.dir) return [];
  const served = new Map((status?.models ?? []).map((m) => [m.id, m]));
  const wanted = reachable ? RECOMMENDED.filter((r) => served.has(r.id)) : RECOMMENDED;
  return wanted.map((r) => {
    const m = served.get(r.id) ?? {};
    const supported = Array.isArray(m.supported_reasoning_efforts) ? m.supported_reasoning_efforts : null;
    const remembered = preference?.kind === "codexapi" && preference.model === r.id
      && (!supported || supported.includes(preference.effort)) ? preference.effort : null;
    const effort = remembered ?? r.effort;
    const display = m.display_name ?? r.id;
    return {
      kind: "codexapi",
      name: `codexapi-${r.short}`,
      label: `codexapi · ${display} · ${effort} reasoning`,
      detail: reachable
        ? `${r.role}: ${m.description ?? "codex via the bridge"} — via ${config.url}`
        : needsKey
          ? `${r.role}: bridge at ${config.url} is up but needs its API key (BANTAM_CODEXAPI_KEY, or enter it when asked)`
          : `${r.role}: bridge is down — start it from ${config.dir} (${config.url})`,
      model: r.id,
      effort,
      launch: !reachable && !needsKey,
      needsKey,
      config,
      recommended: false,
      lastUsed: preference?.kind === "codexapi" && preference.model === r.id && preference.effort === effort,
    };
  });
}

/** Start the checkout detached and wait for /v1/models. Resolves { pid, url, log }. */
export async function launchBridge({ dir, url = DEFAULT_CODEXAPI_URL, key = null, waitMs = 60000, out = (s) => process.stderr.write(s), logFile = null } = {}) {
  if (!dir) throw new Error("no codexapi checkout to start (set BANTAM_CODEXAPI_DIR)");
  const entry = path.join(dir, "bin", "codexapi.js");
  if (!fs.existsSync(entry)) throw new Error(`${entry} does not exist`);
  const parsed = new URL(stripSlash(url));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const log = logFile ?? path.join(os.homedir(), ".bantam", "codexapi.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      ...process.env,
      CODEXAPI_PORT: String(parsed.port || 8787),
      // A LAN address in the URL means "serve the LAN"; loopback stays loopback.
      CODEXAPI_HOST: loopback ? "127.0.0.1" : "0.0.0.0",
      ...(key ? { CODEXAPI_KEY: key } : {}),
      // BANTAM holds sessions itself and deletes them at run end.
      CODEXAPI_SESSION_TTL_MS: process.env.CODEXAPI_SESSION_TTL_MS ?? "0",
    },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  out(`starting codexapi from ${dir} on ${stripSlash(url)} (log: ${log}) …\n`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`codexapi exited with code ${child.exitCode} (see ${log})`);
    const status = await bridgeStatus(url, key, { timeoutMs: 1500 });
    if (status.reachable) {
      out(`codexapi is up: ${status.models.length} model${status.models.length === 1 ? "" : "s"} listed\n`);
      return { pid: child.pid, url: stripSlash(url), log };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { process.kill(child.pid); } catch { /* already gone */ }
  throw new Error(`codexapi did not answer on ${url} within ${Math.round(waitMs / 1000)}s (see ${log})`);
}
