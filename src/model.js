// llama.cpp /completion client with GBNF grammar constraint.
//
// Bantam talks to a raw completion endpoint (not the chat/tools API) so it can
// own the loop and enforce the action grammar. Sampling defaults follow the
// hard-won local-model coding wisdom lives in explicit model profiles, not
// scattered constants. Qwen is the default because it is the current dogfood
// model, but callers can select another profile as we benchmark more models.

import crypto from "node:crypto";
import { resolveProfile } from "./profiles.js";
import { ChatSessionPlanner } from "./chat-sessions.js";
import { grammarFieldFor, buildOpenAiBody, buildChatCompletionsBody, buildDeepSeekBody, extractCompletionText, extractStreamDelta, isStreamDone } from "./openai-transport.js";
import { addModelUsage, emptyModelUsage, usageFromResponse } from "./model-usage.js";
import { CodexAppServer, normalizeCodexStructuredContent } from "./codex-transport.js";
import { activeProfile, recordSample } from "./logic/model-cards.js";
import { buildChatBody, chatTransportFidelity, decomposeRenderedPrompt } from "./chat-transport.js";

const FALLBACK_ENDPOINT = "http://localhost:8085";
const MAX_DETERMINISTIC_SEED = 0xFFFFFFFE;

// Capacity pressure gets its own budget. A generic transient error resolves in
// milliseconds; capacity relieves over tens of seconds, so the generic
// 500ms/1s schedule cannot outlast it and discards the whole run instead --
// observed 2026-07-31 on two runs whose implementations were already correct
// (hidden contract 4/4) when a nine-second budget ran out.
export const CAPACITY_RETRY_BUDGET = 5;
const CAPACITY_BASE_MS = 5_000;
const CAPACITY_CAP_MS = 60_000;

/** Backoff before retrying `error`, for zero-based attempt `index`. */
export function retryDelayMs(error, index) {
  if (error?.code === "capacity") {
    return Math.min(CAPACITY_CAP_MS, CAPACITY_BASE_MS * (2 ** index));
  }
  return 500 * (index + 1);
}

function isChatDialect(dialect) {
  return String(dialect ?? process.env.BANTAM_API_DIALECT ?? "").trim().toLowerCase() === "chat";
}

// Native llama.cpp revisions may emit stop_type instead of stopped_limit.
// A declared limit is incomplete even if the legacy boolean is absent/false;
// EOS and configured stop-word termination are not output-limit events.
function nativeStoppedLimit(data) {
  return Boolean(data?.stopped_limit) || data?.stop_type === "limit";
}

export class ModelClient {
  constructor(opts = {}) {
    const explicitProfile = opts.profile ?? process.env.BANTAM_PROFILE;
    this.profileExplicit = explicitProfile !== undefined && explicitProfile !== null;
    this.localProfile = resolveProfile({
      profile: explicitProfile,
      modelId: opts.modelId,
    });
    this.profile = resolveProfile({
      // Codex already performs native reasoning at `codexEffort`. Giving it
      // Qwen's default <think> prefill activates BANTAM's separate two-call
      // thinking rail as well, duplicating reasoning and full-prompt traffic.
      // Preserve every explicit profile choice while making the unconfigured
      // Codex path use the neutral prompt profile.
      profile: explicitProfile ?? (opts.codex === true || opts.deepseek === true || isChatDialect(opts.apiDialect) ? "generic" : undefined),
      modelId: opts.modelId,
    });
    const sampling = this.profile.sampling;
    this.endpoint = (opts.endpoint || process.env.BANTAM_ENDPOINT || FALLBACK_ENDPOINT).replace(/\/$/, "");
    // OpenAI-compatible transport: point at a `/v1` base to speak /v1/completions
    // (raw prompt, grammar passed through) instead of llama.cpp's native /completion.
    // An explicit null disables an API URL from the environment. This lets a
    // command-line --endpoint reliably select a local server.
    this.apiUrl = Object.hasOwn(opts, "apiUrl")
      ? opts.apiUrl
      : (process.env.BANTAM_API_URL || null);
    if (this.apiUrl) this.apiUrl = String(this.apiUrl).replace(/\/$/, "");
    this.apiMode = Boolean(this.apiUrl);
    this.apiKey = opts.apiKey
      || process.env.BANTAM_API_KEY
      || (opts.deepseek === true ? process.env.DEEPSEEK_API_KEY : null)
      || null;
    this.modelName = opts.model || process.env.BANTAM_MODEL || "local";
    this.grammarField = grammarFieldFor(opts.apiDialect || process.env.BANTAM_API_DIALECT);
    this.profileName = this.profile.name;
    this.temperature = opts.temperature ?? sampling.temperature;
    // Action generation can use a cooler sampler than free-form thinking. A
    // blank environment value is unset; an explicit null disables the profile default.
    const envActTemperature = process.env.BANTAM_ACT_TEMP;
    const rawActTemperature = opts.actTemperature !== undefined
      ? opts.actTemperature
      : envActTemperature != null && envActTemperature.trim() !== ""
        ? envActTemperature
        : sampling.actTemperature;
    const parsedActTemperature = rawActTemperature == null || String(rawActTemperature).trim() === ""
      ? NaN
      : Number(rawActTemperature);
    this.actTemperature = Number.isFinite(parsedActTemperature) && parsedActTemperature >= 0
      ? parsedActTemperature : null;
    this.topP = opts.topP ?? sampling.topP;
    this.topK = opts.topK ?? sampling.topK;
    this.deepseek = opts.deepseek === true;
    // `--api-dialect chat`: the server speaks only /v1/chat/completions (codexapi,
    // hosted providers). Messages instead of a raw prompt, schema via
    // response_format, no GBNF — the reply is validated locally like any other.
    this.chatDialect = isChatDialect(opts.apiDialect);
    this.chatSessions = null;   // ChatSessionPlanner once enableChatSessions() has run
    this.codex = opts.codex === true;
    // Measured 2026-07-31 on gpt-5.6-terra across two fixtures, every arm PASSing:
    // medium beat the previous "high" default on every axis -- -19% input, -27%
    // output, -50% reasoning, -23% wall, and one fewer turn -- while reasoning
    // tokens scale 6.5x from low to xhigh with flat quality. A default, not a
    // ceiling: --codex-effort and BANTAM_CODEX_EFFORT still select any level, and
    // genuinely ambiguous work may still earn a higher one.
    this.codexEffort = opts.codexEffort || process.env.BANTAM_CODEX_EFFORT || "medium";
    const configuredCodexThreadMode =
      opts.codexThreadMode ?? process.env.BANTAM_CODEX_THREAD_MODE;
    const configuredCodexPromptMode =
      opts.codexPromptMode ?? process.env.BANTAM_CODEX_PROMPT_MODE;
    this.codexThreadMode = normalizeCodexThreadMode(
      configuredCodexThreadMode ?? "run",
    );
    this.codexPromptMode = normalizeCodexPromptMode(
      configuredCodexPromptMode
        ?? (this.codexThreadMode === "run" ? "delta" : "full"),
    );
    this.codexRebaseEvery = normalizeCodexRebaseEvery(
      opts.codexRebaseEvery ?? process.env.BANTAM_CODEX_REBASE_EVERY ?? 0,
    );
    this.codexRebaseMinSavings = normalizeCodexRebaseMinSavings(
      opts.codexRebaseMinSavings ?? process.env.BANTAM_CODEX_REBASE_MIN_SAVINGS ?? 0,
    );
    if (this.codexPromptMode === "delta" && this.codexThreadMode !== "run") {
      throw new Error("Codex prompt delta mode requires thread mode run");
    }
    this.codexRuntime = null;
    this.codexRunToken = null;
    // BANTAM asks for one small JSON action per completion. DeepSeek V4 native
    // thinking can consume the entire output allowance before emitting that
    // action, so routine harness turns default to its fast non-thinking mode.
    // Legacy `deepseek-reasoner` remains an explicit opt-in.
    this.deepseekThinking = opts.deepseekThinking ?? false;
    if (this.deepseek && this.modelName === "deepseek-reasoner") {
      this.modelName = "deepseek-v4-flash";
      this.deepseekThinking = true;
    } else if (this.deepseek && this.modelName === "deepseek-chat") {
      this.modelName = "deepseek-v4-flash";
      this.deepseekThinking = false;
    }
    this.seed = normalizeSeed(opts.seed);
    this.completionIndex = 0;
    this.nPredict = opts.nPredict ?? this.profile.nPredict;
    this.stop = opts.stop ?? this.profile.stop;
    this.assistantPrefill = opts.assistantPrefill ?? this.profile.assistantPrefill;
    // Prior assistant turns may need a different prefix from the open one: a
    // Gemma history turn carries no thought block at all. Profiles that do not
    // distinguish them replay the assistant prefill, exactly as before.
    this.historyPrefill = opts.historyPrefill
      ?? this.profile.historyPrefill
      ?? this.assistantPrefill;
    // Chat template + reasoning markers travel with the profile so prompt
    // assembly and the thinking rail follow a profile switch automatically.
    this.template = this.profile.template;
    this.thinkMarkers = this.profile.think;
    // Fields the caller pinned explicitly are never re-derived by a later
    // profile switch (see _applyProfile).
    this.pinned = new Set(
      ["nPredict", "stop", "assistantPrefill", "historyPrefill"].filter((k) => opts[k] !== undefined),
    );
    this.cachePrompt = opts.cachePrompt ?? true;
    // Opt-in chat transport (see src/chat-transport.js). `null` means the byte-
    // fidelity gate has not run yet; it runs once, on the first request, and a
    // failure pins this to false for the session.
    this.chatTransport = opts.chatTransport === true;
    this.chatTransportReady = null;
    // Per-completion wall-clock cap. Requests are NON-streaming, so llama.cpp computes the
    // whole generation before responding — the timeout must exceed the time to emit a FULL
    // nPredict-token completion, not just a short action. On a single local GPU an 8192-token
    // generation can take several minutes; short client timeouts silently abort large writes.
    // Default 600s covers the max generation with headroom; a truly hung server still aborts.
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.BANTAM_MODEL_TIMEOUT_MS) || 600000);
    // Transient model errors (aborts under load, 5xx, dropped sockets) must not
    // kill a run — retry a few times with backoff before surfacing the error.
    this.retries = opts.retries ?? 2;
    // Exact replay starts with preserving what actually crossed the HTTP seam.
    // Keep the public complete() result unchanged, while retaining one record per
    // logical completion (including every transport attempt) for artifacts and
    // crash checkpoints. Operators that handle especially sensitive prompts may
    // explicitly disable capture; normal local-agent runs keep it on.
    this.captureRequests = opts.captureRequests ?? true;
    this.requestRecords = [];
    this.requestCount = 0;
    this.lastRequestRecord = null;
    this.onRequestRecord = typeof opts.onRequestRecord === "function" ? opts.onRequestRecord : null;
    this.onUsage = typeof opts.onUsage === "function" ? opts.onUsage : null;
    this.lastUsage = null;
    this.usageTotals = emptyModelUsage();
    this.usageHistory = [];
    this.externalUsageHistory = [];
    this.usageBySource = {};
  }

  /**
   * Run one constrained completion.
   * @param {string} prompt   Fully-assembled raw prompt (Qwen chat format).
   * @param {object} opts     { grammar, nPredict, stop }
   * @returns {Promise<{ content: string, tokens: number, stoppedEos: boolean, stoppedLimit: boolean, timings: object }>}
   */
  /**
   * Run the chat transport's byte-fidelity gate ONCE, against a real prompt.
   * Returns the verdict. A pass arms the transport for the session; anything
   * else pins it off — the transport must never be the reason the model saw
   * different bytes than BANTAM built.
   */
  async ensureChatTransport(prompt, { out = () => {} } = {}) {
    if (!this.chatTransport || this.apiMode || this.codex) return { ok: false, reason: "chat transport is off" };
    if (this.chatTransportReady !== null) return { ok: this.chatTransportReady, reason: "already decided" };
    const verdict = await chatTransportFidelity({ endpoint: this.endpoint, prompt });
    this.chatTransportReady = verdict.ok === true;
    out(verdict.ok
      ? "chat transport: ON — the server re-renders BANTAM's turns byte-for-byte.\n"
      : `chat transport: OFF — ${verdict.reason}\n  Falling back to /completion. Nothing is lost; the reuse gain is not taken.\n`);
    return verdict;
  }

  async complete(prompt, opts = {}) {
    const requestOptions = { ...opts };
    if (requestOptions.signal?.aborted) throw interruptedError();
    if (opts.seed !== undefined) requestOptions.seed = normalizeSeed(opts.seed);
    else if (this.seed !== null) {
      requestOptions.seed = (this.seed + this.completionIndex) % (MAX_DETERMINISTIC_SEED + 1);
      this.completionIndex++;
    }
    // The gate arms itself on the FIRST real prompt: a flag that cannot take
    // effect is a lie, and a transport armed without proof is worse.
    if (this.chatTransport && this.chatTransportReady === null && !this.apiMode && !this.codex) {
      await this.ensureChatTransport(prompt, { out: (t) => process.stderr.write(t) });
    }
    const request = this.buildRequest(prompt, requestOptions);
    // A held-open chat session can vanish server-side (409 session_unavailable);
    // the retry must then carry the full transcript on a new id, not the delta.
    if (this.chatSessions) request.rebuild = () => this.buildRequest(prompt, requestOptions);
    return this._executeRequest(request, requestOptions);
  }

  /**
   * Hold a chat-completions session open across the run (codexapi `session_id`):
   * byte-extension prompts send only their new user content. See chat-sessions.js.
   */
  enableChatSessions({ prefix = "bantam" } = {}) {
    if (!this.chatDialect) return null;
    if (this.chatSessions) return this.chatSessions;
    this.chatSessions = new ChatSessionPlanner({
      prefix,
      deleteSession: (id) => {
        const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
        return fetch(`${this.apiUrl}/sessions/${encodeURIComponent(id)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
      },
    });
    return this.chatSessions;
  }

  // The HTTP bridge is still a Codex model, but must never dispatch through
  // the direct app-server transport. Keep capability and transport separate.
  get codexBacked() { return this.codex || this.chatSessions !== null; }

  get codexToolIdentity() {
    // codexapi accepts model:effort; native vision tools accept them separately.
    const match = this.codexBacked && this.modelName?.match(/^(.*):(low|medium|high|xhigh|max|ultra)$/);
    return { model: match ? match[1] : this.modelName, effort: match ? match[2] : this.codexEffort };
  }

  async detectChatSessions() {
    if (!this.apiMode || !this.chatDialect || this.deepseek || this.chatSessions
      || /^(0|false|no|off)$/i.test(String(process.env.BANTAM_CHAT_SESSIONS ?? ""))) return;
    try {
      const res = await fetch(`${this.apiUrl}/sessions`, {headers: this.apiKey ? {Authorization:`Bearer ${this.apiKey}`} : {}, signal:AbortSignal.timeout(2500)});
      const listing = res.ok ? await res.json() : null;
      if (listing?.object === 'list' && Array.isArray(listing.data)) this.enableChatSessions();
    } catch { /* Generic chat endpoints may not implement bridge sessions. */ }
  }

  /** Send a request captured by buildRequest()/requestLog() without reconstructing its body. */
  async completeRequest(recordedRequest, opts = {}) {
    const request = normalizeExactRequest(recordedRequest);
    if (!request) throw new Error("recorded completion request needs url, method, headers, and a serialized body");
    // Stored evidence carries a redacted Authorization header; the live key
    // never leaves the client, so it is re-injected at send time.
    for (const name of Object.keys(request.headers)) {
      if (name.toLowerCase() === "authorization" && request.headers[name] === REDACTED_AUTHORIZATION && this.apiKey) {
        request.headers[name] = `Bearer ${this.apiKey}`;
      }
    }
    if (request.bodySha256 && sha256(request.body) !== request.bodySha256) {
      throw new Error("recorded completion request checksum does not match");
    }
    let recordedStream = false;
    try { recordedStream = Boolean(JSON.parse(request.body).stream); } catch { /* server will report malformed JSON */ }
    const requestOptions = { ...opts, retries: opts.retries ?? 0 };
    if (recordedStream && typeof requestOptions.onProgress !== "function") requestOptions.onProgress = () => {};
    return this._executeRequest(request, requestOptions);
  }

  // Every local completion teaches the active profile's model card — TTFT,
  // prefill and generation speed per context bucket — at zero token cost.
  // Best-effort by design: telemetry must never break a completion.
  _recordCardSample(result) {
    if (this.codex || this.apiMode || this.deepseek) return;
    const t = result?.timings;
    if (!t || typeof t.predicted_per_second !== "number") return;
    try {
      const now = Date.now();
      if (!this._cardProfile || now - (this._cardProfileAt ?? 0) > 60_000) {
        this._cardProfile = activeProfile();
        this._cardProfileAt = now;
      }
      if (!this._cardProfile) return;
      recordSample(this._cardProfile, {
        promptN: t.prompt_n ?? 0,
        promptMs: t.prompt_ms ?? null,
        genN: t.predicted_n ?? 0,
        genMs: t.predicted_ms ?? null,
      });
    } catch { /* telemetry is advisory */ }
  }

  async _executeRequest(initialRequest, requestOptions) {
    let request = initialRequest;
    if (requestOptions.signal?.aborted) throw interruptedError();
    const record = this._beginRequestRecord(request, requestOptions);
    let attempts = Math.max(1, (requestOptions.retries ?? this.retries) + 1);
    // Capacity failures do not consume the ordinary budget: the request never ran,
    // so retrying duplicates no upstream work and giving up throws away the whole run.
    let capacityGrants = 0;
    let silentActionRecoveries = 0;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      const attempt = {
        attempt: i + 1,
        startedAt: new Date().toISOString(),
        status: "pending",
        response: null,
        error: null,
      };
      record.attempts.push(attempt);
      const exchange = {};
      try {
        const result = await this._completeOnce(request, requestOptions, exchange);
        if (request.chatSession) this.chatSessions?.commit(request.chatSession.plan, request.chatSession.prompt, result.content);
        attempt.status = "ok";
        attempt.completedAt = new Date().toISOString();
        attempt.response = exchange.response ?? null;
        record.response = exchange.response ?? normalizedResponseRecord(result);
        record.status = "ok";
        record.completedAt = attempt.completedAt;
        this._emitRequestRecord("settled", record);
        this._recordUsage(result);
        this._recordCardSample(result);
        return result;
      } catch (e) {
        lastErr = e;
        attempt.status = "error";
        attempt.completedAt = new Date().toISOString();
        attempt.error = normalizeRequestError(e);
        attempt.response = exchange.response ?? null;
        if (e.code === "session_unavailable" && this.chatSessions && typeof request.rebuild === "function") {
          this.chatSessions.lost();
          request = request.rebuild();
          request.rebuild = null;
        }
        // A context overflow won't fix itself on retry — the caller must shrink
        // the prompt. A user cancellation also must surface immediately: retrying
        // it would make Ctrl-C appear ineffective.
        if (e.code === "capacity" && capacityGrants < CAPACITY_RETRY_BUDGET && !requestOptions.signal?.aborted) {
          capacityGrants += 1;
          attempts += 1;
        }
        // One fresh connection can recover a silent text-only Codex action.
        // Consume the normal retry budget; preserve both attempts and the
        // missing receipt. Never replay any completed BANTAM tool action.
        const recoverSilentAction = this.codex && e.code === 'model_timeout'
          && e.timeoutKind === 'idle' && e.canRegenerate === true
          && silentActionRecoveries === 0 && i < attempts - 1;
        if (recoverSilentAction) silentActionRecoveries++;
        if (
          e.code === "context_overflow"
          || e.code === "aborted"
          || (e.retryable === false && !recoverSilentAction)
          || requestOptions.signal?.aborted
          || i === attempts - 1
        ) {
          const finalError = requestOptions.signal?.aborted && e.code !== "aborted" ? interruptedError() : e;
          record.status = "error";
          record.error = normalizeRequestError(finalError);
          record.response = exchange.response ?? null;
          record.completedAt = attempt.completedAt;
          this._emitRequestRecord("settled", record);
          throw finalError;
        }
        try {
          await abortableDelay(retryDelayMs(e, e?.code === "capacity" ? capacityGrants - 1 : i), requestOptions.signal);
        } catch (delayError) {
          record.status = "error";
          record.error = normalizeRequestError(delayError);
          record.completedAt = new Date().toISOString();
          this._emitRequestRecord("settled", record);
          throw delayError;
        }
      }
    }
    record.status = "error";
    record.error = normalizeRequestError(lastErr);
    record.completedAt = new Date().toISOString();
    this._emitRequestRecord("settled", record);
    throw lastErr;
  }

  /** Build the byte-exact request that complete() will send. Pure and replayable. */
  buildRequest(prompt, opts = {}) {
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const temperature = opts.temperature ?? this.temperature;
    const nPredict = opts.nPredict ?? this.nPredict;
    const stop = opts.stop ?? this.stop;
    const seed = (opts.seed !== null && opts.seed !== undefined) ? opts.seed : undefined;
    // Frontier workers can emit the ordinary action protocol without forcing
    // every unrelated action field through one nullable sampling schema. The
    // runtime parser and checkpoint authority still validate the actual action.
    const unconstrainedAction = (this.codex || this.codexBacked)
      && process.env.BANTAM_CODEX_ACTION_SCHEMA !== 'on'
      && Array.isArray(opts.jsonSchema?.properties?.a?.enum);

    // OpenAI-compatible transport: raw-prompt /v1/completions, grammar passed
    // through, so a user's existing OpenAI-spec server (llama.cpp /v1, vLLM, …)
    // works by just entering its URL.
    let url;
    let body;
    let chatSession = null;
    let headers = { "Content-Type": "application/json" };
    if (this.codex) {
      url = `codex-app-server://local/${this.modelName}`;
      body = {
        prompt,
        model: this.modelName,
        // Per-CALL effort. Codex takes effort on turn/start, and codex-transport
        // guards model changes inside a run-scoped thread but deliberately not
        // effort -- so a caller can think harder on one turn without rebasing the
        // thread or disturbing delta prompting. Falls back to the run's setting.
        effort: opts.codexEffort || this.codexEffort,
        jsonMode: Boolean(opts.grammar),
        outputSchema: opts.jsonSchema ?? null,
        ...(unconstrainedAction ? { constrainOutput: false } : {}),
        adaptiveRebase: opts.codexAdaptiveRebase !== false,
        isolated: opts.isolated === true,
      };
    } else if (this.apiMode) {
      const sampling = { temperature, topP: this.topP, topK: this.topK, nPredict, stop, seed,
        ...(opts.presencePenalty ? { presencePenalty: opts.presencePenalty } : {}) };
      if (this.deepseek) {
        url = `${this.apiUrl}/chat/completions`;
        body = buildDeepSeekBody({
          prompt,
          sampling,
          model: this.modelName,
          stream: Boolean(onProgress),
          jsonMode: Boolean(opts.grammar),
          outputSchema: opts.jsonSchema ?? null,
          thinking: opts.deepseekThinking ?? this.deepseekThinking,
          reasoningEffort: opts.deepseekReasoningEffort ?? "high",
        });
      } else if (this.chatDialect) {
        url = `${this.apiUrl}/chat/completions`;
        const plan = this.chatSessions ? this.chatSessions.plan(prompt, { isolated: opts.isolated === true }) : null;
        body = buildChatCompletionsBody({
          prompt,
          sampling,
          model: this.modelName,
          stream: Boolean(onProgress),
          outputSchema: unconstrainedAction ? null : opts.jsonSchema ?? null,
          jsonMode: !unconstrainedAction && Boolean(opts.grammar),
          messages: plan?.messages ?? null,
          sessionId: plan?.sessionId ?? null,
        });
        if (plan) {
          // The bridge's conversational persona conflicts with an agent loop.
          // Preserve an explicit operator override; this is a bridge extension.
          body.chat_preamble ??= false;
          chatSession = { plan, prompt };
        }
      } else {
        url = `${this.apiUrl}/completions`;
        body = buildOpenAiBody({
          prompt, grammar: opts.grammar ?? null, model: this.modelName, grammarField: this.grammarField,
          stream: Boolean(onProgress),
          sampling,
        });
      }
      if (this.apiKey) headers = { ...headers, Authorization: `Bearer ${this.apiKey}` };
    } else {
      body = {
        prompt,
        n_predict: nPredict,
        temperature,
        top_p: this.topP,
        top_k: this.topK,
        cache_prompt: this.cachePrompt,
        stop,
      };
      // Opt-in loop breaker. The certified server stack runs
      // --repeat-penalty 1.0 --presence-penalty 0.0, both disabled on purpose:
      // penalising repetition degrades code, where repeated tokens are correct.
      // But with nothing damping it a generation can collapse into one fragment
      // and burn its whole budget (dna-insert emitted "ctg" to the end of 13,087
      // characters). So the penalty is applied ONLY when a caller asks for it —
      // the agent loop does, on the retry after it has SEEN a degenerate output —
      // and never on a first attempt.
      if (opts.presencePenalty) body.presence_penalty = opts.presencePenalty;
      if (opts.repeatPenalty) body.repeat_penalty = opts.repeatPenalty;
      if (opts.grammar) body.grammar = opts.grammar;
      if (seed !== undefined) body.seed = seed;
      // Streaming is OPT-IN via onProgress: the interactive surface streams so a minutes-long
      // generation can say what it's producing as it goes. Eval/benchmark paths (no onProgress)
      // stay non-streaming and byte-identical to before.
      if (onProgress) body.stream = true;
      // The chat transport only ever takes over once the gate has PROVED the
      // server re-renders these messages byte-for-byte; until then, and forever
      // after a failure, this is the ordinary /completion path.
      if (this.chatTransport && this.chatTransportReady === true) {
        const decomposed = decomposeRenderedPrompt(prompt);
        if (decomposed) {
          body = buildChatBody({
            decomposed, grammar: opts.grammar ?? null, nPredict, temperature,
            topP: this.topP, topK: this.topK, cachePrompt: this.cachePrompt, stop, seed,
          });
          if (onProgress) body.stream = true;
          url = `${this.endpoint}/v1/chat/completions`;
          return {
            url, method: "POST", headers, body: JSON.stringify(body),
            ...(chatSession ? { chatSession } : {}),
            chatTransport: true, chatPrefill: decomposed.prefill,
          };
        }
      }
      url = `${this.endpoint}/completion`;
    }

    const serializedBody = JSON.stringify(body);
    return {
      url,
      method: "POST",
      ...(chatSession ? { chatSession } : {}),
      ...(unconstrainedAction ? { actionSchema: opts.jsonSchema } : {}),
      headers,
      body: serializedBody,
      bodySha256: sha256(serializedBody),
      promptSha256: sha256(String(prompt)),
      grammarSha256: typeof opts.grammar === "string" ? sha256(opts.grammar) : null,
      jsonSchemaSha256: opts.jsonSchema ? sha256(JSON.stringify(opts.jsonSchema)) : null,
      seed: seed ?? null,
      temperature,
      topP: this.topP,
      topK: this.topK,
      nPredict,
      stop: Array.isArray(stop) ? [...stop] : stop,
      cachePrompt: Boolean(body.cache_prompt),
      stream: Boolean(body.stream),
    };
  }

  async _completeOnce(request, opts = {}, exchange = {}) {
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    const externalSignal = opts.signal ?? null;
    if (externalSignal?.aborted) throw interruptedError();
    if (this.codex) {
      let body;
      try {
        body = JSON.parse(request.body);
      } catch {
        throw new Error("invalid captured Codex request body");
      }
      this.codexRuntime ??= new CodexAppServer({
        cwd: process.cwd(),
        model: body.model || this.modelName,
        effort: body.effort || this.codexEffort,
        timeoutMs: this.timeoutMs,
        threadMode: this.codexThreadMode,
        promptMode: this.codexPromptMode,
        rebaseEvery: this.codexRebaseEvery,
        rebaseMinSavings: this.codexRebaseMinSavings,
      });
      const result = await this.codexRuntime.complete(body.prompt, {
        signal: externalSignal,
        onProgress,
        outputSchema: body.outputSchema,
        constrainOutput: body.constrainOutput !== false,
        model: body.model || this.modelName,
        effort: body.effort || this.codexEffort,
        adaptiveRebase: body.adaptiveRebase !== false,
        isolated: body.isolated === true,
      });
      exchange.response = {
        status: 200,
        rawBody: result.content,
        bodySha256: sha256(result.content),
        normalized: normalizedResponseRecord(result),
      };
      return result;
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    // Close the race between the pre-check and listener registration.
    if (externalSignal?.aborted) onExternalAbort();
    // Keep the timer armed across the WHOLE exchange — headers AND body. Clearing it right
    // after fetch() (which resolves on headers) leaves a hung/slow body read untimed, so a
    // stalled server can wedge the run forever. The finally clears it once the body is in.
    try {
      let res;
      try {
        res = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: ctrl.signal,
        });
      } catch (e) {
        const target = this.apiMode ? this.apiUrl : this.endpoint;
        // Name the fix, not just the fault. The first thing a newcomer hits is a
        // model server that is not running, and "fetch failed (endpoint …)" is
        // true and useless to someone who does not already know bantam wants
        // llama.cpp on 8085. `bantam doctor` checks node, probes the endpoint and
        // prints a Next: instruction — it was simply never mentioned at the
        // moment it is needed.
        //
        // Connection-shaped failures only: an HTTP error from a server that IS
        // running is a different problem, and it does not come through here.
        throw new Error(`model request failed: ${e.message} (endpoint ${target})`
          + ` — run \`bantam doctor\` to check whether a model server is reachable there.`);
      }
      if (!res.ok) {
        const text = await res.text();
        exchange.response = responseRecord(res, text, null);
        const err = new Error(`model returned HTTP ${res.status}: ${text}`);
        // Tag context-window overflows so the agent loop can trim history and retry instead
        // of crashing the run. Broadened beyond the old narrow phrasing to catch llama.cpp's
        // several overflow messages (a 400 mentioning context/tokens is an overflow, not a bug).
        if (res.status === 400 && /context|n_ctx|exceed|too (?:large|long|many tokens)|kv cache/i.test(text)) {
          err.code = "context_overflow";
        }
        // codexapi: the held-open session is gone (server restart past its
        // rollout, or expiry). Never a silent fresh start — resend in full.
        if (res.status === 409 && /session_unavailable/.test(text)) err.code = "session_unavailable";
        throw err;
      }
      if (onProgress) {
        const streamed = await this._readStream(res, onProgress);
        if (request.chatSession) streamed.result.content = normalizeCodexStructuredContent(
          streamed.result.content, request.actionSchema ?? JSON.parse(request.body).response_format?.json_schema?.schema);
        exchange.response = responseRecord(res, streamed.rawBody, streamed.result);
        return streamed.result;
      }
      const { data, rawBody } = await readJsonResponse(res);
      const result = {
        // The chat endpoint continues a trailing assistant message and echoes it
        // back at the head of `content`; /completion never does. Strip it, or the
        // action parser sees BANTAM's own prefill prepended to the model's output.
        content: stripChatPrefill(extractCompletionText(data), request.chatTransport ? request.chatPrefill : ""),
        tokens: data.tokens_predicted ?? data.usage?.completion_tokens ?? 0,
        stoppedEos: Boolean(data.stopped_eos),
        stoppedLimit: nativeStoppedLimit(data),
        // llama.cpp sets `truncated` when the PROMPT overran the slot's context
        // and was cut to fit. That is silent — no error, no stopped_limit — and
        // it is exactly the failure that sat invisible under tune-mjcf: a 47.8k
        // prompt on a 48k slot, every generation cut after a few hundred tokens.
        truncated: Boolean(data.truncated),
        promptTokens: Number(data.tokens_evaluated ?? data.usage?.prompt_tokens ?? 0) || 0,
        timings: data.timings ?? {},
        usage: usageFromResponse(data, {
          provider: this.deepseek ? "deepseek" : (this.apiMode ? "api" : "local"),
          model: data.model || this.modelName,
        }),
      };
      // The action history omits nullable optional fields. A bridge must
      // acknowledge that same normalized action, just like direct Codex, or
      // every next turn looks rewritten and loses its held-open session.
      if (request.chatSession) result.content = normalizeCodexStructuredContent(
        result.content, request.actionSchema ?? JSON.parse(request.body).response_format?.json_schema?.schema);
      exchange.response = responseRecord(res, rawBody, result);
      return result;
    } catch (e) {
      if (e.code === "context_overflow") throw e;
      if (externalSignal?.aborted) throw interruptedError();
      if (timedOut) {
        const target = this.apiMode ? this.apiUrl : this.endpoint;
        const err = new Error(`model request timed out after ${this.timeoutMs}ms (endpoint ${target})`);
        err.code = "model_timeout";
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  // Accumulate a llama.cpp SSE stream ("data: {json}\n\n" events; the final event carries
  // stop=true with tokens_predicted/timings). onProgress is throttled to ~2 calls/sec with the
  // content accumulated SO FAR, so the caller can show what is being generated as it grows.
  async _readStream(res, onProgress) {
    const decoder = new TextDecoder();
    let buffered = "";
    let raw = "";
    let content = "";
    let chunks = 0;
    let final = null;
    let usageEvent = null;
    let lastReport = 0;
    for await (const part of res.body) {
      const text = decoder.decode(part, { stream: true });
      raw += text;
      buffered += text;
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        // An error frame is an error. Read as an empty completion it became
        // "no JSON object found" and three repair turns (luna via codexapi,
        // 2026-08-24: the server had blocked a tool call and said so).
        if (evt && typeof evt === "object" && evt.error) {
          const message = typeof evt.error === "string" ? evt.error : (evt.error.message ?? JSON.stringify(evt.error));
          throw Object.assign(new Error(`model stream error: ${message}`), { code: "stream_error" });
        }
        content += extractStreamDelta(evt);
        chunks++;
        if (evt.usage) usageEvent = evt;
        if (isStreamDone(evt)) final = evt;
        const now = Date.now();
        if (now - lastReport > 300) {
          lastReport = now;
          try { onProgress({ tokens: final?.tokens_predicted ?? chunks, content }); } catch { /* progress is advisory */ }
        }
      }
    }
    // A server (or proxy) that ignored stream:true answers with one plain JSON body — no SSE
    // events at all. Fall back to parsing it like the non-streaming path instead of returning
    // an empty completion.
    if (chunks === 0) {
      try {
        const data = JSON.parse(raw);
        return {
          rawBody: raw,
          result: {
            content: extractCompletionText(data),
            tokens: data.tokens_predicted ?? data.usage?.completion_tokens ?? 0,
            stoppedEos: Boolean(data.stopped_eos),
            stoppedLimit: nativeStoppedLimit(data),
            timings: data.timings ?? {},
            usage: usageFromResponse(data, {
              provider: this.deepseek ? "deepseek" : (this.apiMode ? "api" : "local"),
              model: data.model || this.modelName,
            }),
          },
        };
      } catch { /* fall through to the (empty) stream result */ }
    }
    // Final report is UNTHROTTLED: the 500ms gate can swallow the closing
    // bytes between the last report and stream end, and a live-text consumer
    // would render a truncated answer (caught by the 2026-08-19 smoke).
    try { onProgress({ tokens: final?.tokens_predicted ?? chunks, content, done: true }); } catch { /* progress is advisory */ }
    const usageSource = usageEvent || final || {};
    return {
      rawBody: raw,
      result: {
        content,
        tokens: final?.tokens_predicted ?? chunks,
        stoppedEos: Boolean(final?.stopped_eos),
        stoppedLimit: nativeStoppedLimit(final),
        truncated: Boolean(final?.truncated),
        promptTokens: Number(final?.tokens_evaluated ?? usageSource?.prompt_tokens ?? 0) || 0,
        timings: final?.timings ?? {},
        usage: usageFromResponse(usageSource, {
          provider: this.deepseek ? "deepseek" : (this.apiMode ? "api" : "local"),
          model: usageSource.model || final?.model || this.modelName,
        }),
      },
    };
  }

  _recordUsage(result) {
    const entry = result?.usage;
    if (!entry) return;
    this.lastUsage = serializableCopy(entry);
    this.usageTotals = addModelUsage(this.usageTotals, entry);
    this._recordUsageSource("action_generation", entry);
    this.usageHistory.push(this.lastUsage);
    try {
      this.onUsage?.({
        entry: serializableCopy(this.lastUsage),
        totals: serializableCopy(this.usageTotals),
      });
    } catch { /* accounting display must never break inference */ }
  }

  /** Account for a Codex sidecar tool call (vision/image generation). */
  recordExternalUsage(entry, meta = {}) {
    if (!entry) return;
    const copy = serializableCopy(entry);
    const source = usageSource(meta);
    this.lastUsage = copy;
    this.usageTotals = addModelUsage(this.usageTotals, entry);
    this._recordUsageSource(source, entry);
    this.usageHistory.push(copy);
    this.externalUsageHistory.push({
      at: new Date().toISOString(),
      source,
      ...serializableCopy(meta),
      usage: copy,
    });
    try {
      this.onUsage?.({
        entry: serializableCopy(copy),
        totals: serializableCopy(this.usageTotals),
        external: true,
        meta: serializableCopy(meta),
      });
    } catch { /* accounting display must never break inference */ }
  }

  usageSummary() {
    return serializableCopy(this.usageTotals);
  }

  usageBreakdownSummary() {
    return serializableCopy(this.usageBySource);
  }

  resetUsage() {
    this.lastUsage = null;
    this.usageTotals = emptyModelUsage();
    this.usageHistory = [];
    this.externalUsageHistory = [];
    this.usageBySource = {};
    return this.usageSummary();
  }

  _recordUsageSource(source, entry) {
    this.usageBySource[source] = addModelUsage(this.usageBySource[source], entry);
  }

  _beginRequestRecord(request, opts) {
    const record = {
      schema: 1,
      index: this.requestCount++,
      label: typeof opts.recordLabel === "string" ? opts.recordLabel : null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "pending",
      // Keep evidence detached from the transport object. A diagnostic hook
      // must not be able to mutate the bytes that are about to be sent.
      // Evidence outlives the shell that held the key: run artifacts and crash
      // checkpoints store this record verbatim, so the Authorization header is
      // redacted here and completeRequest() re-injects the live key on replay.
      request: redactRequestEvidence(request),
      transport: {
        timeoutMs: this.timeoutMs,
        retries: opts.retries ?? this.retries,
      },
      attempts: [],
      response: null,
      error: null,
    };
    this.lastRequestRecord = record;
    if (this.captureRequests) this.requestRecords.push(record);
    this._emitRequestRecord("request", record);
    return record;
  }

  _emitRequestRecord(phase, record) {
    if (!this.onRequestRecord) return;
    try { this.onRequestRecord({ phase, record: serializableCopy(record) }); } catch { /* evidence hooks never break inference */ }
  }

  /** Serializable snapshot for artifact builders; callers cannot mutate the live records. */
  requestCursor() { return this.requestCount; }

  requestLog({ from = 0, to = Infinity } = {}) {
    return this.requestRecords
      .filter((record) => record.index >= from && record.index < to)
      .map((record) => JSON.parse(JSON.stringify(record)));
  }

  async health() {
    if (this.codex) {
      if (this.codexRuntime) return this.codexRuntime.health();
      // Health gets a short control-plane budget, but completion turns retain
      // the full model timeout. Reusing this probe runtime used to impose its
      // 30-second cap on every later Codex turn.
      const probe = new CodexAppServer({
        cwd: process.cwd(),
        model: this.modelName,
        effort: this.codexEffort,
        timeoutMs: Math.min(this.timeoutMs, 30000),
        threadMode: this.codexThreadMode,
        promptMode: this.codexPromptMode,
        rebaseEvery: this.codexRebaseEvery,
        rebaseMinSavings: this.codexRebaseMinSavings,
      });
      try {
        return await probe.health();
      } finally {
        probe.close();
      }
    }
    // OpenAI-compatible servers expose GET /v1/models, not llama.cpp's /health.
    const url = this.apiMode ? `${this.apiUrl}/models` : `${this.endpoint}/health`;
    const headers = this.apiMode && this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined;
    try {
      const res = await fetch(url, { method: "GET", headers });
      if (res.ok) await this.detectChatSessions();
      return res.ok;
    } catch {
      return false;
    }
  }

  async listCodexModels() {
    const runtime = this.codexRuntime ?? new CodexAppServer({
      cwd: process.cwd(),
      model: this.codex ? this.modelName : "gpt-5.6-sol",
      effort: this.codex ? this.codexEffort : "high",
      timeoutMs: Math.min(this.timeoutMs, 30000),
      threadMode: this.codexThreadMode,
      promptMode: this.codexPromptMode,
      rebaseEvery: this.codexRebaseEvery,
      rebaseMinSavings: this.codexRebaseMinSavings,
    });
    const temporary = runtime !== this.codexRuntime;
    try {
      return await runtime.models();
    } finally {
      if (temporary) runtime.close();
    }
  }

  /**
   * Point this client at a different server — the primitive behind in-session model switching.
   * A registry entry may name the profile its model needs (`"profile": "gemma"`); an explicit
   * `--profile` on the command line still outranks it.
   */
  switchTo(endpoint, { profile = null } = {}) {
    this.codexRuntime?.close();
    this.codexRuntime = null;
    this.codex = false;
    if (!this.profileExplicit) {
      this._applyProfile(profile ? resolveProfile({ profile }) : this.localProfile);
    }
    this.endpoint = String(endpoint).replace(/\/$/, "");
    this.apiUrl = null;
    this.apiMode = false;
    return this.endpoint;
  }

  switchToApi({ url, model, key = null, deepseek = false, dialect } = {}) {
    this.codexRuntime?.close();
    this.codexRuntime = null;
    this.codex = false;
    this.apiUrl = String(url).replace(/\/$/, "");
    this.apiMode = true;
    this.modelName = model || "local";
    this.apiKey = key;
    this.deepseek = deepseek === true;
    this.chatDialect = isChatDialect(dialect);
    this.deepseekThinking = false;
    if (this.deepseek && (this.modelName === "deepseek-reasoner" || this.modelName === "deepseek-chat")) {
      this.deepseekThinking = this.modelName === "deepseek-reasoner";
      this.modelName = "deepseek-v4-flash";
    }
    if ((this.deepseek || this.chatDialect) && !this.profileExplicit) {
      this._applyProfile(resolveProfile({ profile: "generic" }));
    }
    this.grammarField = grammarFieldFor(dialect);
    return this.apiUrl;
  }

  switchToCodex({ model = "gpt-5.6-sol", effort = "high" } = {}) {
    this.codexRuntime?.close();
    this.codexRuntime = null;
    this.codex = true;
    if (!this.profileExplicit) this._applyProfile(resolveProfile({ profile: "generic" }));
    this.apiMode = false;
    this.apiUrl = null;
    this.apiKey = null;
    this.deepseek = false;
    this.modelName = model;
    this.codexEffort = effort;
    return `codex-app-server://${model}`;
  }

  // Switching profiles must also switch the things a profile OWNS about prompt
  // shape: the chat template, the reasoning markers, the assistant prefill, and
  // the stop tokens (a Gemma server never sees `<|im_end|>`, so keeping ChatML
  // stops across a switch would leave generation unbounded). Sampling is left
  // alone deliberately — it is not template-derived, and an in-session switch
  // has never reset it. Anything the caller pinned explicitly always wins.
  _applyProfile(profile) {
    this.profile = profile;
    this.profileName = profile.name;
    if (!this.pinned.has("assistantPrefill")) this.assistantPrefill = profile.assistantPrefill;
    if (!this.pinned.has("historyPrefill")) {
      this.historyPrefill = profile.historyPrefill ?? profile.assistantPrefill;
    }
    if (!this.pinned.has("stop")) this.stop = profile.stop;
    if (!this.pinned.has("nPredict")) this.nPredict = profile.nPredict;
    this.template = profile.template;
    this.thinkMarkers = profile.think;
  }

  beginAgentRun() {
    this.chatSessions?.beginRun();
    if (!this.codex || this.codexThreadMode !== "run") return null;
    // Establish the boundary before the first lazy completion so no request can
    // accidentally escape into an unscoped persistent conversation.
    this.codexRuntime ??= new CodexAppServer({
      cwd: process.cwd(),
      model: this.modelName,
      effort: this.codexEffort,
      timeoutMs: this.timeoutMs,
      threadMode: this.codexThreadMode,
      promptMode: this.codexPromptMode,
      rebaseEvery: this.codexRebaseEvery,
      rebaseMinSavings: this.codexRebaseMinSavings,
    });
    this.codexRunToken = this.codexRuntime.beginRun();
    return this.codexRunToken;
  }

  endAgentRun(token) {
    let ended = false;
    if (token && this.codexRuntime) {
      ended = this.codexRuntime.endRun(token);
      if (token === this.codexRunToken) this.codexRunToken = null;
    }
    // Awaitable when sessions are held open; a plain boolean otherwise, so
    // callers that never awaited keep working.
    return this.chatSessions ? this.chatSessions.release().then(() => ended) : ended;
  }

  close() {
    this.codexRuntime?.close();
    this.codexRuntime = null;
  }

  metadata() {
    return {
      endpoint: this.endpoint,
      runtime: this.codex ? "codex" : (this.apiMode ? "api" : "local"),
      model: this.modelName,
      reasoningEffort: this.codex ? this.codexEffort : null,
      codexThreadMode: this.codex ? this.codexThreadMode : null,
      codexPromptMode: this.codex ? this.codexPromptMode : null,
      codexRebaseEvery: this.codex ? this.codexRebaseEvery : null,
      codexRebaseMinSavings: this.codex ? this.codexRebaseMinSavings : null,
      profile: this.profileName,
      sampling: {
        temperature: this.temperature,
        act_temperature: this.actTemperature,
        top_p: this.topP,
        top_k: this.topK,
        seed: this.seed,
      },
      nPredict: this.nPredict,
      stop: this.stop,
      completionIndex: this.completionIndex,
    };
  }
}

async function readJsonResponse(res) {
  if (typeof res.text === "function") {
    const rawBody = await res.text();
    return { data: JSON.parse(rawBody), rawBody };
  }
  const data = await res.json();
  return { data, rawBody: JSON.stringify(data) };
}

function responseRecord(res, rawBody, normalized) {
  const body = String(rawBody ?? "");
  return {
    status: Number.isInteger(res?.status) ? res.status : (res?.ok ? 200 : null),
    rawBody: body,
    bodySha256: sha256(body),
    normalized: normalized ? normalizedResponseRecord(normalized) : null,
  };
}

/** Drop the assistant prefill the chat endpoint echoes back ahead of new text. */
export function stripChatPrefill(content, prefill) {
  if (!prefill || typeof content !== "string") return content;
  return content.startsWith(prefill) ? content.slice(prefill.length) : content;
}

function normalizedResponseRecord(value) {
  return {
    content: value?.content ?? "",
    tokens: value?.tokens ?? 0,
    stoppedEos: Boolean(value?.stoppedEos),
    stoppedLimit: Boolean(value?.stoppedLimit),
    timings: value?.timings ?? {},
    usage: value?.usage ?? null,
    codexThread: value?.codexThread ?? null,
    codexPromptDelivery: value?.codexPromptDelivery ?? null,
    codexUsageEvidence: value?.codexUsageEvidence ?? null,
  };
}

function normalizeRequestError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    ...(error?.timeoutKind ? {timeoutKind: error.timeoutKind} : {}),
    ...(Number.isInteger(error?.outputChars) ? {outputChars: error.outputChars} : {}),
    ...(Number.isInteger(error?.notificationCount) ? {notificationCount: error.notificationCount, lastEvent: error.lastEvent ?? null} : {}),
    ...(typeof error?.canRegenerate === 'boolean' ? {canRegenerate: error.canRegenerate} : {}),
  };
}

function normalizeExactRequest(request) {
  if (!request || typeof request !== "object" || typeof request.body !== "string") return null;
  if (typeof request.url !== "string" || !request.url) return null;
  return {
    ...request,
    method: typeof request.method === "string" ? request.method : "POST",
    headers: request.headers && typeof request.headers === "object"
      ? { ...request.headers }
      : { "Content-Type": "application/json" },
    body: request.body,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function serializableCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

const REDACTED_AUTHORIZATION = "Bearer [redacted]";

function redactRequestEvidence(request) {
  const copy = serializableCopy(request);
  if (copy?.headers && typeof copy.headers === "object") {
    for (const name of Object.keys(copy.headers)) {
      if (name.toLowerCase() === "authorization") copy.headers[name] = REDACTED_AUTHORIZATION;
    }
  }
  return copy;
}

function usageSource(meta) {
  const explicit = String(meta?.source ?? "").trim();
  if (/^[a-z][a-z0-9_]*$/.test(explicit)) return explicit;
  const tool = String(meta?.tool ?? "").trim();
  if (tool === "generate_image") return "image_generation";
  if (tool === "preview_vision") return "preview_vision";
  if (tool === "view_image") return "supplied_image_vision";
  return "external_tool";
}

// Auto-select the model endpoint from whatever llama.cpp server is actually running.
// Candidates come from BANTAM_ENDPOINTS (comma-separated) or a default list; the first that
// answers /health wins. An explicit endpoint (--endpoint / BANTAM_ENDPOINT) always short-circuits.
// This is how one BANTAM install switches between e.g. a 27B on :8085 and a 35B on :18086 with
// nothing more than which server you have up.
export async function detectEndpoint(opts = {}) {
  const explicit = opts.endpoint || process.env.BANTAM_ENDPOINT;
  if (explicit) return explicit.replace(/\/$/, "");
  const list = process.env.BANTAM_ENDPOINTS
    ? process.env.BANTAM_ENDPOINTS.split(",")
    : ["http://localhost:8085", "http://localhost:18086"];
  const candidates = list.map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  for (const ep of candidates) {
    try {
      const res = await fetch(`${ep}/health`, { method: "GET", signal: AbortSignal.timeout(1500) });
      if (res.ok) return ep;
    } catch { /* not this one */ }
  }
  return candidates[candidates.length - 1] || FALLBACK_ENDPOINT; // last resort; ModelClient errors clearly if dead
}

function interruptedError() {
  const error = new Error("model request interrupted by user");
  error.code = "aborted";
  return error;
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(interruptedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(interruptedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function normalizeSeed(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_DETERMINISTIC_SEED) {
    throw new Error(`model seed must be an integer from 0 to ${MAX_DETERMINISTIC_SEED}`);
  }
  return value;
}

function normalizeCodexThreadMode(value) {
  const mode = String(value ?? "ephemeral").trim().toLowerCase();
  if (mode === "ephemeral" || mode === "run") return mode;
  throw new Error(`invalid Codex thread mode: ${value}; expected ephemeral or run`);
}

function normalizeCodexPromptMode(value) {
  const mode = String(value ?? "full").trim().toLowerCase();
  if (mode === "full" || mode === "delta") return mode;
  throw new Error(`invalid Codex prompt mode: ${value}; expected full or delta`);
}

function normalizeCodexRebaseEvery(value) {
  const interval = Number(value);
  if (Number.isInteger(interval) && interval >= 0) return interval;
  throw new Error(`invalid Codex rebase interval: ${value}; expected a non-negative integer`);
}

function normalizeCodexRebaseMinSavings(value) {
  const ratio = Number(value);
  if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) return ratio;
  throw new Error(`invalid Codex rebase minimum savings: ${value}; expected a number from 0 to 1`);
}
