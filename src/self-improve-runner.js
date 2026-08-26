#!/usr/bin/env node
// Self-improvement loop runner: scan → pick → build → test → integrate → repeat
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  scanWeaknesses,
  ImprovementLog,
  ImprovementScheduler,
  buildKickMessage,
} from "./self-improve.js";

const DEFAULT_MAX_CYCLES = 10;

// ── Build functions for known improvement types ────────────────────────────
// Every entry here writes a PREDETERMINED stub. The loop proposes a mechanism,
// runs the matching builder, and marks it done -- so "self-improvement" produced
// canned scaffolding rather than working code. Six of those stubs were removed on
// 2026-07-31 after measuring that nothing imported them and, in one case
// (turn-parallelism), that the shelved module had been reporting a wrong number
// for weeks. A builder whose proposal has been removed never fires, which is why
// deleting the proposal is what stops regeneration.
const BUILDERS = {
  "turn-efficiency": buildMetricsTracker,
  "edit-metrics": buildEditMetrics,
  "action-efficiency": buildActionEfficiency,
  "prompt-optimization": buildPromptTracker,
  "self-benchmark": buildBenchmarkSuite,
  "failure-learning": buildFailureDB,
  "codebase-index": buildIndexEnhancement,
  "error-handling": buildErrorHandler,
  "prompt-rules": buildPromptRules,
  "context-budgeting": buildContextBudgeting,
  "action-decision-tree": buildActionDecisionTree,
  "completion-confidence": buildCompletionConfidence,
  "cross-file-patterns": buildCrossFilePatterns,
  "skill-discovery": buildSkillDiscovery,
  "prompt-compression": buildPromptCompression,
  "task-decomposition": buildTaskDecomposition,
  "tool-feedback": buildToolFeedback,
};

// ── Build: Metrics Tracker (turn-efficiency) ───────────────────────────────
async function buildMetricsTracker(candidate, ws) {
  const p = path.join(ws, "src/metrics.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Turn-efficiency metrics: track turns-per-task, actions taken, success rate",
    "export class MetricsTracker {",
    "  constructor() {",
    "    this.tasks = [];",
    "    this.turns = [];",
    "    this.actions = {};",
    "    this.startTime = Date.now();",
    "  }",
    "  recordTurn(actionType, success, duration) {",
    "    this.turns.push({ action: actionType, success, duration, ts: Date.now() });",
    "    this.actions[actionType] = (this.actions[actionType] || 0) + 1;",
    "  }",
    "  recordTask(taskType, turnsUsed, success) {",
    "    this.tasks.push({ type: taskType, turns: turnsUsed, success, ts: Date.now() });",
    "  }",
    "  summary() {",
    "    const totalTurns = this.turns.length;",
    "    const successRate = totalTurns > 0 ? this.turns.filter(t => t.success).length / totalTurns : 0;",
    "    const avgDuration = totalTurns > 0 ? this.turns.reduce((s, t) => s + (t.duration || 0), 0) / totalTurns : 0;",
    "    return {",
    "      totalTurns,",
    "      successRate: +(successRate * 100).toFixed(1),",
    "      avgDurationMs: +avgDuration.toFixed(0),",
    "      actionDistribution: this.actions,",
    "      tasksCompleted: this.tasks.length,",
    "      taskSuccessRate: this.tasks.length > 0",
    "        ? (this.tasks.filter(t => t.success).length / this.tasks.length * 100).toFixed(1)",
    "        : 0,",
    "    };",
    "  }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Edit Metrics ────────────────────────────────────────────────────
async function buildEditMetrics(candidate, ws) {
  const p = path.join(ws, "src/edit-metrics.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Edit success tracking: first-try vs retries, mismatch patterns",
    "export class EditMetrics {",
    "  constructor() {",
    "    this.attempts = [];",
    "    this.fileStats = {};",
    "  }",
    "  recordAttempt(file, action, success, retryCount) {",
    "    this.attempts.push({ file, action, success, retryCount, ts: Date.now() });",
    "    if (!this.fileStats[file]) this.fileStats[file] = { total: 0, success: 0, retries: 0 };",
    "    this.fileStats[file].total++;",
    "    if (success) this.fileStats[file].success++;",
    "    if (retryCount > 0) this.fileStats[file].retries += retryCount;",
    "  }",
    "  firstTrySuccessRate() {",
    "    const firstTry = this.attempts.filter(a => a.retryCount === 0);",
    "    if (firstTry.length === 0) return 0;",
    "    return (firstTry.filter(a => a.success).length / firstTry.length) * 100;",
    "  }",
    "  hotspots() {",
    "    return Object.entries(this.fileStats)",
    "      .filter(([, s]) => s.retries > 0)",
    "      .sort(([, a], [, b]) => b.retries - a.retries)",
    "      .slice(0, 5);",
    "  }",
    "  summary() {",
    "    return {",
    "      totalAttempts: this.attempts.length,",
    "      firstTryRate: +(this.firstTrySuccessRate()).toFixed(1),",
    "      fileStats: this.fileStats,",
    "      hotspots: this.hotspots(),",
    "    };",
    "  }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Action Efficiency ───────────────────────────────────────────────
async function buildActionEfficiency(candidate, ws) {
  const p = path.join(ws, "src/action-efficiency.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Action efficiency: track which actions are most/least effective",
    "export class ActionEfficiency {",
    "  constructor() {",
    "    this.actions = {};",
    "    this.turns = [];",
    "  }",
    "  record(actionType, success, duration, context) {",
    "    if (!this.actions[actionType]) this.actions[actionType] = { count: 0, success: 0, totalDuration: 0 };",
    "    this.actions[actionType].count++;",
    "    if (success) this.actions[actionType].success++;",
    "    this.actions[actionType].totalDuration += duration || 0;",
    "    this.turns.push({ action: actionType, success, duration, context, ts: Date.now() });",
    "  }",
    "  distribution() {",
    "    return Object.fromEntries(",
    "      Object.entries(this.actions).map(([k, v]) => [k, {",
    "        count: v.count,",
    "        successRate: +((v.success / v.count) * 100).toFixed(1),",
    "        avgDuration: +(v.totalDuration / v.count).toFixed(0),",
    "      }])",
    "    );",
    "  }",
    "  wastedTurns() {",
    "    return this.turns.filter(t => !t.success).length;",
    "  }",
    "  summary() {",
    "    return {",
    "      distribution: this.distribution(),",
    "      wastedTurns: this.wastedTurns(),",
    "      totalTurns: this.turns.length,",
    "    };",
    "  }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Prompt Tracker ──────────────────────────────────────────────────
async function buildPromptTracker(candidate, ws) {
  const p = path.join(ws, "src/prompt-tracker.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Rule-ablation tracker: measure pass-rate delta per prompt rule",
    "export class PromptTracker {",
    "  constructor() {",
    "    this.rules = {};",
    "    this.runs = [];",
    "  }",
    "  registerRule(name, description) {",
    "    this.rules[name] = { description, withRule: 0, withoutRule: 0, withSuccess: 0, withoutSuccess: 0 };",
    "  }",
    "  recordRun(ruleName, included, success) {",
    "    if (!this.rules[ruleName]) this.rules[ruleName] = { description: '', withRule: 0, withoutRule: 0, withSuccess: 0, withoutSuccess: 0 };",
    "    const r = this.rules[ruleName];",
    "    if (included) { r.withRule++; if (success) r.withSuccess++; }",
    "    else { r.withoutRule++; if (success) r.withoutSuccess++; }",
    "    this.runs.push({ rule: ruleName, included, success, ts: Date.now() });",
    "  }",
    "  delta(ruleName) {",
    "    const r = this.rules[ruleName];",
    "    if (!r) return null;",
    "    const withRate = r.withRule > 0 ? r.withSuccess / r.withRule : 0;",
    "    const withoutRate = r.withoutRule > 0 ? r.withoutSuccess / r.withoutRule : 0;",
    "    return { rule: ruleName, withRate: +(withRate*100).toFixed(1), withoutRate: +(withoutRate*100).toFixed(1), delta: +((withRate-withoutRate)*100).toFixed(1) };",
    "  }",
    "  summary() {",
    "    return Object.fromEntries(",
    "      Object.keys(this.rules).map(k => [k, this.delta(k)])",
    "    );",
    "  }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Benchmark Suite ────────────────────────────────────────────────
export async function buildBenchmarkSuite(candidate, ws) {
  const p = path.join(ws, "src/benchmark.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  // Reuse the tested implementation instead of maintaining a second source
  // template that silently drifts behind fixes in benchmark.js.
  const code = fs.readFileSync(new URL("./benchmark.js", import.meta.url), "utf8");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Failure DB ──────────────────────────────────────────────────────
async function buildFailureDB(candidate, ws) {
  const p = path.join(ws, "src/failure-db.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Failure pattern database with persistence and retrieval",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "export class FailureDB {",
    "  constructor(ws) {",
    "    this.path = path.join(ws, '.bantam-failure-db.json');",
    "    this.db = this._load();",
    "  }",
    "  _load() { try { return JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { return { entries: [], lessons: [] }; } }",
    "  _save() { fs.writeFileSync(this.path, JSON.stringify(this.db, null, 2)); }",
    "  add(task, failure, rootCause, lesson) {",
    "    this.db.entries.push({ task: task.slice(0,200), failure: failure.slice(0,500), rootCause: rootCause.slice(0,200), lesson: lesson.slice(0,500), ts: Date.now() });",
    "    if (lesson) this.db.lessons.push(lesson.slice(0,200));",
    "    this._save();",
    "  }",
    "  query(task) {",
    "    if (!task) return this.db.lessons.slice(-5);",
    "    const kw = task.toLowerCase().split(/\\s+/);",
    "    return this.db.lessons.filter(l => kw.some(w => l.toLowerCase().includes(w))).slice(-5);",
    "  }",
    "  summary() { return { total: this.db.entries.length, lessons: this.db.lessons.length }; }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Index Enhancement ───────────────────────────────────────────────
async function buildIndexEnhancement(candidate, ws) {
  const p = path.join(ws, "src/index-enhanced.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Enhanced codebase index with symbol resolution and dependency graph",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "export class EnhancedIndex {",
    "  constructor(ws) { this.ws = ws; this.index = {}; }",
    "  build() {",
    "    const src = path.join(this.ws, 'src');",
    "    const files = this._list(src);",
    "    const symbols = {};",
    "    const deps = {};",
    "    for (const f of files) {",
    "      const content = fs.readFileSync(path.join(src, f), 'utf8');",
    "      symbols[f] = [...content.matchAll(/export\\s+(?:const|function|class)\\s+(\\w+)/g)].map(m => m[1]);",
    "      deps[f] = [...content.matchAll(/from\\s+[\"'](.+?)[\"']/g)].map(m => m[1]);",
    "    }",
    "    this.index = { files, symbols, deps, ts: Date.now() };",
    "    return this.index;",
    "  }",
    "  _list(dir) {",
    "    if (!fs.existsSync(dir)) return [];",
    "    const r = [];",
    "    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {",
    "      const full = path.join(dir, e.name);",
    "      if (e.isDirectory()) r.push(...this._list(full).map(f => path.relative(dir, full) + '/' + f));",
    "      else if (/\\.js$/.test(e.name)) r.push(e.name);",
    "    }",
    "    return r;",
    "  }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Error Handler ───────────────────────────────────────────────────
async function buildErrorHandler(candidate, ws) {
  const p = path.join(ws, "src/error-handling.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Error handling utilities with meaningful diagnostics",
    "export class ErrorHandler {",
    "  constructor() { this.errors = []; }",
    "  wrap(fn, label) {",
    "    return async (...args) => {",
    "      try { const r = await fn(...args); return { ok: true, data: r }; }",
    "      catch (e) {",
    "        const err = { label, message: e.message, ts: Date.now() };",
    "        this.errors.push(err);",
    "        return { ok: false, error: err };",
    "      }",
    "    };",
    "  }",
    "  summary() { return { total: this.errors.length, errors: this.errors.slice(-10) }; }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Prompt Rules ────────────────────────────────────────────────────
async function buildPromptRules(candidate, ws) {
  const p = path.join(ws, "src/prompt-rules.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];

  const code = [
    "// Prompt rule management and optimization",
    "export class PromptRules {",
    "  constructor() { this.rules = []; this.active = new Set(); }",
    "  add(name, rule, priority = 0) { this.rules.push({ name, rule, priority, hits: 0, helps: 0 }); }",
    "  activate(name) { this.active.add(name); }",
    "  deactivate(name) { this.active.delete(name); }",
    "  recordHit(name, helped) {",
    "    const r = this.rules.find(r => r.name === name);",
    "    if (r) { r.hits++; if (helped) r.helps++; }",
    "  }",
    "  effectiveness() {",
    "    return Object.fromEntries(this.rules.map(r => [r.name, r.hits > 0 ? +(r.helps/r.hits*100).toFixed(1) : 0]));",
    "  }",
    "  summary() { return { total: this.rules.length, active: this.active.size, effectiveness: this.effectiveness() }; }",
    "}",
  ].join("\n");

  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Context Budgeting ───────────────────────────────────────────────
async function buildContextBudgeting(candidate, ws) {
  const p = path.join(ws, "src/context-budget.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Context budgeting: track token/line budget per turn",
    "export class ContextBudget {",
    "  constructor(maxTokens = 8000) { this.max = maxTokens; this.used = 0; this.turns = []; }",
    "  allocate(turn, cost) { this.used += cost; this.turns.push({ turn, cost, remaining: this.max - this.used }); }",
    "  remaining() { return this.max - this.used; }",
    "  reset() { this.used = 0; this.turns = []; }",
    "  summary() { return { max: this.max, used: this.used, remaining: this.remaining(), turns: this.turns.length, avgCost: this.turns.length ? Math.round(this.used / this.turns.length) : 0 }; }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Action Decision Tree ────────────────────────────────────────────
async function buildActionDecisionTree(candidate, ws) {
  const p = path.join(ws, "src/action-decision-tree.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Action decision tree: learn which action sequences lead to success",
    "export class ActionDecisionTree {",
    "  constructor() { this.nodes = new Map(); this.successPaths = []; this.failPaths = []; }",
    "  recordPath(path, success) {",
    "    const key = path.join('→');",
    "    this.nodes.set(key, { path, success, count: (this.nodes.get(key)?.count || 0) + 1 });",
    "    if (success) this.successPaths.push(key); else this.failPaths.push(key);",
    "  }",
    "  bestAction(lastAction) {",
    "    const matches = [...this.nodes.values()].filter(n => n.path[n.path.length-2] === lastAction && n.success);",
    "    if (!matches.length) return null;",
    "    matches.sort((a,b) => b.count - a.count);",
    "    return matches[0].path[matches[0].path.length - 1];",
    "  }",
    "  summary() { return { totalPaths: this.nodes.size, successPaths: this.successPaths.length, failPaths: this.failPaths.length }; }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Completion Confidence ───────────────────────────────────────────
async function buildCompletionConfidence(candidate, ws) {
  const p = path.join(ws, "src/completion-confidence.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Completion confidence: estimate readiness to declare a task done",
    "export class CompletionConfidence {",
    "  constructor() { this.signals = []; this.history = []; }",
    "  addSignal(name, weight) { this.signals.push({ name, weight, met: false }); }",
    "  markMet(name) { const s = this.signals.find(s => s.name === name); if (s) s.met = true; }",
    "  score() {",
    "    const total = this.signals.reduce((sum, s) => sum + s.weight, 0);",
    "    const met = this.signals.filter(s => s.met).reduce((sum, s) => sum + s.weight, 0);",
    "    return total > 0 ? +(met / total * 100).toFixed(1) : 0;",
    "  }",
    "  record(score, actual) { this.history.push({ score, actual }); }",
    "  calibration() {",
    "    if (this.history.length < 2) return { samples: 0, accuracy: 0 };",
    "    const errors = this.history.map(h => Math.abs(h.score - (h.actual ? 100 : 0)));",
    "    return { samples: this.history.length, avgError: +(errors.reduce((a,b) => a+b, 0) / errors.length).toFixed(1) };",
    "  }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Cross-file Patterns ─────────────────────────────────────────────
async function buildCrossFilePatterns(candidate, ws) {
  const p = path.join(ws, "src/cross-file-patterns.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Cross-file pattern detection: find repeated structures across modules",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "export class CrossFilePatterns {",
    "  constructor() { this.patterns = []; }",
    "  scan(dir, ext = '.js') {",
    "    const files = fs.readdirSync(dir).filter(f => f.endsWith(ext));",
    "    const contents = files.map(f => ({ file: f, lines: fs.readFileSync(path.join(dir, f), 'utf8').split('\n') }));",
    "    this.detectImports(contents);",
    "    this.detectClassPatterns(contents);",
    "    return this.patterns;",
    "  }",
    "  detectImports(files) {",
    "    const importMap = new Map();",
    "    for (const f of files) {",
    "      const imports = f.lines.filter(l => l.startsWith('import ')).map(l => l.trim());",
    "      for (const imp of imports) { importMap.set(imp, (importMap.get(imp) || 0) + 1); }",
    "    }",
    "    const repeated = [...importMap.entries()].filter(([_, c]) => c > 2);",
    "    if (repeated.length) this.patterns.push({ type: 'repeated-imports', count: repeated.length, examples: repeated.map(([k]) => k) });",
    "  }",
    "  detectClassPatterns(files) {",
    "    const classCount = files.filter(f => f.lines.some(l => l.includes('class ') || l.includes('export function'))).length;",
    "    if (classCount > files.length * 0.7) this.patterns.push({ type: 'class-heavy', ratio: +(classCount/files.length).toFixed(2) });",
    "  }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Skill Discovery ─────────────────────────────────────────────────
async function buildSkillDiscovery(candidate, ws) {
  const p = path.join(ws, "src/skill-discovery.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Skill discovery: auto-detect capabilities from codebase",
    "export class SkillDiscovery {",
    "  constructor() { this.skills = []; }",
    "  detectFromExports(modules) {",
    "    for (const [file, mod] of Object.entries(modules)) {",
    "      for (const name of Object.keys(mod)) {",
    "        this.skills.push({ file, name, type: typeof mod[name], confidence: 0.7 });",
    "      }",
    "    }",
    "    return this.skills;",
    "  }",
    "  categorize() {",
    "    return {",
    "      functions: this.skills.filter(s => s.type === 'function').length,",
    "      classes: this.skills.filter(s => s.type === 'object').length,",
    "      total: this.skills.length,",
    "    };",
    "  }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Prompt Compression ──────────────────────────────────────────────
async function buildPromptCompression(candidate, ws) {
  const p = path.join(ws, "src/prompt-compression.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Prompt compression: reduce prompt size while preserving key info",
    "export class PromptCompressor {",
    "  constructor() { this.stats = { original: 0, compressed: 0, saved: 0 }; }",
    "  compress(text) {",
    "    if (typeof text !== 'string') throw new TypeError('PromptCompressor.compress requires a string');",
    "    const orig = text.length;",
    "    let out = text",
    "      .replace(/[ \\t]{2,}/g, ' ')",
    "      .replace(/\\n{3,}/g, '\\n\\n')",
    "      .trim();",
    "    this.stats.original += orig;",
    "    this.stats.compressed += out.length;",
    "    this.stats.saved += orig - out.length;",
    "    return out;",
    "  }",
    "  ratio() { return this.stats.original > 0 ? +((1 - this.stats.compressed / this.stats.original) * 100).toFixed(1) : 0; }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Task Decomposition ──────────────────────────────────────────────
async function buildTaskDecomposition(candidate, ws) {
  const p = path.join(ws, "src/task-decomposition.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Task decomposition: break complex requests into subtasks",
    "export class TaskDecomposer {",
    "  constructor() { this.subtasks = []; this.completed = new Set(); }",
    "  decompose(task) {",
    "    const steps = task.split(/[.!?]+/).filter(s => s.trim().length > 10);",
    "    this.subtasks = steps.map((s, i) => ({ id: i, desc: s.trim(), done: false, deps: i > 0 ? [i-1] : [] }));",
    "    return this.subtasks;",
    "  }",
    "  complete(id) { this.completed.add(id); const t = this.subtasks.find(s => s.id === id); if (t) t.done = true; }",
    "  progress() { return this.subtasks.length ? +((this.completed.size / this.subtasks.length) * 100).toFixed(1) : 0; }",
    "  next() { return this.subtasks.find(s => !s.done) || null; }",
    "  summary() { return { total: this.subtasks.length, done: this.completed.size, progress: this.progress() }; }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Build: Tool Feedback ───────────────────────────────────────────────────
async function buildToolFeedback(candidate, ws) {
  const p = path.join(ws, "src/tool-feedback.js");
  if (fs.existsSync(p)) return [{ file: p, action: "exists" }];
  const code = [
    "// Tool feedback: track which tools/actions produce useful observations",
    "export class ToolFeedback {",
    "  constructor() { this.tools = new Map(); this.totalCalls = 0; }",
    "  record(tool, observationLength, useful) {",
    "    this.totalCalls++;",
    "    const entry = this.tools.get(tool) || { calls: 0, totalObs: 0, useful: 0 };",
    "    entry.calls++; entry.totalObs += observationLength || 0; if (useful) entry.useful++;",
    "    this.tools.set(tool, entry);",
    "  }",
    "  bestTool() {",
    "    let best = null, bestRate = 0;",
    "    for (const [name, data] of this.tools) {",
    "      const rate = data.calls > 0 ? data.useful / data.calls : 0;",
    "      if (rate > bestRate) { bestRate = rate; best = name; }",
    "    }",
    "    return { tool: best, rate: bestRate };",
    "  }",
    "  summary() { return { totalCalls: this.totalCalls, tools: [...this.tools.entries()] }; }",
    "}",
  ].join("\n");
  fs.writeFileSync(p, code);
  return [{ file: p, action: "created" }];
}

// ── Test function ──────────────────────────────────────────────────────────
async function testImprovement(id, changes, ws) {
  const materialChanges = changes.filter((change) => (
    change.action !== "exists"
  ));
  if (materialChanges.length === 0) return "no-change";
  try {
    for (const change of materialChanges) {
      // Try importing the module
      const mod = await import(pathToFileURL(change.file).href + "?t=" + Date.now());
      if (Object.keys(mod).length === 0) return "no-exports";
    }
    return "passed";
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

// ── Reload: re-import modules so the new code is actually active ────────────
async function reloadModules(changes, ws) {
  const materialChanges = changes.filter((change) => (
    change.action !== "exists"
  ));
  try {
    for (const change of materialChanges) {
      // ESM cache-busting is done with a unique URL; CommonJS require.cache is
      // intentionally unavailable in this module.
      await import(pathToFileURL(change.file).href + "?t=" + Date.now());
    }
    return { ok: true, message: `Reloaded ${materialChanges.length} module(s)` };
  } catch (e) {
    return { ok: false, message: `Reload failed: ${e.message}` };
  }
}

// ── Verify: smoke-test the agent with the newly loaded module ───────────────
async function verifyImprovement(candidate, changes, ws) {
  try {
    const materialChanges = changes.filter((change) => (
      change.action !== "exists"
    ));
    for (const change of materialChanges) {
      const mod = await import(pathToFileURL(change.file).href + "?verify=" + Date.now());
      if (Object.keys(mod).length === 0) {
        return { ok: false, message: `Candidate has no exports: ${change.file}` };
      }
    }
    const candidates = scanWeaknesses(ws);
    if (!Array.isArray(candidates)) {
      return { ok: false, message: "scanWeaknesses returned non-array" };
    }
    return {
      ok: true,
      message: `Verified ${materialChanges.length} candidate module(s); scan returned ${candidates.length} candidates`,
    };
  } catch (e) {
    return { ok: false, message: `Verify failed: ${e.message}` };
  }
}

export function parseRunnerArgs(argv = []) {
  const options = {
    workspace: process.cwd(),
    maxCycles: DEFAULT_MAX_CYCLES,
    unsafeDirectWrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace") {
      const value = argv[++i];
      if (!value) throw new Error("--workspace requires a path");
      options.workspace = path.resolve(value);
    } else if (arg === "--max-cycles") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-cycles requires a positive integer");
      }
      options.maxCycles = value;
    } else if (arg === "--unsafe-direct-write") {
      options.unsafeDirectWrite = true;
    } else if (arg !== "--dry-run") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// ── Main Loop ──────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)) {
  const options = parseRunnerArgs(argv);
  const workspace = options.workspace;
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║     BANTAMBUILD — Self-Improvement Loop         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const scheduler = new ImprovementScheduler(workspace);
  const candidates = scheduler.rankCandidates(scanWeaknesses(workspace));
  console.log(`🔍 Scanned codebase: ${candidates.length} weakness candidates found\n`);

  // The same evidence-aware scheduler powers both read-only plans and the
  // quarantined legacy writer, so the two modes cannot disagree on priority.
  const selected = candidates.slice(0, options.maxCycles);

  // A scan must be safe to run from the real checkout. Direct source mutation
  // remains quarantined until it is replaced by the lane/proposal pipeline.
  if (!options.unsafeDirectWrite) {
    console.log("Plan only — no files will be written.");
    for (const candidate of selected) {
      const builder = BUILDERS[candidate.id] ? "builder available" : "no builder";
      console.log(`  [${candidate.id}] ${candidate.proposal} (${builder})`);
    }
    console.log("\nRun ./bin/run-dev.sh self-improve for the governed build/test/promote path. The legacy direct writer requires the explicit --unsafe-direct-write flag.");
    return { mode: "plan", workspace, candidates: selected };
  }

  const stateDir = path.join(workspace, ".bantam");
  fs.mkdirSync(stateDir, { recursive: true });
  const log = new ImprovementLog(path.join(stateDir, "self-improvements.json"));
  let cycle = 0;
  let changed = 0;

  for (const candidate of selected) {
    cycle++;
    const builder = BUILDERS[candidate.id];

    console.log(`\n── Cycle ${cycle}/${selected.length}: [${candidate.id}] ──`);
    console.log(`   Area: ${candidate.area}`);
    console.log(`   Problem: ${candidate.problem.slice(0, 100)}...`);
    console.log(`   Proposal: ${candidate.proposal.slice(0, 100)}...`);

    if (!builder) {
      console.log(`   → No builder registered, skipping`);
      continue;
    }

    // Build
    const changes = await builder(candidate, workspace);
    console.log(`   → Built ${changes.length} change(s): ${changes.map(c => `${c.action}:${c.file}`).join(', ')}`);

    // Test
    const result = await testImprovement(candidate.id, changes, workspace);
    if (result === "no-change") {
      console.log("   → No material change; not counted as an improvement");
      continue;
    }
    let passed = result === "passed";
    console.log(`   → Test: ${passed ? "✅ PASSED" : `❌ ${result}`}`);

    if (passed) {
      const reload = await reloadModules(changes, workspace);
      console.log(`   → Reload: ${reload.ok ? `✅ ${reload.message}` : `⚠️ ${reload.message}`}`);
      passed = reload.ok;

      if (reload.ok) {
        const verify = await verifyImprovement(candidate, changes, workspace);
        console.log(`   → Verify: ${verify.ok ? `✅ ${verify.message}` : `⚠️ ${verify.message}`}`);
        passed = verify.ok;
      }
    }

    log.record({
      cycle,
      id: candidate.id,
      area: candidate.area,
      problem: candidate.problem,
      proposal: candidate.proposal,
      changes: changes.length,
      passed,
    });
    if (passed) changed++;
  }

  console.log("\n\n══════════════════════════════════════════════════");
  console.log("                    FINAL REPORT");
  console.log("══════════════════════════════════════════════════");

  const summary = log.summary();
  const weak = log.weakestAreas();
  const priorities = log.suggestPriorities();

  console.log(`\n📊 Completed ${cycle} improvement cycles`);
  console.log(`   Areas improved: ${Object.keys(summary.byArea ?? {}).length}`);
  console.log(`   Success rate: ${log.entries.filter(e => e.passed).length}/${log.entries.length}`);

  if (weak.length > 0) {
    console.log("\n📉 Weakest areas:");
    for (const w of weak) {
      console.log(`   - ${w.area}: ${(w.rate * 100).toFixed(0)}% success`);
    }
  }

  if (priorities.length > 0) {
    console.log("\n🎯 Next priorities:");
    for (const p of priorities) {
      console.log(`   - ${p.suggestion}`);
    }
  }

  const kick = buildKickMessage(cycle, log.entries.map((e, i) => ({ cycle: i, candidate: { id: e.id }, testResult: e.passed ? 'passed' : 'failed' })), log);
  console.log(kick);

  console.log("\nSelf-improvement loop complete. Evidence written under .bantam/.");
  return { mode: "unsafe-direct-write", workspace, cycles: cycle, changed, summary };
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error("Loop error:", error);
    process.exitCode = 1;
  });
}
