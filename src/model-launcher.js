// Optional model auto-start. If no llama.cpp server is running, offer to launch one from a known
// startup script — interactive only, and it asks first. The registry defaults to the local models;
// override with a JSON file at BANTAM_MODELS or the repository's .bantam/models.json:
//   [{ "name": "qwen38uc-duo", "script": "/abs/path/start.sh", "endpoint": "http://127.0.0.1:8085",
//     "slots": 2, "vision": true, "vramMb": 22800, "notes": "...",
//     "match": "substring of the id the server reports", "profile": "qwen|gemma|generic" }]
// `name` is the handle `bantam swap <name>` resolves on; `label` (a prose display name) is optional
// and defaults to `name`. Everything after `endpoint` is optional: omit `profile` and it is inferred
// from the model id. Prefer `bantam models add` over hand-editing — it validates the script path,
// which this reader can only skip over silently.
import { recordLoad, renderExpectation, loadAnomaly } from "./logic/swap-ledger.js";
import { setActiveProfile } from "./logic/model-cards.js";
import { liveModelLockHolders } from "./model-lock.js";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// No built-in models: a fresh machine must register its own (via
// `bantam doctor`, `BANTAM_MODELS`, or the repository's .bantam/models.json). Hardcoding one
// developer's absolute GGUF paths here made a stranger's *empty* registry
// masquerade as phantom models whose start scripts don't exist — the opposite of
// what `bantam doctor` needs to report truthfully.
const DEFAULT_MODELS = [];

/** The checkout-local registry, independent of the caller's working directory. */
export function defaultModelRegistryPath() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.join(repoRoot, ".bantam", "models.json");
}

function loadRegistry() {
  // 1) Explicit --models flag value
  const args = process.argv;
  const modelsIdx = args.indexOf("--models");
  if (modelsIdx !== -1 && args[modelsIdx + 1]) {
    try { return JSON.parse(fs.readFileSync(args[modelsIdx + 1], "utf8")); } catch { /* fall through */ }
  }
  // 2) BANTAM_MODELS env var
  if (process.env.BANTAM_MODELS) {
    try { return JSON.parse(fs.readFileSync(process.env.BANTAM_MODELS, "utf8")); } catch { /* fall through */ }
  }
  // 3) Resolve repo root from the script's own location (works from any cwd)
  const src = defaultModelRegistryPath();
  try { if (fs.existsSync(src)) return JSON.parse(fs.readFileSync(src, "utf8")); } catch { /* fall back */ }
  return DEFAULT_MODELS;
}

/**
 * Is a model actually resident at `endpoint`?
 *
 * /health is not proof. With --sleep-idle-seconds, llama.cpp destroys the
 * context and unloads the model — measured 2026-08-22: VRAM 20062 MiB -> 696
 * MiB — while /health keeps answering 200, because it bypasses the sleep gate
 * by design. A liveness check built on /health alone would report a model that
 * is not in VRAM at all, and `startAndWait` would call that "up".
 *
 * /props also bypasses the sleep gate (so asking does NOT wake the server —
 * verified: four probes, VRAM never moved) and carries `is_sleeping`. Only an
 * explicit `true` counts as asleep: vLLM and older llama.cpp builds have no
 * /props, and absence of evidence is not evidence of sleeping.
 */
async function serverState(endpoint, timeoutMs = 1200) {
  let reachable = false;
  try {
    const r = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    reachable = r.ok;
  } catch { return { reachable: false, sleeping: false }; }
  if (!reachable) return { reachable: false, sleeping: false };
  try {
    const p = await fetch(`${String(endpoint).replace(/\/$/, "")}/props`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!p.ok) return { reachable: true, sleeping: false };
    return { reachable: true, sleeping: (await p.json())?.is_sleeping === true };
  } catch { return { reachable: true, sleeping: false }; }
}

async function isHealthy(endpoint, timeoutMs = 1200) {
  const { reachable, sleeping } = await serverState(endpoint, timeoutMs);
  return reachable && !sleeping;
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

/**
 * One identity for every registry entry. The registry has two producers with
 * different shapes — `bantam doctor --launch` scaffolds { label, script,
 * endpoint }, while hand-written and `bantam models add` entries carry { name }
 * because that is what `bantam swap` and the aliases resolve on. Consumers were
 * split the same way: every display path read `.label` and every logic path read
 * `.name`, so a name-keyed registry printed "Start undefined" in the startup
 * picker and `:model <name>` threw on undefined.toLowerCase(). Normalize once,
 * here at the load boundary, and both halves are always present.
 */
export function normalizeModelEntry(entry) {
  const name = entry?.name ?? entry?.label ?? null;
  return { ...entry, name, label: entry?.label ?? name };
}

/** Every registered model, including ones whose start script is missing. */
export function readModelRegistry() {
  const raw = loadRegistry();
  return (Array.isArray(raw) ? raw : []).map(normalizeModelEntry);
}

/** Registered models whose startup scripts exist on disk. */
export function listModels() {
  return readModelRegistry().filter((m) => m.script && fs.existsSync(m.script));
}

/** Registered models annotated with live `running` (and `sleeping`) status. */
export async function modelStatus() {
  return Promise.all(listModels().map(async (m) => {
    const { reachable, sleeping } = await serverState(m.endpoint);
    // `sleeping` is surfaced rather than folded into `running`: a sleeping
    // server is reachable and will wake on demand, and an operator staring at
    // an ○ deserves to know the difference between "nothing there" and "the
    // model stepped out and left the port answering".
    return { ...m, running: reachable && !sleeping, sleeping: reachable && sleeping };
  }));
}

/** Does the server at `endpoint` have a vision projector (mmproj) loaded? */
export async function endpointHasVision(endpoint) {
  try {
    const r = await fetch(`${String(endpoint).replace(/\/$/, "")}/props`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? Boolean((await r.json())?.modalities?.vision) : false;
  } catch { return false; }
}

/** The first registered model declared vision-capable — used for "load a vision model?". */
export function firstVisionModel() {
  return listModels().find((m) => m.vision);
}

/** The pid holding a port, or null when nothing holds it (or `fuser` is absent). */
function portOwnerPid(endpoint) {
  const port = (String(endpoint).match(/:(\d+)/) || [])[1];
  if (!port) return null;
  try {
    const out = execFileSync("fuser", [`${port}/tcp`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    });
    return out.trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

/** The number of slots the live server reports, or null when it will not say. */
async function liveSlotCount(endpoint) {
  try {
    const r = await fetch(`${String(endpoint).replace(/\/$/, "")}/slots`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const s = await r.json();
    return Array.isArray(s) ? s.length : null;
  } catch { return null; }
}

/**
 * Is the profile that is actually resident the one we asked for? Profiles share
 * a GGUF and a port, so /v1/models cannot tell solo from duo from crew — the
 * slot count can, and `bantam swap` has always used it for its DISPLAY. Here it
 * is the gate. Returns { ok } or { ok:false, detail }, and says plainly when
 * there was nothing to check against rather than calling that a pass.
 */
export async function verifyResidentProfile(target) {
  if (target?.match) {
    const id = await loadedModelId(target.endpoint);
    if (id && !id.toLowerCase().includes(String(target.match).toLowerCase())) {
      return { ok: false, detail: `the server reports "${id}", which does not match "${target.match}"` };
    }
  }
  if (target?.slots != null) {
    const live = await liveSlotCount(target.endpoint);
    if (live == null) {
      return { ok: true, checked: "slots", unverified: "the /slots endpoint did not answer, so the resident profile is unconfirmed" };
    }
    if (Number(live) !== Number(target.slots)) {
      return { ok: false, checked: "slots", detail: `the server reports ${live} slot(s) but the registry says ${target.slots} — a different profile is resident` };
    }
    return { ok: true, checked: "slots" };
  }
  if (!target?.match) {
    // Declaring neither is a configuration CHOICE, not a failed check: the entry
    // means "whatever local model is serving that endpoint". Attaching to an
    // operator-managed server is the intent, so `checked` stays null and callers
    // that only warn about attempted-but-unanswered checks stay quiet.
    return { ok: true, checked: null, unverified: `"${target?.name}" declares neither slots nor match, so nothing identifies which profile is resident` };
  }
  return { ok: true, checked: "match" };
}

/**
 * Spawn a model's startup script and wait for it to become healthy. `out` is a
 * raw writer.
 *
 * Health alone is not proof that WE started anything: /health only says that
 * something answers on that port. Measured 2026-08-22 — a launch script that
 * did nothing at all printed "Model is up." because a server was already there.
 * So the port's owner is recorded before the spawn: if the same pid still holds
 * it when health returns, nothing new was launched and this is a failure.
 */
async function startAndWait(target, waitMs, out) {
  out(`Starting ${target.label} … (loading can take a minute)\n`);
  const pidBefore = portOwnerPid(target.endpoint);
  const child = spawn("bash", [target.script], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + waitMs;
  let ticks = 0;
  while (Date.now() < deadline) {
    if (await isHealthy(target.endpoint)) {
      const pidAfter = portOwnerPid(target.endpoint);
      if (pidBefore && pidAfter && pidAfter === pidBefore) {
        out(`\n✗ ${target.endpoint} is still held by pid ${pidBefore} — the server that was already there. ${target.label} was not started.\n`);
        return false;
      }
      out("\nModel is up.\n");
      return true;
    }
    if (ticks++ % 5 === 0) out(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  out("\nTimed out waiting for the model to become healthy.\n");
  return false;
}

/** Start one registered local model and return its endpoint once healthy. */
export async function startRegisteredModel(target, { waitMs = 240000, out = (s) => process.stderr.write(s) } = {}) {
  if (!target || typeof target.endpoint !== "string" || typeof target.script !== "string") return null;
  // Every load is timed and remembered (per-machine ledger): the history is
  // the ETA on the next swap and the tripwire for hangs and slow drift.
  const t0 = Date.now();
  const ok = await startAndWait(target, waitMs, out);
  recordLoad(target.name ?? target.script, Date.now() - t0, { ok });
  return ok ? target.endpoint : null;
}

/** The model id the server currently reports loaded (from /v1/models). */
async function loadedModelId(endpoint) {
  try {
    const r = await fetch(`${String(endpoint).replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json())?.data?.[0]?.id || null) : null;
  } catch { return null; }
}

/** Stop whatever llama.cpp server holds the endpoint's port, and wait for it to release. */
async function stopServerAt(endpoint, out) {
  const port = (String(endpoint).match(/:(\d+)/) || [])[1];
  if (!port) return false;
  out(`Stopping the model on port ${port} …\n`);
  try { execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore", timeout: 6000 }); }
  catch {
    try {
      const pids = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\s+/).filter(Boolean);
      for (const p of pids) { try { process.kill(Number(p), "SIGTERM"); } catch { /* already gone */ } }
    } catch { /* no killer available */ }
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!(await isHealthy(endpoint))) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Ensure `target` is the loaded model, then point `model` at it — the in-session switch. On a
 * single-GPU rig, models share a port, so switching means a real restart: if a DIFFERENT model holds
 * the endpoint, stop it first and start the target. Returns true on success.
 */
export async function switchToModel(model, target, {
  waitMs = 240000,
  out = (s) => process.stderr.write(s),
  stop = stopServerAt,
  verify = verifyResidentProfile,
} = {}) {
  if (await isHealthy(target.endpoint)) {
    // "Already running" used to mean only "the model id matches, or there is no
    // id constraint" — and no profile in this registry declares one, so a
    // 4-slot crew server satisfied a request for the 2-slot profile. Ask the
    // gauge that can actually tell them apart before claiming the work is done.
    const resident = await verify(target);
    if (resident.ok) {
      model.switchTo(target.endpoint, { profile: target.profile });
      out(`Now using ${target.label} @ ${target.endpoint} (already running${resident.checked && resident.unverified ? `; ${resident.unverified}` : ""})\n`);
      return true;
    }
    out(`${target.endpoint} is serving something else: ${resident.detail}\n`);
    if (!(await stop(target.endpoint, out))) { out("Could not stop the current model.\n"); return false; }
  }
  if (!(await startAndWait(target, waitMs, out))) return false;
  const started = await verify(target);
  if (!started.ok) {
    out(`${target.label} came up but ${started.detail}\n`);
    return false;
  }
  // The profile hint travels on both paths; it used to be passed only when the
  // server was already up, so a fresh start silently lost it.
  model.switchTo(target.endpoint, { profile: target.profile });
  out(`Now using ${target.label} @ ${target.endpoint}${started.checked && started.unverified ? ` (${started.unverified})` : ""}\n`);
  return true;
}

/**
 * When no server is up, ask whether to launch one. Returns the endpoint of a now-healthy server, or
 * null (declined / headless / no scripts / timed out) — the caller then proceeds and hits the usual
 * clear "can't reach the model" error.
 */
export async function offerToLaunchModel({ interactive = false, waitMs = 240000 } = {}) {
  const models = listModels();
  if (!models.length || !interactive) return null;
  process.stderr.write("\nNo model server is running.\n");
  models.forEach((m, i) => process.stderr.write(`  [${i + 1}] ${m.label}${m.vision ? " [vision]" : ""}\n`));
  const ans = (await prompt("Start one? (number, or Enter to skip) ")).trim();
  const pick = models[Number(ans) - 1];
  if (!pick) { process.stderr.write("Skipping model launch.\n"); return null; }
  return (await startAndWait(pick, waitMs, (s) => process.stderr.write(s))) ? pick.endpoint : null;
}

// Aliases for the two working profiles: the chair says "solo" and "crew",
// not registry names. Measured swap costs (2026-08-19, same GGUF, page-cache
// hot): solo->crew 7.3s, crew->solo 15.2s — RAM-to-VRAM upload plus init,
// never disk. The rapid-swap doctrine: profiles are cheap, keep them pinned.
export const MODEL_ALIASES = { solo: "bantam-q4", crew: "bantam-q4-crew", solomax: "bantam-q4-solomax", max: "bantam-q4-solomax", duo: "bantam-q4-duo", crewmtp: "bantam-q4-crewmtp", crewsplit: "bantam-q4-crewsplit", split: "bantam-q4-crewsplit" };

export function resolveModelTarget(nameOrAlias) {
  const name = MODEL_ALIASES[String(nameOrAlias ?? "").toLowerCase()] ?? nameOrAlias;
  const wanted = String(name ?? "").toLowerCase();
  if (!wanted) return null;
  const models = listModels();
  // Exact name first, then a case-insensitive match on either half of the
  // identity: a doctor-scaffolded entry's only handle is its prose label.
  return models.find((m) => m.name === name)
    ?? models.find((m) => String(m.name ?? "").toLowerCase() === wanted
      || String(m.label ?? "").toLowerCase() === wanted)
    ?? null;
}

/**
 * Stop whatever serves the target's endpoint, start the target profile, and
 * report the measured wall time. stop/start are injectable for tests.
 */
export async function swapModel(nameOrAlias, {
  out = (s) => process.stderr.write(s),
  stop = stopServerAt,
  start = startRegisteredModel,
  verify = verifyResidentProfile,
  now = () => Date.now(),
  force = false,
  lockDir = null,
} = {}) {
  const target = resolveModelTarget(nameOrAlias);
  if (!target) return { ok: false, error: `no registered model or alias "${nameOrAlias}" (try: ${Object.keys(MODEL_ALIASES).join(", ")}, or a name from .bantam/models.json)` };
  const expectation = renderExpectation(target.name);
  if (expectation) out(`\u2192 swapping to ${target.name} \u2014 ${expectation}\n`);
  // VRAM preflight: this machine is a desktop, not a headless box — a swap
  // that leaves the compositor starving crashes the front end. Warn before
  // loading when the profile's measured footprint would leave under ~400 MiB.
  if (target.vramMb) {
    const head = vramHeadroomMb();
    if (head != null) {
      const free = head.freeMb + head.reclaimableMb;
      if (free - target.vramMb < 400) {
        out(`\u26a0 tight fit: ${target.name} needs ~${target.vramMb} MiB; ~${free} MiB will be available after eviction \u2014 close GPU-hungry apps or expect instability.\n`);
      }
    }
  }
  // A swap restarts the server, which kills any run holding the model lock on
  // that endpoint. The lock has always known who is working; the swap simply
  // never asked. `force` is the operator saying they mean it anyway.
  if (!force) {
    const holders = liveModelLockHolders({ endpoint: target.endpoint, ...(lockDir ? { lockDir } : {}) })
      .filter((h) => h.pid !== process.pid);
    if (holders.length) {
      const who = holders.map((h) => `pid ${h.pid}${h.startedAt ? ` since ${h.startedAt}` : ""}`).join(", ");
      return { ok: false, error: `a run is using ${target.endpoint} (${who}). A swap restarts the server and would kill it — wait, or pass --force.` };
    }
  }
  const t0 = now();
  // Stop is a gate, not a gesture. It returns false when the port never freed,
  // and starting anyway meant the OLD model answered /health and the swap
  // reported success (measured 2026-08-22: {ok:true, ms:3} with nothing swapped).
  if (await stop(target.endpoint, out) === false) {
    return { ok: false, error: `could not free ${target.endpoint} — the current model is still resident and nothing was swapped`, ms: now() - t0 };
  }
  const endpoint = await start(target, { out });
  const ms = now() - t0;
  if (!endpoint) return { ok: false, error: `"${target.name}" did not become healthy`, ms };
  // The post-condition: healthy is not the same as "the right profile".
  const resident = await verify(target);
  if (!resident.ok) {
    return { ok: false, error: `${target.name} came up but ${resident.detail}`, ms };
  }
  setActiveProfile(target.name);
  const anomaly = loadAnomaly(target.name, ms);
  return {
    ok: true, name: target.name, endpoint, ms,
    ...(anomaly ? { anomaly } : {}),
    ...(resident.unverified ? { unverified: resident.unverified } : {}),
  };
}


/** Free VRAM now, plus what stopping the current resident would reclaim. */
export function vramHeadroomMb() {
  try {
    const free = Number(execFileSync("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000 }).trim().split("\n")[0]);
    const apps = execFileSync("nvidia-smi", ["--query-compute-apps=used_memory", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000 }).trim();
    const reclaimable = apps ? apps.split("\n").map(Number).reduce((a, b) => a + b, 0) : 0;
    return Number.isFinite(free) ? { freeMb: free, reclaimableMb: reclaimable } : null;
  } catch { return null; }
}
