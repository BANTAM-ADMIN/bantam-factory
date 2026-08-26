import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PriorityQueue,
  buildContext,
  deduplicate,
  overlaps,
  rankImprovements,
  scoreBatch,
  scoreImprovement,
  topN,
} from "../src/improvement-priority.js";

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-improvement-priority-"));
  tempDirs.push(directory);
  return directory;
}

describe("improvement scoring", () => {
  it("applies value, enablement, and dependency signals while retaining overlap metadata", () => {
    const candidate = {
      id: "coverage",
      area: "quality",
      problem: "missing tests for new code",
      frequency: 4,
      severity: 2,
      effort: 2,
      dependsOn: ["index", "runner"],
      enables: ["promotion", "healing"],
    };

    const blocked = scoreImprovement(candidate);
    const partial = scoreImprovement(candidate, { completed: new Set(["index"]) });
    const ready = scoreImprovement(candidate, { completed: new Set(["index", "runner"]) });

    assert.equal(blocked.score, 2.8);
    assert.equal(partial.score, 4.2);
    assert.equal(ready.score, 5.6);
    assert.equal(ready.area, "quality");
    assert.equal(ready.problem, "missing tests for new code");
    assert.deepEqual(ready.dependsOn, ["index", "runner"]);
    assert.deepEqual(ready.enables, ["promotion", "healing"]);
    assert.deepEqual(ready.signals, {
      freq: 4,
      sev: 2,
      effort: 2,
      deps: 2,
      enabled: 2,
    });
    assert.deepEqual(candidate.dependsOn, ["index", "runner"]);
  });

  it("honors explicit zeroes and keeps malformed numeric signals finite", () => {
    assert.equal(scoreImprovement({
      id: "not-observed",
      frequency: 0,
      severity: 10,
      effort: 1,
    }).score, 0);
    assert.equal(scoreImprovement({
      id: "tiny",
      frequency: 1,
      severity: 1,
      effort: 0,
    }).score, 10);

    const normalized = scoreImprovement({
      id: "normalized",
      frequency: "not-a-number",
      severity: Infinity,
      effort: -5,
      dependsOn: "not-an-array",
      enables: {},
    });
    assert.equal(normalized.score, 10);
    assert.deepEqual(normalized.signals, {
      freq: 1,
      sev: 1,
      effort: 0.1,
      deps: 0,
      enabled: 0,
    });
  });
});

describe("immutable ranking and deduplication", () => {
  it("ranks and selects top N without changing the input order", () => {
    const first = Object.freeze({ id: "first", score: 1 });
    const second = Object.freeze({ id: "second", score: 3 });
    const third = Object.freeze({ id: "third", score: 2 });
    const scored = Object.freeze([first, second, third]);

    const ranked = rankImprovements(scored);
    const top = topN(scored, 2);

    assert.deepEqual(ranked.map(item => item.id), ["second", "third", "first"]);
    assert.deepEqual(top.map(item => item.id), ["second", "third"]);
    assert.deepEqual(scored.map(item => item.id), ["first", "second", "third"]);
    assert.notEqual(ranked, scored);
    assert.deepEqual(topN(scored, -2), []);
    assert.deepEqual(topN(scored, 1.9).map(item => item.id), ["second"]);
    assert.deepEqual(topN(scored, Infinity).map(item => item.id), ["second", "third", "first"]);
  });

  it("keeps the highest-scored overlap without mutating or extending its input", () => {
    const scored = Object.freeze([
      Object.freeze({
        id: "primary",
        area: "quality",
        problem: "no test coverage for new modules",
        score: 10,
      }),
      Object.freeze({
        id: "primary",
        area: "quality",
        problem: "duplicate identifier",
        score: 9,
      }),
      Object.freeze({
        id: "semantic-duplicate",
        signals: {
          area: "quality",
          problem: "missing tests for recently added code",
        },
        score: 8,
      }),
      Object.freeze({
        id: "different-area",
        area: "efficiency",
        problem: "missing tests for recently added code",
        score: 7,
      }),
      Object.freeze({
        id: "unique",
        area: "quality",
        problem: "slow startup time",
        score: 6,
      }),
    ]);

    const result = deduplicate(scored);

    assert.deepEqual(result.map(item => item.id), ["primary", "different-area", "unique"]);
    assert.equal(scored.length, 5);
    assert.deepEqual(scored.map(item => item.score), [10, 9, 8, 7, 6]);
  });

  it("compares normalized problems conservatively and tolerates malformed values", () => {
    assert.equal(overlaps(
      { id: "a", area: "Quality", problem: "No test coverage for new modules." },
      { id: "b", area: "quality", problem: "Missing tests for recently added code" },
    ), true);
    assert.equal(overlaps(
      { id: "a", area: "quality", problem: "missing tests" },
      { id: "b", area: "efficiency", problem: "missing tests" },
    ), false);
    assert.equal(overlaps({}, {}), false);
    assert.equal(overlaps(null, { id: "b" }), false);
  });
});

describe("priority queue", () => {
  it("rescales waiting candidates as dependencies complete and isolates candidate input", () => {
    const blocked = {
      id: "blocked",
      frequency: 10,
      severity: 1,
      effort: 1,
      dependsOn: ["foundation"],
    };
    const queue = new PriorityQueue();
    queue.add(blocked);
    queue.add({ id: "steady", frequency: 6, severity: 1, effort: 1 });
    blocked.frequency = 100;
    blocked.dependsOn.push("later");

    assert.equal(queue.next().id, "steady");
    queue.complete("foundation");
    assert.equal(queue.next().id, "blocked");
    assert.equal(queue.next().score, 10);
    assert.deepEqual(queue.report(), {
      total: 2,
      completed: 1,
      top: [
        { id: "blocked", score: 10 },
        { id: "steady", score: 6 },
      ],
    });

    queue.complete("blocked");
    assert.equal(queue.remaining(), 1);
    assert.equal(queue.next().id, "steady");
    assert.equal(queue.completed.has("blocked"), true);
  });

  it("supports batch insertion and rejects malformed batches", () => {
    const queue = new PriorityQueue();
    const added = queue.addBatch([
      { id: "a", frequency: 1 },
      { id: "b", frequency: 2 },
    ]);

    assert.deepEqual(added.map(item => item.id), ["a", "b"]);
    assert.equal(queue.remaining(), 2);
    assert.throws(() => queue.addBatch(null), /candidates must be an array/);
  });
});

describe("improvement-log context", () => {
  it("loads canonical and legacy successful outcomes with canonical precedence", () => {
    const directory = fixture();
    const logPath = path.join(directory, "improvements.json");
    fs.writeFileSync(logPath, JSON.stringify([
      { id: "canonical", passed: true },
      { id: "legacy", success: true },
      { id: "canonical-failure", passed: false, success: true },
      { id: "legacy-failure", success: false },
      { id: "", passed: true },
      null,
      "malformed",
      { passed: true },
      { id: "canonical", passed: true },
    ]));

    assert.deepEqual(
      [...buildContext(logPath).completed].sort(),
      ["canonical", "legacy"],
    );
  });

  it("fails closed for absent, malformed, and non-array logs", () => {
    const directory = fixture();
    const missing = path.join(directory, "missing.json");
    const malformed = path.join(directory, "malformed.json");
    const objectLog = path.join(directory, "object.json");
    const directoryLog = path.join(directory, "directory");
    fs.writeFileSync(malformed, "{not json");
    fs.writeFileSync(objectLog, JSON.stringify({ entries: [] }));
    fs.mkdirSync(directoryLog);

    for (const logPath of [missing, malformed, objectLog, directoryLog, "", null]) {
      assert.deepEqual(buildContext(logPath).completed, new Set());
    }
  });
});

describe("malformed public input and direct CLI", () => {
  it("reports clear type errors for invalid candidate collections", () => {
    assert.throws(() => scoreImprovement(null), /candidate must be an object/);
    assert.throws(() => scoreImprovement([]), /candidate must be an object/);
    assert.throws(() => scoreBatch({}), /candidates must be an array/);
    assert.throws(() => rankImprovements(null), /scored improvements must be an array/);
  });

  it("runs the embedded CLI checks exactly once", () => {
    const directory = fixture();
    const modulePath = fileURLToPath(new URL("../src/improvement-priority.js", import.meta.url));
    const result = spawnSync(process.execPath, [modulePath], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: directory,
        TMPDIR: directory,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/^=== Improvement Priority Engine ===$/gm) ?? []).length, 1);
    assert.equal((result.stdout.match(/^All tests passed\.$/gm) ?? []).length, 1);
    assert.doesNotMatch(result.stderr, /Assertion failed/);
  });
});
