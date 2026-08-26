import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  scanWeaknesses,
  ImprovementLog,
  runSelfImproveLoop,
  CodebaseIndex,
  TurnAnalyzer,
  FailurePatternLearner,
  ImprovementScheduler,
  buildKickMessage,
} from "../src/self-improve.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-test-"));
fs.mkdirSync(path.join(workspace, "src"));
fs.mkdirSync(path.join(workspace, "test"));
fs.writeFileSync(
  path.join(workspace, "src", "self-improve.js"),
  "export function inspectWorkspace() { return true; }\n",
);
fs.writeFileSync(
  path.join(workspace, "test", "self-improve.test.js"),
  'import "../src/self-improve.js";\n',
);
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// scanWeaknesses
// ---------------------------------------------------------------------------

describe("scanWeaknesses", () => {
  it("returns an array of candidates", () => {
    const candidates = scanWeaknesses(workspace);
    assert.ok(Array.isArray(candidates));
  });

  it("each candidate has required fields", () => {
    const candidates = scanWeaknesses(workspace);
    for (const c of candidates) {
      assert.ok(typeof c.id === "string");
      assert.ok(typeof c.area === "string");
      assert.ok(typeof c.problem === "string");
      assert.ok(typeof c.proposal === "string");
      assert.ok(typeof c.effort === "number" && c.effort >= 1 && c.effort <= 5);
      assert.ok(typeof c.impact === "number" && c.impact >= 1 && c.impact <= 5);
    }
  });

  it("detects untested files when many exist", () => {
    const candidates = scanWeaknesses(workspace);
    const testCov = candidates.find(c => c.id === "test-coverage");
    if (testCov) {
      assert.ok(testCov.problem.includes("no direct test import"));
    }
  });

  it("detects large files", () => {
    const candidates = scanWeaknesses(workspace);
    const large = candidates.find(c => c.id === "split-large-files");
    if (large) {
      assert.ok(large.problem.includes("500 lines"));
    }
  });
});

// ---------------------------------------------------------------------------
// ImprovementLog
// ---------------------------------------------------------------------------

describe("ImprovementLog", () => {
  const tmpLog = path.join(workspace, ".bantam-test-log.json");

  it("creates a new log file if missing", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    assert.ok(fs.existsSync(tmpLog));
    assert.deepStrictEqual(log.entries, []);
  });

  it("records an entry and persists it", () => {
    const log = new ImprovementLog(tmpLog);
    log.record({ cycle: 0, id: "test-id", area: "reliability", problem: "x", proposal: "y", changes: 1, passed: true, reloaded: true, verified: true });
    assert.strictEqual(log.entries.length, 1);
    assert.strictEqual(log.entries[0].id, "test-id");
  });

  it("summary returns correct counts", () => {
    const log = new ImprovementLog(tmpLog);
    const summary = log.summary();
    assert.ok(typeof summary.total === "number");
    assert.ok(typeof summary.passed === "number");
    assert.ok(typeof summary.failed === "number");
  });

  it("weakestAreas returns areas sorted by success rate", () => {
    const log = new ImprovementLog(tmpLog);
    const weak = log.weakestAreas();
    assert.ok(Array.isArray(weak));
  });

  it("suggestPriorities returns suggestions", () => {
    const log = new ImprovementLog(tmpLog);
    const prios = log.suggestPriorities();
    assert.ok(Array.isArray(prios));
  });

  // Cleanup
  after(() => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  });
});

// ---------------------------------------------------------------------------
// runSelfImproveLoop
// ---------------------------------------------------------------------------

describe("runSelfImproveLoop", () => {
  it("runs cycles and returns results", async () => {
    const { cycles, results } = await runSelfImproveLoop({
      workspace,
      maxCycles: 2,
      buildFn: () => [{ file: "test", change: "mock" }],
      testFn: () => "passed",
      reloadFn: () => ({ ok: true }),
      verifyFn: () => ({ ok: true }),
    });
    assert.strictEqual(cycles, 2);
    assert.strictEqual(results.length, 2);
  });

  it("stops early when shouldStop returns true", async () => {
    const { cycles } = await runSelfImproveLoop({
      workspace,
      maxCycles: 5,
      buildFn: () => [],
      testFn: () => "passed",
      shouldStop: () => true,
    });
    assert.strictEqual(cycles, 0);
  });

  it("skips reload/verify when test fails", async () => {
    const { results } = await runSelfImproveLoop({
      workspace,
      maxCycles: 1,
      buildFn: () => [{ file: "x", change: "y" }],
      testFn: () => "failed",
      reloadFn: () => ({ ok: true }),
      verifyFn: () => ({ ok: true }),
    });
    assert.ok(results[0].reloadResult === null);
    assert.ok(results[0].verifyResult === null);
  });
});

// ---------------------------------------------------------------------------
// CodebaseIndex
// ---------------------------------------------------------------------------

describe("CodebaseIndex", () => {
  it("builds an index of the workspace", () => {
    const idx = new CodebaseIndex(workspace);
    idx.build();
    assert.ok(typeof idx.index === "object");
  });

  it("finds symbols for a known file", () => {
    const idx = new CodebaseIndex(workspace);
    idx.build();
    const syms = idx.getSymbols("self-improve.js");
    assert.ok(Array.isArray(syms));
  });

  it("finds dependents for a file", () => {
    const idx = new CodebaseIndex(workspace);
    idx.build();
    const deps = idx.getDependents("self-improve.js");
    assert.ok(Array.isArray(deps));
  });

  it("findSymbol returns null for unknown symbol", () => {
    const idx = new CodebaseIndex(workspace);
    idx.build();
    assert.strictEqual(idx.findSymbol("__nonexistent_symbol__"), null);
  });
});

// ---------------------------------------------------------------------------
// TurnAnalyzer
// ---------------------------------------------------------------------------

describe("TurnAnalyzer", () => {
  it("tracks action counts", () => {
    const ta = new TurnAnalyzer();
    ta.recordTurn({ action: { a: "read_file", p: "foo.js" } });
    ta.recordTurn({ action: { a: "read_file", p: "bar.js" } });
    ta.recordTurn({ action: { a: "replace", p: "foo.js" } });
    assert.strictEqual(ta.actionDistribution().read_file, 2);
    assert.strictEqual(ta.actionDistribution().replace, 1);
  });

  it("detects redundant reads", () => {
    const ta = new TurnAnalyzer();
    ta.recordTurn({ action: { a: "read_file", p: "foo.js" } });
    ta.recordTurn({ action: { a: "read_file", p: "foo.js" } });
    ta.recordTurn({ action: { a: "read_file", p: "bar.js" } });
    const redundant = ta.redundantReads();
    assert.ok(redundant.some(([f]) => f === "foo.js"));
  });

  it("detects retry hotspots", () => {
    const ta = new TurnAnalyzer();
    ta.recordTurn({ action: { a: "replace", p: "foo.js" } });
    ta.recordTurn({ action: { a: "replace", p: "foo.js" } });
    ta.recordTurn({ action: { a: "replace", p: "bar.js" } });
    const hotspots = ta.retryHotspots();
    assert.ok(hotspots.some(([f]) => f === "foo.js"));
  });

  it("efficiencyScore returns a value between 0 and 1", () => {
    const ta = new TurnAnalyzer();
    ta.recordTurn({ action: { a: "read_file", p: "a.js" } });
    ta.recordTurn({ action: { a: "replace", p: "a.js" } });
    ta.recordTurn({ action: { a: "shell", c: "test" } });
    const score = ta.efficiencyScore();
    assert.ok(score >= 0 && score <= 1);
  });

  it("suggestImprovements returns actionable suggestions", () => {
    const ta = new TurnAnalyzer();
    ta.recordTurn({ action: { a: "read_file", p: "x.js" } });
    ta.recordTurn({ action: { a: "read_file", p: "x.js" } });
    ta.recordTurn({ action: { a: "replace", p: "x.js" } });
    ta.recordTurn({ action: { a: "replace", p: "x.js" } });
    const suggestions = ta.suggestImprovements();
    assert.ok(Array.isArray(suggestions));
  });

  it("recordObservation accumulates test pass/fail counts", () => {
    const ta = new TurnAnalyzer();
    ta.recordObservation({ category: "test_output", data: { tests: { passed: 5, failed: 2 } } });
    assert.strictEqual(ta.actionSuccess["test_pass"], 5);
    assert.strictEqual(ta.actionSuccess["test_fail"], 2);
  });

  it("recordObservation accumulates totalLinesRead", () => {
    const ta = new TurnAnalyzer();
    ta.recordObservation({ category: "file_read", data: { totalLines: 100 } });
    ta.recordObservation({ category: "file_read", data: { totalLines: 50 } });
    assert.strictEqual(ta.totalLinesRead, 150);
  });

  it("recordObservation accumulates totalSearchMatches", () => {
    const ta = new TurnAnalyzer();
    ta.recordObservation({ category: "search_result", data: { matchCount: 3 } });
    ta.recordObservation({ category: "search_result", data: { matchCount: 7 } });
    assert.strictEqual(ta.totalSearchMatches, 10);
  });

  it("recordObservation stores parsed observations in history", () => {
    const ta = new TurnAnalyzer();
    const parsed = { category: "shell_output", signals: { hasSuccess: true } };
    ta.recordObservation(parsed);
    assert.strictEqual(ta.observations.length, 1);
    assert.strictEqual(ta.observations[0].signals.hasSuccess, true);
  });

  it("recordObservation handles null/undefined parsed data", () => {
    const ta = new TurnAnalyzer();
    ta.recordObservation(null);
    ta.recordObservation(undefined);
    assert.strictEqual(ta.observations.length, 2);
  });
});

// ---------------------------------------------------------------------------
// ImprovementLog — recordObservation
// ---------------------------------------------------------------------------

describe("ImprovementLog.recordObservation", () => {
  const tmpLog = path.join(workspace, ".bantam-test-log-obs.json");

  it("records test outcomes as evidence entries on passed tests", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    log.recordObservation({ category: "test_output", data: { tests: { passed: 10, failed: 0 } } });
    assert.ok(log.entries.length >= 1);
    const entry = log.entries.find(e => e.id === "test-run");
    assert.ok(entry);
    assert.strictEqual(entry.passed, true);
    assert.ok(entry.detail.includes("10"));
  });

  it("records test outcomes as evidence entries on failed tests", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    log.recordObservation({ category: "test_output", data: { tests: { passed: 8, failed: 3 } } });
    const entry = log.entries.find(e => e.id === "test-run");
    assert.ok(entry);
    assert.strictEqual(entry.passed, false);
    assert.ok(entry.detail.includes("3"));
  });

  it("stores parsed observations in observations array", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    const parsed = { category: "file_read", data: { totalLines: 200 } };
    log.recordObservation(parsed);
    assert.strictEqual(log.observations.length, 1);
    assert.strictEqual(log.observations[0].category, "file_read");
  });

  it("handles null parsed data gracefully", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    log.recordObservation(null);
    assert.strictEqual(log.observations.length, 1);
  });

  it("multiple observations accumulate without overwriting", () => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    const log = new ImprovementLog(tmpLog);
    log.recordObservation({ category: "test_output", data: { tests: { passed: 5, failed: 0 } } });
    log.recordObservation({ category: "file_read", data: { totalLines: 100 } });
    assert.strictEqual(log.observations.length, 2);
  });
});

// ---------------------------------------------------------------------------
// FailurePatternLearner
// ---------------------------------------------------------------------------

describe("FailurePatternLearner", () => {
  const tmpPatterns = path.join(workspace, ".bantam-test-patterns.json");

  it("initializes with empty patterns", () => {
    if (fs.existsSync(tmpPatterns)) fs.unlinkSync(tmpPatterns);
    const learner = new FailurePatternLearner(workspace);
    // Override patternsPath for test isolation
    learner.patternsPath = tmpPatterns;
    learner.patterns = { patterns: [], lessons: [] };
    assert.strictEqual(learner.patterns.patterns.length, 0);
  });

  it("records and retrieves a pattern", () => {
    const learner = new FailurePatternLearner(workspace);
    learner.patternsPath = tmpPatterns;
    learner.patterns = { patterns: [], lessons: [] };
    learner.recordPattern({ task: "build UI", failure: "timeout", rootCause: "slow render", lesson: "Add timeout guards to render loops" });
    assert.strictEqual(learner.patterns.patterns.length, 1);
    assert.strictEqual(learner.patterns.lessons.length, 1);
  });

  it("relevantLessons filters by keyword", () => {
    const learner = new FailurePatternLearner(workspace);
    learner.patternsPath = tmpPatterns;
    learner.patterns = { patterns: [], lessons: ["Add timeout guards", "Use caching for reads"] };
    const relevant = learner.relevantLessons("timeout render");
    assert.ok(relevant.some(l => l.includes("timeout")));
  });

  it("asPromptNudge returns formatted string", () => {
    const learner = new FailurePatternLearner(workspace);
    learner.patternsPath = tmpPatterns;
    learner.patterns = { patterns: [], lessons: ["Always test first"] };
    const nudge = learner.asPromptNudge("test");
    assert.ok(nudge.includes("Always test first"));
  });

  it("stats returns pattern counts", () => {
    const learner = new FailurePatternLearner(workspace);
    learner.patternsPath = tmpPatterns;
    learner.patterns = { patterns: [{}, {}], lessons: ["a", "b", "c"] };
    const stats = learner.stats();
    assert.strictEqual(stats.totalPatterns, 2);
    assert.strictEqual(stats.totalLessons, 3);
  });

  after(() => {
    if (fs.existsSync(tmpPatterns)) fs.unlinkSync(tmpPatterns);
  });
});

// ---------------------------------------------------------------------------
// ImprovementScheduler
// ---------------------------------------------------------------------------

describe("ImprovementScheduler", () => {
  it("returns a next improvement candidate", () => {
    const scheduler = new ImprovementScheduler(workspace);
    const next = scheduler.nextImprovement();
    assert.ok(next !== null);
    if (next) {
      assert.ok(typeof next.id === "string");
      assert.ok(typeof next.area === "string");
    }
  });

  it("statusReport returns summary object", () => {
    const scheduler = new ImprovementScheduler(workspace);
    const report = scheduler.statusReport();
    assert.ok(typeof report === "object");
    assert.ok(typeof report.completed === "number");
  });
});

// ---------------------------------------------------------------------------
// buildKickMessage
// ---------------------------------------------------------------------------

describe("buildKickMessage", () => {
  it("returns a non-empty string", () => {
    const msg = buildKickMessage(0, [{ cycle: 0 }], { weakestAreas: () => [], suggestPriorities: () => [] });
    assert.ok(msg.length > 0);
    assert.ok(msg.includes("Self-Improve Kick"));
  });
});
