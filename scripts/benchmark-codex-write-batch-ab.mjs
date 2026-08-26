#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "comparison", "codex-write-batch-ab-2026-08-08");
const outputRoot = path.resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const model = "gpt-5.6-terra";
const effort = "medium";
const timeoutMs = 15 * 60 * 1000;

// Exact task/prompt/verifier cells from the already-recorded Hermes/BANTAM and
// Codex-inside/outside comparisons. Do not improve the wording between arms.
const tasks = [
  {
    id: 1,
    slug: "fibonacci",
    maxTurns: 15,
    verify: "node test-fib.js",
    prompt: "Create a file fib.js that exports a memoized fibonacci(n) function handling n>=0. Also create test-fib.js that imports it and uses console.assert to verify: fib(0)===0, fib(1)===1, fib(10)===55, fib(20)===6765. Run the test with node and it must pass.",
  },
  {
    id: 2,
    slug: "rest-api",
    maxTurns: 30,
    verify: "node test-api.js",
    prompt: "Create a REST API using only Node.js built-in http module. Files: middleware.js (exports a logging middleware and a JSON parsing middleware), server.js (GET /users returns [{id:1,name:'Alice'}], POST /users accepts JSON body and returns 201, GET /users/:id returns the user or 404). Create test-api.js using http module that tests all three endpoints. Run tests with node test-api.js and all assertions must pass.",
  },
  {
    id: 3,
    slug: "ttl-cache",
    maxTurns: 25,
    verify: "node test-ttl-cache.js",
    prompt: "Create a TTL cache implementation in ttl-cache.js that exports a class with set(key, value, ttlMs), get(key), delete(key), and clear() methods. The cache should automatically expire entries. Create test-ttl-cache.js that tests: basic get/set, expiration (use setTimeout to wait), delete, clear, and default TTL. Run with node test-ttl-cache.js.",
  },
  {
    id: 4,
    slug: "event-queue",
    maxTurns: 40,
    verify: "node test-task-queue.js",
    prompt: "Build an in-memory task queue in task-queue.js using Node.js EventEmitter. The queue should support: addTask(name, priority=0, maxRetries=3), processNext(), and emit 'completed', 'failed', 'retried' events. Tasks are async functions. Higher priority numbers are processed first. Failed tasks retry up to maxRetries times. Create test-task-queue.js with at least 6 test cases covering: basic add/process, priority ordering, retry on failure, event emission, queue empty behavior, and max retries exhausted. Run with node test-task-queue.js.",
  },
  {
    id: 5,
    slug: "config-merger",
    maxTurns: 40,
    verify: "node test-config-merge.js",
    prompt: "Create a JSON config merger in config-merge.js. It should export mergeConfigs(base, ...overrides) that deeply merges objects. Rules: later values override earlier ones, arrays are concatenated (not replaced), nested objects merge recursively. Also export mergeWithStrategy(base, override, strategy) where strategy can be 'replace' (arrays replaced), 'concat' (arrays concatenated), or 'union' (arrays deduplicated by primitive values). Create test-config-merge.js with at least 10 test cases. Run with node test-config-merge.js.",
  },
];

const arms = {
  "legacy-writes": {
    description: "BANTAM+Codex with the existing one-file write surface; write_batch is absent",
    extraArgs: [],
  },
  "atomic-write-batch": {
    description: "BANTAM+Codex with the opt-in atomic 1-8 whole-file write_batch surface",
    extraArgs: ["--write-batch"],
  },
};

if (fs.existsSync(outputRoot)) {
  throw new Error(`refusing to overwrite existing benchmark evidence: ${outputRoot}`);
}
if (gitDirty()) {
  throw new Error("refusing to benchmark a dirty worktree; commit the harness and runner first");
}

fs.mkdirSync(outputRoot, { recursive: true });
const manifest = {
  schema: "bantam.codex-write-batch-ab.v1",
  startedAt: new Date().toISOString(),
  sourceCommit: gitHead(),
  model,
  effort,
  samplesPerCell: 1,
  capture: "BANTAM_SAVE_PROMPTS=1: exact assembled prompts, raw model actions, reasoning text, and per-call usage",
  invariant: "same source commit, model, effort, task prompt, verifier, max turns, sandbox, and fresh empty workspace; only write_batch exposure changes",
  arms: Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, arm.description])),
  order: [],
  tasks: tasks.map((task) => ({ ...task, promptSha256: sha256(task.prompt) })),
};
writeJson(path.join(outputRoot, "manifest.json"), manifest);

const results = [];
for (const task of tasks) {
  // Alternate first-run position to reduce systematic warm/load ordering bias.
  const order = task.id % 2 === 1
    ? ["legacy-writes", "atomic-write-batch"]
    : ["atomic-write-batch", "legacy-writes"];
  manifest.order.push({ taskId: task.id, arms: order });
  writeJson(path.join(outputRoot, "manifest.json"), manifest);

  for (const armName of order) {
    const arm = arms[armName];
    const runDir = path.join(outputRoot, "runs", `task-${task.id}-${task.slug}`, armName);
    fs.mkdirSync(runDir, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-write-batch-t${task.id}-${armName}-`));
    const workspace = path.join(temporaryRoot, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(runDir, "prompt.txt"), `${task.prompt}\n`);

    const args = [
      path.join(ROOT, "bin", "bantam.js"),
      "exec",
      "--json",
      "--workspace", workspace,
      "--max-turns", String(task.maxTurns),
      "--verify", task.verify,
      "--codex",
      "--model", model,
      "--codex-effort", effort,
      ...arm.extraArgs,
      task.prompt,
    ];
    writeJson(path.join(runDir, "invocation.json"), {
      command: "node",
      args,
      cwd: ROOT,
      environment: { BANTAM_SAVE_PROMPTS: "1", NO_COLOR: "1" },
    });

    process.stdout.write(`\n[${task.id}/5] ${armName} · ${task.slug}\n`);
    const run = await runCommand("node", args, { cwd: ROOT, timeoutMs });
    fs.writeFileSync(path.join(runDir, "stdout.jsonl"), run.stdout);
    fs.writeFileSync(path.join(runDir, "stderr.txt"), run.stderr);

    const verification = await runCommand("bash", ["-lc", task.verify], {
      cwd: workspace,
      timeoutMs: 60_000,
    });
    fs.writeFileSync(path.join(runDir, "verification.stdout.txt"), verification.stdout);
    fs.writeFileSync(path.join(runDir, "verification.stderr.txt"), verification.stderr);

    const metrics = parseBantam(run.stdout);
    const workspaceState = snapshotWorkspace(workspace);
    fs.cpSync(workspace, path.join(runDir, "workspace"), { recursive: true });
    const result = {
      taskId: task.id,
      task: task.slug,
      promptSha256: sha256(task.prompt),
      arm: armName,
      writeBatchExposed: armName === "atomic-write-batch",
      model,
      effort,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      wallClockMs: run.durationMs,
      processExitCode: run.code,
      timedOut: run.timedOut,
      verification: {
        command: task.verify,
        pass: verification.code === 0 && !verification.timedOut,
        exitCode: verification.code,
        durationMs: verification.durationMs,
      },
      metrics,
      workspace: workspaceState,
    };
    results.push(result);
    writeJson(path.join(runDir, "result.json"), result);
    writeJson(path.join(outputRoot, "results.partial.json"), results);
    fs.rmSync(temporaryRoot, { recursive: true });

    process.stdout.write(
      `  exit=${run.code} verify=${result.verification.pass ? "PASS" : "FAIL"}`
      + ` wall=${(run.durationMs / 1000).toFixed(1)}s turns=${metrics.turns}`
      + ` batch=${metrics.actionCounts.write_batch ?? 0}`
      + ` in=${metrics.inputTokens} cache=${metrics.cachedInputTokens}`
      + ` miss=${metrics.uncachedInputTokens} out=${metrics.outputTokens}\n`,
    );
  }
}

manifest.completedAt = new Date().toISOString();
writeJson(path.join(outputRoot, "manifest.json"), manifest);
writeJson(path.join(outputRoot, "results.json"), results);
writeJson(path.join(outputRoot, "summary.json"), summarize(results));
fs.rmSync(path.join(outputRoot, "results.partial.json"));
process.stdout.write(`\nEvidence written to ${outputRoot}\n`);

function parseBantam(stdout) {
  const rows = jsonLines(stdout);
  const final = [...rows].reverse().find((row) => row?.type === "result");
  const events = rows.filter((row) => row?.type === "event");
  const usageRow = [...rows].reverse().find((row) => row?.type === "model_usage");
  const tokens = final?.tokens ?? {};
  const cacheHit = number(tokens.cacheHit);
  const cacheMiss = number(tokens.cacheMiss);
  const input = number(tokens.input) || cacheHit + cacheMiss;
  const prompts = events.map((event) => event.prompt).filter((value) => typeof value === "string");
  const rawOutputs = events.map((event) => event.rawOutput).filter((value) => typeof value === "string");
  const reasoning = events.map((event) => event.reasoning).filter((value) => typeof value === "string");
  const actionEvents = events.filter((event) => event.event === "action");
  return {
    source: "bantam exec --json with BANTAM_SAVE_PROMPTS=1",
    turns: number(final?.turns),
    modelRequests: number(final?.requests),
    inputTokens: input,
    cachedInputTokens: cacheHit,
    uncachedInputTokens: cacheMiss || Math.max(0, input - cacheHit),
    outputTokens: number(tokens.output),
    reasoningOutputTokens: number(tokens.reasoning),
    totalTokens: number(tokens.total) || input + number(tokens.output),
    cacheHitRate: input > 0 ? cacheHit / input : null,
    status: final?.status ?? null,
    harnessPass: final?.pass ?? null,
    eventCount: events.length,
    eventCounts: countBy(events, (event) => event.event ?? "event"),
    actionCounts: countBy(actionEvents, (event) => event.action ?? "unknown"),
    batchManifests: events.filter((event) => event.event === "write_batch_manifest").map((event) => event.files ?? []),
    batchCommits: events.filter((event) => event.event === "write_batch_committed").map((event) => event.files ?? []),
    capturedPromptCount: prompts.length,
    deliveredPromptChars: prompts.reduce((sum, prompt) => sum + prompt.length, 0),
    promptSha256: prompts.map(sha256),
    rawOutputChars: rawOutputs.reduce((sum, output) => sum + output.length, 0),
    reasoningChars: reasoning.reduce((sum, output) => sum + output.length, 0),
    perCallUsage: Array.isArray(usageRow?.calls) ? usageRow.calls : [],
  };
}

function summarize(rows) {
  const totals = {};
  for (const arm of Object.keys(arms)) {
    const selected = rows.filter((row) => row.arm === arm);
    totals[arm] = {
      tasks: selected.length,
      passed: selected.filter((row) => row.verification.pass).length,
      harnessPassed: selected.filter((row) => row.metrics.harnessPass).length,
      wallClockMs: sum(selected, (row) => row.wallClockMs),
      turns: sum(selected, (row) => row.metrics.turns),
      modelRequests: sum(selected, (row) => row.metrics.modelRequests),
      inputTokens: sum(selected, (row) => row.metrics.inputTokens),
      cachedInputTokens: sum(selected, (row) => row.metrics.cachedInputTokens),
      uncachedInputTokens: sum(selected, (row) => row.metrics.uncachedInputTokens),
      outputTokens: sum(selected, (row) => row.metrics.outputTokens),
      reasoningOutputTokens: sum(selected, (row) => row.metrics.reasoningOutputTokens),
      deliveredPromptChars: sum(selected, (row) => row.metrics.deliveredPromptChars),
      writeFileActions: sum(selected, (row) => row.metrics.actionCounts.write_file ?? 0),
      writeBatchActions: sum(selected, (row) => row.metrics.actionCounts.write_batch ?? 0),
      shellActions: sum(selected, (row) => row.metrics.actionCounts.shell ?? 0),
    };
    totals[arm].cacheHitRate = totals[arm].inputTokens > 0
      ? totals[arm].cachedInputTokens / totals[arm].inputTokens
      : null;
  }
  const base = totals["legacy-writes"];
  const candidate = totals["atomic-write-batch"];
  const delta = {};
  for (const key of [
    "passed", "harnessPassed", "wallClockMs", "turns", "modelRequests",
    "inputTokens", "cachedInputTokens", "uncachedInputTokens", "outputTokens",
    "reasoningOutputTokens", "deliveredPromptChars", "writeFileActions",
    "writeBatchActions", "shellActions",
  ]) delta[key] = candidate[key] - base[key];
  return {
    generatedAt: new Date().toISOString(),
    totals,
    deltaAtomicMinusLegacy: delta,
    perTask: tasks.map((task) => Object.fromEntries(
      rows.filter((row) => row.taskId === task.id).map((row) => [row.arm, {
        pass: row.verification.pass,
        wallClockMs: row.wallClockMs,
        turns: row.metrics.turns,
        modelRequests: row.metrics.modelRequests,
        inputTokens: row.metrics.inputTokens,
        cachedInputTokens: row.metrics.cachedInputTokens,
        uncachedInputTokens: row.metrics.uncachedInputTokens,
        outputTokens: row.metrics.outputTokens,
        reasoningOutputTokens: row.metrics.reasoningOutputTokens,
        actions: row.metrics.actionCounts,
      }]),
    )),
  };
}

function runCommand(command, args, { cwd, timeoutMs: limit }) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const start = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", BANTAM_SAVE_PROMPTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, limit);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    });
  });
}

function snapshotWorkspace(directory) {
  const files = [];
  walk(directory, directory, files);
  return { fileCount: files.length, files };
}

function walk(root, current, files) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, files);
    else if (entry.isFile()) {
      const body = fs.readFileSync(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: body.length,
        sha256: sha256(body),
      });
    }
  }
}

function jsonLines(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = String(keyOf(value));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sum(values, read) {
  return values.reduce((total, value) => total + number(read(value)), 0);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function gitDirty() {
  return execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
}
