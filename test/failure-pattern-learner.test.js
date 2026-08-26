import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { FailurePatternLearner } from "../src/failure-pattern-learner.js";

const temporary = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-failure-learner-"));
  temporary.push(root);
  return root;
}

afterEach(() => {
  while (temporary.length) {
    fs.rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

describe("failure pattern learner", () => {
  it("fails closed on malformed state and does not write during inspection", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, ".bantam-failure-patterns.json"), '{"patterns":{}}');

    const learner = new FailurePatternLearner(root);

    assert.deepEqual(learner.patterns, { patterns: [], lessons: [] });
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("atomically records bounded patterns and reloads canonical state", () => {
    const root = workspace();
    const learner = new FailurePatternLearner(root);
    const recorded = learner.recordPattern({
      task: "t".repeat(250),
      failure: "f".repeat(550),
      rootCause: "r".repeat(250),
      lesson: "l".repeat(550),
    });

    assert.equal(recorded.task.length, 200);
    assert.equal(recorded.failure.length, 500);
    assert.equal(recorded.rootCause.length, 200);
    assert.equal(recorded.lesson.length, 500);
    assert.equal(learner.patterns.lessons[0].length, 200);
    const reloaded = new FailurePatternLearner(root);
    assert.equal(reloaded.stats().totalPatterns, 1);
    assert.equal(reloaded.stats().totalLessons, 1);
    assert.deepEqual(
      fs.readdirSync(path.join(root, ".bantam")).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("matches whole meaningful tokens instead of arbitrary substrings", () => {
    const learner = new FailurePatternLearner(workspace());
    learner.patterns = {
      patterns: [],
      lessons: [
        "Add timeout guards to render loops",
        "Concatenate the cached fragments",
        "Use targeted reads for repositories",
      ],
    };

    assert.deepEqual(
      learner.relevantLessons("render timeout"),
      ["Add timeout guards to render loops"],
    );
    assert.deepEqual(learner.relevantLessons("cat"), []);
    assert.equal(learner.asPromptNudge("cached").includes("cached fragments"), true);
    assert.deepEqual(learner.relevantLessons("the and"), learner.patterns.lessons);
  });

  it("rejects malformed records before changing memory or disk", () => {
    const root = workspace();
    const learner = new FailurePatternLearner(root);

    assert.throws(() => learner.recordPattern(null), /must be an object/);
    assert.throws(() => learner.recordPattern({
      task: "task",
      failure: "failure",
      rootCause: "cause",
      lesson: 42,
    }), /lesson must be a string/);
    assert.deepEqual(learner.patterns, { patterns: [], lessons: [] });
    assert.equal(fs.existsSync(path.join(root, ".bantam")), false);
  });

  it("does not follow direct or parent symlinks for persisted state", () => {
    const root = workspace();
    const outside = workspace();
    const victim = path.join(outside, "victim.json");
    fs.writeFileSync(victim, '{"untouched":true}');
    const direct = new FailurePatternLearner(root);
    fs.mkdirSync(path.join(root, ".bantam"));
    fs.symlinkSync(victim, direct.patternsPath);

    assert.throws(() => direct.recordPattern(validPattern()), /replace symlink/);
    assert.deepEqual(direct.patterns, { patterns: [], lessons: [] });
    assert.equal(fs.readFileSync(victim, "utf8"), '{"untouched":true}');

    fs.rmSync(path.join(root, ".bantam"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".bantam"));
    const escaped = new FailurePatternLearner(root);
    assert.throws(() => escaped.recordPattern(validPattern()), /escapes workspace/);
    assert.equal(fs.existsSync(path.join(outside, "failure-patterns.json")), false);
  });

  it("returns detached recent-pattern snapshots", () => {
    const learner = new FailurePatternLearner(workspace());
    learner.patterns = {
      patterns: [{ task: "original", failure: "x", rootCause: "y", lesson: "z" }],
      lessons: ["z"],
    };

    const stats = learner.stats();
    stats.recentPatterns[0].task = "mutated";

    assert.equal(learner.patterns.patterns[0].task, "original");
    assert.throws(() => learner.relevantLessons({}), /query must be a string/);
  });
});

function validPattern() {
  return {
    task: "task",
    failure: "failure",
    rootCause: "root cause",
    lesson: "lesson",
  };
}
