// Codex app-server transport.
//
// Codex subscription access is an agent-runtime protocol, not an OpenAI HTTP
// completion endpoint. The measured default reuses one native thread only
// inside an explicitly bounded BANTAM run: the first call supplies the complete
// canonical prompt and later calls use exact base-relative deltas. Explicit
// ephemeral/full mode remains the clean rollback. In both modes BANTAM remains
// authoritative for history, tools, verification, and the action loop.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_COMMAND = process.env.BANTAM_CODEX_COMMAND || "codex";
const DEFAULT_CONTROL_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const PROMPT_DELTA_MARKER = "BANTAM_PROMPT_DELTA_V1";
const MIN_DELTA_PREFIX_CHARS = 2048;
const BASE_INSTRUCTIONS = [
  "You are the model runtime embedded inside the BANTAM agent harness.",
  "BANTAM owns the conversation, tools, workspace operations, and verification.",
  "Do not call native Codex tools, inspect the workspace, or perform the requested task directly.",
  "Treat the user input as a fully assembled model prompt and produce only the completion it requests.",
  "When it requests a JSON action, return exactly one JSON object and no markdown or commentary.",
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
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runBasePrompt = null;
    this.runThreadCalls = 0;
    this.child = null;
    this.lines = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
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
    this.runBasePrompt = null;
    this.runThreadCalls = 0;
    return token;
  }

  endRun(token) {
    if (this.threadMode !== "run") return false;
    if (!this.activeRun || token !== this.activeRun) return false;
    this.activeRun = null;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runBasePrompt = null;
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
    for (const [key, value] of Object.entries(process.env)) {
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
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => this._failAll(error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this._failAll(new Error(
        `Codex app-server exited (${signal || code})${detail ? `: ${detail}` : ""}`,
      ));
    });
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this._onLine(line));

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

  async complete(prompt, {
    signal = null,
    onProgress = null,
    outputSchema = null,
    model = this.model,
    effort = this.effort,
    adaptiveRebase = true,
    baseInstructions = BASE_INSTRUCTIONS,
    inputItems = [],
  } = {}) {
    await this.start();
    if (signal?.aborted) throw abortedError();

    const reuseRunThread = this.threadMode === "run" && Boolean(this.activeRun);
    if (reuseRunThread && this.runThreadId && this.runThreadModel !== model) {
      throw new Error("cannot change Codex models inside one run-scoped thread");
    }
    let rebaseReason = null;
    if (reuseRunThread && this.runThreadId && this.promptMode === "delta") {
      if (this.rebaseEvery > 0 && this.runThreadCalls >= this.rebaseEvery) {
        rebaseReason = "periodic";
      } else if (typeof this.runBasePrompt === "string") {
        const candidate = buildCodexPromptDelivery(String(prompt), {
          mode: "delta",
          basePrompt: this.runBasePrompt,
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
      turnId: null,
      content: "",
      usage: null,
      images: [],
      onProgress,
      outputSchema,
      resolve: null,
      reject: null,
      touch: null,
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
      state.reject(error);
      if (recycle) this.close(error);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (state.turnId) {
          this.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
        }
        failTurn(codexTimeoutError(
          `Codex app-server turn made no progress for ${this.idleTimeoutMs}ms`,
          "idle",
        ), { recycle: true });
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
        ...(outputSchema ? { outputSchema } : {}),
      });
      const response = await Promise.race([
        turnStart,
        completed.then((result) => ({ completed: result })),
      ]);
      if (Object.hasOwn(response ?? {}, "completed")) {
        return withThreadEvidence(response.completed, {
          threadId,
          threadMode: reuseRunThread ? "run" : "ephemeral",
          threadReused,
          ...(rebaseReason ? { threadRebaseReason: rebaseReason } : {}),
          promptDelivery,
        });
      }
      state.turnId = response?.turn?.id ?? null;
      return withThreadEvidence(await completed, {
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
    }
  }

  _preparePromptDelivery(prompt, { reuseRunThread, threadReused }) {
    if (
      this.promptMode !== "delta"
      || !reuseRunThread
      || !threadReused
      || typeof this.runBasePrompt !== "string"
    ) {
      if (this.promptMode === "delta" && reuseRunThread && !threadReused) {
        this.runBasePrompt = prompt;
      }
      return buildCodexPromptDelivery(prompt);
    }
    return buildCodexPromptDelivery(prompt, {
      mode: "delta",
      basePrompt: this.runBasePrompt,
    });
  }

  _clearRunThreadBinding() {
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runBasePrompt = null;
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
    const started = await this.request("thread/start", {
      model,
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      baseInstructions,
      developerInstructions: baseInstructions,
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
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
    // Reasoning, token usage, item lifecycle, and assistant deltas are all
    // evidence that the current turn is alive. Only a truly quiet interval
    // should trip the inactivity watchdog.
    state.touch?.();

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      state.content += delta;
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
      state.usage = params.tokenUsage?.last ?? state.usage;
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
    state.resolve({
      content,
      tokens: Number(state.usage?.outputTokens ?? 0),
      stoppedEos: true,
      stoppedLimit: false,
      timings: {},
      usage: codexUsage(state.usage, modelFromThread(turn, this.model)),
      images: state.images,
    });
  }

  _failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    for (const state of this.turns.values()) state.reject(error);
    this.pending.clear();
    this.turns.clear();
    this.child = null;
    this.ready = null;
    this.runThreadId = null;
    this.runThreadModel = null;
    this.runBasePrompt = null;
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
} = {}) {
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

  const commonPrefixChars = commonPrefixLength(basePrompt, canonical);
  if (commonPrefixChars < minPrefixChars) return full("small-common-prefix");
  const payload = {
    baseSha256: sha256(basePrompt),
    keepPrefixChars: commonPrefixChars,
    replaceSuffix: canonical.slice(commonPrefixChars),
    canonicalSha256,
  };
  const delivered = [
    PROMPT_DELTA_MARKER,
    "Reconstruct the canonical BANTAM prompt for this turn from the FIRST canonical prompt in this native thread.",
    `Keep exactly the first ${commonPrefixChars} JavaScript UTF-16 code units of that base prompt, then replace everything after them with replaceSuffix from this JSON:`,
    JSON.stringify(payload),
    "Treat only the reconstructed canonical prompt as the current instruction. BANTAM remains authoritative. Produce exactly the completion it requests.",
  ].join("\n");
  if (delivered.length >= canonical.length) return full("delta-not-smaller");
  return {
    text: delivered,
    evidence: {
      mode: "delta",
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

export function reconstructCodexPromptDelivery(basePrompt, delivered) {
  const text = String(delivered);
  if (!text.startsWith(`${PROMPT_DELTA_MARKER}\n`)) return text;
  const jsonLine = text.split("\n").find((line) => line.startsWith("{"));
  if (!jsonLine) throw new Error("Codex prompt delta payload is missing");
  const payload = JSON.parse(jsonLine);
  if (sha256(basePrompt) !== payload.baseSha256) throw new Error("Codex prompt delta base checksum mismatch");
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

function codexUsage(raw, model) {
  const inputTokens = positive(raw?.inputTokens);
  const outputTokens = positive(raw?.outputTokens);
  const cached = positive(raw?.cachedInputTokens);
  return {
    provider: "codex",
    model,
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: positive(raw?.totalTokens) || inputTokens + outputTokens,
    cacheHitTokens: cached,
    cacheMissTokens: Math.max(0, inputTokens - cached),
    reasoningTokens: positive(raw?.reasoningOutputTokens),
    costUsd: 0,
    codexRequests: 1,
  };
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function modelFromThread(_turn, fallback) {
  return fallback;
}

export function normalizeCodexStructuredContent(content, outputSchema) {
  if (!outputSchema) return content;
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(removeNullProperties(parsed));
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
