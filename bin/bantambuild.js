#!/usr/bin/env -S node
// BANTAMBUILD CLI — self-contained local-model coding agent harness.
//
//   bantambuild run --task "..." [--workspace .] [--max-turns 30] [--verify "npm test"]
//   bantambuild eval [fixtureDir ...]      run repair fixtures with hidden verification
//   bantambuild health                     check the local model endpoint
//   bantambuild strut [anim]               let the rooster loose (idle·peck·flap·crow·walk·all)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { repoRootFromCli } from "../src/repo-root.js";
import { runAgent } from "../src/agent.js";
import { ModelClient, detectEndpoint } from "../src/model.js";
import { startBantamServer, lanAddresses } from "../src/server.js";
import { buildGrounding } from "../src/logic/grounding.js";
import { randomBytes } from "node:crypto";
import { offerToLaunchModel, modelStatus, switchToModel, endpointHasVision, firstVisionModel, listModels } from "../src/model-launcher.js";
import { execFileSync } from "node:child_process";
import { runChecks, scaffold, renderReport } from "../src/doctor.js";
import { planProvision, downloadResumable, freeDiskBytes, modelsDir, formatBytes, renderProgress, DEFAULT_QUANT } from "../src/provision.js";
import { detectVerifier } from "../src/verifier-detect.js";
import { pickLlamaAsset, findReleaseAsset, findLlamaServer, extractArchive, llamaInstallRoot, RELEASES_LATEST_API } from "../src/llama-install.js";
import { loadApiConfig, saveApiConfig } from "../src/openai-transport.js";
import {
  modelUsageBreakdownDelta,
  modelUsageBreakdownSnapshot,
  modelUsageDelta,
  modelUsageSnapshot,
} from "../src/model-usage-snapshot.js";
import { playAnimation, animationNames, loadAnimations, showcaseSequence } from "../src/rooster.js";
import {
  buildArtifact,
  fetchModelId,
  makeRunId,
  makeStamp,
  saveArtifact,
} from "../src/artifact.js";
import { RunCheckpoint, attachModelRequestCheckpoint } from "../src/run-checkpoint.js";
import { captureHarnessState, emptyHarnessState } from "../src/harness-state.js";
import { snapshotTree, checkWorkspace } from "../src/scope-guard.js";
import { normalizeThinkMode } from "../src/thinking.js";
import { formatQueryAction } from "../src/action-display.js";
import { ensureSeededLibrary, loadLibrary } from "../src/skills.js";
import { backfillFromExperiments, backfillFromLedger, defaultFactsPath, defaultRunEvidenceLog, evidenceView } from "../src/logic/run-evidence.js";
import { BantamTUI } from "../src/tui.js";
import { formatEvalSummary } from "../src/reporting.js";
import { addBenchRun, emptyBenchTotals, formatBenchRow } from "../src/bench-report.js";
import { analyzeEvidenceRows, defaultEvidencePaths, formatEvidenceAnalysis, loadEvidenceRows } from "../src/evidence-analysis.js";
import { resolveFixtureRepoSource, runFixture } from "../src/fixture-runner.js";
import {
  buildExperimentSchedule,
  createExperimentManifest,
  formatExperimentSummary,
  normalizeExperimentSpec,
} from "../src/experiment.js";
import { runExperiment } from "../src/experiment-runner.js";
import { modelOptionsForGauntletArm } from "../src/gauntlet.js";
import { readPinnedExperimentBinding } from "../src/pinned-experiment-binding.js";
import { classifyInteractiveResult, verificationDetailLines } from "../src/interactive-verdict.js";
import { emitAboveInput, redrawInput } from "../src/interactive-display.js";
import { isStateCommand, resolveStateHome, runStateCommand } from "../src/state-cli.js";
import { LaneRunBridge } from "../src/lane-run.js";
import {
  mergeContinuationResult,
  prepareRunContinuation,
  sha256,
} from "../src/run-continuation.js";
import { parseArgs } from "../src/cli-args.js";

const cliArgs = process.argv.slice(2);
const args = parseArgs(cliArgs);
// A saved OpenAI-API config (`bantambuild doctor --api-url …`) is the persistent
// fallback for cliModelOptions when no --api-url flag/env is given.
const savedApi = loadApiConfig();
const cmd = args._[0];
if (args["shell-network"] === true) process.env.BANTAM_SHELL_NETWORK = "1";

// State inspection, channel promotion, and lane rewind are local storage
// operations. They must work while the model server is down and must never
// trigger endpoint detection, health probes, skill seeding, or a prompt.
if (isStateCommand(cmd)) {
  process.exit(await runStateCommand(process.argv.slice(2)));
}
if (cmd === "audit-replay") {
  await auditReplayCommand();
}
if (cmd === "replay-ab") {
  await replayAbCommand();
}
if (cmd === "replay-mine") {
  await replayMineCommand();
}
if (cmd === "experiment") {
  try {
    process.exit(await runExperimentCommand(args._[1]));
  } catch (error) {
    process.stderr.write(`experiment failed: ${error.message}\n`);
    process.exit(1);
  }
}
// Keep the install/package entrypoint feature-equivalent with the development
// launcher without maintaining second copies of comparison orchestrators.
if (cmd === "gauntlet" || cmd === "trio" || cmd === "audit-codex" || cmd === "audit-run" || cmd === "hypothesize") {
  try {
    execFileSync(process.execPath, [path.join(repoRootFromCli(import.meta.url), "bin", "bantam.js"), ...cliArgs], {
      stdio: "inherit",
      env: process.env,
    });
    process.exit(0);
  } catch (error) {
    process.exit(Number.isInteger(error?.status) ? error.status : 1);
  }
}

// Headless entrypoints short-circuit before terminal decoration, skill setup,
// endpoint probing, model launch offers, or the interactive REPL.
if (cmd === "exec") {
  if (args.help) {
    console.log(`Usage: bantambuild exec [options] "<task text>"

Headless print mode — runs a task without a REPL, suitable for scripts.

Options:
  --workspace <dir>   workspace directory (default: current directory)
  --verify "<cmd>"    verification command to run after the task completes
  --max-turns <n>     maximum agent turns (default: 30)
  --endpoint <url>    model server endpoint
  --json              output one JSON object per line (progress + final result)
  --help              show this help

Exit codes:
  0  task completed and verification passed (or no verifier)
  1  task failed, hit turn limit, or finished unverified
  2  usage error (e.g. missing task text)
  3  model server could not be reached`);
    process.exit(0);
  }
  await execCommand();
}
if (cmd === undefined && args.help) {
  console.log(usage());
  process.exit(0);
}

// Only emit ANSI styling to a real terminal (respect NO_COLOR); pipes/logs get clean text.
const USE_COLOR = !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === "1");
const paint = (code, s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
// The rooster's little antics — mood labels while it works, a micro-crow when a request lands.
// Easy to toggle: BANTAM_NO_ROOSTER=1, the --rooster / --no-rooster flags, or `:rooster` in the REPL.
let roosterOn = !process.env.BANTAM_NO_ROOSTER;
if (args["no-rooster"]) roosterOn = false;
if (args.rooster) roosterOn = true;

// Palette — a bantam is a small, scrappy rooster: coral comb, golden plume, teal beak.
const C = {
  comb: "38;2;232;85;63", plume: "38;2;224;168;60", beak: "38;2;90;200;210",
  paper: "38;2;225;223;216", dim: "38;2;120;122;132", rule: "38;2;70;72;82",
  good: "38;2;90;200;120", bad: "38;2;229;86;75",
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const TERMINAL_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const safeShellOutput = (s) => String(s)
  .replace(TERMINAL_ESCAPE_RE, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const EDIT_VERBS = new Set(["write_file", "replace", "patch", "delete_file", "move_file"]);

// The opening rooster: the full-color pixel bantam struts on in, then scrolls off as work begins.
// Truecolor art on a real terminal; a small text rooster stands in when color is off or piped.
const BANNER_ART = new URL("../assets/bantam-banner.ans", import.meta.url);
function ansiBannerArt() {
  try { return fs.readFileSync(BANNER_ART, "utf8").replace(/[\s﻿]+$/, ""); }
  catch { return null; }
}

function renderBanner({ profileName, workspace, verify, tty }) {
  const home = process.env.HOME || "";
  const dir = home && workspace.startsWith(home) ? "~" + workspace.slice(home.length) : workspace;
  const verifyBit = verify ? paint(C.dim, "verify ") + paint(C.beak, verify) : paint(C.dim, "no verifier");
  const status = "  " + paint(C.dim, "model ") + paint(C.paper, profileName) + paint(C.dim, "  ·  ")
    + paint(C.paper, dir) + paint(C.dim, "  ·  ") + verifyBit;
  const help = "  " + paint(C.dim, tty
    ? "type a request · steer mid-run · :help for commands · Ctrl-C to stop · exit"
    : 'type a request, or "exit"');

  // The full pixel rooster (art already carries the BANTAM wordmark + tagline). Opt out with
  // BANTAM_ASCII_BANNER=1 for a lean text banner; the art is skipped without color anyway.
  const art = tty && USE_COLOR && !process.env.BANTAM_ASCII_BANNER ? ansiBannerArt() : null;
  if (art) return ["", art + "\x1b[0m", "", status, help, ""].join("\n");

  // Fallback text rooster.
  const rooster = [
    paint(C.comb, "   ▲▲") + paint(C.plume, "__"),
    paint(C.paper, "  ( ") + paint(C.beak, "o") + paint(C.plume, "›") + paint(C.paper, "  )"),
    paint(C.paper, "   \\__/") + paint(C.plume, "/"),
    paint(C.dim, "    ^ ^"),
  ];
  const right = ["", paint(`1;${C.plume}`, "bantam"), paint(C.dim, "grammar-constrained · local · verified"), ""];
  const out = [""];
  for (let i = 0; i < 4; i++) {
    const pad = Math.max(0, 13 - stripAnsi(rooster[i]).length);
    out.push(rooster[i] + " ".repeat(pad) + (right[i] || ""));
  }
  out.push(paint(C.rule, "  " + "─".repeat(52)));
  out.push(status);
  out.push(help);
  out.push("");
  return out.join("\n");
}

// `bantam strut [anim]` — play the rooster animations (idle · peck · flap · crow · walk, or `all`).
// With no terminal it prints the rooster art once instead; Ctrl-C stops a loop.
async function strutCommand() {
  const set = args.micro ? "micro" : "full";
  const names = animationNames(set);
  if (!names.length) { process.stderr.write("No rooster animations found (assets/bantam-frames.json missing).\n"); return; }
  if (args.list) {
    const data = loadAnimations(set) || {};
    for (const n of names) process.stdout.write(`  ${n.padEnd(6)} ${data[n].frames.length} frames @ ${data[n].fps}fps\n`);
    process.stdout.write("  all    every animation, twice\n");
    return;
  }
  if (!process.stdout.isTTY || !USE_COLOR) {          // no live cursor control — just show the rooster
    const art = ansiBannerArt();
    process.stdout.write(art ? `\n${art}\x1b[0m\n` : "A truecolor terminal is needed to strut.\n");
    return;
  }
  const which = args._[1];
  let seq, defaultLoops;
  if (!which) { seq = showcaseSequence(); defaultLoops = 1; }
  else if (which === "all") { seq = names.map((n) => [n, 2]); defaultLoops = 1; }
  else if (names.includes(which)) { seq = [[which, 1]]; defaultLoops = 0; }   // one animation loops until Ctrl-C
  else { process.stdout.write(`unknown animation '${which}'. options: ${names.join(", ")} (or 'all')\n`); return; }

  const loops = args.loops !== undefined ? Math.max(0, Number(args.loops) || 0) : defaultLoops;
  const fps = args.fps ? Number(args.fps) : 0;
  const ctrl = new AbortController();
  const onSig = () => ctrl.abort();
  process.on("SIGINT", onSig);
  try { await playAnimation(seq, { loops, fps, set, signal: ctrl.signal }); }
  finally { process.off("SIGINT", onSig); }
}

// --think auto|always|off. CLI defaults to auto because live hard-tier sweeps show
// cheap repair loops can stall without a reasoning phase; library callers can still
// keep runAgent's fast default by passing thinkMode: "off".
const thinkMode = normalizeThinkMode(args.think === undefined || args.think === true ? "auto" : args.think);

// Skills are explicit. The accumulated library is useful experimental knowledge, but
// naive retrieval on every turn injected unrelated and sometimes contradictory advice
// into self-hosting runs. Enable it deliberately with --skills [path] or BANTAM_SKILLS=1;
// --no-skills / BANTAM_NO_SKILLS=1 always wins.
const skillsRequested = args.skills === true || typeof args.skills === "string"
  || /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_SKILLS ?? ""));
const skillsOff = !skillsRequested || args["no-skills"]
  || /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_NO_SKILLS ?? ""));
const skillsLib = skillsOff
  ? null
  : (typeof args.skills === "string" ? path.resolve(args.skills) : defaultSkillsPath());
// Auto-seed applies ONLY to the default library (the zero-setup path). An explicitly
// passed --skills <path> is the user's own library; never inject lessons into it.
if (skillsLib && skillsLib === defaultSkillsPath()) {
  ensureSeededLibrary(skillsLib, path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "examples", "fable-lessons.jsonl"));
}
const skillsCfg = skillsLib ? { library: skillsLib, retrieve: true, distill: true, language: args.lang || null } : null;

// --plan authors a workflow plan up front and keeps it pinned in context.
const planMode = Boolean(args.plan);

// `bantam strut` — let the rooster loose. Pure terminal art, no model needed, so it short-circuits
// before the model client is even built.
if (cmd === "strut" || cmd === "roost") {
  await strutCommand();
  process.exit(0);
}

// `bantam doctor` — guided setup. Runs before the model client is built (like
// strut) so it can diagnose a missing server instead of tripping the launch
// prompt. Real probes wired here; the logic lives in src/doctor.js.
if (cmd === "doctor" || cmd === "setup") {
  const isHealthy = async (ep) => {
    try { return (await fetch(`${ep}/health`, { signal: AbortSignal.timeout(1500) })).ok; }
    catch { return false; }
  };
  const whichLlama = () => {
    for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
      const p = path.join(dir, "llama-server");
      try { if (fs.existsSync(p) && (fs.statSync(p).mode & 0o111)) return p; } catch { /* keep looking */ }
    }
    return findLlamaServer(llamaInstallRoot()); // a previously fetched prebuilt
  };
  const gpuInfo = () => {
    try {
      const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 3000 });
      const [name, mem] = (out.trim().split("\n")[0] || "").split(",").map((s) => s.trim());
      return name ? { name, memMB: Number(mem) || null } : null;
    } catch { return null; }
  };
  const scanGgufs = () => {
    const roots = [path.join(os.homedir(), "models"), path.join(os.homedir(), ".cache", "huggingface"),
      path.join(process.cwd(), "models"), process.env.BANTAM_MODELS_DIR].filter(Boolean);
    const found = [];
    const walk = (dir, depth) => {
      if (depth < 0 || found.length >= 5) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found.length >= 5) return;
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith(".gguf")) found.push(full);
        else if (e.isDirectory() && !e.name.startsWith(".") ) walk(full, depth - 1);
      }
    };
    for (const r of roots) walk(r, 3);
    return found;
  };
  // `--api-url`: register an existing OpenAI-compatible server (llama.cpp /v1,
  // vLLM, LM Studio, …). Validate it (health + a grammar probe), then persist it
  // so plain `bantam` uses it. This is "enter the API" made durable.
  if (typeof args["api-url"] === "string") {
    const apiUrl = String(args["api-url"]).replace(/\/$/, "");
    const apiKey = typeof args["api-key"] === "string" ? args["api-key"] : undefined;
    const modelName = typeof args.model === "string" ? args.model : "local";
    const dialect = typeof args["api-dialect"] === "string" ? args["api-dialect"] : undefined;
    const client = new ModelClient({ apiUrl, apiKey, model: modelName, apiDialect: dialect });
    process.stderr.write(`\nChecking OpenAI-compatible API at ${apiUrl} …\n`);
    const healthy = await client.health();
    process.stderr.write(healthy ? "  ✔ reachable (GET /v1/models)\n" : "  ✖ /v1/models did not answer — check the URL/key.\n");
    let grammarOk = null;
    if (healthy) {
      try {
        const out = await client.complete("Reply with anything.\nAnswer:", { grammar: 'root ::= "OKBANTAM"', nPredict: 6 });
        grammarOk = String(out.content).trim() === "OKBANTAM";
      } catch { grammarOk = false; }
      process.stderr.write(grammarOk
        ? "  ✔ grammar honored — the action grammar will constrain generation (reliable)\n"
        : "  ✖ grammar NOT honored — this server ignores GBNF. BANTAM constrains EVERY action\n"
          + "     with a grammar; without it the model emits malformed actions and BANTAM will\n"
          + "     NOT run properly. Use llama.cpp or vLLM (try --api-dialect vllm), not a base\n"
          + "     OpenAI endpoint. Saving anyway, but expect it to fail until grammar works.\n");
    }
    if (!healthy) process.exit(1);
    const saved = saveApiConfig(process.cwd(), { apiUrl, apiKey, model: modelName, dialect: dialect ?? "llamacpp", grammar: grammarOk });
    process.stderr.write(`\n✔ Saved to ${saved}\n  → Run \`bantam\` here and it will use this API. Override any time with --api-url / --endpoint.\n`);
    process.exit(0);
  }

  // Shared setup helpers. Each ensure* step RETURNS a result instead of exiting,
  // so the single `--setup` can chain them the same way the individual flags run.
  const setupTty = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const confirmYN = async (q, def) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans = await new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
    return def ? !/^n(o)?$/i.test(ans.trim()) : /^y(es)?$/i.test(ans.trim());
  };
  const downloadWithProgress = async (url, dest) => {
    let lastPaint = 0;
    await downloadResumable({ url, dest, onProgress: ({ received, total, elapsedMs }) => {
      const t = Date.now(); if (t - lastPaint < 500) return; lastPaint = t;
      const line = renderProgress({ received, total, elapsedMs });
      process.stderr.write(setupTty ? `\r${line}          ` : `${line}\n`);
    } });
    if (setupTty) process.stderr.write("\n");
  };

  // Fetch a prebuilt llama-server (no build). Vulkan is the universal GPU build
  // (NVIDIA via the driver's Vulkan ICD, and AMD); macOS is Metal-native; no Linux
  // CUDA prebuilt. Returns { ok, server, skipped }.
  async function ensureLlama({ autoYes }) {
    const existing = whichLlama();
    if (existing) return { ok: true, server: existing, skipped: true };
    const platform = os.platform(); const arch = os.arch();
    const pick = pickLlamaAsset({ platform, arch, hasGpu: Boolean(gpuInfo()), forceVulkan: Boolean(args.vulkan) });
    if (!pick) { process.stderr.write(`\n✖ No prebuilt llama.cpp for ${platform}/${arch}. Build from source: https://github.com/ggml-org/llama.cpp\n`); return { ok: false }; }
    const kind = /vulkan|macos/.test(pick.platformTag) ? "GPU" : "CPU";
    process.stderr.write(`\nFetching prebuilt llama-server for ${platform}/${arch} (${pick.platformTag}, ${kind}) …\n`);
    let rel;
    try { rel = await (await fetch(RELEASES_LATEST_API, { headers: { "User-Agent": "bantam-doctor" } })).json(); }
    catch (e) { process.stderr.write(`\n✖ Couldn't reach the GitHub release API: ${e.message}\n`); return { ok: false }; }
    const asset = findReleaseAsset(rel, pick.platformTag, pick.ext);
    if (!asset) { process.stderr.write(`\n✖ Release ${rel.tag_name} has no ${pick.platformTag} asset — install manually.\n`); return { ok: false }; }
    const root = llamaInstallRoot();
    const archive = path.join(root, asset.name);
    process.stderr.write(`  ${asset.name}  (~${formatBytes(asset.size)}, ${rel.tag_name})\n  into ${root}\n`);
    if (!autoYes) {
      if (!setupTty) { process.stderr.write(`\nRe-run with --yes to download ~${formatBytes(asset.size)} non-interactively.\n`); return { ok: false }; }
      if (!(await confirmYN(`\nDownload now? [Y/n] `, true))) { process.stderr.write("Aborted.\n"); return { ok: false }; }
    }
    fs.mkdirSync(root, { recursive: true });
    try { await downloadWithProgress(asset.url, archive); } catch (e) { process.stderr.write(`\n✖ ${e.message}\n`); return { ok: false }; }
    const outDir = path.join(root, `bin-${rel.tag_name}`);
    process.stderr.write("  extracting …\n");
    try { extractArchive({ archive, dest: outDir, run: (c, a) => execFileSync(c, a) }); }
    catch (e) { process.stderr.write(`\n✖ extract failed: ${e.message}\n`); return { ok: false }; }
    const server = findLlamaServer(outDir);
    if (!server) { process.stderr.write("\n✖ llama-server not found inside the archive.\n"); return { ok: false }; }
    try { execFileSync(server, ["--version"], { stdio: "ignore" }); }
    catch (e) {
      process.stderr.write(`\n⚠ Installed ${server} but \`llama-server --version\` failed: ${String(e.stderr || e.message).split("\n")[0]}\n`);
      if (kind === "GPU") process.stderr.write("  A Vulkan build needs the Vulkan loader — on Linux it ships with your GPU driver.\n");
      return { ok: false };
    }
    try { fs.rmSync(archive, { force: true }); } catch { /* keep the extracted tree regardless */ }
    process.stderr.write(`\n✔ llama-server installed: ${server}\n`);
    return { ok: true, server };
  }

  // Download the model (default the 4-bit) from Hugging Face. Returns { ok, dest, skipped }.
  async function ensureModel({ autoYes }) {
    const dir = modelsDir();
    const quant = typeof args.quant === "string" ? args.quant : DEFAULT_QUANT;
    const ggufUrl = typeof args["gguf-url"] === "string" ? args["gguf-url"] : null;
    const free = freeDiskBytes(dir);
    const plan = planProvision({ dir, quant, ggufUrl, freeBytes: free });
    if (fs.existsSync(plan.dest)) { process.stderr.write(`\n✔ Model already present: ${plan.dest}\n`); return { ok: true, dest: plan.dest, skipped: true }; }
    process.stderr.write(`\nProvision plan:\n  model: ${plan.file}\n  from:  ${plan.url}\n  to:    ${plan.dest}\n  size:  ~${formatBytes(plan.expectedBytes)}    free disk: ${free == null ? "?" : formatBytes(free)}\n`);
    if (plan.enoughDisk === false) { process.stderr.write(`\n✖ Not enough disk: need ~${formatBytes(plan.needBytes)}, have ${formatBytes(free)}. Free space, or set BANTAM_MODELS_DIR to a bigger volume.\n`); return { ok: false }; }
    const gpu = gpuInfo();
    if (gpu?.memMB && plan.expectedBytes && gpu.memMB * 1024 * 1024 < plan.expectedBytes) {
      process.stderr.write(`\n⚠ GPU has ${Math.round(gpu.memMB / 1024)}GB VRAM; ${quant} weights are ~${formatBytes(plan.expectedBytes)}. It still runs with CPU offload (slower), or use \`--quant Q3_K_M\` for a smaller one.\n`);
    }
    if (!autoYes) {
      if (!setupTty) { process.stderr.write(`\nRe-run with --yes to download ~${formatBytes(plan.expectedBytes)} non-interactively.\n`); return { ok: false }; }
      if (!(await confirmYN(`\nDownload ~${formatBytes(plan.expectedBytes)} now? [y/N] `, false))) { process.stderr.write("Aborted.\n"); return { ok: false }; }
    }
    process.stderr.write("\nDownloading (resumable — Ctrl-C is safe, re-run to continue):\n");
    try { await downloadWithProgress(plan.url, plan.dest); } catch (e) { process.stderr.write(`\n✖ ${e.message}\n`); return { ok: false }; }
    process.stderr.write(`\n✔ Downloaded ${plan.file}\n`);
    return { ok: true, dest: plan.dest };
  }

  if (args["install-llama"]) {
    const r = await ensureLlama({ autoYes: Boolean(args.yes) });
    if (r.ok) process.stderr.write(r.skipped
      ? `\n✔ llama-server already available: ${r.server}\n`
      : `  → \`bantam doctor --provision\` (if you still need the model), then \`bantam doctor --launch\`.\n`);
    process.exit(r.ok ? 0 : 1);
  }

  if (args.provision) {
    const r = await ensureModel({ autoYes: Boolean(args.yes) });
    if (r.ok) {
      const s = scaffold({ dir: process.cwd(), detection: { ggufs: [r.dest], llama: whichLlama(), gpu: gpuInfo() } });
      if (s.skipped) process.stderr.write(`  A registry already exists at ${s.registryPath} — point its start script at ${r.dest} if needed.\n`);
      else process.stderr.write(`  Wrote ${s.wrote.join(", ")}\n  → Run \`bantam doctor --launch\` to start it.\n`);
    }
    process.exit(r.ok ? 0 : 1);
  }

  // `--setup`: the whole on-ramp in one command — diagnose, then (only what's
  // missing) fetch llama-server, download the model, scaffold, and launch.
  if (args.setup || cmd === "setup") {
    const detect = async () => { const ep = await detectEndpoint({ endpoint: args.endpoint }); return (await isHealthy(ep)) ? ep : null; };
    const report = await runChecks({ nodeVersion: process.version, detectEndpoint: detect, loadedModel: (ep) => fetchModelId(ep, 2500).catch(() => null), whichLlama, gpuInfo, scanGgufs, listModels });
    process.stderr.write(`\n${renderReport(report)}\n`);
    if (report.ready) { process.stderr.write("\n✔ Already set up — run `bantam` in your project.\n"); process.exit(0); }
    // Shortest path to a running server: if a model is already registered, just
    // start it — don't re-download. Only a truly empty setup fetches everything.
    if ((listModels() || []).length) {
      process.stderr.write("\nA model is already registered — starting it …\n");
      const started = await offerToLaunchModel({ interactive: setupTty });
      if (started) {
        const id = await fetchModelId(started, 3000).catch(() => null);
        process.stderr.write(`\n✔ All set — server up at ${started}${id ? ` — ${id}` : ""}. Run \`bantam\` in your project.\n`);
        process.exit(0);
      }
      process.stderr.write("  (couldn't start the registered model — falling through to a fresh setup)\n");
    }
    const autoYes = Boolean(args.yes);
    const li = await ensureLlama({ autoYes });
    if (!li.ok) process.exit(1);
    const pm = await ensureModel({ autoYes });
    if (!pm.ok) process.exit(1);
    const s = scaffold({ dir: process.cwd(), detection: { ggufs: [pm.dest], llama: li.server, gpu: gpuInfo() } });
    if (!s.skipped) process.stderr.write(`\n  Wrote ${s.wrote.join(", ")}\n`);
    process.stderr.write("\nStarting the server …\n");
    const started = await offerToLaunchModel({ interactive: setupTty });
    if (started) {
      const id = await fetchModelId(started, 3000).catch(() => null);
      process.stderr.write(`\n✔ All set — server up at ${started}${id ? ` — ${id}` : ""}. Run \`bantam\` in your project.\n`);
      process.exit(0);
    }
    process.stderr.write("\n✔ Downloaded and scaffolded. Start the server with `bantam doctor --launch`, then run `bantam`.\n");
    process.exit(0);
  }

  const report = await runChecks({
    nodeVersion: process.version,
    detectEndpoint: async () => { const ep = await detectEndpoint({ endpoint: args.endpoint }); return (await isHealthy(ep)) ? ep : null; },
    loadedModel: (ep) => fetchModelId(ep, 2500).catch(() => null),
    whichLlama, gpuInfo, scanGgufs, listModels,
  });
  if (args.json) { console.log(JSON.stringify({ ready: report.ready, checks: report.checks, nextAction: report.nextAction }, null, 2)); process.exit(0); }
  process.stderr.write(`\n${renderReport(report)}\n`);
  if (report.ready) process.exit(0);

  let scaffolded = null;
  if (report.scaffoldRecommended) {
    scaffolded = scaffold({ dir: process.cwd(), detection: report.detection });
    if (scaffolded.skipped) {
      process.stderr.write(`\n  A registry exists at ${scaffolded.registryPath} but its start scripts are missing — fix the paths there, then \`bantam doctor --launch\`.\n`);
    } else {
      process.stderr.write(`\n  Wrote:\n    ${scaffolded.wrote.join("\n    ")}\n`);
      process.stderr.write(scaffolded.hasTodo
        ? `  → Fill in the TODO line(s) in ${scaffolded.scriptPath}, then run \`bantam doctor --launch\`.\n`
        : `  → Run \`bantam doctor --launch\` to start it.\n`);
    }
  }
  if (args.launch) {
    if (scaffolded && !scaffolded.skipped && scaffolded.hasTodo) {
      process.stderr.write("\n  Can't launch yet — fill in the TODO line(s) in the start script first.\n");
      process.exit(1);
    }
    const started = await offerToLaunchModel({ interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY) });
    if (started) {
      const id = await fetchModelId(started, 3000).catch(() => null);
      process.stderr.write(`\n✔ Server up at ${started}${id ? ` — ${id}` : ""}. Run \`bantam\` in your project.\n`);
      process.exit(0);
    }
    process.stderr.write("\n  No server was started. Check the start script (or run it by hand) and try again.\n");
    process.exit(1);
  }
  process.exit(0);
}

const modelOptions = cliModelOptions();
const usingApi = Boolean(modelOptions.apiUrl || process.env.BANTAM_API_URL);
// No explicit endpoint? Pick whichever llama.cpp server is actually up (e.g. 27B on :8085 vs 35B on
// :18086). Explicit --endpoint / BANTAM_ENDPOINT skips detection; an OpenAI --api-url skips it too.
if (!modelOptions.endpoint && !usingApi) modelOptions.endpoint = await detectEndpoint();
let model = new ModelClient(modelOptions);
// Nothing actually running? Offer to fire up a server from a known startup script (interactive only,
// and it asks first). `health` stays a pure check — it never prompts. With an OpenAI API there is
// nothing local to launch — a failed health check just surfaces the usual clear error downstream.
if (cmd !== "health" && cmd !== "setup" && !usingApi && !(await model.health())) {
  const started = await offerToLaunchModel({ interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY) });
  if (started) { modelOptions.endpoint = started; model = new ModelClient(modelOptions); }
}
// Ask the server which model is actually loaded, so switching servers (27B <-> 35B) is reflected in
// the startup line, the TUI label, and the run artifact — not a hardcoded name.
const activeModelId = usingApi ? model.modelName : await fetchModelId(model.endpoint, 2500).catch(() => null);
// Always announce — ESPECIALLY with an explicit --endpoint, where what's actually serving is the
// question. A swapped GGUF on the same port makes eval numbers incomparable across sessions; this
// line (plus the eval summary header) is what makes that visible.
process.stderr.write(`model: ${activeModelId || "unknown"} @ ${usingApi ? model.apiUrl + " (openai)" : model.endpoint}\n`);
// Grammar is not optional for BANTAM — the action grammar is what keeps a small
// model emitting valid actions. A base OpenAI endpoint that ignores GBNF will
// produce malformed actions, so probe once and warn LOUDLY. (Skip if doctor
// already confirmed it, or the operator opts out with BANTAM_SKIP_GRAMMAR_CHECK.)
if (usingApi && savedApi?.grammar !== true && !envTruthy("BANTAM_SKIP_GRAMMAR_CHECK")) {
  let honored = false;
  try {
    const probe = await model.complete("Reply with anything.\nAnswer:", { grammar: 'root ::= "OKBANTAM"', nPredict: 6 });
    honored = String(probe.content).trim() === "OKBANTAM";
  } catch { honored = false; }
  if (!honored) {
    process.stderr.write(
      "\n⚠  WARNING: this API does NOT honor GBNF grammar.\n"
      + "   BANTAM constrains every action with a grammar; without it the model emits\n"
      + "   malformed actions and BANTAM will NOT run properly. Point at a llama.cpp or\n"
      + "   vLLM server (or add --api-dialect vllm) instead of a base OpenAI endpoint.\n\n");
  }
}
if (envTruthy("BANTAM_SHELL_NETWORK")) {
  process.stderr.write("shell + preview network: enabled by operator opt-in (trusted model/workspace only)\n");
}

function liveLogger(e) {
  if (e.type === "action") process.stderr.write(`  → ${JSON.stringify(e.action)}\n`);
  else if (e.type === "invalid") {
    if (e.kind === "output_limit") {
      process.stderr.write(`  ✗ output limit${e.target ? ` while writing ${e.target}` : ""}: split the action\n`);
    } else {
      process.stderr.write(`  ✗ invalid: ${e.error}\n`);
    }
  }
  else if (e.type === "observation") {
    const first = e.observation.split("\n")[0].slice(0, 100);
    process.stderr.write(`    ${first}\n`);
  } else if (e.type === "thinking") {
    const first = e.text.split("\n").find((l) => l.trim()) || e.text;
    process.stderr.write(`  🤔 ${first.slice(0, 100)}${first.length > 100 ? "…" : ""}\n`);
  } else if (e.type === "skills_used") {
    process.stderr.write(`  📚 using ${e.skills.length} skill(s): ${e.skills.join("; ")}\n`);
  } else if (e.type === "skill_learned") {
    process.stderr.write(`  ✨ learned skill: ${e.skill}\n`);
  } else if (e.type === "plan_made") {
    process.stderr.write(`  🗺  plan: ${e.plan.goal}\n`);
    e.plan.steps.forEach((s, i) => process.stderr.write(`     ${i + 1}. ${s}\n`));
  } else if (e.type === "plan_revised") {
    process.stderr.write(`  🔄 revised plan: ${e.plan.goal}\n`);
    e.plan.steps.forEach((s, i) => process.stderr.write(`     ${i + 1}. ${s}\n`));
  } else if (e.type === "pregate_fail") {
    process.stderr.write(`  🚫 pre-gate: ${e.path} has a syntax error (fed back immediately)\n`);
  } else if (e.type === "protocol_violation") {
    process.stderr.write(`  ⚠ protocol: salvaged JSON from non-strict output\n`);
  } else if (e.type === "repeated_failure") {
    process.stderr.write(`  ⟳ repeated failure: diagnostic fed back\n`);
  } else if (e.type === "progress_nudge") {
    process.stderr.write(`  ⏱ progress nudge after ${e.progresslessTurns} progressless turn(s)\n`);
  } else if (e.type === "progress_gate") {
    process.stderr.write(`  ⛔ progress gate: ${e.action.a} rejected after ${e.progresslessTurns} progressless turn(s)\n`);
  } else if (e.type === "progress_gate_terminated") {
    process.stderr.write(`  ⛔ progress gate terminated run after ${e.consecutiveProgressGateRejections} consecutive rejection(s)\n`);
  } else if (e.type === "artifact_verification_nudge") {
    process.stderr.write(`  ⏱ artifact check requested after draft output\n`);
  } else if (e.type === "artifact_verification_gate") {
    process.stderr.write(`  ⛔ artifact check gate: ${e.action.a} rejected after ${e.turnsSinceArtifact} unverified turn(s)\n`);
  } else if (e.type === "image_generation_started") {
    process.stderr.write(`  ◌ image generation started (${e.variants} variant${e.variants === 1 ? "" : "s"})\n`);
  } else if (e.type === "image_generation_heartbeat") {
    process.stderr.write(`  ◌ image generation ${Math.round(e.elapsedMs / 1000)}s (${e.completed}/${e.variants} workers finished)\n`);
  } else if (e.type === "image_generation_worker_failed") {
    process.stderr.write(`  ⚠ image worker ${e.kind}: ${e.reason}\n`);
  } else if (e.type === "image_generation_finished") {
    process.stderr.write(`  ● image generation finished (${e.completed}/${e.variants}, ${Math.round(e.elapsedMs / 1000)}s)\n`);
  } else if (e.type === "verification") {
    process.stderr.write(`  ⚑ verification: ${e.verification.status}\n`);
  } else if (e.type === "auto_verify") {
    const reason = e.trigger === "stale" ? "turn(s) without the project check"
      : e.trigger === "probes" ? "inline probe(s)" : "blind edit(s)";
    process.stderr.write(`  ⚙ auto-verify after ${e.streak} ${reason}: ${e.verdict}\n`);
  } else if (e.type === "scoped_verify") {
    process.stderr.write(`  ⚙ scoped-verify (${e.tests?.length ?? 0} test(s)): ${e.verdict}\n`);
  } else if (e.type === "test_focus") {
    process.stderr.write(`  🎯 test-focus steer fed back\n`);
  } else if (e.type === "test_diagnosis") {
    process.stderr.write(`  🔬 stuck-test diagnosis fed back\n`);
  } else if (e.type === "regression_revert") {
    process.stderr.write(`  ↩ regression revert: ${e.from} → ${e.to} passing; restored ${(e.files ?? []).join(", ")}\n`);
  } else if (e.type === "placeholder_echo_reject") {
    process.stderr.write(`  🚫 placeholder echo rejected\n`);
  } else if (e.type === "double_escape_reject") {
    process.stderr.write(`  🚫 double-escaped newlines rejected (precise steer fed back)\n`);
  }
}

if (cmd === undefined || cmd === "chat") {
  await repl();
} else if (cmd === "escalate") {
  // Distress-triggered escalation: read a recorded run's own distress tags, decide
  // whether it suspects a major error, and — only after the consent gate clears —
  // fire the same three/four-way compare so a stronger reference can show what the
  // run could not see. Interactive consent = --yes; autonomous consent = a budget.
  const artifactPath = args._[1];
  const task = typeof args.task === "string" ? args.task : null;
  if (!artifactPath || !task || args.help) {
    console.log('usage: bantam escalate <bantam-run.json> --task <task> [--yes] [--budget <usd>] [--config <c>] [--out <dir>]');
    process.exit(artifactPath && task ? 0 : 2);
  }
  const { distillDistress, suspectsMajorError, requireConsent } = await import("../src/logic/escalation-policy.js");
  const { newBudget, estimateEscalationCost, authorizeAutonomous, recordSpend } = await import("../src/logic/escalation-budget.js");
  const artifact = JSON.parse(fs.readFileSync(path.resolve(artifactPath), "utf8"));
  const snapshot = distillDistress(artifact.turns ?? []);
  const suspicion = suspectsMajorError(snapshot);
  console.log(`distress snapshot: ${JSON.stringify(snapshot)}`);
  console.log(suspicion.reason);
  if (!suspicion.escalate) process.exit(0);

  const arms = ["claude-code", "codex"];
  const autonomous = args.budget !== undefined;
  let preAuthorized = false;
  let budget = null;
  if (autonomous) {
    budget = newBudget({ limitUsd: Number(args.budget) || 0 });
    const estimate = estimateEscalationCost({ arms });
    const auth = authorizeAutonomous(budget, estimate);
    console.log(`autonomous budget: ${auth.why}`);
    preAuthorized = auth.allow;
  }
  const consent = requireConsent({
    escalate: suspicion.escalate,
    mode: autonomous ? "autonomous" : "interactive",
    preAuthorized,
    confirm: () => Boolean(args.yes),
  });
  if (!consent.proceed) {
    console.log(`escalation withheld: ${consent.why}`);
    console.log(autonomous ? "  raise --budget to authorize." : "  re-run with --yes to consent (spends money, sends the task to external agents).");
    process.exit(0);
  }
  console.log(`escalation authorized: ${consent.why}\n`);
  const { runCompare } = await import("../src/logic/compare-plan.js");
  const res = await runCompare({
    task,
    config: typeof args.config === "string" ? args.config : undefined,
    out: typeof args.out === "string" ? args.out : undefined,
    only: null,
    dryRun: false,
    allowUnsafe: Boolean(args["allow-unsafe-competitors"]),
  });
  if (autonomous && budget && !res?.error) {
    budget = recordSpend(budget, estimateEscalationCost({ arms }), { note: `escalate ${task}` });
    console.log(`\nrecorded autonomous spend; remaining $${authorizeAutonomous(budget, 0).remaining.toFixed(2)}.`);
  }
  process.exit(0);
} else if (cmd === "forecast") {
  // Structural forecast: query THIS workspace's Datalog KB and predict whether
  // finishing will hold. Today's KB-supported signal: unresolved relative imports
  // (a `.`-import resolving to no file will fail to load). Self-referential — no
  // reference agent needed; bantam's own KB tells it.
  const { snapshotWorkspaceKb, kbStructuralForecast } = await import("../src/logic/kb-diff-witness.js");
  const dir = path.resolve(args._[1] || ".");
  if (!fs.existsSync(dir)) { console.error(`no such workspace: ${dir}`); process.exit(2); }
  const forecast = kbStructuralForecast(snapshotWorkspaceKb(dir));
  if (forecast.sound) {
    console.log(`forecast: structurally sound — no unresolved imports in ${path.relative(process.cwd(), dir) || "."}.`);
    process.exit(0);
  }
  console.log(`forecast: NOT sound — ${forecast.objections.length} structural objection(s) would survive a finish:\n`);
  for (const o of forecast.objections) console.log(`  [${o.kind}] ${o.message}`);
  process.exit(1);
} else if (cmd === "runlens") {
  // Summarize a saved run artifact (`--save-run` output): header, action histogram,
  // turn timeline, gate rejections, verify verdict. `--json` for machine output.
  const artifactPath = args._[1];
  if (!artifactPath || args.help) {
    console.log("usage: bantam runlens <run-artifact.json> [--json]");
    process.exit(artifactPath ? 0 : 2);
  }
  const { analyze, formatReport } = await import("../src/logic/runlens.js");
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(path.resolve(artifactPath), "utf8"));
  } catch (e) {
    console.error(`runlens: cannot read ${artifactPath}: ${e.message}`);
    process.exit(2);
  }
  process.stdout.write(`${args.json ? JSON.stringify(analyze(artifact), null, 2) : formatReport(artifact)}\n`);
  process.exit(0);
} else if (cmd === "compare") {
  // User-initiated three/four-way: fire one task at bantam-dev + bantam-regular +
  // claude-code + codex, grade each, and compile one summary with any
  // reference-witness divergence. Spends money + sends data out; invoking this
  // command still requires the explicit competitor-consent flag.
  const task = args._[1];
  if (!task || args.help) {
    console.log('usage: bantambuild compare "<task>" [--workspace <dir>] [--verify <command>] [--config <four-arms.json>] [--out <run-dir>] [--only <arm,...>] [--dry-run] [--allow-unsafe-competitors]');
    process.exit(task ? 0 : 2);
  }
  const { runCompare } = await import("../src/logic/compare-plan.js");
  const only = typeof args.only === "string" ? args.only.split(",").map((s) => s.trim()) : null;
  await runCompare({
    task,
    config: typeof args.config === "string" ? args.config : undefined,
    out: typeof args.out === "string" ? args.out : undefined,
    only,
    dryRun: Boolean(args["dry-run"] || args.dryRun),
    allowUnsafe: Boolean(args["allow-unsafe-competitors"]),
    workspace: typeof args.workspace === "string" ? args.workspace : undefined,
    verify: typeof args.verify === "string" ? args.verify : undefined,
  });
  process.exit(0);
} else if (cmd === "replay") {
  // Turn-level counterfactual replay of a recorded run (BANTAM_SAVE_PROMPTS=1).
  //   bantam replay <artifact.json> --turn N [--inject "steering text"]
  const { prepareReplay, formatReplayComparison, replayRuntimeOptions } = await import("../src/replay.js");
  const artifactPath = args._[1];
  const turnIndex = Number(args.turn);
  if (!artifactPath || !Number.isInteger(turnIndex)) {
    process.stderr.write('usage: bantam replay <artifact.json> --turn N [--inject "text"] [--endpoint url]\n');
    process.exit(2);
  }
  const artifact = JSON.parse(fs.readFileSync(path.resolve(artifactPath), "utf8"));
  const replay = prepareReplay(artifact, turnIndex, { inject: args.inject });
  const { prompt, recorded, sampling, endpoint: recordedEndpoint } = replay;
  const runtimeOptions = replayRuntimeOptions(artifact, { transportOverride: Boolean(args.endpoint) });
  const recordedCodex = runtimeOptions.codex === true;
  const ep = args.endpoint
    || (recordedCodex ? replay.request?.url : null)
    || recordedEndpoint
    || await detectEndpoint();
  const { actionGrammar } = await import("../src/grammar.js");
  const { LINE_EDIT_FEATURE } = await import("../src/action-protocol.js");
  // --line-edit replays the SAME turn with the line-pointer action available,
  // so a grammar change can be A/B'd against the recorded failure.
  const replayFeatures = args["line-edit"] ? [LINE_EDIT_FEATURE] : [];
  const replayClient = new ModelClient(cliModelOptions({
    endpoint: ep,
    profile: sampling?.profile,
    ...runtimeOptions,
  }));
  // A captured Codex body is not a llama.cpp /completion body. An explicit
  // --endpoint therefore becomes a prompt-level cross-transport
  // counterfactual instead of rewriting incompatible bytes.
  const canReplayRequest = replay.request && replayFeatures.length === 0
    && !(args.endpoint && String(replay.request.url).startsWith("codex-app-server://"));
  const transportChanged = Boolean(args.endpoint && (
    !canReplayRequest || replay.request?.url !== `${ep.replace(/\/$/, "")}/completion`
  ));
  const replayLabel = canReplayRequest
    ? (transportChanged ? "counterfactual-transport" : replay.fidelity)
    : "counterfactual-grammar";
  process.stderr.write(`replaying turn ${turnIndex} of ${artifact.runId ?? artifactPath} against ${ep} [${replayLabel}]${replayFeatures.length ? " [+edit_lines]" : ""}\n`);
  const exactRequest = canReplayRequest && args.endpoint
    ? { ...replay.request, url: `${ep.replace(/\/$/, "")}/completion` }
    : replay.request;
  try {
    const out = canReplayRequest
      ? await replayClient.completeRequest(exactRequest)
      : await replayClient.complete(prompt, { grammar: actionGrammar({ features: replayFeatures }), nPredict: 1024, seed: sampling?.seed ?? undefined });
    console.log(formatReplayComparison(recorded, out?.content ?? out));
  } finally {
    replayClient.close();
  }
} else if (cmd === "diagnose" && typeof args.compare === "string") {
  // Learn from a stronger reference: witness a recorded four-arm comparison where
  // a reference arm (claude-code/codex) passed a task bantam failed, and surface
  // the divergence as grounded, gate-voiced remedy candidates.
  const { witnessTaskRun, loadTaskRun, findReferenceDivergence } = await import("../src/logic/reference-witness.js");
  const dir = path.resolve(args.compare);
  const { arms } = loadTaskRun(dir);
  const divergence = findReferenceDivergence(arms);
  if (!divergence) {
    console.log(`no reference divergence in ${path.basename(dir)}: bantam passed, or no claude-code/codex arm passed where bantam failed.`);
    process.exit(0);
  }
  const gaps = witnessTaskRun(dir);
  console.log(`reference divergence in ${path.basename(dir)}: ${divergence.referenceArm} passed, bantam failed.`);
  console.log(`\ntextual gaps (${gaps.length}):\n`);
  for (const g of gaps) {
    console.log(`  [${g.kind}] ${g.target} @ line ${g.site.line}  (learned from ${g.arm})`);
    console.log(g.remedy.split("\n").map((l) => `      ${l}`).join("\n"));
    console.log("");
  }
  // Structural gaps: diff the two arms' Datalog KBs — missing definitions, unwired
  // calls, broken imports, missing dependencies a text excerpt can't show. Silent
  // (empty) for prose tasks with no code KB.
  const { snapshotWorkspaceKb, diffKb } = await import("../src/logic/kb-diff-witness.js");
  const subjectWs = path.join(dir, "bantam-dev", "workspace");
  const refWs = path.join(dir, divergence.referenceArm, "workspace");
  let kbGaps = [];
  if (fs.existsSync(subjectWs) && fs.existsSync(refWs)) {
    kbGaps = diffKb({
      bantam: snapshotWorkspaceKb(subjectWs),
      reference: snapshotWorkspaceKb(refWs),
      referenceArm: divergence.referenceArm,
    });
  }
  console.log(`structural KB gaps (${kbGaps.length}):${kbGaps.length ? "" : " none — the divergence is textual, not structural."}\n`);
  for (const g of kbGaps) {
    console.log(`  [${g.kind}] ${g.symbol ?? g.target} @ ${g.site.file}`);
    console.log(g.remedy.split("\n").map((l) => `      ${l}`).join("\n"));
    console.log("");
  }
  if (gaps.length || kbGaps.length) {
    console.log("witness only: preregister and measure a remedy with `bantambuild experiment`; this checkout has no standalone comparison scorer.");
  }
  process.exit(0);
} else if (cmd === "diagnose") {
  // Self-diagnosis (docs/PRINCIPLES.md): witness the bad turns of a recorded
  // run; with --turn, rewind that turn and A/B a context remedy against the
  // live model, scoring whether it moves the model from spinning to working.
  const { witnessProblems, summarizeProblems, CONTEXT_REMEDIES, scoreRemedy } = await import("../src/diagnose.js");
  const { prepareReplay, withSampleSeed } = await import("../src/replay.js");
  const artifactPath = args._[1];
  if (!artifactPath) {
    process.stderr.write('usage: bantam diagnose <artifact.json> [--turn N] [--samples 3]\n');
    process.exit(2);
  }
  const artifact = JSON.parse(fs.readFileSync(path.resolve(artifactPath), "utf8"));
  const problems = witnessProblems(artifact);
  const summary = summarizeProblems(artifact);

  // Silent completeness gaps — invisible to the distress-signal witness — are
  // surfaced when a task repo is given (needed to build the KB). These are the
  // misses that leave no signal: the model edited one twin, done'd, and only the
  // hidden grader knew.
  let completenessGaps = [];
  if (args.repo) {
    const { witnessCompletenessGaps } = await import("../src/logic/critic-witness.js");
    const { buildGrounding } = await import("../src/logic/grounding.js");
    completenessGaps = witnessCompletenessGaps(artifact, buildGrounding(path.resolve(args.repo)), path.resolve(args.repo));
  }

  if (args.turn === undefined) {
    console.log(`${summary.problemTurns}/${summary.turns} turns hit a harness distress signal (${(summary.problemRate * 100).toFixed(0)}%), ${summary.replayable} replayable.`);
    console.log("\nby kind:");
    for (const { kind, count } of summary.byKind) console.log(`  ${String(count).padStart(3)}  ${kind}`);
    console.log("\nfailure rate by action:");
    for (const r of summary.actionFailureRate) {
      console.log(`  ${r.verb.padEnd(12)} ${String(r.bad).padStart(3)}/${String(r.total).padEnd(3)}  ${(r.rate * 100).toFixed(0)}%`);
    }
    const worst = problems.filter((p) => p.replayable).slice(-5);
    if (worst.length) {
      console.log("\nrewindable problem turns (try: --turn N):");
      for (const p of worst) console.log(`  turn ${String(p.turn).padStart(3)}  ${p.kind.padEnd(18)} ${p.why}`);
    }
    if (args.repo) {
      console.log(`\nsilent completeness gaps (via the critic, KB from ${args.repo}): ${completenessGaps.length}`);
      for (const g of completenessGaps) {
        console.log(`  ${g.kind.padEnd(28)} \`${g.target}\` -> ${g.site?.file}${g.site?.line ? `:${g.site.line}` : ""}`);
      }
      if (completenessGaps.length) {
        console.log("  witness only: preregister and measure a remedy with `bantambuild experiment` before promotion.");
      }
    } else {
      console.log("\n(pass --repo <task-repo> to also witness silent completeness gaps)");
    }
    process.exit(0);
  }

  const turnIndex = Number(args.turn);
  const problem = problems.find((p) => p.turn === turnIndex);
  const kind = problem?.kind ?? "failed-action";
  const remedies = CONTEXT_REMEDIES[kind] ?? [];
  if (!remedies.length) {
    process.stderr.write(`no candidate remedies for problem kind "${kind}"\n`);
    process.exit(1);
  }
  const samples = Math.max(1, Number(args.samples ?? 3));
  const ep = args.endpoint || artifact.endpoint || await detectEndpoint();
  const { actionGrammar } = await import("../src/grammar.js");
  const client = new ModelClient(cliModelOptions({ endpoint: ep, profile: artifact.sampling?.profile }));
  const ask = async (inject, sampleIndex) => {
    const replay = withSampleSeed(prepareReplay(artifact, turnIndex, { inject }), sampleIndex);
    const request = replay.request && args.endpoint
      ? { ...replay.request, url: `${ep.replace(/\/$/, "")}/completion` }
      : replay.request;
    const out = request
      ? await client.completeRequest(request)
      : await client.complete(replay.prompt, { grammar: actionGrammar(), nPredict: 1024 });
    return String(out?.content ?? out ?? "");
  };

  process.stderr.write(`turn ${turnIndex}: ${kind} — ${problem?.why ?? "(unclassified)"}\n`);
  process.stderr.write(`recorded action: ${JSON.stringify(problem?.action ?? null)}\n\n`);
  const baseline = [];
  for (let i = 0; i < samples; i++) baseline.push(await ask("", i));

  const results = [];
  for (const remedy of remedies) {
    const outs = [];
    for (let i = 0; i < samples; i++) outs.push(await ask(remedy, i));
    const score = scoreRemedy(baseline, outs);
    results.push({ remedy, score });
    console.log(`\nremedy: ${remedy.slice(0, 90)}...`);
    console.log(`  baseline  productive ${score.baseline.productive}/${score.baseline.n}  (recon ${score.baseline.recon}, invalid ${score.baseline.invalid})`);
    console.log(`  remedied  productive ${score.remedy.productive}/${score.remedy.n}  (recon ${score.remedy.recon}, invalid ${score.remedy.invalid})`);
    console.log(`  lift ${(score.lift * 100).toFixed(0)}%  ->  ${score.verdict.toUpperCase()}`);
  }

  const best = results.filter((r) => r.score.verdict === "promote").sort((a, b) => b.score.lift - a.score.lift)[0];
  if (best) {
    console.log(`\nbest remedy lifts productive actions by ${(best.score.lift * 100).toFixed(0)}%. Record it in an experiment manifest before any promotion decision.`);
  } else {
    console.log("\nno remedy cleared the promotion bar on this turn.");
  }
} else if (cmd === "health") {
  const ok = await model.health();
  console.log(ok ? "ok" : "unreachable");
  process.exit(ok ? 0 : 1);
} else if (cmd === "serve") {
  await serveCommand();
  process.exit(0);
} else if (cmd === "run") {
  if (!args.task) fail("run requires --task (or run `bantam` with no args for interactive mode)");
  if ((args["resume-run"] || args["review-file"] || args["through-turn"] !== undefined) && args.lane !== undefined) {
    fail("--resume-run/--review-file cannot be combined with --lane; fork/resume the lane for an exact workspace cursor");
  }
  if (args["through-turn"] !== undefined && !args["resume-run"]) {
    fail("--through-turn requires --resume-run");
  }
  if (args["resume-run"] === true) fail("--resume-run requires an artifact path");
  if (args["review-file"] === true) fail("--review-file requires a file path");

  let continuation = null;
  if (args["resume-run"] || args["review-file"]) {
    let artifact = null;
    let artifactPath = null;
    let artifactSha256 = null;
    if (args["resume-run"]) {
      artifactPath = path.resolve(args["resume-run"]);
      let serialized;
      try { serialized = fs.readFileSync(artifactPath, "utf8"); }
      catch (error) { fail(`cannot read --resume-run ${artifactPath}: ${error.message}`); }
      try { artifact = JSON.parse(serialized); }
      catch (error) { fail(`cannot parse --resume-run ${artifactPath}: ${error.message}`); }
      artifactSha256 = sha256(serialized);
    }

    let reviewText = null;
    let reviewSource = null;
    let reviewSha256 = null;
    if (args["review-file"]) {
      reviewSource = path.resolve(args["review-file"]);
      try { reviewText = fs.readFileSync(reviewSource, "utf8"); }
      catch (error) { fail(`cannot read --review-file ${reviewSource}: ${error.message}`); }
      reviewSha256 = sha256(reviewText);
    }

    try {
      continuation = prepareRunContinuation(artifact, {
        task: args.task,
        throughTurn: args["through-turn"],
        artifactPath,
        artifactSha256,
        reviewText,
        reviewSource,
        reviewSha256,
      });
    } catch (error) {
      fail(error.message);
    }
    if (artifact) {
      process.stderr.write(
        `continuing ${artifact.runId ?? path.basename(artifactPath)} through turn ${continuation.provenance.throughTurn}; `
        + "dialogue is restored, but --workspace must already match that artifact cursor\n",
      );
    }
    if (continuation?.provenance.review) {
      process.stderr.write(
        `trusted reviewer evidence: ${continuation.provenance.review.source} `
        + `(sha256 ${continuation.provenance.review.sha256})\n`,
      );
    }
    if (Number.isInteger(model.requestCount)) {
      model.requestCount = Math.max(model.requestCount, continuation.nextRequestIndex);
    }
    if (Number.isInteger(model.completionIndex)) {
      model.completionIndex = Math.max(model.completionIndex, continuation.completionIndex);
    }
  }
  const runMaxTurns = args["max-turns"]
    ? Number(args["max-turns"])
    : (Number(process.env.BANTAM_MAX_TURNS) || 200);
  if (continuation && (!Number.isFinite(runMaxTurns) || runMaxTurns <= continuation.resumeTurns.length)) {
    fail(
      `--max-turns is the total trajectory length and must exceed the ${continuation.resumeTurns.length} restored turn(s)`,
    );
  }
  const autonomous = Boolean(args.autonomous);
  const autonomousGrounding = Boolean(args.ground) || envTruthy("BANTAM_GROUND");
  const runStamp = makeStamp();
  const runId = makeRunId(runStamp);
  let laneBridge = null;
  let laneStopSignal = null;
  let checkpoint = null;
  const laneRunController = new AbortController();
  const laneSignalHandlers = new Map();
  const detachLaneSignals = () => {
    for (const [signalName, handler] of laneSignalHandlers) process.off(signalName, handler);
    laneSignalHandlers.clear();
  };
  let workspace = path.resolve(args.workspace || ".");
  if (args.lane !== undefined) {
    if (args.lane === true) fail("run --lane requires a lane id");
    if (args["state-home"] === true) fail("run --state-home requires a directory");
    // Install before lease acquisition. A signal delivered while Git is
    // validating/materializing the lane is handled as soon as control returns
    // to the event loop instead of taking the process's default hard-exit path.
    for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        if (laneStopSignal === null) laneStopSignal = signalName;
        checkpoint?.flush(signalName.toLowerCase());
        laneRunController.abort();
      };
      laneSignalHandlers.set(signalName, handler);
      process.on(signalName, handler);
    }
    const stateHome = resolveStateHome(
      process.cwd(),
      process.env,
      typeof args["state-home"] === "string" ? args["state-home"] : undefined,
    );
    try {
      laneBridge = new LaneRunBridge({
        stateHome,
        laneId: args.lane,
        runId,
        stamp: runStamp,
        task: args.task,
        model,
      });
    } catch (error) {
      detachLaneSignals();
      fail(`cannot acquire lane ${args.lane}: ${error.message}`);
    }
    if (args.workspace && path.resolve(args.workspace) !== laneBridge.workspace) {
      laneBridge.close();
      detachLaneSignals();
      fail(`run --lane owns workspace ${laneBridge.workspace}; remove the conflicting --workspace`);
    }
    workspace = laneBridge.workspace;
    // A lane stop is a state transition, not an immediate process exit. Let
    // runAgent abort its current model/shell operation, then persist the
    // interrupted cursor and release the single-writer lease in `finally`.
  }
  // --tui launches the live cockpit (a view over the same events) when on a TTY.
  let tui = null;
  try {
    tui = (args.tui && process.stdout.isTTY)
      ? new BantamTUI({ title: (args.title || args.task).slice(0, 48), model: activeModelId || args.profile || "local model" })
      : null;
    if (tui) tui.start();
  } catch (error) {
    laneBridge?.close();
    detachLaneSignals();
    throw error;
  }
  // Crash/timeout evidence. A process killed mid-turn would otherwise lose its trajectory because
  // the full artifact is written only after runAgent resolves. Arm a checkpoint so a killed run
  // still says where it got to.
  const runDest = args["save-run"]
    ? (typeof args["save-run"] === "string" ? path.resolve(args["save-run"]) : path.resolve(".bantam/runs", `${runStamp}.json`))
    : null;
  if (runDest && continuation?.provenance.parentArtifact
      && runDest === path.resolve(continuation.provenance.parentArtifact)) {
    fail("--save-run must differ from --resume-run; refusing to overwrite the rewind source");
  }
  // A lane needs the same in-memory request/turn collector even when the
  // operator did not request a standalone artifact path: its final artifact is
  // stored content-addressed in the lane state.
  checkpoint = (runDest || laneBridge)
    ? new RunCheckpoint({
        dest: runDest,
        meta: {
          runId,
          stamp: runStamp,
          laneId: args.lane ?? null,
          task: args.task,
          ...(continuation ? { continuation: continuation.provenance } : {}),
        },
        initialEvidence: laneBridge?.resumeEvidence ?? continuation?.initialEvidence ?? null,
      })
    : null;
  // Standalone runs retain the historical immediate signal checkpoint. Lane
  // runs own their signal lifecycle above so they can close the durable lease.
  const disarm = checkpoint && !laneBridge ? checkpoint.arm() : () => {};
  const detachModelCheckpoint = attachModelRequestCheckpoint(model, checkpoint);
  let checkpointDisarmed = false;
  const baseOnEvent = tui ? (e) => tui.handleEvent(e) : (autonomous ? liveLogger : makeInteractiveLogger());
  const captureEvent = checkpoint
    ? (event) => {
        checkpoint.note(event);
        laneBridge?.note(event, checkpoint, { model });
        baseOnEvent(event);
      }
    : baseOnEvent;
  // Skill distillation only mints from an integrity-clean pass (agent.js requires a
  // postVerifyIntegrity verdict), so --skills without this check could never learn — a silent
  // no-op. Snapshot the tree up front and grade it after, exactly as the fixture runner does.
  let skillSnapshot = null;
  let res;
  const usageBefore = modelUsageSnapshot(model);
  const usageBreakdownBefore = modelUsageBreakdownSnapshot(model);
  try {
    // Keep setup which touches the lane workspace inside the same lease cleanup
    // boundary as the run itself.
    skillSnapshot = skillsCfg ? snapshotTree(workspace) : null;
    res = await runAgent({
      task: args.task,
      workspace,
      model,
      maxTurns: runMaxTurns,
      verificationScript: args.verify || null,
      thinkMode,
      skills: skillsCfg,
      postVerifyIntegrity: skillSnapshot ? () => checkWorkspace(skillSnapshot, workspace, {}) : null,
      planMode,
      preGate: !args["no-pregate"],
      // Default: a human asked for this, so run clean (no autonomous guardrails). `--autonomous`
      // restores the gates for headless runs where nothing is watching.
      interactive: !autonomous,
      // Grounding (datalog KB + query tool): mirror the REPL for interactive runs (on, --no-ground
      // to disable); opt-in via --ground for --autonomous so unattended defaults stay conservative.
      grounding: autonomous ? autonomousGrounding : !args["no-ground"],
      resumeTurns: laneBridge?.resumeTurns ?? continuation?.resumeTurns ?? null,
      signal: laneBridge ? laneRunController.signal : null,
      onEvent: captureEvent,
    });
    const restoredPrefix = Boolean(continuation || laneBridge?.resumeTurns?.length);
    if (!restoredPrefix) {
      res.usage = modelUsageDelta(usageBefore, modelUsageSnapshot(model));
      res.usageBySource = modelUsageBreakdownDelta(
        usageBreakdownBefore,
        modelUsageBreakdownSnapshot(model),
      );
    }
    if (tui) tui.finish(res); else printResult(res);
    if (runDest || laneBridge) {
      const modelId = activeModelId ?? await fetchModelId(model.endpoint);
      const gitState = harnessGit();
      const liveArtifactResult = checkpoint ? {
        ...res,
        // runAgent's completed trajectory is authoritative and carries fields
        // that action/observation checkpoint events cannot reconstruct
        // (query routing, preview proof/generation, edit provenance). The
        // checkpoint remains the crash-safe source while a run is incomplete.
        turns: res.turns,
        rejectedOutputs: res.rejectedOutputs,
        modelCalls: checkpoint.modelCalls(),
      } : res;
      const artifactResult = mergeContinuationResult(liveArtifactResult, continuation);
      const artifact = buildArtifact({
        runId,
        stamp: runStamp,
        fixture: null,
        task: args.task,
        model,
        modelId,
        result: artifactResult,
        harnessGit: gitState,
        continuation: continuation?.provenance ?? null,
      });
      // saveArtifact is a synchronous atomic rename. Keep the partial checkpoint
      // armed until that rename succeeds; if it throws, the catch below writes
      // exception evidence instead of leaving neither artifact.
      if (runDest) {
        saveArtifact(runDest, artifact);
        // Once the complete artifact exists, an unrelated later lane failure
        // must not replace it with the partial crash shape.
        checkpoint.complete();
      }
      const laneFinished = res.interrupted
        ? laneBridge?.abort({
            checkpoint,
            artifact,
            result: res,
            model,
            error: new Error(`interrupted by ${laneStopSignal ?? "abort"}`),
          })
        : laneBridge?.finish({ checkpoint, artifact, result: res, model });
      if (!runDest) checkpoint.complete();
      disarm();
      checkpointDisarmed = true;
      if (runDest) console.log(`saved run artifact: ${runDest}`);
      if (laneFinished) console.log(`lane checkpoint: ${args.lane}@${laneFinished.lane.eventId}`);
    }
  } catch (error) {
    checkpoint?.flush("exception");
    try { laneBridge?.abort({ checkpoint, error, model }); } catch { /* retain the original failure */ }
    throw error;
  } finally {
    detachModelCheckpoint();
    laneBridge?.close();
    detachLaneSignals();
    if (!checkpointDisarmed) disarm();
  }
  const signalExitCode = laneStopSignal === "SIGINT" ? 130
    : laneStopSignal === "SIGTERM" ? 143
      : laneStopSignal === "SIGHUP" ? 129
        : null;
  process.exit(signalExitCode ?? (res.modelFailure || (res.verification && res.verification.status === "fail") ? 1 : 0));
} else if (cmd === "eval") {
  const fixtures = args._.slice(1);
  const dirs = fixtures.length ? fixtures : defaultFixtures();
  if (!dirs.length) fail(`no fixtures found under ${fixturesRoot()}`);
  const saveRun = Boolean(args["save-run"]);
  const evalGitState = saveRun ? harnessGit() : null;
  let pass = 0;
  const rows = [];
  for (const dir of dirs) {
    process.stderr.write(`\n▶ ${JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")).name}\n`);
    const row = await runFixture({
      dir,
      model,
      thinkMode,
      skills: skillsCfg,
      planMode,
      preGate: !args["no-pregate"],
      onEvent: liveLogger,
      captureArtifact: saveRun,
      harnessGitState: evalGitState,
      ledgerPath: saveRun ? path.join(fixturesRoot(), "ledger.jsonl") : null,
      ledgerArtifactPath: repoRelative,
    });
    if (row.scopeViolations) {
      const list = row.scopeViolationDetails.map((v) => `${v.change} ${v.path}`).join(", ");
      process.stderr.write(`  ⚠ scope violation (${row.scopeViolationDetails[0].kind}): ${list}\n`);
    }
    rows.push(row);
    if (row.status === "pass") pass++;
  }
  // Name the model IN the summary, not just the startup line: over a long eval the header scrolls
  // away, and pass rates compared across sessions are meaningless without the model identity (a
  // swapped GGUF on the same port looked like a harness regression until the artifact said otherwise).
  console.log(`\n=== Bantam eval — ${activeModelId || "unknown model"} @ ${model.endpoint} ===`);
  for (const r of rows) {
    const tag = r.status === "pass" ? "PASS" : r.status === "cheated" ? "CHEAT" : r.status === "fail" ? "FAIL" : r.status === "expectation-miss" ? "MISS" : "----";
    console.log(`${tag}  ${r.name}  (${r.turns} turns, ${r.invalid} invalid, ${r.protocolViolations} protocol, ${r.duplicateActionRejections} duplicate, ${r.repeatEscapeMasks} repeat-mask, ${r.patchActions} patch, ${r.patchFailures} patch-fail, ${r.durationMs}ms)${r.scopeViolations ? `  ⚠ ${r.scopeViolations} scope violation(s)` : ""}`);
    // For declared-outcome fixtures, name what the tag means: "PASS" on an
    // honesty fixture is a public FAIL that the fixture wanted, not a green suite.
    if (r.expectation) {
      const d = r.expectation.declared;
      console.log(`      expectation ${r.expectation.met ? "met" : "MISSED"}: wanted public ${d.public} + contract ${d.contract}; got public ${r.expectation.publicStatus}, contract ${r.expectation.contractStatus ?? "none"}`);
    }
    if (r.artifactPath) console.log(`      artifact: ${r.artifactPath}`);
  }
  console.log(`\n${formatEvalSummary(rows)}`);
  process.exit(pass === rows.length ? 0 : 1);
} else if (cmd === "skills") {
  const lib = skillsLib || defaultSkillsPath();
  const skills = loadLibrary(lib);
  console.log(`${skills.length} skill(s) in ${lib}\n`);
  for (const s of skills) {
    console.log(`• ${s.title}  [${s.language}]`);
    console.log(`  triggers: ${(s.triggers || []).join(", ")}`);
    console.log(`  ${s.approach}\n`);
  }
} else if (cmd === "facts") {
  // Run-evidence queries over .bantam/facts.jsonl — every fixture run records durable,
  // provenanced facts (see docs/FACT_LOG.md). Usage:
  //   bantam facts                        summary (statuses, flaky, contract violations)
  //   bantam facts --backfill             import historic fixtures/ledger.jsonl rows
  //   bantam facts <rel> [args...]        query a relation; "?" wildcards, padded to arity
  //   bantam facts explain <rel> <args>   proof tree for a derived fact
  const factsLog = defaultRunEvidenceLog();
  if (args.backfill) {
    const n = backfillFromLedger(factsLog, path.join(fixturesRoot(), "ledger.jsonl"));
    const x = backfillFromExperiments(factsLog, path.resolve(".bantam", "experiments"));
    console.log(`backfilled ${n} run(s) from fixtures/ledger.jsonl, ${x} from experiment evidence`);
  }
  const factsDb = evidenceView(factsLog);
  const rest = args._.slice(1);
  if (rest[0] === "explain" && rest[1]) {
    const [rel, ...qargs] = rest.slice(1).map(String);
    console.log(JSON.stringify(factsDb.explain(rel, ...qargs), null, 2));
  } else if (rest.length) {
    const [rel, ...qargs] = rest.map(String);
    const arity = factsDb.rels.get(rel)?.arity;
    if (arity === undefined) {
      console.log(`unknown relation: ${rel}\nknown: ${[...factsDb.rels.keys()].sort().join(", ")}`);
    } else {
      while (qargs.length < arity) qargs.push("?");
      const rows = factsDb.query(rel, ...qargs);
      for (const r of rows) console.log(r.join("  "));
      console.log(`${rows.length} row(s)`);
    }
  } else {
    console.log(`${factsDb.count("run")} run(s) on record in ${defaultFactsPath()}\n`);
    const statuses = new Map();
    for (const [, s] of factsDb.query("run_status", "?", "?")) statuses.set(s, (statuses.get(s) ?? 0) + 1);
    for (const [s, n] of [...statuses].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${s}`);
    const flaky = factsDb.query("flaky", "?").map((r) => r[0]);
    if (flaky.length) console.log(`\nflaky fixtures (passed AND failed on record): ${flaky.join(", ")}`);
    const violated = factsDb.query("contract_violated", "?").map((r) => r[0]);
    if (violated.length) console.log(`contract-violating runs: ${violated.join(", ")}`);
    const gates = factsDb.query("gate_fired", "?").map((r) => r[0]);
    if (gates.length) console.log(`gates that have fired: ${gates.join(", ")}`);
  }
} else if (cmd === "bench") {
  // Reliability benchmark: the same task with the grammar ON vs OFF, to show what
  // the constraint buys (malformed-output rate) on a local model.
  const dirs = args._.slice(1).length ? args._.slice(1) : defaultFixtures();
  if (!dirs.length) fail(`no fixtures found under ${fixturesRoot()}`);
  const repeat = args.repeat ? Number(args.repeat) : 3;
  console.log(`\n=== Bantam reliability benchmark (repeat=${repeat} per mode) ===`);
  for (const dir of dirs) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    process.stderr.write(`\n▶ ${spec.name}\n`);
    for (const [label, useGrammar] of [["grammar ON ", true], ["grammar OFF", false]]) {
      const totals = emptyBenchTotals();
      for (let i = 0; i < repeat; i++) {
        const r = await benchRun(dir, spec, model, useGrammar);
        addBenchRun(totals, r);
        process.stderr.write(`   ${label} #${i + 1}: ${r.pass ? "PASS" : "FAIL"} (${r.invalid} invalid, ${r.protocol} protocol, ${r.turns} turns, ${r.preGateFails} pre-gate fails, ${r.replaceFailures} replace failures, ${r.shellCwdGuards} cwd guards, ${r.shellReadGuards} shell-read guards, ${r.testPipeGuards} test-pipe guards, ${r.testDigestHits} test digests)\n`);
      }
      console.log(formatBenchRow(spec.name, label, totals, repeat));
    }
  }
} else if (cmd === "analyze") {
  const root = repoRoot();
  const customPaths = args._.slice(1);
  const inputs = customPaths.length
    ? customPaths.map((p) => ({ source: "custom", path: path.resolve(p) }))
    : defaultEvidencePaths(root);
  const { rows, missing } = loadEvidenceRows(inputs);
  const analysis = analyzeEvidenceRows(rows, { currentSha: harnessGit().sha, latestOnly: !args["all-runs"] });
  if (args.json) {
    console.log(JSON.stringify({ ...analysis, missing: missing.map((m) => m.path) }, null, 2));
  } else {
    console.log(formatEvidenceAnalysis(analysis));
    const missingPaths = missing.map((m) => m.path).filter(Boolean);
    if (missingPaths.length) console.log(`\nmissing ledgers ignored:\n${missingPaths.map((p) => `- ${repoRelative(p)}`).join("\n")}`);
  }
} else {
  fail(`unknown command: ${cmd ?? "(none)"}\n\n${usage()}`);
}

async function benchRun(dir, spec, model, useGrammar) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-bench-"));
  fs.cpSync(path.join(dir, "repo"), workspace, { recursive: true });
  const snapshot = snapshotTree(workspace);
  try {
    const res = await runAgent({
      task: spec.task, workspace, model,
      maxTurns: spec.maxTurns ?? 30, verificationScript: spec.verify, useGrammar,
    });
    const { clean } = checkWorkspace(snapshot, workspace, spec);
    const pass = Boolean(clean && res.verification && res.verification.status === "pass");
    const replaceFailures = res.metrics.replaceFailures ?? {};
    const patchFailures = res.metrics.patchFailures ?? {};
    const fileOperationFailures = res.metrics.fileOperationFailures ?? {};
    return {
      pass,
      invalid: res.metrics.invalid,
      protocol: res.metrics.protocolViolations ?? 0,
      turns: res.metrics.turns,
      durationMs: res.metrics.durationMs ?? 0,
      preGateFails: res.metrics.preGateFails ?? 0,
      shellCwdGuards: res.metrics.shellCwdGuards ?? 0,
      shellReadGuards: res.metrics.shellReadGuards ?? 0,
      testPipeGuards: res.metrics.testPipeGuards ?? 0,
      testDigestHits: res.metrics.testDigestHits ?? 0,
      repeatedFailureHints: res.metrics.repeatedFailureHints ?? 0,
      duplicateActionRejections: res.metrics.duplicateActionRejections ?? 0,
      repeatEscapeMasks: res.metrics.repeatEscapeMasks ?? 0,
      doneRejections: res.metrics.doneRejections ?? 0,
      ledgerRejections: res.metrics.ledgerRejections ?? 0,
      progressNudges: res.metrics.progressNudges ?? 0,
      progressGateRejections: res.metrics.progressGateRejections ?? 0,
      progressGateTerminations: res.metrics.progressGateTerminations ?? 0,
      artifactVerificationNudges: res.metrics.artifactVerificationNudges ?? 0,
      artifactVerificationGateRejections: res.metrics.artifactVerificationGateRejections ?? 0,
      artifactVerificationGateTerminations: res.metrics.artifactVerificationGateTerminations ?? 0,
      maxProgresslessTurns: res.metrics.maxProgresslessTurns ?? 0,
      replaceFailures: replaceFailures.total ?? 0,
      replaceOldNotFound: replaceFailures.oldNotFound ?? 0,
      replaceAmbiguous: replaceFailures.ambiguous ?? 0,
      replaceLineStale: replaceFailures.lineStale ?? 0,
      replaceOther: replaceFailures.other ?? 0,
      patchActions: res.metrics.actions?.patch ?? 0,
      patchFailures: patchFailures.total ?? 0,
      deleteFileActions: res.metrics.actions?.delete_file ?? 0,
      moveFileActions: res.metrics.actions?.move_file ?? 0,
      fileOperationFailures: fileOperationFailures.total ?? 0,
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function defaultSkillsPath() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "skills", "library.jsonl");
}

async function runExperimentCommand(specArgument) {
  if (!specArgument) throw new Error("a spec file is required");
  if (args.resume === true) throw new Error("--resume requires an experiment evidence directory");
  if (args.resume && args.output) throw new Error("use --resume or --output, not both");
  if (args.resume && args["dry-run"]) throw new Error("--resume cannot be combined with --dry-run");
  const specFile = path.resolve(specArgument);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(specFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${specFile}: ${error.message}`);
  }
  const spec = normalizeExperimentSpec(raw);
  const fixtures = resolveExperimentFixtures(spec.fixtures);

  if (args["dry-run"]) {
    console.log(JSON.stringify({ spec, schedule: buildExperimentSchedule(spec), fixtures }, null, 2));
    return 0;
  }

  if (spec.arms.some((arm) => arm.model?.runtime?.startsWith("native-")) && !args.yes) {
    throw new Error("native Codex/Claude experiment arms require --yes because they invoke external CLI agents");
  }

  const promotionBinding = readPinnedExperimentBinding({
    harnessRoot: repoRoot(),
  });
  const startedAt = new Date().toISOString();
  const resumeDir = typeof args.resume === "string" ? path.resolve(args.resume) : null;
  let preview;
  if (resumeDir) {
    try {
      preview = JSON.parse(fs.readFileSync(path.join(resumeDir, "manifest.json"), "utf8"));
    } catch (error) {
      throw new Error(`cannot read resume manifest: ${error.message}`);
    }
  } else {
    preview = createExperimentManifest({ spec, startedAt, promotionBinding });
  }
  const outputDir = resumeDir ?? path.resolve(
    typeof args.output === "string" ? args.output : path.join(".bantam", "experiments", preview.id),
  );

  console.log(`\n=== Bantam experiment: ${spec.name} ===`);
  console.log(`id: ${preview.id}`);
  console.log(`evidence: ${outputDir}`);
  const outcome = await runExperiment({
    spec,
    fixtures,
    outputDir,
    id: preview.id,
    startedAt,
    harnessGit: harnessGit(),
    promotionBinding,
    sourceSpec: specFile,
    resume: Boolean(resumeDir),
    invocation: {
      endpoint: args.endpoint ?? process.env.BANTAM_ENDPOINT ?? null,
      profile: args.profile ?? process.env.BANTAM_PROFILE ?? null,
    },
    createModel: (arm, context) => new ModelClient({
      ...(arm.model.runtime
        ? modelOptionsForGauntletArm(arm.model, {
            endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
            profile: typeof args.profile === "string" ? args.profile : undefined,
          })
        : cliModelOptions(arm.model)),
      seed: context.seed,
    }),
    onEvent: liveLogger,
    onRunStart: ({ entry, arm, fixture }) => {
      process.stderr.write(`\n> round ${entry.round}/${spec.rounds} | ${arm.name} | ${fixture.name}${entry.seed === null ? "" : ` | seed ${entry.seed}`}\n`);
    },
    onRunComplete: ({ entry, row }) => console.log(formatExperimentRow(entry, row)),
  });
  console.log(`\n${formatExperimentSummary(outcome.manifest)}`);
  console.log(`manifest: ${outcome.manifestPath}`);
  return outcome.exitCode;
}

function resolveExperimentFixtures(fixtures) {
  return fixtures.map((fixture) => {
    const named = path.join(fixturesRoot(), fixture);
    const direct = path.resolve(fixture);
    const dir = fs.existsSync(path.join(named, "task.json")) ? named : direct;
    const taskPath = path.join(dir, "task.json");
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
      throw new Error(`experiment fixture not found: ${fixture}`);
    }
    const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    resolveFixtureRepoSource(dir, task);
    return { requested: fixture, name: task.name, dir: path.resolve(dir) };
  });
}

function formatExperimentRow(entry, row) {
  const tag = row.status === "pass" ? "PASS" : row.status === "cheated" ? "CHEAT" : row.status === "error" ? "ERROR" : row.status === "expectation-miss" ? "MISS" : "FAIL";
  return `${tag}  r${entry.round} ${entry.arm} ${row.name} (${row.turns} turns, ${row.invalid} invalid, ${row.protocolViolations} protocol, ${row.durationMs}ms)${row.artifactPath ? `  ${row.artifactPath}` : ""}${row.error ? `  ${row.error}` : ""}`;
}

function cliModelOptions(overrides = {}) {
  return {
    endpoint: args.endpoint,
    profile: args.profile,
    temperature: args.temperature ? Number(args.temperature) : undefined,
    actTemperature: typeof args["act-temperature"] === "string" ? Number(args["act-temperature"]) : undefined,
    topP: args["top-p"] ? Number(args["top-p"]) : undefined,
    topK: args["top-k"] ? Number(args["top-k"]) : undefined,
    // OpenAI-compatible transport: point at an existing /v1 server by URL. Flags
    // and env win; otherwise fall back to a config saved by `bantam doctor --api-url`.
    apiUrl: typeof args["api-url"] === "string" ? args["api-url"] : (savedApi?.apiUrl ?? undefined),
    apiKey: typeof args["api-key"] === "string" ? args["api-key"] : (savedApi?.apiKey ?? undefined),
    model: typeof args.model === "string" ? args.model : (savedApi?.model ?? undefined),
    apiDialect: typeof args["api-dialect"] === "string" ? args["api-dialect"] : (savedApi?.dialect ?? undefined),
    ...overrides,
  };
}

// ── serve (web UI on localhost / LAN) ───────────────────────────────────

async function serveCommand() {
  if (args.help) {
    console.log(`Usage: bantam serve [--port 4173] [--host 0.0.0.0] [--workspace .] [--verify "..."] [--token X]

Host a phone-friendly web UI that drives BANTAM. Type a task, watch it work turn by turn.
The API is gated by a token (printed on start). Runs execute shell in BANTAM's sandbox — use on a trusted network only.`);
    return;
  }
  const host = typeof args.host === "string" ? args.host : "0.0.0.0";
  const port = Number(args.port) || 4173;
  let workspace = path.resolve(args.workspace || ".");
  try { if (!fs.statSync(workspace).isDirectory()) { console.error(`workspace is not a directory: ${workspace}`); process.exit(2); } }
  catch { console.error(`workspace is not a directory: ${workspace}`); process.exit(2); }
  const token = (typeof args.token === "string" && args.token) || process.env.BANTAM_WEB_TOKEN || randomBytes(9).toString("base64url");
  const think = normalizeThinkMode(args.think === undefined ? "auto" : args.think);
  const shortDir = (d) => { const h = os.homedir(); return h && d.startsWith(h) ? "~" + d.slice(h.length) : d; };

  let ep = typeof args.endpoint === "string" ? args.endpoint : null;
  if (!ep) { try { ep = await detectEndpoint(); } catch { ep = null; } }

  // KB stats for the header, recomputed on every workspace change. buildGrounding walks the whole
  // tree synchronously and is NOT cycle-safe, so a huge folder or a symlink loop would peg the single
  // event loop and freeze the server. Pre-scan with hard caps + a realpath cycle guard; bail to null
  // (header shows "—") on anything pathological so the server always stays responsive.
  const KB_SKIP = new Set(["node_modules", ".git", ".hg", ".svn", ".bantam"]);
  const treeIsSmallEnough = (root) => {
    const seen = new Set();
    let files = 0, dirs = 0;
    const stack = [root];
    while (stack.length) {
      if (dirs++ > 4000) return false;
      const dir = stack.pop();
      let real; try { real = fs.realpathSync(dir); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isDirectory()) { if (!KB_SKIP.has(e.name)) stack.push(path.join(dir, e.name)); }
        else if (++files > 6000) return false;
      }
    }
    return true;
  };
  const computeKb = (ws) => {
    try {
      if (!treeIsSmallEnough(ws)) return null;   // too big / cyclic — skip KB, keep the server alive
      const g = buildGrounding(ws);
      return { files: g.stats.files || 0, defines: g.db.count("defines"), depends: g.db.count("depends") };
    } catch { return null; }
  };
  let kb = computeKb(workspace);

  // Resolve a path from the picker/manual entry: ~ expands home; absolute stays; relative is vs the current dir.
  const resolvePath = (d) => {
    d = String(d || "").trim();
    if (!d) return workspace;
    if (d === "~" || d.startsWith("~/")) d = os.homedir() + d.slice(1);
    return path.resolve(workspace, d);
  };
  const listDir = (dir) => {
    const base = dir ? resolvePath(dir) : workspace;
    try {
      if (!fs.statSync(base).isDirectory()) return { error: "not a directory", dir: base };
      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => { try { return e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(base, e.name)).isDirectory()); } catch { return false; } })
        .map((e) => e.name).sort((a, b) => a.localeCompare(b))
        .map((n) => ({ name: n, path: path.join(base, n) }));
      const parent = path.dirname(base);
      return { dir: base, parent: parent !== base ? parent : null, current: workspace, entries };
    } catch (e) { return { error: e.code === "EACCES" ? "permission denied" : e.message, dir: base }; }
  };
  const setWorkspace = (dir) => {
    const target = resolvePath(dir);
    try { if (!fs.statSync(target).isDirectory()) return { ok: false, error: "not a directory" }; }
    catch { return { ok: false, error: "no such directory" }; }
    workspace = target; kb = computeKb(workspace);
    return { ok: true, workspace: shortDir(workspace), path: workspace, kb };
  };

  const verifyDefault = typeof args.verify === "string" ? args.verify : "";
  let modelId = null;
  const getStatus = async () => {
    if (!modelId && ep) modelId = await fetchModelId(ep, 2500).catch(() => null);
    return { model: modelId || (ep ? "local model" : "no model server"), workspace: shortDir(workspace), endpoint: ep, kb, verify: verifyDefault };
  };
  const runTask = async ({ task, verify, maxTurns, signal }, onEvent) => {
    const rep = ep || (await detectEndpoint().catch(() => null));
    if (!rep) return { pass: false, status: "endpoint-unreachable", turns: 0, durationMs: 0 };
    const client = new ModelClient(cliModelOptions({ endpoint: rep }));
    const t0 = Date.now();
    // A `respond` action is a conversational answer (a greeting, a question) — no workspace change,
    // so verify/pass don't apply; report it as "answered" so the UI shows the reply, not a verdict.
    let responded = false;
    const watch = (e) => { if (e.type === "action" && e.action?.a === "respond") responded = true; onEvent(e); };
    // Grounding also walks the tree; gate it on the same size/cycle guard so a run against a
    // huge or symlink-looped workspace can't freeze the loop (it just runs without the KB).
    const useGround = !args["no-ground"] && treeIsSmallEnough(workspace);
    const res = await runAgent({
      task, workspace, model: client, maxTurns: maxTurns || 30,
      verificationScript: verify || null, thinkMode: think,
      grounding: useGround, interactive: false, signal, onEvent: watch,
    });
    const durationMs = Date.now() - t0;
    if (responded && res.reachedDone) return { pass: true, status: "answered", turns: res.metrics.turns, durationMs };
    const pass = res.reachedDone && (!verify || res.verification?.status === "pass");
    const status = res.reachedDone
      ? (verify ? (res.verification?.status ?? "unknown") : "done")
      : (res.metrics.turns >= (maxTurns || 30) ? "turn-limit" : "incomplete");
    return { pass, status, turns: res.metrics.turns, durationMs };
  };

  let server;
  try { server = await startBantamServer({ host, port, token, getStatus, runTask, listDir, setWorkspace }); }
  catch (e) { console.error(`could not start server on ${host}:${port} — ${e.message}`); process.exit(1); }

  const url = (h) => `http://${h}:${port}/?t=${token}`;
  console.log(`\n  \x1b[1;38;2;224;168;60mBANTAM\x1b[0m web UI — serving ${shortDir(workspace)}`);
  console.log(`  model: ${ep ? (modelId || ep) : "\x1b[38;2;229;86;75mno model server reachable\x1b[0m (runs will retry detection)"}`);
  console.log(`\n  local:  ${url("localhost")}`);
  for (const a of lanAddresses()) console.log(`  phone:  ${url(a)}`);
  console.log(`\n  token ${token} — the API is unreachable without it.`);
  console.log(`  runs execute shell in the sandbox; keep this on a trusted network. Ctrl-C to stop.\n`);

  await new Promise((resolve) => {
    const stop = () => { try { server.close(); } catch { /* */ } resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

// ── exec (headless print mode) ──────────────────────────────────────────

function emitExecResult(json, { pass, status, turns = 0, durationMs = 0, error = null }) {
  if (json) {
    const result = { type: "result", pass, status, turns, durationMs };
    if (error) result.error = error;
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`RESULT ${pass ? "pass" : "fail"} ${status}${error ? ` ${error}` : ""}`);
}

async function execCommand() {
  const json = args.json === true;
  const startTime = Date.now();
  const finish = (code, status, { pass = false, turns = 0, error = null } = {}) => {
    emitExecResult(json, {
      pass,
      status,
      turns,
      durationMs: Date.now() - startTime,
      error,
    });
    process.exit(code);
  };
  const usageError = (error) => finish(2, "usage-error", { error });

  const supportedOptions = new Set([
    "help", "json", "workspace", "verify", "max-turns", "endpoint",
    "profile", "temperature", "act-temperature", "top-p", "top-k", "think",
    "ground", "no-ground", "shell-network",
  ]);
  const unknown = Object.keys(args).find((key) => key !== "_" && !supportedOptions.has(key));
  if (unknown) usageError(`unknown option --${unknown}`);

  const task = args._[1];
  if (!task || args._.length !== 2) usageError("exec requires exactly one quoted task text");

  const valueOptions = [
    "workspace", "verify", "max-turns", "endpoint", "profile", "temperature",
    "act-temperature", "top-p", "top-k", "think",
  ];
  const missingValue = valueOptions.find((name) => args[name] === true);
  if (missingValue) usageError(`--${missingValue} requires a value`);

  const workspace = path.resolve(args.workspace || ".");
  try {
    if (!fs.statSync(workspace).isDirectory()) usageError(`workspace is not a directory: ${workspace}`);
  } catch (error) {
    usageError(error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? `workspace is not a directory: ${workspace}`
      : `cannot use workspace ${workspace}: ${error.message}`);
  }

  const maxTurns = args["max-turns"] === undefined ? 30 : Number(args["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) usageError("--max-turns must be a positive integer");
  for (const name of ["temperature", "act-temperature", "top-p", "top-k"]) {
    if (args[name] !== undefined && !Number.isFinite(Number(args[name]))) {
      usageError(`--${name} must be a number`);
    }
  }

  const verify = args.verify;
  const endpoint = args.endpoint;
  let execThinkMode;
  try {
    execThinkMode = normalizeThinkMode(args.think === undefined ? "auto" : args.think);
  } catch (error) {
    usageError(error.message);
  }

  // Resolve endpoint
  let ep = endpoint;
  if (!ep) {
    try {
      ep = await detectEndpoint();
    } catch {
      finish(3, "endpoint-unreachable");
    }
  }

  let client;
  try {
    client = new ModelClient(cliModelOptions({ endpoint: ep }));
    if (!(await client.health())) finish(3, "endpoint-unreachable");
  } catch {
    finish(3, "endpoint-unreachable");
  }

  // Run the agent — headless: no banner, no rooster, no TUI
  let currentTurn = 0;
  const onEvent = (e) => {
    if (e.type === "turn_start" && Number.isInteger(e.turn)) currentTurn = e.turn;
    const turn = Number.isInteger(e.turn) ? e.turn : currentTurn;
    if (json) {
      const ev = { type: "event", event: e.type, turn };
      if (e.action?.a) ev.action = e.action.a;
      if (e.observation) ev.obs = String(e.observation).slice(0, 200);
      console.log(JSON.stringify(ev));
    } else if (e.action) {
      console.log(`  turn ${turn}: ${describeAction(e.action)}`);
    }
  };

  try {
    const res = await runAgent({
      task,
      workspace,
      model: client,
      maxTurns,
      verificationScript: verify || null,
      thinkMode: execThinkMode,
      grounding: !args["no-ground"],
      interactive: false,
      onEvent,
    });

    const pass = res.reachedDone && (!verify || res.verification?.status === "pass");
    const status = res.reachedDone
      ? (verify ? (res.verification?.status ?? "unknown") : "done")
      : (res.metrics.turns >= maxTurns ? "turn-limit" : "incomplete");

    finish(pass ? 0 : 1, status, { pass, turns: res.metrics.turns });
  } catch (err) {
    finish(1, "error", { error: err.message });
  }
}

function fixturesRoot() {
  return path.join(repoRoot(), "fixtures");
}

function defaultFixtures() {
  const root = fixturesRoot();
  if (!fs.existsSync(root)) return [];
  // A fixture is a directory with a task.json. Skip anything else under fixtures/
  // — shared grader helpers (fixtures/_grader-lib) and stray output dirs are not
  // runnable and used to crash no-arg eval on a missing task.json.
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "task.json")));
}

function printResult(res) {
  console.log("\n=== result ===");
  console.log(`reached done: ${res.reachedDone}`);
  if (res.modelFailure) {
    const kind = res.modelFailure.timeoutKind ? ` (${res.modelFailure.timeoutKind})` : "";
    console.log(`model failure${kind}: ${res.modelFailure.message}`);
  }
  if (res.summary) console.log(`summary: ${res.summary}`);
  if (res.verification) console.log(`verification: ${res.verification.status}${res.verification.exitCode !== undefined ? ` (exit ${res.verification.exitCode})` : ""}`);
  const m = res.metrics;
  console.log(`turns: ${m.turns}, invalid: ${m.invalid}, protocol: ${m.protocolViolations ?? 0}, tokens: ${m.tokens}, ${m.durationMs}ms`);
  console.log(`actions: ${JSON.stringify(m.actions)}`);
  for (const warning of res.warnings ?? []) {
    console.log(`unverified (${warning.gate}): ${warning.message}`);
  }
}

function harnessGit() {
  const root = repoRoot();
  try {
    return captureHarnessState(root);
  } catch {
    return emptyHarnessState();
  }
}

function repoRelative(filePath) {
  const root = repoRoot();
  return path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
}

function repoRoot() {
  return repoRootFromCli(import.meta.url);
}

// Concise, human-facing stream for interactive use: one dim line per action, and the OUTPUT
// of shell commands (test results, errors) — which is what a person actually wants to watch.
// Reading a file back or echoing "wrote 40 bytes" is noise, so those observations are skipped.
// One short, human-readable label for any action — also used for each op inside an
// `inspect` batch, so the feed shows WHAT the model is reading, not just "inspect (6 ops)".
function describeAction(a) {
  switch (a.a) {
    case "read_file": return (a.start || a.limit)
      ? `read ${a.p} (lines ${a.start || 1}–${a.limit ? (a.start || 1) + a.limit - 1 : "end"})`
      : `read ${a.p}`;
    case "list_dir": return `list ${a.p || "."}`;
    case "search": return `search /${a.q}/${a.p ? ` in ${a.p}` : ""}`;
    case "write_file": return `write ${a.p}`;
    case "replace": return `edit ${a.p}`;
    case "patch": { const n = (a.edits || []).length; return `patch ${a.p ? a.p + " " : ""}(${n} edit${n === 1 ? "" : "s"})`; }
    case "delete_file": return `delete ${a.p}`;
    case "move_file": return `move ${a.from} → ${a.to}`;
    case "query": return formatQueryAction(a.q);
    case "shell": return `$ ${String(a.c || "").replace(/\s+/g, " ").slice(0, 100)}`;
    case "inspect": {
      const ops = (a.ops || []).map(describeAction);
      return ops.length ? `inspect: ${ops.join("  ·  ")}` : "inspect";
    }
    default: return a.a;
  }
}

// Word-wrap text to the terminal width instead of hard-slicing it, so a long line
// (a harness note, a reasoning glimpse, command output) is never cut mid-sentence.
function wrapForTerminal(s, pad = 6) {
  const width = Math.max(50, (process.stdout.columns || 100) - pad);
  const lines = [];
  for (const raw of String(s).split("\n")) {
    if (raw.length <= width) { lines.push(raw); continue; }
    let cur = "";
    for (const w of raw.split(" ")) {
      if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
      while (cur.length > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

// Turn the current activity phase (set by the agent's "activity" events) into a heartbeat
// label, so a long wait says WHAT the model is doing instead of a blank "working…".
function activityLabel(activity) {
  const detail = activity && activity.detail;
  const cmd = detail ? (detail.length > 70 ? detail.slice(0, 70) + "…" : detail) : "";
  const phase = activity && activity.label;
  if (roosterOn) {   // a little rooster flavor on the heartbeat, still saying WHAT it's doing
    switch (phase) {
      case "thinking": return cmd ? `scratching at it… (${cmd})` : "scratching at it…";
      case "generating": return cmd ? `pecking out: ${cmd}` : "lining up the next peck…";
      case "running": return cmd ? `pecking at: ${cmd}` : "pecking at the shell…";
      case "verifying": return "pecking at the verifier…";
      default: return "pecking around…";
    }
  }
  switch (phase) {
    case "thinking": return cmd ? `thinking… (${cmd})` : "thinking…";
    case "generating": return cmd ? `writing: ${cmd}` : "composing the next step…";
    case "running": return cmd ? `running: ${cmd}` : "running a command…";
    case "verifying": return "running the verifier…";
    default: return "working…";
  }
}

// A fleeting micro-crow when a request lands well. Interactive terminal only, and it clears itself
// so nothing piles up in the scrollback. A decoration must never break the loop, so failures are swallowed.
async function roosterCrow() {
  if (!roosterOn || !process.stdout.isTTY || !USE_COLOR) return;
  try { await playAnimation("crow", { set: "micro", loops: 2, fps: 6, indent: 2, clearAfter: true }); }
  catch { /* the rooster stumbled; carry on */ }
}

// `:help` — what you can do inside the interactive session.
function printReplHelp() {
  const cmd = (s) => paint(C.beak, s);
  const dim = (s) => paint(C.dim, s);
  const row = (c, d) => `    ${cmd(c)}${" ".repeat(Math.max(2, 20 - c.length))}${dim(d)}`;
  console.log([
    "",
    paint(`1;${C.plume}`, "  bantam — what you can do here"),
    "",
    "  Just say what you want in plain language and I'll work on it.",
    "",
    dim("  while I'm working"),
    row("type a line + ↵", "steer the next step without stopping"),
    row("Ctrl-C", "stop the current model or shell action"),
    "",
    dim("  commands"),
    row(":model [n]", "list models, or switch to model n"),
    row(":rooster [on|off]", "toggle the rooster antics (labels + crow)"),
    row(":help  ?", "show this help"),
    row("exit  quit  :q", "leave the session"),
    "",
    dim("  tips"),
    dim("    · drop an image path (shot.png) in a request — I'll view it if a vision model is loaded"),
    dim("    · run `bantam strut` from your shell for the full rooster show"),
    "",
  ].join("\n"));
}

function makeInteractiveLogger(emit, activity = {}) {
  const out = emit || ((s) => process.stdout.write(s + "\n"));
  const dim = (s) => paint(C.dim, s);
  let lastAction = null;
  let liveShellChars = 0;
  let liveShellOutputSeen = false;
  let liveShellTruncated = false;
  const LIVE_SHELL_CHAR_LIMIT = 12_000;
  return (e) => {
    if (e.type === "activity") {   // phase signal for the heartbeat; nothing printed
      activity.label = e.label;
      activity.detail = e.detail || null;
      return;
    }
    if (e.type === "image_generation_started") {
      activity.label = "rendering images";
      activity.detail = `0/${e.variants} workers finished`;
      return;
    }
    if (e.type === "image_generation_heartbeat") {
      activity.label = "rendering images";
      activity.detail = `${e.completed}/${e.variants} workers finished`;
      return;
    }
    if (e.type === "image_generation_finished") {
      activity.label = "generating";
      activity.detail = null;
      return;
    }
    if (e.type === "action") {
      const a = e.action;
      lastAction = a.a;
      if (a.a === "shell") {
        liveShellChars = 0;
        liveShellOutputSeen = false;
        liveShellTruncated = false;
      }
      // `done`/`respond` carry the final reply, which the REPL prints itself.
      const line = (a.a === "done" || a.a === "respond") ? null : describeAction(a);
      // Quiet by default; edits get plume, shell/query get beak — so changes and commands scan.
      if (line) {
        const col = EDIT_VERBS.has(a.a) ? C.plume : (a.a === "shell" || a.a === "query") ? C.beak : C.dim;
        out(`  ${paint(col, line)}`);
      }
    } else if (e.type === "shell_output" && lastAction === "shell") {
      if (liveShellTruncated) return;
      const clean = safeShellOutput(e.text);
      if (!clean) return;
      const remaining = LIVE_SHELL_CHAR_LIMIT - liveShellChars;
      const shown = clean.slice(0, Math.max(0, remaining));
      liveShellChars += shown.length;
      liveShellOutputSeen = liveShellOutputSeen || Boolean(shown);
      const prefix = e.stream === "stderr" ? "stderr │ " : "│ ";
      for (const l of wrapForTerminal(shown)) out(`    ${dim(prefix + l)}`);
      if (shown.length < clean.length || liveShellChars >= LIVE_SHELL_CHAR_LIMIT) {
        liveShellTruncated = true;
        out(`    ${dim("… live command output capped; the final result remains bounded")}`);
      }
    } else if (e.type === "observation") {
      const obs = String(e.observation || "").trim();
      if (!obs) return;
      if (obs.startsWith("[")) {
        // BANTAM's own guidance to the model (budget/gate/interjection notes). Show it
        // in FULL, wrapped — never truncated — so you can read what it told the model.
        const text = obs.length > 2000 ? obs.slice(0, 2000) + " …" : obs;
        for (const l of wrapForTerminal(text)) out(`    ${dim(l)}`);
      } else if (lastAction === "shell") {
        // Real command output is streamed while it runs. Keep the final observation authoritative,
        // but avoid printing the same stdout/stderr twice: retain command/cwd/sandbox/exit metadata
        // plus timeout/interruption guidance. Commands that emitted nothing still use the old path.
        let finalText = obs;
        if (liveShellOutputSeen && !liveShellTruncated) {
          const lines = obs.split("\n");
          const exitAt = lines.findIndex((line) => /^exit \d+/.test(line));
          const head = exitAt >= 0 ? lines.slice(0, exitAt + 1).join("\n") : lines[0];
          const noteAt = lines.findIndex((line) => /^\[(?:timeout|interrupted)\]/.test(line));
          finalText = noteAt >= 0 ? `${head}\n${lines.slice(noteAt).join("\n")}` : head;
        }
        const wrapped = wrapForTerminal(finalText);
        const cap = 14;
        for (const l of wrapped.slice(0, cap)) out(`    ${dim(l)}`);
        if (wrapped.length > cap) out(`    ${dim(`… (+${wrapped.length - cap} more line${wrapped.length - cap === 1 ? "" : "s"})`)}`);
      }
    } else if (e.type === "thinking") {
      // a glimpse of the model's reasoning — wrapped, not cut mid-word
      const text = String(e.text || "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
      if (text) {
        const glimpse = text.length > 280 ? text.slice(0, 280).replace(/\s+\S*$/, "") + " …" : text;
        const wrapped = wrapForTerminal(glimpse);
        out(`  ${dim("· " + (wrapped[0] || ""))}`);
        for (const l of wrapped.slice(1)) out(`    ${dim(l)}`);
      }
    } else if (e.type === "verification") {
      const label = e.verification.status === "pass" ? "passed" : e.verification.status;
      out(`  ${dim(`verifier ${label}`)}`);
    } else if (e.type === "skills_used") {
      // Once per skill per run: explains why the model suddenly knows an approach.
      out(`  ${dim(`recalling skill: ${e.skills.join(", ")}`)}`);
    } else if (e.type === "skill_learned") {
      out(`  ${dim(`learned skill: ${e.skill}`)}`);
    } else if (e.type === "invalid") {
      // A malformed action costs a silent retry otherwise — say so (observed: minutes of
      // heartbeats while truncated big-write JSON was re-generated with no visible reason).
      if (e.kind === "output_limit") {
        out(`  ${paint("33", "✗ output limit")}${dim(`${e.target ? ` while writing ${e.target}` : ""} — steering to smaller incremental edits`)}`);
      } else {
        out(`  ${paint("33", "✗ malformed action, retrying")}${e.error ? dim(` — ${String(e.error).slice(0, 90)}`) : ""}`);
      }
    } else if (e.type === "context_trim") {
      out(`  ${dim("(context trimmed to fit the model window — continuing)")}`);
    }
  };
}

// Interactive REPL — the default `bantam` experience. You type a request, it works on the
// current directory (workspace persists across requests, and a short session log gives it
// memory of what it already did), it shows what it's doing, then waits for the next request.
async function repl() {
  const workspace = path.resolve(args.workspace || ".");
  if (args.verify === true) fail("--verify requires a command");
  let verificationScript = typeof args.verify === "string" ? args.verify : null;
  if (!(await model.health())) {
    console.error(`Can't reach the model at ${model.endpoint}.\nStart your llama.cpp server (or pass --endpoint URL) and try again.`);
    process.exit(1);
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const IDLE_PROMPT = `${paint(`1;${C.comb}`, "bantam")} ${paint(C.plume, "❯")} `;
  rl.setPrompt(IDLE_PROMPT);

  // No verifier set? A change graded by the project's own tests is what makes a
  // small model trustworthy — so detect the test command and offer to attach it.
  // Interactive only (like offer-to-launch); --no-autoverify or BANTAM_NO_AUTOVERIFY skips it.
  if (!verificationScript && tty && !args["no-autoverify"] && !envTruthy("BANTAM_NO_AUTOVERIFY")) {
    const detected = detectVerifier(workspace);
    if (detected) {
      const ans = await new Promise((res) => rl.question(
        `${paint(C.dim, "No verifier set. Found a test command:")} ${paint(C.beak, detected.command)} ${paint(C.dim, `(${detected.source})`)}\n`
        + `${paint(C.dim, "Grade every change with it before calling a result done?")} ${paint(C.plume, "[Y/n]")} `, res));
      if (!/^n(o)?$/i.test(ans.trim())) {
        verificationScript = detected.command;
        console.log(paint(C.good, `✔ verifier: ${detected.command}`) + paint(C.dim, "  (override with --verify \"...\", or start with --no-autoverify)"));
      } else {
        console.log(paint(C.dim, "No verifier — changes won't be graded. Attach one any time with --verify."));
      }
    }
  }

  // While a request runs, the prompt itself pulses so it's obvious Bantam is alive even between
  // heartbeat lines: "bantam ⠹ working ❯ " — spinner rotating, the verb tracking the actual phase
  // (thinking / writing / running / verifying). Typed input survives every repaint (steer mid-run).
  const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinFrame = 0;
  const workingWord = () => ({
    thinking: "thinking", generating: "writing", running: "running", verifying: "verifying",
  })[activity.label] ?? "working";
  const runningPrompt = () => {
    const spinner = SPIN_FRAMES[spinFrame++ % SPIN_FRAMES.length];
    const word = spinFrame % 8 < 4 ? paint("1", workingWord()) : paint("2", workingWord()); // pulse bold/dim
    return `${paint(`1;${C.comb}`, "bantam")} ${paint(C.beak, spinner)} ${word} ${paint(C.plume, "❯")} `;
  };

  let running = false;       // a request is currently executing
  let aborted = false;       // user hit Ctrl-C during a run
  let activeRunController = null;
  let injections = [];       // messages typed mid-run, to steer the next turn
  let resolveRequest = null; // resolver for the idle "waiting for a request" promise
  let closed = false;
  const pending = [];        // requests that arrived while busy (or buffered non-TTY input)
  let lastOutputAt = Date.now();

  // Print a line. During a run on a real terminal, render it ABOVE the input line so the
  // prompt (and anything the user is mid-typing) stays put at the bottom.
  const emit = (text) => {
    lastOutputAt = Date.now();
    if (running && tty) {
      emitAboveInput(rl, process.stdout, text);
    } else {
      process.stdout.write(text + "\n");
    }
  };
  const activity = { label: null, detail: null };
  const logger = makeInteractiveLogger(emit, activity);

  rl.on("line", (line) => {
    const s = line.trim();
    if (running && tty) {                     // typed mid-run on a terminal -> steer
      if (s) {
        injections.push(s);
        const state = activity.label === "running"
          ? "queued for the next step (current command keeps running; Ctrl-C stops it)"
          : "queued for the next step";
        emit(paint("2", `  ↪ ${state}: ${s}`));
      }
      return;
    }
    if (resolveRequest) { const r = resolveRequest; resolveRequest = null; r(s); }
    else pending.push(s);                      // arrived while busy / buffered pipe input
  });
  rl.on("SIGINT", () => {
    if (running) {
      if (!aborted) emit(paint("33", "  ⏸ stopping the current operation…"));
      aborted = true;
      activeRunController?.abort();
    }
    else { closed = true; if (resolveRequest) { const r = resolveRequest; resolveRequest = null; r(null); } else rl.close(); }
  });
  rl.on("close", () => { closed = true; if (resolveRequest) { const r = resolveRequest; resolveRequest = null; r(null); } });

  console.log(renderBanner({ profileName: model.profileName, workspace, verify: verificationScript, tty }));

  const sessionLog = [];
  const nextRequest = () => {
    if (pending.length) return Promise.resolve(pending.shift());
    if (closed) return Promise.resolve(null);
    // A draft may already be buffered from typing during the previous run. Bare
    // rl.prompt() resets readline's logical cursor to column 0, so the next key
    // would be inserted at the beginning of that draft.
    return new Promise((res) => { resolveRequest = res; redrawInput(rl); });
  };

  // `:model` — list registered models (with running/vision status) and switch between them live.
  async function handleModelCommand(arg) {
    const models = await modelStatus();
    if (!models.length) { console.log("  No models registered (set BANTAM_MODELS or ./.bantam/models.json)."); return; }
    if (!arg) {
      console.log("  Models:");
      models.forEach((m, i) => console.log(
        `    [${i + 1}] ${m.label}${m.vision ? " [vision]" : ""}${m.running ? "  (running)" : ""}${m.endpoint === model.endpoint ? "  ← current" : ""}`));
      console.log("  Switch with :model <number>.");
      return;
    }
    const target = models[Number(arg) - 1];
    if (!target) { console.log(`  No model #${arg}. Use :model to list.`); return; }
    const ok = await switchToModel(model, target, { out: (s) => process.stdout.write(s) });
    if (!ok) console.log("  Switch failed (couldn't start the server).");
  }

  for (;;) {
    const raw = await nextRequest();
    if (raw === null) break;                    // EOF / Ctrl-C at the prompt
    const request = String(raw).trim();
    if (!request) continue;
    if (["exit", "quit", ":q"].includes(request.toLowerCase())) break;

    // `:help` / `/help` / `?` — the in-session command list.
    if (/^(?::help|\/help|:h|help|\?)$/i.test(request)) { printReplHelp(); continue; }

    // `:model` / `:models` — list registered models and switch between them in-session.
    if (/^:models?\b/i.test(request)) {
      await handleModelCommand(request.replace(/^:models?\b\s*/i, "").trim());
      continue;
    }

    // `:rooster [on|off]` — toggle the rooster antics (mood labels + crow) live. Bare `:rooster` flips it.
    if (/^:rooster\b/i.test(request)) {
      const arg = request.replace(/^:rooster\b\s*/i, "").trim().toLowerCase();
      roosterOn = arg === "on" ? true : arg === "off" ? false : !roosterOn;
      console.log(paint("2", `  rooster ${roosterOn ? "on — he'll crow when work lands" : "off — plain status, no crow"}`));
      if (roosterOn && tty && USE_COLOR) await roosterCrow();
      continue;
    }

    // Image task but the current model has no vision? Offer to load a vision model (interactive only).
    if (tty && /[\w./-]+\.(?:png|jpe?g|gif|webp|bmp)\b/i.test(request) && !(await endpointHasVision(model.endpoint))) {
      const vm = firstVisionModel();
      if (vm) {
        emit(paint("33", `  ⓘ Image task, but the current model has no vision. Load ${vm.label} and switch to it? [y/N]`));
        const ans = await nextRequest();               // read y/N as the next line
        if (ans === null) break;
        if (/^\s*y/i.test(String(ans))) {
          await switchToModel(model, vm, { out: (s) => process.stdout.write(s) });
        } else {
          emit(paint("2", "  continuing without vision."));
        }
      }
    }

    let task = request;
    if (sessionLog.length) {
      const ctx = sessionLog.slice(-6).map((s) => `- you asked: "${s.request}" → I: ${s.summary}`).join("\n");
      task = `Session so far (context only; the workspace already reflects this work):\n${ctx}\n\nNew request: ${request}`;
    }

    running = true; aborted = false; injections = [];
    activeRunController = new AbortController();
    const t0 = Date.now();
    const hb = tty ? setInterval(() => {
      if (Date.now() - lastOutputAt > 5000) emit(paint("2", `  · ${activityLabel(activity)} (${Math.round((Date.now() - t0) / 1000)}s)`));
    }, 5000) : null;
    // The pulsing working-prompt: repaint the prompt line (input buffer preserved) a few times a
    // second so the session visibly breathes between output lines.
    const spin = tty ? setInterval(() => {
      redrawInput(rl, runningPrompt());
    }, 250) : null;
    let res = null, err = null;
    // Snapshot at request start so skill distillation can mint (it requires an integrity-clean
    // verdict; without this, --skills in the REPL silently never learned). Fresh per request —
    // the workspace legitimately evolves between requests, and the baseline is "state at ask".
    const skillSnapshot = skillsCfg ? snapshotTree(workspace) : null;
    try {
      res = await runAgent({
        task, workspace, model,
        // Generous by default so a real build can run to completion; small tasks finish in a
        // few turns. Override with --max-turns or BANTAM_MAX_TURNS; Ctrl-C interrupts.
        maxTurns: args["max-turns"] ? Number(args["max-turns"]) : (Number(process.env.BANTAM_MAX_TURNS) || 200),
        verificationScript,
        verificationPolicy: "after_edit",
        thinkMode, skills: skillsCfg, planMode,
        postVerifyIntegrity: skillSnapshot ? () => checkWorkspace(skillSnapshot, workspace, {}) : null,
        preGate: !args["no-pregate"],
        interactive: true,
        grounding: !args["no-ground"],   // datalog KB: code map + reject reads/edits of missing files
        signal: activeRunController.signal,
        shouldAbort: () => aborted,
        drainInjections: () => { const q = injections; injections = []; return q; },
        onEvent: logger,
      });
    } catch (e) {
      err = e;
    } finally {
      if (hb) clearInterval(hb);
      if (spin) {
        clearInterval(spin);
        rl.setPrompt(IDLE_PROMPT);           // back to the calm prompt before the result prints
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
      }
      activeRunController = null;
      running = false;
    }

    // A line typed near completion, interruption, or an infrastructure pause may not have reached
    // runAgent's between-turn drain. Keep the promise made by the "queued" acknowledgement: treat
    // every undelivered line as the next request instead of silently dropping it.
    if (injections.length) {
      pending.splice(0, 0, ...injections);
      injections = [];
    }

    // Result prints via the plain path now that the run is over.
    const secs = res ? ((Date.now() - t0) / 1000).toFixed(0) : "0";
    const meta = res ? paint("2", `(${res.metrics.turns} turns, ${secs}s)`) : "";
    const verdict = res ? classifyInteractiveResult(res) : null;
    if (verdict && (verdict.kind === "success" || verdict.kind === "response")) await roosterCrow();
    if (err) {
      console.log(`\n${paint("31", "✗")} ${err.message}\n`);
    } else if (verdict.kind === "interrupted") {
      console.log(`\n${paint("33", "⏸")} Stopped. ${paint("2", 'Workspace is saved — give a new instruction or say "keep going".')} ${meta}\n`);
      sessionLog.push({ request, summary: "(interrupted by you)" });
    } else if (verdict.kind === "blocked") {
      console.log(`\n${paint("33", "⏸ blocked")} ${res.summary || "The environment cannot perform that action safely."} ${meta}\n`);
      sessionLog.push({ request, summary: String(res.summary || "(infrastructure blocked)").replace(/\s+/g, " ").slice(0, 220) });
    } else if (verdict.kind === "verification_failed") {
      console.log(`\n${paint("31", "✗ verification failed")} ${res.summary || "workspace changes did not pass"} ${meta}`);
      for (const line of verificationDetailLines(res.verification?.detail)) {
        console.log(`  ${line}`);
      }
      console.log("");
      sessionLog.push({ request, summary: `${String(res.summary || "work completed").replace(/\s+/g, " ").slice(0, 180)} (configured verifier failed)` });
    } else if (verdict.kind === "verification_unverified") {
      console.log(`\n${paint("33", "⚠ verifier unverified")} ${res.summary || "workspace changes could not be graded"} ${meta}`);
      for (const line of verificationDetailLines(res.verification?.detail)) {
        console.log(`  ${paint("2", line)}`);
      }
      console.log("");
      sessionLog.push({ request, summary: `${String(res.summary || "work completed").replace(/\s+/g, " ").slice(0, 180)} (configured verifier was inconclusive)` });
    } else if (verdict.kind === "response" && res.summary) {
      console.log(`\n${res.summary}\n${meta}\n`);
      sessionLog.push({ request, summary: String(res.summary).replace(/\s+/g, " ").slice(0, 220) });
    } else if (verdict.kind === "paused") {
      const verified = verdict.externallyVerified ? " Verifier passed." : "";
      console.log(`\n${paint("33", "⏸")} Paused at the ${res.metrics.turns}-turn limit${res.summary ? " — " + res.summary : ""}.${verified} ${paint("2", 'Say "keep going" to continue, or raise --max-turns.')} ${meta}\n`);
      sessionLog.push({ request, summary: String(res.summary || "(in progress)").replace(/\s+/g, " ").slice(0, 220) });
    } else if (verdict.kind === "warning") {
      console.log(`\n${paint("33", "⚠ unverified")} ${res.summary || "done"} ${meta}`);
      for (const warning of verdict.warnings) {
        console.log(`  ${paint("33", "•")} ${paint("2", warning.message)}`);
      }
      console.log("");
      sessionLog.push({ request, summary: `${String(res.summary || "done").replace(/\s+/g, " ").slice(0, 200)} (unverified)` });
    } else {
      const verified = verdict.externallyVerified ? ` ${paint("2", "· verifier passed")}` : "";
      console.log(`\n${paint("32", "✓")} ${res.summary || "done"}${verified} ${meta}\n`);
      sessionLog.push({ request, summary: String(res.summary || "done").replace(/\s+/g, " ").slice(0, 220) });
    }
    if (closed) break;
  }
  rl.close();
  console.log("bye");
}

async function auditReplayCommand() {
  const evidencePath = args._[1];
  if (args.help) {
    console.log("usage: bantambuild audit-replay <evidence.json|study-directory> [--artifact run.json] [--json]");
    process.exit(0);
  }
  if (!evidencePath) {
    process.stderr.write("usage: bantambuild audit-replay <evidence.json|study-directory> [--artifact run.json] [--json]\n");
    process.exit(2);
  }
  try {
    const {
      auditReplayExperimentEvidence,
      formatReplayExperimentAudit,
      resolveReplayEvidenceFile,
    } = await import("../src/replay-experiment-audit.js");
    const evidenceFile = resolveReplayEvidenceFile(evidencePath);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    const artifactPath = typeof args.artifact === "string"
      ? path.resolve(args.artifact)
      : path.resolve(path.dirname(evidenceFile), evidence?.artifact?.path);
    const artifactBytes = fs.readFileSync(artifactPath);
    const report = auditReplayExperimentEvidence(evidence, { artifactBytes });
    process.stdout.write(`${args.json
      ? JSON.stringify(report, null, 2)
      : formatReplayExperimentAudit(report)}\n`);
    process.exit(report.status === "pass" ? 0 : 1);
  } catch (error) {
    process.stderr.write(`audit-replay failed: ${error.message}\n`);
    process.exit(1);
  }
}

async function replayAbCommand() {
  const specPath = args._[1];
  if (args.help) {
    console.log("usage: bantambuild replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint url] [--json]");
    process.exit(0);
  }
  if (!specPath) {
    process.stderr.write("usage: bantambuild replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint url] [--json]\n");
    process.exit(2);
  }
  try {
    if (args["dry-run"] === true) {
      const {
        buildReplayExperimentPreflight,
        formatReplayExperimentPreflight,
      } = await import("../src/replay-experiment-preflight.js");
      const report = buildReplayExperimentPreflight({
        specPath,
        endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
        maxCalls: args["max-calls"],
        studyRoots: typeof args["study-root"] === "string" ? [args["study-root"]] : undefined,
        requireNewDesign: args["require-new-design"] === true,
      });
      process.stdout.write(`${args.json
        ? JSON.stringify(report, null, 2)
        : formatReplayExperimentPreflight(report)}\n`);
      process.exit(report.status === "ready" ? 0 : 1);
    }
    const { runReplayExperimentCli } = await import("../src/replay-experiment-cli.js");
    const result = await runReplayExperimentCli({
      specPath,
      output: typeof args.output === "string" ? args.output : undefined,
      endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
      maxCalls: args["max-calls"],
      studyRoots: typeof args["study-root"] === "string" ? [args["study-root"]] : undefined,
      requireNewDesign: args["require-new-design"] === true,
      onProgress: ({ arm, sample }) => {
        process.stderr.write(`replay sample ${sample + 1} · ${arm}\n`);
      },
    });
    process.stdout.write(`${result.summary}\n\nevidence: ${result.outputDir}\n`);
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`replay-ab failed: ${error.message}\n`);
    process.exit(1);
  }
}

async function replayMineCommand() {
  if (args.help) {
    console.log("usage: bantambuild replay-mine [artifact-directory ...] [--untreated] [--uncontrasted] [--coverage FILE --uncovered] [--mode SHA_PREFIX] [--json]");
    process.exit(0);
  }
  try {
    const roots = args._.slice(1);
    const {
      mineReplayCohorts,
      loadReplayCoverage,
      selectReplayFailureMode,
      formatReplayMine,
    } = await import("../src/replay-mine.js");
    let report = mineReplayCohorts({
      roots: roots.length ? roots : [".bantam"],
      untreatedOnly: args.untreated === true,
      uncontrastedOnly: args.uncontrasted === true,
      uncoveredOnly: args.uncovered === true,
      coverage: typeof args.coverage === "string"
        ? loadReplayCoverage(args.coverage)
        : [],
    });
    if (args.mode !== undefined) {
      report = selectReplayFailureMode(report, args.mode);
    }
    await writeReplayMineOutput(`${args.json
      ? JSON.stringify(report, null, 2)
      : formatReplayMine(report)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`replay-mine failed: ${error.message}\n`);
    process.exit(1);
  }
}

function writeReplayMineOutput(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function usage() {
  return `bantambuild [--workspace .] [--verify "npm test"] [--shell-network]
                                  interactive mode (type requests; works on the selected dir)
bantambuild chat                       same as above (explicit)
bantambuild run --task "..." [--workspace . | --lane ID [--state-home DIR]] [--max-turns 30] [--verify "npm test"] [--autonomous] [--ground] [--tui] [--plan] [--skills] [--save-run [path]]
           [--resume-run artifact.json [--through-turn N]] [--review-file evidence.txt]
bantambuild exec [options] "<task text>"   one-shot: run a task, verify, exit (headless, no TUI)
bantambuild eval [fixtureDir ...] [--save-run]
bantambuild experiment spec.json [--output path] [--dry-run]
bantambuild experiment spec.json --resume evidence-directory
bantambuild gauntlet [--models local,sol,terra] [--quick] [--rounds N] [--faults]
                                  isolated same-task model comparison with hidden contracts and full usage metrics
bantambuild trio run --task "..." [--workspace .] [--verify "npm test"] [--models local,sol,terra]
                                  parallel isolated real-task comparison
bantambuild replay <run.json> --turn N [--inject "text"]
bantambuild replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint URL] [--json]
                                  paired exact-turn semantic counterfactual with durable evidence
bantambuild replay-mine [artifact-directory ...] [--untreated] [--uncontrasted] [--coverage FILE --uncovered] [--mode SHA_PREFIX] [--json]
                                  model-free exact-task mixed-outcome specimen discovery
bantambuild audit-replay evidence.json [--artifact run.json] [--json]
                                  independently re-hash and re-score replay evidence
bantambuild analyze [ledger.jsonl ...] [--json] [--all-runs]
bantambuild state init [--source DIR] [--state-home DIR] [--json]
bantambuild channel list|show|history|checkpoint|promote|rollback|materialize ... [--state-home DIR] [--json]
bantambuild channel run regular|dev --lane ID --expected VERSION [--dependency-root DIR] [--state-home DIR] -- [run options]
bantambuild channel experiment regular|dev --lane ID --expected VERSION [--dependency-root DIR] [--state-home DIR] -- spec.json [experiment options]
bantambuild lane create|list|status|checkpoint|fork|materialize ... [--state-home DIR] [--json]
bantambuild bench [fixtureDir ...] [--repeat N]     reliability: grammar ON vs OFF, malformed-output rates
bantambuild skills                     list the learned-skills library
bantambuild health [--endpoint http://localhost:8085]
bantambuild setup [--yes]               one command: install llama-server, download the model, scaffold, launch (= doctor --setup)
bantambuild doctor --api-url URL [--api-key KEY] [--model NAME] [--api-dialect llamacpp|vllm]  use an existing OpenAI-compatible server (validates + saves it)
bantambuild doctor [--launch] [--json]  check setup (Node, model server, GPU, GGUF, registry) and scaffold a start script
bantambuild doctor --install-llama [--yes] [--vulkan]  download a prebuilt llama-server (GPU=Vulkan / CPU) — no build
bantambuild doctor --provision [--yes] [--quant Q4_K_M] [--gguf-url URL]  download the model (default: the 4-bit) from Hugging Face, resumable
bantambuild strut [idle|peck|flap|crow|walk|all] [--micro] [--loops N] [--fps N] [--list]
                                  play the rooster animations in the terminal (Ctrl-C to stop)

--autonomous turns on the unattended-run guardrails (progress gate, premature-done veto,
ledger). Interactive mode leaves them off so the harness just does what you ask.
For autonomous runs, use --ground or BANTAM_GROUND=1 to enable the query socket.

Common model flags: [--endpoint URL] [--profile qwen|gemma|generic] [--think auto|off|always] [--temperature N] [--act-temperature N] [--top-p N] [--top-k N]
More run flags: [--tui] [--title "..."] [--plan] [--skills [path]] [--lang X] [--no-pregate] [--no-ground]

--resume-run restores recorded dialogue through a zero-based turn; it does not
restore filesystem bytes, so --workspace must already match that cursor. Use a
lane fork for an exact historical workspace. --review-file adds one trusted,
hashed reviewer/runtime observation without changing the task string.

--shell-network permits model-chosen Docker commands and browser previews to use networking
(also BANTAM_SHELL_NETWORK=1). It keeps Docker filesystem confinement, but enable it only for a
trusted model and workspace because commands/page code can send mounted workspace data over the
network. Offline Docker and offline preview remain the default.

The rooster (mood labels + a crow when work lands) is on by default. Turn it off with --no-rooster
or BANTAM_NO_ROOSTER=1, toggle it live with :rooster in the REPL, and run \`bantam strut\` to play the
animations any time.`;
}

function envTruthy(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] ?? ""));
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}
