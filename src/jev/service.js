// Jev mode service: the running piece behind `:jev on` and `bantamfactory jev`.
// It owns the DiffusionGemma engine, the System One decider, the GPU policy
// and the Jev API server, and keeps request statistics for `:jev status`.
//
// GPU policy (config.gpu.policy; "auto" resolves per worker):
//   alongside  DiffusionGemma stays awake; the worker runs in the cloud (Codex,
//              API presets), so nothing competes for the GPU.
//   swap       a local llama.cpp worker shares the GPU. A Jev request takes the
//              GPU lease on the worker's endpoint (the same lease ComfyUI uses,
//              which src/model.js waits on before every local call), waits for
//              llama.cpp to idle-sleep, wakes DiffusionGemma, and answers.
//              DiffusionGemma stays awake for a burst window, then sleeps and
//              releases the lease; the worker wakes on its next request.
//   off        Jev never takes the GPU from a local worker: requests get 503
//              while the engine is not awake.
import { endpointKey, imageLeases, ImageGpuRuntime, acquireImageLease, localModelEndpoint } from "../image-gpu.js";
import { compileHandlePool, createStructuredReader, decideJevAdaptive } from "../factory/system-one.js";
import { createExecCell } from "../factory/exec-gauge.js";
import { JevBusy, JevUnavailable, startJevHttpServer } from "./api.js";
import { createJevEngine } from "./engine.js";

export const JEV_GAUGES = Object.freeze([
  { name: "exec", authority: "exact", trigger: "material with a Python function and call arguments; the call runs in a sealed sandbox and the one candidate equal to its value is released" },
  { name: "tool-call", authority: "exact rule-out + evidence", trigger: "material with tool definitions and options that are JSON tool calls; calls to missing tools or malformed calls are ruled out, schema and grounding findings are shown to the reads" },
  { name: "state", authority: "exact rule-out + derivation", trigger: "entities with ids in the material and options written as `id.prop becomes value`; no-op changes are ruled out and after-state questions are derived from the chosen change" },
  { name: "preference", authority: "exact when unanimous", trigger: "a rated history of color palettes and two candidate palettes; five fits of the user's own history release an answer when all agree" },
  { name: "calculator", authority: "evidence", trigger: "quantitative questions in rows of up to four questions; the model writes a setup and exact arithmetic is shown to its thought" },
]);

/** The policy that applies with this worker: auto picks swap for a local worker. */
export function effectivePolicy(config, worker) {
  const policy = config.gpu.policy;
  if (policy !== "auto") return policy;
  return worker && localModelEndpoint(worker) ? "swap" : "alongside";
}

export function createJevService({ config, worker = null, engine = createJevEngine(config), log = () => {}, fetchImpl = fetch, now = () => Date.now() }) {
  let reader = null;
  let pool = null;
  let execCell = null;
  let queue = Promise.resolve();
  let waiting = 0;
  let lease = null;
  let burstTimer = null;
  let server = null;
  let primed = false;
  const stats = { requests: 0, questions: 0, errors: 0, ms: [], swapsIn: 0, swapsOut: 0, startedAt: null };

  const policy = () => effectivePolicy(config, worker);
  const workerEndpoint = () => (worker ? localModelEndpoint(worker) : null);

  async function ensureDecider() {
    if (!reader) {
      reader = createStructuredReader({ baseUrl: config.endpoint, model: config.servedModel, fetchImpl });
      pool = await compileHandlePool(reader, { size: 256 });
    }
    return { reader, pool };
  }

  function cell() {
    if (!execCell) {
      try { execCell = createExecCell({ image: config.execCellImage }); } catch { execCell = null; }
    }
    return execCell;
  }

  // Swap in: take the worker's GPU lease, let llama.cpp idle-sleep, wake DiffusionGemma.
  async function swapIn() {
    if (lease) return;
    const endpoint = workerEndpoint();
    if (!endpoint) return;
    if (imageLeases().some((l) => l.endpoint === endpointKey(endpoint))) throw new JevBusy("the GPU is reserved for an image job; try again when it finishes");
    lease = acquireImageLease({ url: `jev:${config.endpoint}`, gpu: { resourceKey: `jev:${endpointKey(endpoint)}` } }, { kind: "jev", endpoint: endpointKey(endpoint), state: "swapping-in" });
    try {
      const runtime = new ImageGpuRuntime({ mode: "llamacpp", endpoint: endpointKey(endpoint) }, { gpu: { sleepTimeoutMs: config.gpu.sleepTimeoutMs }, pollMs: 250 }, { fetchImpl });
      await runtime.sleep(AbortSignal.timeout(config.gpu.sleepTimeoutMs));
      await engine.ensureAwake();
      lease.update({ state: "jev-awake" });
      stats.swapsIn++;
      log({ event: "jev_swap_in", endpoint });
    } catch (error) {
      releaseLease();
      throw new JevUnavailable(`could not take the GPU from the local worker: ${error.message}`);
    }
  }

  function releaseLease() {
    try { lease?.release(); } catch { /* already gone */ }
    lease = null;
  }

  async function swapOut() {
    burstTimer = null;
    if (!lease) return;
    try { await engine.sleep(); } catch (error) { log({ event: "jev_sleep_failed", error: error.message }); }
    releaseLease();
    stats.swapsOut++;
    log({ event: "jev_swap_out" });
  }

  function armBurst() {
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { queue = queue.then(swapOut, swapOut); }, config.gpu.burstMs);
    burstTimer.unref?.();
  }

  async function readyForRequest() {
    const mode = policy();
    if (mode === "swap") { await swapIn(); return; }
    const status = await engine.status();
    if (status.state === "awake") return;
    if (mode === "off") throw new JevUnavailable(`DiffusionGemma is ${status.state}; turn Jev mode on first (:jev on)`);
    await engine.ensureAwake();
  }

  /**
   * The API's decide(): serialized, with the GPU policy applied first.
   * `releaseAfter` (the working agent's own decide action) hands the GPU back
   * to the local worker at once instead of holding it for a burst window: the
   * agent's very next step needs its model.
   */
  function decide({ profile, state, questions, seed, thought, releaseAfter = false }) {
    if (waiting >= 64) return Promise.reject(new JevBusy("too many Jev requests are queued"));
    waiting++;
    const run = async () => {
      waiting--;
      const t0 = now();
      try {
        await readyForRequest();
        const { reader: r, pool: p } = await ensureDecider();
        const decided = await decideJevAdaptive({
          ...profile.options,
          reader: r, pool: p, state, questions, seed,
          execCell: profile.execGauge ? cell() : null,
          borrowedThought: thought ?? null,
        });
        stats.requests++;
        stats.questions += Object.keys(questions).length;
        stats.ms.push(now() - t0);
        if (stats.ms.length > 1000) stats.ms.shift();
        return { answers: decided.answers, evidence: decided.evidence, usage: { inputTokens: decided.usage.inputTokens, outputTokens: 0 } };
      } catch (error) {
        stats.errors++;
        if (error instanceof JevBusy || error instanceof JevUnavailable) throw error;
        if (/fetch failed|ECONNREFUSED|HTTP 5\d\d/.test(String(error.message))) throw new JevUnavailable(`inference backend unavailable: ${error.message}`);
        throw error;
      } finally {
        if (policy() === "swap" && lease) {
          if (releaseAfter) { if (burstTimer) clearTimeout(burstTimer); await swapOut(); }
          else armBurst();
        }
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  async function status() {
    const engineStatus = await engine.status();
    const sorted = [...stats.ms].sort((a, b) => a - b);
    return {
      engine: engineStatus.state,
      mode: engineStatus.mode ?? config.engine?.mode,
      endpoint: engineStatus.endpoint,
      policy: policy(),
      configuredPolicy: config.gpu.policy,
      gpuLease: lease ? { held: true, state: lease.record.state } : { held: false },
      api: server ? { url: `http://${config.api.host}:${server.address().port}`, auth: Boolean(config.api.token) } : null,
      requests: stats.requests,
      questions: stats.questions,
      errors: stats.errors,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      swaps: { in: stats.swapsIn, out: stats.swapsOut },
      startedAt: stats.startedAt,
    };
  }

  /**
   * Turn Jev mode on: bring the engine up and (unless `serve` is false) start
   * the API. Under the swap policy the first sleep after a start is slow (it
   * copies the weights to host memory), so it is done once here, up front.
   */
  async function on({ serve = true, host = config.api.host, port = config.api.port, onProgress = () => {} } = {}) {
    if (host !== "127.0.0.1" && host !== "localhost" && !config.api.token) {
      throw new Error("serving Jev beyond localhost needs an API token (set api.token in .bantam/jev.json)");
    }
    await engine.start({ onProgress });
    if (policy() === "swap" && !primed) {
      onProgress("priming sleep mode once (the first sleep copies the weights to host memory; later swaps take about a second)");
      await engine.sleep();
      primed = true;
    }
    if (policy() !== "swap") await ensureDecider();
    stats.startedAt = new Date(now()).toISOString();
    if (serve && !server) {
      server = await startJevHttpServer({
        decide, status, gauges: JEV_GAUGES, token: config.api.token,
        maxQuestions: config.api.maxQuestions, maxBodyBytes: config.api.maxBodyBytes,
        log: (entry) => log({ event: "jev_request", ...entry }),
      }, { host, port });
    }
    return status();
  }

  /** Turn Jev mode off: stop serving, give back the GPU, stop the engine unless `keepEngine`. */
  async function off({ keepEngine = false } = {}) {
    if (burstTimer) clearTimeout(burstTimer);
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
    await queue.catch(() => {});
    releaseLease();
    execCell?.close();
    execCell = null;
    if (!keepEngine) await engine.stop();
    reader = null;
    pool = null;
    return status();
  }

  return Object.freeze({ on, off, status, decide, sleep: () => engine.sleep(), wake: () => engine.ensureAwake(), setWorker: (w) => { worker = w; }, get server() { return server; } });
}
