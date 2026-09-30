// Jev engine lifecycle: the DiffusionGemma vLLM container behind Jev mode.
//
//   start  docker start (or create from config.create), then wait for /health
//   stop   docker stop (a port kill cannot end a root-owned container)
//   sleep  POST /sleep?level=1: weights leave VRAM (21.4 -> about 3 GB, 10.7 s measured)
//   wake   POST /wake_up (1.0 s measured)
//
// Sleep and wake need the server started with --enable-sleep-mode and
// VLLM_SERVER_DEV_MODE=1, which the default create spec sets.
//
// config.engine.mode decides what BANTAM may do:
//   managed       BANTAM runs the container: all of the above.
//   external      a DiffusionGemma vLLM the user runs: BANTAM only talks to it
//                 (sleep/wake if the server supports them), never starts or stops it.
//   unconfigured  nothing yet; every action points to `bantamfactory jev setup`.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function dockerCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim()), { code: error.code }));
      else resolve(String(stdout).trim());
    });
  });
}

export class JevNotConfigured extends Error {
  constructor() { super("Jev mode is not set up yet. Run `bantamfactory jev setup` (or :jev on in a session) to use your own DiffusionGemma server or install one."); }
}

export function createJevEngine(config, { docker = dockerCli, fetchImpl = fetch, wait = delay, now = () => Date.now() } = {}) {
  const root = config.endpoint.replace(/\/+$/, "");
  const mode = config.engine?.mode ?? "managed";
  const requireSetup = () => { if (mode === "unconfigured") throw new JevNotConfigured(); };

  async function http(route, { method = "GET", timeoutMs = 5000 } = {}) {
    const response = await fetchImpl(`${root}${route}`, { method, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok) throw new Error(`DiffusionGemma ${route}: HTTP ${response.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : null;
  }

  async function containerState() {
    try { return await docker(["inspect", "-f", "{{.State.Status}}", config.container]); }
    catch { return "missing"; }
  }

  async function serverState() {
    try {
      const response = await fetchImpl(`${root}/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return { reachable: false, sleeping: false };
    } catch { return { reachable: false, sleeping: false }; }
    try { return { reachable: true, sleeping: (await http("/is_sleeping"))?.is_sleeping === true }; }
    catch { return { reachable: true, sleeping: false }; }
  }

  /** Where the engine is: container state, and whether the server answers and sleeps. */
  async function status() {
    if (mode === "unconfigured") return { state: "unconfigured", mode, endpoint: root, reachable: false, sleeping: false };
    if (mode === "external") {
      const server = await serverState();
      return { state: !server.reachable ? "unreachable" : server.sleeping ? "asleep" : "awake", mode, endpoint: root, ...server };
    }
    const container = await containerState();
    const server = container === "running" ? await serverState() : { reachable: false, sleeping: false };
    const state = container === "missing" ? "missing"
      : container !== "running" ? "stopped"
      : !server.reachable ? "starting"
      : server.sleeping ? "asleep" : "awake";
    return { state, mode, container, endpoint: root, ...server };
  }

  async function create() {
    const spec = config.create;
    if (!spec?.image || !spec?.modelPath) throw new Error(`container ${config.container} does not exist and jev.json has no create spec`);
    await docker(["run", "-d", "--name", config.container, "--gpus", "all", "--network", "host", "--ipc", "host",
      "-e", "VLLM_SERVER_DEV_MODE=1", "-v", `${spec.modelPath}:/model:ro`, "--entrypoint", "vllm", spec.image, ...spec.args]);
  }

  /** Bring the engine up and awake. `onProgress` gets short status lines. */
  async function start({ onProgress = () => {} } = {}) {
    requireSetup();
    let current = await status();
    if (mode === "external") {
      if (current.state === "unreachable") throw new Error(`your DiffusionGemma server at ${root} is not reachable; start it, or change the endpoint with \`bantamfactory jev setup\``);
      if (current.state === "asleep") await wake();
      return status();
    }
    if (current.state === "awake") return current;
    if (current.state === "asleep") { await wake(); return status(); }
    if (current.state === "missing") { onProgress(`creating container ${config.container}`); await create(); }
    else if (current.state === "stopped") { onProgress(`starting container ${config.container}`); await docker(["start", config.container]); }
    const deadline = now() + config.startTimeoutMs;
    onProgress("loading DiffusionGemma (a cold start takes about 2-3 minutes)");
    while (now() < deadline) {
      current = await status();
      if (current.state === "awake") return current;
      if (current.state === "asleep") { await wake(); return status(); }
      if (current.state === "stopped" || current.state === "missing") {
        const logs = await docker(["logs", "--tail", "20", config.container]).catch(() => "");
        throw new Error(`container ${config.container} exited while loading:\n${logs}`);
      }
      await wait(2000);
    }
    throw new Error(`DiffusionGemma did not become healthy within ${Math.round(config.startTimeoutMs / 1000)} s`);
  }

  async function stop() {
    // An external server belongs to the user: BANTAM never stops it.
    if (mode !== "managed") return status();
    const current = await status();
    if (current.state === "missing" || current.state === "stopped") return current;
    await docker(["stop", config.container], { timeoutMs: 120_000 });
    return status();
  }

  async function sleep() {
    requireSetup();
    await http("/sleep?level=1", { method: "POST", timeoutMs: config.gpu.sleepTimeoutMs });
    if ((await http("/is_sleeping"))?.is_sleeping !== true) throw new Error("DiffusionGemma did not enter sleep mode");
  }

  async function wake() {
    requireSetup();
    await http("/wake_up", { method: "POST", timeoutMs: config.gpu.sleepTimeoutMs });
    if ((await http("/is_sleeping"))?.is_sleeping !== false) throw new Error("DiffusionGemma did not wake");
  }

  /** Awake and serving, starting or waking as needed. */
  async function ensureAwake(options) {
    requireSetup();
    const current = await status();
    if (current.state === "awake") return current;
    if (current.state === "asleep") { await wake(); return status(); }
    return start(options);
  }

  return Object.freeze({ status, start, stop, sleep, wake, ensureAwake, endpoint: root, mode });
}
