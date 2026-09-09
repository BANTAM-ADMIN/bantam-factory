// Codex app-server transport.
//
// Codex subscription access is an agent-runtime protocol, not an OpenAI HTTP
// completion endpoint. The measured default reuses one native thread only
// inside an explicitly bounded BANTAM run: the first call supplies the complete
// canonical prompt and later calls append exact, acknowledged incremental
// deltas. Rewritten canonical history starts a fresh thread. Explicit
// ephemeral/full mode remains the clean rollback. In both modes BANTAM remains
// authoritative for history, tools, verification, and the action loop.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { ActionSchema, parseAction } from "./actions.js";
import { CodexUsageAccumulator, emptyCodexUsage } from "./codex-usage.js";

const DEFAULT_COMMAND = process.env.BANTAM_CODEX_COMMAND || "codex";
const DEFAULT_CONTROL_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const PROMPT_DELTA_MARKER = "BANTAM_PROMPT_DELTA_V1";
const INCREMENTAL_DELTA_MARKER = "BANTAM_PROMPT_DELTA_V2";
const OBSERVATION_MARKER = "BANTAM_OBSERVATION_V1\n";
const ACTION_OBSERVATION_MARKER = "BANTAM_ACTION_OBSERVATION_V1\n"
  + "BANTAM selected the first JSON action in your last reply. Surrounding prose and additional objects were not actions. Your reply is already in this thread; continue from the reported result below.\n";
const ASSISTANT_HEAD = "<|im_start|>assistant\n";
const OBSERVATION_HEAD = "<|im_end|>\n<|im_start|>user\n";
const OBSERVATION_TAIL = `<|im_end|>\n${ASSISTANT_HEAD}`;
const MIN_DELTA_PREFIX_CHARS = 2048;
// BANTAM executes tools; its text worker does not need Codex's second tool
// menu. These supported feature switches remove ~3k input tokens per request
// in the recorded Astra calibration. Image workers explicitly retain their
// image-generation capability. Caller thread configuration remains explicit.
const EMBEDDED_CONFIG = {
  'features.shell_tool': false, 'features.multi_agent': false,
  // Model metadata can select the newer agent runtime independently of the
  // legacy feature switch. Disable it explicitly: BANTAM owns its workers.
  'agents.enabled': false,
  'features.view_image': false, 'features.image_generation': false,
  'features.sleep_tool': false, 'features.skill_search': false,
  'features.goals': false, web_search: 'disabled',
};
// The text worker cannot use native skills or native shell approvals. Suppress
// their prompt scaffolding, not their enforcement: thread/start still denies
// approvals, keeps a read-only sandbox and exposes no environments. The live
// Astra calibration removed 2,759 input tokens with the same requested action.
// Image generation keeps native guidance; caller configuration takes priority.
const TEXT_WORKER_CONFIG = {
  'skills.include_instructions': false, 'skills.bundled.enabled': false,
  include_permissions_instructions: false,
};
const BASE_INSTRUCTIONS = [
  "You are the model runtime embedded inside the BANTAM agent harness.",
  "BANTAM owns the conversation, tools, workspace operations, and verification.",
  "Do not call native Codex tools, inspect the workspace, or perform the requested task directly.",
  "Treat the user input as a fully assembled model prompt and produce only the completion it requests.",
  "When it requests a JSON action, return exactly one JSON object and no markdown or commentary.",
  "BANTAM_OBSERVATION_V1 supplies new observations after your last action. Your previous answer is already in this thread; use the observations to choose the next action.",
].join(" ");

// A deliberately narrow escape hatch from the constrained coding thread. The
// image worker may invoke Codex image generation, but still may not inspect or
// modify the user's workspace. BANTAM receives the resulting file and applies
// its ordinary workspace/scope accounting itself.
const IMAGE_INSTRUCTIONS = [
  "You are BANTAM's image-generation worker.",
  "Generate exactly one image for the supplied request using Codex image generation.",
  "Do not inspect files, use shell tools, or edit the workspace.",
  "After the image tool completes, reply with a one-sentence completion notice.",
].join(" ");

// Editing is generation with the source attached. The worker is told to CHANGE
// the supplied image rather than invent a new one, because the same endpoint
// will happily ignore a reference and produce something unrelated.
const IMAGE_EDIT_INSTRUCTIONS = [
  "You are BANTAM's image-editing worker.",
  "The user turn attaches one source image. Produce exactly one NEW image that is the source image with the requested change applied.",
  "Preserve the source's subject, composition, and style except where the request asks otherwise.",
  "Do not inspect files, use shell tools, or edit the workspace.",
  "After the image tool completes, reply with a one-sentence completion notice.",
].join(" ");

const VISION_INSTRUCTIONS = [
  "You are BANTAM's visual-inspection worker.",
  "Inspect only the image attached to the user turn and answer the supplied visual question.",
  "Do not inspect files, use shell tools, or edit the workspace.",
  "Be literal about visible evidence, quote legible text exactly, and distinguish observations from interpretation.",
].join(" ");

export class CodexAppServer {
  constructor({
    command = DEFAULT_COMMAND,
    commandArgs = [],
    env = null,
    threadConfig = null,
    cwd = process.cwd(),
    model = "gpt-5.6-sol",
    effort = "high",
    timeoutMs = 600000,
    idleTimeoutMs = positiveTimeout(
      process.env.BANTAM_CODEX_IDLE_TIMEOUT_MS,
      Math.min(timeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    ),
    controlTimeoutMs = positiveTimeout(
      process.env.BANTAM_CODEX_CONTROL_TIMEOUT_MS,
      Math.min(timeoutMs, DEFAULT_CONTROL_TIMEOUT_MS),
    ),
    threadMode = process.env.BANTAM_CODEX_THREAD_MODE,
    promptMode = process.env.BANTAM_CODEX_PROMPT_MODE,
    rebaseEvery = process.env.BANTAM_CODEX_REBASE_EVERY || 0,
    rebaseMinSavings = process.env.BANTAM_CODEX_REBASE_MIN_SAVINGS || 0,
  } = {}) {
    this.command = command;
    this.commandArgs = commandArgs;
    this.environment = env;
    this.threadConfig = threadConfig;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.timeoutMs = timeoutMs;
    this.idleTimeoutMs = Math.min(timeoutMs, idleTimeoutMs);
    this.controlTimeoutMs = Math.min(timeoutMs, controlTimeoutMs);
    this.threadMode = normalizeThreadMode(threadMode ?? "run");
    this.promptMode = normalizePromptMode(
      promptMode ?? (this.threadMode === "run" ? "delta" : "full"),
    );
    this.rebaseEvery = nonNegativeInteger(rebaseEvery, "Codex rebase interval");
    this.rebaseMinSavings = unitInterval(rebaseMinSavings, "Codex rebase minimum savings");
    if (this.promptMode === "delta" && this.threadMode !== "run") {
      throw new Error("Codex prompt delta mode requires thread mode run");
    }
    this.activeRun = null;
    this.runCompletion = null;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runLastPrompt = null;
    this.runLastCompletion = null;
    this.runThreadCalls = 0;
    this.child = null;
    this.lines = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.usageCursors = new Map();
    this.ready = null;
    this.stderr = "";
  }

  beginRun() {
    if (this.threadMode !== "run") return null;
    if (this.activeRun) throw new Error("Codex run-scoped thread already has an active BANTAM run");
    const token = Symbol("bantam-codex-run");
    this.activeRun = token;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runLastPrompt = null;
    this.runLastCompletion = null;
    this.runThreadCalls = 0;
    return token;
  }

  endRun(token) {
    if (this.threadMode !== "run") return false;
    if (!this.activeRun || token !== this.activeRun) return false;
    this.usageCursors.delete(this.runThreadId);
    this.activeRun = null;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runLastPrompt = null;
    this.runLastCompletion = null;
    this.runThreadCalls = 0;
    return true;
  }

  async health() {
    try {
      await this.start();
      const models = await this.models();
      return models.some((entry) => entry.model === this.model || entry.id === this.model);
    } catch {
      return false;
    }
  }

  async models() {
    await this.start();
    const models = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request("model/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (Array.isArray(result?.data)) models.push(...result.data);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      this.close();
      throw error;
    }
  }

  async _start() {
    // The app-server is BANTAM's own control plane, so its auth (OPENAI_*/CODEX_*)
    // passes through — unlike model-authored shell commands, which get the full
    // secret scrub. What must not leak: NODE_TEST_CONTEXT (a child inheriting the
    // test-runner IPC marker stops reflecting real exit codes) and the BANTAM_*
    // namespace (harness switches that would alter codex-spawned subprocesses).
    const env = {};
    for (const [key, value] of Object.entries(this.environment ?? process.env)) {
      if (key === "NODE_TEST_CONTEXT" || key.startsWith("BANTAM_")) continue;
      env[key] = value;
    }
    const child = spawn(
      this.command,
      [...this.commandArgs, "app-server", "--listen", "stdio://"],
      {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => {
      if (this.child === child) this._failAll(error);
    });
    child.once("exit", (code, signal) => {
      // A cancelled runtime may exit after its replacement has initialized.
      // Its late lifecycle event must never erase the replacement's cursor.
      if (this.child !== child) return;
      const detail = this.stderr.trim();
      this._failAll(new Error(
        `Codex app-server exited (${signal || code})${detail ? `: ${detail}` : ""}`,
      ));
    });
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (this.child === child) this._onLine(line);
    });

    await this.request("initialize", {
      clientInfo: { name: "bantam", title: "BANTAM", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = codexTimeoutError(
          `Codex app-server ${method} request timed out after ${this.controlTimeoutMs}ms`,
          "control",
        );
        reject(error);
        // A control request that never answers leaves protocol state ambiguous.
        // Retire this process so a later request starts from a clean handshake.
        this.close(error);
      }, this.controlTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  async complete(prompt, options = {}) {
    const runScoped = this.threadMode === "run" && Boolean(this.activeRun);
    if (runScoped && this.runCompletion) {
      throw new Error("Codex run-scoped thread cannot execute concurrent BANTAM completions");
    }
    const lease = runScoped ? Symbol("codex-run-completion") : null;
    if (lease) this.runCompletion = lease;
    try {
      return await this._complete(prompt, options);
    } finally {
      if (lease && this.runCompletion === lease) this.runCompletion = null;
    }
  }

  async _complete(prompt, {
    signal = null,
    onProgress = null,
    outputSchema = null,
    constrainOutput = true,
    model = this.model,
    effort = this.effort,
    adaptiveRebase = true,
    baseInstructions = BASE_INSTRUCTIONS,
    inputItems = [],
    isolated = false,
  } = {}) {
    await this.start();
    if (signal?.aborted) throw abortedError();

    // Auditors/stations have their own system prompt. They must never replace
    // the worker's acknowledged conversation, including when their call fails.
    const systemHead = (text) => typeof text === "string"
      ? text.match(/^<\|im_start\|>system\n[\s\S]*?<\|im_end\|>/)?.[0] : null;
    const previousSystem = systemHead(this.runLastPrompt);
    const auxiliary = isolated || (previousSystem && systemHead(String(prompt))
      && previousSystem !== systemHead(String(prompt)));
    const reuseRunThread = this.threadMode === "run" && Boolean(this.activeRun) && !auxiliary;
    if (reuseRunThread && this.runThreadId && this.runThreadModel !== model) {
      throw new Error("cannot change Codex models inside one run-scoped thread");
    }
    let rebaseReason = null;
    if (reuseRunThread && this.runThreadId && this.promptMode === "delta") {
      if (this.rebaseEvery > 0 && this.runThreadCalls >= this.rebaseEvery) {
        rebaseReason = "periodic";
      } else if (typeof this.runLastPrompt === "string") {
        const candidate = buildCodexPromptDelivery(String(prompt), {
          mode: "delta",
          basePrompt: this.runLastPrompt,
          baseReference: "previous",
          acknowledgedCompletion: this.runLastCompletion,
        });
        if (candidate.evidence.mode === "full-fallback") {
          rebaseReason = candidate.evidence.reason || "delta-fallback";
        } else if (
          adaptiveRebase
          &&
          this.rebaseMinSavings > 0
          && candidate.evidence.savedChars / candidate.evidence.canonicalChars < this.rebaseMinSavings
        ) {
          rebaseReason = "low-delta-savings";
        }
      }
      if (rebaseReason) this._clearRunThreadBinding();
    }
    const threadReused = Boolean(reuseRunThread && this.runThreadId);
    const threadId = threadReused
      ? this.runThreadId
      : await this._startThread(model, { baseInstructions });
    if (this.turns.has(threadId)) {
      throw new Error("Codex run-scoped thread cannot execute concurrent BANTAM completions");
    }
    if (reuseRunThread && !threadReused) {
      this.runThreadId = threadId;
      this.runThreadModel = model;
    }
    const promptDelivery = this._preparePromptDelivery(String(prompt), {
      reuseRunThread,
      threadReused,
    });
    if (rebaseReason) promptDelivery.evidence.rebaseReason = rebaseReason;
    if (reuseRunThread) this.runThreadCalls++;

    const state = {
      threadId,
      model,
      turnId: null,
      content: "",
      usage: null,
      usageAccumulator: new CodexUsageAccumulator(this.usageCursors.get(threadId)),
      images: [],
      onProgress,
      outputSchema,
      jsonProgress: outputSchema ? { inString: false, escaped: false, whitespace: 0 } : null,
      resolve: null,
      reject: null,
      touch: null,
      lastEvent: null,
      notificationCount: 0,
      nativeActivity: false,
    };
    const completed = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    this.turns.set(threadId, state);

    let hardTimer;
    let idleTimer;
    const failTurn = (error, { recycle = false } = {}) => {
      if (!this.turns.has(threadId)) return;
      this.turns.delete(threadId);
      if (!reuseRunThread || this.runThreadId !== threadId) this.usageCursors.delete(threadId);
      state.reject(error);
      if (recycle) this.close(error);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (state.turnId) {
          this.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
        }
        const error = codexTimeoutError(
          `Codex app-server turn made no progress for ${this.idleTimeoutMs}ms`,
          "idle",
        );
        Object.assign(error, {
          outputChars: state.content.length,
          lastEvent: state.lastEvent,
          notificationCount: state.notificationCount,
          // Only the ordinary, tool-disabled action generator may be retried.
          // No returned action has reached BANTAM's executor. Image jobs,
          // custom thread configurations and partial replies are excluded.
          canRegenerate: baseInstructions === BASE_INSTRUCTIONS
            && Array.isArray(outputSchema?.properties?.a?.enum)
            && Object.keys(this.threadConfig ?? {}).length === 0
            && !state.content && !state.images.length && !state.nativeActivity,
        });
        failTurn(error, { recycle: true });
      }, this.idleTimeoutMs);
    };
    state.touch = armIdleTimer;
    const onAbort = () => {
      if (state.turnId) {
        this.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
      }
      // Cancellation can race an unacknowledged turn/start. Recycle the
      // connection so its pending request cannot poison the next completion.
      failTurn(abortedError(), { recycle: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    hardTimer = setTimeout(() => {
      if (state.turnId) {
        this.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
      }
      failTurn(codexTimeoutError(
        `Codex app-server turn timed out after ${this.timeoutMs}ms`,
        "hard",
      ), { recycle: true });
    }, this.timeoutMs);
    armIdleTimer();

    try {
      const turnStart = this.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: promptDelivery.text },
          ...normalizeCodexInputItems(inputItems),
        ],
        model,
        effort,
        ...(outputSchema && constrainOutput ? { outputSchema } : {}),
      });
      const response = await Promise.race([
        turnStart,
        completed.then((result) => ({ completed: result })),
      ]);
      let result;
      if (Object.hasOwn(response ?? {}, "completed")) {
        result = response.completed;
      } else {
        state.turnId = response?.turn?.id ?? null;
        result = await completed;
      }
      // turn/start acknowledgement is not successful delivery: interrupted or
      // failed turns must not advance the canonical cursor. The thread already
      // retains its own assistant reply; subsequent input adds only new state.
      if (reuseRunThread && this.runThreadId === threadId) {
        this.runLastPrompt = String(prompt);
        this.runLastCompletion = result.content;
      }
      return withThreadEvidence(result, {
        threadId,
        threadMode: reuseRunThread ? "run" : "ephemeral",
        threadReused,
        ...(rebaseReason ? { threadRebaseReason: rebaseReason } : {}),
        promptDelivery,
      });
    } catch (error) {
      if (this.runThreadId === threadId) {
        this._clearRunThreadBinding();
      }
      throw error;
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      this.turns.delete(threadId);
      if (!reuseRunThread || this.runThreadId !== threadId) this.usageCursors.delete(threadId);
    }
  }

  _preparePromptDelivery(prompt, { reuseRunThread, threadReused }) {
    if (
      this.promptMode !== "delta"
      || !reuseRunThread
      || !threadReused
      || typeof this.runLastPrompt !== "string"
    ) {
      return buildCodexPromptDelivery(prompt);
    }
    return buildCodexPromptDelivery(prompt, {
      mode: "delta",
      basePrompt: this.runLastPrompt,
      baseReference: "previous",
      acknowledgedCompletion: this.runLastCompletion,
    });
  }

  _clearRunThreadBinding() {
    this.usageCursors.delete(this.runThreadId);
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runLastPrompt = null;
    this.runLastCompletion = null;
    this.runThreadCalls = 0;
  }

  /** Generate one image on an isolated native Codex thread. */
  async generateImage(prompt, {
    model = this.model,
    effort = this.effort,
    signal = null,
    references = [],
  } = {}) {
    const priorThreadMode = this.threadMode;
    this.threadMode = "ephemeral";
    try {
      const result = await this.complete(String(prompt), {
        model,
        effort,
        adaptiveRebase: false,
        // With a source attached this is an EDIT, and the worker needs to be
        // told so — the same call with generation instructions treats the
        // reference as loose inspiration.
        baseInstructions: references.length ? IMAGE_EDIT_INSTRUCTIONS : IMAGE_INSTRUCTIONS,
        inputItems: references.map((imagePath) => ({ type: "localImage", path: String(imagePath), detail: "high" })),
        signal,
      });
      const image = result.images?.find((item) => item.status === "completed" && item.savedPath);
      if (!image) throw new Error("Codex image generation completed without a saved image path");
      return { ...image, usage: result.usage, content: result.content };
    } finally {
      this.threadMode = priorThreadMode;
    }
  }

  /** Inspect one BANTAM-validated local image on an isolated native Codex thread. */
  async describeImage(imagePath, prompt, {
    model = this.model,
    effort = this.effort,
    detail = "high",
  } = {}) {
    const priorThreadMode = this.threadMode;
    this.threadMode = "ephemeral";
    try {
      const result = await this.complete(String(prompt), {
        model,
        effort,
        adaptiveRebase: false,
        baseInstructions: VISION_INSTRUCTIONS,
        inputItems: [{ type: "localImage", path: String(imagePath), detail }],
      });
      return {
        content: result.content,
        usage: result.usage,
        codexThread: result.codexThread,
      };
    } finally {
      this.threadMode = priorThreadMode;
    }
  }

  async _startThread(model, { baseInstructions = BASE_INSTRUCTIONS } = {}) {
    const imageWorker = baseInstructions === IMAGE_INSTRUCTIONS || baseInstructions === IMAGE_EDIT_INSTRUCTIONS
      || this.threadConfig?.['features.image_generation'] === true;
    const config = { ...EMBEDDED_CONFIG,
      ...(imageWorker ? {'features.image_generation': true} : TEXT_WORKER_CONFIG), ...this.threadConfig };
    const started = await this.request("thread/start", {
      model,
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      config,
      baseInstructions,
      developerInstructions: baseInstructions,
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    this.usageCursors.set(threadId, emptyCodexUsage());
    return threadId;
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(classifyCodexUpstreamError(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      // BANTAM's Codex threads prohibit native tools. Deny any unexpected
      // server-initiated approval/tool request instead of leaving the turn hung.
      this.child?.stdin?.write(`${JSON.stringify({
        id: message.id,
        result: { decision: "decline", success: false, contentItems: [] },
      })}\n`);
      return;
    }
    this._onNotification(message.method, message.params ?? {});
  }

  _onNotification(method, params) {
    const state = this.turns.get(params.threadId);
    if (!state) return;
    if (params.turnId && state.turnId && params.turnId !== state.turnId) return;
    state.lastEvent = method;
    state.notificationCount++;
    if (params.item?.type && !['agentMessage', 'reasoning', 'userMessage'].includes(params.item.type)) {
      state.nativeActivity = true;
    }
    // Reasoning, token usage, item lifecycle, and assistant deltas are all
    // evidence that the current turn is alive. Only a truly quiet interval
    // should trip the inactivity watchdog.
    state.touch?.();

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      state.content += delta;
      // A live stream is not necessarily useful progress. A recorded strict
      // action stalled after `limit:250` and emitted 166k whitespace characters.
      // Count only whitespace OUTSIDE strings; indentation inside generated
      // source, escapes and legitimate long reasoning must never trip this.
      if (state.jsonProgress && stalledJsonWhitespace(state.jsonProgress, delta)) {
        const error = new Error('Codex action generation stalled in JSON whitespace');
        Object.assign(error, { code: 'degenerate_output', provider: 'codex', retryable: false,
          outputChars: state.content.length, whitespaceChars: state.jsonProgress.whitespace });
        if (state.turnId) this.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
        state.reject(error);
        this.close(error);
        return;
      }
      try {
        state.onProgress?.({ content: state.content, tokens: 0 });
      } catch { /* progress is advisory */ }
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      // Completed item text is authoritative; deltas are only presentation.
      state.content = params.item.text ?? state.content;
      return;
    }
    if (method === "item/completed" && params.item?.type === "imageGeneration") {
      state.images.push({
        id: params.item.id ?? null,
        status: params.item.status ?? null,
        savedPath: params.item.savedPath ?? null,
        revisedPrompt: params.item.revisedPrompt ?? null,
        // `result` is the raw image payload (often multi-megabyte base64).
        // The app server has already persisted it at savedPath; retaining it
        // would bloat BANTAM's transcript and evidence for no added utility.
      });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      state.usageAccumulator.add(params.tokenUsage);
      const accumulated = state.usageAccumulator.snapshot();
      state.usage = accumulated.raw;
      this.usageCursors.set(state.threadId, accumulated.cursor);
      return;
    }
    if (method !== "turn/completed") return;

    const turn = params.turn ?? {};
    if (turn.status === "failed") {
      state.reject(classifyCodexUpstreamError(turn.error?.message));
      return;
    }
    const messages = (turn.items ?? []).filter((item) => item.type === "agentMessage");
    const finalMessage = [...messages].reverse().find((item) => item.phase !== "commentary")
      ?? messages.at(-1);
    const content = normalizeCodexStructuredContent(
      finalMessage?.text ?? state.content,
      state.outputSchema,
    );
    const accumulated = state.usageAccumulator.snapshot();
    state.resolve({
      content,
      tokens: Number(state.usage?.outputTokens ?? 0),
      stoppedEos: true,
      stoppedLimit: false,
      timings: {},
      usage: codexUsage(state.usage, state.model, accumulated),
      rawUsage: state.usage,
      codexUsageEvidence: accumulated.evidence,
      images: state.images,
    });
  }

  _failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    for (const state of this.turns.values()) state.reject(error);
    this.pending.clear();
    this.turns.clear();
    this.usageCursors.clear();
    this.child = null;
    this.ready = null;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runLastPrompt = null;
    this.runLastCompletion = null;
    this.runThreadCalls = 0;
  }

  close(reason = new Error("Codex app-server closed")) {
    const child = this.child;
    this.lines?.close();
    this.lines = null;
    this._failAll(reason);
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

function normalizeThreadMode(value) {
  const mode = String(value ?? "ephemeral").trim().toLowerCase();
  if (mode === "ephemeral" || mode === "run") return mode;
  throw new Error(`invalid Codex thread mode: ${value}; expected ephemeral or run`);
}

function normalizePromptMode(value) {
  const mode = String(value ?? "full").trim().toLowerCase();
  if (mode === "full" || mode === "delta") return mode;
  throw new Error(`invalid Codex prompt mode: ${value}; expected full or delta`);
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  throw new Error(`invalid ${label}: ${value}; expected a non-negative integer`);
}

function unitInterval(value, label) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && number <= 1) return number;
  throw new Error(`invalid ${label}: ${value}; expected a number from 0 to 1`);
}

function withThreadEvidence(result, { promptDelivery, ...threadEvidence }) {
  return {
    ...result,
    codexThread: threadEvidence,
    codexPromptDelivery: promptDelivery.evidence,
  };
}

function normalizeCodexInputItems(items) {
  if (!Array.isArray(items)) throw new TypeError("Codex inputItems must be an array");
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Codex inputItems[${index}] must be an object`);
    }
    if (item.type !== "localImage") {
      throw new Error(`unsupported Codex input item type: ${item.type}`);
    }
    const imagePath = path.resolve(String(item.path ?? ""));
    const detail = String(item.detail ?? "high");
    if (!["auto", "low", "high", "original"].includes(detail)) {
      throw new Error(`unsupported Codex image detail: ${detail}`);
    }
    return { type: "localImage", path: imagePath, detail };
  });
}

export function buildCodexPromptDelivery(prompt, {
  mode = "full",
  basePrompt = null,
  minPrefixChars = MIN_DELTA_PREFIX_CHARS,
  // V1 remains available for reconstructing historical first-base artifacts.
  // Live run/delta delivery explicitly selects acknowledged previous-base V2.
  baseReference = "first",
  acknowledgedCompletion = null,
} = {}) {
  if (baseReference !== "first" && baseReference !== "previous") {
    throw new Error("invalid Codex delta base reference");
  }
  const canonical = String(prompt);
  const canonicalSha256 = sha256(canonical);
  const full = (reason = null) => ({
    text: canonical,
    evidence: {
      mode: reason ? "full-fallback" : "full",
      reason,
      canonicalSha256,
      deliveredSha256: canonicalSha256,
      canonicalChars: canonical.length,
      deliveredChars: canonical.length,
      commonPrefixChars: 0,
      savedChars: 0,
    },
  });
  if (mode !== "delta" || typeof basePrompt !== "string") return full();

  const incremental = baseReference === "previous";
  if (incremental && !canonical.startsWith(basePrompt)) return full("canonical-not-extension");
  const commonPrefixChars = commonPrefixLength(basePrompt, canonical);
  if (commonPrefixChars < minPrefixChars) return full("small-common-prefix");
  // A native thread already contains the successfully completed assistant
  // message. Re-sending a write_file body as escaped user input charges for it
  // twice and makes every later cached request larger. Omit it only after an
  // exact match at the canonical assistant boundary; never guess which bytes
  // are model output. Rewritten/slimmed history uses the existing full/delta
  // fallback. Hashes and reconstruction bookkeeping stay in local evidence.
  const suffix = canonical.slice(commonPrefixChars);
  if (incremental && typeof acknowledgedCompletion === "string" && acknowledgedCompletion
      && basePrompt.endsWith(ASSISTANT_HEAD)
      && suffix.startsWith(acknowledgedCompletion + OBSERVATION_HEAD)
      && suffix.endsWith(OBSERVATION_TAIL)) {
    const observations = suffix.slice(acknowledgedCompletion.length + OBSERVATION_HEAD.length,
      -OBSERVATION_TAIL.length);
    const delivered = OBSERVATION_MARKER + observations;
    if (delivered.length < canonical.length) return {
      text: delivered,
      evidence: {
        mode: "delta", format: "observation-v1", baseReference: "previous", reason: null,
        baseSha256: sha256(basePrompt), canonicalSha256, deliveredSha256: sha256(delivered),
        completionSha256: sha256(acknowledgedCompletion),
        omittedAssistantChars: acknowledgedCompletion.length,
        canonicalChars: canonical.length, deliveredChars: delivered.length,
        commonPrefixChars, savedChars: canonical.length - delivered.length,
        deliveredText: delivered,
      },
    };
  }
  // Unconstrained workers can surround an otherwise valid action with prose.
  // The controller records that protocol violation and selects its first JSON
  // object through parseAction. Reuse that SAME parser, and omit the duplicate
  // only when its exact serialized action is the canonical history entry.
  // Never normalize the raw response here: protocol warnings and audit bytes
  // must remain observable. Repaired JSON and changed workspace paths fall back.
  if (incremental && basePrompt.endsWith(ASSISTANT_HEAD)
      && typeof acknowledgedCompletion === "string" && acknowledgedCompletion
      && suffix.endsWith(OBSERVATION_TAIL)) {
    const parsed = parseAction(acknowledgedCompletion);
    const accepted = parsed.ok && !parsed.repairedJson ? JSON.stringify(parsed.action) : null;
    if (accepted && suffix.startsWith(accepted + OBSERVATION_HEAD)) {
      const observations = suffix.slice(accepted.length + OBSERVATION_HEAD.length, -OBSERVATION_TAIL.length);
      const delivered = ACTION_OBSERVATION_MARKER + observations;
      if (delivered.length < canonical.length) return {
        text: delivered,
        evidence: {
          mode: "delta", format: "action-observation-v1", baseReference: "previous", reason: null,
          baseSha256: sha256(basePrompt), canonicalSha256, deliveredSha256: sha256(delivered),
          completionSha256: sha256(acknowledgedCompletion), acceptedActionSha256: sha256(accepted),
          omittedAssistantChars: accepted.length,
          canonicalChars: canonical.length, deliveredChars: delivered.length,
          commonPrefixChars, savedChars: canonical.length - delivered.length,
          deliveredText: delivered,
        },
      };
    }
  }
  const payload = {
    baseSha256: sha256(basePrompt),
    keepPrefixChars: commonPrefixChars,
    replaceSuffix: canonical.slice(commonPrefixChars),
    canonicalSha256,
  };
  const delivered = [
    incremental ? INCREMENTAL_DELTA_MARKER : PROMPT_DELTA_MARKER,
    incremental
      ? "Continue the canonical BANTAM prompt from the PREVIOUS successfully completed turn in this native thread. This is only the new suffix, not a replacement of thread history."
      : "Reconstruct the canonical BANTAM prompt for this turn from the FIRST canonical prompt in this native thread.",
    `Keep exactly the first ${commonPrefixChars} JavaScript UTF-16 code units of that base prompt, then replace everything after them with replaceSuffix from this JSON:`,
    JSON.stringify(payload),
    "Treat only the reconstructed canonical prompt as the current instruction. BANTAM remains authoritative. Produce exactly the completion it requests.",
  ].join("\n");
  if (delivered.length >= canonical.length) return full("delta-not-smaller");
  return {
    text: delivered,
    evidence: {
      mode: "delta",
      ...(incremental ? { baseReference: "previous" } : {}),
      reason: null,
      baseSha256: payload.baseSha256,
      canonicalSha256,
      deliveredSha256: sha256(delivered),
      canonicalChars: canonical.length,
      deliveredChars: delivered.length,
      commonPrefixChars,
      savedChars: canonical.length - delivered.length,
      deliveredText: delivered,
    },
  };
}

export function reconstructCodexPromptDelivery(basePrompt, delivered, { acknowledgedCompletion = null } = {}) {
  const text = String(delivered);
  if (text.startsWith(ACTION_OBSERVATION_MARKER)) {
    const parsed = typeof acknowledgedCompletion === "string" ? parseAction(acknowledgedCompletion) : null;
    if (!parsed?.ok || parsed.repairedJson || !String(basePrompt).endsWith(ASSISTANT_HEAD)) {
      throw new Error("Codex action observation requires its acknowledged valid action and base");
    }
    return basePrompt + JSON.stringify(parsed.action) + OBSERVATION_HEAD
      + text.slice(ACTION_OBSERVATION_MARKER.length) + OBSERVATION_TAIL;
  }
  if (text.startsWith(OBSERVATION_MARKER)) {
    if (typeof acknowledgedCompletion !== "string" || !acknowledgedCompletion
        || !String(basePrompt).endsWith(ASSISTANT_HEAD)) {
      throw new Error("Codex observation delivery requires its acknowledged assistant completion and base");
    }
    return basePrompt + acknowledgedCompletion + OBSERVATION_HEAD
      + text.slice(OBSERVATION_MARKER.length) + OBSERVATION_TAIL;
  }
  const incremental = text.startsWith(`${INCREMENTAL_DELTA_MARKER}\n`);
  if (!incremental && !text.startsWith(`${PROMPT_DELTA_MARKER}\n`)) return text;
  const jsonLine = text.split("\n").find((line) => line.startsWith("{"));
  if (!jsonLine) throw new Error("Codex prompt delta payload is missing");
  const payload = JSON.parse(jsonLine);
  if (sha256(basePrompt) !== payload.baseSha256) throw new Error("Codex prompt delta base checksum mismatch");
  if (incremental && payload.keepPrefixChars !== String(basePrompt).length) {
    throw new Error("incremental Codex prompt delta must retain the whole previous prompt");
  }
  const reconstructed = String(basePrompt).slice(0, payload.keepPrefixChars) + payload.replaceSuffix;
  if (sha256(reconstructed) !== payload.canonicalSha256) {
    throw new Error("Codex prompt delta canonical checksum mismatch");
  }
  return reconstructed;
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function codexUsage(raw, model, {requests = 0, complete = false} = {}) {
  const inputTokens = positive(raw?.inputTokens);
  const outputTokens = positive(raw?.outputTokens);
  const cached = positive(raw?.cachedInputTokens);
  return {
    provider: "codex",
    model,
    requests: Math.max(1, requests),
    complete,
    inputTokens,
    outputTokens,
    totalTokens: positive(raw?.totalTokens) ?? (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens),
    cacheHitTokens: cached,
    cacheMissTokens: inputTokens === null || cached === null ? null : Math.max(0, inputTokens - cached),
    reasoningTokens: positive(raw?.reasoningOutputTokens),
    costUsd: 0,
    codexRequests: Math.max(1, requests),
  };
}

function positive(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeCodexStructuredContent(content, outputSchema) {
  // Nullable optional fields belong to our action envelope. Arbitrary data
  // outputs (fixtures, expected values, reviews) must preserve literal nulls.
  if (!Array.isArray(outputSchema?.properties?.a?.enum)) return content;
  try {
    const parsed = JSON.parse(content);
    const cleaned = removeNullProperties(parsed);
    const action = ActionSchema.safeParse(cleaned);
    // The union schema orders fields differently from individual actions
    // (edit_lines.new precedes end). Match the action history's field order,
    // so that formatting alone never looks like a rewritten conversation.
    return JSON.stringify(action.success ? action.data : cleaned);
  } catch {
    // The app-server should guarantee schema-valid JSON. Preserve unexpected
    // text so BANTAM's normal protocol repair path can report it precisely.
    return content;
  }
}

function removeNullProperties(value) {
  if (Array.isArray(value)) return value.map(removeNullProperties);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, removeNullProperties(child)]),
  );
}

function abortedError() {
  const error = new Error("model request interrupted");
  error.code = "aborted";
  return error;
}

// Capacity and rate-limit pressure from the upstream provider. Unlike a timeout
// this is worth waiting out: the request never ran, so a retry duplicates no
// upstream work, and the pressure relieves on a scale of tens of seconds.
//
// Two runs on 2026-07-31 were scored `model-error` with a hidden contract of 4/4 --
// correct implementations discarded because "Selected model is at capacity"
// exhausted a nine-second retry budget at the finish line.
// Quota exhaustion is NOT capacity pressure and must never be retried: the answer
// does not change for days. Observed 2026-08-01 -- "You've hit your usage limit ...
// try again at Aug 4th" -- and BANTAM reported it as `evidence-invalid` with zero
// turns and modelFailure: null, which reads as a broken fixture rather than an
// empty account. Hours could be lost debugging the harness instead of buying
// credits.
const QUOTA_PATTERN = /\b(?:usage limit|quota (?:exceeded|exhausted)|out of credits|purchase more credits|insufficient_quota|billing)\b/i;

const CAPACITY_PATTERN = /\b(?:at capacity|rate[ _-]?limit|too many requests|429|overloaded|try again later|temporarily unavailable|503)\b/i;

export function classifyCodexUpstreamError(message) {
  const text = typeof message === "string" ? message : "";
  const error = new Error(text || "Codex turn failed");
  error.provider = "codex";
  // Checked BEFORE capacity: "usage limit" would otherwise match the rate-limit
  // pattern and be retried five times over two minutes against an account that
  // cannot serve a request for days.
  if (text && QUOTA_PATTERN.test(text)) {
    error.code = "quota_exhausted";
    error.retryable = false;
    return error;
  }
  if (text && CAPACITY_PATTERN.test(text)) {
    error.code = "capacity";
    error.retryable = true;
  }
  return error;
}

function codexTimeoutError(message, timeoutKind) {
  const error = new Error(message);
  error.code = "model_timeout";
  error.provider = "codex";
  error.timeoutKind = timeoutKind;
  // Replaying a ten-minute agent turn can duplicate opaque upstream work and
  // multiplies the user's wait. Recovery is a fresh BANTAM turn/app-server.
  error.retryable = false;
  return error;
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function stalledJsonWhitespace(state, delta) {
  for (const char of delta) {
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (char === '\\') state.escaped = true;
      else if (char === '"') state.inString = false;
      state.whitespace = 0;
    } else if (char === '"') {
      state.inString = true; state.whitespace = 0;
    } else if (/\s/.test(char)) {
      if (++state.whitespace > 4096) return true;
    } else state.whitespace = 0;
  }
  return false;
}
