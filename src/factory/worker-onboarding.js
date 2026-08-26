import { ModelClient } from "../model.js";
import { WorkforceRegistry } from "./workforce.js";

const GRAMMAR_SENTINEL = "BANTAMCLOCKIN";

export async function onboardLocalWorker({
  root,
  endpoint,
  profile = "qwen",
  slots = null,
  ttlMs = 60_000,
  fetchFn = globalThis.fetch,
  modelFactory = (options) => new ModelClient(options),
} = {}) {
  const base = loopbackEndpoint(endpoint);
  if (typeof fetchFn !== "function") throw new TypeError("worker onboarding fetch function is required");
  const healthDocument = await fetchJson(fetchFn, `${base}/health`, "local worker health");
  if (healthDocument?.status !== "ok") throw new Error("local worker health did not report ok");
  const models = await fetchJson(fetchFn, `${base}/v1/models`, "local worker model catalog");
  const model = requiredText(models?.data?.[0]?.id ?? models?.models?.[0]?.model, "served local model id");
  const props = await fetchJson(fetchFn, `${base}/props`, "local worker properties");
  const contextTokens = positiveInteger(props?.default_generation_settings?.n_ctx ?? models?.data?.[0]?.meta?.n_ctx, "local worker context tokens");
  const observedSlots = positiveInteger(props?.total_slots, "local worker observed slots");
  const declaredSlots = slots === null ? observedSlots : positiveInteger(slots, "local worker declared slots");
  if (declaredSlots > observedSlots) throw new Error(`local worker cannot declare ${declaredSlots} slots when the server reports ${observedSlots}`);

  const client = modelFactory({ endpoint: base, profile, model, nPredict: 12, timeoutMs: 60_000, retries: 0 });
  let probe;
  const started = Date.now();
  try {
    probe = await client.complete("Clock this worker into BANTAMFACTORY. Return the constrained sentinel.\nAnswer:", {
      grammar: `root ::= "${GRAMMAR_SENTINEL}"`,
      nPredict: 12,
    });
  } finally {
    client?.close?.();
  }
  if (String(probe?.content ?? "").trim() !== GRAMMAR_SENTINEL) throw new Error("local worker did not honor the factory grammar probe");

  const workforce = new WorkforceRegistry(root);
  const installed = workforce.installRuntimeIdentity(`local:${model}`);
  const build = optionalText(props?.build_info);
  const detail = [
    `endpoint ${base}`,
    `context ${contextTokens}`,
    `slots ${observedSlots}`,
    build ? `llama.cpp ${build}` : null,
    "grammar passed",
  ].filter(Boolean).join("; ");
  const health = workforce.observeHealth({
    workerRef: installed.ref,
    condition: "available",
    code: "endpoint-ready",
    ttlMs,
    slotsAvailable: declaredSlots,
    detail,
  });
  return Object.freeze({
    schema: 1,
    kind: "bantam.factory-worker-onboarding",
    endpoint: base,
    model,
    profile: requiredText(profile, "local worker prompt profile"),
    contextTokens,
    observedSlots,
    declaredSlots,
    modalities: Object.freeze({
      vision: props?.modalities?.vision === true,
      audio: props?.modalities?.audio === true,
      video: props?.modalities?.video === true,
    }),
    serverBuild: build,
    grammar: Object.freeze({ passed: true, sentinel: GRAMMAR_SENTINEL, durationMs: Date.now() - started }),
    worker: installed,
    health,
    qualification: "not-granted",
    authority: "attendance-only",
  });
}

function loopbackEndpoint(value) {
  let url;
  try { url = new URL(requiredText(value, "local worker endpoint")); }
  catch { throw new Error("local worker endpoint must be a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("local worker endpoint must use http or https");
  const host = url.hostname.toLowerCase();
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host)) throw new Error("local worker onboarding requires a loopback endpoint");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("local worker endpoint must be an origin without credentials, path, query, or fragment");
  return url.origin;
}

async function fetchJson(fetchFn, url, label) {
  let response;
  try { response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) }); }
  catch (error) { throw new Error(`${label} is unreachable: ${error.message}`); }
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  try { return await response.json(); }
  catch { throw new Error(`${label} did not return JSON`); }
}

function requiredText(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function optionalText(value) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null; }
function positiveInteger(value, label) { const result = Number(value); if (!Number.isInteger(result) || result < 1 || result > 1_000_000_000) throw new Error(`${label} must be a positive integer`); return result; }
