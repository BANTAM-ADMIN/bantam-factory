// Jev mode configuration, per user in ~/.bantam/jev.json (or the file named by
// BANTAM_JEV_CONFIG). `bantam jev setup` / the first `:jev on` writes it:
//
//   external engine (a DiffusionGemma vLLM you run yourself):
//     { "engine": { "mode": "external" }, "endpoint": "http://gpu-box:8001", "servedModel": "dgemma" }
//   managed engine (BANTAM runs the container):
//     { "engine": { "mode": "managed" }, "container": "dg-jev-vllm", "endpoint": "http://127.0.0.1:8001",
//       "create": { "image": "...", "modelPath": "...", "args": [...] } }
//
// Everything else has defaults below. See docs/JEV-MODE.md for each setting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The vLLM serve arguments measured on a 24 GB RTX 4090 with the AWQ-INT4
// model: structured reads need vLLM with PR #57250 (commit 1b3b88e, as pinned
// by OpenJev's image), sleep mode for GPU swapping, and max-num-seqs 1 (8 ran
// out of memory in the logits buffer).
export function vllmServeArgs({ port = 8001, maxModelLen = 16384, gpuUtil = 0.88 } = {}) {
  return [
    "serve", "/model", "--served-model-name", "dgemma", "--host", "127.0.0.1", "--port", String(port),
    "--max-model-len", String(maxModelLen), "--max-num-batched-tokens", String(maxModelLen), "--max-num-seqs", "1",
    "--gpu-memory-utilization", String(gpuUtil), "--kv-cache-dtype", "fp8", "--max-logprobs", "32",
    "--limit-mm-per-prompt", "{\"image\": 0, \"video\": 0}",
    "--override-generation-config", "{\"max_new_tokens\": null}", "--enable-prefix-caching", "--async-scheduling",
    "--attention-backend", "TRITON_ATTN", "--enable-sleep-mode",
  ];
}

export const DEFAULT_JEV_CONFIG = Object.freeze({
  // "unconfigured" until `bantam jev setup` (or the first `:jev on`) chooses
  // "external" (your own DiffusionGemma vLLM) or "managed" (BANTAM runs it).
  engine: { mode: "unconfigured" },
  // The managed container and the endpoint the decider reads from.
  container: "dg-jev-vllm",
  endpoint: "http://127.0.0.1:8001",
  servedModel: "dgemma",
  // How a managed container is created; setup fills image and modelPath.
  create: { image: null, modelPath: null, args: vllmServeArgs() },
  // A cold start loads 21 GB of weights (measured about 145 s).
  startTimeoutMs: 300_000,
  // The Jev-compatible API BANTAM serves. LAN exposure requires a token.
  api: { host: "127.0.0.1", port: 8090, token: null, maxQuestions: 256, maxBodyBytes: 64 * 1024 * 1024 },
  // GPU policy: "alongside" keeps DiffusionGemma awake next to a cloud worker;
  // "swap" trades the GPU with a local llama.cpp worker; "off" refuses while a
  // local worker holds the GPU. "auto" picks alongside for Codex/API workers and
  // swap for a local worker.
  // The first sleep after a start copies the weights to host memory (85.9 s
  // measured); later sleeps take under a second and wakes about one.
  gpu: { policy: "auto", burstMs: 30_000, sleepTimeoutMs: 180_000 },
  // The execution gauge's sandbox image (docker/exec-cell).
  execCellImage: "bantam/exec-cell:1",
});

export function jevConfigPath() {
  return process.env.BANTAM_JEV_CONFIG || path.join(os.homedir(), ".bantam", "jev.json");
}

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object"
      ? merge(base[key], value)
      : value;
  }
  return out;
}

/** The effective configuration: defaults, then the config file, then `overrides`. */
export function loadJevConfig(overrides = {}, { readFile = fs.readFileSync, file = jevConfigPath() } = {}) {
  let fromFile = {};
  try { fromFile = JSON.parse(readFile(file, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Jev config ${file} is not valid JSON: ${error.message}`);
  }
  const config = merge(merge(DEFAULT_JEV_CONFIG, fromFile), overrides);
  if (!["unconfigured", "external", "managed"].includes(config.engine.mode)) {
    throw new Error(`jev engine.mode must be external or managed (got ${config.engine.mode})`);
  }
  if (!["auto", "alongside", "swap", "off"].includes(config.gpu.policy)) {
    throw new Error(`jev gpu.policy must be auto, alongside, swap or off (got ${config.gpu.policy})`);
  }
  return config;
}

/** Persist settings (for example the GPU policy chosen with `:jev policy`). */
export function saveJevConfig(patch, { file = jevConfigPath() } = {}) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* start fresh */ }
  const next = merge(current, patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
