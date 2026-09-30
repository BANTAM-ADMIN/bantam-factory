import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ComfyClient, readComfyConfig, renderWorkflow } from './comfyui-client.js';
import { ensureComfyStarted } from './comfyui-start.js';
import { extractImageOptions, parseImageRequest } from './codex-image.js';
import { acquireImageLease, recoverOrphanedImageLease, gpuPlan, ImageGpuRuntime, imageLeases, localModelEndpoint } from '../image-gpu.js';
import { ImageProgress, timingKey, imageTimingEstimate, saveImageTiming } from './image-progress.js';

const terminal = new Set(['completed', 'failed', 'cancelled', 'recovery_required']);
const DEFAULT_SIZES = Object.freeze({
  square: '1024x1024',
  landscape: '1280x720',
  portrait: '720x1280',
  standard: '1152x864',
  'standard-portrait': '864x1152',
  widescreen: '1280x720',
  tall: '720x1280',
  cinematic: '1344x576',
});

/** Extract Comfy-specific choices without changing the Codex image grammar. */
export function extractComfyImageOptions(query) {
  let text = String(query ?? '');
  const match = text.match(/(?:^|\s)--(?:aspect|ratio)[= ]([^\s]+)/i);
  const aspect = match?.[1]?.toLowerCase() ?? null;
  if (match) text = text.replace(match[0], ' ');
  const raw = /(?:^|\s)--(?:raw|raw-prompt)(?=\s|$)/i.test(text);
  if (raw) text = text.replace(/(?:^|\s)--(?:raw|raw-prompt)(?=\s|$)/ig, ' ');
  return { ...extractImageOptions(text), aspect, raw };
}

const KREA_PROMPT_SYSTEM = `You are an expert Krea-2 prompt engineer and visual analyst. Turn the user's request into a rich, faithful Krea 2 Turbo prompt in one or two cohesive natural-language paragraphs. Preserve every explicit subject, action, style, aspect ratio, and text requirement; do not invent a different subject or contradict the request.

Start directly with the scene. Never say "the image shows", explain your process, add headings, or write keyword soup. Describe the main subject, exact pose, body language, gaze, expression, action, clothing, hair, accessories, materials, and important props when relevant. State composition, shot size, framing, perspective, camera angle, focus, depth of field, negative space, and spatial relationships. Describe the environment and its textures, then lighting direction and quality, shadows, highlights, palette, contrast, atmosphere, and apparent medium or aesthetic. Quote every requested legible word exactly in double quotes.

For an interface, graphic-design, diagram, poster, or other complex layout, begin with its overall style and describe the scene top-to-bottom. Specify each element's shape, color, relative size, exact position, typography, text, weight, decoration, and font character, plus vantage height and camera angle. Use vivid declarative rendering language. Output only the finished Krea prompt.`;

export async function expandKreaPrompt(request, { model, signal, config, raw = false, env = process.env } = {}) {
  const source = String(request ?? '').trim();
  const disabled = /^(0|false|no|off|raw)$/i.test(String(env.BANTAM_COMFYUI_PROMPT_EXPANSION ?? ''));
  if (!source || raw || config?.promptExpansion === false || disabled || typeof model?.complete !== 'function') {
    return { prompt: source, expanded: false, reason: raw ? 'raw prompt requested' : 'prompt expansion unavailable or disabled' };
  }
  try {
    const result = await model.complete(`${KREA_PROMPT_SYSTEM}\n\nUser request:\n${source}\n\nKrea 2 prompt:\n`, {
      nPredict: 700, temperature: 0.35, signal,
    });
    const prompt = String(result?.content ?? result ?? '').trim()
      .replace(/^['"]([\s\S]*)['"]$/, '$1').trim();
    // A short or absurdly long completion is less useful than the request the
    // operator already wrote. The image should still be generated.
    if (prompt.length < 24 || prompt.length > 8_000) throw Error('prompt expansion returned an unusable length');
    return { prompt, expanded: true };
  } catch (error) {
    return { prompt: source, expanded: false, reason: `prompt expansion unavailable: ${error.message}` };
  }
}

export function comfySizeChoices(config = {}) {
  const custom = config.sizes && typeof config.sizes === 'object' && !Array.isArray(config.sizes) ? config.sizes : {};
  return { ...DEFAULT_SIZES, ...custom };
}

export function formatComfySizeChoices(config = {}) {
  return Object.entries(comfySizeChoices(config)).map(([name, size]) => `${name} (${size})`).join(' · ');
}

export function resolveComfyDimensions(options, config) {
  const requestedSize = String(options.size ?? 'auto').trim().toLowerCase();
  const requestedAspect = options.aspect ? String(options.aspect).trim().toLowerCase() : null;
  if (requestedSize !== 'auto' && requestedAspect) throw Error('Use either --size or --aspect, not both');
  let value = requestedAspect || requestedSize;
  if (value === 'auto') return { width: undefined, height: undefined, selected: 'workflow default' };
  const choices = comfySizeChoices(config);
  if (Object.hasOwn(choices, value)) value = String(choices[value]);
  // Ratios are deliberately resolved to practical Krea defaults, so a request
  // such as --aspect 16:9 does not produce an awkward 16x9 latent image.
  const ratio = value.match(/^(\d+):(\d+)$/);
  if (ratio) {
    const [w, h] = ratio.slice(1).map(Number);
    if (!w || !h) throw Error('Aspect ratio values must be positive, for example --aspect 16:9');
    const ratioValue = w / h;
    const candidates = Object.values(choices).filter(candidate => /^(\d+)x(\d+)$/.test(candidate));
    const closest = candidates.sort((a, b) => {
      const pa = a.split('x').map(Number); const pb = b.split('x').map(Number);
      return Math.abs(pa[0] / pa[1] - ratioValue) - Math.abs(pb[0] / pb[1] - ratioValue);
    })[0];
    if (!closest || Math.abs(closest.split('x').map(Number).reduce((a, b) => a / b) - ratioValue) > 0.01) {
      throw Error(`No configured Krea size matches --aspect ${value}. Use --size WIDTHxHEIGHT or add it to sizes in .bantam/comfyui.json.`);
    }
    value = closest;
  }
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) throw Error(`Unknown image size "${value}". Use --size WIDTHxHEIGHT, --aspect W:H, or :image sizes.`);
  const [width, height] = match.slice(1).map(Number);
  const multiple = Number(config.dimensionMultiple ?? 16);
  const maxPixels = Number(config.maxPixels ?? 8_294_400);
  if (!Number.isInteger(multiple) || multiple < 1) throw Error('ComfyUI dimensionMultiple must be a positive integer');
  if ([width, height].some(n => n < 64 || n > 8192 || n % multiple)) {
    throw Error(`ComfyUI dimensions must be multiples of ${multiple} between 64 and 8192`);
  }
  if (width * height > maxPixels) throw Error(`ComfyUI image size exceeds the configured ${maxPixels.toLocaleString()} pixel limit`);
  return { width, height, selected: `${width}x${height}` };
}

export async function checkComfyGpuHeadroom(client, config, signal) {
  const stats = await client.request('/system_stats', { signal });
  const devices = (stats.devices || []).filter(d => d.type !== 'cpu');
  if (!devices.length || devices.some(d => !Number.isFinite(d.vram_total) || !Number.isFinite(d.vram_free) || d.vram_total <= 0 || d.vram_free < 0)) {
    throw Error('Cannot verify GPU telemetry from ComfyUI system_stats');
  }
  const minimumMb = config.gpu?.minFreeVramMb;
  if (minimumMb !== undefined && (!Number.isFinite(minimumMb) || minimumMb <= 0)) throw Error('gpu.minFreeVramMb must be a positive number');
  if (devices.some(d => d.vram_free < (minimumMb === undefined ? d.vram_total * 0.85 : minimumMb * 1024 * 1024))) {
    throw Error('Insufficient GPU headroom for ComfyUI; free VRAM or lower gpu.minFreeVramMb only if the workflow fits safely');
  }
  return devices.map(d => ({ index: d.index, free: d.vram_free }));
}

export class ComfyImageJobs {
  constructor(workspace, { onEvent = () => {}, clientFactory = c => new ComfyClient(c),
    runtimeFactory = (p, c) => new ImageGpuRuntime(p, c), startComfy = ensureComfyStarted, leaseDirectory } = {}) {
    this.workspace = path.resolve(workspace);
    this.onEvent = onEvent;
    this.clientFactory = clientFactory;
    this.runtimeFactory = runtimeFactory;
    this.startComfy = startComfy;
    this.leaseDirectory = leaseDirectory;
    this.job = null;
  }
  get busy() { return !!this.job && !terminal.has(this.job.state); }
  get sleeping() { return !!this.job?.shared && (this.busy || this.job.state === 'recovery_required'); }
  emit(job, state, message) {
    job.state = state;
    job.lease?.update({ state, promptId: job.promptId });
    this.onEvent({ type: 'comfyui_image', id: job.id, state, shared: job.shared, message, artifacts: job.artifacts });
  }
  status() {
    const j = this.job;
    if (!j) return '[image_status] No image job in this session.';
    return `[image_status] ${j.id}: ${j.state}${j.error ? ` — ${j.error}` : ''}${j.progress && this.busy ? `\n${j.progress.snapshot(j.config.workflow).message}` : ''}\n${j.artifacts.join('\n')}`;
  }
  async generate(query, { model, background = false, env = process.env, signal } = {}) {
    if (this.busy || this.job?.state === 'recovery_required') throw Error('An image job is already active or needs :image recover. Use image_status or cancel_image.');
    const config = readComfyConfig(this.workspace, env);
    const options = extractComfyImageOptions(query);
    const { prompt, variants } = parseImageRequest(options.rest);
    if (!prompt) throw Error('usage: generate_image <prompt> [--variants=1..4] [--size auto|WIDTHxHEIGHT|PRESET] [--aspect W:H]');
    if (options.quality && options.quality !== 'auto') throw Error('ComfyUI quality is set by the workflow; omit --quality or use auto');
    const dimensions = resolveComfyDimensions(options, config);
    const { width, height } = dimensions;
    const plan = gpuPlan(config, model);
    const job = { id: crypto.randomUUID(), state: 'prompting', shared: plan.shared, config, plan,
      originalPrompt: prompt, prompt, variants, width, height, dimensions: dimensions.selected, artifacts: [], images: [], startedAt: Date.now(), controller: new AbortController(), cleanupController: new AbortController() };
    this.job = job;
    const asynchronous = background && !plan.shared;
    const cancelFromRun = () => job.controller.abort(Error('Image generation cancelled'));
    if (!asynchronous) {
      signal?.addEventListener('abort', cancelFromRun, { once: true });
      if (signal?.aborted) cancelFromRun();
    }
    job.promise = Promise.resolve().then(async () => {
    this.emit(job, 'prompting', 'Expanding your request into a Krea 2 visual prompt…');
    try {
      job.controller.signal.throwIfAborted();
      await this.recoverOrphan(config);
      job.controller.signal.throwIfAborted();
      const expansion = await expandKreaPrompt(prompt, { model, signal: job.controller.signal, config, raw: options.raw, env });
      job.controller.signal.throwIfAborted();
      job.prompt = expansion.prompt;
      job.promptExpanded = expansion.expanded;
      if (expansion.expanded) this.emit(job, 'prompting', `Krea 2 prompt:\n${job.prompt}`);
      else if (expansion.reason?.startsWith('prompt expansion unavailable:')) this.emit(job, 'warning', `${expansion.reason}. Using your original request.`);
      // Validate bindings before acquiring resources or changing model state.
      renderWorkflow(config, { prompt: job.prompt, width, height });
      job.client = this.clientFactory(config);
      job.runtime = this.runtimeFactory(plan, config);
      job.lease = acquireImageLease(config, { id: job.id, workspace: this.workspace, endpoint: plan.endpoint,
        mode: plan.mode, shared: plan.shared, state: job.state, promptId: null }, this.leaseDirectory);
    } catch (error) {
      job.error = String(error.message || error);
      this.emit(job, job.controller.signal.aborted ? 'cancelled' : 'failed', job.error);
      throw error;
    }
    await this.execute(job);
    }).finally(() => signal?.removeEventListener('abort', cancelFromRun));
    // Background failures are reported through status/events, not an unhandled rejection.
    job.promise.catch(() => {});
    if (asynchronous) return `[generate_image] ComfyUI job ${job.id} started in the background. Continue chatting or working. Use image_status for results or cancel_image to stop it.`;
    await job.promise;
    return this.status().replace('[image_status]', '[generate_image]');
  }

  async execute(job) {
    const { config, client, runtime } = job;
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(config.timeoutMs)]);
    let touched = false;
    try {
      this.emit(job, 'checking', 'Checking ComfyUI workflow and available models…');
      // Check connectivity before changing the LLM state. If offline, sleep the
      // local model first, then verify VRAM and launch the configured install.
      let offline = false;
      try { await client.check(signal); }
      catch (error) {
        if (!['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.cause?.code ?? error?.code)) throw error;
        offline = true;
      }
      if (job.plan.mode !== 'none') {
        touched = true; // A cancelled sleep request may already have released the model.
        this.emit(job, 'sleeping', job.shared
          ? 'Putting the local LLM to sleep to free GPU memory. It will resume when the image is ready.'
          : 'Releasing the configured local GPU. Your active LLM can keep chatting.');
        await runtime.sleep(signal);
      }
      if (offline) {
        job.comfyReady = false;
        this.emit(job, 'starting', 'Checking GPU VRAM and starting ComfyUI…');
        await this.startComfy(config, client, { signal });
        job.comfyReady = true;
        await client.check(signal);
      }
      // Even with no local LLM to sleep, ComfyUI must have enough free VRAM.
      // The sleep flag can become visible before CUDA allocations are released.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.gpu?.sleepTimeoutMs ?? 60_000)]);
      for (;;) {
        try {
          job.freeBefore = await checkComfyGpuHeadroom(client, config, deadline);
          break;
        } catch (error) {
          if (!job.plan.endpoint || !/Insufficient GPU headroom/.test(error.message)) throw error;
          await delay(config.pollMs, undefined, { signal: deadline });
        }
      }
      const outputDir = path.join(this.workspace, 'assets', 'generated');
      fs.mkdirSync(outputDir, { recursive: true });
      for (let variant = 1; variant <= job.variants; variant++) {
        signal.throwIfAborted();
        await client.requireIdle(signal);
        this.emit(job, 'generating', `${job.shared ? 'Local LLM is sleeping. ' : ''}ComfyUI is generating image ${variant}/${job.variants}.`);
        const seed = crypto.randomInt(0, 2 ** 48 - 1);
        const workflow = renderWorkflow(config, { prompt: job.prompt, seed, width: job.width, height: job.height,
          prefix: `BANTAM/${job.id}-${variant}` });
        // Persist the proposed ID before submission, including ambiguous network failures.
        job.promptId = crypto.randomUUID();
        job.lease.update({ promptId: job.promptId });
        job.timingKey = timingKey(config, job.width, job.height, variant);
        job.progress = new ImageProgress({ estimate: imageTimingEstimate(this.workspace, job.timingKey), stallWarningMs: config.stallWarningMs });
        job.stopWatching = await client.watch(job.promptId, event => {
          job.progress.update(event);
          this.reportProgress(job);
        }, signal);
        this.reportProgress(job, true);
        touched = true;
        job.promptId = await client.submit(workflow, job.promptId);
        job.lease.update({ promptId: job.promptId });
        const entry = await client.wait(job.promptId, signal, () => this.reportProgress(job));
        job.stopWatching?.(); job.stopWatching = null;
        const images = config.outputs.flatMap(id => entry.outputs?.[id]?.images || []);
        if (!images.length) throw Error('Workflow completed without images at its configured output nodes');
        for (let index = 0; index < images.length; index++) {
          const item = images[index];
          const params = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
          const { data, extension } = await client.request(`/view?${params}`, { signal, binary: true });
          const rel = `assets/generated/comfyui-${job.id}-${variant}-${index + 1}${extension}`;
          fs.writeFileSync(path.join(this.workspace, rel), data, { flag: 'wx' });
          job.artifacts.push(rel);
          job.images.push({ path: rel, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length,
            seed, variant, promptId: job.promptId });
        }
        try { saveImageTiming(this.workspace, job.timingKey, Date.now() - job.progress.start); }
        catch (e) { this.onEvent({ type: 'comfyui_image', state: 'warning', message: `Could not save timing estimate: ${e.message}` }); }
      }
    } catch (error) {
      job.error = job.controller.signal.aborted ? 'Cancelled by operator' : String(error.message || error);
    } finally {
      job.stopWatching?.();
      try {
        if (touched) await this.restore(job);
        job.lease.release();
        job.lease = null;
        this.emit(job, job.error ? (job.controller.signal.aborted ? 'cancelled' : 'failed') : 'completed',
          job.error ? `${job.error}${job.plan.mode !== 'none' ? ' Local LLM is available again.' : ''}`
            : `Image generation complete.${job.plan.mode !== 'none' ? ' Local LLM is available again.' : ''}`);
      } catch (error) {
        job.error = [job.error, `Recovery required: ${error.message}. Run :image recover.`].filter(Boolean).join(' — ');
        this.emit(job, 'recovery_required', job.error);
      }
      // Keep evidence even for cancellation, partial output, or recovery failure.
      try {
        const rel = `assets/generated/comfyui-${job.id}.json`;
        fs.mkdirSync(path.dirname(path.join(this.workspace, rel)), { recursive: true });
        fs.writeFileSync(path.join(this.workspace, rel), JSON.stringify({ provider: 'comfyui', id: job.id,
          state: job.state, originalPrompt: job.originalPrompt, prompt: job.prompt, promptExpanded: job.promptExpanded,
          workflowSha256: config.workflowHash, variants: job.variants,
          dimensions: job.dimensions,
          elapsedMs: Date.now() - job.startedAt, images: job.images, error: job.error || null }, null, 2));
        job.artifacts.push(rel);
        if (['completed', 'failed', 'cancelled', 'recovery_required'].includes(job.state)) {
          this.onEvent({ type: 'comfyui_image', id: job.id, state: job.state, shared: job.shared,
            message: job.state === 'completed' ? 'Image manifest saved.' : 'Image manifest saved with failure details.', artifacts: job.artifacts });
        }
      } catch (e) { this.onEvent({ type: 'comfyui_image', state: 'warning', message: `Could not save image manifest: ${e.message}` }); }
    }
  }

  reportProgress(job, force = false) {
    if (!force && Date.now() - (job.lastProgressReport || 0) < 5000) return;
    job.lastProgressReport = Date.now();
    const progress = job.progress.snapshot(job.config.workflow);
    this.onEvent({ type: 'comfyui_image', id: job.id, state: 'progress', shared: job.shared, ...progress });
    for (const message of progress.warnings) this.onEvent({ type: 'comfyui_image', id: job.id, state: 'warning', message });
  }

  async restore(job) {
    job.cleanupController ??= new AbortController();
    const signal = AbortSignal.any([job.cleanupController.signal, AbortSignal.timeout(job.config.cleanupTimeoutMs)]);
    signal.throwIfAborted();
    this.emit(job, 'restoring', 'Stopping any remaining image work and releasing ComfyUI GPU memory…');
    let offline = false;
    if (job.comfyReady !== false) {
      try {
        await job.client.cancel(job.promptId, signal);
        await job.client.unload(signal);
      } catch (error) {
        // A refused loopback connection means the local image service has
        // exited. Still prove the LLM can infer before releasing its lease.
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(job.config.url).hostname);
        if (!local || (error.cause?.code ?? error.code) !== 'ECONNREFUSED' || signal.aborted) throw error;
        offline = true;
      }
    }
    if (job.freeBefore && !offline) {
      for (;;) {
        const stats = await job.client.request('/system_stats', { signal });
        const tolerance = (job.config.gpu?.maxComfyVramMb ?? 1024) * 1024 * 1024;
        if (job.freeBefore.every(before => (stats.devices || []).some(d => d.index === before.index && d.vram_free >= before.free - tolerance))) break;
        await delay(job.config.pollMs, undefined, { signal });
      }
    }
    this.emit(job, 'waking', job.plan.mode === 'none' ? 'ComfyUI GPU memory released.' : 'Waking the local LLM…');
    await job.runtime.wake(signal);
  }

  // First Ctrl-C cancels; a second stops waiting for cleanup, preserving the
  // lease so local inference cannot race GPU work whose release is unverified.
  interrupt() {
    if (!this.busy) return false;
    const job = this.job;
    if (!job.controller.signal.aborted) {
      this.onEvent({ type: 'comfyui_image', state: 'warning', message: 'Stopping image generation and restoring GPU availability… Press Ctrl-C again to stop waiting for cleanup (recovery may be required).' });
      void this.cancel();
    } else if (!job.cleanupController.signal.aborted) {
      this.onEvent({ type: 'comfyui_image', state: 'warning', message: 'Stopping GPU cleanup wait. Use :image recover before reusing the local GPU.' });
      job.cleanupController.abort(Error('GPU cleanup interrupted by operator'));
    }
    return true;
  }

  async cancel() {
    if (!this.busy) return this.status();
    this.job.controller.abort(Error('Image generation cancelled'));
    await this.job.promise.catch(() => {});
    return this.status();
  }
  async recoverOrphan(config) {
    return recoverOrphanedImageLease(config, async (record, lease) => {
      const plan = { mode: record.mode, endpoint: record.endpoint, shared: record.shared };
      this.onEvent({ type: 'comfyui_image', state: 'restoring',
        message: 'Recovering an image reservation left by a closed BANTAM session…' });
      await this.restore({ ...record, config, plan, lease, artifacts: [],
        client: this.clientFactory(config), runtime: this.runtimeFactory(plan, config) });
    }, this.leaseDirectory);
  }
  async prepareLocalModel(model, env = process.env) {
    const endpoint = localModelEndpoint(model);
    if (!endpoint || !imageLeases(this.leaseDirectory).some(l => l.endpoint === endpoint)) return;
    const config = readComfyConfig(this.workspace, env);
    if (!imageLeases(this.leaseDirectory).some(l => l.endpoint === endpoint && l.url === config.url)) return;
    await this.recoverOrphan(config);
  }
  async recover(env = process.env) {
    if (this.busy) throw Error('Cancel the active job before attempting recovery');
    if (this.job?.state !== 'recovery_required') {
      const config = readComfyConfig(this.workspace, env);
      if (await this.recoverOrphan(config)) return 'Recovery complete. The orphaned image reservation has been released.';
      const record = imageLeases(this.leaseDirectory).find(l => l.workspace === this.workspace && l.url === config.url);
      if (!record) return 'No image recovery is needed.';
      let alive = true;
      try { process.kill(record.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) throw Error('The image job still belongs to a running BANTAM process');
      const plan = { mode: record.mode, endpoint: record.endpoint, shared: record.shared };
      this.job = { ...record, state: 'recovery_required', config, plan, artifacts: [],
        client: this.clientFactory(config), runtime: this.runtimeFactory(plan, config),
        lease: { update(fields) { Object.assign(record, fields); fs.writeFileSync(record.file, JSON.stringify(record)); },
          release() { fs.unlinkSync(record.file); } } };
    }
    try {
      this.job.cleanupController = new AbortController();
      await this.restore(this.job);
      this.job.lease.release(); this.job.lease = null;
      this.job.error = 'Image job ended during recovery';
      this.emit(this.job, 'cancelled', 'Recovery complete. The local LLM is available.');
    } catch (e) {
      this.emit(this.job, 'recovery_required', `Recovery failed: ${e.message}`);
      throw e;
    }
    return this.status();
  }
  async close() {
    if (this.busy) await this.cancel();
    if (this.job?.state === 'recovery_required') await this.recover();
  }
}

export function comfyImageTools(jobs, options = {}) {
  return [{
    name: 'generate_image', verbs: ['generate_image'],
    description: 'generate an image through the configured ComfyUI workflow. It expands the request into a detailed Krea 2 natural-language visual prompt first: generate_image <prompt> [--variants=1..4] [--size auto|WIDTHxHEIGHT|square|landscape|portrait|standard|cinematic] [--aspect W:H] [--raw]. Hosted LLM sessions run images in the background; shared local GPUs pause the LLM until generation finishes. Results go to assets/generated/.',
    async answer(query) {
      try { return await jobs.generate(query, options); }
      catch (e) { return `[generate_image] ${e.message}`; }
    },
  }, {
    name: 'image_status', verbs: ['image_status'], description: 'report the current ComfyUI image job and saved image paths; avoid repeated polling while it runs.',
    answer: () => jobs.status(),
  }, {
    name: 'cancel_image', verbs: ['cancel_image'], description: 'cancel this session’s ComfyUI image job and restore the local LLM when needed.',
    answer: () => jobs.cancel(),
  }];
}

// No model call is involved in this input path. It also works during GPU recovery.
export class ImageSleepInput {
  constructor(jobs, { emit, queue }) { this.jobs = jobs; this.emit = emit; this.queue = queue; this.awaiting = false; }
  finished() { this.awaiting = false; }
  handle(text) {
    if (!this.jobs.sleeping) { this.awaiting = false; return false; }
    if (this.jobs.job.state === 'recovery_required') {
      this.emit('The local LLM needs GPU recovery. Use :image recover.');
      return false;
    }
    if (this.awaiting) {
      if (!/^(?:y|yes|n|no)?$/i.test(text.trim())) {
        this.emit('Please answer Y to stop generation or N to keep waiting.');
        return true;
      }
      this.awaiting = false;
      if (/^y(?:es)?$/i.test(text.trim())) {
        this.emit('Stopping image generation, then waking the local LLM. Your message is queued.');
        void this.jobs.cancel();
      } else this.emit('Continuing image generation. Your message will be handled when the LLM resumes.');
      return true;
    }
    if (!text.trim()) return true;
    this.queue(text);
    if (['restoring', 'waking'].includes(this.jobs.job.state)) {
      this.emit('The local LLM is resuming. Your message is queued.');
    } else {
      this.awaiting = true;
      this.emit('The local LLM is sleeping while ComfyUI prepares or generates your image. Stop generation and wake the LLM? [y/N] Your message is queued.');
    }
    return true;
  }
}
