// Turn-level counterfactual replay: rewind a recorded run to the exact turn
// where something went wrong, optionally adjust the context, and re-ask the
// model that ONE turn. Turns "fix the harness, rerun 80 minutes" into "fix
// the context, replay 30 seconds". Requires the run to have been recorded
// with BANTAM_SAVE_PROMPTS=1 (each turn then carries its assembled prompt).

import crypto from "node:crypto";

/**
 * Reconstruct the model transport that produced an artifact. Exact request
 * replay is only exact when the client dispatches through the same runtime;
 * a codex-app-server:// request sent through fetch() is neither replay nor a
 * useful counterfactual.
 */
export function replayRuntimeOptions(artifact, { transportOverride = false } = {}) {
  if (transportOverride) return { codex: false, apiUrl: null };
  const metadata = artifact?.model?.metadata ?? {};
  const requestRuntime = (artifact?.modelCalls ?? [])
    .some((call) => String(call?.request?.url ?? "").startsWith("codex-app-server://"))
    ? "codex"
    : null;
  const runtime = metadata.runtime ?? requestRuntime;
  if (runtime !== "codex") return { codex: false };
  return {
    codex: true,
    apiUrl: null,
    model: metadata.model ?? artifact?.modelId ?? artifact?.model?.id,
    codexEffort: metadata.reasoningEffort ?? "high",
    codexThreadMode: "run",
    codexPromptMode: "delta",
  };
}

export function prepareReplay(artifact, turnIndex, { inject = "" } = {}) {
  const turns = artifact?.turns ?? [];
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= turns.length) {
    throw new Error(`turn ${turnIndex} out of range (run has ${turns.length} turns)`);
  }
  const turn = turns[turnIndex];
  const callIndex = Number.isInteger(turn.modelCallIndex) ? turn.modelCallIndex : null;
  const exact = callIndex === null ? null : prepareRequestReplay(artifact, callIndex, { inject });
  const recordedPrompt = typeof exact?.body?.prompt === "string" && exact.body.prompt
    ? exact.body.prompt
    : turn.prompt;
  if (typeof recordedPrompt !== "string" || !recordedPrompt) {
    throw new Error(
      "this artifact has no saved prompts or linked model request — record the run with request capture to enable replay",
    );
  }
  let prompt = recordedPrompt;
  // prepareRequestReplay already applies the injection to its exact request.
  // Apply it here only when replaying a legacy prompt-only artifact.
  if (inject && !exact) {
    // The injection lands as a final steering note, in the same voice the
    // harness uses for live signals, immediately before the model acts.
    prompt = `${prompt}\n\n[replay-injection] ${inject}\n`;
  }
  return {
    prompt,
    recorded: {
      action: turn.parsedAction ?? null,
      rawOutput: turn.rawOutput ?? null,
      reasoning: turn.reasoning ?? null,
      observation: turn.observation ?? null,
    },
    sampling: artifact.sampling ?? null,
    endpoint: artifact.endpoint ?? null,
    fidelity: exact ? exact.fidelity : "prompt-exact",
    requestExact: Boolean(exact?.requestExact),
    request: exact?.request ?? null,
    modelCallIndex: callIndex,
  };
}

/**
 * Reconstruct the byte-exact HTTP request stored by ModelClient. Unlike the
 * older turn replay, this preserves grammar, seed, all sampler settings, stop
 * tokens, n_predict, cache mode, and streaming mode. An injection deliberately
 * changes only `prompt`, so that result is labelled a counterfactual.
 */
export function prepareRequestReplay(artifact, callIndex, { inject = "" } = {}) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  if (!Number.isInteger(callIndex) || callIndex < 0) {
    throw new Error(`model call ${callIndex} out of range (artifact has ${calls.length} calls)`);
  }
  // A long-lived ModelClient numbers calls monotonically. A single run may
  // therefore contain calls 40..52 even though its artifact array has only 13
  // entries. Prefer that stable recorded id; retain positional lookup for
  // schema-1/hand-authored artifacts whose call rows predate `index`.
  const call = calls.find((row) => row?.index === callIndex)
    ?? (calls[callIndex]?.index === undefined ? calls[callIndex] : null);
  if (!call) {
    throw new Error(`model call ${callIndex} not found (artifact has ${calls.length} calls)`);
  }
  const original = normalizeRecordedRequest(call.request ?? call);
  if (!original) {
    throw new Error(`model call ${callIndex} has no exact serialized request body`);
  }
  if (original.bodySha256 && sha256(original.body) !== original.bodySha256) {
    throw new Error(`model call ${callIndex} request body checksum does not match`);
  }

  let body;
  try { body = JSON.parse(original.body); }
  catch (error) { throw new Error(`model call ${callIndex} request body is invalid JSON: ${error.message}`); }
  let serialized = original.body;
  if (inject) {
    if (typeof body.prompt !== "string") throw new Error(`model call ${callIndex} request has no prompt to inject`);
    body.prompt = `${body.prompt}\n\n[replay-injection] ${inject}\n`;
    serialized = JSON.stringify(body);
  }

  const request = {
    ...original,
    body: serialized,
    bodySha256: sha256(serialized),
    promptSha256: typeof body.prompt === "string" ? sha256(body.prompt) : null,
    grammarSha256: typeof body.grammar === "string" ? sha256(body.grammar) : null,
  };
  return {
    fidelity: inject ? "counterfactual" : "request-exact",
    requestExact: !inject,
    request,
    body,
    endpoint: artifact.endpoint ?? endpointFromRequest(request.url),
    recorded: {
      response: call.response ?? null,
      attempts: Array.isArray(call.attempts) ? call.attempts : [],
      error: call.error ?? null,
    },
  };
}

/**
 * Derive the request for replay sample N. Sample 0 re-sends the recorded body
 * byte-exactly. Later samples step the recorded seed: a seeded body re-sent N
 * times yields N near-identical completions, so a "3-sample" diagnose verdict
 * was really one effective draw wearing three hats. Baseline and remedy arms
 * share the same derived seed sequence, so the comparison stays paired.
 */
export function withSampleSeed(replay, sampleIndex) {
  if (!replay?.request || !Number.isInteger(sampleIndex) || sampleIndex <= 0) return replay;
  let body;
  try { body = JSON.parse(replay.request.body); } catch { return replay; }
  if (!Number.isFinite(body.seed)) return replay;
  body.seed = (body.seed + sampleIndex) % 0xFFFFFFFF;
  const serialized = JSON.stringify(body);
  return {
    ...replay,
    fidelity: replay.fidelity === "request-exact" ? "counterfactual-seed" : `${replay.fidelity}+seed`,
    requestExact: false,
    body,
    request: { ...replay.request, body: serialized, bodySha256: sha256(serialized) },
  };
}

/**
 * Three outcomes, not two. "The model decided the same", "the model decided
 * something else", and "the model did not decide" are different results, and the
 * third is not evidence about the injection at all: an empty or unparseable
 * completion means the counterfactual produced no action to compare. Reporting it
 * as CHANGED reads as a win — on 2026-07-16 an injected fact returned one newline
 * and this said "the model decides differently with this context."
 *
 * CHANGED is also not a synonym for BETTER. The replayed action can be a worse
 * answer than the recorded one, so the verdict states what moved and leaves the
 * judgement to the reader looking at both actions above it.
 */
export function formatReplayComparison(recorded, replayedRaw) {
  const lines = [];
  lines.push("── recorded action ──");
  lines.push(JSON.stringify(recorded.action ?? recorded.rawOutput ?? null, null, 2));
  lines.push("── replayed output ──");
  const shown = String(replayedRaw ?? "").trim();
  lines.push(shown || "(nothing)");
  const replayed = safeParseCompare(replayedRaw);
  if (replayed === null) {
    lines.push("── verdict: NO ACTION — the replay produced no parseable action, so this");
    lines.push("   says nothing about the injection. Re-run before reading anything into it. ──");
  } else if (JSON.stringify(recorded.action) === replayed) {
    lines.push("── verdict: UNCHANGED — the injection did not alter this decision ──");
  } else {
    lines.push("── verdict: CHANGED — the model decides differently with this context.");
    lines.push("   Different is not better: read both actions above and judge the new one. ──");
  }
  return lines.join("\n");
}

function safeParseCompare(raw) {
  try {
    const match = String(raw ?? "").match(/\{[\s\S]*\}/);
    return match ? JSON.stringify(JSON.parse(match[0])) : null;
  } catch {
    return null;
  }
}

function normalizeRecordedRequest(request) {
  if (!request || typeof request !== "object") return null;
  const body = typeof request.body === "string"
    ? request.body
    : typeof request.serializedBody === "string" ? request.serializedBody : null;
  if (!body) return null;
  return {
    url: request.url ?? null,
    method: request.method ?? "POST",
    headers: request.headers && typeof request.headers === "object"
      ? { ...request.headers }
      : { "Content-Type": "application/json" },
    ...request,
    body,
  };
}

function endpointFromRequest(url) {
  return typeof url === "string" ? url.replace(/\/completion$/, "") : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
