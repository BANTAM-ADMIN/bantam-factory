// `bantam doctor` — guided setup. Applies BANTAM's own thesis to onboarding: the
// harness knows which link in the chain (Node, model server, registry) is broken;
// say it precisely, with the fix, and never leave the user at "unreachable".
//
// The check logic here is pure over an injectable `probes` object so every branch
// is unit-testable without a real server, GPU, or PATH. bin/bantam.js wires the
// real probes (detectEndpoint, nvidia-smi, which, gguf scan) and renders the report.

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const MIN_NODE_MAJOR = 20;

/** Major version from a `process.version`-style string ("v20.11.0" -> 20). */
export function nodeMajor(versionString) {
  const m = String(versionString ?? "").match(/v?(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Run the setup check chain. `probes` (all injectable):
 *   nodeVersion : string                     — process.version
 *   detectEndpoint : () => Promise<string|null>
 *   loadedModel : (endpoint) => Promise<string|null>
 *   whichLlama : () => string|null           — path to llama-server on PATH
 *   gpuInfo : () => { name, memMB } | null
 *   scanGgufs : () => string[]               — absolute .gguf paths found
 *   listModels : () => Array<{ name, label, script, endpoint }>
 *   sandboxProbe : () => { mode, image, dockerFound, imagePresent } | null
 *
 * Returns { ready, checks:[{name,status,detail,remedy?}], nextAction,
 *           scaffoldRecommended, detection }.
 */
export async function runChecks(probes) {
  const checks = [];
  const detection = {};

  // 1) Node version — reported, never aborts the rest.
  const major = nodeMajor(probes.nodeVersion);
  if (major >= MIN_NODE_MAJOR) {
    checks.push({ name: "node", status: "pass", detail: `${probes.nodeVersion} (>= ${MIN_NODE_MAJOR})` });
  } else {
    checks.push({
      name: "node", status: "warn",
      detail: `${probes.nodeVersion} (< ${MIN_NODE_MAJOR})`,
      remedy: `Upgrade Node to ${MIN_NODE_MAJOR}+ — earlier versions are unsupported.`,
    });
  }

  // 2) Shell sandbox. Checked BEFORE the endpoint short-circuit on purpose: a
  // reachable model says nothing about whether the agent can run a command, and
  // this link failed silently for everyone but its author. The sandbox runs
  // `docker run --pull never` — deliberately, so a model-chosen action can never
  // reach a registry — which means the base image must already be on the machine.
  // Without this check the first symptom is `exit 125: No such image` on every
  // shell action, long after `doctor` said "You're set".
  const sb = probes.sandboxProbe?.() ?? null;
  if (sb?.mode === "host") {
    checks.push({
      name: "sandbox", status: "warn",
      detail: "host mode (BANTAM_SHELL_SANDBOX=host) — no container isolation",
      remedy: "Shell actions run with your user's full reach. Unset BANTAM_SHELL_SANDBOX to restore the Docker sandbox.",
    });
  } else if (sb && !sb.dockerFound) {
    checks.push({
      name: "sandbox", status: "fail",
      detail: "docker not found — every shell action will fail",
      remedy: "Install Docker, or accept the loss of isolation with BANTAM_SHELL_SANDBOX=host.",
    });
  } else if (sb && !sb.imagePresent) {
    checks.push({
      name: "sandbox", status: "fail",
      detail: `sandbox image ${sb.image} is not present locally`,
      remedy: `Run \`docker pull ${sb.image}\`. The sandbox runs --pull never, so it cannot fetch this itself.`,
    });
  } else if (sb) {
    checks.push({ name: "sandbox", status: "pass", detail: `docker, image ${sb.image}` });
  }

  // 2) Model endpoint — the happy path short-circuits everything else.
  const endpoint = await probes.detectEndpoint();
  if (endpoint) {
    const model = await probes.loadedModel(endpoint).catch(() => null);
    checks.push({
      name: "endpoint", status: "pass",
      detail: `reachable at ${endpoint}${model ? ` — ${model}` : ""}`,
    });
    const sandboxBroken = checks.find((c) => c.name === "sandbox" && c.status === "fail");
    return {
      ready: !sandboxBroken, checks, detection, scaffoldRecommended: false,
      nextAction: sandboxBroken
        ? `The model is reachable, but shell actions cannot run: ${sandboxBroken.remedy}`
        : "You're set — run `bantam` in your project directory.",
    };
  }
  checks.push({
    name: "endpoint", status: "fail",
    detail: "no llama.cpp server answered /health on any candidate endpoint",
    remedy: "Start a model server (see below), or point at an existing OpenAI-compatible API with `bantam doctor --api-url http://host:port/v1`.",
  });

  // 3) Environment detection — best-effort, feeds the scaffold.
  detection.llama = probes.whichLlama();
  checks.push(detection.llama
    ? { name: "llama.cpp", status: "pass", detail: detection.llama }
    : { name: "llama.cpp", status: "warn", detail: "llama-server not found on PATH", remedy: "Run `bantam doctor --install-llama` to fetch a prebuilt one (no build)." });

  detection.gpu = probes.gpuInfo();
  checks.push(detection.gpu
    ? { name: "gpu", status: "pass", detail: `${detection.gpu.name}${detection.gpu.memMB ? ` (${Math.round(detection.gpu.memMB / 1024)}GB)` : ""}` }
    : { name: "gpu", status: "info", detail: "no NVIDIA GPU detected — CPU inference will be slow for a 27B model" });

  detection.ggufs = probes.scanGgufs() ?? [];
  checks.push(detection.ggufs.length
    ? { name: "model file", status: "pass", detail: `${detection.ggufs.length} .gguf found (e.g. ${detection.ggufs[0]})` }
    : { name: "model file", status: "warn", detail: "no .gguf model files found in the usual locations", remedy: "Download a GGUF (a Qwen 27B Q4 is a good default) and note its path." });

  // 4) Registry.
  const models = probes.listModels() ?? [];
  if (models.length) {
    checks.push({ name: "registry", status: "pass", detail: `${models.length} model(s) registered` });
    return {
      ready: false, checks, detection, scaffoldRecommended: false,
      nextAction: "A model is registered but no server is running — start it with `bantam doctor --launch`.",
    };
  }
  checks.push({
    name: "registry", status: "fail",
    detail: "no models registered (registry is empty)",
    remedy: "Scaffold one below, then start it.",
  });
  return {
    ready: false, checks, detection, scaffoldRecommended: true,
    nextAction: "Run `bantam doctor --launch` to scaffold .bantam/models.json + a start script and bring a server up.",
  };
}

/**
 * Build the llama-server start-script body from detection. Config goes into shell
 * variables with any `# TODO:` comment on its OWN line above — never trailing a
 * `\` continuation, which would break bash. scaffold() derives hasTodo from the
 * `# TODO:` markers; GPU/CPU notes are advisory comments, not blockers.
 */
export function buildStartScript(detection = {}) {
  const ggufs = detection.ggufs ?? [];
  const hasGpu = Boolean(detection.gpu);
  // With a model and a GPU, delegate to the CERTIFIED profile shipped in the
  // repo (scripts/launch-profiles/local-gguf.sh): the measured flags —
  // --parallel 1, ubatch 3072, checkpoint window, optional vision/MTP — with
  // their WHY comments. The inline fallback below stays for the TODO cases
  // (no model found yet / CPU-only), where a template a human edits is kinder
  // than a profile that exits.
  const profile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "launch-profiles", "local-gguf.sh");
  if (ggufs.length >= 1 && hasGpu && fs.existsSync(profile)) {
    return [
      "#!/usr/bin/env bash",
      "# Generated by `bantam doctor` — delegates to the certified launch profile",
      "# (measured flags + rationale live there; edit MODEL/PORT here).",
      "set -euo pipefail",
      ggufs.length > 1 ? `# NOTE: found ${ggufs.length} .gguf files — confirm MODEL is the one you want` : "",
      `export MODEL="${ggufs[0]}"`,
      detection.llama ? `export LLAMA_SERVER="${detection.llama}"` : "",
      `exec "${profile}" --port 8085 "$@"`,
      "",
    ].filter((l) => l !== "").join("\n");
  }
  const nGpuLayers = hasGpu ? 999 : 0;
  const lines = [
    "#!/usr/bin/env bash",
    "# Generated by `bantam doctor`. Resolve any TODO lines below, then run this",
    "# (or `bantam doctor --launch`). It must serve llama.cpp's HTTP API on port 8085.",
    "set -euo pipefail",
    "",
  ];
  if (detection.llama) {
    lines.push(`BIN="${detection.llama}"`);
  } else {
    lines.push("# TODO: install llama.cpp (github.com/ggml-org/llama.cpp) and set BIN to its llama-server");
    lines.push('BIN="llama-server"');
  }
  if (ggufs.length === 1) {
    lines.push(`MODEL="${ggufs[0]}"`);
  } else if (ggufs.length > 1) {
    lines.push(`# TODO: found ${ggufs.length} .gguf files — confirm MODEL points at the one you want`);
    lines.push(`MODEL="${ggufs[0]}"`);
  } else {
    lines.push("# TODO: set MODEL to the path of your GGUF model file");
    lines.push('MODEL="/path/to/your-model.gguf"');
  }
  lines.push("");
  lines.push(hasGpu
    ? "# --n-gpu-layers 999 offloads all layers; lower it if it won't fit your VRAM."
    : "# CPU-only (no GPU detected): --n-gpu-layers 0. A 27B model will be slow.");
  lines.push('exec "$BIN" \\');
  lines.push('  -m "$MODEL" \\');
  lines.push("  --host 127.0.0.1 \\");
  lines.push("  --port 8085 \\");
  lines.push(`  --n-gpu-layers ${nGpuLayers} \\`);
  lines.push("  --ctx-size 32768");
  lines.push("");
  return lines.join("\n");
}

/**
 * Write .bantam/models.json + start script into `dir`. Never overwrites an
 * existing models.json (returns { skipped:true } instead). Returns
 * { wrote:[paths], hasTodo, scriptPath, registryPath }.
 */
export function scaffold({ dir, detection = {}, label = "Local llama.cpp model" }) {
  const bantamDir = path.join(dir, ".bantam");
  const registryPath = path.join(bantamDir, "models.json");
  const scriptPath = path.join(bantamDir, "start-local.sh");
  if (fs.existsSync(registryPath)) {
    return { skipped: true, reason: "models.json already exists", registryPath, wrote: [] };
  }
  fs.mkdirSync(bantamDir, { recursive: true });
  const body = buildStartScript(detection);
  const hasTodo = /# TODO/.test(body);
  fs.writeFileSync(scriptPath, body);
  fs.chmodSync(scriptPath, 0o755);
  // `name` is the handle `bantam swap <name>` and `:model <name>` resolve on;
  // `label` is the prose the pickers show. Scaffolding only the label left a
  // fresh machine with a model it could see but not name.
  const registry = [{
    name: "local",
    label,
    script: scriptPath,
    endpoint: "http://localhost:8085",
    match: "",
  }];
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return { skipped: false, wrote: [registryPath, scriptPath], hasTodo, scriptPath, registryPath };
}

const GLYPH = { pass: "✔", fail: "✖", warn: "⚠", info: "•" };

/** Render a report to a plain-text checklist (returned as a string). */
export function renderReport(report) {
  const lines = [];
  for (const c of report.checks) {
    lines.push(`${GLYPH[c.status] ?? " "} ${c.name}: ${c.detail}`);
    if (c.remedy && c.status !== "pass") lines.push(`    ${c.remedy}`);
  }
  lines.push("");
  lines.push(`→ Next: ${report.nextAction}`);
  return lines.join("\n");
}
