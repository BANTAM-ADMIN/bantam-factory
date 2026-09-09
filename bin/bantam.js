#!/usr/bin/env node
// Bantam CLI.
//
//   bantam run --task "..." [--workspace .] [--max-turns 30] [--verify "npm test"]
//   bantam eval [fixtureDir ...]      run repair fixtures with hidden verification
//   bantam health                     check the local model endpoint
//   bantam strut [anim]               let the rooster loose (idle·peck·flap·crow·walk·all)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { repoRootFromCli } from "../src/repo-root.js";
import { isChangeShapedRequest, runAgent } from "../src/agent.js";
import { runIsAttended } from "../src/attendance.js";
import { openWorkerControl } from "../src/foreman-worker-control.js";
import { ModelClient, detectEndpoint } from "../src/model.js";
import { DEFAULT_SANDBOX_IMAGE } from "../src/executor.js";
import { renderFirstScreen, columnBudget, elideMiddle, visibleWidth } from "../src/logic/first-screen.js";
import { detectCodex } from "../src/logic/codex-detect.js";
import { loadConnection, saveConnection, confirmCodexConsent } from '../src/first-run.js';
import { setupWizard, startManagedStock } from '../src/setup-wizard.js';

// The over-the-ceiling note, once per process. The agent emits grounding_state
// on EVERY request, and in the REPL the same too-large grounding object is
// passed each time — so without this the paragraph would repeat per request.
let kbTooLargeNoted = false;
function noteKbTooLarge(e) {
  if (kbTooLargeNoted) return "";
  kbTooLargeNoted = true;
  return describeTooLarge(e.tooLarge, e.workspace, { cols: process.stdout.columns });
}
import { renderReplHelp } from "../src/logic/repl-help.js";
import { ONBOARDING_KEY, shouldOfferImageOnboarding, imageOnboardingPrompt, imageOnboardingDecision } from "../src/logic/image-onboarding.js";
import { startBantamServer, lanAddresses } from "../src/server.js";
import { buildGrounding, reconcileGrounding, loadGroundingCache, saveGroundingCache, describeTooLarge } from "../src/logic/grounding.js";
import { researchOffer, elicitGaps } from "../src/logic/research-triggers.js";
import { diffClaims, renderClaimDiff } from "../src/logic/claim-diff.js";
import { sampleAnswers, stabilityReport, renderStabilityReport } from "../src/logic/consistency-probe.js";
import { makeStreamRenderer } from "../src/logic/stream-render.js";
import { makeAttendantState, noteAttendantEvent, buildAttendantPrompt } from "../src/logic/attendant.js";
import { loadUserSettings, saveUserSetting } from "../src/logic/user-settings.js";
import { resolveCodexapiConfig, findCodexapiCheckout, bridgeStatus, codexapiChoices, launchBridge } from "../src/codexapi-bridge.js";
import {
  CONTEXT_MODES,
  contextModeEnv,
  contextModeForRequest,
  contextModeFromEnv,
  contextModeIsImmutable,
  describeContextMode,
  normalizeContextMode,
  renderModeLine,
  renderModeSummary,
  renderModeTable,
  resolveContextMode,
  resolveImageMode,
  describeImageMode,
  resolveImageProvider,
  describeImageProvider,
  IMAGE_PROVIDERS,
} from "../src/logic/session-modes.js";
import { randomBytes } from "node:crypto";
import { offerToLaunchModel, modelStatus, switchToModel, startRegisteredModel, endpointHasVision, firstVisionModel, listModels } from "../src/model-launcher.js";
import { execFileSync } from "node:child_process";
import { runChecks, scaffold, renderReport } from "../src/doctor.js";
import { planProvision, downloadResumable, freeDiskBytes, modelsDir, formatBytes, renderProgress, DEFAULT_QUANT } from "../src/provision.js";
import { detectVerifier } from "../src/verifier-detect.js";
import { pickLlamaAsset, findReleaseAsset, findLlamaServer, extractArchive, llamaInstallRoot, RELEASES_LATEST_API } from "../src/llama-install.js";
import { loadApiConfig, saveApiConfig } from "../src/openai-transport.js";
import { formatUsage, formatPrefixReuse } from "../src/model-usage.js";
import { buildExecResult } from "../src/exec-result.js";
import {
  modelUsageBreakdownDelta,
  modelUsageBreakdownSnapshot,
  modelUsageDelta,
  modelUsageSnapshot,
} from "../src/model-usage-snapshot.js";
import {
  codexModelOptions,
  resolveCodexModelAlias,
  resolveCodexReasoningEffort,
} from "../src/codex-models.js";
import {
  loadModelPreference,
  saveModelPreference,
} from "../src/model-preference.js";
import {
  resolveStartupModelChoice,
  startupModelChoices,
} from "../src/startup-model-choice.js";
import { playAnimation, animationNames, loadAnimations, showcaseSequence } from "../src/rooster.js";
import {
  buildArtifact,
  fetchModelId,
  makeRunId,
  makeStamp,
  saveArtifact,
} from "../src/artifact.js";
import { RunCheckpoint, attachModelRequestCheckpoint } from "../src/run-checkpoint.js";
import { captureFinalDiff, prepareDiffBaseline } from "../src/diff.js";
import { buildSessionTask, extractNextStep, isStatusQuestion } from "../src/continuation.js";
import { beginChatEvidence } from "../src/chat-evidence.js";
import { loadOperatorProfile } from "../src/operator-profile.js";
import { EDIT_ACTIONS } from "../src/edit-actions.js";
import { captureHarnessState, emptyHarnessState } from "../src/harness-state.js";
import { snapshotTree, checkWorkspace, graderTampering, graderSnapshot } from "../src/scope-guard.js";
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
import {
  createGauntletSpec,
  GAUNTLET_FIXTURES,
  GAUNTLET_MODELS,
  gauntletModelRegistry,
  modelOptionsForGauntletArm,
  parseGauntletList,
} from "../src/gauntlet.js";
import { writeGauntletShowcase } from "../src/gauntlet-showcase.js";
import {
  applyTrioArm,
  buildTrioComparison,
  formatTrioComparison,
  loadTrioManifest,
  TrioSession,
} from "../src/trio-session.js";
import {
  applyTeamPrimary,
  formatTeamComparison,
  TeamSession,
} from "../src/team-session.js";
import {
  applyNativeDelegate,
  formatNativeDelegate,
  loadNativeDelegate,
  runNativeDelegate,
} from "../src/native-delegate.js";
import {
  compareExecutionEvidence,
  formatExecutionComparison,
} from "../src/delegate-comparison.js";
import { readPinnedExperimentBinding } from "../src/pinned-experiment-binding.js";
import { classifyInteractiveResult, verificationDetailLines, demonstrationOf, editedPathsOf } from "../src/interactive-verdict.js";
import { emitAboveInput, redrawInput } from "../src/interactive-display.js";
import { isStateCommand, resolveStateHome, runStateCommand } from "../src/state-cli.js";
import { LaneRunBridge } from "../src/lane-run.js";
import {
  mergeContinuationResult,
  prepareRunContinuation,
  sha256,
} from "../src/run-continuation.js";
import { restoreWorkspace, snapshotWorkspace } from "../src/workspace-snapshot.js";
import { parseArgs } from "../src/cli-args.js";
import { parseQuotaNotice, formatQuotaNotice } from "../src/logic/quota-notice.js";
import { scrubStationNotes } from "../src/logic/station-notes.js";
import {
  formatGovernedSelfImproveResult,
  parseSelfImproveRequest,
  runGovernedSelfImprove,
} from "../src/self-improve-controller.js";
import {
  observeCompletedSelfHostRun,
} from "../src/self-observation.js";
import {
  compareTeacherTrajectories,
  deriveTrajectoryHypotheses,
  formatTrajectoryHypotheses,
} from "../src/trajectory-comparison.js";
import { runFactoryCommand, resolveFactoryHome } from "../src/factory-cli.js";
import { FactoryRunTelemetry } from "../src/factory.js";
import { classifyTaskIntent } from "../src/task-intent.js";

const cliArgs = process.argv.slice(2);
const args = parseArgs(cliArgs);
// A saved OpenAI-API config (`bantam doctor --api-url …`) is the persistent
// fallback for cliModelOptions when no --api-url flag/env is given.
const savedApi = loadApiConfig();
if (savedApi?.presets) {
  cliModelOptions.__presets = savedApi.presets;
}
const cmd = args._[0];
if (cmd === 'foreman') {
  try {
    const { foremanCommand } = await import('../src/foreman.js');
    process.exit(await foremanCommand(args, { ask: askSetup }));
  } catch (error) { console.error(`Foreman: ${error.message}`); process.exit(2); }
}
if (cmd === 'cards') {
  try {
    const {factoryCardsCommand}=await import('../src/factory-cards-command.js');
    process.exit(await factoryCardsCommand(args,{ask:askSetup}));
  } catch(error) { console.error(`Fight cards: ${error.message}`); process.exit(2); }
}
if (args["shell-network"] === true) process.env.BANTAM_SHELL_NETWORK = "1";
// First-class trajectory choice (operator, 2026-08-18): rebuild stays the
// quality default (the 08-12 preregistered ruling — stale panels poison
// post-bounce repairs); --context-mode extension opts a session into the
// prefix-cache-preferring build (~92% slot reuse, roughly half the wall time
// on local models). Values are validated where they are consumed (runAgent
// throws on anything but rebuild/extension).
if (typeof args["context-mode"] === "string") process.env.BANTAM_PROMPT_TRAJECTORY = args["context-mode"];

if (cmd === "factory") {
  if (new Set(["floor", "yard"]).has(String(cliArgs[1] ?? "").toLowerCase())) {
    const floorAbort = new AbortController();
    const stopFloor = () => floorAbort.abort();
    process.once("SIGINT", stopFloor);
    const code = await runFactoryCommand(process.argv.slice(2), { signal: floorAbort.signal });
    process.off("SIGINT", stopFloor);
    process.exit(code);
  }
  process.exit(await runFactoryCommand(process.argv.slice(2)));
}

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

// Headless entrypoints short-circuit before terminal decoration, skill setup,
// endpoint probing, model launch offers, or the interactive REPL.
if (cmd === "exec") {
  if (args.help) {
    console.log(`Usage: bantam exec [options] "<task text>"

Headless print mode — runs a task without a REPL, suitable for scripts.

Options:
  --workspace <dir>   workspace directory (default: current directory)
  --verify "<cmd>"    verification command to run after the task completes
  --verify-workspace-read-only  run configured verification with source read-only (Docker; /tmp writable)
  --dangerously-allow-net   grant shell NETWORK access for the whole run without asking
                      (default: network is OFF; interactive sessions ask per request)
  --max-turns <n>     maximum agent turns (default: 30)
  --endpoint <url>    model server endpoint
  --write-batch       expose the opt-in atomic multi-file write action
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
if (cmd === "self-improve" && args.help) {
  console.log(selfImproveUsage());
  process.exit(0);
}
// Planning scans the exact checkout but is deliberately read-only and
// model-free, so it must work even when no model server is running.
if (cmd === "self-improve" && (args.plan || args["dry-run"])) {
  process.exit(await selfImproveCommand({ modelClient: null, forcePlan: true }));
}
// Teacher collaboration is a Codex-only, artifact-driven witness. It must not
// probe, launch, or depend on the default local model.
if (cmd === "collaborate") {
  process.exit(await collaborateCommand());
}
if (cmd === "hypothesize") {
  process.exit(hypothesizeCommand());
}
if (cmd === "gauntlet") {
  process.exit(await gauntletCommand());
}
if (cmd === "trio") {
  process.exit(await trioCommand());
}
if (cmd === "delegate") {
  process.exit(await delegateCommand());
}
if (cmd === "audit-codex") {
  process.exit(await auditCodexCommand());
}
if (cmd === "audit-run") {
  process.exit(await auditRunCommand());
}

// Only emit ANSI styling to a real terminal (respect NO_COLOR); pipes/logs get clean text.
const USE_COLOR = !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === "1");
const paint = (code, s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));

/** A yes/no the REPL can ask mid-session. Defaults to NO: this gates a
 *  multi-gigabyte download and an rm -rf, and a piped session that cannot
 *  answer must not be taken to have said yes. */
async function askYesNo(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
  return /^y(es)?$/i.test(String(answer).trim());
}
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
const EDIT_VERBS = new Set(["write_file", "write_batch", "replace", "patch", "delete_file", "move_file"]);

// The opening rooster: the full-color pixel bantam struts on in, then scrolls off as work begins.
// Truecolor art on a real terminal; a small text rooster stands in when color is off or piped.
const BANNER_ART = new URL("../assets/bantam-banner.ans", import.meta.url);
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return null; }
})();
function ansiBannerArt() {
  try {
    const art = fs.readFileSync(BANNER_ART, "utf8").replace(/[\s﻿]+$/, "");
    // The wordmark art carries a baked-in "VERSION x.y". Re-stamp it from
    // package.json so the front door cannot drift from the shipped version —
    // the art file and the manifest were two separate truths, and the art won
    // by being the only one a user ever sees. Left-pad to the original width
    // so the centring under the wordmark holds.
    if (!PKG_VERSION) return art;
    const want = `VERSION ${PKG_VERSION.split(".").slice(0, 2).join(".")}`;
    return art.replace(/VERSION \d+\.\d+/, (m) => (want.length < m.length ? " ".repeat(m.length - want.length) + want : want));
  } catch { return null; }
}

function renderBanner({ profileName, workspace, verify, tty, servedModel = null, servedAt = null }) {
  const home = process.env.HOME || "";
  const dir = home && workspace.startsWith(home) ? "~" + workspace.slice(home.length) : workspace;
  const verifyBit = verify ? paint(C.dim, "verify ") + paint(C.beak, verify) : paint(C.dim, "no verifier");
  // The trajectory trade is real (quality vs prefix-cache speed) and the mode
  // was invisible — an env var nobody could see chose how every prompt was
  // built. Say which world this session lives in, in the SAME words as
  // `:context` and `:modes`; the banner used to have a vocabulary of its own
  // and could not name the middle position at all.
  const live = contextModeFromEnv(process.env);
  const contextMode = live === "rebuild"
    ? paint(C.dim, "context rebuild")
    : paint(C.beak, `context ${live} (cache-fast)`);
  const status = "  " + paint(C.dim, "model ") + paint(C.paper, profileName) + paint(C.dim, "  ·  ")
    + paint(C.paper, dir) + paint(C.dim, "  ·  ") + verifyBit + paint(C.dim, "  ·  ") + contextMode;
  const help = "  " + paint(C.dim, tty
    ? "type a request · steer mid-run · :help for commands · Ctrl-C to stop · exit"
    : 'type a request, or "exit"');

  // The first screen is a compact card: the idle sprite, the wordmark, and one
  // `key   value` column, centred to the terminal (src/logic/first-screen.js).
  // The 29-row pixel banner it replaces printed from column 0 with no width
  // awareness and was preceded by two grey metadata lines — the model was named
  // before the logo was. The full art still plays in `bantam strut`. Opt out
  // with BANTAM_ASCII_BANNER=1 for the lean text banner below.
  if (tty && USE_COLOR && !process.env.BANTAM_ASCII_BANNER) {
    const frame = loadAnimations("full")?.idle?.frames?.[0];
    const bird = typeof frame === "string" ? frame.replace(/\n$/, "").split("\n") : null;
    const K = (k) => paint(C.dim, k.padEnd(9));
    const sandboxMode = process.env.BANTAM_SHELL_SANDBOX ?? "docker";
    const netOn = process.env.BANTAM_SHELL_NETWORK === "1" || Boolean(args["dangerously-allow-net"]);
    const sandbox = sandboxMode === "docker"
      ? paint(C.paper, "docker") + paint(C.dim, ` · ${process.env.BANTAM_DOCKER_IMAGE ?? DEFAULT_SANDBOX_IMAGE} · `) + (netOn ? paint(C.comb, "network on") : paint(C.dim, "offline"))
      : paint(C.comb, sandboxMode) + paint(C.dim, " — no container isolation");
    // Fit an 80-column terminal: the model id and the path are the two values
    // with no upper bound, so they are elided to what the column can hold.
    const budget = columnBudget(process.stdout.columns, bird ? Math.max(...bird.map(visibleWidth)) : 22) - 9; // minus the key
    const host = servedAt ? String(servedAt).replace(/^https?:\/\//, "") : "";
    const modelName = elideMiddle(servedModel || profileName, Math.max(12, budget - (host ? host.length + 2 : 0)));
    const modelCell = paint(C.paper, modelName) + (host ? paint(C.dim, `  ${host}`) : "");
    const lines = [
      paint(`1;${C.plume}`, "BANTAM") + (PKG_VERSION ? paint(C.dim, `  v${PKG_VERSION}`) : ""),
      paint(C.dim, "a scrappy little terminal agent"),
      "",
      K("model") + modelCell,
      K("dir") + paint(C.paper, elideMiddle(dir, Math.max(12, budget))),
      K("verify") + (verify ? paint(C.beak, elideMiddle(verify, 24)) : paint(C.dim, "none")) + "   " + K("context") + (live === "rebuild" ? paint(C.dim, live) : paint(C.beak, `${live} (cache-fast)`)),
      K("sandbox") + sandbox,
      "",
      paint(C.dim, "type a request · :help · Ctrl-C stops · exit"),
      paint(C.dim, ":modes to see what else is switched on"),
      "",
    ];
    const card = renderFirstScreen({ cols: process.stdout.columns, bird, lines, paint: (t) => paint(C.rule, t) });
    if (card) return ["", card, ""].join("\n");
  }

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
if (cmd === "morning") {
  const { renderMorningReport, latestCodexReading } = await import("../src/logic/fuel.js");
  const { loadPolicy, haltState, governorVerdict, renderGovernorLine } = await import("../src/logic/governor.js");
  console.log(await renderMorningReport({}));
  const root = process.env.BANTAM_GOVERNOR_ROOT || process.cwd();
  console.log(renderGovernorLine(governorVerdict({ policy: loadPolicy(root), reading: latestCodexReading(), halt: haltState(root) })));
  process.exit(0);
}
if (cmd === "fuel") {
  // P0 of the frontier-orchestration spec: what do this machine's provider
  // logs say about quota state, basis and age stamped on every number.
  const { renderFuelReport } = await import("../src/logic/fuel.js");
  console.log(renderFuelReport());
  process.exit(0);
}
if (cmd === "cards") {
  // One simple card per registered profile: what it is, what it costs to
  // load, and what it has MEASURED itself doing at each context size.
  const { listModels } = await import("../src/model-launcher.js");
  const { renderCard, activeProfile } = await import("../src/logic/model-cards.js");
  const { renderExpectation } = await import("../src/logic/swap-ledger.js");
  const active = activeProfile();
  for (const m of listModels()) {
    const card = renderCard(m, { loadLine: renderExpectation(m.name) });
    console.log((m.name === active ? "▶ " : "  ") + card.split("\n").join("\n  ") + "\n");
  }
  process.exit(0);
}
if (cmd === "loadouts" || cmd === "loadout") {
  // The complete logbook of every loadout this machine has run — captured
  // from live process argv, replayable exactly. `bantam loadouts` lists;
  // `bantam loadout <n|hash>` re-summons one; `bantam loadouts capture`
  // snapshots whatever is serving right now (even hand-launched configs).
  const { listLoadouts, findLoadout, captureLiveLoadout, renderLoadout } = await import("../src/logic/loadouts.js");
  const sel = args._[1];
  if (cmd === "loadouts" && sel === "capture") {
    const got = captureLiveLoadout({});
    console.log(got ? `captured ${got.hash} — ${got.args.length} args, ctx ${got.ctx}, ${got.slots} slot(s)` : "nothing serving on :8085 to capture");
    process.exit(got ? 0 : 1);
  }
  if (cmd === "loadouts" || !sel) {
    const all = listLoadouts();
    if (!all.length) console.log("  no loadouts recorded yet — they accumulate as you swap, or run: bantam loadouts capture");
    for (const e of all) console.log(`  ${renderLoadout(e)}`);
    if (all.length) console.log("  replay: bantam loadout <n|hash>");
    process.exit(0);
  }
  const target = findLoadout(sel);
  if (!target) { console.log(`no loadout matches "${sel}" — see: bantam loadouts`); process.exit(1); }
  const { spawn } = await import("node:child_process");
  const { recordLoad, renderExpectation, loadAnomaly } = await import("../src/logic/swap-ledger.js");
  const key = `loadout:${target.hash}`;
  const eta = renderExpectation(key);
  console.log(`→ replaying loadout ${target.hash}${eta ? ` — ${eta}` : ""}`);
  try { execFileSync("fuser", ["-k", "-TERM", "8085/tcp"], { stdio: "ignore", timeout: 5000 }); } catch { /* port may be free */ }
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  const child = spawn(target.args[0], target.args.slice(1), { detached: true, stdio: "ignore" });
  child.unref();
  let healthy = false;
  while (Date.now() - t0 < 240000) {
    try { if ((await fetch("http://127.0.0.1:8085/health", { signal: AbortSignal.timeout(1500) })).ok) { healthy = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const ms = Date.now() - t0;
  recordLoad(key, ms, { ok: healthy });
  if (healthy) {
    console.log(`✔ loadout ${target.hash} healthy — ${(ms / 1000).toFixed(1)}s`);
    const warn = loadAnomaly(key, ms);
    if (warn) console.log(`  ${warn}`);
    captureLiveLoadout({});
    process.exit(0);
  }
  console.log(`✗ loadout ${target.hash} did not become healthy in ${(ms / 1000).toFixed(0)}s`);
  process.exit(1);
}
if (cmd === "swap" || cmd === "solo" || cmd === "crew" || cmd === "max" || cmd === "solomax" || cmd === "duo" || cmd === "crewmtp") {
  // Rapid model-profile swapping (measured 2026-08-19: same-GGUF swaps ride
  // the page cache — solo->crew 7.3s, crew->solo 15.2s, never touching disk).
  // `bantam solo` = single-slot + MTP (fast lone worker); `bantam crew` =
  // 4 slots over one unified KV pool (concurrent agents, live chat).
  const { swapModel, modelStatus } = await import("../src/model-launcher.js");
  const targetName = cmd === "swap" ? args._[1] : cmd;
  if (!targetName) {
    // Profiles share an endpoint, so health alone cannot say WHICH one is
    // loaded — the live slot count disambiguates (solo=1, crew=4).
    const st = await modelStatus();
    let liveSlots = null;
    try { liveSlots = (await (await fetch(`${st.find((m) => m.running)?.endpoint}/slots`, { signal: AbortSignal.timeout(2000) })).json()).length; } catch { /* no live server */ }
    for (const m of st) {
      const active = m.running && (m.slots == null || liveSlots == null || m.slots === liveSlots);
      // ◐ is a reachable server with no model in VRAM (--sleep-idle-seconds).
      // It answers /health like a loaded one, so it must be drawn differently.
      const mark = m.sleeping ? "◐" : !m.running ? "○" : active ? "●" : "◌";
      const { renderExpectation } = await import("../src/logic/swap-ledger.js");
      const eta = renderExpectation(m.name);
      console.log(`  ${mark} ${m.name}${m.sleeping ? " (asleep — reachable, but the model is unloaded and VRAM is free)" : !m.running ? "" : active ? " (active)" : " (endpoint held by another profile)"} — ${m.endpoint}${eta ? ` · load ${eta}` : ""}${m.notes ? ` · ${m.notes}` : ""}`);
    }
    console.log("  usage: bantam swap <solo|crew|name> [--force]   (or: bantam solo / bantam crew)");
    console.log("  a swap restarts the server; it refuses while a run holds the model lock unless --force");
    process.exit(0);
  }
  // --force overrides the model-lock refusal. A swap restarts the server, so
  // the default is to refuse while a run is using it rather than kill that run.
  const r = await swapModel(targetName, { force: args.force === true });
  if (r.ok) {
    console.log(`✔ ${r.name} up on ${r.endpoint} — swap took ${(r.ms / 1000).toFixed(1)}s`);
    if (r.unverified) console.log(`  ⚠ ${r.unverified}`);
    if (r.anomaly) console.log(`  ${r.anomaly}`);
    // Every successful swap enters the logbook, argv captured from the live
    // process — the loadout history is complete without anyone thinking of it.
    try { (await import("../src/logic/loadouts.js")).captureLiveLoadout({}); } catch { /* best effort */ }
    process.exit(0);
  }
  console.log(`✗ ${r.error}`);
  process.exit(1);
}
if (cmd === "chat-transport") {
  // `bantam chat-transport` — would sending BANTAM's turns as chat `messages`
  // send the SAME bytes? The chat endpoint checkpoints at every user-message
  // boundary, which /completion cannot do, and that is worth 3x less prefill
  // work at depth (docs/LLAMA-CPP-PREFIX-CACHE-CONTROLS.md). It is only safe if
  // the server's template reproduces the prompt exactly, so this measures.
  const { chatTransportFidelity, decomposeRenderedPrompt } = await import("../src/chat-transport.js");
  const file = args._[1];
  if (!file) {
    console.log("  usage: bantam chat-transport <rendered-prompt-file> [--endpoint URL]");
    console.log("  Capture one by launching llama-server with --log-prompts-dir DIR and running any task.");
    process.exit(2);
  }
  const endpoint = (typeof args.endpoint === "string" ? args.endpoint : null) || process.env.BANTAM_ENDPOINT || "http://127.0.0.1:8085";
  const prompt = fs.readFileSync(file, "utf8");
  const decomposed = decomposeRenderedPrompt(prompt);
  console.log(`  prompt:   ${prompt.length} chars, ${decomposed ? decomposed.messages.length : 0} messages`);
  if (decomposed) console.log(`  prefill:  ${JSON.stringify(decomposed.prefill)}`);
  const v = await chatTransportFidelity({ endpoint, prompt });
  console.log(v.ok ? `  ✔ byte-identical — chat transport is safe here` : `  ✖ ${v.reason}`);
  if (!v.ok && v.commonPrefixTokens !== undefined) {
    console.log("  The transport stays off until the renderer and the template agree.");
  }
  process.exit(v.ok ? 0 : 1);
}
if (cmd === "models") {
  // `bantam models` — the registry an operator actually edits. Adding a
  // llama.cpp model used to mean hand-writing .bantam/models.json, where every
  // mistake failed silently: a wrong script path just made the model not appear
  // in the startup picker. Registration validates and says so.
  const { readModelRegistry, modelStatus } = await import("../src/model-launcher.js");
  const { addModel, removeModel, registryPathForWrite, DEFAULT_ENDPOINT } = await import("../src/model-registry.js");
  const sub = (args._[1] ?? "list").toLowerCase();

  if (sub === "path") { console.log(registryPathForWrite()); process.exit(0); }

  if (sub === "list") {
    const registered = readModelRegistry();
    if (!registered.length) {
      console.log(`  No models registered. Add one:\n    bantam models add <name> --script /path/to/launch.sh\n  Registry: ${registryPathForWrite()}`);
      process.exit(0);
    }
    const live = await modelStatus();
    console.log(`  Registered models (${registryPathForWrite()}):`);
    for (const m of registered) {
      const missing = !m.script || !fs.existsSync(m.script);
      const running = live.some((s) => s.name === m.name && s.running);
      const bits = [
        m.slots ? `${m.slots} slot${Number(m.slots) === 1 ? "" : "s"}` : null,
        m.vision ? "vision" : null,
        m.endpoint,
      ].filter(Boolean).join(" · ");
      console.log(`    ${missing ? "✖" : running ? "●" : "○"} ${m.name} — ${bits}`);
      console.log(`        ${m.script}${missing ? "   ← MISSING: this model is hidden from the picker until the path is fixed" : ""}`);
    }
    console.log("  Start one: bantam swap <name>   ·   Add: bantam models add <name> --script PATH   ·   Remove: bantam models remove <name>");
    process.exit(0);
  }

  if (sub === "remove" || sub === "rm") {
    const r = removeModel(args._[2]);
    console.log(r.ok ? `✔ removed ${r.removed.name} from ${r.file}` : `✗ ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === "add") {
    const ask = async (q) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const a = await new Promise((res) => rl.question(q, res));
      rl.close();
      return String(a).trim();
    };
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    let name = args._[2] ?? (typeof args.name === "string" ? args.name : "");
    let script = typeof args.script === "string" ? args.script : "";
    let endpoint = typeof args.endpoint === "string" ? args.endpoint : "";
    let slots = args.slots;
    let vision = Boolean(args.vision);
    // Prompt only for what a registration cannot do without; everything else
    // stays flag-only so scripted setup never blocks on a question.
    if (!name && interactive) name = await ask("Name (how you'll refer to it, e.g. qwen38uc-duo): ");
    if (!script && interactive) script = await ask("Launch script (absolute path to the .sh that starts llama-server): ");
    if (!endpoint && interactive) endpoint = await ask(`Endpoint [${DEFAULT_ENDPOINT}]: `);
    if (slots === undefined && interactive) slots = await ask("Slots [blank = unspecified]: ");
    if (!args.vision && interactive) vision = /^y/i.test(await ask("Vision (mmproj) capable? [y/N]: "));

    const r = addModel({
      name,
      script,
      endpoint,
      slots,
      vision,
      ctx: args.ctx,
      vramMb: args["vram-mb"],
      priority: args.priority,
      warn: args.warn,
      match: args.match,
      profile: args.profile,
      notes: args.notes,
    }, { replace: Boolean(args.replace) });
    if (!r.ok) { console.log(`✗ ${r.error}`); process.exit(1); }
    console.log(`✔ ${r.replaced ? "replaced" : "registered"} ${r.entry.name} → ${r.entry.endpoint}`);
    console.log(`  script:   ${r.entry.script}`);
    console.log(`  registry: ${r.file}`);
    if (!r.executable) console.log("  note: the script is not executable — BANTAM runs it as `bash <script>`, so this is fine.");
    console.log(`  Start it now with: bantam swap ${r.entry.name}`);
    process.exit(0);
  }

  console.log("  usage: bantam models [list] | add <name> --script PATH [--endpoint URL] [--vision] [--slots N] [--ctx N] [--vram-mb N] [--priority N] [--warn \"...\"] [--notes \"...\"] [--replace] | remove <name> | path");
  process.exit(2);
}
if (cmd === "governor") {
  // P1 of the frontier-orchestration spec: the operator's hand between any
  // auto-spend path (librarian, citation checks, delegates) and the vendor.
  const { loadPolicy, haltState, haltSpend, resumeSpend, governorVerdict, renderGovernorLine, haltPath } = await import("../src/logic/governor.js");
  const { latestCodexReading } = await import("../src/logic/fuel.js");
  const root = process.env.BANTAM_GOVERNOR_ROOT || process.cwd();
  const sub = (args._[1] ?? "status").toLowerCase();
  if (sub === "halt") {
    haltSpend(root, args._.slice(2).join(" "));
    console.log(`⛔ spend halted — ${haltPath(root)} written. Every codex errand refuses until \`bantam governor resume\`.`);
  } else if (sub === "resume") {
    console.log(resumeSpend(root) ? "⛽ spend resumed — the kill switch file is gone." : "⛽ nothing to resume — no kill switch file was set.");
  } else {
    const policy = loadPolicy(root);
    const halt = haltState(root);
    const v = governorVerdict({ policy, reading: latestCodexReading(), halt });
    console.log(renderGovernorLine(v));
    console.log(`   policy: weekly cap ${policy.codex.weeklyStopPct}% · 5h cap ${policy.codex.fiveHourStopPct}% · warn margin ${policy.codex.warnMarginPct}% · unmetered spend: ${policy.onNoReading}`);
    console.log(`   kill switch: ${halt.halted ? `ON (${halt.source})` : "off"} · override file: ${haltPath(root)}`);
    console.log("   verbs: bantam governor halt [reason] | bantam governor resume");
  }
  process.exit(0);
}
if (cmd === "supervise") {
  // The film archaeologist: the factory's byte-level audits, encoded. Reads a
  // --save-run film (or the newest in .bantam/runs) and drafts findings with
  // evidence attached — mechanism guesses matched against the jig catalog.
  const { supervise, renderSupervisorReport } = await import("../src/supervisor/report.js");
  let target = args._[1];
  if (!target || args.latest) {
    const dir = path.resolve(".bantam", "runs");
    const cand = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith(".json")).sort();
    if (!cand.length && !target) { console.error("no film given and no .bantam/runs/*.json found — run with --save-run first"); process.exit(2); }
    target ??= path.join(dir, cand.at(-1));
  }
  const film = JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
  const r = supervise(film);
  console.log(renderSupervisorReport(r, { source: target }));
  if (args.json) console.log(JSON.stringify(r, null, 1));
  process.exit(r.findings.some((f) => f.severity === "high") ? 1 : 0);
}
if (cmd === "addons") {
  const { renderAddons } = await import("../src/addons.js");
  console.log(renderAddons());
  process.exit(0);
}
if (cmd === 'setup' && !args.legacy && !args['api-url']) {
  if (!(process.stdin.isTTY && process.stderr.isTTY) && !(args.yes && typeof args['stock-profile']==='string')) {
    fail('Interactive setup requires a terminal. For explicit unattended stock installation: bantam setup --stock-profile 72k-cpu-vision --yes. Existing APIs: bantam doctor --api-url URL.');
  }
  const choice=typeof args['stock-profile']==='string'
    ? await setupWizard({...setupWizardOptions(),profile:args['stock-profile'],yes:Boolean(args.yes)})
    : await promptStartupModelChoice(new ModelClient({}));
  if(choice?.kind==='local'){
    const endpoint=choice.model.managed?await startManagedStock(choice.model):await startRegisteredModel(choice.model);
    if(!endpoint)fail('Stock model did not start. Inspect its log; no existing server was stopped.');
    // A previous saved cloud/API choice must not hide the newly selected local profile.
    saveConnection({kind:'local',name:choice.name});
    console.log(`Ready at ${endpoint}. Run bantamfactory in your project.`);
  }else if(choice?.kind==='codex'){
    const c=new ModelClient({codex:true,model:choice.model,codexEffort:choice.effort});
    if(!await c.health())fail('Codex is unavailable or not signed in. Run codex login, then retry setup.');
    saveConnection({kind:'codex',model:choice.model,effort:choice.effort,consent:'cloud-context-v1'});
    console.log('Codex selected. Run bantamfactory in your project.');
  }else if(choice&&choice.kind!=='api'){
    fail('This advanced backend is available from the ordinary bantam model menu; setup did not change your connection.');
  }
  process.exit(0);
}
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
  // The sandbox image must already be local: the executor runs `docker run --pull
  // never` so a model-chosen action can never reach a registry. `docker image
  // inspect` is the cheap local-only existence check — never `docker pull`.
  const sandboxProbe = () => {
    const mode = process.env.BANTAM_SHELL_SANDBOX ?? "docker";
    const image = process.env.BANTAM_DOCKER_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    if (mode !== "docker") return { mode, image, dockerFound: false, imagePresent: false };
    let dockerFound = false;
    try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 5000 }); dockerFound = true; }
    catch { return { mode, image, dockerFound: false, imagePresent: false }; }
    let imagePresent = false;
    try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5000 }); imagePresent = true; }
    catch { /* absent */ }
    return { mode, image, dockerFound, imagePresent };
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
    const deepseek = args.deepseek === true;
    const client = new ModelClient({ apiUrl, apiKey, model: modelName, apiDialect: dialect, deepseek });
    process.stderr.write(`\nChecking OpenAI-compatible API at ${apiUrl} …\n`);
    const healthy = await client.health();
    process.stderr.write(healthy ? "  ✔ reachable (GET /v1/models)\n" : "  ✖ /v1/models did not answer — check the URL/key.\n");
    let grammarOk = null;
    if (healthy && dialect === "chat") {
      // A chat-only server (codexapi, hosted providers) never sees GBNF. Probe the
      // schema path instead: response_format json_schema, validated locally.
      try {
        const out = await client.complete("<|im_start|>user\nReply with a JSON object with key ok set to true.<|im_end|>\n<|im_start|>assistant\n",
          { grammar: 'root ::= "{}"', jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, nPredict: 32 });
        grammarOk = JSON.parse(String(out.content).trim())?.ok === true;
      } catch { grammarOk = false; }
      process.stderr.write(grammarOk
        ? "  ✔ chat dialect: response_format json_schema honored — actions arrive as schema-shaped JSON\n"
        : "  ⚠ chat dialect: schema probe did not return {\"ok\":true} — actions are validated locally and malformed ones become repair turns\n");
    } else if (healthy) {
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
    const saved = saveApiConfig(process.cwd(), { apiUrl, apiKey, model: modelName, dialect: dialect ?? "llamacpp", grammar: grammarOk, deepseek });
    process.stderr.write(`\n✔ Saved to ${saved}\n  → This API is now available via \`:model\`; a reachable local model remains the startup default.\n`);
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

  // `--provision-extra vision|mtp`: optional companions from the same repo —
  // vision (mmproj) and the MTP speculative-decoding sidecar. Small enough to
  // be quick, optional enough to never be part of the default pull.
  if (typeof args["provision-extra"] === "string") {
    const { EXTRAS } = await import("../src/provision.js");
    const which = String(args["provision-extra"]);
    const extra = EXTRAS[which];
    if (!extra) { console.error(`unknown extra "${which}" — have: ${Object.keys(EXTRAS).join(", ")}`); process.exit(2); }
    const { resolveUrl, modelsDir: mdir, formatBytes: fb } = await import("../src/provision.js");
    const dest = path.join(mdir(), extra.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= extra.bytes) {
      process.stderr.write(`✔ already installed: ${dest}\n`); process.exit(0);
    }
    process.stderr.write(`${which}: ${extra.file} (${fb(extra.bytes)}) → ${dest}\n`);
    if (setupTty && !args.yes && !(await confirmYN(`Download now? [Y/n] `, true))) process.exit(1);
    fs.mkdirSync(mdir(), { recursive: true });
    await downloadWithProgress(resolveUrl({ file: extra.file }), dest);
    process.stderr.write(`\n✔ ${which} installed. The certified launch profile auto-detects it next start.\n`);
    process.exit(0);
  }

  // `--setup`: the whole on-ramp in one command — diagnose, then (only what's
  // missing) fetch llama-server, download the model, scaffold, and launch.
  if (args.setup || cmd === "setup") {
    const detect = async () => { const ep = await detectEndpoint({ endpoint: args.endpoint }); return (await isHealthy(ep)) ? ep : null; };
    const report = await runChecks({ nodeVersion: process.version, detectEndpoint: detect, loadedModel: (ep) => fetchModelId(ep, 2500).catch(() => null), whichLlama, gpuInfo, scanGgufs, listModels, sandboxProbe });
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
    whichLlama, gpuInfo, scanGgufs, listModels, sandboxProbe,
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

const explicitCodexRequested = args.codex === true;
const explicitApiRequested = args.deepseek === true
  || typeof args["api-url"] === "string"
  || Boolean(process.env.BANTAM_API_URL);
let modelOptions = explicitApiRequested || explicitCodexRequested
  ? cliModelOptions()
  : cliModelOptions({
      apiUrl: null,
      apiKey: null,
      model: undefined,
      apiDialect: undefined,
      deepseek: false,
    });
const rememberedConnection=loadConnection();
if (!explicitApiRequested && !explicitCodexRequested && !args.endpoint && !process.env.BANTAM_ENDPOINT) {
  if(rememberedConnection?.kind==='api')modelOptions={...modelOptions,apiUrl:rememberedConnection.apiUrl,apiKey:args['api-key']??process.env.BANTAM_API_KEY??rememberedConnection.apiKey,model:args.model??rememberedConnection.model,apiDialect:args['api-dialect']??rememberedConnection.dialect,deepseek:false};
  if(rememberedConnection?.kind==='codex')modelOptions={...modelOptions,codex:true,model:args.model??rememberedConnection.model,codexEffort:args['codex-effort']??rememberedConnection.effort,apiUrl:null};
}
let usingCodex = modelOptions.codex === true;
let usingApi = !usingCodex && modelOptions.apiUrl !== null
  && Boolean(modelOptions.apiUrl || process.env.BANTAM_API_URL);
// No explicit endpoint? Pick whichever llama.cpp server is actually up (e.g. 27B on :8085 vs 35B on
// :18086). Explicit --endpoint / BANTAM_ENDPOINT skips detection; an OpenAI --api-url skips it too.
if (!modelOptions.endpoint && !usingApi && !usingCodex) modelOptions.endpoint = await detectEndpoint();
// --chat-transport arms the opt-in chat-messages transport. It self-tests on the
// first real prompt and turns itself OFF unless the server re-renders BANTAM's
// turns byte-for-byte — see src/chat-transport.js.
if (args["chat-transport"] === true || envTruthy("BANTAM_CHAT_TRANSPORT")) modelOptions.chatTransport = true;
let model = new ModelClient(modelOptions);
// Legacy workspace APIs remain presets; first-run user selections are explicit
// cross-workspace defaults. If the selected backend is unavailable, offer setup.
if (canOfferStartupChoice(cmd) && (!rememberedConnection || !(await model.health()))) {
  let selection = await promptStartupModelChoice(model);
  if(!selection)process.exit(0);
  while (selection) {
    if(selection.kind==='api'){
      const c=selection.config;
      modelOptions={...modelOptions,codex:false,apiUrl:c.apiUrl,apiKey:c.apiKey,model:c.model,apiDialect:c.dialect,deepseek:false,endpoint:undefined};
      model=new ModelClient(modelOptions);usingApi=true;usingCodex=false;break;
    }
    if (selection.kind === "codex") {
      model.switchToCodex({ model: selection.model, effort: selection.effort });
      if (await model.health()) {
        modelOptions = {
          ...modelOptions,
          codex: true,
          model: selection.model,
          codexEffort: selection.effort,
          apiUrl: null,
        };
        usingCodex = true;
        usingApi = false;
        saveConnection({kind:'codex',model:selection.model,effort:selection.effort,consent:'cloud-context-v1'});
        saveModelPreference({
          kind: "codex",
          name: selection.name,
          model: selection.model,
          effort: selection.effort,
        });
        break;
      }
      process.stderr.write("Codex app-server is unavailable or not authenticated. Choose another option.\n");
      selection = await promptStartupModelChoice(model);
      continue;
    }
    if (selection.kind === "local") {
      const started = selection.model.managed?await startManagedStock(selection.model):await startRegisteredModel(selection.model);
      if (started) {
        modelOptions = {
          ...modelOptions,
          codex: false,
          endpoint: started,
          apiUrl: null,
          deepseek: false,
        };
        model = new ModelClient(modelOptions);
        usingApi=false;usingCodex=false;
        saveConnection({kind:'local',name:selection.name});
        // A registry entry may pin the chat profile its model needs (Gemma 4
        // does not speak ChatML). An explicit --profile still outranks it.
        if (selection.model.profile) model.switchTo(started, { profile: selection.model.profile });
        saveModelPreference({ kind: "local", name: selection.name });
        break;
      }
      process.stderr.write("The local model did not start. Choose another option.\n");
      selection = await promptStartupModelChoice(model);
      continue;
    }
    if (selection.kind === "codexapi") {
      let url = selection.config.url;
      if (selection.needsKey) {
        const key = await promptHidden("codexapi API key (hidden, saved for next time): ");
        const check = key ? await bridgeStatus(url, key) : { reachable: false };
        if (!check.reachable) {
          process.stderr.write("codexapi still refused that key. Choose another option.\n");
          selection = await promptStartupModelChoice(model);
          continue;
        }
        selection.config.key = key;
      }
      if (selection.launch) {
        try {
          url = (await launchBridge({ dir: selection.config.dir, url, key: selection.config.key })).url;
        } catch (error) {
          process.stderr.write(`codexapi did not start: ${error.message}. Choose another option.\n`);
          selection = await promptStartupModelChoice(model);
          continue;
        }
      }
      modelOptions = {
        ...cliModelOptions(),
        apiUrl: url,
        apiKey: selection.config.key ?? null,
        model: `${selection.model}:${selection.effort}`,
        apiDialect: "chat",
        deepseek: false,
        endpoint: undefined,
      };
      model = new ModelClient(modelOptions);
      usingApi = true;
      usingCodex = false;
      // codex as a text brain: BANTAM executes every action itself, so the
      // bridge's conversational persona is declined and its no-tools rule kept.
      if (!process.env.BANTAM_CHAT_BODY_EXTRA) process.env.BANTAM_CHAT_BODY_EXTRA = '{"chat_preamble":false}';
      saveModelPreference({ kind: "codexapi", name: selection.name, model: selection.model, effort: selection.effort });
      saveUserSetting("codexapi", { url, key: selection.config.key ?? null, dir: selection.config.dir ?? null });
      break;
    }
    if (selection.kind === "deepseek") {
      const fallback = deepSeekFallbackOptions();
      let apiKey = fallback.apiKey;
      if (!apiKey) {
        apiKey = await promptHidden("DeepSeek API key (hidden, used for this session): ");
      }
      if (apiKey) {
        modelOptions = {
          ...cliModelOptions(),
          ...fallback,
          apiKey,
          deepseek: true,
          endpoint: undefined,
        };
        model = new ModelClient(modelOptions);
        usingApi = true;
        saveModelPreference({ kind: "deepseek", name: "deepseek-pro" });
      } else {
        process.stderr.write("DeepSeek was not enabled because no API key was provided.\n");
      }
      break;
    }
  }
}
// Ask the server which model is actually loaded, so switching servers (27B <-> 35B) is reflected in
// the startup line, the TUI label, and the run artifact — not a hardcoded name.
const activeModelId = usingCodex || usingApi
  ? model.modelName
  : await fetchModelId(model.endpoint, 2500).catch(() => null);
// Always announce — ESPECIALLY with an explicit --endpoint, where what's actually serving is the
// question. A swapped GGUF on the same port makes eval numbers incomparable across sessions; this
// line (plus the eval summary header) is what makes that visible.
const activeModelLocation = usingCodex
  ? `Codex app-server (${model.codexEffort} reasoning, ChatGPT subscription)`
  : usingApi
    ? `${model.apiUrl} (openai)`
    : model.endpoint;
// On the interactive path the first-screen card carries model + endpoint, so
// this line would only put grey metadata above the logo. Every other command
// (run/exec/eval, a pipe, --ascii) still gets it — that is where the
// "what is actually serving" question matters for comparable eval numbers.
const interactiveCard = (cmd === undefined || cmd === "chat") && Boolean(process.stdout.isTTY) && USE_COLOR && !process.env.BANTAM_ASCII_BANNER;
if (!interactiveCard) process.stderr.write(`model: ${activeModelId || "unknown"} @ ${activeModelLocation}\n`);
// Context mode, resolved once and pushed back into the environment that
// src/agent.js reads per turn — so `:context` mid-session takes effect on the
// very next turn without threading a new parameter through the whole loop.
// The env var is BOTH an input (a scripted run may set it) and the transport,
// so read it before overwriting it.
const contextModeState = resolveContextMode({
  contextModeFlag: typeof args["context-mode"] === "string" ? args["context-mode"] : null,
  immutableFlag: args["immutable-history"] === true,
  recomputeFlag: args.recompute === true,
  envTrajectory: process.env.BANTAM_PROMPT_TRAJECTORY,
  envImmutable: process.env.BANTAM_IMMUTABLE_HISTORY,
  saved: loadUserSettings().contextMode,
});
function applyContextMode(mode) {
  Object.assign(process.env, contextModeEnv(mode));
  contextModeState.mode = mode;
}
applyContextMode(contextModeState.mode);
// generate_image is brokered through the signed-in Codex account, so it is off
// unless asked for — but it was previously reachable ONLY by exporting
// BANTAM_CODEX_IMAGE before launch. Resolve it like any other mode so it can be
// remembered and, crucially, SEEN.
const imageModeState = resolveImageMode({
  env: process.env.BANTAM_CODEX_IMAGE,
  saved: loadUserSettings().imageMode,
});
function applyImageMode(on) {
  process.env.BANTAM_CODEX_IMAGE = on ? "1" : "0";
  imageModeState.on = on;
}
applyImageMode(imageModeState.on);
// Which eyes read an image. The tool registry is rebuilt per request, so this
// can change mid-session like any other mode.
const imageProviderState = resolveImageProvider({
  env: process.env.BANTAM_IMAGE_PROVIDER,
  saved: loadUserSettings().imageProvider,
});
/** Real probes for detectCodex: PATH lookup, `codex --version`, `codex login
 *  status`, and the auth file. Each is bounded (3 s) and failure-tolerant. */
function codexProbes() {
  const run = (args) => {
    try { return { ok: true, stdout: execFileSync("codex", args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }) }; }
    catch (e) { return { ok: false, stdout: String(e?.stdout ?? "") }; }
  };
  return {
    which: (name) => {
      for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, name);
        try { if (fs.existsSync(p) && (fs.statSync(p).mode & 0o111)) return p; } catch { /* keep looking */ }
      }
      return null;
    },
    version: () => run(["--version"]).stdout.trim() || null,
    loginStatus: () => run(["login", "status"]),
    readAuth: () => JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8")),
  };
}

function applyImageProvider(provider) {
  if (provider === "auto") delete process.env.BANTAM_IMAGE_PROVIDER;
  else process.env.BANTAM_IMAGE_PROVIDER = provider;
  imageProviderState.provider = provider;
}
applyImageProvider(imageProviderState.provider);
// Headless `run` does not take the interactive health/startup path. Discover
// held-open bridge sessions before any probe or agent policy is selected,
// including when the caller has already confirmed grammar support.
await model.detectChatSessions();
// Grammar is not optional for BANTAM — the action grammar is what keeps a small
// model emitting valid actions. A base OpenAI endpoint that ignores GBNF will
// produce malformed actions, so probe once and warn LOUDLY. (Skip if doctor
// already confirmed it, or the operator opts out with BANTAM_SKIP_GRAMMAR_CHECK.)
if (usingApi && !model.deepseek && model.chatDialect && !envTruthy("BANTAM_SKIP_GRAMMAR_CHECK")) {
  // A chat-only server never sees GBNF; the action schema rides in
  // response_format instead. Probe that, and say what it means either way.
  let honored = false;
  try {
    const probe = await model.complete("<|im_start|>user\nReply with a JSON object with key ok set to true.<|im_end|>\n<|im_start|>assistant\n",
      { grammar: 'root ::= "{}"', jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, nPredict: 32 });
    honored = JSON.parse(String(probe.content).trim())?.ok === true;
  } catch { honored = false; }
  process.stderr.write(honored
    ? "chat dialect: response_format json_schema honored — actions arrive schema-shaped and are validated locally\n"
    : "chat dialect: schema probe did not return {\"ok\":true} — actions are validated locally; malformed ones become repair turns\n");
  if (model.chatSessions) process.stderr.write("chat dialect: session reuse enabled — new observations only\n");
} else if (usingApi && !model.deepseek && savedApi?.grammar !== true && !envTruthy("BANTAM_SKIP_GRAMMAR_CHECK")) {
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
    const scrubbed = scrubStationNotes(e.observation);
    if (!scrubbed.trim()) return;
    const first = scrubbed.split("\n")[0].slice(0, 100);
    process.stderr.write(`    ${first}\n`);
  } else if (e.type === "thinking") {
    const first = e.text.split("\n").find((l) => l.trim()) || e.text;
    process.stderr.write(`  🤔 ${first.slice(0, 100)}${first.length > 100 ? "…" : ""}\n`);
  } else if (e.type === "grounding_progress") {
    // Live single-line bar: on a big repository the index build blocked the
    // first request invisibly and chat felt unresponsive (2026-08-18).
    const width = 24;
    const filled = Math.max(0, Math.min(width, Math.round((e.done / Math.max(1, e.total)) * width)));
    process.stderr.write(`\r  \u{1F9ED} indexing code KB  [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${e.done.toLocaleString()}/${e.total.toLocaleString()} files`);
    if (e.done >= e.total) process.stderr.write("\r\u001b[2K");
  } else if (e.type === "grounding_state") {
    process.stderr.write(e.enabled
      ? `  🧭 code KB: ${e.files.toLocaleString()} files${e.buildMs >= 50 ? ` indexed in ${(e.buildMs / 1000).toFixed(1)}s` : " ready"} — \`query\` answers defines/symbols/deps/flow\n`
      : e.tooLarge
        ? noteKbTooLarge(e)
        : "  🧭 code KB: off — the `query` action has no tools behind it (--ground enables it)\n");
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
    process.stderr.write(`  ⚙ auto-verify after ${e.streak} blind edit(s): ${e.verdict}\n`);
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

let usageDisplayEnabled = args.usage === true
  || (args["no-usage"] !== true
    ? /^(1|true|yes|on)$/i.test(String(process.env.BANTAM_USAGE ?? ""))
    : false);
model.onUsage = ({ entry, totals }) => {
  if (!usageDisplayEnabled) return;
  process.stderr.write(`  usage  ${formatUsage(entry)}\n`);
  process.stderr.write(`         ${formatUsage(totals, { cumulative: true })}\n`);
};

/**
 * What this session's optional modes are set to. Modes that persist across
 * sessions are invisible state by construction, so they get announced at
 * startup and listed by `:modes` — one builder feeds both, because a summary
 * that drifts from the live toggles is worse than none.
 */
function sessionModeEntries({ contextMode, contextSource, stream, deepResearch, rooster, usage, image, imageProvider }) {
  return [
    {
      key: "context",
      value: `${contextMode}${contextSource && contextSource !== "remembered" ? ` (${contextSource})` : ""}`,
      command: ":context [rebuild|immutable|extension]",
      detail: describeContextMode(contextMode),
    },
    { key: "stream", value: stream ? "on" : "off", command: ":stream [on|off]", detail: "render reasoning and answers live as they generate" },
    { key: "deepresearch", value: deepResearch ? "on" : "off", command: ":deepresearch [on|off]", detail: "pre-answer gap check, then one governed source errand" },
    { key: "rooster", value: rooster ? "on" : "off", command: ":rooster [on|off]", detail: "mood labels and a crow when work lands" },
    { key: "usage", value: usage ? "on" : "off", command: ":usage [on|off|reset]", detail: "token and cost reporting after each turn" },
    // Printed even when off: this is the one mode whose ON state sends prompts
    // to an external account, so it must never be quietly enabled from a
    // remembered setting.
    { key: "image", value: image ? "ON — via your Codex plan" : "off", command: ":image [on|off]", detail: describeImageMode(image) },
    { key: "eyes", value: imageProvider, command: ":eyes [auto|local|codex]", detail: describeImageProvider(imageProvider) },
  ];
}

/** The mode states a fresh session starts from (before any REPL toggle). */
function startupModeEntries() {
  const settings = loadUserSettings();
  return sessionModeEntries({
    contextMode: contextModeState.mode,
    contextSource: contextModeState.source,
    stream: process.env.BANTAM_STREAM === "1" || (process.env.BANTAM_STREAM !== "0" && settings.stream === true),
    deepResearch: process.env.BANTAM_DEEPRESEARCH === "1",
    rooster: roosterOn,
    usage: usageDisplayEnabled,
    image: imageModeState.on,
    imageProvider: imageProviderState.provider,
  });
}

if ((cmd === undefined || cmd === "chat") && !interactiveCard) {
  process.stderr.write(`${renderModeLine(startupModeEntries())}\n`);
}

if (cmd === undefined || cmd === "chat") {
  await repl();
} else if (cmd === "self-improve") {
  process.exit(await selfImproveCommand({ modelClient: model }));
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
} else if (cmd === "runs") {
  // Browse the evidence shelf: every chat request and --save-run artifact here.
  //   bantam runs [workspace]
  const { listRunArtifacts, formatRunsListing } = await import("../src/run-listing.js");
  const where = typeof args._[1] === "string" ? path.resolve(args._[1]) : process.cwd();
  console.log(formatRunsListing(listRunArtifacts(where)));
  process.exit(0);
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
    console.log('usage: bantam compare "<task>" [--workspace <dir>] [--verify <command>] [--grader <hidden-test-dir>] [--config <four-arms.json>] [--out <run-dir>] [--only <arm,...>] [--dry-run] [--allow-unsafe-competitors]');
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
    // A contract the arms never see. Without it every arm is graded on the
    // visible verify command, and two arms that both make it green look identical.
    grader: typeof args.grader === "string" ? args.grader : undefined,
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
    console.log("witness only: preregister and measure a remedy with `bantam experiment`; this checkout has no standalone comparison scorer.");
  }
  process.exit(0);
} else if (cmd === "diagnose") {
  // Self-diagnosis (docs/PRINCIPLES.md): witness the bad turns of a recorded
  // run; with --turn, rewind that turn and A/B a context remedy against the
  // live model, scoring whether it moves the model from spinning to working.
  const { witnessProblems, summarizeProblems, selectRemedies, scoreRemedy } = await import("../src/diagnose.js");
  const { prepareReplay, withSampleSeed } = await import("../src/replay.js");
  const artifactPath = args._[1];
  if (!artifactPath) {
    process.stderr.write('usage: bantam diagnose <artifact.json> [--turn N] [--samples 3] [--inject "<fact>"] [--repo <dir>]\n');
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
        console.log("  witness only: preregister and measure a remedy with `bantam experiment` before promotion.");
      }
    } else {
      console.log("\n(pass --repo <task-repo> to also witness silent completeness gaps)");
    }
    process.exit(0);
  }

  const turnIndex = Number(args.turn);
  const problem = problems.find((p) => p.turn === turnIndex);
  const kind = problem?.kind ?? "failed-action";
  const remedies = selectRemedies(kind, args.inject);
  if (!remedies.length) {
    process.stderr.write(
      `no candidate remedies for problem kind "${kind}"\n`
      + `pass --inject "<one true fact>" to A/B a specific context against this turn instead\n`,
    );
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
} else if (cmd === "fight") {
  // Fight Night for anyone: fan the current workspace + a task across chosen
  // corners, judge, and emit the postmortem card + replayable page.
  const { startFight, armsRoster } = await import("../src/fight.js");
  const task = String(args.task ?? "").trim();
  if (args["list-arms"]) {
    for (const a of await armsRoster()) console.log(`  ${a.available ? "●" : "✖"} ${a.name.padEnd(24)} ${a.corner.padEnd(14)} ${a.sub}${a.why ? `   ← ${a.why}` : ""}`);
    process.exit(0);
  }
  if (!task) fail("bantam fight needs --task \"...\"");
  let arms;
  const wantPicker = !args.arms && (Boolean(args.pick) || (process.stdin.isTTY && process.stderr.isTTY));
  if (wantPicker) {
    // The corner picker (operator ask, 2026-08-25): show the roster with live
    // availability, let the operator choose. Scripted callers pass --arms and
    // never see it; a non-TTY call without --arms keeps the old default trio.
    const roster = await armsRoster();
    console.error("\n  ── pick your corners ──");
    let lastPool = "";
    roster.forEach((a, i) => {
      if (a.pool !== lastPool) { console.error(`  [${a.pool}]`); lastPool = a.pool; }
      console.error(`   ${String(i + 1).padStart(2)}. ${a.available ? "●" : "✖"} ${a.name.padEnd(24)} ${a.sub}${a.why ? `   ← ${a.why}` : ""}`);
    });
    console.error("  Numbers or names select explicit participants. 'a' / Enter = available local participants only.");
    console.error("  Cloud participants send task/context to their provider and use your account. Claude Code must be selected by name or number for a direct agent comparison.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = String(await new Promise((res) => rl.question("  corners> ", res))).trim();
    rl.close();
    const avail = roster.filter((a) => a.available).map((a) => a.name);
    if (!answer || answer === "a") {
      arms = ["bantam", "hermes", "opencode"].filter((n) => avail.includes(n));
      if (!arms.length) fail('No local participants available. Select a cloud participant explicitly or configure a local server.');
    } else {
      arms = answer.split(/[\s,]+/).filter(Boolean).map((tok) => {
        if (/^\d+$/.test(tok)) return roster[Number(tok) - 1]?.name;
        return roster.find((a) => a.name === tok)?.name;
      }).filter(Boolean);
      if (!arms.length) fail(`no corners matched "${answer}" — use numbers from the list or exact arm names`);
    }
    const out = arms.filter((n) => !roster.find((a) => a.name === n).available);
    if (out.length) console.error(`  note: ${out.join(", ")} probed unavailable — they fight anyway and will judge from whatever their ws holds.`);
    console.error(`  🐓 FIGHT CARD: ${arms.join(" vs ")}\n`);
  } else {
    arms = String(args.arms ?? "bantam,hermes,opencode").split(",").map((a) => a.trim()).filter(Boolean);
  }
  const materialsDir = path.resolve(String(args.materials ?? "."));
  const fightDir = path.resolve(String(args.dir ?? `.bantam-fight-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const fightPort = Number(args.port) > 0 ? Number(args.port) : 8447;
  if (args["dry-run"]) { console.log(JSON.stringify({ task, arms, materialsDir, fightDir, port: fightPort })); process.exit(0); }
  fs.mkdirSync(fightDir, { recursive: true });
  const fight = startFight({ task, arms, materialsDir, dir: fightDir, port: fightPort, narrate: true,
    onEvent: (e) => { if (e.kind === "done" || e.kind === "status") console.log(`[${e.arm}] ${e.text}`); } });
  const post = await fight.done;
  console.log("\n=== fight night ===");
  for (const c of post.corners) console.log(c.arm.padEnd(24), `${(c.wallMs / 1000).toFixed(1)}s`, "exit", c.exitCode, post.verdicts?.[c.arm]?.outcome ?? "");
  console.log("card:  ", post.card);
  console.log("replay:", path.join(fightDir, "fight-replay.html"));
  fight.stop();
  process.exit(0);
} else if (cmd === "run") {
  // --resume-run carries the task (and, on newer checkpoints, the workspace)
  // inside the artifact. The Ctrl-C farewell prints exactly
  // `bantam run --resume-run <path>`, and that command failed here with
  // "run requires --task" before the artifact was ever opened — a rescue
  // instruction that errors when followed. Recover both from the artifact;
  // explicit flags still win.
  if (!args.task && typeof args["resume-run"] === "string") {
    try {
      const early = JSON.parse(fs.readFileSync(path.resolve(args["resume-run"]), "utf8"));
      if (typeof early.task === "string" && early.task.trim()) args.task = early.task;
      if (!args.workspace && typeof early.workspace === "string" && early.workspace) {
        args.workspace = early.workspace;
      }
    } catch { /* unreadable/unparseable falls through to the loader's own errors */ }
  }
  if (!args.task) fail(args["resume-run"]
    ? "the --resume-run artifact carries no task; pass --task explicitly"
    : "run requires --task (or run `bantam` with no args for interactive mode)");
  if (args["factory-home"] === true) fail("run --factory-home requires a directory");
  if (args["factory-home"] !== undefined && !args.factory && !envTruthy("BANTAM_FACTORY")) {
    fail("run --factory-home requires --factory (or BANTAM_FACTORY=1)");
  }
  if ((args["resume-run"] || args["review-file"] || args["through-turn"] !== undefined) && args.lane !== undefined) {
    fail("--resume-run/--review-file cannot be combined with --lane; fork/resume the lane for an exact workspace cursor");
  }
  if (args["through-turn"] !== undefined && !args["resume-run"]) {
    fail("--through-turn requires --resume-run");
  }
  if (args["resume-run"] === true) fail("--resume-run requires an artifact path");
  if (args["review-file"] === true) fail("--review-file requires a file path");

  let continuation = null;
  let resumeArtifact = null;   // hoisted: the workspace restore below (after --workspace resolves) needs it
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
      resumeArtifact = artifact;
      const hasSnap = artifact.workspaceSnapshot && Array.isArray(artifact.workspaceSnapshot.files)
        && artifact.workspaceSnapshot.files.length > 0;
      process.stderr.write(
        `continuing ${artifact.runId ?? path.basename(artifactPath)} through turn ${continuation.provenance.throughTurn}; `
        + (hasSnap
          ? `dialogue restored; ${artifact.workspaceSnapshot.files.length} workspace file(s) will be rebuilt into --workspace\n`
          : "dialogue is restored, but --workspace must already match that artifact cursor\n"),
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
  // A run whose output is redirected has nobody to answer. `interactive` gates
  // the disguised-done guard (src/agent.js isDisguisedDone), which exists to
  // stop a mid-work narration from ending the run: without it, `respond` is
  // accepted as a finished answer on an untouched tree. Ticket B rerun
  // (2026-08-16, .bantam/runs/2026-08-16T14-55-11-002Z.json) ended at turn 16
  // with reachedDone:true, zero applied edits and a respond that literally
  // closed "Reading those two files now." — it intended to continue. Attendance
  // is observable, so observe it instead of inferring it from --autonomous.
  // BANTAM_ASSUME_ATTENDED=1 forces the old behavior for a wrapper that really
  // does relay responses to a person.
  const attended = runIsAttended({ stdout: process.stdout, stdin: process.stdin, env: process.env });
  // Autonomous runs get the code KB unless told otherwise, matching interactive
  // runs (which have defaulted it on all along). The old opt-in default rested
  // on a 28-second build cost; remeasured 2026-08-16 on this tree (14,654
  // files) it is 2.5-3.6 SECONDS. Meanwhile the `query` verb was advertised in
  // the action grammar with an empty tool menu behind it, and a run asked to
  // wire a subcommand into a 4,718-line CLI read that file 54 times while
  // `flow bin/bantam.js` — which returns all 65 dispatch sites with line
  // numbers — sat unbuilt. --no-ground restores the old behavior.
  const autonomousGrounding = args["no-ground"]
    ? false
    : (Boolean(args.ground) || envTruthy("BANTAM_GROUND") || true);
  const runStamp = makeStamp();
  const runId = makeRunId(runStamp);
  let laneBridge = null;
  let factoryTelemetry = null;
  let laneStopSignal = null;
  let checkpoint = null;
  const laneRunController = new AbortController();
  const laneSignalHandlers = new Map();
  const detachLaneSignals = () => {
    for (const [signalName, handler] of laneSignalHandlers) process.off(signalName, handler);
    laneSignalHandlers.clear();
  };
  let workspace = path.resolve(args.workspace || ".");
  // Resume rebuilds the workspace from the checkpoint's embedded bytes (schema 3+),
  // so a run truncated by a harness timeout continues from its files, not cold.
  // Only fills gaps: never clobbers a file the operator already staged into --workspace.
  if (resumeArtifact?.workspaceSnapshot && Array.isArray(resumeArtifact.workspaceSnapshot.files)) {
    try { fs.mkdirSync(workspace, { recursive: true }); } catch { /* resolved below */ }
    const { written, failed, skippedExisting } = restoreWorkspace(
      resumeArtifact.workspaceSnapshot, workspace, { skipExisting: true },
    );
    if (written.length || failed.length || skippedExisting.length) {
      process.stderr.write(
        `workspace rebuilt from checkpoint: ${written.length} file(s) written`
        + (skippedExisting.length ? `, ${skippedExisting.length} left as already-present` : "")
        + (failed.length ? `, ${failed.length} refused/failed` : "")
        + "\n",
      );
    }
  }
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
  if (args.factory || envTruthy("BANTAM_FACTORY")) {
    try {
      factoryTelemetry = new FactoryRunTelemetry({
        root: resolveFactoryHome({
          cwd: process.cwd(),
          env: process.env,
          explicit: typeof args["factory-home"] === "string" ? args["factory-home"] : undefined,
        }),
        jobId: runId,
        workspace,
        task: args.task,
        verificationCommand: typeof args.verify === "string" ? args.verify : null,
        executionMode: autonomous ? "bantam-run-autonomous" : "bantam-run-interactive",
        time: new Date().toISOString(),
      });
    } catch (error) {
      laneBridge?.close();
      detachLaneSignals();
      fail(`cannot start factory telemetry: ${error.message}`);
    }
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
  let diffBaseline = null;
  let graderBefore = null;
  checkpoint = (runDest || laneBridge)
    ? new RunCheckpoint({
        dest: runDest,
        meta: {
          runId,
          stamp: runStamp,
          laneId: args.lane ?? null,
          task: args.task,
          workspace,   // so `bantam run --resume-run <path>` works from any cwd
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
  const workerControl = args['supervisor-control'] === undefined ? null : openWorkerControl(args['supervisor-control'], workspace, args.task);
  const captureEvent = (checkpoint || factoryTelemetry || workerControl)
    ? (event) => {
        checkpoint?.note(event);
        laneBridge?.note(event, checkpoint, { model });
        factoryTelemetry?.note(event);
        workerControl?.note(event);
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
    // A saved artifact recorded finalDiff: null for every run, because nothing
    // on this path ever prepared a baseline — so the one record of what the run
    // PRODUCED was missing from exactly the artifact kept for diagnosis. Only
    // for --save-run, and never by committing to a repository that already
    // exists: skipIfRepo leaves a real working tree alone and captureFinalDiff
    // diffs against its own HEAD instead.
    diffBaseline = runDest ? prepareDiffBaseline(workspace, { skipIfRepo: true }) : null;
    // The run is graded by --verify, so a green means nothing if the model
    // rewrote the tests that command runs. scope-guard exists for exactly this
    // and was wired only into the eval path; a three-turn probe on 2026-08-17
    // turned `assert.equal(1, 9)` into `assert.equal(9, 9)` and recorded
    // pass: true. Reported, never blocked — `bantam run` is a general CLI and
    // "change that test" is a legitimate request.
    graderBefore = args.verify ? graderSnapshot(workspace, { verifyCommand: args.verify }) : null;
    res = await runAgent({
      task: args.task,
      supportingContext: typeof args["supporting-context-file"] === "string"
        ? fs.readFileSync(args["supporting-context-file"], "utf8") : "",
      drainInjections: workerControl ? () => workerControl.drain() : null,
      inheritedInstructionScope: workerControl?.instructionScope ?? null,
      workspace,
      shellNetwork: args["dangerously-allow-net"] ? true : undefined,
      model,
      maxTurns: runMaxTurns,
      ...(args["write-batch"] === true ? { writeBatch: true } : {}),
      verificationScript: args.verify || null,
      verificationWorkspaceReadOnly: args["verify-workspace-read-only"] ? true : undefined,
      // --no-edit: answer questions about a codebase without touching it. The
      // model's own prompt already says a QUESTION deserves an ANSWER rather
      // than a file change, and asked politely it still edited — on the joblog
      // project (2026-08-17) "just explain it, don't change anything yet" got a
      // correct explanation AND six edit turns. runAgent has enforced
      // excludeActions all along, in the grammar and again at parse time; it was
      // simply not reachable from the CLI, so there was no way to ask.
      excludeActions: args["no-edit"] ? [...EDIT_ACTIONS] : undefined,
      thinkMode,
      skills: skillsCfg,
      postVerifyIntegrity: skillSnapshot ? () => checkWorkspace(skillSnapshot, workspace, {}) : null,
      planMode,
      preGate: !args["no-pregate"],
      // Default: a human asked for this, so run clean (no autonomous guardrails). `--autonomous`
      // restores the gates for headless runs where nothing is watching.
      interactive: !autonomous && attended,
      // Grounding (datalog KB + query tool): mirror the REPL for interactive runs (on, --no-ground
      // to disable); opt-in via --ground for --autonomous so unattended defaults stay conservative.
      grounding: autonomous ? autonomousGrounding : !args["no-ground"],
      resumeTurns: laneBridge?.resumeTurns ?? continuation?.resumeTurns ?? null,
      signal: laneBridge ? laneRunController.signal : null,
      onEvent: captureEvent,
    });
    // Restored turns predate this process snapshot. Do not attach a new-segment
    // total to a historical prefix and pretend it is complete.
    const restoredPrefix = Boolean(continuation || laneBridge?.resumeTurns?.length);
    if (!restoredPrefix) {
      res.usage = modelUsageDelta(usageBefore, modelUsageSnapshot(model));
      res.usageBySource = modelUsageBreakdownDelta(
        usageBreakdownBefore,
        modelUsageBreakdownSnapshot(model),
      );
    }
    const factoryReport = factoryTelemetry?.finish(res) ?? null;
    if (factoryReport && !factoryReport.ok) {
      process.stderr.write(`warning: factory telemetry incomplete: ${factoryReport.error}\n`);
    }
    if (!laneBridge) {
      observeCompletedSelfHostRun({
        launcherWorkspace: repoRoot(),
        taskWorkspace: workspace,
        task: args.task,
        result: res,
        warn: (warning) => {
          process.stderr.write(`warning: ${warning}\n`);
        },
      });
    }
    const graderTamperingFound = graderBefore
      ? (() => { try { return graderTampering(graderBefore, graderSnapshot(workspace, { verifyCommand: args.verify }), { verifyCommand: args.verify }); } catch { return []; } })()
      : [];
    if (graderTamperingFound.length) {
      // Loud, because it invalidates the verdict printed right above it.
      process.stderr.write(`\n⚠ the graded tests changed during this run — a PASS here is not evidence: ${
        graderTamperingFound.map((v) => `${v.change} ${v.path}`).join(", ")}\n`);
    }
    if (tui) tui.finish(res); else printResult(res);
    if (runDest || laneBridge) {
      // Teardown wall-clock (BANTAM_TEARDOWN_TIMING=1): the not-fastest audit
      // measured ~3.5-4.3s between run end and artifact-on-disk on EVERY card
      // — inside the filed fight wall. Name the station before fixing it.
      const tdT = process.env.BANTAM_TEARDOWN_TIMING === "1" ? [] : null;
      const tdMark = (label, t0) => { if (tdT) tdT.push(`${label} ${Date.now() - t0}ms`); };
      let tdt = Date.now();
      const modelId = activeModelId ?? await fetchModelId(model.endpoint);
      tdMark("fetchModelId", tdt); tdt = Date.now();
      const gitState = harnessGit();
      tdMark("harnessGit", tdt); tdt = Date.now();
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
        // Wrapped: a forensics failure must never cost the artifact itself,
        // which is the same rule the SWE-bench runner learned this morning.
        finalDiff: diffBaseline
          ? (() => { try { return captureFinalDiff(workspace); } catch (e) { return { status: "unavailable", reason: String(e?.message ?? e) }; } })()
          : null,
        graderTampering: graderTamperingFound,
        // Embed the agent-authored workspace so this artifact is RESUMABLE
        // anywhere, not just in the container that produced it.
        //
        // The consumer half already existed (--resume-run restores
        // artifact.workspaceSnapshot); only the producer was missing, so a
        // saved run carried the dialogue and none of the files. That is the
        // whole OUT-OF-BUDGET class: on 2026-08-21 three of nine standing
        // terminal-bench reds were runs cut mid-work — gcode-to-text at turn 22
        // holding a parsed toolpath, write-compressor at 80 holding a
        // half-built arithmetic coder — and each had to start again from zero
        // because its files died with its container.
        //
        // snapshotWorkspace is already lean by construction (per-file cap,
        // total cap, NUL-byte binary sniff), so weights and binaries cannot get
        // in. Wrapped for the same reason as finalDiff: a forensics failure
        // must never cost the artifact itself.
        workspaceSnapshot: (() => {
          try { return snapshotWorkspace(workspace); } catch { return null; }
        })(),
      });
      tdMark("buildArtifact", tdt); tdt = Date.now();
      // saveArtifact is a synchronous atomic rename. Keep the partial checkpoint
      // armed until that rename succeeds; if it throws, the catch below writes
      // exception evidence instead of leaving neither artifact.
      if (runDest) {
        saveArtifact(runDest, artifact);
        tdMark("saveArtifact", tdt); tdt = Date.now();
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
      if (tdT) console.log(`teardown: ${tdT.join(" · ")}`);
      if (runDest) console.log(`saved run artifact: ${runDest}`);
      if (laneFinished) console.log(`lane checkpoint: ${args.lane}@${laneFinished.lane.eventId}`);
    }
    if (factoryReport) {
      console.log(`factory traveler: ${factoryReport.jobId} (${factoryReport.eventCount} events, ${factoryReport.overheadMs.toFixed(1)}ms telemetry)`);
    }
  } catch (error) {
    checkpoint?.flush("exception");
    try { factoryTelemetry?.abort(error); } catch { /* retain the original failure */ }
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
    // Unknown statuses must still name themselves. `contract-fail` -- the ordinary
    // hidden-grader failure -- was not in this chain and rendered as "----", so a
    // real failure was indistinguishable from a status the CLI had never heard of.
    const TAGS = { pass: "PASS", cheated: "CHEAT", fail: "FAIL", "contract-fail": "FAIL", "expectation-miss": "MISS", "quota-exhausted": "QUOTA" };
    const tag = TAGS[r.status] ?? String(r.status ?? "unknown").toUpperCase().slice(0, 5);
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
  // An empty account is not a fixture failure. Say so, say when it lifts, and name
  // the alternative -- on 2026-08-01 this surfaced as "evidence-invalid,
  // modelFailure: null", which sent an hour into debugging the harness.
  const quotaRow = rows.find((r) => r.status === "quota-exhausted" || /usage limit|quota/i.test(String(r.modelFailure?.message ?? "")));
  if (quotaRow) {
    const notice = parseQuotaNotice(quotaRow.modelFailure?.message ?? "", new Date());
    if (notice) console.log(formatQuotaNotice(notice));
  }
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
    // Power check: cheap, needs nothing run, and answers "could this design see
    // the effect at all?" -- the question four nulls on 2026-07-30 were spent
    // discovering. Only fires when the author states what they hope to
    // distinguish, via --baseline/--target; an author who cannot state those has
    // not yet decided what the experiment is for.
    const baseline = Number(args.baseline);
    const target = Number(args.target);
    if (Number.isFinite(baseline) && Number.isFinite(target)) {
      const { powerWarning } = await import("../src/logic/experiment-power.js");
      const warning = powerWarning(spec, { baseline, target });
      if (warning) process.stderr.write("\n" + warning + "\n");
    }
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
  const codexArm = spec.arms.find((arm) => arm.model?.runtime === "codex");
  let catalog = [];
  if (codexArm) {
    const catalogClient = new ModelClient(modelOptionsForGauntletArm(codexArm.model));
    try { catalog = await catalogClient.listCodexModels(); } catch { /* snapshot fallback below */ }
    finally { catalogClient.close?.(); }
  }
  const { writeJsonAtomic } = await import("../src/atomic-file.js");
  writeJsonAtomic(path.join(outputDir, "catalog.json"), {
    capturedAt: new Date().toISOString(),
    source: catalog.length ? "codex-app-server" : "bantam-fallback",
    models: catalog.length ? catalog : codexModelOptions([]),
  });
  const showcasePath = path.join(outputDir, "showcase", "index.html");
  writeGauntletShowcase(showcasePath, outcome.manifest, {
    evidenceHref: "../../",
    title: spec.name,
  });
  console.log(`\n${formatExperimentSummary(outcome.manifest)}`);
  console.log(`manifest: ${outcome.manifestPath}`);
  console.log(`showcase: ${showcasePath}`);
  return outcome.exitCode;
}

async function auditCodexCommand() {
  const artifactPaths = args._.slice(1);
  if (!artifactPaths.length || args.help) {
    console.log("usage: bantam audit-codex <run-artifact.json> [...] [--json] [--calls]");
    return artifactPaths.length ? 0 : 2;
  }
  const { auditCodexArtifactFile } = await import("../src/codex-artifact-audit.js");
  const reports = [];
  try {
    for (const artifactPath of artifactPaths) {
      reports.push(auditCodexArtifactFile(artifactPath, { includeCalls: Boolean(args.calls) }));
    }
  } catch (error) {
    console.error(`audit-codex: ${error.message}`);
    return 2;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    for (const report of reports) {
      const detail = report.status === "pass"
        ? `${report.exactCalls}/${report.auditedCalls} exact, ${report.uniqueThreads} thread(s)`
        : report.status === "not-applicable"
          ? "not a Codex artifact"
          : `${report.failures.length} integrity failure(s)`;
      process.stdout.write(`${report.status.toUpperCase()}  ${report.file}  ${detail}\n`);
      for (const failure of report.failures) {
        process.stdout.write(`  call ${failure.callIndex ?? "-"} [${failure.code}] ${failure.message}\n`);
      }
      for (const call of report.callAudits ?? []) {
        const saved = call.savedRatio === null ? "-" : `${(call.savedRatio * 100).toFixed(1)}%`;
        const duration = call.durationMs === null ? "-" : `${(call.durationMs / 1000).toFixed(3)}s`;
        process.stdout.write(
          `  call ${call.callIndex} ${call.exact ? "exact" : "FAIL"} ${call.mode ?? "-"}`
          + ` prompt ${call.deliveredChars ?? "-"}/${call.canonicalChars ?? "-"} saved ${saved}`
          + ` input ${call.inputTokens ?? "-"} cache ${call.cacheHitTokens ?? "-"}`
          + ` miss ${call.cacheMissTokens ?? "-"} output ${call.outputTokens ?? "-"}`
          + ` reasoning ${call.reasoningTokens ?? "-"} time ${duration}\n`,
        );
      }
    }
  }
  return reports.every((report) => report.status !== "fail") ? 0 : 1;
}

async function auditRunCommand() {
  const artifactPaths = args._.slice(1);
  if (!artifactPaths.length || args.help) {
    console.log("usage: bantam audit-run <run-artifact.json> [...] [--json]");
    return artifactPaths.length ? 0 : 2;
  }
  const {
    auditRunArtifactFile,
    formatRunArtifactAudit,
  } = await import("../src/run-artifact-audit.js");
  const reports = artifactPaths.map((artifactPath) => auditRunArtifactFile(artifactPath));
  if (args.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    process.stdout.write(`${reports.map(formatRunArtifactAudit).join("\n")}\n`);
  }
  return reports.every((report) => report.status === "pass") ? 0 : 1;
}

async function gauntletCommand() {
  if (args.help) {
    console.log(`Usage: ./bin/run-dev.sh gauntlet [options]

Run identical isolated coding fixtures through any selected local or live Codex models.

Options:
  --models local,sol,terra   arms to run (default: all three)
  --fixtures <list>          built-in fixtures (default: all seven)
  --rounds <n>               balanced repeated rounds (default: 1)
  --effort <level>           Codex reasoning level (default: high)
  --codex-thread-mode <mode> run (default) or ephemeral (full-prompt rollback)
  --codex-prompt-mode <mode> delta (default with run) or full
  --codex-rebase-every <n> rotate delta threads after n calls; 0 disables periodic rebasing
  --codex-rebase-min-savings <ratio> adaptively rotate when delta savings fall below 0..1
  --think <mode>             off|auto|always for local arms (default: auto)
  --quick                    run only the first selected fixture
  --faults                   run transport/model fault injections first
  --faults-only              run fault injections without model fixtures
  --output <dir>             evidence directory
  --dry-run                  print the normalized spec and schedule
  --baseline <rate> --target <rate>   with --dry-run, check the design can detect that effect

Fixtures: ${GAUNTLET_FIXTURES.join(", ")}
Models (offline catalog): ${Object.keys(GAUNTLET_MODELS).join(", ")}`);
    return 0;
  }
  let catalog = [];
  const catalogClient = new ModelClient({
    codex: true,
    model: "gpt-5.6-terra",
    codexEffort: "medium",
  });
  try {
    catalog = await catalogClient.listCodexModels();
  } catch {
    // The checked-in fallback still makes dry runs and offline diagnostics useful.
  } finally {
    catalogClient.close?.();
  }
  const modelRegistry = gauntletModelRegistry(catalog);
  const defaultModels = ["local", "sol", "terra"].filter((name) => modelRegistry[name]);
  const models = parseGauntletList(args.models, defaultModels);
  const fixtures = parseGauntletList(args.fixtures, GAUNTLET_FIXTURES);
  const spec = createGauntletSpec({
    root: repoRoot(),
    models,
    fixtures,
    rounds: args.rounds ?? 1,
    effort: typeof args.effort === "string" ? args.effort : null,
    quick: Boolean(args.quick),
    thinkMode: typeof args.think === "string" ? args.think : "auto",
    modelRegistry,
  });
  if (args["dry-run"]) {
    console.log(JSON.stringify({ spec, schedule: buildExperimentSchedule(spec) }, null, 2));
    return 0;
  }
  const faultResult = args.faults || args["faults-only"]
    ? runGauntletFaultTests()
    : null;
  if (args["faults-only"]) return faultResult.pass ? 0 : 1;

  const resolvedFixtures = resolveExperimentFixtures(spec.fixtures);
  const startedAt = new Date().toISOString();
  const preview = createExperimentManifest({ spec, startedAt });
  const outputDir = path.resolve(
    typeof args.output === "string"
      ? args.output
      : path.join(".bantam", "gauntlets", preview.id),
  );
  console.log(`\n=== ${spec.name} ===`);
  console.log(`evidence: ${outputDir}`);
  const outcome = await runExperiment({
    spec,
    fixtures: resolvedFixtures,
    outputDir,
    id: preview.id,
    startedAt,
    harnessGit: harnessGit(),
    sourceSpec: "builtin:gauntlet",
    invocation: { command: "gauntlet", models, fixtures, faults: Boolean(faultResult) },
    createModel: (arm, context) => new ModelClient({
      ...modelOptionsForGauntletArm(arm.model, {
        endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
        profile: typeof args.profile === "string" ? args.profile : undefined,
        codexThreadMode: typeof args["codex-thread-mode"] === "string"
          ? args["codex-thread-mode"]
          : undefined,
        codexPromptMode: typeof args["codex-prompt-mode"] === "string"
          ? args["codex-prompt-mode"]
          : undefined,
        codexRebaseEvery: typeof args["codex-rebase-every"] === "string"
          ? Number(args["codex-rebase-every"])
          : undefined,
        codexRebaseMinSavings: typeof args["codex-rebase-min-savings"] === "string"
          ? Number(args["codex-rebase-min-savings"])
          : undefined,
      }),
      seed: context.seed,
    }),
    // This command intentionally runs before the decorated interactive logger
    // is initialized, so model fixtures never trigger default endpoint setup.
    onEvent: () => {},
    onRunStart: ({ entry, arm, fixture }) => {
      process.stderr.write(`\n> gauntlet r${entry.round}/${spec.rounds} | ${arm.name} | ${fixture.name}\n`);
    },
    onRunComplete: ({ entry, row }) => console.log(formatExperimentRow(entry, row)),
  });
  if (faultResult) {
    const { writeJsonAtomic } = await import("../src/atomic-file.js");
    writeJsonAtomic(path.join(outputDir, "faults.json"), faultResult);
  }
  const { writeJsonAtomic } = await import("../src/atomic-file.js");
  writeJsonAtomic(path.join(outputDir, "catalog.json"), {
    capturedAt: new Date().toISOString(),
    source: catalog.length ? "codex-app-server" : "bantam-fallback",
    models: catalog.length ? catalog : codexModelOptions([]),
    aliases: Object.fromEntries(
      Object.entries(modelRegistry).map(([name, entry]) => [name, entry.model]),
    ),
  });
  const showcasePath = path.join(outputDir, "showcase", "index.html");
  writeGauntletShowcase(showcasePath, outcome.manifest, { evidenceHref: "../../" });
  console.log(`\n${formatExperimentSummary(outcome.manifest)}`);
  console.log(`manifest: ${outcome.manifestPath}`);
  console.log(`showcase: ${showcasePath}`);
  return outcome.exitCode;
}

async function trioCommand() {
  const subcommand = args._[1] && !String(args._[1]).startsWith("-")
    ? String(args._[1]).toLowerCase()
    : "run";
  if (args.help) {
    console.log(trioUsage());
    return 0;
  }
  if (subcommand === "show" || subcommand === "status") {
    const sessionDir = args._[2] || args.session;
    if (!sessionDir) {
      process.stderr.write("trio show requires a session directory\n");
      return 2;
    }
    try {
      const manifest = loadTrioManifest(path.resolve(sessionDir));
      console.log(formatTrioComparison(buildTrioComparison(manifest)));
      console.log(`session: ${path.resolve(sessionDir)}`);
      console.log(`report: ${path.join(path.resolve(sessionDir), "report", "index.html")}`);
      return 0;
    } catch (error) {
      process.stderr.write(`trio show: ${error.message}\n`);
      return 1;
    }
  }
  if (subcommand === "apply") {
    const sessionDir = args._[2] || args.session;
    const arm = typeof args.arm === "string" ? args.arm : args._[3];
    if (!sessionDir || !arm) {
      process.stderr.write("trio apply requires <session-dir> --arm <local|sol|terra>\n");
      return 2;
    }
    if (!args.yes) {
      process.stderr.write(
        "trio apply changes the live source workspace. Inspect the report, then re-run with --yes.\n",
      );
      return 2;
    }
    try {
      const applied = await applyTrioArm({
        sessionDir: path.resolve(sessionDir),
        arm,
        workspace: typeof args.workspace === "string" ? path.resolve(args.workspace) : null,
        verificationScript: typeof args.verify === "string" ? args.verify : null,
        timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) : 120_000,
      });
      console.log(`Applied trio arm ${applied.arm} to ${applied.workspace}.`);
      console.log(`Verifier: ${applied.verification.status}`);
      return 0;
    } catch (error) {
      process.stderr.write(`trio apply: ${error.message}\n`);
      return 1;
    }
  }
  if (subcommand !== "run") {
    process.stderr.write(`unknown trio command: ${subcommand}\n${trioUsage()}\n`);
    return 2;
  }
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    process.stderr.write(`trio run requires --task "..." \n${trioUsage()}\n`);
    return 2;
  }
  const workspace = path.resolve(typeof args.workspace === "string" ? args.workspace : ".");
  let stat;
  try { stat = fs.lstatSync(workspace); } catch { /* handled below */ }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    process.stderr.write(`trio workspace is not a real directory: ${workspace}\n`);
    return 2;
  }
  let models;
  try {
    models = parseGauntletList(args.models, ["local", "sol", "terra"]);
  } catch (error) {
    process.stderr.write(`trio: ${error.message}\n`);
    return 2;
  }
  const verifier = typeof args.verify === "string"
    ? args.verify
    : (detectVerifier(workspace)?.command ?? null);
  const stateRoot = path.resolve(
    typeof args.output === "string"
      ? args.output
      : path.join(workspace, ".bantam", "trios"),
  );
  const effort = typeof args.effort === "string" ? args.effort : "medium";
  const clients = new Map();
  let session;
  try {
    session = new TrioSession({
      workspace,
      stateRoot,
      arms: models,
      effort,
      verificationScript: verifier,
      maxTurns: Number(args["max-turns"]) > 0 ? Number(args["max-turns"]) : 30,
      thinkMode: typeof args.think === "string" ? args.think : "auto",
      modelFactory: async (arm) => {
        const client = new ModelClient(modelOptionsForGauntletArm(arm.model, {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          profile: typeof args.profile === "string" ? args.profile : undefined,
          codexThreadMode: typeof args["codex-thread-mode"] === "string"
            ? args["codex-thread-mode"]
            : undefined,
          codexPromptMode: typeof args["codex-prompt-mode"] === "string"
            ? args["codex-prompt-mode"]
            : undefined,
          codexRebaseEvery: typeof args["codex-rebase-every"] === "string"
            ? Number(args["codex-rebase-every"])
            : undefined,
          codexRebaseMinSavings: typeof args["codex-rebase-min-savings"] === "string"
            ? Number(args["codex-rebase-min-savings"])
            : undefined,
        }));
        client.onUsage = ({ entry }) => {
          process.stdout.write(`[${arm.name}] usage ${formatUsage(entry)}\n`);
        };
        clients.set(arm.name, client);
        return client;
      },
      onEvent: trioEventLogger(),
    });
    await session.start();
    console.log(`Trio session: ${session.directory}`);
    console.log(`Baseline frozen; live workspace will not be changed.`);
    if (verifier) console.log(`Verifier: ${verifier}`);
    const outcome = await session.runTurn(task);
    console.log(`\n${formatTrioComparison(outcome.comparison)}`);
    for (const row of outcome.rows) {
      console.log(`\n${row.arm.toUpperCase()}\n${row.summary || row.status}`);
    }
    console.log(`\nreport: ${path.join(session.directory, "report", "index.html")}`);
    console.log(`apply: ./bin/run-dev.sh trio apply ${session.directory} --arm <name> --yes`);
    return outcome.comparison.allPassed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`trio: ${error.message}\n`);
    return 1;
  } finally {
    session?.close();
    for (const client of clients.values()) client.close();
  }
}

async function delegateCommand() {
  const subcommand = String(args._[1] ?? "run").toLowerCase();
  if (args.help) {
    console.log(delegateUsage());
    return 0;
  }
  if (subcommand === "show" || subcommand === "status") {
    const target = args._[2] || args.artifact;
    if (!target) {
      process.stderr.write("delegate show requires an artifact or run directory\n");
      return 2;
    }
    try {
      const { artifact } = loadNativeDelegate(target);
      console.log(args.json ? JSON.stringify(artifact, null, 2) : formatNativeDelegate(artifact));
      return artifact.result.pass ? 0 : 1;
    } catch (error) {
      process.stderr.write(`delegate show: ${error.message}\n`);
      return 1;
    }
  }
  if (subcommand === "compare") {
    const sources = args._.slice(2);
    if (sources.length < 2) {
      process.stderr.write("delegate compare requires at least two artifacts, run directories, or experiment manifests\n");
      return 2;
    }
    try {
      const comparison = compareExecutionEvidence(sources);
      console.log(args.json ? JSON.stringify(comparison, null, 2) : formatExecutionComparison(comparison));
      return comparison.allPassed ? 0 : 1;
    } catch (error) {
      process.stderr.write(`delegate compare: ${error.message}\n`);
      return 1;
    }
  }
  if (subcommand === "apply") {
    const target = args._[2] || args.artifact;
    if (!target) {
      process.stderr.write("delegate apply requires an artifact or run directory\n");
      return 2;
    }
    if (!args.yes) {
      process.stderr.write(
        "delegate apply changes the live source workspace. Inspect the artifact, then re-run with --yes.\n",
      );
      return 2;
    }
    try {
      const result = await applyNativeDelegate({
        artifactPath: target,
        workspace: typeof args.workspace === "string" ? path.resolve(args.workspace) : null,
        verificationScript: typeof args.verify === "string" ? args.verify : null,
        timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) : 120_000,
      });
      console.log(`Applied native CLI delegate to ${result.workspace}.`);
      console.log(`Verifier: ${result.verification.status}`);
      return 0;
    } catch (error) {
      process.stderr.write(`delegate apply: ${error.message}\n`);
      return 1;
    }
  }
  if (subcommand !== "run") {
    process.stderr.write(`unknown delegate command: ${subcommand}\n${delegateUsage()}\n`);
    return 2;
  }
  if (!args.yes) {
    process.stderr.write(
      "Native CLI delegation is research-only: current same-task evidence found BANTAM-constrained "
      + "Codex faster and substantially lower in total token processing. "
      + "Use normal :model codex-sol/codex-terra for ordinary work. "
      + "To authorize a measured native experiment, re-run delegate run with --yes.\n",
    );
    return 2;
  }
  const task = typeof args.task === "string" ? args.task.trim() : args._.slice(2).join(" ").trim();
  if (!task) {
    process.stderr.write(`delegate run requires --task "..."\n${delegateUsage()}\n`);
    return 2;
  }
  const workspace = path.resolve(typeof args.workspace === "string" ? args.workspace : ".");
  const provider = typeof args.provider === "string" ? args.provider : "codex";
  const bypassSandbox = args["bypass-sandbox"] === true;
  if (bypassSandbox && provider !== "codex") {
    process.stderr.write("delegate run --bypass-sandbox is supported only for the Codex provider\n");
    return 2;
  }
  const verifier = typeof args.verify === "string"
    ? args.verify
    : (detectVerifier(workspace)?.command ?? null);
  try {
    const result = await runNativeDelegate({
      provider,
      workspace,
      task,
      ...(typeof args.model === "string" ? { model: args.model } : {}),
      ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
      ...(typeof args["permission-mode"] === "string" ? { permissionMode: args["permission-mode"] } : {}),
      ...(bypassSandbox ? { bypassSandbox: true } : {}),
      verificationScript: verifier,
      timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) : 900_000,
      verifyTimeoutMs: Number(args["verify-timeout"]) > 0 ? Number(args["verify-timeout"]) : 120_000,
      stateRoot: typeof args.output === "string" ? path.resolve(args.output) : null,
      onEvent: ({ event }) => {
        if (event?.type === "delegate_started") {
          process.stderr.write(`delegate: ${event.model} · ${event.effort} · isolated native ${event.provider === "claude" ? "Claude Code" : "Codex"}\n`);
        } else if (event?.type === "delegate_progress") {
          process.stderr.write(safeShellOutput(event.text));
        }
      },
    });
    console.log(`\n${formatNativeDelegate(result.artifact)}`);
    console.log(`\nartifact: ${result.artifactPath}`);
    if (result.artifact.finalDiff.fileCount > 0) {
      console.log(`apply: ./bin/run-dev.sh delegate apply ${result.directory} --yes`);
    }
    return result.artifact.result.pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(`delegate: ${error.message}\n`);
    return 1;
  }
}

function delegateUsage() {
  return `Usage:
  ./bin/run-dev.sh delegate run --yes --provider codex|claude --task "..." [options]
  ./bin/run-dev.sh delegate show <artifact-or-run-dir> [--json]
  ./bin/run-dev.sh delegate compare <evidence> <evidence> [...]
  ./bin/run-dev.sh delegate apply <artifact-or-run-dir> --yes [--verify "npm test"]

RESEARCH-ONLY: measured same-task evidence currently favors BANTAM-constrained
Codex in elapsed time and total token processing. Native execution requires
explicit --yes so it cannot be selected accidentally. For ordinary work, use
:model codex-sol or :model codex-terra and remain inside the BANTAM harness.

When explicitly authorized, Codex or Claude Code runs as an independent coding
delegate in an external isolated candidate. BANTAM freezes the baseline,
captures the complete native JSONL stream and usage, runs its own verifier, and
leaves the source unchanged.
Compare accepts native artifacts and BANTAM experiment manifests and renders
their pass status, turns, requests, token/cache accounting, reasoning, and time.

Run options:
  --workspace <dir>       source workspace (default: .)
  --provider <name>       codex (default) or claude
  --model <name>          Codex sol|terra; Claude opus|sonnet|fable or exact id
  --effort <level>        provider reasoning effort (default: high)
  --permission-mode <m>   Claude acceptEdits (default) or auto
  --bypass-sandbox        Codex only: explicit host-sandbox bypass for broken bwrap
  --verify "<command>"    authoritative verifier (auto-detected when omitted)
  --timeout <ms>          native agent deadline (default: 900000)
  --verify-timeout <ms>   verifier deadline (default: 120000)
  --output <dir>          evidence root (default: <workspace>/.bantam/delegates)

Apply is separately consented, baseline-bound, candidate-verified,
transactional, live-verified, and automatically rolled back on failure.`;
}

function trioEventLogger(output = (line) => process.stdout.write(`${line}\n`)) {
  const lastAction = new Map();
  const shellOutput = new Map();
  const shellLimit = 12_000;
  const write = (line) => output(line);
  return ({ arm, event }) => {
    if (!arm || !event) return;
    const prefix = `[${arm}]`;
    if (event.type === "trio_health") {
      write(`${prefix} ${event.ok ? "ready" : "unavailable"}`);
    } else if (event.type === "trio_arm_started") {
      write(`${prefix} started in isolated workspace`);
    } else if (event.type === "action") {
      lastAction.set(arm, event.action?.a ?? null);
      if (event.action?.a === "shell") shellOutput.set(arm, 0);
      if (!["done", "respond"].includes(event.action?.a)) {
        write(`${prefix} ${describeAction(event.action)}`);
      }
    } else if (event.type === "thinking") {
      const text = String(event.text ?? "").replace(/\s+/g, " ").trim();
      if (text) write(`${prefix} · ${text.slice(0, 220)}${text.length > 220 ? " …" : ""}`);
    } else if (event.type === "shell_output" && lastAction.get(arm) === "shell") {
      const used = shellOutput.get(arm) ?? 0;
      if (used >= shellLimit) return;
      const raw = String(event.text ?? "");
      const remaining = shellLimit - used;
      const clipped = raw.slice(0, remaining);
      shellOutput.set(arm, used + clipped.length);
      for (const line of clipped.trimEnd().split("\n").filter(Boolean)) {
        write(`${prefix} │ ${line}`);
      }
      if (raw.length > remaining) write(`${prefix} │ … shell output clipped at ${shellLimit.toLocaleString()} characters`);
    } else if (event.type === "verification") {
      write(`${prefix} verifier ${event.verification?.status ?? "unknown"}`);
    } else if (event.type === "invalid") {
      write(`${prefix} malformed action${event.error ? `: ${event.error}` : ""}`);
    } else if (event.type === "trio_arm_completed") {
      write(
        `${prefix} completed ${event.row.status} `
        + `(${event.row.turns} turns, ${Math.round(event.row.durationMs / 1000)}s)`,
      );
    } else if (event.type === "trio_arm_error") {
      write(`${prefix} failed: ${event.error}`);
    }
  };
}

function trioUsage() {
  return `Usage:
  ./bin/run-dev.sh trio run --task "..." [options]
  ./bin/run-dev.sh trio show <session-dir>
  ./bin/run-dev.sh trio apply <session-dir> --arm <local|sol|terra> --yes

Run the ordinary BANTAM agent concurrently through isolated model workspaces.
The source workspace remains unchanged until an explicit verified apply.

Run options:
  --workspace <dir>          source workspace (default: .)
  --verify "<command>"       project verifier (auto-detected when omitted)
  --models local,sol,terra   selected arms (default: all)
  --effort <level>           Codex reasoning effort (default: high)
  --max-turns <n>            per-arm turn limit (default: 30)
  --endpoint <url>           local-model endpoint
  --output <dir>             trio state root (default: <workspace>/.bantam/trios)

Apply verifies the selected candidate, refuses a changed live baseline, applies
transactionally, verifies the live workspace, and rolls back on failure.`;
}

function runGauntletFaultTests() {
  const startedAt = new Date().toISOString();
  const files = [
    path.join(repoRoot(), "test", "codex-transport.test.js"),
    path.join(repoRoot(), "test", "model-codex-recovery.test.js"),
    path.join(repoRoot(), "test", "model-codex-timeout.test.js"),
    path.join(repoRoot(), "test", "agent.test.js"),
  ];
  try {
    execFileSync(process.execPath, ["--test", "--test-reporter=dot", ...files], {
      cwd: repoRoot(),
      stdio: "inherit",
      env: { ...process.env, BANTAM_NO_FACTS: "1" },
    });
    return { schema: 1, pass: true, startedAt, completedAt: new Date().toISOString(), files };
  } catch (error) {
    return {
      schema: 1,
      pass: false,
      startedAt,
      completedAt: new Date().toISOString(),
      files,
      exitCode: Number.isInteger(error?.status) ? error.status : null,
      error: error?.message ?? String(error),
    };
  }
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
  const explicitNative = typeof args.endpoint === "string";
  const explicitCodex = args.codex === true;
  const explicitDeepSeek = args.deepseek === true;
  const useSavedApi = !explicitNative
    && !explicitCodex
    && typeof args["api-url"] !== "string"
    && !process.env.BANTAM_API_URL
    // `run-dev.sh` exports the detected local endpoint. An explicit DeepSeek
    // selection must outrank that launcher convenience or it silently routes
    // the requested online model to localhost.
    && (explicitDeepSeek || !process.env.BANTAM_ENDPOINT);
  return {
    endpoint: args.endpoint,
    profile: args.profile,
    temperature: args.temperature ? Number(args.temperature) : undefined,
    actTemperature: typeof args["act-temperature"] === "string" ? Number(args["act-temperature"]) : undefined,
    topP: args["top-p"] ? Number(args["top-p"]) : undefined,
    topK: args["top-k"] ? Number(args["top-k"]) : undefined,
    // OpenAI-compatible transport: point at an existing /v1 server by URL. Flags
    // and env win; otherwise fall back to a config saved by `bantam doctor --api-url`.
    apiUrl: explicitNative || explicitCodex
      ? null
      : (typeof args["api-url"] === "string" ? args["api-url"] : (useSavedApi ? savedApi?.apiUrl : undefined)),
    apiKey: typeof args["api-key"] === "string"
      ? args["api-key"]
      : ((process.env.BANTAM_API_KEY || process.env.DEEPSEEK_API_KEY) ? undefined : (useSavedApi ? savedApi?.apiKey : undefined)),
    model: explicitCodex
      ? resolveCodexModelAlias(typeof args.model === "string" ? args.model : null)
      : (typeof args.model === "string" ? args.model : (useSavedApi ? savedApi?.model : undefined)),
    apiDialect: typeof args["api-dialect"] === "string" ? args["api-dialect"] : (useSavedApi ? savedApi?.dialect : undefined),
    deepseek: args.deepseek === true ? true : (useSavedApi && savedApi?.deepseek === true),
    codex: args.codex === true,
    codexEffort: typeof args["codex-effort"] === "string"
      ? args["codex-effort"]
      : (explicitCodex && typeof args.effort === "string" ? args.effort : undefined),
    codexThreadMode: typeof args["codex-thread-mode"] === "string"
      ? args["codex-thread-mode"]
      : undefined,
    codexPromptMode: typeof args["codex-prompt-mode"] === "string"
      ? args["codex-prompt-mode"]
      : undefined,
    codexRebaseEvery: typeof args["codex-rebase-every"] === "string"
      ? Number(args["codex-rebase-every"])
      : undefined,
    codexRebaseMinSavings: typeof args["codex-rebase-min-savings"] === "string"
      ? Number(args["codex-rebase-min-savings"])
      : undefined,
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

function emitExecResult(json, { pass, status, turns = 0, durationMs = 0, error = null, usage = null }) {
  if (json) {
    console.log(JSON.stringify(buildExecResult({ pass, status, turns, durationMs, error, usage })));
    return;
  }
  console.log(`RESULT ${pass ? "pass" : "fail"} ${status}${error ? ` ${error}` : ""}`);
}

async function execCommand() {
  const json = args.json === true;
  const startTime = Date.now();
  let resultEmitted = false;
  let evidenceAppend = null;   // set once the workspace is known
  const finish = (code, status, { pass = false, turns = 0, error = null, usage = null } = {}) => {
    const payload = { pass, status, turns, durationMs: Date.now() - startTime, error, usage };
    resultEmitted = true;
    try { evidenceAppend?.({ type: "result", exitCode: code, ...payload }); } catch { /* evidence never blocks the exit */ }
    emitExecResult(json, payload);
    process.exit(code);
  };
  // NO path may end this process silently. Measured 2026-08-23: a run died 29s
  // in — empty stderr, an event stream that just stopped — and its watcher
  // could not tell a crash from a hang. Three layers close every route out:
  // last words on 'exit' (any exit that never emitted a result emits one),
  // crash handlers that route through finish, and signal handlers — node's
  // DEFAULT SIGTERM kills without running 'exit' hooks, so an unhandled
  // signal was exactly the silent path.
  process.on("exit", (code) => {
    if (resultEmitted) return;
    try {
      const line = json
        ? JSON.stringify({ type: "result", pass: false, status: "died", exitCode: code, durationMs: Date.now() - startTime })
        : `RESULT fail died exit=${code}`;
      fs.writeSync(1, `${line}\n`);
      fs.writeSync(2, `exec exited (code ${code}) without a result — emitted these last words so silence is impossible\n`);
    } catch { /* nothing blocks the exit */ }
  });
  process.on("uncaughtException", (err) => finish(1, "uncaught-exception", { error: String(err?.stack || err).slice(0, 600) }));
  process.on("unhandledRejection", (err) => finish(1, "unhandled-rejection", { error: String(err?.stack || err).slice(0, 600) }));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => finish(sig === "SIGINT" ? 130 : 143, `interrupted-${sig.toLowerCase()}`));
  }
  const usageError = (error) => finish(2, "usage-error", { error });

  const supportedOptions = new Set([
    "help", "json", "workspace", "verify", "max-turns", "endpoint",
    "profile", "temperature", "act-temperature", "top-p", "top-k", "think",
    "ground", "no-ground", "shell-network", "api-url", "api-key", "api-dialect",
    "model", "deepseek", "codex", "codex-effort", "write-batch", "context-mode",
  ]);
  const unknown = Object.keys(args).find((key) => key !== "_" && !supportedOptions.has(key));
  if (unknown) usageError(`unknown option --${unknown}`);

  const task = args._[1];
  if (!task || args._.length !== 2) usageError("exec requires exactly one quoted task text");

  const valueOptions = [
    "workspace", "verify", "max-turns", "endpoint", "profile", "temperature",
    "act-temperature", "top-p", "top-k", "think", "api-url", "api-key",
    "api-dialect", "model", "codex-effort", "context-mode",
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
  // Evidence by DEFAULT. Two headless runs in one experiment had to be
  // process-forensic'd because exec recorded nothing (no artifact, no usage,
  // observations lost). Every exec now tees its events and result to
  // <workspace>/.bantam/exec-runs/<stamp>.jsonl; prompt/output byte capture
  // stays opt-in via BANTAM_SAVE_PROMPTS (size, and the task's own source).
  let evidencePath = null;
  try {
    const evDir = path.join(workspace, ".bantam", "exec-runs");
    fs.mkdirSync(evDir, { recursive: true });
    evidencePath = path.join(evDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.appendFileSync(evidencePath, `${JSON.stringify({ type: "meta", task: String(task).slice(0, 2000), workspace, argv: process.argv.slice(2, 12), startedAt: new Date(startTime).toISOString() })}\n`);
    evidenceAppend = (obj) => { try { fs.appendFileSync(evidencePath, `${JSON.stringify(obj)}\n`); } catch { /* evidence never breaks a run */ } };
  } catch { evidenceAppend = null; /* an unwritable workspace still gets a run */ }

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

  let client;
  try {
    let options = cliModelOptions();
    if (!options.codex && !options.apiUrl) {
      let ep = endpoint;
      if (!ep) {
        try {
          ep = await detectEndpoint();
        } catch {
          finish(3, "endpoint-unreachable");
        }
      }
      options = { ...options, endpoint: ep, apiUrl: null };
    }
    client = new ModelClient(options);
    if (!(await client.health())) finish(3, "endpoint-unreachable");
  } catch {
    finish(3, "endpoint-unreachable");
  }

  // Run the agent — headless: no banner, no rooster, no TUI
  let currentTurn = 0;
  const onEvent = (e) => {
    if (e.type === "turn_start" && Number.isInteger(e.turn)) currentTurn = e.turn;
    const turn = Number.isInteger(e.turn) ? e.turn : currentTurn;
    {
      const ev = { type: "event", event: e.type, turn };
      if (e.action?.a) ev.action = e.action.a;
      if (Array.isArray(e.files)) ev.files = e.files;
      if (e.observation) ev.obs = String(e.observation).slice(0, 200);
      // Exact prompt/output capture is intentionally opt-in because it makes
      // JSONL evidence large and may contain the task's source material. The
      // agent already records these fields under BANTAM_SAVE_PROMPTS; preserve
      // them at the headless CLI boundary so controlled experiments can audit
      // input identity and model output rather than relying on summaries.
      if (envTruthy("BANTAM_SAVE_PROMPTS")) {
        if (typeof e.prompt === "string") ev.prompt = e.prompt;
        if (typeof e.rawOutput === "string") ev.rawOutput = e.rawOutput;
        if (typeof e.reasoning === "string") ev.reasoning = e.reasoning;
        if (e.protocolViolation !== undefined) ev.protocolViolation = e.protocolViolation;
        if (Number.isInteger(e.modelCallIndex)) ev.modelCallIndex = e.modelCallIndex;
      }
      evidenceAppend?.(ev);
      if (json) console.log(JSON.stringify(ev));
    }
    if (!json && typeof e.action?.a === "string") {
      // Same guard the JSON branch has had all along: several event types carry
      // an `action` field that is not a protocol action (or not yet parsed), and
      // describeAction's default arm rendered those as literal "turn 1:
      // undefined" in exec's output — observed on the first live exec probe.
      console.log(`  turn ${turn}: ${describeAction(e.action)}`);
    }
  };

  try {
    const usageBefore = modelUsageSnapshot(client);
    const execIntent = classifyTaskIntent(task);
    const res = await runAgent({
      task,
      workspace,
      model: client,
      maxTurns,
      shellNetwork: args["dangerously-allow-net"] ? true : undefined,
      verificationScript: verify || null,
      thinkMode: execThinkMode,
      grounding: !args["no-ground"],
      ...(args["write-batch"] === true ? { writeBatch: true } : {}),
      interactive: false,
      // Headless does not mean implementation. Without this distinction a
      // read-only audit has its answer rejected for failing to edit a file.
      advisoryMode: execIntent === "advisory",
      verificationPolicy: execIntent === "advisory" ? "after_edit" : "always",
      onEvent,
    });
    const usageAfter = modelUsageSnapshot(client);
    const usage = modelUsageDelta(usageBefore, usageAfter);
    if (json && envTruthy("BANTAM_SAVE_PROMPTS")) {
      console.log(JSON.stringify({
        type: "model_usage",
        calls: Array.isArray(client.usageHistory) ? client.usageHistory : [],
      }));
    }
    observeCompletedSelfHostRun({
      launcherWorkspace: repoRoot(),
      taskWorkspace: workspace,
      task,
      result: res,
      warn: (warning) => {
        process.stderr.write(`warning: ${warning}\n`);
      },
    });

    const pass = res.reachedDone && (!verify || res.verification?.status === "pass");
    const status = res.reachedDone
      ? (verify ? (res.verification?.status ?? "unknown") : "done")
      : (res.metrics.turns >= maxTurns ? "turn-limit" : "incomplete");

    finish(pass ? 0 : 1, status, { pass, turns: res.metrics.turns, usage });
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
  // What share of the prompt the server reused instead of reprocessing. The
  // throughput andon fires only on the catastrophic case; this makes the
  // chronic case visible on every run.
  const reuse = formatPrefixReuse(model?.usageTotals, { remote: Boolean(model?.chatDialect || model?.provider === "codex") });
  if (reuse) console.log(reuse);
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
    case "write_batch": { const n = (a.files || []).length; return `write batch (${n} file${n === 1 ? "" : "s"})`; }
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
function wrapForTerminal(s, pad = 6, maxWidth = Infinity) {
  const width = Math.max(50, Math.min(maxWidth, (process.stdout.columns || 100) - pad));
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
  console.log(renderReplHelp({
    cols: process.stdout.columns ?? 80,
    heading: (s) => paint(`1;${C.plume}`, s),
    command: (s) => paint(C.beak, s),
    description: (s) => paint(C.dim, s),
  }));
}

// A local llama.cpp slot reached through --api-url still has a KV cache to protect.
function isLoopbackUrl(url) {
  try { return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(String(url)).hostname); } catch { return false; }
}

// Per-request prefix reuse from two snapshots of the session's usage totals.
// Quiet on small requests, where there is nothing to reuse.
function formatRequestPrefixReuse(before, after) {
  const input = Math.max(0, Number(after?.inputTokens ?? 0) - Number(before?.inputTokens ?? 0));
  if (!Number.isFinite(input) || input < 8000) return null;
  const hit = Math.min(input, Math.max(0, Number(after?.cacheHitTokens ?? 0) - Number(before?.cacheHitTokens ?? 0)));
  return `prefix reuse ${Math.round((100 * hit) / input)}%`;
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
    if (e.type === "throughput_andon") {
      // The andon used to feed telemetry only; the operator whose run had
      // crawled through 71 s of prefill (2026-08-24 tour run) never saw it.
      // A station that starves the line must be visible from the line.
      const pct = Math.round((e.reuseRatio ?? 0) * 100);
      out(`  ${paint("33", `⚠ prefix cache miss: ${pct}% of ~${e.promptTokens} prompt tokens reused for ${e.streak} turns — `
        + `every turn is re-prefilling the whole context. Try \`:context extension\` (see :modes).`)}`);
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
      // Station notes (steers/gates/pins) are for the MODEL and the films —
      // shown raw they read as malfunction. BANTAM_SHOW_STATIONS=1 restores
      // the full shop-floor view. run.json always keeps every byte.
      const obs = scrubStationNotes(String(e.observation || "")).trim();
      if (!obs) return;
      if (obs.startsWith("[")) {
        // A surviving user-facing note ([timeout]/[interrupted]) — or the full
        // view when BANTAM_SHOW_STATIONS=1. Wrapped, never truncated.
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
    } else if (e.type === "grounding_progress") {
    // Live single-line bar: on a big repository the index build blocked the
    // first request invisibly and chat felt unresponsive (2026-08-18).
    const width = 24;
    const filled = Math.max(0, Math.min(width, Math.round((e.done / Math.max(1, e.total)) * width)));
    process.stderr.write(`\r  \u{1F9ED} indexing code KB  [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${e.done.toLocaleString()}/${e.total.toLocaleString()} files`);
    if (e.done >= e.total) process.stderr.write("\r\u001b[2K");
  } else if (e.type === "grounding_state") {
    process.stderr.write(e.enabled
      ? `  🧭 code KB: ${e.files.toLocaleString()} files${e.buildMs >= 50 ? ` indexed in ${(e.buildMs / 1000).toFixed(1)}s` : " ready"} — \`query\` answers defines/symbols/deps/flow\n`
      : e.tooLarge
        ? noteKbTooLarge(e)
        : "  🧭 code KB: off — the `query` action has no tools behind it (--ground enables it)\n");
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
    } else if (e.type === "walled_garden") {
      // Honest, calm, once: the environment (not the agent) lacks network.
      out(`  ${dim(`sandbox has no network access — adapting to the tools already installed`)}`);
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
    const target = model.apiMode ? model.apiUrl : model.endpoint;
    const remedy = model.apiMode
      ? "Check the API URL, key, and model name (or pass --endpoint URL for a local server)."
      : "Start your llama.cpp server (or pass --endpoint URL) and try again.";
    console.error(`Can't reach the model at ${target}.\n${remedy}`);
    process.exit(1);
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const IDLE_PROMPT = `${paint(`1;${C.comb}`, "bantam")} ${paint(C.plume, "❯")} `;
  rl.setPrompt(IDLE_PROMPT);

  // No verifier set? A change graded by the project's own tests is what makes a
  // small model trustworthy — so detect the test command and just USE it.
  //
  // This used to ask "[Y/n]" on every fresh workspace. The question defaulted
  // to yes, and yes is the answer that makes BANTAM work as advertised, so it
  // was friction charging the operator a keystroke for the only sensible
  // choice. Adopt it, say so in one line, and name both escapes. The correct
  // move should be the lit button, not a quiz.
  // Printed AFTER the first-screen card (which already shows the verifier),
  // so the adoption note and its two escapes sit under the logo, not above it.
  let autoVerifyNote = null;
  if (!verificationScript && tty && !args["no-autoverify"] && !envTruthy("BANTAM_NO_AUTOVERIFY")) {
    const detected = detectVerifier(workspace);
    if (detected) {
      verificationScript = detected.command;
      autoVerifyNote = "  " + paint(C.good, `✔ verifier: ${detected.command}`)
        + paint(C.dim, `  (${detected.source} — every change is graded with it; --verify "..." to change, --no-autoverify to skip)`);
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
  let attendantRun = null;   // event accumulator for the live second voice
  let attendantBusy = false; // single-flight: one instant reply at a time
  let attendantSlots = null; // cached server slot count (probed once per session)
  let attendantPersona;      // optional ~/.bantam/attendant-voice.md, read once

  // The live second voice (A/B-tested 2026-08-19): answer a mid-run message
  // instantly from the sibling slot — digest for shape, raw tail for truth —
  // while the message steers the worker at its boundary exactly as before.
  // Local multi-slot servers only; single-flight; failure is silence, never
  // a broken run.
  async function maybeAttendantReply(question) {
    if (attendantBusy || !attendantRun || model.codex || model.apiMode || model.deepseek) return;
    try {
      if (attendantSlots == null) {
        try {
          const r = await fetch(`${model.endpoint}/slots`, { signal: AbortSignal.timeout(1500) });
          attendantSlots = r.ok ? (await r.json()).length : 1;
        } catch { attendantSlots = 1; }
      }
      if (attendantSlots < 2) return;
      attendantBusy = true;
      if (attendantPersona === undefined) {
        try { attendantPersona = fs.readFileSync(path.join(os.homedir(), ".bantam", "attendant-voice.md"), "utf8").trim() || null; }
        catch { attendantPersona = null; }
      }
      const prompt = buildAttendantPrompt({ task: lastUserQuestion, turns: attendantRun.turns, question, persona: attendantPersona });
      const res = await model.complete(prompt, { nPredict: 160, temperature: 0.2, stop: ["<|im_end|>"] });
      const text = String(res?.content ?? "").trim();
      if (text) {
        for (const line of text.split("\n")) if (line.trim()) emit(`  ⚡ ${line.trim()}`);
        // Close the loop: the worker hears what its own voice said, clearly
        // framed as its voice — one agent, two hands, no confusion.
        injections.push({ kind: "attendant", text: `In reply to "${question.slice(0, 120)}" I told the operator: ${text}` });
      }
    } catch { /* the attendant never breaks a run */ } finally {
      attendantBusy = false;
    }
  }
  // Session-persistent code KB. The request loop passed `grounding: true` per
  // request, so the ENTIRE index was rebuilt while the operator sat waiting
  // (taste report, 2026-08-18). Build once with the progress bar; reconcile
  // by stat-diff before every later request.
  let chatGround = null;
  let lastAnswerText = "";  // last respond text, for the post-answer research offer
  let lastUserQuestion = ""; // last real request, so bare `:probe` has a target
  // Deep research: the gap-list A/B (2026-08-18) ruled — elicited self-assessed
  // gaps caught 2/2 real errors (git 2.29, the dotted rope key) where the
  // mechanical probe caught 0/2. Off by default: it spends one governed codex
  // errand per gapped question.
  let deepResearch = process.env.BANTAM_DEEPRESEARCH === "1";
  // Live text streaming (operator order, 2026-08-19): OPTIONAL, default off.
  // Delivery-only — the grammar constrains sampling server-side either way,
  // proven byte-identical by the stream-identity tests.
  let streamMode = process.env.BANTAM_STREAM === "1" || (process.env.BANTAM_STREAM !== "0" && loadUserSettings().stream === true);
  let previousAnswerText = "";  // the answer BEFORE this one — the memory the model cannot back-write
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
        // "how's it coming?" — the operator's status poke, in 100+ of their
        // real sessions (benches/collab). The harness knows the answer and it
        // costs nothing; queueing it as a steer would burn a model turn to
        // answer late.
        if (isStatusQuestion(s)) {
          const secs = Math.round((Date.now() - (lastRunStartedAt || Date.now())) / 1000);
          const doing = activity.label ? `${activityLabel(activity)}` : "working";
          emit(paint("36", `  ⏱ ${secs}s in — ${doing}${activity.detail ? `: ${String(activity.detail).slice(0, 80)}` : ""}`));
          return;
        }
        const governed = parseSelfImproveRequest(s);
        if (governed?.help) {
          emit(selfImproveUsage());
          return;
        }
        if (governed?.error) {
          emit(`${paint("31", "✗")} ${governed.error}  (use :self-improve help)`);
          return;
        }
        if (governed) {
          // Self-improvement owns channels and deployment state, so it must
          // never become an ambient steering message inside an ordinary run.
          // Preserve earlier steering as later top-level work, put this request
          // first, and stop the current run at its existing abort boundary.
          if (injections.length) {
            pending.push(...injections);
            injections = [];
          }
          pending.unshift(s);
          aborted = true;
          activeRunController?.abort();
          emit(paint("33", `  ⏸ stopping the current task; queued governed request next: ${s}`));
          return;
        }
        injections.push(s);
        const state = activity.label === "running"
          ? "queued for the next step (current command keeps running; Ctrl-C stops it)"
          : "queued for the next step";
        emit(paint("2", `  ↪ ${state}: ${s}`));
        maybeAttendantReply(s);
      }
      return;
    }
    if (resolveRequest) {
      // Enter on an empty line is the minimal yes — but only when the last run
      // proposed a next step; a stray Enter with nothing pending stays inert.
      if (!s && !lastProposedNext) { redrawInput(rl); return; }
      const r = resolveRequest; resolveRequest = null; r(s);
    }
    else if (s || lastProposedNext) pending.push(s);   // buffered pipe input; empty lines count only with a pending next
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

  console.log(renderBanner({
    profileName: model.codex ? `codex/${model.modelName}` : (model.apiMode ? model.modelName : model.profileName),
    workspace,
    verify: verificationScript,
    tty,
    servedModel: activeModelId,
    servedAt: activeModelLocation,
  }));
  if (autoVerifyNote) console.log(autoVerifyNote);
  // Under the card: only the modes that are OFF their default, in `:modes`
  // vocabulary, fitted to the terminal. The full seven-entry line wrapped into
  // three grey rows at 80 columns; `:modes` still has the whole table. Context
  // is omitted because it is already a row in the card.
  if (interactiveCard) {
    const summary = renderModeSummary(startupModeEntries(), { cols: process.stdout.columns, omit: ["context"] });
    if (summary) console.log(paint("2", `  ${summary}`));
  }

  // Standing operator preferences (~/.bantam/profile.md; BANTAM_PROFILE=0 off).
  const operatorProfile = loadOperatorProfile();
  if (operatorProfile) {
    const home = os.homedir();
    const shown = home && operatorProfile.file.startsWith(home) ? "~" + operatorProfile.file.slice(home.length) : operatorProfile.file;
    console.log(paint("2", `  profile: ${shown}`));
  }

  // First-run offer: use a signed-in Codex for images? Asked ONCE, only of a
  // person, default No, and only if `:image` was never set by hand. The Codex
  // probe spawns `codex login status` (~50 ms) and runs only after the cheap
  // checks pass, so a session that has already answered pays nothing.
  if (interactiveCard && shouldOfferImageOnboarding({
    settings: loadUserSettings(), imageSource: imageModeState.source, env: process.env, tty,
    codex: () => detectCodex(codexProbes()),
  })) {
    const codex = detectCodex(codexProbes());
    process.stdout.write("\n");
    const answer = await new Promise((res) => rl.question(imageOnboardingPrompt(codex), res));
    const d = imageOnboardingDecision(answer, codex);
    applyImageMode(d.imageMode);
    saveUserSetting("imageMode", d.imageMode);
    if (d.imageProvider) { applyImageProvider(d.imageProvider); saveUserSetting("imageProvider", d.imageProvider); }
    saveUserSetting(ONBOARDING_KEY, d.record);
    if (d.imageMode) {
      console.log(paint("33", `  image: ON — ${describeImageMode(true)} (remembered)`));
      console.log(paint("2", `  eyes: codex — ${describeImageProvider("codex")} (remembered)`));
    } else {
      console.log(paint("2", "  image: off (remembered) — `:image on` any time."));
    }
    console.log("");
  }
  const sessionLog = [];
  let lastProposedNext = null;   // the agent's own Next proposal, made pressable
  let lastRunStartedAt = null;   // for instant status answers
  let trioSession = null;
  let teamSession = null;
  const startTrioSession = async (effort = "high") => {
    if (teamSession) throw new Error("team mode is already active");
    if (trioSession) throw new Error("trio mode is already active");
    const clients = [];
    const next = new TrioSession({
      workspace,
      arms: ["local", "sol", "terra"],
      effort,
      verificationScript,
      maxTurns: args["max-turns"] ? Number(args["max-turns"]) : 30,
      thinkMode,
      preGate: !args["no-pregate"],
      modelFactory: async (arm) => {
        const client = new ModelClient(modelOptionsForGauntletArm(arm.model, {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          profile: typeof args.profile === "string" ? args.profile : undefined,
        }));
        client.onUsage = ({ entry }) => {
          if (usageDisplayEnabled) emit(`[${arm.name}] usage ${formatUsage(entry)}`);
        };
        clients.push(client);
        return client;
      },
      onEvent: trioEventLogger(emit),
    });
    try {
      await next.start();
      trioSession = next;
      return next;
    } catch (error) {
      next.close();
      for (const client of clients) client.close();
      throw error;
    }
  };
  const startTeamSession = async () => {
    if (trioSession) throw new Error("trio mode is already active");
    if (teamSession) throw new Error("team mode is already active");
    let catalog = [];
    try { catalog = await model.listCodexModels(); } catch { /* fallback catalog below */ }
    const registry = gauntletModelRegistry(catalog);
    const missing = ["terra", "luna", "sol"].filter((name) => !registry[name]);
    if (missing.length) {
      throw new Error(`required Codex team model(s) unavailable: ${missing.join(", ")}`);
    }

    const localProbe = new ModelClient(modelOptionsForGauntletArm(registry.local.model, {
      endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
      profile: typeof args.profile === "string" ? args.profile : undefined,
    }));
    let includeLocal = false;
    try {
      includeLocal = await localProbe.health();
    } finally {
      localProbe.close();
    }

    const clients = [];
    const next = new TeamSession({
      workspace,
      includeLocal,
      verificationScript,
      maxTurns: args["max-turns"] ? Number(args["max-turns"]) : 30,
      thinkMode,
      preGate: !args["no-pregate"],
      modelFactory: async (arm) => {
        const entry = registry[arm.name];
        if (!entry) throw new Error(`team model unavailable: ${arm.name}`);
        const modelSpec = {
          ...entry.model,
          effort: arm.model.effort ?? entry.model.effort,
        };
        const client = new ModelClient(modelOptionsForGauntletArm(modelSpec, {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          profile: typeof args.profile === "string" ? args.profile : undefined,
        }));
        client.onUsage = ({ entry: usage }) => {
          if (usageDisplayEnabled) emit(`[${arm.name}] usage ${formatUsage(usage)}`);
        };
        clients.push(client);
        return client;
      },
      onEvent: trioEventLogger(emit),
    });
    try {
      await next.start();
      teamSession = next;
      return next;
    } catch (error) {
      next.close();
      for (const client of clients) client.close();
      throw error;
    }
  };
  const nextRequest = () => {
    if (pending.length) return Promise.resolve(pending.shift());
    if (closed) return Promise.resolve(null);
    // A draft may already be buffered from typing during the previous run. Bare
    // rl.prompt() resets readline's logical cursor to column 0, so the next key
    // would be inserted at the beginning of that draft.
    return new Promise((res) => { resolveRequest = res; redrawInput(rl); });
  };

  const wizardPrompt = async (label) => {
    const previous = rl.getPrompt();
    rl.setPrompt(`${paint("1", label)} ${paint(C.plume, "❯")} `);
    try {
      return await nextRequest();
    } finally {
      rl.setPrompt(previous);
    }
  };

  function apiPresetIsCurrent(preset) {
    if (!model.apiMode || String(preset.url).replace(/\/$/, "") !== model.apiUrl) return false;
    if (!preset.deepseek) return preset.model === model.modelName;
    const resolvedModel = preset.model === "deepseek-reasoner" || preset.model === "deepseek-chat"
      ? "deepseek-v4-flash"
      : preset.model;
    // Routine BANTAM action turns intentionally use DeepSeek V4 non-thinking
    // mode. Only the retired `deepseek-reasoner` alias remains an explicit
    // thinking selection.
    const thinking = preset.model === "deepseek-reasoner";
    return model.deepseek && model.modelName === resolvedModel
      && model.deepseekThinking === thinking;
  }

  async function switchToApiPreset(name, preset) {
    let key = preset.key || process.env.BANTAM_API_KEY || process.env.DEEPSEEK_API_KEY || null;
    if (!key) {
      key = await promptHidden(`API key for ${name} (hidden, used for this session): `);
      if (!key) {
        console.log(`  ${name} was not enabled because no API key was provided.`);
        return false;
      }
    }
    const previous = {
      codex: model.codex,
      codexEffort: model.codexEffort,
      apiMode: model.apiMode,
      endpoint: model.endpoint,
      apiUrl: model.apiUrl,
      model: model.modelName,
      key: model.apiKey,
      deepseek: model.deepseek,
      deepseekThinking: model.deepseekThinking,
      dialect: model.grammarField === "guided_grammar" ? "vllm" : "llamacpp",
    };
    model.switchToApi({
      url: preset.url,
      model: preset.model,
      key,
      deepseek: preset.deepseek,
      dialect: preset.dialect,
    });
    if (await model.health()) {
      console.log(paint("2", `  Now using ${name} @ ${preset.url} (${model.modelName})`));
      return true;
    }
    if (previous.codex) {
      model.switchToCodex({ model: previous.model, effort: previous.codexEffort });
    } else if (previous.apiMode) {
      model.switchToApi({
        url: previous.apiUrl,
        model: previous.model,
        key: previous.key,
        deepseek: previous.deepseek,
        dialect: previous.dialect,
      });
      model.deepseekThinking = previous.deepseekThinking;
    } else {
      model.switchTo(previous.endpoint);
    }
    console.log(`  API preset ${name} is unreachable; still using the previous model.`);
    return false;
  }

  // `:model` — one list and switch command for local models and API presets.
  async function handleModelCommand(arg, { apiOnly = false } = {}) {
    const guided = !String(arg ?? "").trim() && !apiOnly && tty;
    const models = apiOnly ? [] : await modelStatus();
    const presets = cliModelOptions.__presets || {};
    const presetNames = Object.keys(presets);
    let codexModels = [];
    if (!apiOnly) {
      let catalog = [];
      try { catalog = await model.listCodexModels(); } catch { /* fallback catalog below */ }
      codexModels = codexModelOptions(catalog);
    }
    if (!arg) {
      console.log(apiOnly ? "  API models:" : "  Models:");
      if (!apiOnly) {
        models.forEach((m, i) => console.log(
          `    [${i + 1}] local${i === 0 ? "" : `-${i + 1}`}  ${m.label}${m.vision ? " [vision]" : ""}${m.running ? "  (running)" : m.sleeping ? "  (asleep — model unloaded)" : ""}${!model.apiMode && !model.codex && m.endpoint === model.endpoint ? "  ← current" : ""}`));
      }
      presetNames.forEach((name, presetIndex) => {
        const preset = presets[name];
        const number = models.length + presetIndex + 1;
        console.log(`    [${number}] ${name.padEnd(15)} API  ${preset.model} @ ${preset.url}${apiPresetIsCurrent(preset) ? "  ← current" : ""}`);
      });
      codexModels.forEach((entry, codexIndex) => {
        const number = models.length + presetNames.length + codexIndex + 1;
        const current = model.codex && model.modelName === entry.model;
        const shownEffort = current ? model.codexEffort : entry.effort;
        const migration = entry.upgrade ? `  ⚠ use ${entry.upgrade}` : "";
        console.log(`    [${number}] ${entry.name.padEnd(17)} CODEX  ${entry.displayName} · ${shownEffort} reasoning · ${entry.role}${migration}${current ? "  ← current" : ""}`);
        if (entry.recommendation) console.log(`        ${entry.recommendation}`);
      });
      if (!models.length && !presetNames.length && !codexModels.length) {
        console.log("    (none configured — use .bantam/models.json and .bantam/api.json)");
      }
      console.log(apiOnly
        ? "  Switch with :api-model <name>."
        : "  Switch directly with :model <name|number> [reasoning].");
      if (!guided) return;
      console.log(paint("2", "\n  Choose a model by number or name; Enter cancels."));
      const selection = await wizardPrompt("model");
      if (selection === null || !String(selection).trim()) {
        console.log(paint("2", "  Model switch cancelled."));
        return;
      }
      arg = String(selection).trim();
    }

    const [modelArg, requestedEffort, ...extraArgs] = String(arg).trim().split(/\s+/);
    if (extraArgs.length) {
      console.log("  Usage: :model <name|number> [reasoning]");
      return;
    }
    if (presets[modelArg]) {
      if (requestedEffort) {
        console.log("  Reasoning levels apply only to Codex models.");
        return;
      }
      await switchToApiPreset(modelArg, presets[modelArg]);
      return;
    }
    const namedCodex = codexModels.find((entry) => entry.name === modelArg);
    if (namedCodex) {
      const effort = await chooseCodexEffort(namedCodex, {
        guided,
        requested: requestedEffort,
      });
      if (effort) await switchToCodexModel(namedCodex, effort);
      return;
    }
    let target = null;
    if (modelArg.toLowerCase() === "local") target = models[0];
    else if (/^\d+$/.test(modelArg)) {
      const index = Number(modelArg) - 1;
      if (index < models.length) target = models[index];
      else {
        const presetName = presetNames[index - models.length];
        if (presetName) {
          if (requestedEffort) {
            console.log("  Reasoning levels apply only to Codex models.");
            return;
          }
          await switchToApiPreset(presetName, presets[presetName]);
          return;
        }
        const codexEntry = codexModels[index - models.length - presetNames.length];
        if (codexEntry) {
          const effort = await chooseCodexEffort(codexEntry, {
            guided,
            requested: requestedEffort,
          });
          if (effort) await switchToCodexModel(codexEntry, effort);
          return;
        }
      }
    }
    else {
      target = models.find((candidate) =>
        String(candidate.name ?? "").toLowerCase() === modelArg.toLowerCase()
        || String(candidate.label ?? "").toLowerCase() === modelArg.toLowerCase());
    }
    if (!target) {
      console.log(apiOnly
        ? `  Unknown API model: ${modelArg}. Use :api-model to list.`
        : `  Unknown model: ${modelArg}. Use :model to list.`);
      return;
    }
    if (requestedEffort) {
      console.log("  Reasoning levels apply only to Codex models.");
      return;
    }
    const ok = await switchToModel(model, target, { out: (s) => process.stdout.write(s) });
    if (!ok) console.log("  Switch failed (couldn't start the server).");
    else saveModelPreference({ kind: "local", name: target.name });
  }

  async function chooseCodexEffort(entry, { guided = false, requested } = {}) {
    if (requested) {
      const resolved = resolveCodexReasoningEffort(entry, requested);
      if (!resolved.ok) {
        console.log(`  ${resolved.error}`);
        console.log(`  Supported: ${entry.supportedReasoningEfforts.join(", ")}`);
        return null;
      }
      return resolved.effort;
    }
    if (!guided || entry.supportedReasoningEfforts.length < 2) return entry.effort;

    console.log(`\n  Reasoning level for ${entry.displayName}:`);
    entry.supportedReasoningEfforts.forEach((effort, index) => {
      const recommended = effort === entry.effort ? "  ← default" : "";
      console.log(`    [${index + 1}] ${effort}${recommended}`);
    });
    console.log(paint("2", `  Enter uses ${entry.effort}; type q to cancel.`));
    const selection = await wizardPrompt("reasoning");
    if (selection === null || /^(?:q|quit|cancel)$/i.test(String(selection).trim())) {
      console.log(paint("2", "  Model switch cancelled."));
      return null;
    }
    const resolved = resolveCodexReasoningEffort(entry, selection);
    if (!resolved.ok) {
      console.log(`  ${resolved.error}`);
      console.log(`  Supported: ${entry.supportedReasoningEfforts.join(", ")}`);
      return null;
    }
    return resolved.effort;
  }

  async function switchToCodexModel(entry, effort = entry.effort) {
    const previous = {
      codex: model.codex,
      codexEffort: model.codexEffort,
      apiMode: model.apiMode,
      endpoint: model.endpoint,
      apiUrl: model.apiUrl,
      model: model.modelName,
      key: model.apiKey,
      deepseek: model.deepseek,
      dialect: model.grammarField === "guided_grammar" ? "vllm" : "llamacpp",
    };
    model.switchToCodex({ model: entry.model, effort });
    if (await model.health()) {
      console.log(paint(
        "2",
        `  Now using ${entry.name} (${entry.model}, ${effort} reasoning, ${model.codexThreadMode}/${model.codexPromptMode}) via your Codex subscription`,
      ));
      saveModelPreference({
        kind: "codex",
        name: entry.name,
        model: entry.model,
        effort,
      });
      return true;
    }
    if (previous.codex) {
      model.switchToCodex({ model: previous.model, effort: previous.codexEffort });
    } else if (previous.apiMode) {
      model.switchToApi({
        url: previous.apiUrl,
        model: previous.model,
        key: previous.key,
        deepseek: previous.deepseek,
        dialect: previous.dialect,
      });
    } else {
      model.switchTo(previous.endpoint);
    }
    console.log("  Codex app-server is unavailable or not authenticated; still using the previous model.");
    return false;
  }

  for (;;) {
    const raw = await nextRequest();
    if (raw === null) break;                    // EOF / Ctrl-C at the prompt
    const request = String(raw).trim();
    if (!request) continue;
    if (["exit", "quit", ":q"].includes(request.toLowerCase())) break;

    // `:help` / `/help` / `?` — the in-session command list.
    if (/^(?::help|\/help|:h|help|\?)$/i.test(request)) { printReplHelp(); continue; }

    if (/^:research\b/i.test(request)) {
      const q = request.replace(/^:research\b\s*/i, "").trim();
      if (!q) { console.log("  Usage: :research <question> — a bounded web agent fetches quoted sources into reference/ for the next answer."); nextRequest(); return; }
      const shelfPath = path.join(workspace, "reference", "research-notes.md");
      console.log("  🔎 dispatching the librarian (bounded codex agent, empty jail; only the question leaves this machine)…");
      try {
        const out = execFileSync("node", [path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "tools", "librarian.cjs"), "--question", q, "--shelf", shelfPath, "--timeout-sec", "420"], { encoding: "utf8" });
        console.log(`  ${out.trim()}`);
        // Citation check by default: a fabricated quote's URL never contains
        // it (2026-08-19 falsifier). Failed citations mark their claims
        // UNSOURCED in the shelf regardless of [S] ink.
        try {
          const v = execFileSync("node", [path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "tools", "quote-verify.cjs"), "--shelf", shelfPath, "--timeout-sec", "300"], { encoding: "utf8" });
          console.log(`  ${v.trim()}`);
        } catch (e) {
          console.log(`  ⚠ citation check: ${String(e.stdout || e.message).trim().split("\n")[0]}`);
        }
        console.log("  Shelved and citation-checked. Ask your question again and I will consult reference/research-notes.md with provenance inks.");
      } catch (e) {
        // Exit 3 is a governed refusal — relay the governor's own words, not
        // a generic empty-haul shrug.
        const refusal = e.status === 3 ? String(e.stdout ?? "").trim() : "";
        if (refusal) console.log(`  ⛔ ${refusal}`);
        else console.log(`  librarian returned nothing usable (${String(e.message).slice(0, 80)}); the shelf notes the empty haul.`);
      }
      nextRequest(); return;
    }
    if (/^:stream\b/i.test(request)) {
      const arg = request.replace(/^:stream\b\s*/i, "").trim().toLowerCase();
      if (arg === "on") { streamMode = true; saveUserSetting("stream", true); }
      else if (arg === "off") { streamMode = false; saveUserSetting("stream", false); }
      else if (arg) { console.log("  Usage: :stream [on|off]"); continue; }
      console.log(`  ⚡ streaming: ${streamMode ? "ON — reasoning and answers render live as they generate" : "off"}${arg ? " (saved — future sessions remember)" : ""}`);
      continue;
    }
    if (/^:deepresearch\b/i.test(request)) {
      const arg = request.replace(/^:deepresearch\b\s*/i, "").trim().toLowerCase();
      if (arg === "on") deepResearch = true;
      else if (arg === "off") deepResearch = false;
      else if (arg) { console.log("  Usage: :deepresearch [on|off]"); continue; }
      console.log(`  🔬 deep research: ${deepResearch ? "ON — before each answer I list my own factual gaps; if any, one governed librarian errand shelves sources first" : "off"}`);
      continue;
    }
    if (/^:fight\b/i.test(request)) {
      // The chicken fight (operator design, 2026-08-19): current task +
      // conversation context, same bytes to every corner — BANTAM and Hermes
      // serialized on the shared 27B (full window each), frontier corners in
      // parallel. Live lanes at a local page; scorecard lands back here.
      let rest = request.replace(/^:fight\b\s*/i, "").trim();
      let armsArg = null;
      const m = rest.match(/^--arms\s+(\S+)\s*/);
      if (m) { armsArg = m[1].split(","); rest = rest.slice(m[0].length).trim(); }
      const q = rest || lastUserQuestion;
      if (!q) { console.log("  Usage: :fight [task] — every corner gets the current task + context; live side-by-side at a local page."); continue; }
      const { startFight, composeFightBrief } = await import("../src/fight.js");
      const { haltState } = await import("../src/logic/governor.js");
      const halted = haltState(process.cwd()).halted;
      const arms = armsArg ?? ["bantam", "hermes", "opencode"];
      if (halted && arms.some(a=>!['bantam','hermes','opencode','bantam-local-27b'].includes(a))) {
        console.log('  Governor halt: explicit cloud participants cannot run until the halt is cleared.'); continue;
      }
      if (halted) console.log("  ⛔ governor halt is on — cloud corners sit out; local-only fight.");
      const brief = composeFightBrief({ sessionLog, request: q });
      console.log(`  🐓 FIGHT CARD: ${arms.join(" vs ")}`);
      let fight;
      try {
        fight = startFight({ task: brief, arms, port: 8377, onEvent: (e) => { if (e.kind === "done") console.log(`  🏁 ${e.arm}: ${e.text}`); } });
      } catch (e) { console.log(`  could not start the fight: ${String(e.message).slice(0, 120)}`); continue; }
      console.log(`  watch live: http://127.0.0.1:8377   (workspaces: ${fight.fightDir})`);
      const post = await fight.done;
      console.log("  ── judges' scorecard ──");
      for (const c of post.corners) console.log(`  ${c.arm.padEnd(14)} ${(c.wallMs / 1000).toFixed(1)}s · exit ${c.exitCode} · ${c.lines} lines · ${c.artifacts.length} artifact(s)`);
      console.log(`  full record: ${fight.fightDir}/fight.json — the page stays up until you exit.`);
      if (post.card) console.log(`  📦 finished object: ${post.card}  (single file — share, save, open anywhere; workspaces embedded)`);
      continue;
    }
    if (/^:probe\b/i.test(request)) {
      // Knowledge-stability probe (2026-08-18 logit study): single-pass
      // confidence read 0.994 on a known-wrong answer, so confidence cannot
      // be trusted — but k redecodes at sampling temperature agree on known
      // facts and scatter on guesses. Local, seconds, zero quota: the middle
      // rung between the free claim-class offer and a paid :research errand.
      const q = request.replace(/^:probe\b\s*/i, "").trim() || lastUserQuestion;
      if (!q) { console.log("  Usage: :probe [question] — redecodes the question locally k times and reports whether its fact atoms hold still (knowledge) or scatter (guess). No quota spent."); continue; }
      process.stdout.write("  🎲 probing stability (5 local redecodes at sampling temperature)…\n");
      try {
        const samples = await sampleAnswers({ endpoint: model.endpoint, question: q });
        console.log(`  ${renderStabilityReport(stabilityReport(samples)).split("\n").join("\n  ")}`);
      } catch (e) {
        console.log(`  probe failed: ${String(e.message).slice(0, 100)}`);
      }
      continue;
    }
    if (/^:usage\b/i.test(request)) {
      const arg = request.replace(/^:usage\b\s*/i, "").trim().toLowerCase();
      if (arg === "on") usageDisplayEnabled = true;
      else if (arg === "off") usageDisplayEnabled = false;
      else if (arg === "reset") model.resetUsage();
      else if (arg) {
        console.log("  Usage: :usage, :usage on, :usage off, or :usage reset");
        continue;
      }
      console.log(`  usage reporting: ${usageDisplayEnabled ? "on" : "off"}`);
      console.log(`  ${formatUsage(model.usageSummary(), { cumulative: true })}`);
      continue;
    }

    // `:model` / `:models` — list registered models and switch between them in-session.
    if (/^:models?\b/i.test(request)) {
      await handleModelCommand(request.replace(/^:models?\b\s*/i, "").trim());
      continue;
    }

    // Backward-compatible alias; `:model deepseek` is the unified path.
    if (/^:api-model\b/i.test(request)) {
      const arg = request.replace(/^:api-model\b\s*/i, "").trim();
      await handleModelCommand(arg, { apiOnly: true });
      continue;
    }

    if (/^:team\b/i.test(request)) {
      const tail = request.replace(/^:team\b\s*/i, "").trim();
      const [operation = "status", ...extra] = tail.split(/\s+/).filter(Boolean);
      if (extra.length || !["on", "off", "status", "compare", "apply", "reset", "help"].includes(operation)) {
        console.log("  Usage: :team on | off | status | compare | apply | reset | help");
        continue;
      }
      if (operation === "help") {
        console.log([
          "  :team on       explicitly start isolated Local-if-reachable/Luna/Sol/Terra lanes",
          "                 each request runs parallel read-only scouts, then one Terra primary",
          "  :team status   show the active team and whether Local joined",
          "  :team compare  print the latest specialist/primary usage comparison",
          "  :team apply    verify and transactionally apply the Terra candidate",
          "  :team reset    close the team and freeze a new baseline",
          "  :team off      stop Team mode; evidence and private lanes remain",
          "  Team mode never starts automatically and never writes the live workspace before apply.",
        ].join("\n"));
        continue;
      }
      if (operation === "on") {
        if (teamSession) {
          console.log(`  Team mode is already active: ${teamSession.directory}`);
          continue;
        }
        try {
          const started = await startTeamSession();
          console.log([
            `  Team mode enabled: ${started.includeLocal ? "Local, " : ""}Luna, Sol, and Terra.`,
            "  Scouts run read-only in parallel; Terra is the sole integration writer.",
            "  Every lane is isolated. The live workspace remains unchanged until :team apply.",
            "  Team mode is explicit-only and will not auto-fire.",
            `  Session: ${started.directory}`,
          ].join("\n"));
        } catch (error) {
          console.log(`  Team mode could not start: ${error.message}`);
        }
        continue;
      }
      if (operation === "off") {
        if (!teamSession) {
          console.log("  Team mode is not active.");
        } else {
          const directory = teamSession.directory;
          teamSession.close();
          teamSession = null;
          console.log(`  Team mode off. Evidence and lanes remain at ${directory}`);
        }
        continue;
      }
      if (operation === "reset") {
        try {
          teamSession?.close();
          teamSession = null;
          const started = await startTeamSession();
          console.log(`  Team mode reset from the current live workspace: ${started.directory}`);
        } catch (error) {
          console.log(`  Team reset failed: ${error.message}`);
        }
        continue;
      }
      if (!teamSession) {
        console.log("  Team mode is not active. Use :team on.");
        continue;
      }
      if (operation === "status") {
        const current = teamSession.view();
        console.log(
          `  Team ${current.id}: ${current.taskCount} task(s), `
          + `${current.specialists.map((entry) => entry.name).join(", ")}`,
        );
        console.log(`  Local scout: ${current.includeLocal ? "joined" : "not reachable; skipped"}`);
        console.log(`  ${teamSession.directory}`);
        continue;
      }
      if (operation === "compare") {
        const latest = teamSession.view().tasks.at(-1)?.comparison;
        console.log(latest ? formatTeamComparison(latest) : "  No completed Team task yet.");
        continue;
      }
      if (operation === "apply") {
        if (!verificationScript) {
          console.log("  Team apply requires a configured verifier.");
          continue;
        }
        const answer = await wizardPrompt("Apply Terra primary? [y/N]");
        if (!/^y(?:es)?$/i.test(String(answer ?? "").trim())) {
          console.log("  Team apply cancelled.");
          continue;
        }
        try {
          const applied = await applyTeamPrimary({
            sessionDir: teamSession.directory,
            workspace,
            verificationScript,
          });
          teamSession.close();
          teamSession = null;
          console.log(`  Applied Terra primary; live verifier ${applied.verification.status}. Team mode is now off.`);
        } catch (error) {
          console.log(`  Team apply failed safely: ${error.message}`);
        }
        continue;
      }
    }

    if (/^:trio\b/i.test(request)) {
      const tail = request.replace(/^:trio\b\s*/i, "").trim();
      const [operation = "status", value, ...extra] = tail.split(/\s+/).filter(Boolean);
      if (extra.length || !["on", "off", "status", "compare", "apply", "reset", "help"].includes(operation)) {
        console.log("  Usage: :trio on [effort] | off | status | compare | apply <arm> | reset");
        continue;
      }
      if (operation === "help") {
        console.log([
          "  :trio on [effort]  freeze this workspace and start local/Sol/Terra lanes",
          "  :trio status       show the active session",
          "  :trio compare      print the latest objective comparison",
          "  :trio apply <arm>  verify and transactionally apply one whole arm",
          "  :trio reset        close current lanes and freeze a fresh baseline",
          "  :trio off          stop trio mode; evidence and lane workspaces remain",
        ].join("\n"));
        continue;
      }
      if (operation === "on") {
        if (teamSession) {
          console.log(`  Team mode is active. Use :team off before enabling Trio: ${teamSession.directory}`);
          continue;
        }
        if (trioSession) {
          console.log(`  Trio mode is already active: ${trioSession.directory}`);
          continue;
        }
        try {
          const started = await startTrioSession(value || "high");
          console.log([
            "  Trio mode enabled: local, Sol, and Terra.",
            "  Every ordinary request now runs concurrently in three isolated workspaces.",
            "  The live workspace remains unchanged until :trio apply <arm>.",
            `  Session: ${started.directory}`,
          ].join("\n"));
        } catch (error) {
          console.log(`  Trio mode could not start: ${error.message}`);
        }
        continue;
      }
      if (operation === "off") {
        if (!trioSession) {
          console.log("  Trio mode is not active.");
        } else {
          const directory = trioSession.directory;
          trioSession.close();
          trioSession = null;
          console.log(`  Trio mode off. Evidence and lanes remain at ${directory}`);
        }
        continue;
      }
      if (operation === "reset") {
        try {
          trioSession?.close();
          trioSession = null;
          const started = await startTrioSession(value || "high");
          console.log(`  Trio mode reset from the current live workspace: ${started.directory}`);
        } catch (error) {
          console.log(`  Trio reset failed: ${error.message}`);
        }
        continue;
      }
      if (!trioSession) {
        console.log("  Trio mode is not active. Use :trio on.");
        continue;
      }
      if (operation === "status") {
        const current = trioSession.view();
        console.log(`  Trio ${current.id}: ${current.turnCount} turn(s), ${Object.keys(current.arms).join(", ")}`);
        console.log(`  ${trioSession.directory}`);
        continue;
      }
      if (operation === "compare") {
        try {
          console.log(formatTrioComparison(buildTrioComparison(trioSession.view())));
        } catch {
          console.log("  No completed trio turn yet.");
        }
        continue;
      }
      if (operation === "apply") {
        if (!value || !["local", "sol", "terra"].includes(value.toLowerCase())) {
          console.log("  Usage: :trio apply <local|sol|terra>");
          continue;
        }
        if (!verificationScript) {
          console.log("  Trio apply requires a configured verifier.");
          continue;
        }
        const answer = await wizardPrompt(`Apply ${value}? [y/N]`);
        if (!/^y(?:es)?$/i.test(String(answer ?? "").trim())) {
          console.log("  Trio apply cancelled.");
          continue;
        }
        try {
          const directory = trioSession.directory;
          const applied = await applyTrioArm({
            sessionDir: directory,
            arm: value,
            workspace,
            verificationScript,
          });
          trioSession.close();
          trioSession = null;
          console.log(`  Applied ${applied.arm}; live verifier ${applied.verification.status}. Trio mode is now off.`);
        } catch (error) {
          console.log(`  Trio apply failed safely: ${error.message}`);
        }
        continue;
      }
    }

    // `:context [immutable|recompute]` — the speed/accuracy dial, live. The
    // agent re-reads BANTAM_IMMUTABLE_HISTORY inside its turn loop, so a flip
    // lands on the next turn rather than the next session.
    if (/^:context\b/i.test(request)) {
      const arg = request.replace(/^:context\b\s*/i, "").trim();
      if (arg && !/^status$/i.test(arg)) {
        const picked = normalizeContextMode(arg);
        if (!picked) {
          console.log(`  Unknown context mode: ${arg}. Use :context ${CONTEXT_MODES.join(" | :context ")}.`);
          continue;
        }
        applyContextMode(picked);
        contextModeState.source = "remembered";
        const saved = saveUserSetting("contextMode", picked);
        console.log(paint("2", `  context: ${picked} — ${describeContextMode(picked)}${saved ? " (remembered for future sessions)" : ""}`));
        // Append-only history is re-read inside the agent's turn loop, but the
        // trajectory is fixed when a run starts — so a switch into or out of
        // extension lands on the next REQUEST, not the next turn. Say which.
        console.log(paint("2", `  takes effect on your next ${picked === "extension" || contextModeIsImmutable(picked) ? "request" : "turn"}.`));
      } else {
        console.log(paint("2", `  context: ${contextModeState.mode} (${contextModeState.source}) — ${describeContextMode(contextModeState.mode)}`));
        for (const mode of CONTEXT_MODES) {
          console.log(paint("2", `    :context ${mode.padEnd(9)} ${describeContextMode(mode)}`));
        }
      }
      // The definitive gauge, not the convenient one: immutable history only
      // pays on a single-slot server. A multi-slot profile scatters the cache
      // (measured: cache_n drops to 0), so the mode would report ON while
      // delivering nothing. Say so — but never restart the server to "fix" it,
      // because a swap kills whatever run is holding the model lock.
      if (contextModeIsImmutable(contextModeState.mode) && !model.apiMode && !model.codex) {
        let slots = null;
        try {
          const r = await fetch(`${String(model.endpoint).replace(/\/$/, "")}/slots`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) slots = (await r.json()).length;
        } catch { /* no live server to ask */ }
        if (slots > 1) {
          console.log(paint("33", `  ⚠ this server is running ${slots} slots — prefix reuse needs a single slot, so immutable history buys nothing here.`));
          console.log(paint("33", "    Run `bantam swap solo` in another shell when no run is in flight (a swap restarts the server)."));
        }
      }
      continue;
    }

    // `:image [on|off]` — offer generate_image to the model. The tool registry is
    // rebuilt per request, so this lands on the next message.
    if (/^:image\b/i.test(request)) {
      const arg = request.replace(/^:image\b\s*/i, "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        applyImageMode(arg === "on");
        const saved = saveUserSetting("imageMode", imageModeState.on);
        console.log(paint(imageModeState.on ? "33" : "2",
          `  image: ${imageModeState.on ? "ON" : "off"} — ${describeImageMode(imageModeState.on)}${saved ? " (remembered)" : ""}`));
        if (imageModeState.on) {
          console.log(paint("33", "  generate_image runs on your signed-in Codex plan (no per-image charge) — `bantam governor status` shows BANTAM's own caps."));
        }
        console.log(paint("2", "  takes effect on your next request."));
      } else {
        console.log(paint("2", `  image: ${imageModeState.on ? "ON" : "off"} — ${describeImageMode(imageModeState.on)}`));
        console.log(paint("2", "  :image on   ·   :image off"));
      }
      continue;
    }

    // `:eyes [auto|local|codex]` — which model reads an image. Not cosmetic: the
    // local projector misreads machine-rendered images most of the time.
    if (/^:eyes\b/i.test(request)) {
      const arg = request.replace(/^:eyes\b\s*/i, "").trim().toLowerCase();
      if (IMAGE_PROVIDERS.includes(arg)) {
        applyImageProvider(arg);
        const saved = saveUserSetting("imageProvider", arg);
        console.log(paint("2", `  eyes: ${arg} — ${describeImageProvider(arg)}${saved ? " (remembered)" : ""}`));
        if (arg === "codex") console.log(paint("33", "  Codex vision reads each image through your signed-in Codex plan."));
        console.log(paint("2", "  takes effect on your next request."));
      } else if (arg) {
        console.log(`  Unknown: ${arg}. Use :eyes ${IMAGE_PROVIDERS.join(" | :eyes ")}.`);
      } else {
        console.log(paint("2", `  eyes: ${imageProviderState.provider} (${imageProviderState.source}) — ${describeImageProvider(imageProviderState.provider)}`));
        for (const p of IMAGE_PROVIDERS) console.log(paint("2", `    :eyes ${p.padEnd(6)} ${describeImageProvider(p)}`));
      }
      continue;
    }

    // `:modes` — every optional mode, its state, and the command that flips it.
    if (/^:modes?\b/i.test(request)) {
      for (const line of renderModeTable(sessionModeEntries({
        contextMode: contextModeState.mode,
        contextSource: contextModeState.source,
        stream: streamMode,
        deepResearch,
        rooster: roosterOn,
        usage: usageDisplayEnabled,
        image: imageModeState.on,
        imageProvider: imageProviderState.provider,
      }))) console.log(line);
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

    const selfImproveRequest = parseSelfImproveRequest(request);
    if (selfImproveRequest?.help) {
      console.log(selfImproveUsage());
      continue;
    }
    if (selfImproveRequest?.error) {
      console.log(`${paint("31", "✗")} ${selfImproveRequest.error}\nUse :self-improve help for valid forms.`);
      continue;
    }

    // Image task but the current model has no vision? Offer to load a vision model (interactive only).
    if (!selfImproveRequest && tty && /[\w./-]+\.(?:png|jpe?g|gif|webp|bmp)\b/i.test(request) && !(await endpointHasVision(model.endpoint))) {
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

    // The thread is ALWAYS held (operator, 2026-08-17: "I shouldn't have to
    // say 'keep going' to have all that held"). Every request carries the
    // recent asks and the last report in full; bare consent — including an
    // empty Enter — is disambiguated into an explicit continue.
    let task = selfImproveRequest ? request : buildSessionTask({ request, sessionLog });

    running = true; aborted = false; injections = [];
    lastRunStartedAt = Date.now();
    activeRunController = new AbortController();
    let usageBeforeRun = null;
    let requestMode = null;
    const t0 = Date.now();
    const hb = tty ? setInterval(() => {
      if (Date.now() - lastOutputAt > 5000) emit(paint("2", `  · ${activityLabel(activity)} (${Math.round((Date.now() - t0) / 1000)}s)`));
    }, 5000) : null;
    // The pulsing working-prompt: repaint the prompt line (input buffer preserved) a few times a
    // second so the session visibly breathes between output lines.
    const spin = tty ? setInterval(() => {
      redrawInput(rl, runningPrompt());
    }, 250) : null;
    let res = null, trioOutcome = null, teamOutcome = null, selfImproveResult = null, err = null;
    let streamedAnswerShown = false; // set when :stream fully rendered the answer on a tty
    // Every chat request leaves the same evidence a headless --save-run does
    // (.bantam/runs/<stamp>-chat-rN.json, prompt bytes included) — the operator's
    // audit rule is impossible without it. BANTAM_CHAT_RUNS=0 opts out.
    let evidence = null;
    // Snapshot at request start so skill distillation can mint (it requires an integrity-clean
    // verdict; without this, --skills in the REPL silently never learned). Fresh per request —
    // the workspace legitimately evolves between requests, and the baseline is "state at ask".
    const skillSnapshot = skillsCfg ? snapshotTree(workspace) : null;
    try {
      if (selfImproveRequest) {
        const harnessWorkspace = repoRoot();
        selfImproveResult = await runGovernedSelfImprove({
          // A governed self-improvement request always targets the exact
          // harness that owns this launcher, even when Bantam is currently
          // helping with a different project workspace.
          workspace: harnessWorkspace,
          model,
          verificationScript: path.resolve(workspace) === path.resolve(harnessWorkspace)
            ? verificationScript
            : (detectVerifier(harnessWorkspace)?.command ?? null),
          candidateId: selfImproveRequest.candidateId,
          operatorRequest: selfImproveRequest.operatorRequest,
          planOnly: selfImproveRequest.planOnly,
          apply: selfImproveRequest.apply,
          maxTurns: args["max-turns"]
            ? Number(args["max-turns"])
            : (Number(process.env.BANTAM_MAX_TURNS) || 120),
          signal: activeRunController.signal,
          onEvent: makeSelfImproveEventLogger(emit, logger),
        });
      } else if (teamSession) {
        teamOutcome = await teamSession.runTask(request, {
          signal: activeRunController.signal,
        });
      } else if (trioSession) {
        trioOutcome = await trioSession.runTurn(request, {
          signal: activeRunController.signal,
        });
      } else {
        if (!args["no-ground"]) {
          if (!chatGround) {
            // Project KB is a saved artifact: restore from .bantam/ and let
            // ordinary reconcile absorb whatever changed since the save —
            // "edited after finalize" is the normal load path, not an error.
            const t0 = Date.now();
            chatGround = loadGroundingCache(workspace);
            if (chatGround) {
              const r = reconcileGrounding(chatGround);
              process.stderr.write(`  \u{1F9ED} code KB: restored ${chatGround.factIndex?.records?.size ?? 0} files from cache in ${Date.now() - t0}ms${r.changed?.length ? ` (${r.changed.length} refreshed)` : ""}\n`);
              if (r.changed?.length) saveGroundingCache(chatGround);
            } else {
              const width = 24;
              chatGround = buildGrounding(workspace, { onProgress: ({ done, total }) => {
                const filled = Math.max(0, Math.min(width, Math.round((done / Math.max(1, total)) * width)));
                process.stderr.write(`\r  \u{1F9ED} indexing code KB  [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done.toLocaleString()}/${total.toLocaleString()} files`);
                if (done >= total) process.stderr.write("\r\u001b[2K");
              } });
              if (chatGround.stats?.tooLarge) {
                // Over the ceiling: the agent's grounding_state event prints the
                // note (once per process). Keep the object as the session's
                // grounding so the request loop does not rebuild every turn; the
                // agent treats it as no KB. Nothing to reconcile or cache.
              } else {
                reconcileGrounding(chatGround);  // seed the stat stamps for later diffs
                saveGroundingCache(chatGround);
              }
            }
          } else {
            const r = reconcileGrounding(chatGround);
            if (r.changed?.length) {
              process.stderr.write(`  \u{1F9ED} code KB: refreshed ${r.changed.length} changed file(s) in ${r.ms}ms\n`);
              saveGroundingCache(chatGround); // save-on-reconcile: crash-safe, exit job becomes a touch
            }
          }
        }
        // Deep research (opt-in): the A/B-winning proactive trigger — elicit
        // the model's own gap list, shelve sources for it, answer with inks.
        if (deepResearch) {
          try {
            const gaps = await elicitGaps({ endpoint: model.endpoint, question: request });
            if (gaps.length) {
              console.log(`  🔬 deep research: ${gaps.length} self-assessed gap(s) — dispatching the librarian…`);
              const shelfPath = path.join(workspace, "reference", "research-notes.md");
              fs.mkdirSync(path.dirname(shelfPath), { recursive: true });
              try {
                execFileSync("node", [path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "tools", "librarian.cjs"), "--question", `${request} Focus on: ${gaps.join(" | ")}`, "--shelf", shelfPath, "--timeout-sec", "420"], { encoding: "utf8" });
                task += "\nConsult reference/research-notes.md as outside testimony with provenance (not gospel), tag claims [S]/[K], and call out conflicts.";
              } catch (e) {
                const refusal = e.status === 3 ? String(e.stdout ?? "").trim() : "";
                console.log(refusal ? `  ⛔ ${refusal}` : `  deep research errand failed (${String(e.message).slice(0, 80)}); answering without it.`);
              }
            } else {
              console.log("  🔬 deep research: model reports NO-GAPS — answering from local knowledge.");
            }
          } catch (e) {
            console.log(`  deep research elicitation failed (${String(e.message).slice(0, 80)}); answering without it.`);
          }
        }
        evidence = beginChatEvidence({ workspace, request, index: sessionLog.length, model });
        previousAnswerText = lastAnswerText;
        lastAnswerText = "";
        lastUserQuestion = request;
        // Wrap to the live terminal so streamed and canonical text share a
        // silhouette; thinking renders dim ┆, the answer renders plain.
        attendantRun = makeAttendantState();
        const streamRenderer = streamMode
          ? makeStreamRenderer({ wrap: Math.max(50, Math.min(100, (process.stdout.columns || 100) - 4)) })
          : null;
        let streamPhase = "thinking";
        const renderStreamChunk = (text, phase) => {
          for (const line of text.split("\n").slice(0, -1)) {
            if (phase === "action") emit(line ? "  " + line : line);
            else if (line) emit(paint("2", `  ┆ ${line}`));
          }
        };
        // Snapshot the session totals so the summary line can state THIS
        // request's prefix reuse — the chronic case the andon does not fire on.
        usageBeforeRun = { ...(model?.usageTotals ?? {}) };
        // Per-request context dial (measured 2026-08-24, same request, same
        // slot: rebuild 71.5 s of prefill vs extension 9-12 s). A read-only
        // request on a local slot with the dial still at its DEFAULT runs the
        // extension trajectory; an explicit or remembered choice is untouched.
        // src/agent.js reads the env per call, so the flip is scoped to this run.
        requestMode = contextModeForRequest({
          resolved: contextModeState,
          changeShaped: isChangeShapedRequest(task),
          // A server holding a session open is stateful in the same sense as a
          // local KV slot: only a byte-extension prompt reuses what it holds.
          localSlot: !usingCodex && (!usingApi || isLoopbackUrl(model?.apiUrl) || Boolean(model?.chatSessions)),
        });
        if (requestMode.applied) Object.assign(process.env, contextModeEnv(requestMode.mode));
        res = await runAgent({
          task, workspace, model,
          profileText: operatorProfile?.text ?? null,
          // Net access is OFF by default. --dangerously-allow-net grants it
          // outright (no prompts); otherwise a classified internet fetch pauses
          // the run and asks the OPERATOR: once / always / no (default no).
          shellNetwork: args["dangerously-allow-net"] ? true : undefined,
          onNetRequest: args["dangerously-allow-net"] ? null : async ({ command }) => {
            const shown = String(command).replace(/\s+/g, " ").slice(0, 140);
            process.stderr.write(`\n  ${paint("33", "⏸ net access request")} the model wants to run:\n      ${shown}\n`);
            const answer = await new Promise((res2) => rl.question(`  allow network for this? [y]es once / [a]lways this session / [N]o: `, res2));
            const t = String(answer ?? "").trim().toLowerCase();
            if (t === "a" || t === "always") return "allow-session";
            if (t === "y" || t === "yes") return "allow-once";
            return "deny";
          },
          // A chat request is one exchange with a person waiting, not a headless
          // build: 200 turns read as "no deadline" and the cellui correction
          // replay spent 78 turns on one request before the operator pulled it
          // (2026-08-17). The prompt's budget line paces against this number, so
          // it must be one a single request should actually fit. Override with
          // --max-turns or BANTAM_MAX_TURNS; Ctrl-C interrupts.
          maxTurns: args["max-turns"] ? Number(args["max-turns"]) : (Number(process.env.BANTAM_MAX_TURNS) || 60),
          verificationScript,
          verificationWorkspaceReadOnly: args["verify-workspace-read-only"] ? true : undefined,
          verificationPolicy: "after_edit",
          thinkMode, skills: skillsCfg, planMode,
          postVerifyIntegrity: skillSnapshot ? () => checkWorkspace(skillSnapshot, workspace, {}) : null,
          preGate: !args["no-pregate"],
          interactive: true,
          grounding: chatGround ?? !args["no-ground"],   // session KB object after first build
          signal: activeRunController.signal,
          shouldAbort: () => aborted,
          drainInjections: () => { const q = injections; injections = []; return q; },
          onEvent: (e) => {
            // Stream frames render and stop here: they are cumulative content
            // snapshots at ~2/sec — recording them would bloat run evidence,
            // and the logger already gets its activity label separately.
            if (e.type === "model_stream") {
              if (streamRenderer) {
                streamPhase = e.phase || "thinking";
                renderStreamChunk(streamRenderer.feed(e), streamPhase);
              }
              return;
            }
            if (e.type === "action" && streamRenderer) {
              const rest = streamRenderer.finish();
              if (rest.trim()) renderStreamChunk(rest.trimEnd() + "\n", streamPhase);
              // A fully-streamed answer on a live terminal need not print
              // twice; pipes and partial streams keep the canonical copy.
              if (streamPhase === "action" && streamRenderer.answerComplete() && tty) streamedAnswerShown = true;
            }
            evidence?.note(e);
            noteAttendantEvent(attendantRun, e);
            // The thinking glimpse duplicates what streaming already rendered
            // in full (operator hand-test, 2026-08-19) — evidence keeps it,
            // the display shows it once.
            if (!(e.type === "thinking" && streamRenderer)) logger(e);
            if (e.type === "action" && e.action?.a === "respond" && typeof e.action.text === "string") lastAnswerText = e.action.text;
          },
        });
        // Post-answer research offer. The librarian study (2026-08-19) showed
        // the WORST errors carry no uncertainty flag — claim classes, not
        // confidence, decide when sources are worth fetching. Offer only;
        // :research spends, and only when the user says so.
        {
          const offer = researchOffer(lastAnswerText || res?.summary || "");
          // emit, not raw stderr: a bare write while the spinner owns the
          // prompt line bakes "bantam \u28fc writing \u276f" into scrollback
          // (operator hand-test, 2026-08-19).
          if (offer) emit(`  ${offer}`);
          // Poisoned-shelf countermeasure: when a research shelf exists, the
          // HARNESS diffs this answer's fact atoms against the previous one —
          // the model declared "no conflict" over a direct contradiction
          // (2026-08-19 falsifier), so its self-report cannot be the detector.
          if (previousAnswerText && lastAnswerText && fs.existsSync(path.join(workspace, "reference", "research-notes.md"))) {
            const warn = renderClaimDiff(diffClaims(previousAnswerText, lastAnswerText));
            if (warn) for (const l of warn.split("\n")) emit(`  ${l}`);
          }
        }
      }
    } catch (e) {
      err = e;
    } finally {
      evidence?.finalize(res, err);
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

    if (selfImproveResult) {
      console.log(`\n${formatGovernedSelfImproveResult(selfImproveResult)}\n`);
      if (selfImproveResult.warning) {
        console.log(`${paint("33", "⚠")} ${selfImproveResult.warning}\n`);
      }
      sessionLog.push({
        request,
        summary: `self-improvement ${selfImproveResult.status}`,
      });
      // closed means stdin ended (EOF or Ctrl-C at idle) — but a PIPED session
    // delivers all its lines up front and hits EOF immediately, so requests the
    // user already sent are still sitting in `pending`. Breaking here threw
    // them away: `printf 'ask\nfix it\nexit\n' | bantam` answered the first
    // line and said bye, silently dropping the second — observed live
    // 2026-08-17. Drain what was accepted; nextRequest() returns null once
    // pending is empty and closed is set, which ends the loop cleanly.
    if (closed && !pending.length) break;
      continue;
    }

    if (trioOutcome) {
      console.log(`\n${formatTrioComparison(trioOutcome.comparison)}\n`);
      for (const row of trioOutcome.rows) {
        console.log(`${row.arm.toUpperCase()}\n${row.summary || row.status}\n`);
      }
      console.log(`report: ${path.join(trioSession.directory, "report", "index.html")}\n`);
      sessionLog.push({
        request,
        summary: `trio ${trioOutcome.comparison.passing.length}/${trioOutcome.comparison.rows.length} passed`,
      });
      // closed means stdin ended (EOF or Ctrl-C at idle) — but a PIPED session
    // delivers all its lines up front and hits EOF immediately, so requests the
    // user already sent are still sitting in `pending`. Breaking here threw
    // them away: `printf 'ask\nfix it\nexit\n' | bantam` answered the first
    // line and said bye, silently dropping the second — observed live
    // 2026-08-17. Drain what was accepted; nextRequest() returns null once
    // pending is empty and closed is set, which ends the loop cleanly.
    if (closed && !pending.length) break;
      continue;
    }

    if (teamOutcome) {
      console.log(`\n${formatTeamComparison(teamOutcome.comparison)}\n`);
      console.log(`TERRA PRIMARY\n${teamOutcome.primary?.summary || teamOutcome.primary?.status || "no result"}\n`);
      console.log(`report: ${path.join(teamSession.directory, "team-report", "index.html")}\n`);
      sessionLog.push({
        request,
        summary: `team ${teamOutcome.comparison.status}; ${teamOutcome.comparison.totalRequests} model requests`,
      });
      // closed means stdin ended (EOF or Ctrl-C at idle) — but a PIPED session
    // delivers all its lines up front and hits EOF immediately, so requests the
    // user already sent are still sitting in `pending`. Breaking here threw
    // them away: `printf 'ask\nfix it\nexit\n' | bantam` answered the first
    // line and said bye, silently dropping the second — observed live
    // 2026-08-17. Drain what was accepted; nextRequest() returns null once
    // pending is empty and closed is set, which ends the loop cleanly.
    if (closed && !pending.length) break;
      continue;
    }

    if (res) {
      observeCompletedSelfHostRun({
        launcherWorkspace: repoRoot(),
        taskWorkspace: workspace,
        task: request,
        result: res,
        warn: (warning) => {
          emit(paint("33", `  ⚠ ${warning}`));
        },
      });
    }

    // Result prints via the plain path now that the run is over.
    const secs = res ? ((Date.now() - t0) / 1000).toFixed(0) : "0";
    const modelCalls = Number.isInteger(res?.metrics?.modelRequests)
      ? `, ${res.metrics.modelRequests} model calls`
        + (res.metrics.auxiliaryModelRequests > 0
          ? `, +${res.metrics.auxiliaryModelRequests} auxiliary`
          : "")
      : "";
    // Put the dial back where the operator left it, whatever the run did.
    if (requestMode?.applied) Object.assign(process.env, contextModeEnv(contextModeState.mode));
    const reuse = formatRequestPrefixReuse(usageBeforeRun, model?.usageTotals);
    const modeNote = requestMode?.applied ? `, context ${requestMode.mode} (auto)` : "";
    const sessionStats = model?.chatSessions?.stats;
    const sessionNote = sessionStats && (sessionStats.delta + sessionStats.full + sessionStats.rebases)
      ? `, sessions ${sessionStats.delta} delta/${sessionStats.full + sessionStats.rebases} full${sessionStats.rebases ? ` (${sessionStats.rebases} rebase)` : ""}${sessionStats.lost ? ` (${sessionStats.lost} lost)` : ""}`
      : "";
    const meta = res ? paint("2", `(${res.metrics.turns} turns${modelCalls}, ${secs}s${reuse ? `, ${reuse}` : ""}${modeNote}${sessionNote})`) : "";
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
      if (streamedAnswerShown) console.log(`${meta}\n`);
      else console.log(`\n${wrapForTerminal(res.summary, 4, 100).map((l) => (l ? "  " + l : l)).join("\n")}\n  ${meta}\n`);
      sessionLog.push({ request, summary: String(res.summary).replace(/\s+/g, " ").slice(0, 220) });
    } else if (verdict.kind === "paused") {
      const verified = verdict.externallyVerified ? " Verifier passed." : "";
      console.log(`\n${paint("33", "⏸")} Paused at the ${res.metrics.turns}-turn limit${res.summary ? " — " + res.summary : ""}.${verified} ${paint("2", 'Say "keep going" to continue, or raise --max-turns.')} ${meta}`);
      // The pause is not a shrug: show what already exists so the person can
      // decide with their eyes open (the typewriter PWA pause hid a four-stage
      // flow and a service worker behind a bare limit notice).
      const edited = editedPathsOf(res);
      if (edited.paths.length) {
        console.log(paint("2", `  progress so far: edited ${edited.paths.join(", ")}${edited.more ? ` (+${edited.more} more)` : ""}`));
      }
      console.log("");
      const editNote = edited.paths.length ? ` [edited so far: ${edited.paths.join(", ")}]` : "";
      sessionLog.push({ request, summary: `${String(res.summary || "(in progress)").replace(/\s+/g, " ").slice(0, 180)}${editNote}`.slice(0, 300) });
    } else if (verdict.kind === "warning") {
      // "⚠ unverified" beside a summary that honestly says "verified via
      // preview" read as a contradiction (operator feedback, 2026-08-17). The
      // truthful shape: the done was ACCEPTED, and the bullets below name the
      // specific residual doubts. Label the whole, blame the parts.
      console.log(`\n${paint("33", "⚠ done with caveats")} ${res.summary || "done"} ${meta}`);
      for (const warning of verdict.warnings) {
        console.log(`  ${paint("33", "•")} ${paint("2", warning.message)}`);
      }
      // Proposals surface here too — an unverified finish still has a next.
      lastProposedNext = extractNextStep(res.summary);
      if (lastProposedNext) console.log(`${paint("36", "→ next:")} ${lastProposedNext} ${paint("2", "(Enter or any yes continues)")}`);
      console.log("");
      sessionLog.push({ request, summary: `${String(res.summary || "done").replace(/\s+/g, " ").slice(0, 200)} (done with caveats)`, fullSummary: String(res.summary || "done").slice(0, 900) });
    } else {
      const verified = verdict.externallyVerified ? ` ${paint("2", "· verifier passed")}` : "";
      console.log(`\n${paint("32", "✓")} ${res.summary || "done"}${verified} ${meta}`);
      // Show it working. Praise in the operator's real sessions follows
      // demonstrations, not claims ("dial it in and test it out. Show me it
      // working"). The receipt is the run's own last deliverable output; when
      // the run never ran its deliverable there is no receipt, honestly.
      const demo = demonstrationOf(res);
      if (demo) {
        console.log(paint("2", `  shown working: $ ${demo.command}`));
        for (const l of demo.output) console.log(paint("2", `    ${l}`));
      }
      // Anticipation: the agent's own Next proposal, made pressable. The
      // operator should never have to compose a continuation — Enter is the
      // minimal yes, and any affirmation works.
      const next = extractNextStep(res.summary);
      lastProposedNext = next;
      if (next) console.log(`${paint("36", "→ next:")} ${next} ${paint("2", "(Enter or any yes continues; anything else is a new request)")}`);
      console.log("");
      sessionLog.push({ request, summary: String(res.summary || "done").replace(/\s+/g, " ").slice(0, 220), fullSummary: String(res.summary || "done").slice(0, 900) });
    }
    // closed means stdin ended (EOF or Ctrl-C at idle) — but a PIPED session
    // delivers all its lines up front and hits EOF immediately, so requests the
    // user already sent are still sitting in `pending`. Breaking here threw
    // them away: `printf 'ask\nfix it\nexit\n' | bantam` answered the first
    // line and said bye, silently dropping the second — observed live
    // 2026-08-17. Drain what was accepted; nextRequest() returns null once
    // pending is empty and closed is set, which ends the loop cleanly.
    if (closed && !pending.length) break;
  }
  teamSession?.close();
  trioSession?.close();
  model.close();
  rl.close();
  // The closing touch (operator order): reconcile whatever changed during the
  // session into the saved KB so the NEXT session restores instantly.
  if (chatGround) {
    try {
      const r = reconcileGrounding(chatGround);
      saveGroundingCache(chatGround);
      if (r.changed?.length) process.stderr.write(`  \u{1F9ED} code KB saved (${r.changed.length} late change(s) folded in)\n`);
    } catch { /* a failed save costs a rebuild, never a broken exit */ }
  }
  console.log("bye");
}

async function selfImproveCommand({ modelClient, forcePlan = false } = {}) {
  const allowedOptions = new Set([
    "workspace", "candidate", "verify", "max-turns", "plan", "dry-run",
    "no-apply", "help", "endpoint", "profile", "temperature",
    "act-temperature", "top-p", "top-k", "api-url", "api-key", "model",
    "api-dialect", "no-rooster", "rooster", "shell-network", "codex",
    "codex-effort",
  ]);
  const unknown = Object.keys(args).find((name) => name !== "_" && !allowedOptions.has(name));
  if (unknown) fail(`self-improve does not recognize --${unknown}`);
  if (args._.length !== 1) fail("self-improve does not accept positional arguments");
  if (args.verify === true) fail("self-improve --verify requires a command");
  if (args.candidate === true) fail("self-improve --candidate requires an id");
  if (typeof args.verify === "string" && !args.verify.trim()) {
    fail("self-improve --verify requires a non-empty command");
  }
  if (typeof args.candidate === "string" && !args.candidate.trim()) {
    fail("self-improve --candidate requires an id");
  }
  if (typeof args.workspace === "string" && !args.workspace.trim()) {
    fail("self-improve --workspace requires a directory");
  }
  // This command governs Bantam itself. With no override, bind it to the
  // checkout that owns this exact launcher rather than the caller's cwd.
  const workspace = path.resolve(args.workspace || repoRoot());
  if (!forcePlan) {
    let requestedRoot;
    let launcherRoot;
    try {
      requestedRoot = fs.realpathSync(workspace);
      launcherRoot = fs.realpathSync(repoRoot());
    } catch (error) {
      fail(`self-improve workspace is unavailable: ${error.message}`);
    }
    if (requestedRoot !== launcherRoot) {
      fail("managed self-improvement must target the exact checkout that owns this launcher");
    }
  }
  const maxTurns = args["max-turns"] === undefined
    ? undefined
    : Number(args["max-turns"]);
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    fail("self-improve --max-turns must be a positive integer");
  }
  if (!forcePlan && (!modelClient || !(await modelClient.health()))) {
    process.stderr.write("self-improve: the configured model is unreachable; no candidate was built or applied.\n");
    return 1;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signalName, stop);
  const onEvent = forcePlan
    ? () => {}
    : makeSelfImproveEventLogger(
        (line) => process.stderr.write(`${line}\n`),
        typeof liveLogger === "function" ? liveLogger : () => {},
      );
  try {
    const result = await runGovernedSelfImprove({
      workspace,
      model: modelClient,
      verificationScript: typeof args.verify === "string" ? args.verify : null,
      candidateId: typeof args.candidate === "string" ? args.candidate : null,
      operatorRequest: "Operator requested governed self-improvement from the development CLI.",
      planOnly: forcePlan,
      apply: !args["no-apply"],
      maxTurns,
      signal: controller.signal,
      onEvent,
    });
    console.log(formatGovernedSelfImproveResult(result));
    if (result.warning) process.stderr.write(`self-improve warning: ${result.warning}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`self-improve failed: ${error.message}\n`);
    return 1;
  } finally {
    for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.removeListener(signalName, stop);
    }
  }
}

async function collaborateCommand() {
  const {
    assessLocalRun,
    DEFAULT_TEACHER_MODELS,
    formatTeacherCollaboration,
    parseGrade,
    runTeacherCollaboration,
    saveTeacherCollaboration,
  } = await import("../src/teacher-collaboration.js");
  const {
    compareTeacherTrajectories,
    formatTrajectoryComparison,
  } = await import("../src/trajectory-comparison.js");
  const { loadTrioTeacherArtifacts } = await import("../src/trio-evidence.js");
  if (args.help) {
    console.log(collaborateUsage());
    return 0;
  }
  const sources = args._.slice(1);
  if (sources.length !== 1 && sources.length < 3) {
    process.stderr.write(
      "collaborate requires a trio session directory, or one local artifact followed by at least two reference artifacts.\n",
    );
    process.stderr.write(`${collaborateUsage()}\n`);
    return 2;
  }
  if (args.turn === true || (args.turn !== undefined && typeof args.turn !== "string")) {
    process.stderr.write("collaborate --turn requires latest or a positive integer.\n");
    return 2;
  }
  if (args.turn !== undefined && sources.length !== 1) {
    process.stderr.write("collaborate --turn is only valid with a trio session directory.\n");
    return 2;
  }
  const workspace = path.resolve(
    typeof args.workspace === "string" ? args.workspace : repoRoot(),
  );
  const models = typeof args.models === "string"
    ? args.models.split(",").map((value) => value.trim()).filter(Boolean)
    : [...DEFAULT_TEACHER_MODELS];
  const effort = typeof args.effort === "string" ? args.effort.trim() : "high";
  let grades;
  try {
    grades = parseCollaborationGrades(args.grades, parseGrade);
  } catch (error) {
    process.stderr.write(`collaborate: ${error.message}\n`);
    return 2;
  }
  let artifacts;
  let evidenceLabel;
  try {
    if (sources.length === 1) {
      const trio = loadTrioTeacherArtifacts(path.resolve(sources[0]), {
        turn: typeof args.turn === "string" ? args.turn : "latest",
      });
      artifacts = [trio.artifacts.local, trio.artifacts.sol, trio.artifacts.terra];
      evidenceLabel = `trio ${trio.sessionId} turn ${trio.turn}`;
    } else {
      artifacts = sources.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
      evidenceLabel = `${artifacts.length} explicit artifacts`;
    }
  } catch (error) {
    process.stderr.write(`collaborate: cannot read artifacts: ${error.message}\n`);
    return 2;
  }
  let trajectoryComparison;
  try {
    trajectoryComparison = compareTeacherTrajectories(artifacts[0], artifacts.slice(1));
  } catch (error) {
    process.stderr.write(`collaborate: incomparable trajectory evidence: ${error.message}\n`);
    return 2;
  }
  if (args.preview) {
    console.log(`Evidence source: ${evidenceLabel}`);
    console.log(formatTrajectoryComparison(trajectoryComparison));
    const assessment = assessLocalRun(artifacts[0], {
      grade: grades.local,
      force: Boolean(args.proactive),
    });
    console.log(
      assessment.eligible
        ? `Teacher eligibility: yes (${assessment.reasons.join("; ")})`
        : "Teacher eligibility: withheld unless --proactive is supplied",
    );
    return 0;
  }
  if (!args.yes) {
    process.stderr.write(
      "Teacher collaboration sends a bounded task/trajectory packet to Codex. "
      + "Re-run with --yes to authorize those external model calls, or --preview for local-only evidence.\n",
    );
    return 2;
  }

  const clients = new Map();
  const clientFor = (modelName) => {
    if (!clients.has(modelName)) {
      clients.set(modelName, new ModelClient({
        codex: true,
        model: modelName,
        codexEffort: effort,
        timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) : 600000,
      }));
    }
    return clients.get(modelName);
  };
  try {
    for (const modelName of models) {
      const client = clientFor(modelName);
      if (!(await client.health())) {
        throw new Error(`Codex model is unavailable: ${modelName}`);
      }
    }
    const result = await runTeacherCollaboration({
      local: artifacts[0],
      references: artifacts.slice(1),
      grades,
      models,
      effort,
      force: Boolean(args.proactive),
      invokeTeacher: async ({ model: modelName, phase, prompt, schema }) => {
        process.stderr.write(`  teacher council · ${modelName} ${phase}\n`);
        const completion = await clientFor(modelName).complete(prompt, {
          jsonSchema: schema,
          nPredict: 4096,
          recordLabel: `teacher-collaboration:${phase}`,
        });
        return completion.content;
      },
      usageForModel: (modelName) => clientFor(modelName).usageSummary(),
    });
    let reportPath = null;
    if (result.report) {
      reportPath = saveTeacherCollaboration(workspace, result.report, {
        output: typeof args.out === "string" ? args.out : null,
      });
    }
    console.log(formatTeacherCollaboration(result, reportPath));
    return 0;
  } catch (error) {
    process.stderr.write(`collaborate failed: ${error.message}\n`);
    return 1;
  } finally {
    for (const client of clients.values()) client.close();
  }
}

function parseCollaborationGrades(value, parse) {
  if (value === undefined) return {};
  if (value === true || typeof value !== "string") {
    throw new Error("--grades requires local=passed/tests,sol=passed/tests,terra=passed/tests");
  }
  const out = {};
  for (const assignment of value.split(",")) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(\d+\/\d+)\s*$/.exec(assignment);
    if (!match) throw new Error(`invalid --grades entry: ${assignment}`);
    out[match[1].toLowerCase()] = parse(match[2]);
  }
  return out;
}

function collaborateUsage() {
  return `Usage:
  ./bin/run-dev.sh collaborate <trio-session-dir> [--turn latest|N] [options]
  ./bin/run-dev.sh collaborate <local-run.json> <sol-run.json> <terra-run.json> [options]

Run an independent Sol/Terra teacher council over same-task BANTAM artifacts.
Each teacher diagnoses the local harness and designs adversarial tests, then
cross-reviews the other teacher. Cross-accepted hypotheses become durable,
build-only candidates visible in \`:self-improve plan\`.

Options:
  --yes               authorize sending the bounded evidence packet to Codex
  --preview           compute deterministic trajectory evidence locally; no model calls
  --turn <latest|N>   select a completed trio turn (default: latest)
  --grades <list>     external grades, e.g. local=3/10,sol=9/10,terra=10/10
  --models <list>     Codex models (default: gpt-5.6-sol,gpt-5.6-terra)
  --effort <level>    reasoning effort for council calls (default: high)
  --proactive         consult despite no automatic local struggle signal
  --workspace <dir>   BANTAM checkout that stores the report (default: launcher)
  --out <file>        report path inside the workspace
  --timeout <ms>      per-call timeout (default: 600000)

Teacher consensus is witness evidence, not promotion evidence. Candidate builds
remain on dev until replay and a preregistered paired experiment measure lift.`;
}

function hypothesizeCommand() {
  const paths = args._.slice(1);
  if (args.help || paths.length < 2) {
    const stream = args.help ? process.stdout : process.stderr;
    stream.write(`Usage:
  ./bin/run-dev.sh hypothesize <subject-run.json> <reference-run.json> [...]
    [--max-candidates N] [--json]

Compare exact same-task BANTAM artifacts without making model calls. The first
artifact is the subject; subsequent artifacts are references. Candidates are
emitted only when a reference passed and the subject failed. Output is witness
evidence for a fresh paired experiment, never an automatic source change or
promotion decision.
`);
    return args.help ? 0 : 2;
  }
  try {
    const artifacts = paths.map((file) => {
      const resolved = path.resolve(file);
      return JSON.parse(fs.readFileSync(resolved, "utf8"));
    });
    const comparison = compareTeacherTrajectories(artifacts[0], artifacts.slice(1));
    const maxCandidates = args["max-candidates"] === undefined
      ? 4
      : Number(args["max-candidates"]);
    const result = deriveTrajectoryHypotheses(comparison, { maxCandidates });
    process.stdout.write(`${args.json
      ? JSON.stringify({ comparison, hypotheses: result }, null, 2)
      : formatTrajectoryHypotheses(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`hypothesize failed: ${error.message}\n`);
    return 1;
  }
}

function makeSelfImproveEventLogger(write, fallback = () => {}) {
  let verifierOutputChars = 0;
  const maxVerifierOutputChars = 16_000;
  const phases = {
    selected: "selected a frozen improvement candidate",
    implementing: "building the candidate in a private exact lane",
    deployed: "deployed exact candidate bytes; checking content attestation",
    promoted: "promoted the verified candidate",
  };
  return (event) => {
    if (event?.type === "self_improve_phase") {
      write(`  self-improve · ${phases[event.phase] ?? event.phase}`);
      return;
    }
    if (event?.type === "self_improve_verification") {
      const suffix = event.tests
        ? ` (${event.tests.passed} passed, ${event.tests.failed} failed)`
        : "";
      write(`  self-improve · ${event.phase} verification ${event.status}${suffix}`);
      return;
    }
    if (event?.type === "shell_output") {
      if (verifierOutputChars >= maxVerifierOutputChars) return;
      const clean = safeShellOutput(event.text);
      const shown = clean.slice(0, maxVerifierOutputChars - verifierOutputChars);
      verifierOutputChars += shown.length;
      for (const line of shown.split(/\r?\n/)) {
        if (line) write(`    ${event.stream === "stderr" ? "stderr │" : "│"} ${line}`);
      }
      if (shown.length < clean.length) write("    … verifier output capped");
      return;
    }
    fallback(event);
  };
}

function selfImproveUsage() {
  return `Usage: ./bin/run-dev.sh self-improve [options]

Observe this Bantam checkout, freeze one evidence-backed weakness, implement it
in a private exact lane, run immutable candidate + protected baseline tests,
then transactionally deploy and promote only the exact passing bytes.

Options:
  --workspace <dir>   exact Bantam development checkout (default: this launcher)
  --candidate <id>    select one candidate shown by --plan
  --verify "<cmd>"    authoritative test command (auto-detected by default)
  --max-turns <n>     implementation-agent turn budget (default: 120)
  --plan              scan without model or self-improvement state/source writes
  --no-apply          build, test, and checkpoint to dev without changing live files
  --help              show this help

Interactive: use :self-improve, :self-improve plan, or a deliberate request such
as "Let's do a little self improvement." Questions about self-improvement are
left as ordinary conversation.`;
}

async function auditReplayCommand() {
  const evidencePath = args._[1];
  if (args.help) {
    console.log("usage: bantam audit-replay <evidence.json|study-directory> [--artifact run.json] [--json]");
    process.exit(0);
  }
  if (!evidencePath) {
    process.stderr.write("usage: bantam audit-replay <evidence.json|study-directory> [--artifact run.json] [--json]\n");
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
    console.log("usage: bantam replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint url] [--json]");
    process.exit(0);
  }
  if (!specPath) {
    process.stderr.write("usage: bantam replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint url] [--json]\n");
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
    console.log("usage: bantam replay-mine [artifact-directory ...] [--untreated] [--uncontrasted] [--coverage FILE --uncovered] [--mode SHA_PREFIX] [--json]");
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
  return `bantam [--workspace .] [--verify "npm test"] [--shell-network] [--context-mode rebuild|extension]
                                  interactive mode (type requests; works on the selected dir)
bantam chat                       same as above (explicit)
./bin/run-dev.sh self-improve [--candidate ID] [--verify "npm test"] [--max-turns 120] [--no-apply]
./bin/run-dev.sh self-improve --plan
                                  inspect candidates; no model or controller/source writes
bantam run --task "..." [--workspace . | --lane ID [--state-home DIR]] [--max-turns 30] [--verify "npm test"] [--verify-workspace-read-only] [--autonomous] [--ground] [--tui] [--plan] [--skills] [--save-run[=path]]
           [--resume-run artifact.json [--through-turn N]] [--review-file evidence.txt] [--factory [--factory-home DIR]]
bantam exec [options] "<task text>"   one-shot: run a task, verify, exit (headless, no TUI)
bantam factory list|show|audit|report ...
                                  inspect durable factory travelers without a model server
bantam eval [fixtureDir ...] [--save-run[=path]]
bantam experiment spec.json [--output path] [--dry-run] [--yes for native CLI arms]
bantam experiment spec.json --resume evidence-directory
bantam gauntlet [--models local,sol,terra] [--quick] [--rounds N] [--faults]
                                  isolated same-task model comparison with hidden contracts and full usage metrics
bantam trio run --task "..." [--workspace .] [--verify "npm test"] [--models local,sol,terra] [--effort high]
bantam trio show <session-dir>
bantam trio apply <session-dir> --arm <local|sol|terra> --yes
                                  parallel isolated real-task comparison and explicit transactional adoption
bantam delegate run --yes --provider codex|claude --task "..." [--model NAME] [--effort high] [--verify "npm test"]
bantam delegate show <artifact-or-run-dir> [--json]
bantam delegate compare <evidence> <evidence> [...]
bantam delegate apply <artifact-or-run-dir> --yes [--verify "npm test"]
                                  research-only native Codex control; constrained BANTAM remains the default
bantam analyze [ledger.jsonl ...] [--json] [--all-runs]
bantam collaborate <local.json> <sol.json> <terra.json> --yes [--grades local=3/10,sol=9/10,terra=10/10]
bantam hypothesize <subject.json> <reference.json> [...] [--json]
                                  turn saved trajectory gaps into model-free, falsifiable harness candidates
bantam replay <run.json> --turn N [--inject "text"]
bantam replay-ab spec.json [--dry-run] [--max-calls N] [--study-root directory] [--require-new-design] [--output evidence-directory] [--endpoint URL] [--json]
                                  paired exact-turn semantic counterfactual with durable evidence
bantam replay-mine [artifact-directory ...] [--untreated] [--uncontrasted] [--coverage FILE --uncovered] [--mode SHA_PREFIX] [--json]
                                  model-free exact-task mixed-outcome specimen discovery
bantam audit-replay evidence.json [--artifact run.json] [--json]
                                  independently re-hash and re-score replay evidence
bantam audit-run <run-artifact.json> [...] [--json]
                                  independently verify attachments, tool outcomes, usage, and Codex prompt evidence
bantam state init [--source DIR] [--state-home DIR] [--json]
bantam channel list|show|history|checkpoint|promote|rollback|materialize ... [--state-home DIR] [--json]
bantam channel run regular|dev --lane ID --expected VERSION [--dependency-root DIR] [--state-home DIR] -- [run options]
bantam channel experiment regular|dev --lane ID --expected VERSION [--dependency-root DIR] [--state-home DIR] -- spec.json [experiment options]
bantam lane create|list|status|checkpoint|fork|materialize ... [--state-home DIR] [--json]
bantam bench [fixtureDir ...] [--repeat N]     reliability: grammar ON vs OFF, malformed-output rates
bantam runs [workspace]           list the evidence shelf (.bantam/runs): every chat request and --save-run artifact, newest first
bantam runlens <artifact.json> [--json]
                                  digest one run artifact: header, cache reuse, action histogram, timeline, gate rejections
bantam skills                     list the learned-skills library
bantam health [--endpoint http://localhost:8085]
bantam models                     list registered local models (● running, ○ stopped, ✖ launch script missing)
bantam models add <name> --script /path/to/launch.sh [--endpoint URL] [--vision] [--slots N] [--ctx N] [--vram-mb N]
                                  [--priority N] [--warn "..."] [--notes "..."] [--replace]   (--priority ranks the startup picker)
                                  register a llama.cpp model so the startup picker can launch it (run bare for prompts)
bantam models remove <name>       unregister a model    ·    bantam models path   print the registry file
bantam setup                       guided: existing server, Codex, or opt-in DavidAU 24GB stock
bantam setup --stock-profile 72k-cpu-vision|92k-cpu-vision|72k-gpu-vision|tiel-32k-cpu-experts [--yes]
                                  managed Linux/NVIDIA profile; --yes authorizes download and launch
bantam addons [install <name>]    list the optional add-ons (vision, speculative decoding) with sizes — nothing optional is bundled
bantam supervise [film.json] [--json]
                                  read a saved run back and draft findings with evidence (see docs/SUPERVISOR.md)
bantam doctor --api-url URL [--api-key KEY] [--model NAME] [--api-dialect llamacpp|vllm]  use an existing OpenAI-compatible server (validates + saves it)
bantam doctor [--launch] [--json]  check setup (Node, model server, GPU, GGUF, registry) and scaffold a start script
bantam doctor --install-llama [--yes] [--vulkan]  download a prebuilt llama-server (GPU=Vulkan / CPU) — no build
bantam doctor --provision [--yes] [--quant Q4_K_M] [--gguf-url URL]  download the model (default: the 4-bit) from Hugging Face, resumable
bantam strut [idle|peck|flap|crow|walk|all] [--micro] [--loops N] [--fps N] [--list]
                                  play the rooster animations in the terminal (Ctrl-C to stop)

--autonomous turns on the unattended-run guardrails (progress gate, premature-done veto,
ledger). Interactive mode leaves them off so the harness just does what you ask.
For autonomous runs, use --ground or BANTAM_GROUND=1 to enable the query socket.

Common model flags: [--endpoint URL] [--profile qwen|gemma|generic] [--think auto|off|always] [--temperature N] [--act-temperature N] [--top-p N] [--top-k N]
More run flags: [--tui] [--title "..."] [--plan] [--skills [path]] [--lang X] [--no-pregate] [--no-ground] [--no-edit]
Usage display: [--usage] [--no-usage] (or BANTAM_USAGE=on|off); in chat use :usage [on|off|reset]
Images:        [--ground is on by default] BANTAM_CODEX_IMAGE=1 or :image on — offers generate_image and
               edit_image to the model, brokered through the signed-in Codex account (included with the
               plan, no per-image charge; announced in the startup modes line). The first interactive launch
               that finds a signed-in Codex asks once whether to turn this on (BANTAM_NO_ONBOARDING=1 skips). :eyes [auto|local|codex] chooses which model READS an
               image; the local mmproj wins by default whenever a projector is loaded. Concurrency falls to
               3 at >=2 Mpx or --quality high (BANTAM_CODEX_IMAGE_CONCURRENCY overrides).

Chat transport: [--chat-transport] (or BANTAM_CHAT_TRANSPORT=1) — send turns as chat messages so the
               server checkpoints at every user-message boundary (3x less prefill at depth). Opt-in and
               self-testing: it turns itself OFF unless the server re-renders the prompt byte-for-byte.
               Check any captured prompt with: bantam chat-transport <file>

Context dial:  [--context-mode rebuild|immutable|extension] [--immutable-history] [--recompute]
               (or BANTAM_PROMPT_TRAJECTORY / BANTAM_IMMUTABLE_HISTORY); in chat use :context
               rebuild   every prompt re-rendered - clean context, full reprefill (default)
               immutable append-only history - a single-slot server reuses its KV cache
               extension byte-extension prompts - fastest reuse, stale bodies never leave context
               The choice is remembered across sessions; every session prints its modes at startup
               and :modes lists them. Reuse needs a single-slot server (bantam swap solo).

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

function canOfferStartupChoice(command) {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY)
    && !envTruthy('BANTAM_NO_ONBOARDING')
    && !args.codex && !args.deepseek && !args['api-url'] && !process.env.BANTAM_API_URL
    && typeof args.endpoint !== "string"
    && !process.env.BANTAM_ENDPOINT
    && (command === undefined || command === "chat" || command === "run");
}

function deepSeekFallbackOptions() {
  const named = savedApi?.presets?.["deepseek-pro"]
    || savedApi?.presets?.deepseek
    || savedApi?.presets?.["deepseek-flash"]
    || null;
  const configured = savedApi?.deepseek === true ? savedApi : named;
  return {
    apiUrl: configured?.apiUrl || configured?.url || "https://api.deepseek.com/v1",
    apiKey: process.env.BANTAM_API_KEY
      || process.env.DEEPSEEK_API_KEY
      || configured?.apiKey
      || configured?.key
      || null,
    model: configured?.model || "deepseek-v4-pro",
    apiDialect: configured?.dialect,
  };
}

function askSetup(question) {
  const rl=readline.createInterface({input:process.stdin,output:process.stderr});
  return new Promise(resolve=>rl.question(question,answer=>{rl.close();resolve(answer);}));
}
function setupWizardOptions(){
  return {ask:askSetup,out:s=>process.stderr.write(s),hidden:promptHidden,advanced:true,
    installLlama:async()=>{execFileSync(process.execPath,[path.join(repoRoot(),'bin','bantam.js'),'doctor','--install-llama','--yes'],{stdio:'inherit'});}};
}
async function promptStartupModelChoice(client) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  let first;
  try{first=await setupWizard(setupWizardOptions());}catch(e){fail(`Setup: ${e.message}`);}
  if(!first)return null;
  if(first.kind!=='advanced'&&first.kind!=='choose-codex')return first;
  const onlyCodex=first.kind==='choose-codex';
  const locals = listModels();
  let catalog = [];
  try { catalog = await client?.listCodexModels?.(); } catch { /* offline fallback */ }
  // codexapi bridge: offered when it answers, or when a checkout is known so
  // selecting it can start it. Same models as the app-server, over HTTP, with
  // sessions held open — and reachable from any box on the LAN.
  const bridgeConfig = resolveCodexapiConfig({ env: process.env, settings: loadUserSettings() });
  if (!onlyCodex && !bridgeConfig.dir) bridgeConfig.dir = findCodexapiCheckout({ repoRoot: repoRoot(), home: os.homedir() });
  const bridge = onlyCodex ? {reachable:false,models:[]} : await bridgeStatus(bridgeConfig.url, bridgeConfig.key);
  const choices = startupModelChoices({
    locals: onlyCodex ? [] : locals,
    catalog,
    preference: loadModelPreference(),
    codexapi: codexapiChoices({ status: bridge, config: bridgeConfig, preference: loadModelPreference() }),
  }).filter(entry=>!onlyCodex||entry.kind==='codex');
  process.stderr.write("\nNo local model is running. Choose a model:\n");
  choices.forEach((entry, index) => {
    const badges = [
      entry.recommended ? "recommended" : null,
      entry.lastUsed ? "last used" : null,
    ].filter(Boolean);
    process.stderr.write(`  [${index + 1}] ${entry.label}${badges.length ? `  ← ${badges.join(", ")}` : ""}\n`);
    if (entry.detail) process.stderr.write(`      ${entry.detail}\n`);
  });
  // Enter takes the lit button. Having a recommendation and then making the
  // default keypress mean "cancel" is the wrong button being the easy one.
  const lit = choices.find((entry) => entry.recommended);
  process.stderr.write(lit
    ? `  [Enter] ${lit.label}   ·   [q] cancel\n`
    : "  [Enter] Cancel\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question(lit ? `Select [${choices.indexOf(lit) + 1}]: ` : "Select: ", resolve));
  rl.close();
  const selected=resolveStartupModelChoice(choices, answer, { enterSelectsRecommended: Boolean(lit) });
  if(selected?.kind==='codex'&&!await confirmCodexConsent({ask:askSetup,out:s=>process.stderr.write(s),model:selected.model}))return null;
  return selected;
}

async function promptHidden(question) {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return "";

  output.write(question);
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    let value = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", finish);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003") {
          value = "";
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
    input.on("end", finish);
  });
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}
