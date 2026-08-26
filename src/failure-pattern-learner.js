// Durable, bounded failure-pattern learning for self-improvement feedback.
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
]);

/**
 * Persist bounded, reusable lessons from failed runs.
 *
 * Reads are fail-closed and writes are atomic. Recording computes the complete
 * next state before persistence, so a rejected write cannot partially advance
 * the learner in memory.
 */
export class FailurePatternLearner {
  constructor(workspace) {
    if (typeof workspace !== "string" || workspace.length === 0 || workspace.includes("\0")) {
      throw new TypeError("failure learner workspace must be a non-empty path");
    }
    this.workspace = path.resolve(workspace);
    const canonicalPath = path.join(this.workspace, ".bantam", "failure-patterns.json");
    const legacyPath = path.join(this.workspace, ".bantam-failure-patterns.json");
    this.patternsPath = fs.existsSync(canonicalPath) || !fs.existsSync(legacyPath)
      ? canonicalPath
      : legacyPath;
    this.patterns = this._load();
  }

  _load() {
    try {
      const stat = fs.lstatSync(this.patternsPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return emptyState();
      return normalizeState(JSON.parse(fs.readFileSync(this.patternsPath, "utf8")));
    } catch {
      return emptyState();
    }
  }

  /** Record one bounded failure pattern and, when present, its general lesson. */
  recordPattern(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("failure pattern must be an object");
    }
    const task = textField(value.task, "task");
    const failure = textField(value.failure, "failure");
    const rootCause = textField(value.rootCause, "rootCause");
    const lesson = textField(value.lesson, "lesson");
    const entry = {
      task: task.slice(0, 200),
      failure: failure.slice(0, 500),
      rootCause: rootCause.slice(0, 200),
      lesson: lesson.slice(0, 500),
      timestamp: Date.now(),
    };
    const next = {
      patterns: [...this.patterns.patterns, entry],
      lessons: lesson
        ? [...this.patterns.lessons, lesson.slice(0, 200)]
        : [...this.patterns.lessons],
    };

    this._save(next);
    this.patterns = next;
    return { ...entry };
  }

  _save(state = this.patterns) {
    assertStatePathInsideWorkspace(this.workspace, this.patternsPath);
    writeJsonAtomic(this.patternsPath, state);
  }

  /** Return up to five recent lessons sharing a meaningful task token. */
  relevantLessons(task) {
    if (task === undefined || task === null || task === "") {
      return this.patterns.lessons.slice(-5);
    }
    if (typeof task !== "string") {
      throw new TypeError("lesson query must be a string");
    }
    const queryTokens = tokens(task);
    if (queryTokens.size === 0) return this.patterns.lessons.slice(-5);
    return this.patterns.lessons.filter((lesson) => (
      [...tokens(lesson)].some((token) => queryTokens.has(token))
    )).slice(-5);
  }

  /** Format relevant lessons as a prompt nudge. */
  asPromptNudge(task) {
    const lessons = this.relevantLessons(task);
    if (lessons.length === 0) return "";
    return `\nLessons from previous runs:\n${lessons.map((lesson) => `- ${lesson}`).join("\n")}`;
  }

  /** Return counts and detached snapshots of the five most recent patterns. */
  stats() {
    return {
      totalPatterns: this.patterns.patterns.length,
      totalLessons: this.patterns.lessons.length,
      recentPatterns: this.patterns.patterns.slice(-5).map((entry) => ({ ...entry })),
    };
  }
}

function emptyState() {
  return { patterns: [], lessons: [] };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Array.isArray(value.patterns) || !Array.isArray(value.lessons)) {
    return emptyState();
  }
  return {
    patterns: value.patterns
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => ({ ...entry })),
    lessons: value.lessons.filter((lesson) => typeof lesson === "string"),
  };
}

function textField(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`failure pattern ${name} must be a string`);
  }
  return value;
}

function tokens(value) {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function assertStatePathInsideWorkspace(workspace, target) {
  let root;
  try {
    root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new Error("workspace is not a directory");
  } catch (error) {
    throw new Error(`failure learner workspace is unavailable: ${error.message}`);
  }

  let ancestor = path.dirname(path.resolve(target));
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  const relative = path.relative(root, realAncestor);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`failure learner state path escapes workspace: ${target}`);
  }
}
