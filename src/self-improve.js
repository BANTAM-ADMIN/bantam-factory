// Self-improvement loop: identify weakness → propose fix → build → test → integrate.
//
// Each cycle the agent scans its own codebase for anti-patterns, missing coverage,
// and structural gaps, then emits a ranked list of improvement candidates.
// The agent picks one, builds it, tests it, and commits it into its own harness.

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";
import { deduplicate, scoreImprovement } from "./improvement-priority.js";
import { checkErrorHandling, checkTestCoverage } from "./self-diagnostic.js";
export { FailurePatternLearner } from "./failure-pattern-learner.js";

// ---------------------------------------------------------------------------
// 1.  WEAKNESS DETECTION — scan the codebase for known improvement signals
// ---------------------------------------------------------------------------

/**
 * Return a ranked list of self-improvement candidates.
 * Each candidate has: id, area, problem, proposal, effort (1-5), impact (1-5).
 */
export function scanWeaknesses(workspace) {
  const candidates = [];
  const srcDir = path.join(workspace, "src");
  try {
    if (!fs.statSync(srcDir).isDirectory()) return candidates;
  } catch {
    return candidates;
  }

  // --- Check 1: files without any tests ---
  const srcFiles = listFiles(srcDir, /\.js$/);
  let untested = [];
  try {
    untested = checkTestCoverage(workspace).untested;
  } catch {
    // A malformed workspace is handled by the other structural candidates.
  }
  if (untested.length > 4) {
    const target = untested[0];
    candidates.push({
      id: "test-coverage",
      area: "reliability",
      problem: `${untested.length} source files have no direct test import.`,
      proposal: `Add focused direct unit tests for the highest-priority module: ${target}`,
      // One small, independently provable improvement per managed cycle keeps
      // the model from spreading a coverage change across several unrelated
      // modules and makes rollback/promotion evidence easier to audit.
      targets: [target],
      occurrences: untested.length,
      effort: 3,
      impact: 4,
    });
  }

  // --- Check 2: large files (>500 lines) that could be split ---
  const largeFiles = srcFiles.map(f => ({
    path: f,
    lines: fs.readFileSync(path.join(srcDir, f), "utf8").split("\n").length,
  })).filter(f => f.lines > 500);
  if (largeFiles.length > 0) {
    candidates.push({
      id: "split-large-files",
      area: "maintainability",
      problem: `${largeFiles.length} files exceed 500 lines: ${largeFiles.map(f => `${f.path}(${f.lines})`).join(", ")}`,
      proposal: "Extract helper logic into smaller, focused modules to reduce cognitive load and improve testability.",
      targets: largeFiles.map(file => file.path),
      occurrences: largeFiles.length,
      effort: 4,
      impact: 3,
    });
  }

  // --- Check 3: repeated patterns (copy-paste anti-pattern) ---
  const contentMap = new Map();
  for (const f of srcFiles) {
    contentMap.set(f, fs.readFileSync(path.join(srcDir, f), "utf8"));
  }
  const repeatedPatterns = findRepeatedPatterns(contentMap, 3);
  if (repeatedPatterns.length > 0) {
    const targets = [...new Set(repeatedPatterns.flatMap(pattern => pattern.files))].sort();
    candidates.push({
      id: "dedupe-patterns",
      area: "code-quality",
      problem: `Found ${repeatedPatterns.length} repeated code patterns across at least 3 distinct files.`,
      proposal: "Extract shared patterns into reusable utility functions.",
      targets,
      patternEvidence: repeatedPatterns.slice(0, 5),
      occurrences: repeatedPatterns.length,
      effort: 2,
      impact: 3,
    });
  }

  // --- Check 4: missing error handling ---
  let errorGaps = [];
  try {
    errorGaps = checkErrorHandling(workspace).issues;
  } catch {
    // Do not recommend a rewrite from an incomplete diagnostic.
  }
  if (errorGaps.length > 0) {
    candidates.push({
      id: "error-handling",
      area: "robustness",
      problem: `${errorGaps.length} undocumented empty catch block(s) can hide failures.`,
      proposal: "Make each catch propagate, report, or explicitly document its best-effort fallback.",
      targets: [...new Set(errorGaps.map((issue) => issue.file))].slice(0, 5),
      occurrences: errorGaps.length,
      effort: 2,
      impact: 3,
    });
  }

  // Static "missing mechanism" candidates are useful only while the generated
  // module is actually absent. Keeping them unconditional made completed work
  // resurface forever and caused the runner to cycle over "exists" no-ops.
  // Five proposals were removed on 2026-07-31 because their PREMISES had gone
  // stale, not because the work was done. Each had been "implemented" as a stub
  // that nothing imported, while the stated need was already met by real
  // infrastructure:
  //
  //   turn-efficiency        every artifact already records turns, actions,
  //                          tokens and cost; a day of measurement ran off it
  //   action-efficiency      action-cost-model.js is wired into the recommender
  //   action-decision-tree   action-recommender.js is wired
  //   completion-confidence  fifteen done-gates, verify_red and the state audits
  //                          already score readiness before done
  //   task-decomposition     built as 660 lines exporting only runTests, with its
  //                          logic unexported and its own tests running on import
  //   prompt-compression     the system prompt is the CACHED PREFIX, so
  //                          compressing it saves almost nothing, and the stub
  //                          collapsed whitespace inside prompts made of code
  //
  // A proposal whose premise is false does not become true by being built.
  const missingMechanisms = [
    {
      files: ["prompt-tracker.js", "prompt-optimization.js"],
      id: "prompt-optimization", area: "reasoning",
      problem: "Prompt rules are static; no mechanism to learn which rules actually help on real tasks.",
      proposal: "Build a rule-ablation tracker that measures pass-rate delta per rule across runs.",
      effort: 3, impact: 5,
    },
    {
      files: ["benchmark.js", "self-benchmark.js"],
      id: "self-benchmark", area: "measurement",
      problem: "No automated benchmark that measures Bantam's own capability before vs after a change.",
      proposal: "Create a micro-benchmark suite: small coding tasks with known correct outputs, run before/after each improvement.",
      effort: 3, impact: 5,
    },
    {
      files: ["failure-db.js"],
      id: "failure-learning", area: "reasoning",
      problem: "Each run starts fresh; failure patterns from previous runs are not captured as lessons.",
      proposal: "Build a failure-pattern database: after each run, extract what went wrong and feed it back as a nudge in future runs.",
      effort: 3, impact: 5,
    },
    {
      files: ["tool-feedback.js"],
      id: "tool-feedback", area: "tooling",
      problem: "Tools are registered statically; no feedback on which tools are actually used vs ignored.",
      proposal: "Track tool usage frequency and effectiveness. Auto-suggest underused tools when relevant.",
      effort: 2, impact: 3,
    },
    {
      files: ["index-enhanced.js", "codebase-index.js"],
      id: "codebase-index", area: "awareness",
      problem: "No pre-built index of own codebase structure, symbols, and dependencies. Each run re-discovers from scratch.",
      proposal: "Build a codebase index (file map, exported symbols, dependency graph) that is cached and reused across runs, dramatically reducing reconnaissance turns.",
      effort: 3, impact: 5,
    },
    {
      files: ["edit-metrics.js"],
      id: "edit-metrics", area: "measurement",
      problem: "No tracking of edit success rate (first-try vs retries). High retry rates signal prompt or parsing issues.",
      proposal: "Track edit success metrics: first-try success rate, common mismatch patterns, and files that need the most retries.",
      effort: 2, impact: 4,
    },
    {
      files: ["context-budget.js"],
      id: "context-budgeting", area: "performance",
      problem: "No tracking of context window usage per turn. Large observations waste tokens that could be used for reasoning.",
      proposal: "Add context-window budgeting: track token/character usage per turn, flag turns that exceed thresholds, suggest truncation strategies.",
      effort: 2, impact: 4,
    },
    {
      files: ["action-cost-model.js"],
      id: "action-cost-model", area: "performance",
      problem: "No cost model for actions. Bantam doesn't know that a full-dir listing costs more than a targeted read, or that shell commands are slower than direct file ops.",
      proposal: "Build an action-cost model: assign estimated costs to each action type, track actual costs, and prefer cheaper actions when outcomes are equivalent.",
      effort: 2, impact: 4,
    },
    {
      files: ["cross-file-patterns.js"],
      id: "cross-file-patterns", area: "awareness",
      problem: "No ability to detect when the same bug/anti-pattern exists across multiple files simultaneously.",
      proposal: "Build a cross-file pattern matcher: scan for common anti-patterns (missing exports, inconsistent error handling, duplicated logic) across the entire codebase.",
      effort: 3, impact: 4,
    },
    {
      files: ["skill-discovery.js"],
      id: "skill-discovery", area: "tooling",
      problem: "Skills directory exists but no system to discover, rate, or recommend skills for a given task.",
      proposal: "Build a skill-discovery system: index skills, match them to task descriptions, and auto-recommend relevant skills.",
      effort: 2, impact: 4,
    },
    {
      files: ["output-validation.js", "source-validation.js"],
      id: "output-validation", area: "reliability",
      problem: "No validation that output matches expected format before returning to user. Malformed responses waste turns.",
      proposal: "Build an output-validator: check that responses match the expected JSON/action format, catch malformed outputs before they cause errors.",
      effort: 2, impact: 4,
    },
    {
      files: ["retry-strategy.js"],
      id: "retry-strategy", area: "performance",
      problem: "Retries are blind — no strategy for what to change on retry. Same action repeated with same parameters wastes turns.",
      proposal: "Build a retry-strategy engine: on failure, suggest specific parameter changes (different tool, narrower scope, different approach) instead of blind retries.",
      effort: 3, impact: 5,
    },
    {
      files: ["dependency-impact.js"],
      id: "dependency-impact", area: "awareness",
      problem: "When a file is edited, no analysis of which other files depend on it. Silent breakage from cascading changes.",
      proposal: "Build a dependency-impact analyzer: before editing, check which files import from the target and flag potential breakage.",
      effort: 2, impact: 4,
    },
    {
      files: ["memory-compression.js"],
      id: "memory-compression", area: "performance",
      problem: "Turn history grows linearly. No compression of earlier turns to save context window for later reasoning.",
      proposal: "Build a memory-compression system: summarize earlier turns, keep only critical details, free context for active work.",
      effort: 3, impact: 4,
    },
    {
      files: ["test-priority.js"],
      id: "test-priority", area: "reliability",
      problem: "Tests are run in arbitrary order. Most critical tests (core modules, recently changed) should run first.",
      proposal: "Build a test-priority ranker: order tests by importance (core modules first, recently changed files, then coverage gaps).",
      effort: 2, impact: 3,
    },
    {
      files: ["turn-parallelism.js"],
      id: "turn-parallelism", area: "performance",
      problem: "Actions are always sequential. Independent reads (list_dir + read_file) could be batched into one turn.",
      proposal: "Build a turn-parallelism detector: identify independent actions that can be batched, reducing total turns.",
      effort: 2, impact: 5,
    },
    {
      files: ["improvement-priority.js"],
      id: "improvement-priority", area: "reasoning",
      problem: "Improvement candidates are picked in fixed order. No learning about which improvements actually yield the best results.",
      proposal: "Build an improvement-priority learner: track which improvements lead to measurable gains and deprioritize those that don't.",
      effort: 2, impact: 4,
    },
    {
      files: ["style-consistency.js"],
      id: "style-consistency", area: "maintainability",
      problem: "Self-built modules may have inconsistent style (naming, formatting, export patterns). This creates cognitive drag.",
      proposal: "Build a style-consistency checker: detect deviations from established patterns and auto-correct them.",
      effort: 2, impact: 3,
    },
    {
      files: ["module-budget.js"],
      id: "module-budget", area: "maintainability",
      problem: "No limit on how large a single module can grow. Modules accumulate features without bounds.",
      proposal: "Build a module-size budget: track lines per module, flag when a module exceeds its budget, suggest splits.",
      effort: 2, impact: 3,
    },
    {
      files: ["self-test-gen.js", "self-test-generator.js"],
      id: "self-test-gen", area: "reliability",
      problem: "Tests are written manually. No system to auto-generate basic smoke tests for new modules.",
      proposal: "Build a self-test generator: for each new module, auto-generate import + basic API tests.",
      effort: 3, impact: 4,
    },
  ];
  for (const { files, ...candidate } of missingMechanisms) {
    if (!files.some((file) => fs.existsSync(path.join(srcDir, file)))) {
      candidates.push({
        ...candidate,
        targets: [...files],
        // File appearance is useful build evidence, but not proof that a new
        // mechanism is wired into Bantam's production path. Keep these on dev
        // until an integration target + behavioral metric is preregistered.
        promotionEligible: false,
        lanePolicy: "build-only",
        promotionBlocker: (
          "a newly named mechanism must demonstrate production integration and "
          + "behavioral lift; filename presence plus unit tests is insufficient"
        ),
      });
    }
  }

  // Sort by impact/effort ratio (highest first)
  return candidates.sort((a, b) => (b.impact / b.effort) - (a.impact / a.effort));
}

// ---------------------------------------------------------------------------
// 2.  IMPROVEMENT IMPLEMENTATION — build and test a single improvement
// ---------------------------------------------------------------------------

/**
 * Run the self-improvement loop for one cycle.
 * Returns { candidate, changes, testResult }.
 */
export async function runImprovementCycle(workspace, cycle, buildFn, testFn) {
  const candidates = scanWeaknesses(workspace);
  const picked = candidates[cycle % candidates.length];

  if (!picked) {
    return { candidate: null, changes: [], testResult: "no candidates" };
  }

  // Build the improvement
  const changes = await buildFn(picked, workspace);

  // Test it
  const result = await testFn(picked, changes, workspace);

  return { candidate: picked, changes, testResult: result };
}

// ---------------------------------------------------------------------------
// 3.  EVIDENCE TRACKING — log what worked and what didn't
// ---------------------------------------------------------------------------

export class ImprovementLog {
  constructor(logPath = null, { create = Boolean(logPath) } = {}) {
    // No path means an in-memory log. This is important for normal agent and
    // read-only diagnostic runs: observing a workspace must not dirty it.
    this.path = logPath ? path.resolve(logPath) : null;
    this.entries = this._load();
    if (create && this.path && !fs.existsSync(this.path)) {
      writeJsonAtomic(this.path, []);
    }
    this.observations = [];
  }

  /** Record a parsed observation from the observation parser. */
  recordObservation(parsed) {
    this.observations.push(parsed);

    // Record test outcomes as evidence entries
    const data = parsed?.data ?? parsed?.extracted;
    if (data?.tests) {
      const a = data.tests;
      if (a.failed > 0) {
        this.record({ id: "test-run", area: "reliability", passed: false, detail: `${a.failed} test(s) failed, ${a.passed} passed` });
      } else if (a.passed > 0) {
        this.record({ id: "test-run", area: "reliability", passed: true, detail: `${a.passed} test(s) passed` });
      }
    }
  }

  _load() {
    if (!this.path) return [];
    try {
      const entries = JSON.parse(fs.readFileSync(this.path, "utf8"));
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  record(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("improvement log entry must be an object");
    }
    const normalized = { ...entry };
    // Read old `success` records, but persist one canonical outcome field.
    if (typeof normalized.passed !== "boolean" && typeof normalized.success === "boolean") {
      normalized.passed = normalized.success;
    }
    delete normalized.success;
    const snapshot = jsonSnapshot({ ...normalized, timestamp: Date.now() }, "improvement log entry");
    const nextEntries = [...this.entries, snapshot];
    if (this.path) writeJsonAtomic(this.path, nextEntries);
    this.entries = nextEntries;
  }

  /** Return overall summary with totals and per-area breakdown. */
  summary() {
    const areaEntries = new Map();
    let total = 0, passed = 0, failed = 0;
    for (const e of this.entries) {
      const area = typeof e?.area === "string" && e.area.trim()
        ? e.area
        : "unknown";
      const areaSummary = areaEntries.get(area) ?? { total: 0, passed: 0 };
      areaSummary.total++;
      if (entryPassed(e)) areaSummary.passed++;
      areaEntries.set(area, areaSummary);
      total++;
      if (entryPassed(e)) passed++; else failed++;
    }
    return {
      total,
      passed,
      failed,
      byArea: Object.fromEntries(areaEntries),
    };
  }

  /** Which areas have the lowest success rate? Those are priority targets. */
  weakestAreas() {
    const s = this.summary();
    return Object.entries(s.byArea)
      .map(([area, v]) => ({ area, rate: v.total > 0 ? v.passed / v.total : 0 }))
      .sort((a, b) => a.rate - b.rate);
  }

  /** Get all entries for a specific improvement id. */
  historyFor(id) {
    return this.entries.filter(e => e.id === id);
  }

  /** Get improvement suggestions based on past failures. */
  suggestPriorities() {
    const weak = this.weakestAreas();
    return weak.filter((entry) => entry.rate < 1).slice(0, 3).map(w => ({
      area: w.area,
      rate: w.rate,
      suggestion: `Focus on ${w.area} improvements (current success rate: ${(w.rate * 100).toFixed(0)}%)`,
    }));
  }
}

// ---------------------------------------------------------------------------
// 4.  SELF-IMPROVEMENT LOOP — autonomous runner
// ---------------------------------------------------------------------------

/**
 * Run a self-improvement loop: scan → pick → build → test → reload → verify → repeat.
 *
 * Key insight: after building an improvement, the agent process must RELOAD so the
 * new module is actually imported and active. Without a reload, improvements sit on
 * disk but never affect the running agent.
 *
 * @param {object} opts
 * @param {string} opts.workspace - workspace root
 * @param {number} opts.maxCycles - how many improvement cycles to run
 * @param {string} [opts.logPath] - path to improvement log file
 * @param {function} [opts.buildFn] - custom build function (candidate, workspace) => changes[]
 * @param {function} [opts.testFn] - custom test function (candidate, changes, workspace) => result
 * @param {function} [opts.reloadFn] - custom reload function (changes, workspace) => {ok, message}
 * @param {function} [opts.verifyFn] - custom verify function (candidate, workspace) => {ok, message}
 * @param {function} [opts.onCycle] - callback(cycleNum, candidate, result) for progress
 * @param {function} [opts.shouldStop] - callback() => boolean to allow early termination
 * @returns {Promise<{cycles: number, results: Array, log: ImprovementLog}>}
 */
export async function runSelfImproveLoop({
  workspace,
  maxCycles = 3,
  logPath = path.join(workspace, ".bantam", "self-improvements.json"),
  buildFn,
  testFn,
  reloadFn,
  verifyFn,
  onCycle,
  shouldStop,
}) {
  const log = new ImprovementLog(logPath);
  const scheduler = new ImprovementScheduler(workspace, { log });
  const results = [];
  const attemptedIds = new Set();

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (shouldStop && shouldStop()) break;

    // Phase 1: Scan for weaknesses
    const candidates = scheduler.rankCandidates(scanWeaknesses(workspace));
    const picked = candidates.find((candidate) => !attemptedIds.has(candidate.id));

    if (!picked) {
      results.push({ cycle, candidate: null, testResult: "no candidates found" });
      break;
    }
    attemptedIds.add(picked.id);

    // Phase 2: Build the improvement
    const changes = buildFn ? await buildFn(picked, workspace) : [];
    if (!Array.isArray(changes)) {
      throw new TypeError("self-improvement buildFn must return an array of changes");
    }

    // Phase 3: Test it (unit / integration tests)
    let testResult;
    try {
      testResult = testFn ? await testFn(picked, changes, workspace) : "skipped";
    } catch (error) {
      testResult = `failed: ${errorMessage(error)}`;
    }
    const testPassed = testResult === "passed" || testResult === true;
    let passed = testPassed && changes.length > 0;

    // Phase 3.5: Reload the agent so the new module is actually active
    let reloadResult = null;
    if (passed && reloadFn) {
      try {
        reloadResult = await reloadFn(changes, workspace);
      } catch (error) {
        reloadResult = { ok: false, message: `Reload failed: ${errorMessage(error)}` };
      }
      passed = reloadResult?.ok === true;
    }

    // Phase 3.7: Verify the reload worked (smoke-test the agent with the new module)
    let verifyResult = null;
    if (passed && reloadResult?.ok && verifyFn) {
      try {
        verifyResult = await verifyFn(picked, workspace);
      } catch (error) {
        verifyResult = { ok: false, message: `Verify failed: ${errorMessage(error)}` };
      }
      passed = verifyResult?.ok === true;
    }

    // Phase 4: Log evidence
    log.record({
      cycle,
      id: picked.id,
      area: picked.area,
      problem: picked.problem,
      proposal: picked.proposal,
      changes: changes.length,
      testPassed,
      passed,
      reloaded: reloadResult?.ok ?? null,
      verified: verifyResult?.ok ?? null,
    });

    results.push({
      cycle,
      candidate: picked,
      changes,
      testResult,
      testPassed,
      passed,
      reloadResult,
      verifyResult,
    });

    if (onCycle) onCycle(cycle, picked, {
      testResult,
      testPassed,
      passed,
      reloadResult,
      verifyResult,
    });
  }

  return { cycles: results.length, results, log };
}

// ---------------------------------------------------------------------------
// 5.  AUTO-TRIGGER — integrate into agent loop
// ---------------------------------------------------------------------------

/**
 * Build a "kick" message that the agent can use to restart its own loop
 * with a self-improvement focus.
 */
export function buildKickMessage(cycle, results, log) {
  const weak = log.weakestAreas();
  const priorities = log.suggestPriorities();

  let msg = `\n[Self-Improve Kick — Cycle ${cycle + 1}]\n`;
  msg += `Completed ${results.length} improvement cycle(s).\n`;

  if (priorities.length > 0) {
    msg += `\nPriority areas (lowest success rate first):\n`;
    for (const p of priorities) {
      msg += `  - ${p.suggestion}\n`;
    }
  }

  if (weak.length > 0) {
    msg += `\nWeakest areas:\n`;
    for (const w of weak) {
      msg += `  - ${w.area}: ${(w.rate * 100).toFixed(0)}% success\n`;
    }
  }

  msg += `\nNext: pick the highest-impact weakness and build an improvement for it.`;
  return msg;
}

// ---------------------------------------------------------------------------
// 6.  CODEBASE INDEX — cached knowledge of own structure
// ---------------------------------------------------------------------------

/**
 * Build or load a cached index of the codebase.
 * Contains: file list, exported symbols per file, dependency graph.
 */
export class CodebaseIndex {
  constructor(workspace) {
    this.workspace = workspace;
    this.cachePath = path.join(workspace, ".bantam-index.json");
    this.index = this._load();
    this._dirty = false;
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      // Validate cache freshness
      const srcMtime = fs.statSync(path.join(this.workspace, "src")).mtimeMs;
      if (data.mtime === srcMtime) return data;
      return null;
    } catch {
      return null;
    }
  }

  save() {
    if (!this._dirty) return;
    this.index.mtime = fs.statSync(path.join(this.workspace, "src")).mtimeMs;
    fs.writeFileSync(this.cachePath, JSON.stringify(this.index, null, 2));
    this._dirty = false;
  }

  /** Build the full index from scratch. */
  build() {
    const srcDir = path.join(this.workspace, "src");
    const files = listFiles(srcDir, /\.js$/);
    const symbols = new Map();
    const deps = new Map();

    for (const f of files) {
      const content = fs.readFileSync(path.join(srcDir, f), "utf8");
      // Extract exports
      const exports = [];
      const exportRe = /export\s+(?:const|function|class|let|var)\s+(\w+)/g;
      let m;
      while ((m = exportRe.exec(content)) !== null) {
        exports.push(m[1]);
      }
      // Extract imports
      const imports = [];
      const importRe = /from\s+["'](\.\.?\/[^"']+)["']/g;
      while ((m = importRe.exec(content)) !== null) {
        imports.push(m[1]);
      }
      symbols.set(f, exports);
      deps.set(f, imports);
    }

    this.index = {
      files,
      symbols: Object.fromEntries(symbols),
      deps: Object.fromEntries(deps),
      mtime: fs.statSync(srcDir).mtimeMs,
      builtAt: Date.now(),
    };
    this._dirty = true;
    return this.index;
  }

  /** Get exported symbols for a file. */
  getSymbols(file) {
    return this.index?.symbols?.[file] ?? [];
  }

  /** Get files that depend on a given file. */
  getDependents(file) {
    if (!this.index?.deps) return [];
    const base = path.basename(file);
    return Object.entries(this.index.deps)
      .filter(([, imports]) => imports.some(i => i.includes(base)))
      .map(([f]) => f);
  }

  /** Find which file exports a given symbol. */
  findSymbol(symbol) {
    if (!this.index?.symbols) return null;
    for (const [file, syms] of Object.entries(this.index.symbols)) {
      if (syms.includes(symbol)) return file;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 7.  TURN ANALYZER — track action efficiency
// ---------------------------------------------------------------------------

export class TurnAnalyzer {
  constructor() {
    this.turns = [];
    this.actionCounts = {};
    this.actionSuccess = {};
    this.readCounts = {};
    this.editRetries = {};
    this.observations = [];
  }

  /** Record a parsed observation from the observation parser. */
  recordObservation(parsed) {
    this.observations.push(parsed);

    // Accumulate test results into actionSuccess tracking
    const data = parsed?.data ?? parsed?.extracted;
    if (data?.tests) {
      const a = data.tests;
      for (let i = 0; i < a.passed; i++) this.actionSuccess["test_pass"] = (this.actionSuccess["test_pass"] || 0) + 1;
      for (let i = 0; i < a.failed; i++) this.actionSuccess["test_fail"] = (this.actionSuccess["test_fail"] || 0) + 1;
    }

    // Accumulate file read stats
    if (data?.totalLines) {
      this.totalLinesRead = (this.totalLinesRead || 0) + data.totalLines;
    }

    // Accumulate search match stats
    if (data?.matchCount) {
      this.totalSearchMatches = (this.totalSearchMatches || 0) + data.matchCount;
    }
  }

  recordTurn(turn) {
    this.turns.push(turn);
    const action = turn.action;
    if (!action) return;

    // Count action types
    this.actionCounts[action.a] = (this.actionCounts[action.a] || 0) + 1;

    // Track reads per file (detect redundant reads)
    if (action.a === "read_file" || action.a === "inspect") {
      const paths = action.a === "inspect"
        ? action.ops?.filter(o => o.a === "read_file").map(o => o.p) ?? []
        : [action.p];
      for (const p of paths) {
        this.readCounts[p] = (this.readCounts[p] || 0) + 1;
      }
    }

    // Track edit attempts per file (detect retries)
    if (action.a === "replace" || action.a === "write_file") {
      const p = action.p;
      this.editRetries[p] = (this.editRetries[p] || 0) + 1;
    }
  }

  /** Find files read more than once (potential wasted turns). */
  redundantReads() {
    return Object.entries(this.readCounts)
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1]);
  }

  /** Find files with the most edit retries. */
  retryHotspots() {
    return Object.entries(this.editRetries)
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1]);
  }

  /** Get action distribution. */
  actionDistribution() {
    return this.actionCounts;
  }

  /** Get efficiency score (0-1, higher is better). */
  efficiencyScore() {
    if (this.turns.length === 0) return 1;
    const reads = Object.values(this.readCounts).reduce((a, b) => a + b, 0);
    const edits = Object.values(this.editRetries).reduce((a, b) => a + b, 0);
    const total = this.turns.length;
    const readRatio = reads / total;
    const editRatio = edits / total;
    // Ideal: ~40% reads, ~30% edits, rest is shell/done/etc
    const readPenalty = Math.abs(readRatio - 0.4) * 2;
    const editPenalty = Math.abs(editRatio - 0.3) * 2;
    return Math.max(0, Math.min(1, 1 - readPenalty - editPenalty));
  }

  /** Generate improvement suggestions based on turn data. */
  suggestImprovements() {
    const suggestions = [];
    const redundant = this.redundantReads();
    if (redundant.length > 0) {
      suggestions.push({
        type: "reduce-redundant-reads",
        message: `${redundant.length} files were read multiple times. Consider caching or using inspect batches.`,
        files: redundant.slice(0, 5).map(([f]) => f),
      });
    }
    const retries = this.retryHotspots();
    if (retries.length > 0) {
      suggestions.push({
        type: "reduce-edit-retries",
        message: `${retries.length} files needed multiple edit attempts. Consider using open_files or more context.`,
        files: retries.slice(0, 5).map(([f]) => f),
      });
    }
    return suggestions;
  }
}

// ---------------------------------------------------------------------------
// 8.  SELF-IMPROVEMENT SCHEDULER — decide what to work on next
// ---------------------------------------------------------------------------

export class ImprovementScheduler {
  constructor(workspace, { log = null } = {}) {
    this.workspace = workspace;
    // Status and scheduling are read-only. Load an existing log, but do not
    // create one merely because somebody inspected the scheduler.
    const canonicalPath = path.join(workspace, ".bantam", "self-improvements.json");
    const legacyPath = path.join(workspace, ".bantam-improvements.json");
    const logPath = fs.existsSync(canonicalPath) || !fs.existsSync(legacyPath)
      ? canonicalPath
      : legacyPath;
    if (log !== null && !(log instanceof ImprovementLog)) {
      throw new TypeError("ImprovementScheduler log must be an ImprovementLog");
    }
    this.log = log ?? new ImprovementLog(logPath, { create: false });
    this.index = new CodebaseIndex(workspace);
  }

  /**
   * Rank currently observable weaknesses using their declared value/cost and
   * the historical failure rate for each area. Current evidence stays
   * authoritative: a prior pass must not permanently hide a weakness that has
   * recurred in the workspace.
   */
  rankCandidates(candidates = scanWeaknesses(this.workspace)) {
    if (!Array.isArray(candidates)) {
      throw new TypeError("improvement candidates must be an array");
    }
    const byArea = this.log.summary().byArea;
    const completed = new Set(this.log.entries.filter(entryPassed).map((entry) => entry.id));
    const scored = candidates.map((candidate) => {
      const stats = byArea[candidate.area];
      const failureRate = stats?.total > 0
        ? (stats.total - stats.passed) / stats.total
        : 0;
      const priority = scoreImprovement({
        ...candidate,
        frequency: candidate.frequency ?? occurrenceWeight(candidate.occurrences),
        severity: candidate.severity ?? candidate.impact,
      }, { completed });
      return {
        ...candidate,
        score: priority.score * (1 + failureRate),
        confidence: priority.confidence,
        prioritySignals: priority.signals,
        evidence: {
          areaFailureRate: failureRate,
          areaSamples: stats?.total ?? 0,
        },
      };
    });
    return deduplicate(scored).sort((a, b) => (
      (b.score - a.score)
      || (b.impact - a.impact)
      || (a.effort - b.effort)
      || a.id.localeCompare(b.id)
    ));
  }

  /**
   * Determine the next improvement to work on.
   * Considers: past failure rates, current codebase state, and priority.
   */
  nextImprovement() {
    return this.rankCandidates()[0] || null;
  }

  /** Generate a status report of self-improvement progress. */
  statusReport() {
    const summary = this.log.summary();
    const weak = this.log.weakestAreas();
    return {
      totalImprovements: this.log.entries.length,
      completed: this.log.entries.filter(entryPassed).length,
      areas: summary,
      weakestAreas: weak,
      nextTarget: this.nextImprovement(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryPassed(entry) {
  if (typeof entry?.passed === "boolean") return entry.passed;
  // Compatibility with logs emitted before `passed` became canonical.
  return entry?.success === true;
}

function jsonSnapshot(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (typeof serialized !== "string") {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  return JSON.parse(serialized);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function occurrenceWeight(occurrences) {
  const count = Number(occurrences);
  if (!Number.isFinite(count) || count <= 1) return 1;
  // Evidence volume matters, but logarithmic scaling prevents a broad signal
  // such as coverage from drowning out every smaller correctness issue.
  return 1 + Math.log2(count);
}

function listFiles(dir, filter) {
  let entries;
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = listFiles(full, filter);
      results.push(...sub.map(f => path.join(path.relative(dir, full), f)));
    } else if (filter.test(entry.name)) {
      results.push(entry.name);
    }
  }
  return results;
}

function extractTestTargets(testFiles, testDir) {
  const targets = new Set();
  for (const f of testFiles) {
    const fullPath = path.join(testDir, f);
    const content = fs.readFileSync(fullPath, "utf8");
    // Match import paths that look like they're testing a module
    const imports = content.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g);
    for (const m of imports) {
      targets.add(path.basename(m[1]));
    }
  }
  return targets;
}

function findRepeatedPatterns(contentMap, minFiles) {
  const patternFiles = new Map();
  for (const [file, content] of contentMap) {
    const lines = content.split("\n");
    const seenInFile = new Set();
    for (let i = 0; i < lines.length - 2; i++) {
      const chunkLines = lines.slice(i, i + 3);
      const chunk = chunkLines.join("\n").trim();
      // Section separators, comments, braces, and import lists are common
      // scaffolding rather than extractable duplicated logic.
      if (chunk.length <= 60 || !chunkLines.every(isSubstantialPatternLine)) continue;
      if (chunkLines.every((line) => line.trimStart().startsWith("import "))) continue;
      seenInFile.add(chunk);
    }
    for (const chunk of seenInFile) {
      if (!patternFiles.has(chunk)) patternFiles.set(chunk, new Set());
      patternFiles.get(chunk).add(file);
    }
  }
  return [...patternFiles.entries()]
    .filter(([, files]) => files.size >= minFiles)
    .map(([pattern, files]) => ({
      pattern: pattern.slice(0, 240),
      files: [...files].sort(),
    }));
}

function isSubstantialPatternLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed)) return false;
  return !/^[{}()[\];,]+$/.test(trimmed);
}

export { listFiles, extractTestTargets };

// ---------------------------------------------------------------------------
// 10.  CLI ENTRY — run self-improvement loop standalone
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspace = process.argv[2] || process.cwd();
  const maxCycles = parseInt(process.argv[3] || "3", 10);

  console.log(`Starting self-improvement loop in ${workspace} (${maxCycles} cycles)`);

  const scheduler = new ImprovementScheduler(workspace);
  const next = scheduler.nextImprovement();

  if (next) {
    console.log(`\nNext improvement: ${next.id}`);
    console.log(`  Area: ${next.area}`);
    console.log(`  Problem: ${next.problem}`);
    console.log(`  Proposal: ${next.proposal}`);
    console.log(`  Effort: ${next.effort}/5, Impact: ${next.impact}/5`);
  } else {
    console.log("No improvements needed right now.");
  }

  const report = scheduler.statusReport();
  console.log(`\nStatus: ${report.totalImprovements} improvements logged`);
  if (report.weakestAreas.length > 0) {
    console.log("Weakest areas:");
    for (const w of report.weakestAreas) {
      console.log(`  - ${w.area}: ${(w.rate * 100).toFixed(0)}% success`);
    }
  }
}
