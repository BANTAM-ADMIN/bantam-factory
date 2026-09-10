#!/usr/bin/env node
// Three cumulative, same-starter project cards. Candidate code is written only
// by the contenders. Raw evidence remains local; no publishing or narrator.
import fs from "node:fs";
import {readJsonFile} from '../src/json-file.js';
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runProcess } from "../src/process-runner.js";
import { wasControllerStopped } from "../src/controller-stop.js";
import { runShellProcess } from "../src/executor.js";
import { buildArmCommand, cornerUsage, listArtifacts } from "../src/fight.js";
import { writeFightReplay, replayCardData, renderReplayHtml } from "../src/fight-replay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "examples/fights/repobrief-astra-2026-09-06");
const LAUNCHER = path.join(ROOT, "scripts/astra-container-cli.mjs");
const ARMS = ["bantam-codex-astra", "codex-astra", "bantam-local-27b"];
const CARD_FILES = ["01-status.md", "02-snapshots.md", "03-verification.md"];
const OMIT = new Set([".git", ".bantam", ".codex", ".repobrief", "node_modules"]);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

export function treeHashes(directory, { excludeGenerated = false } = {}) {
  const files = {};
  function walk(rel) {
    for (const entry of fs.readdirSync(path.join(directory, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludeGenerated && (OMIT.has(entry.name) || entry.name.startsWith(".bantam"))) continue;
      const name = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) files[name] = `symlink:${fs.readlinkSync(path.join(directory, name))}`;
      else if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files[name] = sha(fs.readFileSync(path.join(directory, name)));
    }
  }
  walk("");
  return files;
}

export function changedSealedFiles(before, directory) {
  return Object.entries(before).filter(([name, hash]) => {
    try { return !fs.lstatSync(path.join(directory, name)).isFile() || sha(fs.readFileSync(path.join(directory, name))) !== hash; }
    catch { return true; }
  }).map(([name]) => name);
}

export function cardOrder(stage) { return stage === 2 ? [...ARMS].reverse() : [...ARMS]; }

export function acceptedBantamCompletion(saved) {
  if (saved?.result?.reachedDone !== true || saved.result.pass !== true
      || saved.result.interrupted === true || saved.result.modelFailure) return false;
  // Older controllers also used `done` to stop a stalled loop before grading.
  // Passing final tests therefore does not by itself establish model completion.
  if (wasControllerStopped({ ...saved.result, metrics: saved.metrics })) return false;
  // Keep the legacy explicit reachedDone/pass contract when no turn log was
  // serialized. When a log exists, do not discard contradictory/missing evidence
  // or mistake an earlier rejected done for the actual terminal action.
  if (Object.hasOwn(saved, "turns")) {
    if (!Array.isArray(saved.turns) || saved.turns.length === 0) return false;
    const last = saved.turns.at(-1);
    if (!last || typeof last !== "object" || Array.isArray(last) || last.doneAccepted === false) return false;
    const action = Object.hasOwn(last, "parsedAction") ? last.parsedAction : last.action;
    if (!action || typeof action !== "object" || Array.isArray(action) || action.a !== "done") return false;
    if (last.action != null && last.action.a !== "done") return false;
  }
  return true;
}

export function gradeCandidate(workspace, stage, kitSeal = treeHashes(KIT)) {
  const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
  return runShellProcess(workspace,
    `node --test test/*.test.js && node ${quote(path.join(KIT, "grader.mjs"))} --workspace ${quote(workspace)} --stage ${stage}`, {
      shellSandbox: "docker", shellNetwork: false, workspaceReadOnly: true,
      readOnlyHostFiles: [path.join(ROOT, "package.json"), ...Object.keys(kitSeal)
        .filter((file) => /\.(m?js|json)$/.test(file)).map((file) => path.join(KIT, file))],
      timeoutMs: 120_000,
    });
}

export function cardCommand(arm, task, workspace, runDir) {
  const command = buildArmCommand(arm, { task });
  if (arm === "codex-astra") {
    // The launcher supplies external Docker isolation on hosts where bwrap
    // cannot operate. It replaces the in-container sandbox flag, never runs an
    // unrestricted agent directly on the host, and starts with a clean config.
    const args = [...command.args];
    const sandbox = args.indexOf("--sandbox");
    args.splice(sandbox, 2, "--dangerously-bypass-approvals-and-sandbox");
    return { ...command, exe: LAUNCHER, args };
  }
  const args = [...command.args];
  args[args.indexOf("--workspace") + 1] = workspace;
  args[args.findIndex((arg) => arg.startsWith("--save-run="))] = `--save-run=${path.join(runDir, "run.json")}`;
  args.push("--verify", "npm test");
  return { ...command, args, env: { ...command.env,
    BANTAM_CODEX_COMMAND: LAUNCHER, BANTAM_CODEX_THREAD_MODE: "run", BANTAM_CODEX_PROMPT_MODE: "delta",
    BANTAM_SHELL_SANDBOX: "docker", BANTAM_SHELL_NETWORK: "0",
  } };
}

function copyCandidate(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: (file) => {
    const rel = path.relative(source, file);
    return !rel.split(path.sep).some((part) => OMIT.has(part) || part.startsWith(".bantam"));
  } });
}

function cleanEnv(workspace, additions = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("BANTAM_") && !key.startsWith("ASTRA_CONTAINER_") && !["NODE_TEST_CONTEXT", "NODE_OPTIONS", "OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key)));
  return { ...env, PWD: workspace, ...additions };
}

export async function execute(command, { cwd, env, dir, timeoutMs, events, arm }) {
  const startedAt = new Date().toISOString(), start = Date.now();
  const streams = { stdout: "", stderr: "" };
  const cidDir = path.join(dir, "container-receipts");
  fs.mkdirSync(cidDir, { mode: 0o700 });
  let result;
  try {
  result = await runProcess(command.exe, command.args, {
    cwd, env: { ...env, ASTRA_CONTAINER_CID_DIR: cidDir, ASTRA_CONTAINER_TIMEOUT_SECONDS: String(Math.ceil(timeoutMs / 1000)) },
    timeoutMs, maxBuffer: 32 * 1024 * 1024,
    onOutput: ({ stream, text }) => {
      fs.appendFileSync(path.join(dir, `${stream}.log`), text);
      streams[stream] += text;
      const lines = streams[stream].split("\n"); streams[stream] = lines.pop();
      for (const line of lines) if (line.trim()) {
        const event = { arm, kind: "line", text: line.slice(0, 8000), t: Date.now() - start };
        events.push(event);
        fs.appendFileSync(path.join(path.dirname(dir), "events.ndjson"), JSON.stringify(event) + "\n");
      }
    },
  });
  } finally {
    // SIGKILLing a Docker client does not kill its daemon-owned container.
    // Only IDs produced in this invocation's dedicated receipt directory can
    // be stopped; no name globs, shared containers or broad cleanup.
    for (const file of fs.readdirSync(cidDir)) {
      if (!/^astra-codex-[a-z0-9-]+\.cid$/.test(file)) continue;
      const id = fs.readFileSync(path.join(cidDir, file), "utf8").trim();
      if (/^[a-f0-9]{64}$/.test(id)) {
        const stopped = await runProcess("docker", ["stop", "--time", "1", id], { timeoutMs: 5000 });
        if (stopped.code !== 0 && !/No such container/i.test(stopped.stderr)) {
          throw new Error(`Cannot confirm isolated model container stopped: ${id}`);
        }
      }
    }
  }
  return { ...result, startedAt, wallMs: Date.now() - start };
}

export async function runCards(outputRoot, { timeoutMs = 480_000, reuseFirstPair = null } = {}) {
  if (fs.existsSync(outputRoot)) throw new Error(`Refusing to overwrite evidence: ${outputRoot}`);
  if (!fs.existsSync(LAUNCHER)) throw new Error("Astra confined CLI launcher is missing");
  const kitSeal = treeHashes(KIT);
  const sourceSeal = Object.fromEntries(["src", "bin", "scripts"].flatMap((part) =>
    Object.entries(treeHashes(path.join(ROOT, part))).map(([file, hash]) => [`${part}/${file}`, hash])));
  let prior = null;
  if (reuseFirstPair) {
    const old = JSON.parse(fs.readFileSync(path.join(reuseFirstPair, "manifest.json"), "utf8"));
    if (old.stages.length !== 1 || old.stages[0].results.length !== 2 || !old.finishedAt) throw new Error("only a completed first pair can be reused");
    if (JSON.stringify(old.kitSeal) !== JSON.stringify(kitSeal)) throw new Error("prior test kit differs");
    const differences = changedSealedFiles(old.sourceSeal, ROOT);
    if (differences.some((file) => !["src/fight.js", "scripts/repobrief-astra-fights.mjs"].includes(file))) throw new Error("prior production harness differs");
    prior = { directory: path.resolve(reuseFirstPair), manifestSha256: sha(fs.readFileSync(path.join(reuseFirstPair, "manifest.json"))),
      sourceDifferences: differences, stage: old.stages[0],
      note: "Original first-pair evidence retained unchanged. Regrade only the saved completion field (reachedDone, not done). No candidate or grader changes and no repeated model calls. Local 27B added afterward at user request." };
  }
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const manifest = {
    schema: "bantam.repobrief-astra-cards.v1", startedAt: new Date().toISOString(),
    model: "gpt-6-astra", effort: "medium", localEndpoint: "http://127.0.0.1:8085", localProfile: "qwen", timeoutMs, maxBantamTurns: 60,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    kitSeal, sourceSeal, arms: ARMS, priorEvidence: prior,
    design: "One sample per arm per card. Alternate order; fresh sessions and identical starting bytes at each card. Card 2/3 start from previous passing BANTAM product plus new public tests; native candidates are preserved but not carried forward. No manual candidate edits. This measures feature additions on a shared BANTAM-built codebase, not two independent end-to-end trajectories.",
    isolation: "Native and constrained Codex transport use a clean Docker CLI runtime; BANTAM executes project shell actions through its Docker sandbox. Graders run after model exit in a separate no-network Docker container with read-only candidate and kit, without account credentials.",
    stages: [],
  };
  writeJson(path.join(outputRoot, "manifest.json"), manifest);
  let baseline = path.join(KIT, "starter");
  const cards = [];
  for (const stage of [1, 2, 3]) {
    const task = fs.readFileSync(path.join(KIT, "cards", CARD_FILES[stage - 1]), "utf8");
    const stageDir = path.join(outputRoot, `card-${stage}`);
    fs.mkdirSync(stageDir);
    const materials = path.join(stageDir, "materials"); copyCandidate(baseline, materials);
    if (stage > 1) fs.cpSync(path.join(KIT, "stage-tests", `stage-${stage}`), path.join(materials, "test"), { recursive: true });
    const materialSeal = treeHashes(materials);
    const protectedTests = Object.fromEntries(Object.entries(materialSeal).filter(([name]) => name.startsWith("test/") || name === "package.json"));
    const record = { stage, taskSha256: sha(task), materialSeal, order: cardOrder(stage), results: [] };
    manifest.stages.push(record); writeJson(path.join(outputRoot, "manifest.json"), manifest);
    const post = { task, startedAt: new Date().toISOString(), build: `${manifest.baseCommit.slice(0, 7)} + sealed Astra additions`, corners: [], verdicts: {} };
    const events = stage === 1 && prior ? fs.readFileSync(path.join(prior.directory, "card-1/events.ndjson"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    if (events.length) fs.writeFileSync(path.join(stageDir, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const arm of record.order) {
      if (changedSealedFiles(sourceSeal, ROOT).length || changedSealedFiles(kitSeal, KIT).length) {
        throw new Error("Source or test kit changed after sealing; refusing to continue the comparison");
      }
      const runDir = path.join(stageDir, arm), workspace = path.join(runDir, "ws");
      const reuse = stage === 1 && prior?.stage.results.find((r) => r.arm === arm);
      if (reuse) {
        if (prior.stage.taskSha256 !== sha(task) || JSON.stringify(prior.stage.materialSeal) !== JSON.stringify(materialSeal)) throw new Error("prior task/material differs");
        const oldDir = path.join(prior.directory, "card-1", arm);
        if (JSON.stringify(treeHashes(path.join(oldDir, "ws"), { excludeGenerated: true })) !== JSON.stringify(reuse.finalFiles)) throw new Error("prior candidate changed");
        if (!reuse.candidatePass || reuse.exitCode !== 0 || reuse.timedOut || reuse.bufferExceeded || reuse.graderTimedOut || reuse.tampered.length) throw new Error("prior candidate did not pass unchanged checks");
        fs.cpSync(oldDir, runDir, { recursive: true, dereference: false });
        const acceptedCompletion = arm.startsWith("bantam") ? acceptedBantamCompletion(await readJsonFile(path.join(runDir, "run.json"))) : null;
        const summary = { ...reuse, acceptedCompletion, pass: acceptedCompletion !== false, importedFrom: oldDir,
          originalResultSha256: sha(fs.readFileSync(path.join(oldDir, "result.json"))) };
        writeJson(path.join(runDir, "result.json"), summary);
        record.results.push(summary);
        post.corners.push({ ...summary, artifacts: listArtifacts(workspace, 0, { materialsDir: materials }) });
        post.verdicts[arm] = { outcome: summary.pass ? "WIN" : "FAIL", reason: "Preserved first-pair candidate and grader; completion read from serialized reachedDone field" };
        writeJson(path.join(outputRoot, "manifest.json"), manifest);
        process.stdout.write(`Card 1: ${arm} ${summary.pass ? "PASS" : "FAIL"} (preserved ${(summary.wallMs / 1000).toFixed(1)}s run; no rerun)\n`);
        continue;
      }
      fs.mkdirSync(runDir); copyCandidate(materials, workspace);
      if (JSON.stringify(treeHashes(workspace)) !== JSON.stringify(materialSeal)) throw new Error("Starter copy mismatch");
      const command = cardCommand(arm, task, workspace, runDir);
      fs.writeFileSync(path.join(runDir, "task.md"), task);
      writeJson(path.join(runDir, "command.json"), { exe: command.exe, args: command.args, overrides: command.env ?? {} });
      process.stdout.write(`Card ${stage}/3: ${arm} started\n`);
      const result = await execute(command, { cwd: workspace, env: cleanEnv(workspace, command.env), dir: runDir, timeoutMs, events, arm });
      const tampered = changedSealedFiles(protectedTests, workspace);
      const grader = await gradeCandidate(workspace, stage, kitSeal);
      fs.writeFileSync(path.join(runDir, "grade.stdout.log"), grader.stdout);
      fs.writeFileSync(path.join(runDir, "grade.stderr.log"), grader.stderr);
      let saved = null;
      if (arm.startsWith("bantam")) {
        try { saved = await readJsonFile(path.join(runDir, "run.json")); } catch { /* missing evidence stays unaccepted */ }
      }
      const usage = cornerUsage(arm, { armDir: runDir, run: saved, rawLines: result.stdout.split("\n") });
      const acceptedCompletion = arm.startsWith("bantam") ? acceptedBantamCompletion(saved) : null;
      const candidatePass = tampered.length === 0 && grader.code === 0 && !grader.timedOut && !grader.bufferExceeded && !grader.aborted;
      const pass = candidatePass && result.code === 0 && !result.timedOut && !result.bufferExceeded && !result.aborted && acceptedCompletion !== false;
      const summary = { arm, pass, exitCode: result.code, timedOut: result.timedOut, bufferExceeded: result.bufferExceeded,
        candidatePass, acceptedCompletion,
        wallMs: result.wallMs, startedAt: result.startedAt, tampered, graderExitCode: grader.code, graderTimedOut: grader.timedOut,
        usage, finalFiles: treeHashes(workspace, { excludeGenerated: true }) };
      writeJson(path.join(runDir, "result.json"), summary);
      record.results.push(summary);
      post.corners.push({ ...summary, artifacts: listArtifacts(workspace, 0, { materialsDir: materials }) });
      post.verdicts[arm] = { outcome: pass ? "WIN" : (result.timedOut ? "TIMEOUT" : "FAIL"), reason: `Independent cumulative grader exit ${grader.code}; protected-test changes ${tampered.length}` };
      writeJson(path.join(stageDir, "fight.json"), post);
      writeJson(path.join(outputRoot, "manifest.json"), manifest);
      process.stdout.write(`Card ${stage}: ${arm} ${pass ? "PASS" : "FAIL"} (${(result.wallMs / 1000).toFixed(1)}s)\n`);
    }
    post.finishedAt = new Date().toISOString();
    writeJson(path.join(stageDir, "fight.json"), post);
    writeFightReplay({ fightDir: stageDir, post, no: `RepoBrief ${stage}`, label: `Astra medium · project stage ${stage}` });
    cards.push(replayCardData({ no: stage, post, events }));
    fs.writeFileSync(path.join(outputRoot, "fight-cards.html"), renderReplayHtml({ cards,
      title: "RepoBrief · project fight cards", h1: "RepoBrief · three build stages", eyebrow: "Native Codex Astra versus BANTAM Astra versus local 27B" }));
    if (!record.results.find((r) => r.arm === ARMS[0])?.pass) {
      manifest.stopped = `BANTAM card ${stage} did not pass; no unreported manual repair or baseline substitution.`;
      break;
    }
    baseline = path.join(stageDir, ARMS[0], "ws");
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.sourceMismatches = changedSealedFiles(sourceSeal, ROOT);
  manifest.kitMismatches = changedSealedFiles(kitSeal, KIT);
  manifest.complete = manifest.stages.length === 3 && manifest.stages.every((s) => s.results.length === ARMS.length);
  manifest.allPassed = manifest.complete && manifest.stages.every((s) => s.results.every((r) => r.pass)) && !manifest.sourceMismatches.length && !manifest.kitMismatches.length;
  writeJson(path.join(outputRoot, "manifest.json"), manifest);
  process.stdout.write(`Evidence: ${outputRoot}\nComplete=${manifest.complete} allPassed=${manifest.allPassed}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out || !path.isAbsolute(out)) throw new Error("Usage: node scripts/repobrief-astra-fights.mjs ABSOLUTE_NEW_EVIDENCE_DIRECTORY");
  const reuseIndex = process.argv.indexOf("--reuse-first-pair");
  const result = await runCards(out, { reuseFirstPair: reuseIndex >= 0 ? process.argv[reuseIndex + 1] : null });
  if (!result.allPassed) process.exitCode = 1;
}
