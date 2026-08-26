// Playground: deterministic simulation for exercising comparison/report code.
//
// This does not run the real agent or model and is never promotion evidence.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 1.  TASK DEFINITIONS — small, self-contained tasks with known outcomes
// ---------------------------------------------------------------------------

/**
 * Built-in micro-tasks for benchmarking.
 * Each task has a prompt, an expected outcome checker, and a category.
 */
export const BUILTIN_TASKS = [
  {
    id: "create-file",
    category: "file-ops",
    prompt: "Create a file at src/hello.js that exports a function greet(name) returning 'Hello, {name}!'",
    check: (workspace) => {
      const f = path.join(workspace, "src", "hello.js");
      return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("greet");
    },
    cleanup: (workspace) => {
      try { fs.unlinkSync(path.join(workspace, "src", "hello.js")); } catch { /* file may not exist */ }
    },
  },
  {
    id: "find-bug",
    category: "debugging",
    prompt: "In src/self-improve.js, find the first function that reads files and check if it handles ENOENT errors",
    check: (workspace) => true, // always succeeds as a read task
    cleanup: () => {},
  },
  {
    id: "count-lines",
    category: "analysis",
    prompt: "Count how many .js files are in the src directory",
    check: (workspace) => true,
    cleanup: () => {},
  },
];

// ---------------------------------------------------------------------------
// 2.  CONFIG VARIANTS — baseline vs modified agent behavior
// ---------------------------------------------------------------------------

/**
 * A config variant describes how the agent should behave for this run.
 * Keys: prompt_rules (additional rules), max_turns, action_budget, etc.
 */
export const defaultBaseline = {
  name: "baseline",
  prompt_rules: [],
  max_turns: 20,
  action_budget: 10,
};

export const defaultVariant = {
  name: "variant",
  prompt_rules: ["Be more concise", "Investigate briefly before acting"],
  max_turns: 20,
  action_budget: 10,
};

// ---------------------------------------------------------------------------
// 3.  RUNNER — execute a task under a given config
// ---------------------------------------------------------------------------

/**
 * Run a single task under a configuration.
 * Returns a result object with metrics.
 */
export async function runTask(task, config, workspace) {
  const startTime = Date.now();
  const actions = [];
  let turn = 0;
  let editRetries = 0;
  let success = false;

  // Simulate agent turns (in a real run, this would call the agent loop)
  // For now, we track what actions would be taken.
  const maxTurns = config.max_turns || 20;

  while (turn < maxTurns) {
    turn++;

    // Step 1: Reconnaissance (read relevant files)
    const action = await decideAction(task, config, turn, workspace);
    actions.push(action);

    if (action.type === "replace" || action.type === "write_file") {
      editRetries++;
    }

    // Step 2: Execute the action
    const result = await executeAction(action, workspace);

    if (result.done) break;
  }

  // Check outcome
  try {
    success = task.check(workspace);
  } catch (e) {
    success = false;
  }

  const elapsed = Date.now() - startTime;

  return {
    kind: "bantam.playground-simulation",
    promotionEligible: false,
    task: task.id,
    config: config.name,
    turns: turn,
    actions: actions.map(a => a.type),
    editRetries,
    success,
    elapsed,
    actionBreakdown: countActions(actions),
  };
}

/**
 * Decide what action to take next (simplified agent logic).
 */
async function decideAction(task, config, turn, workspace) {
  // Parse the task prompt to determine action type
  const prompt = task.prompt.toLowerCase();

  if (prompt.includes("create") || prompt.includes("write") || prompt.includes("build")) {
    if (turn === 1) return { type: "read_file", path: "src" };
    return { type: "write_file", path: "src/hello.js", content: "export function greet(name) { return `Hello, ${name}!` }" };
  }

  if (prompt.includes("find") || prompt.includes("check") || prompt.includes("bug")) {
    return { type: "read_file", path: "src/self-improve.js", limit: 50 };
  }

  if (prompt.includes("count") || prompt.includes("how many")) {
    return { type: "list_dir", path: "src" };
  }

  // Default: read something
  return { type: "read_file", path: "src/self-improve.js", limit: 20 };
}

/**
 * Execute an action and return the result.
 */
async function executeAction(action, workspace) {
  try {
    switch (action.type) {
      case "read_file":
        return { done: false, ok: true };
      case "write_file":
        return { done: true, ok: true };
      case "list_dir":
        return { done: false, ok: true };
      default:
        return { done: false, ok: true };
    }
  } catch (e) {
    return { done: true, ok: false, error: e.message };
  }
}

/**
 * Count actions by type.
 */
function countActions(actions) {
  const counts = {};
  for (const action of actions) {
    const type = typeof action === "string" ? action : action?.type;
    const key = typeof type === "string" && type ? type : "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 4.  A/B COMPARISON — run the same task under two configs
// ---------------------------------------------------------------------------

/**
 * Run an A/B experiment: same task, two configs.
 * Returns a comparison report.
 */
export async function runAB(task, baseline, variant, workspace) {
  const resultA = await runTask(task, baseline, workspace);
  const resultB = await runTask(task, variant, workspace);

  // Determine winner
  let winner = "tie";
  if (resultA.success && !resultB.success) winner = "baseline";
  else if (!resultA.success && resultB.success) winner = "variant";
  else if (resultA.success && resultB.success) {
    // Both succeeded: fewer turns wins
    if (resultA.turns < resultB.turns) winner = "baseline";
    else if (resultB.turns < resultA.turns) winner = "variant";
  }

  return {
    kind: "bantam.playground-simulation",
    promotionEligible: false,
    task: task.id,
    category: task.category,
    baseline: resultA,
    variant: resultB,
    winner,
    delta: {
      turns: resultA.turns - resultB.turns,
      editRetries: resultA.editRetries - resultB.editRetries,
      ms: resultA.elapsed - resultB.elapsed,
    },
  };
}

// ---------------------------------------------------------------------------
// 5.  BENCHMARK SUITE — run multiple tasks and aggregate
// ---------------------------------------------------------------------------

/**
 * Run a full benchmark suite across tasks and configs.
 */
export async function runBenchmark(tasks, baseline, variant, workspace) {
  const results = [];

  for (const task of tasks) {
    try {
      const report = await runAB(task, baseline, variant, workspace);
      results.push(report);

      // Cleanup after each task
      try { task.cleanup(workspace); } catch (cleanupErr) {
        // Cleanup failures shouldn't affect results
      }
    } catch (e) {
      results.push({
        task: task.id,
        category: task.category,
        baseline: { turns: 0, success: false },
        variant: { turns: 0, success: false },
        winner: "error",
        error: e.message,
      });
    }
  }

  return aggregateResults(results);
}

/**
 * Aggregate A/B results into a summary report.
 */
export function aggregateResults(results) {
  const total = results.length;
  const baselineWins = results.filter(r => r.winner === "baseline").length;
  const variantWins = results.filter(r => r.winner === "variant").length;
  const ties = results.filter(r => r.winner === "tie").length;
  const errors = results.filter(r => r.winner === "error").length;

  const avgBaselineTurns = average(results.map(r => r.baseline?.turns || 0));
  const avgVariantTurns = average(results.map(r => r.variant?.turns || 0));
  const baselineSuccessRate = (results.filter(r => r.baseline?.success).length / total) * 100;
  const variantSuccessRate = (results.filter(r => r.variant?.success).length / total) * 100;

  return {
    totalTasks: total,
    baselineWins,
    variantWins,
    ties,
    errors,
    avgTurns: {
      baseline: avgBaselineTurns,
      variant: avgVariantTurns,
      delta: avgBaselineTurns - avgVariantTurns,
    },
    successRate: {
      baseline: baselineSuccessRate,
      variant: variantSuccessRate,
      delta: variantSuccessRate - baselineSuccessRate,
    },
    details: results,
  };
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// 6.  IMPACT TRACKER — persist results across runs
// ---------------------------------------------------------------------------

const IMPACT_FILE = ".bantam-playground-results.json";

/**
 * Save benchmark results to persistent storage.
 */
export function saveResults(results, workspace) {
  const file = path.join(workspace, IMPACT_FILE);
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    history = [];
  }

  history.push({
    timestamp: Date.now(),
    ...results,
  });

  fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

/**
 * Load historical results for trend analysis.
 */
export function loadHistory(workspace) {
  const file = path.join(workspace, IMPACT_FILE);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Compute trends from historical data.
 * Returns per-metric trend direction: "improving", "declining", or "stable".
 */
export function computeTrends(history) {
  if (history.length < 2) return { turns: "insufficient-data", success: "insufficient-data" };

  const recent = history.slice(-3);
  const older = history.slice(0, -3);

  const recentAvgTurns = average(recent.map(r => r.avgTurns?.variant || 0));
  const olderAvgTurns = average(older.map(r => r.avgTurns?.variant || 0));

  const recentSuccess = average(recent.map(r => r.successRate?.variant || 0));
  const olderSuccess = average(older.map(r => r.successRate?.variant || 0));

  return {
    turns: recentAvgTurns < olderAvgTurns ? "improving" : recentAvgTurns > olderAvgTurns ? "declining" : "stable",
    success: recentSuccess > olderSuccess ? "improving" : recentSuccess < olderSuccess ? "declining" : "stable",
    dataPoints: history.length,
  };
}

// ---------------------------------------------------------------------------
// 7.  CLI — run from command line
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspace = process.cwd();
  const tasks = BUILTIN_TASKS;
  const baseline = defaultBaseline;
  const variant = defaultVariant;

  console.log("=== Playground A/B Benchmark ===");
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Baseline: ${baseline.name}`);
  console.log(`Variant: ${variant.name}`);
  console.log("");

  runBenchmark(tasks, baseline, variant, workspace).then(async (results) => {
    console.log("--- Results ---");
    console.log(`Total tasks: ${results.totalTasks}`);
    console.log(`Baseline wins: ${results.baselineWins}`);
    console.log(`Variant wins: ${results.variantWins}`);
    console.log(`Ties: ${results.ties}`);
    console.log(`Avg turns (baseline): ${results.avgTurns.baseline.toFixed(1)}`);
    console.log(`Avg turns (variant): ${results.avgTurns.variant.toFixed(1)}`);
    console.log(`Success rate (baseline): ${results.successRate.baseline.toFixed(0)}%`);
    console.log(`Success rate (variant): ${results.successRate.variant.toFixed(0)}%`);
    console.log("");

    // Save results
    await saveResults(results, workspace);
    console.log(`Results saved to ${IMPACT_FILE}`);

    // Show trends if we have history
    const history = loadHistory(workspace);
    if (history.length > 1) {
      const trends = computeTrends(history);
      console.log(`\n--- Trends (${trends.dataPoints} runs) ---`);
      console.log(`Turns: ${trends.turns}`);
      console.log(`Success: ${trends.success}`);
    }
  }).catch((e) => {
    console.error("Benchmark failed:", e.message);
    process.exit(1);
  });
}
