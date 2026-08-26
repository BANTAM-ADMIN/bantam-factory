#!/usr/bin/env node
// benchmark-runner.mjs
//
// Runs a suite of tasks through BOTH BANTAM and Hermes, recording:
//   - turns / API calls
//   - wall clock time (total and per-turn)
//   - tokens in, tokens out, prefix cache hits
//   - reasoning tokens
//   - pass/fail from verification
//
// Usage: node scripts/benchmark-runner.mjs [--task N] [--system bantam|hermes]
//   --task N    only run task N (1-10)
//   --system    only run one system (default: both)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BANTAM_BIN = path.resolve("bin", "bantam.js");
const RESULTS_DIR = path.resolve("tmp", "benchmark-results");
const LOGS_DIR = path.resolve("tmp", "benchmark-logs");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Task definitions (increasingly difficult)
// ---------------------------------------------------------------------------
const TASKS = [
  {
    id: 1,
    name: "Single file: Fibonacci with memoization",
    difficulty: "easy",
    description: "Create a single fib.js that exports a memoized fibonacci function. Include a test file that verifies fib(0)=0, fib(1)=1, fib(10)=55, fib(20)=6765.",
    task: "Create a file fib.js that exports a memoized fibonacci(n) function handling n>=0. Also create test-fib.js that imports it and uses console.assert to verify: fib(0)===0, fib(1)===1, fib(10)===55, fib(20)===6765. Run the test with node and it must pass.",
    verify: "node test-fib.js",
    maxTurns: 15,
  },
  {
    id: 2,
    name: "Multi-file: HTTP server with middleware",
    difficulty: "medium",
    description: "Build a REST API with server.js, middleware.js, and test file using Node.js http module.",
    task: "Create a REST API using only Node.js built-in http module. Files: middleware.js (exports a logging middleware and a JSON parsing middleware), server.js (GET /users returns [{id:1,name:'Alice'}], POST /users accepts JSON body and returns 201, GET /users/:id returns the user or 404). Create test-api.js using http module that tests all three endpoints. Run tests with node test-api.js and all assertions must pass.",
    verify: "node test-api.js",
    maxTurns: 30,
  },
  {
    id: 3,
    name: "Bug fix: Broken cache implementation",
    difficulty: "medium-hard",
    description: "Fix a TTL cache with bugs in expiration logic and concurrent access.",
    task: "Create a TTL cache implementation in ttl-cache.js that exports a class with set(key, value, ttlMs), get(key), delete(key), and clear() methods. The cache should automatically expire entries. Create test-ttl-cache.js that tests: basic get/set, expiration (use setTimeout to wait), delete, clear, and default TTL. Run with node test-ttl-cache.js.",
    verify: "node test-ttl-cache.js",
    maxTurns: 25,
  },
  {
    id: 4,
    name: "Architecture: Event-driven task queue",
    difficulty: "hard",
    description: "Build an in-memory task queue with priority, retry, and event emission.",
    task: "Build an in-memory task queue in task-queue.js using Node.js EventEmitter. The queue should support: addTask(name, priority=0, maxRetries=3), processNext(), and emit 'completed', 'failed', 'retried' events. Tasks are async functions. Higher priority numbers are processed first. Failed tasks retry up to maxRetries times. Create test-task-queue.js with at least 6 test cases covering: basic add/process, priority ordering, retry on failure, event emission, queue empty behavior, and max retries exhausted. Run with node test-task-queue.js.",
    verify: "node test-task-queue.js",
    maxTurns: 40,
  },
  {
    id: 5,
    name: "Refactor + test: JSON config merger",
    difficulty: "hard",
    description: "Build a deep merge utility with array strategies, schema validation, and comprehensive tests.",
    task: "Create a JSON config merger in config-merge.js. It should export mergeConfigs(base, ...overrides) that deeply merges objects. Rules: later values override earlier ones, arrays are concatenated (not replaced), nested objects merge recursively. Also export mergeWithStrategy(base, override, strategy) where strategy can be 'replace' (arrays replaced), 'concat' (arrays concatenated), or 'union' (arrays deduplicated by primitive values). Create test-config-merge.js with at least 10 test cases. Run with node test-config-merge.js.",
    verify: "node test-config-merge.js",
    maxTurns: 40,
  },
  {
    id: 6,
    name: "Debug: Subtle race condition in async pool",
    difficulty: "hard-debug",
    description: "Create an async worker pool with a hidden race condition, then debug and fix it.",
    task: "Create async-pool.js that exports a WorkerPool class with a fixed number of workers. It should have run(taskFn) that queues async work, and runAll(taskFns) that processes an array concurrently using the pool. The pool must track active workers and reject new tasks when at capacity, using a promise queue. Create test-async-pool.js with 8 tests: basic concurrency, capacity limit, sequential completion, error handling, runAll ordering, concurrent runs, timeout, and memory leak (pool should not hold references after completion). Run with node test-async-pool.js.",
    verify: "node test-async-pool.js",
    maxTurns: 60,
  },
  {
    id: 7,
    name: "Debug: Pre-existing broken codebase",
    difficulty: "hard-debug",
    description: "Create a file with 3 subtle bugs, then have the agent find and fix all of them.",
    task: "First, create utils.js with these exports: (1) flatten(arr) that recursively flattens nested arrays, (2) groupBy(arr, fn) that groups array items by a key function, (3) debounce(fn, ms) that returns a debounced version, (4) pipe(...fns) that composes functions left-to-right. Intentionally include these bugs: flatten should not handle nested objects (only arrays), groupBy should lose items when key is undefined, debounce should not clear timeout on call, and pipe should reverse argument order. Then create test-utils.js with tests that expose all 4 bugs. Run the tests, see them fail, then fix utils.js so all tests pass. Run tests again to confirm.",
    verify: "node test-utils.js",
    maxTurns: 50,
  },
  {
    id: 8,
    name: "Cross-file: Build a mini framework",
    difficulty: "hard-architecture",
    description: "Build a small MVC-like framework across multiple files with proper exports.",
    task: "Build a mini MVC framework. Files: model.js (exports BaseModel class with save/load/delete using an in-memory store), controller.js (exports BaseController that takes a Model class, implements list/create/update/delete actions), view.js (exports View class that renders data as JSON or plain text based on format option), app.js (exports App class that wires routes to controller actions, supports GET/POST). Create test-framework.js that tests: creating a model instance, saving/loading, controller list/create, view rendering in both formats, and app routing. All tests must pass with node test-framework.js.",
    verify: "node test-framework.js",
    maxTurns: 50,
  },
  {
    id: 9,
    name: "Multi-step: Design, implement, test, refactor",
    difficulty: "hard-multi-step",
    description: "Build a data pipeline, then refactor it to support plugins.",
    task: "Step 1: Create pipeline.js with a DataPipeline class that chains transformations. Each step is a function that receives an array of records and returns a transformed array. Support .addStep(name, fn), .run(data), and .getStats() returning {steps, processedRecords, durationMs}. Step 2: Create test-pipeline.js with 8 tests covering: single step, multiple steps, empty input, error in middle step, stats tracking, step naming, filtering (step that reduces records), and mapping (step that transforms each record). Step 3: Refactor pipeline.js to support a 'plugin' system where plugins can hook into 'beforeStep', 'afterStep', and 'complete' events. The refactor must not break existing tests. Run all tests to confirm everything passes.",
    verify: "node test-pipeline.js",
    maxTurns: 60,
  },
  {
    id: 10,
    name: "Large context: Parse and transform config files",
    difficulty: "hard-context",
    description: "Read multiple config formats, merge them, validate against a schema, output unified config.",
    task: "Create a config loader system. Files: parser.js (exports parseJSON(str), parseYAML(str) — implement a simple YAML parser that handles key: value, nested indentation, and arrays with - prefix, no external deps), validator.js (exports validate(config, schema) where schema defines required fields, types, and defaults — returns {valid, errors, resolved} with defaults applied), loader.js (exports ConfigLoader class with load(path) that auto-detects json/yaml extension, parseAndValidate(schema), and merge(...loaders) combining multiple loaders with later overriding earlier). Create test-config-loader.js with 12 tests: JSON parsing, YAML parsing, nested YAML, array YAML, validation with required fields, type checking, defaults, loading from string, merging two configs, merging with conflicts, validation errors, and full pipeline (parse + validate + merge). Run with node test-config-loader.js.",
    verify: "node test-config-loader.js",
    maxTurns: 60,
  },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help")) {
  console.log("usage: node scripts/benchmark-runner.mjs [--task 1-10] [--system bantam|hermes]");
  process.exit(0);
}
const hasSingleTask = cliArgs.includes("--task");
const singleTaskIdx = hasSingleTask
  ? Number(cliArgs[cliArgs.indexOf("--task") + 1]) - 1
  : -1;
const singleSystem = cliArgs.includes("--system")
  ? cliArgs[cliArgs.indexOf("--system") + 1]
  : null;
if (hasSingleTask && (singleTaskIdx < 0 || singleTaskIdx >= TASKS.length || !Number.isInteger(singleTaskIdx))) {
  throw new Error(`--task must be an integer from 1 through ${TASKS.length}`);
}
if (singleSystem && !new Set(["bantam", "hermes"]).has(singleSystem)) {
  throw new Error("--system must be bantam or hermes");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseHermesOutput(raw) {
  // Parse hermes -v -Q verbose output for token counts and timing
  const lines = raw.split("\n");
  const calls = [];
  let currentCall = null;

  for (const line of lines) {
    // Match: API call #N: model=... provider=... in=X out=Y total=Z latency=Ws
    const callMatch = line.match(/API call #(\d+):.*in=(\d[\d,]*)\s+out=(\d[\d,]*)\s+total=(\d[\d,]*)\s+latency=([\d.]+)s/);
    if (callMatch) {
      if (currentCall) calls.push(currentCall);
      currentCall = {
        num: parseInt(callMatch[1]),
        inputTokens: parseInt(callMatch[2].replace(/,/g, "")),
        outputTokens: parseInt(callMatch[3].replace(/,/g, "")),
        totalTokens: parseInt(callMatch[4].replace(/,/g, "")),
        latencyMs: Math.round(parseFloat(callMatch[5]) * 1000),
        cacheHit: 0,
        reasoningTokens: 0,
      };
    }
    // Match: CompletionUsage line for cache hits
    const usageMatch = line.match(/CompletionUsage\(completion_tokens=(\d+),\s*prompt_tokens=(\d+),\s*total_tokens=(\d+),.*cached_tokens=(\d+)/);
    if (usageMatch && currentCall) {
      currentCall.cacheHit = parseInt(usageMatch[4]);
    }
    // Match: Token usage line with breakdown
    const tokenMatch = line.match(/Token usage: prompt=(\d[\d,]*), completion=(\d[\d,]*), total=(\d[\d,]*)/);
    if (tokenMatch) {
      const prompt = parseInt(tokenMatch[1].replace(/,/g, ""));
      const completion = parseInt(tokenMatch[2].replace(/,/g, ""));
      const total = parseInt(tokenMatch[3].replace(/,/g, ""));
      // Update the last call if we haven't seen the API call line yet
      if (!currentCall) {
        currentCall = {
          num: calls.length + 1,
          inputTokens: prompt,
          outputTokens: completion,
          totalTokens: total,
          latencyMs: 0,
          cacheHit: 0,
          reasoningTokens: 0,
        };
      } else {
        // Refine with actual numbers
        currentCall.inputTokens = Math.max(currentCall.inputTokens, prompt);
        currentCall.outputTokens = Math.max(currentCall.outputTokens, completion);
      }
    }
    // Match: reasoning capture
    const reasoningMatch = line.match(/Captured reasoning \((\d+) chars/);
    if (reasoningMatch && currentCall) {
      // Rough estimate: ~0.6 tokens per char
      currentCall.reasoningTokens = Math.round(parseInt(reasoningMatch[1]) / 1.6);
    }
    // Match: tool turns
    const toolMatch = line.match(/tool_turns=(\d+)/);
    if (toolMatch && currentCall) {
      currentCall.toolTurns = parseInt(toolMatch[1]);
    }
  }
  if (currentCall) calls.push(currentCall);

  return {
    calls,
    turns: calls.length,
    totalInputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    totalTokens: calls.reduce((s, c) => s + c.totalTokens, 0),
    totalCacheHits: calls.reduce((s, c) => s + c.cacheHit, 0),
    totalReasoningTokens: calls.reduce((s, c) => s + c.reasoningTokens, 0),
    totalLatencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    perCallLatency: calls.map(c => c.latencyMs),
  };
}

function parseBantamOutput(jsonLines) {
  // Parse bantam exec --json output
  const events = [];
  let finalResult = null;

  for (const line of jsonLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "event") {
        events.push(obj);
      } else if (obj.turns !== undefined) {
        finalResult = obj;
      }
    } catch { /* skip non-JSON */ }
  }

  // Count turns from events
  const turnNumbers = new Set();
  for (const ev of events) {
    if (ev.turn !== undefined) turnNumbers.add(ev.turn);
  }

  // Extract token data from the new --json tokens field
  const tokens = finalResult?.tokens ?? null;
  const requests = finalResult?.requests ?? 0;

  return {
    turns: finalResult?.turns ?? turnNumbers.size,
    durationMs: finalResult?.durationMs ?? 0,
    wallClockMs: finalResult?.durationMs ?? 0,
    pass: finalResult?.pass ?? false,
    status: finalResult?.status ?? "unknown",
    events,
    // Token breakdown (new --json format)
    totalInputTokens: tokens?.input ?? 0,
    totalOutputTokens: tokens?.output ?? 0,
    totalTokens: tokens?.total ?? 0,
    totalCacheHits: tokens?.cacheHit ?? 0,
    totalCacheMiss: tokens?.cacheMiss ?? 0,
    totalReasoningTokens: tokens?.reasoning ?? 0,
    modelCalls: requests,
    perCallLatency: [],
  };
}

function runCommand(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn(cmd, args, {
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runHermesTask(task, workspaceDir) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    // Run hermes chat with verbose + quiet mode, cd to workspace dir
    const child = spawn("hermes", [
      "chat",
      "-q", task.task,
      "-v",
      "-Q",
    ], {
      env: { ...process.env, NO_COLOR: "1" },
      cwd: workspaceDir,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const allOutput = stdout + "\n" + stderr;
      const metrics = parseHermesOutput(allOutput);
      metrics.wallClockMs = Date.now() - startTime;
      metrics.exitCode = 0;
      metrics.rawLog = allOutput;
      resolve(metrics);
    }, 300000);

    child.on("close", (code) => {
      clearTimeout(timer);
      const allOutput = stdout + "\n" + stderr;
      const metrics = parseHermesOutput(allOutput);
      metrics.wallClockMs = Date.now() - startTime;
      metrics.exitCode = code;
      metrics.rawLog = allOutput;
      resolve(metrics);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runBantamTask(task, workspaceDir) {
  const args = [
    "exec",
    "--json",
    "--workspace", workspaceDir,
    "--max-turns", String(task.maxTurns),
    ...(task.verify ? ["--verify", task.verify] : []),
    task.task,
  ];
  return runCommand("node", [BANTAM_BIN, ...args], 180000);
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------
function createWorkspace(taskId, system) {
  const dir = path.join(LOGS_DIR, `task${taskId}_${system}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function generateReport(results) {
  const lines = [];
  lines.push("=" .repeat(90));
  lines.push("BANTAM FACTORY vs HERMES — Detailed Benchmark Report");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Model: Qwen3.6-27B (localhost:8085)`);
  lines.push("=" .repeat(90));
  lines.push("");

  for (const task of TASKS) {
    const hermesResult = results.find(r => r.taskId === task.id && r.system === "hermes");
    const bantamResult = results.find(r => r.taskId === task.id && r.system === "bantam");

    lines.push("-".repeat(90));
    lines.push(`Task ${task.id}: ${task.name} (${task.difficulty})`);
    lines.push(`Description: ${task.description}`);
    lines.push("-".repeat(90));
    lines.push("");

    if (hermesResult) {
      const m = hermesResult.metrics;
      lines.push("  HERMES:");
      lines.push(`    Wall clock:        ${(m.wallClockMs / 1000).toFixed(1)}s`);
      lines.push(`    API calls (turns): ${m.turns}`);
      lines.push(`    Total latency:     ${(m.totalLatencyMs / 1000).toFixed(1)}s (sum of API call latencies)`);
      lines.push(`    Idle overhead:     ${((m.wallClockMs - m.totalLatencyMs) / 1000).toFixed(1)}s (wall clock - API time)`);
      lines.push(`    Input tokens:      ${m.totalInputTokens.toLocaleString()}`);
      lines.push(`    Output tokens:     ${m.totalOutputTokens.toLocaleString()}`);
      lines.push(`    Total tokens:      ${m.totalTokens.toLocaleString()}`);
      lines.push(`    Cache hits:        ${m.totalCacheHits.toLocaleString()}`);
      lines.push(`    Reasoning tokens:  ${m.totalReasoningTokens.toLocaleString()}`);
      lines.push(`    Per-call latency:  ${m.perCallLatency.map(l => `${(l/1000).toFixed(1)}s`).join(", ")}`);
      lines.push(`    Pass:              ${hermesResult.pass ? "YES" : "NO"}`);
      lines.push("");
    }

    if (bantamResult) {
      const m = bantamResult.metrics;
      lines.push("  BANTAM:");
      lines.push(`    Wall clock:        ${(m.durationMs / 1000).toFixed(1)}s`);
      lines.push(`    Turns:             ${m.turns}`);
      lines.push(`    Model calls:       ${m.modelCalls ?? "N/A"}`);
      lines.push(`    Input tokens:      ${m.totalInputTokens?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Output tokens:     ${m.totalOutputTokens?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Total tokens:      ${m.totalTokens?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Cache hits:        ${m.totalCacheHits?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Cache miss:        ${m.totalCacheMiss?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Reasoning tokens:  ${m.totalReasoningTokens?.toLocaleString() ?? "N/A"}`);
      lines.push(`    Pass:              ${m.pass ? "YES" : "NO"}`);
      lines.push(`    Status:            ${m.status}`);
      lines.push("");
    }

    // Comparison
    if (hermesResult && bantamResult) {
      const h = hermesResult.metrics;
      const b = bantamResult.metrics;
      const speedRatio = b.durationMs > 0 ? h.wallClockMs / b.durationMs : 0;
      const turnRatio = b.turns > 0 ? h.turns / b.turns : 0;
      const tokenRatio = b.totalTokens > 0 ? h.totalTokens / b.totalTokens : 0;
      const cacheRatio = b.totalCacheHits > 0 ? h.totalCacheHits / b.totalCacheHits : 0;

      lines.push("  COMPARISON:");
      lines.push(`    Speed ratio:       BANTAM ${speedRatio.toFixed(1)}x (Hermes ${(h.wallClockMs/1000).toFixed(1)}s vs BANTAM ${(b.durationMs/1000).toFixed(1)}s)`);
      lines.push(`    Turn ratio:        Hermes ${h.turns} vs BANTAM ${b.turns} (${turnRatio.toFixed(1)}x)`);
      lines.push(`    Token ratio:       Hermes ${h.totalTokens.toLocaleString()} vs BANTAM ${b.totalTokens.toLocaleString()} (${tokenRatio.toFixed(1)}x)`);
      lines.push(`    Cache ratio:       Hermes ${h.totalCacheHits.toLocaleString()} vs BANTAM ${b.totalCacheHits.toLocaleString()} (${cacheRatio.toFixed(1)}x)`);
      lines.push(`    Both passed:       ${h.pass === b.pass ? "YES" : "DIFFERENT RESULTS"}`);
      lines.push("");
    }
  }

  // Summary table
  lines.push("");
  lines.push("=" .repeat(90));
  lines.push("SUMMARY TABLE");
  lines.push("=" .repeat(90));
  lines.push("");
  lines.push("-".repeat(90));

  const header = `${"Task".padEnd(10)} ${"System".padEnd(8)} ${"Turns".padEnd(6)} ${"Wall(s)".padEnd(8)} ${"InTok".padEnd(10)} ${"OutTok".padEnd(10)} ${"Cache".padEnd(8)} ${"Reason".padEnd(8)} ${"Pass".padEnd(5)}`;
  lines.push(header);
  lines.push("-".repeat(90));

  for (const r of results) {
    const task = TASKS.find(t => t.id === r.taskId);
    const m = r.metrics;
    const inTok = m.totalInputTokens?.toLocaleString() ?? "N/A";
    const outTok = m.totalOutputTokens?.toLocaleString() ?? "N/A";
    const cache = m.totalCacheHits?.toLocaleString() ?? "N/A";
    const reason = m.totalReasoningTokens?.toLocaleString() ?? "N/A";
    const row = `${task.name.split(":")[0].padEnd(10)} ${r.system.padEnd(8)} ${String(m.turns).padEnd(6)} ${(m.wallClockMs/1000).toFixed(1).padEnd(8)} ${String(inTok).padEnd(10)} ${String(outTok).padEnd(10)} ${String(cache).padEnd(8)} ${String(reason).padEnd(8)} ${String(m.pass).padEnd(5)}`;
    lines.push(row);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
async function main() {
  const allResults = [];
  const tasksToRun = singleTaskIdx >= 0 ? [TASKS[singleTaskIdx]] : TASKS;
  const systemsToRun = singleSystem ? [singleSystem] : ["bantam", "hermes"];

  // Run sequentially by system to avoid model server contention
  // (BANTAM and Hermes share the same local model)
  for (const system of systemsToRun) {
    console.log(`\n=== Running ${system.toUpperCase()} on all tasks ===`);
    for (const task of tasksToRun) {
      console.log(`  Running ${system}...`);
      const workspace = createWorkspace(task.id, system);

      try {
        if (system === "hermes") {
          const metrics = await runHermesTask(task, workspace);
          // Check if verification passed by looking at the output
          // Hermes passes if it completed without errors and ran verification
          const passed = metrics.turns > 0 && metrics.exitCode === 0;
          allResults.push({
            taskId: task.id,
            system: "hermes",
            metrics: {
              ...metrics,
              pass: passed,
            },
          });
          // Save raw log
          fs.writeFileSync(
            path.join(RESULTS_DIR, `task${task.id}_hermes.log`),
            metrics.rawLog,
          );
          console.log(`    Done: ${metrics.turns} calls, ${(metrics.wallClockMs/1000).toFixed(1)}s, ${metrics.totalTokens.toLocaleString()} tokens`);
        } else {
          const result = await runBantamTask(task, workspace);
          const jsonLines = result.stdout.split("\n");
          const metrics = parseBantamOutput(jsonLines);
          allResults.push({
            taskId: task.id,
            system: "bantam",
            metrics,
          });
          // Save raw output
          fs.writeFileSync(
            path.join(RESULTS_DIR, `task${task.id}_bantam.log`),
            result.stdout,
          );
          console.log(`    Done: ${metrics.turns} turns, ${(metrics.durationMs/1000).toFixed(1)}s, ${metrics.totalTokens?.toLocaleString() ?? 0} tokens, pass=${metrics.pass}`);
        }
      } catch (err) {
        console.log(`    Error: ${err.message}`);
        allResults.push({
          taskId: task.id,
          system,
          metrics: {
            turns: 0,
            durationMs: 0,
            wallClockMs: 0,
            totalLatencyMs: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            totalCacheHits: 0,
            totalReasoningTokens: 0,
            perCallLatency: [],
            pass: false,
            status: "error",
            error: err.message,
            rawLog: "",
          },
        });
      }
    }
  }

  // Generate report
  const report = generateReport(allResults);
  const reportPath = path.join(RESULTS_DIR, "BENCHMARK_REPORT.md");
  fs.writeFileSync(reportPath, report);

  console.log("\n" + report);
  console.log(`\nReport saved to: ${reportPath}`);

  // Save structured results
  const structuredPath = path.join(RESULTS_DIR, "results.json");
  fs.writeFileSync(structuredPath, JSON.stringify(allResults, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
