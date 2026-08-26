#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "comparison", "codex-inside-outside-2026-08-08");
const outputRoot = path.resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const model = "gpt-5.6-terra";
const effort = "medium";
const timeoutMs = 15 * 60 * 1000;

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
  "bantam-codex": {
    command: "node",
    args(task, workspace, runDir) {
      return [
        path.join(ROOT, "bin", "bantam.js"),
        "exec",
        "--json",
        "--workspace", workspace,
        "--max-turns", String(task.maxTurns),
        "--verify", task.verify,
        "--codex",
        "--model", model,
        "--codex-effort", effort,
        task.prompt,
      ];
    },
  },
  "codex-cli": {
    command: "codex",
    args(task) {
      return [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--model", model,
        "-c", `model_reasoning_effort="${effort}"`,
        "-c", "web_search=\"disabled\"",
        "--sandbox", "danger-full-access",
        "--json",
        task.prompt,
      ];
    },
  },
};

if (fs.existsSync(outputRoot)) {
  throw new Error(`refusing to overwrite existing benchmark evidence: ${outputRoot}`);
}

fs.mkdirSync(outputRoot, { recursive: true });
const manifest = {
  schema: "bantam.codex-inside-outside-benchmark.v1",
  startedAt: new Date().toISOString(),
  model,
  effort,
  samplesPerCell: 1,
  taskSource: "scripts/benchmark-runner.mjs tasks 1-5",
  taskSourceCommit: gitHead(),
  arms: {
    "bantam-codex": "Codex app-server model constrained behind the BANTAM action harness",
    "codex-cli": "standalone codex exec with native Codex tools",
  },
  order: [],
  tasks: tasks.map((task) => ({
    ...task,
    promptSha256: sha256(task.prompt),
  })),
};
writeJson(path.join(outputRoot, "manifest.json"), manifest);

const results = [];
for (const task of tasks) {
  const order = task.id % 2 === 1
    ? ["bantam-codex", "codex-cli"]
    : ["codex-cli", "bantam-codex"];
  manifest.order.push({ taskId: task.id, arms: order });
  writeJson(path.join(outputRoot, "manifest.json"), manifest);

  for (const arm of order) {
    const runDir = path.join(outputRoot, "runs", `task-${task.id}-${task.slug}`, arm);
    fs.mkdirSync(runDir, { recursive: true });
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-codex-benchmark-t${task.id}-${arm}-`));
    const workspace = path.join(temporaryRoot, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(runDir, "prompt.txt"), `${task.prompt}\n`);

    process.stdout.write(`\n[${task.id}/5] ${arm} · ${task.slug}\n`);
    const spec = arms[arm];
    const run = await runCommand(spec.command, spec.args(task, workspace, runDir), {
      cwd: arm === "codex-cli" ? workspace : ROOT,
      timeoutMs,
    });

    fs.writeFileSync(path.join(runDir, "stdout.jsonl"), run.stdout);
    fs.writeFileSync(path.join(runDir, "stderr.log"), run.stderr);

    const verification = await runCommand("bash", ["-lc", task.verify], {
      cwd: workspace,
      timeoutMs: 60_000,
    });
    fs.writeFileSync(path.join(runDir, "verification.stdout.log"), verification.stdout);
    fs.writeFileSync(path.join(runDir, "verification.stderr.log"), verification.stderr);

    const metrics = arm === "bantam-codex"
      ? parseBantam(run.stdout)
      : parseCodex(run.stdout);
    const workspaceState = snapshotWorkspace(workspace);
    fs.cpSync(workspace, path.join(runDir, "workspace"), { recursive: true });
    const result = {
      taskId: task.id,
      task: task.slug,
      promptSha256: sha256(task.prompt),
      arm,
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
      + ` wall=${(run.durationMs / 1000).toFixed(1)}s`
      + ` in=${metrics.inputTokens ?? "?"}`
      + ` cache=${metrics.cachedInputTokens ?? "?"}`
      + ` out=${metrics.outputTokens ?? "?"}\n`,
    );
  }
}

manifest.completedAt = new Date().toISOString();
writeJson(path.join(outputRoot, "manifest.json"), manifest);
writeJson(path.join(outputRoot, "results.json"), results);
fs.rmSync(path.join(outputRoot, "results.partial.json"));
process.stdout.write(`\nEvidence written to ${outputRoot}\n`);

function parseBantam(stdout) {
  const rows = jsonLines(stdout);
  const final = [...rows].reverse().find((row) => row && Number.isFinite(row.turns));
  const events = rows.filter((row) => row?.type === "event");
  const tokens = final?.tokens ?? {};
  const cacheHit = number(tokens.cacheHit);
  const cacheMiss = number(tokens.cacheMiss);
  const input = number(tokens.input) || cacheHit + cacheMiss;
  return {
    source: "bantam exec --json events and terminal usage result",
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
    actionCounts: countBy(events, (event) => event.action ?? event.name ?? event.event ?? "event"),
  };
}

function parseCodex(stdout) {
  const rows = jsonLines(stdout);
  const completed = [...rows].reverse().find((row) => row?.type === "turn.completed");
  const usage = completed?.usage ?? {};
  const input = number(usage.input_tokens);
  const cached = number(usage.cached_input_tokens);
  const items = rows.filter((row) => row?.type === "item.completed").map((row) => row.item).filter(Boolean);
  return {
    source: "codex exec --json turn.completed usage",
    turns: rows.filter((row) => row?.type === "turn.started").length,
    modelRequests: null,
    inputTokens: input,
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, input - cached),
    outputTokens: number(usage.output_tokens),
    reasoningOutputTokens: number(usage.reasoning_output_tokens),
    totalTokens: input + number(usage.output_tokens),
    cacheHitRate: input > 0 ? cached / input : null,
    status: completed ? "completed" : rows.some((row) => row?.type === "turn.failed") ? "failed" : "unknown",
    harnessPass: null,
    eventCount: rows.length,
    actionCounts: countBy(items, (item) => item.type ?? "item"),
    threadId: rows.find((row) => row?.type === "thread.started")?.thread_id ?? null,
  };
}

function jsonLines(text) {
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const start = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
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
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs,
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

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = String(keyOf(value));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
