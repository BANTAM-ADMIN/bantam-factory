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
import { endpointKey, imageLeases, ImageGpuRuntime, acquireImageLease, localModelEndpoint, recoverOrphanedImageLease } from "../image-gpu.js";
import { compileHandlePool, createStructuredReader, decideJevAdaptive, rackOptions } from "../factory/system-one.js";
import { rerankToolCandidates } from "../factory/retrieval-ranker.js";
import { createExecCell } from "../factory/exec-gauge.js";
import { JevBusy, JevUnavailable, startJevHttpServer } from "./api.js";
import { createJevEngine } from "./engine.js";
import { resolveProfile } from "./profiles.js";
import { gpuHandoffConfig, prepareGpuFor, parkDiffusionGemma, restoreLocalModel, registerGpuOwner, recoverManagedGpu } from '../gpu-handoff.js';

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
  if (config.endpoint && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.endpoint).hostname)) return 'alongside';
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
  let unregisterOwner = null;
  let primary = false;
  const stats = { requests: 0, questions: 0, generations: 0, errors: 0, ms: [], swapsIn: 0, swapsOut: 0, startedAt: null };

  const policy = () => effectivePolicy(config, worker);
  const workerEndpoint = () => (primary || worker?.diffusionGemma ? null : worker ? localModelEndpoint(worker) : null);
  const managedGpu = () => Boolean(gpuHandoffConfig()) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.endpoint).hostname);

  async function ensureDecider() {
    if (!reader) {
      reader = createStructuredReader({ baseUrl: config.endpoint, model: config.servedModel, fetchImpl });
    }
    if (!pool) pool = await compileHandlePool(reader, { size: 256 });
    return { reader, pool };
  }

  function cell() {
    if (!execCell) {
      try { execCell = createExecCell({ image: config.execCellImage }); } catch { execCell = null; }
    }
    return execCell;
  }

  // Take the worker's GPU lease (src/model.js then holds new local calls) and
  // wait for llama.cpp to idle-sleep. False when there is no local worker.
  async function takeGpu(state) {
    const endpoint = workerEndpoint() || (managedGpu() ? gpuHandoffConfig()?.llamaEndpoint : null);
    if (!endpoint) return false;
    if (managedGpu()) {
      // A crashed/headless primary session can leave its physical reservation
      // behind. The existing recovery helper verifies that the owner is dead,
      // holds a recovery lock, and restores resources before deleting it.
      await recoverOrphanedImageLease({ url: `jev:${config.endpoint}`, gpu: { resourceKey: 'gpu:local:0' } }, recoverManagedGpu);
    }
    if (imageLeases().some((l) => l.endpoint === endpointKey(endpoint))) throw new JevBusy("the GPU is reserved for an image job; try again when it finishes");
    lease = acquireImageLease({ url: `jev:${config.endpoint}`, gpu: { resourceKey: 'gpu:local:0' } }, { kind: "jev", mode: 'vllm', endpoint: endpointKey(endpoint), state });
    if (managedGpu()) unregisterOwner = registerGpuOwner('jev', yieldGpu);
    const runtime = new ImageGpuRuntime({ mode: "llamacpp", endpoint: endpointKey(endpoint) }, { gpu: { sleepTimeoutMs: config.gpu.sleepTimeoutMs }, pollMs: 250 }, { fetchImpl });
    // The runtime bounds the wait by gpu.sleepTimeoutMs itself; an outer timeout
    // signal would replace its "start llama.cpp with --sleep-idle-seconds" advice.
    // Keep llama.cpp's GGUF cache warm rather than checkpointing two CUDA
    // runtimes together; this also leaves host RAM for vLLM's sleep buffers.
    if (managedGpu()) await prepareGpuFor('jev');
    else await runtime.sleep(new AbortController().signal);
    return true;
  }

  // Swap in: take the worker's GPU lease, let llama.cpp idle-sleep, wake DiffusionGemma.
  async function swapIn() {
    if (lease) return;
    try {
      if (!(await takeGpu("swapping-in"))) return;
      await engine.ensureAwake();
      lease.update({ state: "jev-awake" });
      stats.swapsIn++;
      log({ event: "jev_swap_in", endpoint: workerEndpoint() });
    } catch (error) {
      if (lease) {
        try {
          const current = await engine.status();
          if (current.state === 'awake') await engine.sleep();
          else if (current.state === 'starting') await engine.stop();
          if (managedGpu()) await restoreLocalModel(gpuHandoffConfig().llamaEndpoint);
          releaseLease();
        } catch (recovery) { lease.update({ state: 'recovery_required', error: recovery.message }); }
      }
      if (error instanceof JevBusy) throw error;
      throw new JevUnavailable(`could not take the GPU from the local worker: ${error.message}`);
    }
  }

  function releaseLease() {
    try { lease?.release(); } catch { /* already gone */ }
    lease = null;
    unregisterOwner?.(); unregisterOwner = null;
  }

  async function swapOut({ restoreLocal = true } = {}) {
    burstTimer = null;
    if (!lease) return;
    if (config.gpu.handback === "stop") {
      // Sleep mode keeps vLLM's process and about 2.5 GB of VRAM; a local model
      // that needs the whole card crashes waking into what is left.
      try { await engine.stop(); primed = false; }
      catch (error) { lease.update({ state: 'recovery_required' }); throw error; }
      reader = null;
      pool = null;
    } else {
      try { if (managedGpu()) await parkDiffusionGemma({ engine, jev: config }); else await engine.sleep(); }
      catch (error) { lease.update({ state: 'recovery_required' }); throw error; }
    }
    if (managedGpu()) {
      try {
        if (config.gpu.handback === 'stop') await parkDiffusionGemma({ engine, jev: config });
        if (restoreLocal) await restoreLocalModel(gpuHandoffConfig().llamaEndpoint);
      } catch (error) { lease.update({ state: 'recovery_required', error: error.message }); throw error; }
    }
    releaseLease();
    stats.swapsOut++;
    log({ event: "jev_swap_out" });
  }

  function armBurst() {
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { queue = queue.then(() => swapOut()).catch(error => log({ event: 'jev_recovery_required', error: error.message })); }, config.gpu.burstMs);
    burstTimer.unref?.();
  }

  async function readyForRequest() {
    // Selecting this backend also works without a local GPU broker (for
    // example, a separately hosted server). There is no worker to swap out.
    if (primary && !managedGpu()) { await engine.ensureAwake(); return; }
    const mode = policy();
    if (mode === "swap" || (managedGpu() && mode !== 'off')) { await swapIn(); return; }
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
  // Serialized use of the engine, with the GPU policy applied first and the
  // GPU handed back (or its burst window armed) afterwards.
  function onGpu(work, { releaseAfter = false } = {}) {
    if (waiting >= 64) return Promise.reject(new JevBusy("too many Jev requests are queued"));
    waiting++;
    const run = async () => {
      waiting--;
      try {
        await readyForRequest();
        return await work();
      } catch (error) {
        stats.errors++;
        if (error instanceof JevBusy || error instanceof JevUnavailable) throw error;
        if (/fetch failed|ECONNREFUSED|HTTP 5\d\d/.test(String(error.message))) throw new JevUnavailable(`inference backend unavailable: ${error.message}`);
        throw error;
      } finally {
        if (lease) {
          if (!primary && releaseAfter) { if (burstTimer) clearTimeout(burstTimer); await swapOut(); }
          else if (!primary) armBurst();
        }
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  function decide({ profile, state, questions, seed, thought, releaseAfter = false }) {
    return onGpu(async () => {
      const t0 = now();
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
    }, { releaseAfter });
  }

  // The primary agent uses the very same issued-handle reader as Jev. Choices
  // are controller-owned values, not sampled JSON or executable model text.
  function choose({ state, question, options, seed = 0, maxInputTokens, maxContextTokens, signal }) {
    if (!Array.isArray(options) || !options.length || options.length > 256) throw new TypeError('Tool selection needs 1..256 choices');
    return onGpu(async () => {
      signal?.throwIfAborted();
      if (options.length === 1) return { index: 0, evidence: { authority: 'exact', singleOption: true }, usage: { requests: 0 } };
      const { reader: r, pool: p } = await ensureDecider();
      signal?.throwIfAborted();
      const rack = rackOptions(p, options, { seed });
      const compiled = await r.compileLabels({ lead: 'q1: [', tail: ']', labels: rack.labels });
      const read = await r.read({ system: 'Select the immediate next operation supported by the supplied task and actual tool results. Reply exactly as q1: [HANDLE].',
        user: `${state}\n\nQUESTION: ${question}\nOPTIONS:\n${rack.material}`, compiled, seed, maxInputTokens, maxContextTokens, signal });
      const row = rack.rows.find(row => row.handle === read.choice);
      if (!row || read.missingLabels.length || !Number.isFinite(read.labelMass) || read.labelMass <= 0) throw new Error('Jev returned no fully supported tool choice');
      stats.requests++; stats.questions++; stats.ms.push(read.elapsedMs);
      if (stats.ms.length > 1000) stats.ms.shift();
      return { index: row.optionIndex, evidence: { ...read, authority: 'model' },
        usage: { requests: 1, inputTokens: read.promptTokens, outputTokens: 0, totalTokens: read.promptTokens } };
    });
  }

  /** Explicit ranking utility, serialized under the same GPU policy as decisions. */
  function rank({ state, questions, seed }) {
    return onGpu(async () => {
      const t0 = now();
      const { reader: r, pool: p } = await ensureDecider();
      const profile = resolveProfile("bantam-jev-fast");
      const fast = await decideJevAdaptive({ ...profile.options, reader: r, pool: p, state, questions, seed, execCell: cell() });
      const baseScores = Object.fromEntries(Object.entries(fast.answers).map(([id, answer]) => [id, answer.probabilities.yes]));
      const ranked = await rerankToolCandidates({ reader: r, pool: p, state, questions, baseScores, seed });
      stats.requests++;
      stats.questions += Object.keys(questions).length;
      stats.ms.push(now() - t0);
      if (stats.ms.length > 1000) stats.ms.shift();
      return { ...ranked, elapsedMs: now() - t0, usage: { inputTokens: fast.usage.inputTokens + ranked.usage.inputTokens, outputTokens: 0 } };
    });
  }

  /** Plain text from DiffusionGemma (thinking off), under the same GPU rules as decide. */
  function generate({ system = "You are a helpful, concise assistant.", user, maxTokens = 512, releaseAfter = false }) {
    return onGpu(async () => {
      reader ??= createStructuredReader({ baseUrl: config.endpoint, model: config.servedModel, fetchImpl });
      for (let attempt = 0; attempt < 3; attempt++) {
        const out = await reader.complete({ system, user, maxTokens });
        if (out.text.trim()) { stats.generations++; return out; }
      }
      throw new JevUnavailable('DiffusionGemma returned empty text after three attempts; try a larger output budget (at least 256 tokens).');
    }, { releaseAfter });
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
      primary,
      gpuLease: lease ? { held: true, state: lease.record.state } : { held: false },
      api: server ? { url: `http://${config.api.host}:${server.address().port}`, auth: Boolean(config.api.token) } : null,
      requests: stats.requests,
      questions: stats.questions,
      generations: stats.generations,
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
      throw new Error("serving Jev beyond localhost needs an API token (run `bantamfactory jev token`)");
    }
    if (primary) await runPrimary(async () => {});
    else if (policy() === "swap" || managedGpu()) {
      // A cold start or a wake needs the GPU the local worker is holding: wait
      // for it to sleep first, or vLLM cannot allocate and exits while loading.
      // Queued behind any decide in flight; nothing to do while Jev already
      // holds the GPU (the engine is awake in its burst window).
      const bringUp = async () => {
        // Under handback "stop" the engine lives only while Jev holds the GPU:
        // it starts on the first question instead.
        if (lease || config.gpu.handback === "stop") return;
        onProgress("waiting for the local model to go idle and release the GPU");
        let took = false;
        try { took = await takeGpu("starting"); }
        catch (error) {
          try { if (managedGpu()) await restoreLocalModel(gpuHandoffConfig().llamaEndpoint); releaseLease(); }
          catch (recovery) { lease?.update({ state: 'recovery_required', error: recovery.message }); }
          if (error instanceof JevBusy) throw error;
          throw new JevUnavailable(`could not take the GPU from the local worker: ${error.message}`);
        }
        try {
          await engine.start({ onProgress });
          if (!primed) onProgress("priming sleep mode once (the first sleep copies the weights to host memory; later swaps take about a second)");
          if (managedGpu()) await parkDiffusionGemma({ engine, jev: config }); else await engine.sleep();
          primed = true;
          if (managedGpu()) {
            await restoreLocalModel(gpuHandoffConfig().llamaEndpoint);
          }
          if (took) releaseLease();
        } catch (error) {
          try {
            await engine.stop();
            if (managedGpu()) await restoreLocalModel(gpuHandoffConfig().llamaEndpoint);
            if (took) releaseLease();
          } catch (recovery) { lease?.update({ state: 'recovery_required', error: recovery.message }); }
          throw error;
        }
      };
      const next = queue.then(bringUp, bringUp);
      queue = next.catch(() => {});
      await next;
    } else await engine.start({ onProgress });
    if (policy() !== "swap" && !managedGpu()) await ensureDecider();
    stats.startedAt = new Date(now()).toISOString();
    if (serve && !server) {
      server = await startJevHttpServer({
        decide, rank, status, gauges: JEV_GAUGES, token: () => config.api.token,
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
    execCell?.close();
    execCell = null;
    // Disabling the decision API must not stop the selected chat backend.
    if (primary) { reader = null; pool = null; return status(); }
    if (!keepEngine) await engine.stop();
    else if (managedGpu() && (await engine.status()).state === 'awake') await parkDiffusionGemma({ engine, jev: config });
    if (managedGpu()) await restoreLocalModel(gpuHandoffConfig().llamaEndpoint);
    releaseLease();
    unregisterOwner?.(); unregisterOwner = null;
    reader = null;
    pool = null;
    return status();
  }

  function yieldGpu(options) {
    if (burstTimer) clearTimeout(burstTimer);
    const next = queue.then(() => swapOut(options), () => swapOut(options));
    queue = next.catch(() => {});
    return next;
  }
  function runPrimary(work) {
    primary = true;
    if (burstTimer) clearTimeout(burstTimer);
    return onGpu(work);
  }
  function releasePrimary({ restoreLocal = false } = {}) {
    const release = async () => {
      primary = false;
      if (burstTimer) clearTimeout(burstTimer);
      await swapOut({ restoreLocal });
    };
    const next = queue.then(release, release); queue = next.catch(() => {}); return next;
  }
  return Object.freeze({ on, off, status, decide, choose, rank, generate, yieldGpu,
    runPrimary, releasePrimary,
    sleep: async () => { if (lease) await yieldGpu(); else await engine.sleep(); },
    wake: () => { const next = queue.then(async () => { if (managedGpu()) { await swapIn(); armBurst(); return status(); } return engine.ensureAwake(); }); queue = next.catch(() => {}); return next; },
    setWorker: (w) => { worker = w; }, get server() { return server; } });
}
