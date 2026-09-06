// Offline integrity audit for Codex prompt-delivery evidence.
//
// BANTAM stores the complete canonical request for every model call and, for
// run/delta delivery, the exact wire envelope returned by the transport. This
// module proves that each recorded envelope reconstructs the canonical prompt
// byte-for-byte. It never contacts Codex or trusts aggregate counters.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { reconstructCodexPromptDelivery } from "./codex-transport.js";

const MAX_FAILURES = 32;

export function auditCodexPromptDelivery(artifact, { includeCalls = false } = {}) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  const codex = artifact?.model?.metadata?.runtime === "codex"
    || calls.some((call) => isCodexCall(call));
  if (!codex) {
    return frozenReport({
      status: "not-applicable",
      codex: false,
      calls: 0,
      auditedCalls: 0,
      exactCalls: 0,
      fullCalls: 0,
      deltaCalls: 0,
      uniqueThreads: 0,
      failures: [],
      ...(includeCalls ? { callAudits: [] } : {}),
    });
  }

  const failures = [];
  const bases = new Map();
  const previousPrompts = new Map();
  const seenThreads = new Set();
  let auditedCalls = 0;
  let exactCalls = 0;
  let fullCalls = 0;
  let deltaCalls = 0;
  const exactCallIndices = new Set();

  const fail = (code, callIndex, message) => {
    if (failures.length < MAX_FAILURES) failures.push({ code, callIndex, message });
  };

  calls.forEach((call, position) => {
    if (!isCodexCall(call)) return;
    const callIndex = Number.isInteger(call?.index) ? call.index : position;
    const normalized = call?.response?.normalized;
    const delivery = normalized?.codexPromptDelivery;
    const thread = normalized?.codexThread;
    let request;
    try {
      request = JSON.parse(call?.request?.body);
    } catch {
      fail("request_body", callIndex, "request body is not valid JSON");
      return;
    }
    const canonical = request?.prompt;
    if (typeof canonical !== "string") {
      fail("canonical_prompt", callIndex, "request body has no canonical prompt string");
      return;
    }
    if (!delivery || typeof delivery !== "object") {
      fail("delivery_evidence", callIndex, "Codex response has no prompt-delivery evidence");
      return;
    }
    if (!thread || typeof thread.threadId !== "string" || thread.threadId === "") {
      fail("thread_evidence", callIndex, "Codex response has no native thread id");
      return;
    }

    auditedCalls++;
    const canonicalSha256 = sha256(canonical);
    if (call?.request?.promptSha256 !== canonicalSha256) {
      fail("request_sha256", callIndex, "request prompt SHA-256 does not match its canonical prompt");
    }
    if (delivery.canonicalSha256 !== canonicalSha256) {
      fail("canonical_sha256", callIndex, "delivery canonical SHA-256 does not match the request");
    }
    if (delivery.canonicalChars !== canonical.length) {
      fail("canonical_chars", callIndex, "delivery canonical character count does not match the request");
    }

    const threadId = thread.threadId;
    const previouslySeen = seenThreads.has(threadId);
    if (Boolean(thread.threadReused) !== previouslySeen) {
      fail("thread_reuse", callIndex, "thread reuse flag disagrees with prior call evidence");
    }
    seenThreads.add(threadId);

    let reconstructed = null;
    if (delivery.mode === "full" || delivery.mode === "full-fallback") {
      fullCalls++;
      reconstructed = typeof delivery.deliveredText === "string"
        ? delivery.deliveredText
        : canonical;
      bases.set(threadId, canonical);
    } else if (delivery.mode === "delta") {
      deltaCalls++;
      const incremental = Boolean(delivery.deliveredText?.startsWith("BANTAM_PROMPT_DELTA_V2\n"));
      if (incremental !== (delivery.baseReference === "previous")) {
        fail("delta_reference", callIndex, "delta reference evidence disagrees with its versioned wire envelope");
        return;
      }
      const base = incremental ? previousPrompts.get(threadId) : bases.get(threadId);
      if (typeof base !== "string") {
        fail("delta_base", callIndex, "delta has no full canonical base for its native thread");
        return;
      }
      if (typeof delivery.deliveredText !== "string") {
        fail("delta_text", callIndex, "delta has no exact delivered envelope");
        return;
      }
      try {
        reconstructed = reconstructCodexPromptDelivery(base, delivery.deliveredText);
      } catch (error) {
        fail("delta_parse", callIndex, boundedMessage(error));
        return;
      }
    } else {
      fail("delivery_mode", callIndex, "delivery mode is neither full nor delta");
      return;
    }

    const deliveredText = typeof delivery.deliveredText === "string"
      ? delivery.deliveredText
      : canonical;
    if (delivery.deliveredChars !== deliveredText.length) {
      fail("delivered_chars", callIndex, "delivered character count does not match the wire text");
    }
    if (delivery.deliveredSha256 !== sha256(deliveredText)) {
      fail("delivered_sha256", callIndex, "delivered SHA-256 does not match the wire text");
    }
    if (delivery.savedChars !== canonical.length - deliveredText.length) {
      fail("saved_chars", callIndex, "saved character count is arithmetically inconsistent");
    }
    if (reconstructed !== canonical) {
      fail("reconstruction", callIndex, "delivered prompt does not reconstruct the canonical request");
      return;
    }
    exactCalls++;
    exactCallIndices.add(callIndex);
    previousPrompts.set(threadId, canonical);
  });

  if (auditedCalls === 0) {
    fail("codex_calls", null, "artifact identifies Codex but has no auditable successful Codex calls");
  }
  return frozenReport({
    status: failures.length === 0 ? "pass" : "fail",
    codex: true,
    calls: calls.filter((call) => isCodexCall(call)).length,
    auditedCalls,
    exactCalls,
    fullCalls,
    deltaCalls,
    uniqueThreads: seenThreads.size,
    failures,
    ...(includeCalls ? {
      callAudits: calls
        .map((call, position) => ({ call, position }))
        .filter(({ call }) => isCodexCall(call))
        .map(({ call, position }) => codexCallAudit(call, position, exactCallIndices, failures)),
    } : {}),
  });
}

export function auditCodexArtifactFile(filePath, options) {
  const resolved = path.resolve(filePath);
  const artifact = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return { file: resolved, ...auditCodexPromptDelivery(artifact, options) };
}

function codexCallAudit(call, position, exactCallIndices, failures) {
  const callIndex = Number.isInteger(call?.index) ? call.index : position;
  const normalized = call?.response?.normalized;
  const usage = normalized?.usage ?? {};
  const delivery = normalized?.codexPromptDelivery ?? {};
  const thread = normalized?.codexThread ?? {};
  const started = Date.parse(call?.startedAt);
  const completed = Date.parse(call?.completedAt);
  const canonicalChars = finiteOrNull(delivery.canonicalChars);
  const deliveredChars = finiteOrNull(delivery.deliveredChars);
  const savedChars = finiteOrNull(delivery.savedChars);
  const failureCodes = failures
    .filter((failure) => failure.callIndex === callIndex)
    .map((failure) => failure.code);
  return {
    callIndex,
    exact: exactCallIndices.has(callIndex),
    failureCodes,
    threadId: typeof thread.threadId === "string" ? thread.threadId : null,
    threadReused: typeof thread.threadReused === "boolean" ? thread.threadReused : null,
    mode: typeof delivery.mode === "string" ? delivery.mode : null,
    canonicalChars,
    deliveredChars,
    savedChars,
    savedRatio: canonicalChars > 0 && savedChars !== null ? savedChars / canonicalChars : null,
    inputTokens: finiteOrNull(usage.inputTokens),
    cacheHitTokens: finiteOrNull(usage.cacheHitTokens),
    cacheMissTokens: finiteOrNull(usage.cacheMissTokens),
    outputTokens: finiteOrNull(usage.outputTokens),
    reasoningTokens: finiteOrNull(usage.reasoningTokens),
    durationMs: Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null,
  };
}

function isCodexCall(call) {
  const normalized = call?.response?.normalized;
  return normalized?.usage?.provider === "codex"
    || normalized?.codexThread != null
    || normalized?.codexPromptDelivery != null;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function boundedMessage(error) {
  const message = String(error?.message ?? error ?? "unknown delta reconstruction error");
  return message.length > 240 ? `${message.slice(0, 239)}…` : message;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function frozenReport(report) {
  return Object.freeze({
    ...report,
    failures: Object.freeze(report.failures.map((failure) => Object.freeze({ ...failure }))),
    ...(Array.isArray(report.callAudits)
      ? { callAudits: Object.freeze(report.callAudits.map((call) => Object.freeze({
          ...call,
          failureCodes: Object.freeze([...call.failureCodes]),
        }))) }
      : {}),
  });
}
