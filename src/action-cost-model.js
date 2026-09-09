// Action Cost Model
//
// Estimates the cost of each action type in terms of:
// - latency (ms), - I/O operations, - CPU cycles
// Helps optimize turn selection by picking lowest-cost actions first.
//
// Rules:
//   1. Each action type has a base cost
//   2. File reads cost more for larger files
//   3. Shell commands cost more for complex pipelines
//   4. Track cumulative cost per session

import { pathToFileURL } from "node:url";
import { shellSegments } from "./shell-lex.js";

// ---------------------------------------------------------------------------
// 1.  BASE COST TABLE
// ---------------------------------------------------------------------------

const BASE_COSTS = {
  read_file: { latency: 5, io: 1, cpu: 1 },
  list_dir: { latency: 2, io: 1, cpu: 0.5 },
  search: { latency: 10, io: 2, cpu: 2 },
  replace: { latency: 3, io: 2, cpu: 1 },
  edit_lines: { latency: 3, io: 2, cpu: 1 },
  patch: { latency: 5, io: 2, cpu: 1.5 },
  write_file: { latency: 4, io: 2, cpu: 1 },
  // Conservative prior: verify the stored baseline, then run the usual write.
  confirm_edit: { latency: 8, io: 4, cpu: 2 },
  write_batch: { latency: 6, io: 4, cpu: 2 },
  delete_file: { latency: 3, io: 2, cpu: 1 },
  move_file: { latency: 3, io: 2, cpu: 1 },
  shell: { latency: 50, io: 1, cpu: 3 },
  // Unmeasured conservative prior: one probe can run three isolated shells.
  probe: { latency: 150, io: 3, cpu: 9 },
  inspect: { latency: 8, io: 3, cpu: 2 },
  query: { latency: 2, io: 0, cpu: 0.5 },
  done: { latency: 1, io: 0, cpu: 0.1 },
  respond: { latency: 1, io: 0, cpu: 0.1 },
};

// ---------------------------------------------------------------------------
// 2.  COST ESTIMATOR
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of a single action.
 */
export function estimateCost(action, fileStats = new Map(), overrides = {}) {
  const type = actionType(action);
  validateFileStats(fileStats);
  const base = Object.hasOwn(BASE_COSTS, type)
    ? BASE_COSTS[type]
    : { latency: 10, io: 1, cpu: 1 };

  let cost = { ...base, type };

  // File reads: larger files cost more
  if (type === "read_file" && action.p) {
    const size = fileStats.has(action.p) ? fileStats.get(action.p) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new TypeError(`file size for ${action.p} must be a finite non-negative number`);
    }
    const pages = Math.ceil(size / 50); // 50 lines per page
    cost.latency += pages * 3;
    cost.io += Math.ceil(pages / 10);
  }

  // Shell commands: more pipes = higher cost
  if (type === "shell" && Object.hasOwn(action, "c")) {
    if (typeof action.c !== "string") {
      throw new TypeError("shell command must be a string");
    }
    const operators = Math.max(0, shellSegments(action.c).length - 1);
    cost.latency += operators * 15;
    cost.cpu += operators * 0.5;
  }

  // Search: an omitted/empty path scans the whole workspace.
  if (type === "search" && (!action.p || action.p === "." || action.p === "./")) {
    cost.latency += 5;
    cost.io += 1;
  }

  cost = applyOverrides(cost, overrides);

  // Composite score for quick comparison
  cost.total = cost.latency * 0.5 + cost.io * 2 + cost.cpu * 3;

  return cost;
}

function actionType(action) {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("action must be an object");
  }
  const type = action.a === undefined ? action.type : action.a;
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new TypeError("action type must be a non-empty string");
  }
  return type;
}

function validateFileStats(fileStats) {
  if (!(fileStats instanceof Map)) {
    throw new TypeError("fileStats must be a Map");
  }
}

function applyOverrides(cost, overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("cost overrides must be an object");
  }
  const unknown = Object.keys(overrides)
    .filter((key) => !["latency", "io", "cpu"].includes(key));
  if (unknown.length) {
    throw new TypeError(`unknown cost override(s): ${unknown.join(", ")}`);
  }
  const result = { ...cost };
  for (const key of ["latency", "io", "cpu"]) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${key} override must be a finite non-negative number`);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3.  SESSION COST TRACKER
// ---------------------------------------------------------------------------

export class SessionCostTracker {
  constructor() {
    this.totalLatency = 0;
    this.totalIo = 0;
    this.totalCpu = 0;
    this.actions = [];
    this.fileStats = new Map();
  }

  track(action, overrides = {}) {
    const cost = estimateCost(action, this.fileStats, overrides);
    const actionSnapshot = cloneAndFreeze(action);
    this.totalLatency += cost.latency;
    this.totalIo += cost.io;
    this.totalCpu += cost.cpu;
    this.actions.push(Object.freeze({
      action: actionSnapshot,
      cost: Object.freeze({ ...cost }),
      timestamp: Date.now(),
    }));
    return { ...cost };
  }

  summary() {
    return {
      totalLatency: this.totalLatency,
      totalIo: this.totalIo,
      totalCpu: this.totalCpu,
      totalActions: this.actions.length,
      avgLatency: this.actions.length ? this.totalLatency / this.actions.length : 0,
      byType: this._byType(),
    };
  }

  _byType() {
    const byType = new Map();
    for (const { cost } of this.actions) {
      const type = cost.type;
      if (!byType.has(type)) byType.set(type, { count: 0, totalCost: 0 });
      const entry = byType.get(type);
      entry.count++;
      entry.totalCost += cost.total;
    }
    // Object.fromEntries creates own data properties even for special names
    // such as "__proto__", without invoking Object.prototype setters.
    return Object.fromEntries(byType);
  }

  mostExpensive(n = 5) {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError("result count must be a non-negative integer");
    }
    return [...this.actions]
      .sort((a, b) => b.cost.total - a.cost.total)
      .slice(0, n);
  }

  withinBudget(maxLatency) {
    if (!Number.isFinite(maxLatency) || maxLatency < 0) {
      throw new TypeError("maxLatency must be a finite non-negative number");
    }
    return this.totalLatency <= maxLatency;
  }
}

function cloneAndFreeze(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return item;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
    return item;
  };
  return freeze(clone);
}

// ---------------------------------------------------------------------------
// 4.  COST OPTIMIZER
// ---------------------------------------------------------------------------

/**
 * Given a list of candidate actions, return them sorted by cost-efficiency.
 */
export function optimizeActions(actions, fileStats = new Map()) {
  if (!Array.isArray(actions)) throw new TypeError("actions must be an array");
  validateFileStats(fileStats);
  const scored = actions.map(a => ({
    action: a,
    cost: estimateCost(a, fileStats),
  }));

  // Sort by total cost (cheapest first)
  scored.sort((a, b) => a.cost.total - b.cost.total);
  return scored;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

export function runTests() {
  console.log("=== Action Cost Model ===\n");

  // Test 1: base costs
  console.log("Test 1: Base costs");
  const c1 = estimateCost({ a: "read_file", p: "src/a.js" });
  console.assert(c1.type === "read_file", `type should be read_file`);
  console.assert(c1.total > 0, `total cost should be positive`);
  console.log(`  PASS: Base cost works, total=${c1.total.toFixed(1)}`);

  // Test 2: file size affects cost
  console.log("Test 2: File size affects cost");
  const fileStats = new Map([ ["src/large.js", 500] ]);
  const c2a = estimateCost({ a: "read_file", p: "src/large.js" }, fileStats);
  const c2b = estimateCost({ a: "read_file", p: "src/small.js" }, fileStats);
  console.assert(c2a.latency > c2b.latency, `larger file should cost more`);
  console.log(`  PASS: Large file latency=${c2a.latency}, small=${c2b.latency}`);

  // Test 3: shell pipeline cost
  console.log("Test 3: Shell pipeline cost");
  const c3a = estimateCost({ a: "shell", c: "ls" });
  const c3b = estimateCost({ a: "shell", c: "ls | grep foo | wc -l" });
  console.assert(c3b.latency > c3a.latency, `pipeline should cost more`);
  console.log(`  PASS: Pipeline latency=${c3b.latency}, simple=${c3a.latency}`);

  // Test 4: session tracker
  console.log("Test 4: Session tracker");
  const tracker = new SessionCostTracker();
  tracker.track({ a: "read_file", p: "src/a.js" });
  tracker.track({ a: "shell", c: "ls" });
  const summary = tracker.summary();
  console.assert(summary.totalActions === 2, `should have 2 actions`);
  console.assert(summary.totalLatency > 0, `total latency should be positive`);
  console.log(`  PASS: Tracker works, totalLatency=${summary.totalLatency}`);

  // Test 5: most expensive
  console.log("Test 5: Most expensive");
  const expensive = tracker.mostExpensive(1);
  console.assert(expensive.length > 0, `should have expensive actions`);
  console.log(`  PASS: Most expensive action type=${expensive[0].action.a}`);

  // Test 6: budget check
  console.log("Test 6: Budget check");
  console.assert(tracker.withinBudget(1000), `should be within budget`);
  console.assert(!tracker.withinBudget(1), `should exceed tiny budget`);
  console.log(`  PASS: Budget check works`);

  // Test 7: optimize actions
  console.log("Test 7: Optimize actions");
  const actions = [
    { a: "shell", c: "ls | grep foo | wc -l" },
    { a: "read_file", p: "src/a.js" },
    { a: "query", q: "test" },
  ];
  const optimized = optimizeActions(actions);
  console.assert(optimized[0].cost.total <= optimized[1].cost.total, `cheapest first`);
  console.log(`  PASS: Optimization works, cheapest=${optimized[0].action.a}`);

  // Test 8: byType summary
  console.log("Test 8: ByType summary");
  const tracker2 = new SessionCostTracker();
  tracker2.track({ a: "read_file", p: "src/a.js" });
  tracker2.track({ a: "read_file", p: "src/b.js" });
  tracker2.track({ a: "shell", c: "ls" });
  const byType = tracker2.summary().byType;
  console.assert(byType.read_file.count === 2, `read_file count should be 2`);
  console.assert(byType.shell.count === 1, `shell count should be 1`);
  console.log(`  PASS: ByType works, read_file=${byType.read_file.count}, shell=${byType.shell.count}`);

  console.log("\nAll tests passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTests();
}
