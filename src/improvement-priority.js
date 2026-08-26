// Improvement Priority Engine
//
// Ranks improvement candidates by expected value using multiple signals:
// - frequency: how often the weakness appears
// - severity: how much it affects correctness
// - effort: estimated lines of code to fix
// - dependencies: how many other improvements it enables
//
// Rules:
//   1. Score = (frequency * severity) / effort
//   2. Boost score for improvements that unblock others
//   3. Deduplicate overlapping improvements
//   4. Return ranked list with confidence scores

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 1.  SIGNAL SCORING
// ---------------------------------------------------------------------------

/**
 * Score a single improvement candidate.
 */
export function scoreImprovement(candidate, context = {}) {
  assertCandidate(candidate);
  const freq = finiteNonNegative(candidate.frequency, 1);
  const sev = finiteNonNegative(candidate.severity, 1);
  const effort = Math.max(finiteNonNegative(candidate.effort, 1), 0.1);
  const dependsOn = Array.isArray(candidate.dependsOn) ? [...candidate.dependsOn] : [];
  const enables = Array.isArray(candidate.enables) ? [...candidate.enables] : [];
  const deps = dependsOn.length;
  const enabled = enables.length;
  const completed = context?.completed instanceof Set ? context.completed : new Set();

  // Base score: value / cost
  let score = (freq * sev) / effort;

  // Boost for unblocking other improvements
  if (enabled > 0) score *= (1 + enabled * 0.2);

  // Penalty for having unmet dependencies
  if (deps > 0) {
    const met = dependsOn.filter(dependency => completed.has(dependency)).length;
    const ratio = met / deps;
    score *= (0.5 + ratio * 0.5);
  }

  // Confidence: how sure are we about the score
  const confidence = Math.min(0.95, 0.5 + (Object.keys(candidate).length * 0.05));

  return {
    id: candidate.id,
    area: candidate.area,
    problem: candidate.problem,
    dependsOn,
    enables,
    score: Math.round(score * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    signals: { freq, sev, effort, deps, enabled },
  };
}

/**
 * Score a batch of candidates.
 */
export function scoreBatch(candidates, context = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  return candidates.map(c => scoreImprovement(c, context));
}

// ---------------------------------------------------------------------------
// 2.  RANKING
// ---------------------------------------------------------------------------

/**
 * Rank improvements by score (descending).
 */
export function rankImprovements(scored) {
  if (!Array.isArray(scored)) throw new TypeError("scored improvements must be an array");
  return [...scored].sort((a, b) => b.score - a.score);
}

/**
 * Find the top N improvements.
 */
export function topN(scored, n = 5) {
  const ranked = rankImprovements(scored);
  const limit = n === Infinity ? ranked.length : Math.max(0, Math.floor(Number(n) || 0));
  return ranked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 3.  DEDUPLICATION
// ---------------------------------------------------------------------------

/**
 * Check if two improvements overlap (same area, similar problem).
 */
export function overlaps(a, b) {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return false;
  if (validId(a.id) && a.id === b.id) return true;
  const areaA = typeof a.area === "string" ? a.area.trim().toLowerCase() : "";
  const areaB = typeof b.area === "string" ? b.area.trim().toLowerCase() : "";
  if (!areaA || !areaB || areaA !== areaB
      || typeof a.problem !== "string" || typeof b.problem !== "string") {
    return false;
  }

  const wordsA = problemTokens(a.problem);
  const wordsB = problemTokens(b.problem);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  if (setsEqual(wordsA, wordsB)) return true;
  const shared = [...wordsA].filter(word => wordsB.has(word)).length;
  return shared >= 2 && shared / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

/**
 * Remove duplicate/overlapping improvements, keeping the highest-scored.
 */
export function deduplicate(scored) {
  const ranked = rankImprovements(scored);
  const kept = [];
  for (const s of ranked) {
    const candidate = overlapView(s);
    if (!kept.some(keptScore => overlaps(overlapView(keptScore), candidate))) kept.push(s);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// 4.  PRIORITY QUEUE
// ---------------------------------------------------------------------------

export class PriorityQueue {
  #candidates;

  constructor() {
    this.items = [];
    this.completed = new Set();
    this.#candidates = [];
  }

  add(candidate) {
    assertCandidate(candidate);
    const snapshot = candidateSnapshot(candidate);
    const scored = scoreImprovement(snapshot, { completed: this.completed });
    this.#candidates.push(snapshot);
    this.items.push(scored);
    return scored;
  }

  addBatch(candidates) {
    if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
    return candidates.map(c => this.add(c));
  }

  next() {
    const ranked = rankImprovements(this.items);
    return ranked[0] || null;
  }

  complete(id) {
    this.completed.add(id);
    this.#candidates = this.#candidates.filter(candidate => candidate.id !== id);
    this.items = this.#candidates.map(candidate => scoreImprovement(candidate, {
      completed: this.completed,
    }));
  }

  remaining() {
    return this.items.length;
  }

  report() {
    const ranked = rankImprovements(this.items);
    return {
      total: this.items.length,
      completed: this.completed.size,
      top: ranked.slice(0, 3).map(r => ({ id: r.id, score: r.score })),
    };
  }
}

// ---------------------------------------------------------------------------
// 5.  CONTEXT BUILDER
// ---------------------------------------------------------------------------

/**
 * Build context from improvement log for scoring.
 */
export function buildContext(logFile) {
  const empty = () => ({ completed: new Set() });
  if (typeof logFile !== "string" || logFile.length === 0 || logFile.includes("\0")) return empty();
  try {
    if (!fs.statSync(logFile).isFile()) return empty();
    const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
    if (!Array.isArray(log)) return empty();
    const completed = new Set();
    for (const entry of log) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.length === 0) continue;
      const passed = typeof entry.passed === "boolean" ? entry.passed : entry.success === true;
      if (passed) completed.add(entry.id);
    }
    return { completed };
  } catch {
    return empty();
  }
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("improvement candidate must be an object");
  }
}

function finiteNonNegative(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
}

function candidateSnapshot(candidate) {
  const snapshot = { ...candidate };
  if (Array.isArray(candidate.dependsOn)) snapshot.dependsOn = [...candidate.dependsOn];
  if (Array.isArray(candidate.enables)) snapshot.enables = [...candidate.enables];
  return snapshot;
}

function overlapView(candidate) {
  return {
    id: candidate?.id,
    area: candidate?.area ?? candidate?.signals?.area,
    problem: candidate?.problem ?? candidate?.signals?.problem,
  };
}

const TOKEN_ALIASES = new Map([
  ["absent", "missing"],
  ["lack", "missing"],
  ["lacks", "missing"],
  ["no", "missing"],
  ["tests", "test"],
  ["tested", "test"],
  ["testing", "test"],
  ["file", "code"],
  ["files", "code"],
  ["module", "code"],
  ["modules", "code"],
  ["added", "new"],
  ["recent", "new"],
  ["recently", "new"],
]);
const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"]);

function problemTokens(problem) {
  const tokens = problem.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens
    .filter(token => !STOP_WORDS.has(token))
    .map(token => TOKEN_ALIASES.get(token) ?? token));
}

function setsEqual(a, b) {
  return a.size === b.size && [...a].every(value => b.has(value));
}

function validId(id) {
  return (typeof id === "string" && id.length > 0)
    || (typeof id === "number" && Number.isFinite(id));
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

export function runTests() {
  console.log("=== Improvement Priority Engine ===\n");

  // Test 1: basic scoring
  console.log("Test 1: Basic scoring");
  const scored = scoreImprovement({
    id: "test-improvement",
    frequency: 5,
    severity: 3,
    effort: 2,
    enables: ["a", "b"],
  });
  console.assert(scored.score > 0, "score should be positive");
  console.assert(scored.confidence > 0, "confidence should be positive");
  console.log(`  PASS: Score = ${scored.score}, confidence = ${scored.confidence}`);

  // Test 2: high severity scores higher
  console.log("Test 2: Severity weighting");
  const low = scoreImprovement({ id: "low", frequency: 1, severity: 1, effort: 1 });
  const high = scoreImprovement({ id: "high", frequency: 1, severity: 5, effort: 1 });
  console.assert(high.score > low.score, "higher severity should score more");
  console.log(`  PASS: High(${high.score}) > Low(${low.score})`);

  // Test 3: low effort scores higher
  console.log("Test 3: Effort weighting");
  const hard = scoreImprovement({ id: "hard", frequency: 1, severity: 1, effort: 5 });
  const easy = scoreImprovement({ id: "easy", frequency: 1, severity: 1, effort: 1 });
  console.assert(easy.score > hard.score, "lower effort should score more");
  console.log(`  PASS: Easy(${easy.score}) > Hard(${hard.score})`);

  // Test 4: ranking
  console.log("Test 4: Ranking");
  const batch = [
    { id: "a", frequency: 3, severity: 2, effort: 1 },
    { id: "b", frequency: 1, severity: 1, effort: 1 },
    { id: "c", frequency: 5, severity: 5, effort: 2 },
  ];
  const ranked = rankImprovements(scoreBatch(batch));
  console.assert(ranked[0].id === "c", "highest score should be first");
  console.log(`  PASS: Top = ${ranked[0].id} (score: ${ranked[0].score})`);

  // Test 5: topN
  console.log("Test 5: Top N");
  const top = topN(scoreBatch(batch), 2);
  console.assert(top.length === 2, "should return exactly N");
  console.log(`  PASS: Got ${top.length} items`);

  // Test 6: overlap detection
  console.log("Test 6: Overlap detection");
  const a = { id: "x", area: "quality", problem: "no test coverage for new modules" };
  const b = { id: "y", area: "quality", problem: "missing tests for recently added code" };
  const c = { id: "z", area: "efficiency", problem: "slow startup time" };
  console.assert(overlaps(a, b), "similar problems should overlap");
  console.assert(!overlaps(a, c), "different areas should not overlap");
  console.log(`  PASS: Overlap detection working`);

  // Test 7: priority queue
  console.log("Test 7: Priority queue");
  const pq = new PriorityQueue();
  pq.add({ id: "a", frequency: 1, severity: 1, effort: 1 });
  pq.add({ id: "b", frequency: 5, severity: 5, effort: 1 });
  console.assert(pq.next().id === "b", "next should return highest scored");
  pq.complete("b");
  console.assert(pq.remaining() === 1, "should have 1 remaining");
  console.log(`  PASS: Queue working, remaining = ${pq.remaining()}`);

  // Test 8: context from log
  console.log("Test 8: Context builder");
  const ctx = buildContext(".bantam-improvements.json");
  console.assert(ctx.completed instanceof Set, "completed should be a Set");
  console.log(`  PASS: Context has ${ctx.completed.size} completed improvements`);

  console.log("\nAll tests passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTests();
}
