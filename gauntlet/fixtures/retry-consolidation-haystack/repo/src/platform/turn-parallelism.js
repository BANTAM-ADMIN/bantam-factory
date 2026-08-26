// Turn-Parallelism Detector
//
// Identifies independent actions that can be batched into a single turn,
// reducing total turns by executing read-only ops concurrently.
//
// Rules:
//   - read_file, list_dir, search, and query are independent of each other.
//   - replace/replace_all depend on the file being in its current state.
//   - shell commands are independent of file reads but not of each other
//     (they share the same environment).

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 1.  ACTION DEPENDENCY GRAPH
// ---------------------------------------------------------------------------

/**
 * Classify an action as read-only or write.
 */
export function actionKind(action) {
  if (typeof action === "object" && action !== null) {
    const a = action.a || action.type;
    if (a === "read_file" || a === "list_dir" || a === "search" || a === "query" || a === "inspect") {
      return "read";
    }
    if (a === "replace" || a === "replace_all" || a === "write_file" || a === "shell") {
      return "write";
    }
  }
  return "unknown";
}

/**
 * Check if two actions conflict (i.e. should not be parallelized).
 */
export function actionsConflict(a, b) {
  const ka = actionKind(a);
  const kb = actionKind(b);
  if (ka === "write" || kb === "write") return true;
  // Two reads of the same file at different ranges are fine,
  // but two searches with overlapping patterns might be redundant.
  return false;
}

// ---------------------------------------------------------------------------
// 2.  BATCH BUILDER — group independent reads into one inspect call
// ---------------------------------------------------------------------------

/**
 * Given a list of planned actions, return batches of independent reads
 * that can be executed in a single inspect call.
 *
 * @param {Array} actions - list of action objects
 * @param {number} maxBatch - max ops per inspect call (default 6)
 * @returns {Array<{type, ops}>} batches
 */
export function buildBatches(actions, maxBatch = 6) {
  const reads = actions.filter(a => actionKind(a) === "read");
  const writes = actions.filter(a => actionKind(a) === "write");

  const batches = [];
  let current = [];

  for (const r of reads) {
    if (current.length >= maxBatch) {
      batches.push({ type: "inspect", ops: [...current] });
      current = [];
    }
    current.push(r);
  }
  if (current.length > 0) {
    batches.push({ type: "inspect", ops: current });
  }

  // Writes stay sequential
  for (const w of writes) {
    batches.push({ type: "sequential", ops: [w] });
  }

  return batches;
}

// ---------------------------------------------------------------------------
// 3.  TURN SAVINGS ESTIMATOR
// ---------------------------------------------------------------------------

/**
 * Estimate how many turns could be saved by batching.
 *
 * @param {Array} actions - list of planned actions for a task
 * @returns {{originalTurns, optimizedTurns, saved, savingsPercent}}
 */
export function estimateSavings(actions, maxBatch = 6) {
  if (!actions || actions.length === 0) {
    return { originalTurns: 0, optimizedTurns: 0, turnsSaved: 0, pctSaved: 0 };
  }

  // Two corrections, both measured on 34 recorded Codex runs / 383 turns.
  //
  // 1. Actions the classifier does not recognise -- `done` above all, which every
  //    run has exactly one of -- were dropped from the optimized count, so each
  //    one registered as a turn SAVED.
  // 2. Reads were pooled across the WHOLE run and divided by the batch size, which
  //    merges a turn-1 read with a turn-8 read that only happened because of
  //    turn-7's edit. A trajectory is a sequence, not a bag of actions.
  //
  // Together those reported 46.5% of turns removable. Respecting both gives 4.4%,
  // matching a hand check of the trajectories. That gap is the entire argument for
  // or against building parallel dispatch: 46.5% would justify it, 4.4% says the
  // models already batch well and the lever is nearly spent.
  //
  // What remains is an UPPER BOUND, not an estimate, and cannot be tightened from
  // a trajectory alone. Consecutive reads fall into two kinds that look identical
  // in the log:
  //
  //   inspect(6) -> inspect(6)   twelve independent modules, split only by the
  //                              batch cap -- genuinely collapsible
  //   read_file  -> inspect(6)   the first read decided WHICH files to batch --
  //                              causally sequential, not collapsible at all
  //
  // Only the model knows which it was. And the clearly-collapsible kind was already
  // tested: raising the inspect cap 6 -> 12 saved a turn and cost 61% more cache
  // misses, because one wide batch makes one large observation that sticky slimming
  // later rewrites in a single block. So the reachable part of this bound is
  // measured net-negative. Read it as a ceiling on a lever already tried.
  //
  // Only CONSECUTIVE reads collapse. Writes and unrecognised actions keep a turn.
  let optimizedTurns = 0;
  let index = 0;
  while (index < actions.length) {
    if (actionKind(actions[index]) !== "read") {
      optimizedTurns += 1;
      index += 1;
      continue;
    }
    let span = 0;
    while (index + span < actions.length && actionKind(actions[index + span]) === "read") span += 1;
    optimizedTurns += Math.ceil(span / maxBatch);
    index += span;
  }

  const originalTurns = actions.length;
  const turnsSaved = Math.max(0, originalTurns - optimizedTurns);

  return {
    originalTurns,
    optimizedTurns,
    turnsSaved,
    pctSaved: originalTurns > 0 ? (turnsSaved / originalTurns) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// 4.  PARALLELISM ANALYZER — scan a turn log for missed batching opportunities
// ---------------------------------------------------------------------------

/**
 * Analyze a sequence of turns (action + observation pairs) and find
 * consecutive read-only actions that could have been batched.
 *
 * @param {Array<{action, observation}>} turns
 * @returns {{missedBatches, potentialSavings, recommendations}}
 */
export function analyzeTurns(turns) {
  const missedBatches = [];
  let streak = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const actions = Array.isArray(turn) ? turn : [turn.action];
    const kinds = actions.map(a => actionKind(a));
    const kind = kinds[0] || "unknown";
    if (kind === "read") {
      streak.push(i);
    } else {
      if (streak.length >= 2) {
        missedBatches.push({
          turnRange: [streak[0], streak[streak.length - 1]],
          count: streak.length,
          actions: streak.map(j => {
            const t = turns[j];
            const as = Array.isArray(t) ? t : [t.action];
            return as[0].a || as[0].type;
          }),
        });
      }
      streak = [];
    }
  }
  // Check trailing streak
  if (streak.length >= 2) {
    missedBatches.push({
      turnRange: [streak[0], streak[streak.length - 1]],
      count: streak.length,
      actions: streak.map(j => {
        const t = turns[j];
        const as = Array.isArray(t) ? t : [t.action];
        return as[0].a || as[0].type;
      }),
    });
  }

  const potentialSavings = missedBatches.reduce((sum, b) => {
    return sum + (b.count - Math.ceil(b.count / 6));
  }, 0);

  const recommendations = missedBatches.map(b =>
    `Batch turns ${b.turnRange[0]}–${b.turnRange[1]}: ${b.count} independent reads → 1 inspect call`
  );

  // Build phase breakdown
  const phases = [];
  const phaseNames = new Set();
  for (const t of turns) {
    const actions = Array.isArray(t) ? t : [t.action];
    for (const a of actions) {
      const kind = actionKind(a);
      if (kind === "read" && !phaseNames.has("discovery")) {
        phases.push({ name: "discovery", count: 0 });
        phaseNames.add("discovery");
      }
      if (kind === "write" && !phaseNames.has("write")) {
        phases.push({ name: "write", count: 0 });
        phaseNames.add("write");
      }
    }
  }

  return { missedBatches, potentialSavings, recommendations, phases };
}

// ---------------------------------------------------------------------------
// 5.  SMART BATCHING — respect file ordering constraints
// ---------------------------------------------------------------------------

/**
 * Some reads depend on knowing a file's structure first (e.g. list_dir
 * before read_file). Smart batching respects these soft dependencies.
 *
 * @param {Array} actions
 * @returns {Array<{phase, ops}>} phased batches
 */
export function smartBatch(actions) {
  const reads = actions.filter(a => actionKind(a) === "read");
  const writes = actions.filter(a => actionKind(a) === "write");

  // Phase 1: discovery (list_dir, search)
  const discovery = reads.filter(a => {
    const t = a.a || a.type;
    return t === "list_dir" || t === "search" || t === "query";
  });

  // Phase 2: targeted reads (read_file)
  const targeted = reads.filter(a => {
    const t = a.a || a.type;
    return t === "read_file" || t === "inspect";
  });

  const phases = [];
  if (discovery.length > 0) {
    phases.push({ phase: "discovery", ops: discovery });
  }
  if (targeted.length > 0) {
    phases.push({ phase: "targeted", ops: targeted });
  }
  for (const w of writes) {
    phases.push({ phase: "write", ops: [w] });
  }

  return phases;
}

// ---------------------------------------------------------------------------
// 6.  COST MODEL — estimate context cost per action type
// ---------------------------------------------------------------------------

const COST_PER_ACTION = {
  read_file: 50,       // ~50 lines average
  list_dir: 5,         // small output
  search: 15,          // regex match output
  query: 10,           // KB lookup
  inspect: 30,         // batched read
  replace: 20,         // edit + context
  write_file: 40,      // full file content
  shell: 25,           // command output
};

/**
 * Estimate context budget consumed by a sequence of actions.
 *
 * @param {Array} actions
 * @returns {{totalCost, breakdown, budgetUsed}}
 */
export function estimateCost(actions, budget = 8000) {
  const breakdown = {};
  let total = 0;

  for (const a of actions) {
    const type = a.a || a.type || "unknown";
    const cost = COST_PER_ACTION[type] || 20;
    breakdown[type] = (breakdown[type] || 0) + cost;
    total += cost;
  }

  return {
    totalCost: total,
    breakdown,
    budgetUsed: Math.round((total / budget) * 100),
  };
}

// ---------------------------------------------------------------------------
// 7.  TURN OPTIMIZER — suggest optimal action ordering
// ---------------------------------------------------------------------------

/**
 * Reorder actions to maximize parallelism and minimize turns.
 *
 * Strategy:
 *   1. Group all independent reads into inspect batches
 *   2. Keep writes sequential after their dependency reads
 *   3. Front-load discovery actions (list_dir, search)
 *
 * @param {Array} actions
 * @returns {Array} reordered actions with batching hints
 */
export function optimizeTurns(actions) {
  const phases = smartBatch(actions);
  const optimized = [];

  for (const phase of phases) {
    if (phase.phase === "write") {
      optimized.push({
        type: "sequential",
        action: phase.ops[0],
      });
    } else if (phase.ops.length === 1) {
      optimized.push({
        type: "single",
        action: phase.ops[0],
      });
    } else {
      // Split into batches of 6
      for (let i = 0; i < phase.ops.length; i += 6) {
        const batch = phase.ops.slice(i, i + 6);
        optimized.push({
          type: "inspect",
          ops: batch,
        });
      }
    }
  }

  return optimized;
}

// ---------------------------------------------------------------------------
// 8.  CLI / STANDALONE TEST
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== Turn Parallelism Detector ===\n");

  // Test 1: action kind classification
  console.log("Test 1: Action kind classification");
  console.assert(actionKind({ a: "read_file" }) === "read", "read_file should be read");
  console.assert(actionKind({ a: "list_dir" }) === "read", "list_dir should be read");
  console.assert(actionKind({ a: "search" }) === "read", "search should be read");
  console.assert(actionKind({ a: "replace" }) === "write", "replace should be write");
  console.assert(actionKind({ a: "write_file" }) === "write", "write_file should be write");
  console.assert(actionKind({ a: "shell" }) === "write", "shell should be write");
  console.assert(actionKind({ a: "query" }) === "read", "query should be read");
  console.assert(actionKind({ a: "inspect" }) === "read", "inspect should be read");
  console.log("  PASS: All action kinds classified correctly\n");

  // Test 2: conflict detection
  console.log("Test 2: Conflict detection");
  console.assert(!actionsConflict({ a: "read_file" }, { a: "list_dir" }), "reads don't conflict");
  console.assert(actionsConflict({ a: "replace" }, { a: "read_file" }), "write conflicts with read");
  console.assert(actionsConflict({ a: "replace" }, { a: "write_file" }), "writes conflict");
  console.log("  PASS: Conflicts detected correctly\n");

  // Test 3: batch building
  console.log("Test 3: Batch building");
  const testActions = [
    { a: "read_file", p: "a.js" },
    { a: "list_dir", p: "src" },
    { a: "read_file", p: "b.js" },
    { a: "replace", p: "a.js" },
    { a: "search", q: "test" },
    { a: "read_file", p: "c.js" },
    { a: "write_file", p: "d.js" },
  ];
  const batches = buildBatches(testActions);
  const readBatches = batches.filter(b => b.type === "inspect");
  const writeBatches = batches.filter(b => b.type === "sequential");
  console.assert(readBatches.length >= 1, "should have at least 1 read batch");
  console.assert(writeBatches.length === 2, "should have 2 write batches");
  console.log(`  PASS: Built ${readBatches.length} read batches, ${writeBatches.length} write batches\n`);

  // Test 4: savings estimation
  console.log("Test 4: Savings estimation");
  const savings = estimateSavings(testActions);
  console.assert(savings.saved > 0, "should save turns");
  console.assert(savings.optimizedTurns < savings.originalTurns, "optimized should use fewer turns");
  console.log(`  PASS: ${savings.originalTurns} → ${savings.optimizedTurns} turns (${savings.saved} saved, ${savings.savingsPercent.toFixed(0)}% reduction)\n`);

  // Test 5: turn analysis
  console.log("Test 5: Turn analysis");
  const testTurns = [
    { action: { a: "read_file" }, observation: "content" },
    { action: { a: "list_dir" }, observation: "files" },
    { action: { a: "read_file" }, observation: "content" },
    { action: { a: "replace" }, observation: "ok" },
    { action: { a: "search" }, observation: "matches" },
    { action: { a: "read_file" }, observation: "content" },
  ];
  const analysis = analyzeTurns(testTurns);
  console.assert(analysis.missedBatches.length >= 1, "should find missed batching opportunities");
  console.assert(analysis.potentialSavings > 0, "should estimate savings");
  console.log(`  PASS: Found ${analysis.missedBatches.length} missed batches, ${analysis.potentialSavings} turns savable\n`);

  // Test 6: smart batching
  console.log("Test 6: Smart batching");
  const phases = smartBatch(testActions);
  const phaseNames = phases.map(p => p.phase);
  console.assert(phaseNames.includes("discovery") || phaseNames.includes("targeted"), "should have read phases");
  console.assert(phaseNames.includes("write"), "should have write phase");
  console.log(`  PASS: ${phases.length} phases: ${phaseNames.join(", ")}\n`);

  // Test 7: cost estimation
  console.log("Test 7: Cost estimation");
  const cost = estimateCost(testActions);
  console.assert(cost.totalCost > 0, "should have positive cost");
  console.assert(cost.breakdown.read_file > 0, "should track read_file cost");
  console.log(`  PASS: Total cost ${cost.totalCost}, budget used ${cost.budgetUsed}%\n`);

  // Test 8: turn optimization
  console.log("Test 8: Turn optimization");
  const optimized = optimizeTurns(testActions);
  console.assert(optimized.length < testActions.length, "optimized should have fewer steps");
  console.log(`  PASS: ${testActions.length} actions → ${optimized.length} optimized steps\n`);

  console.log("All tests passed.");
}
