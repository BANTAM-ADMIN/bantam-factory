// Jev mode setup: use a DiffusionGemma server the user already runs, or install
// one (with consent). `bantamfactory jev setup` and the first `:jev on` call this.
//
//   external  verify the endpoint serves DiffusionGemma with structured reads
//             (vLLM with PR #57250), then save it; BANTAM never starts or stops it.
//   install   check prerequisites (NVIDIA GPU with enough memory, Docker with GPU
//             access, disk), show exactly what will be downloaded, and only on
//             consent: pull the image, download the model with the image's own
//             `hf` CLI (no host Python needed), save the config and start it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileHandlePool, createStructuredReader } from "../factory/system-one.js";
import { jevConfigPath, loadJevConfig, saveJevConfig, vllmServeArgs } from "./config.js";

// OpenJev's published image: vLLM pinned at the structured-read merge commit
// (1b3b88e, PR #57250), the same build Jev mode was measured on.
export const DEFAULT_IMAGE = "razorback16/openjev:0.5.0";
export const MODELS = Object.freeze({
  // Compressed-tensors AWQ INT4: runs on 24 GB Ampere/Ada cards (RTX 3090/4090, A5000...).
  awq: { repo: "cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4", bytes: 17_262_626_352, note: "AWQ INT4 for GPUs before Blackwell" },
  // NVFP4 needs Blackwell (compute capability 10.0 or newer).
  nvfp4: { repo: "nvidia/diffusiongemma-26B-A4B-it-NVFP4", bytes: 18_864_432_762, note: "NVFP4 for Blackwell GPUs" },
});
export const MIN_VRAM_MIB = 22_000;
const GIB = 1024 ** 3;

function run(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim(), error });
    });
  });
}

/**
 * Does `endpoint` serve DiffusionGemma with structured reads? One tiny real
 * read decides it: a plain vLLM or another model cannot pin the canvas, and
 * its answer mass on the two labels collapses.
 */
export async function probeEndpoint(endpoint, { servedModel = "dgemma", fetchImpl = fetch } = {}) {
  const root = String(endpoint).replace(/\/+$/, "");
  const out = { endpoint: root, reachable: false, vllm: false, model: false, structuredReads: false, sleepMode: false };
  // Identify the server before any read. A structured read sends a canvas of
  // token ids sized for DiffusionGemma's vocabulary; a llama.cpp server with a
  // smaller vocabulary crashed on one instead of rejecting it (seen in testing).
  try {
    const version = await (await fetchImpl(`${root}/version`, { signal: AbortSignal.timeout(5000) })).json();
    if (typeof version?.version !== "string") throw new Error("no vLLM version");
    out.reachable = true;
    out.vllm = true;
    out.version = version.version;
  } catch (error) {
    try { await fetchImpl(`${root}/v1/models`, { signal: AbortSignal.timeout(5000) }); out.reachable = true; } catch { /* unreachable */ }
    out.problem = out.reachable
      ? "this is not a vLLM server (no /version); Jev mode needs DiffusionGemma served by vLLM with PR #57250 (commit 1b3b88e)"
      : `not reachable: ${error.message}`;
    return out;
  }
  try {
    const models = await (await fetchImpl(`${root}/v1/models`, { signal: AbortSignal.timeout(5000) })).json();
    out.reachable = true;
    const ids = (models?.data ?? []).map((m) => m.id);
    out.models = ids;
    // A server that serves exactly one model under another name is tried as is.
    if (!ids.includes(servedModel) && ids.length === 1) servedModel = ids[0];
    out.servedModel = servedModel;
    out.model = ids.includes(servedModel);
    if (!out.model) { out.problem = `the server does not list the model "${servedModel}" (it lists: ${ids.join(", ") || "nothing"})`; return out; }
  } catch (error) {
    out.problem = `not reachable: ${error.message}`;
    return out;
  }
  try {
    const reader = createStructuredReader({ baseUrl: root, model: servedModel, fetchImpl });
    const pool = await compileHandlePool(reader, { size: 2 });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: pool.map((p) => p.handle) });
    const read = await reader.read({
      system: "Answer one multiple-choice question about the material. Reply exactly as: q1: [HANDLE]",
      user: `Two plus two is four.\n\n---\nQUESTION: Is the statement true?\nOPTIONS:\n[${pool[0].handle}] yes\n[${pool[1].handle}] no\n\nq1: Which ONE bracketed handle answers the question?`,
      compiled, seed: 1,
    });
    out.labelMass = read.labelMass;
    out.structuredReads = read.labelMass > 0.5;
    if (!out.structuredReads) out.problem = `structured reads are not working (answer mass ${read.labelMass?.toFixed(3)}); the server needs vLLM with PR #57250 (commit 1b3b88e)`;
  } catch (error) {
    out.problem = `structured read failed: ${String(error.message).slice(0, 200)}; the server needs vLLM with PR #57250 (commit 1b3b88e)`;
    return out;
  }
  try { out.sleepMode = (await fetchImpl(`${root}/is_sleeping`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* optional */ }
  return out;
}

/** What this machine has for a managed install, and which model fits it. */
export async function checkPrerequisites({ modelDir = defaultModelDir(), runImpl = run } = {}) {
  const found = { docker: false, gpuInDocker: false, gpus: [], diskFreeBytes: null, problems: [] };
  const docker = await runImpl("docker", ["version", "--format", "{{.Server.Version}}"]);
  found.docker = docker.ok;
  if (!docker.ok) found.problems.push("Docker is not available (install Docker Engine and make sure your user can run `docker`)");
  const info = docker.ok ? await runImpl("docker", ["info", "--format", "{{json .Runtimes}}"]) : { ok: false, stdout: "" };
  found.gpuInDocker = info.ok && /nvidia/.test(info.stdout);
  if (docker.ok && !found.gpuInDocker) found.problems.push("Docker has no NVIDIA runtime (install the NVIDIA Container Toolkit and restart Docker)");
  const smi = await runImpl("nvidia-smi", ["--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits"]);
  if (smi.ok) {
    found.gpus = smi.stdout.split("\n").filter(Boolean).map((line) => {
      const [name, mib, cap] = line.split(",").map((x) => x.trim());
      return { name, memoryMiB: Number(mib), computeCap: Number(cap) };
    });
  } else found.problems.push("no NVIDIA GPU found (nvidia-smi failed)");
  const best = [...found.gpus].sort((a, b) => b.memoryMiB - a.memoryMiB)[0];
  if (best && best.memoryMiB < MIN_VRAM_MIB) found.problems.push(`${best.name} has ${Math.round(best.memoryMiB / 1024)} GB; DiffusionGemma 26B needs about ${Math.round(MIN_VRAM_MIB / 1024)} GB of GPU memory`);
  found.gpu = best ?? null;
  found.model = best ? (best.computeCap >= 10 ? MODELS.nvfp4 : MODELS.awq) : MODELS.awq;
  try {
    fs.mkdirSync(modelDir, { recursive: true });
    const stat = fs.statfsSync(modelDir);
    found.diskFreeBytes = stat.bavail * stat.bsize;
    if (found.diskFreeBytes < found.model.bytes * 1.1) found.problems.push(`not enough disk at ${modelDir}: ${(found.diskFreeBytes / GIB).toFixed(1)} GiB free, the model needs ${(found.model.bytes / GIB).toFixed(1)} GiB`);
  } catch (error) { found.problems.push(`cannot use ${modelDir}: ${error.message}`); }
  return found;
}

export function defaultModelDir() {
  return path.join(os.homedir(), ".bantam", "models");
}

/** Exactly what an install will do: shown to the user before any download. */
export async function installPlan({ prerequisites, image = DEFAULT_IMAGE, modelDir = defaultModelDir(), runImpl = run, port = 8001 } = {}) {
  const model = prerequisites.model;
  const modelPath = path.join(modelDir, model.repo.split("/")[1]);
  const imagePresent = (await runImpl("docker", ["image", "inspect", image])).ok;
  const modelPresent = fs.existsSync(path.join(modelPath, "config.json")) && fs.readdirSync(modelPath).some((f) => f.endsWith(".safetensors"));
  const gpuUtil = prerequisites.gpu ? Math.min(0.9, Math.max(0.5, 21_500 / prerequisites.gpu.memoryMiB)) : 0.88;
  return {
    image, imagePresent,
    model: model.repo, modelNote: model.note, modelBytes: model.bytes, modelPath, modelPresent,
    container: "dg-jev-vllm", endpoint: `http://127.0.0.1:${port}`,
    args: vllmServeArgs({ port, gpuUtil: Number(gpuUtil.toFixed(2)) }),
    steps: [
      imagePresent ? `use the Docker image ${image} (already present)` : `pull the Docker image ${image} (the vLLM build with structured reads)`,
      modelPresent ? `use the model already at ${modelPath}` : `download ${model.repo} (${(model.bytes / GIB).toFixed(1)} GiB, ${model.note}) to ${modelPath}`,
      `create the container dg-jev-vllm serving it on 127.0.0.1:${port} (about 21 GB of GPU memory while awake, 3 GB asleep)`,
      `save the settings to ${jevConfigPath()}`,
    ],
  };
}

/** Carry out a plan. Call only after the user agreed to it. */
export async function runInstall(plan, { onProgress = () => {}, runImpl = run } = {}) {
  if (!plan.imagePresent) {
    onProgress(`pulling ${plan.image} (this can take several minutes)`);
    const pulled = await runImpl("docker", ["pull", plan.image], { timeoutMs: 60 * 60_000 });
    if (!pulled.ok) throw new Error(`docker pull ${plan.image} failed: ${pulled.stderr.slice(-300)}`);
  }
  if (!plan.modelPresent) {
    fs.mkdirSync(plan.modelPath, { recursive: true });
    onProgress(`downloading ${plan.model} to ${plan.modelPath} (${(plan.modelBytes / GIB).toFixed(1)} GiB)`);
    // Run as the invoking user so the weights are theirs, not root's.
    const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
    const args = ["run", "--rm", "--network", "host", ...user, "-e", "HF_HOME=/download/.cache", "-v", `${plan.modelPath}:/download`,
      ...(process.env.HF_TOKEN ? ["-e", "HF_TOKEN"] : []),
      "--entrypoint", "/opt/venv/bin/hf", plan.image, "download", plan.model, "--local-dir", "/download"];
    const downloaded = await runImpl("docker", args, { timeoutMs: 6 * 60 * 60_000 });
    if (!downloaded.ok) throw new Error(`model download failed: ${downloaded.stderr.slice(-300)}`);
  }
  const config = saveJevConfig({
    engine: { mode: "managed" },
    container: plan.container,
    endpoint: plan.endpoint,
    servedModel: "dgemma",
    create: { image: plan.image, modelPath: plan.modelPath, args: plan.args },
  });
  onProgress(`saved ${jevConfigPath()}`);
  return config;
}

/** Save an external endpoint after it passed the probe. */
export function saveExternal(endpoint, { servedModel = "dgemma" } = {}) {
  return saveJevConfig({ engine: { mode: "external" }, endpoint, servedModel });
}

/**
 * The interactive setup. `ask(question)` returns the user's typed answer (null
 * when cancelled); `yes` skips the confirmation (scripted installs).
 */
export async function setupWizard({ ask, out = console.log, endpoint = null, install = false, yes = false, image = DEFAULT_IMAGE, modelDir = defaultModelDir(), fetchImpl = fetch, runImpl = run } = {}) {
  let choice = endpoint ? "external" : install ? "install" : null;
  if (!choice) {
    out("  Jev mode needs DiffusionGemma 26B served by vLLM with structured reads.");
    out("    1) use a DiffusionGemma server you already run (enter its address)");
    out("    2) install one on this machine (downloads about 17-19 GB; needs an NVIDIA GPU with 22+ GB)");
    const picked = String((await ask("  Choose 1 or 2 (Enter cancels): ")) ?? "").trim();
    if (picked === "1") choice = "external";
    else if (picked === "2") choice = "install";
    else { out("  Setup cancelled."); return null; }
  }
  if (choice === "external") {
    const url = endpoint ?? String((await ask("  Server address (for example http://127.0.0.1:8001): ")) ?? "").trim();
    if (!url) { out("  Setup cancelled."); return null; }
    out(`  Checking ${url} …`);
    const probe = await probeEndpoint(url, { fetchImpl });
    if (!probe.structuredReads) { out(`  ✖ ${probe.problem}`); return null; }
    out(`  ✔ structured reads work (answer mass ${probe.labelMass.toFixed(3)})${probe.sleepMode ? "; sleep mode available (GPU swapping works)" : "; no sleep mode (GPU swapping with a local worker will not be available)"}`);
    saveExternal(probe.endpoint, { servedModel: probe.servedModel });
    out(`  Saved to ${jevConfigPath()}. BANTAM will use this server and never start or stop it.`);
    return loadJevConfig();
  }
  const prerequisites = await checkPrerequisites({ modelDir, runImpl });
  if (prerequisites.gpu) out(`  GPU: ${prerequisites.gpu.name}, ${Math.round(prerequisites.gpu.memoryMiB / 1024)} GB, compute capability ${prerequisites.gpu.computeCap}`);
  if (prerequisites.problems.length) {
    out("  This machine cannot run a local Jev engine yet:");
    for (const problem of prerequisites.problems) out(`    ✖ ${problem}`);
    out("  You can still use a DiffusionGemma server running elsewhere: bantamfactory jev setup --endpoint <url>");
    return null;
  }
  const plan = await installPlan({ prerequisites, image, modelDir, runImpl });
  out("  The install will:");
  for (const step of plan.steps) out(`    • ${step}`);
  if (!yes) {
    const agreed = String((await ask("  Proceed? [y/N] ")) ?? "").trim().toLowerCase();
    if (agreed !== "y" && agreed !== "yes") { out("  Nothing was downloaded or changed."); return null; }
  }
  await runInstall(plan, { onProgress: (line) => out(`    ${line}`), runImpl });
  out("  Installed. Start it with :jev on (or bantamfactory jev serve).");
  return loadJevConfig();
}
