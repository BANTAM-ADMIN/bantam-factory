import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ImprovementLog,
  ImprovementScheduler,
  scanWeaknesses,
} from "../src/self-improve.js";

const temporary = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-scheduler-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  return root;
}

afterEach(() => {
  while (temporary.length) {
    fs.rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

describe("evidence-aware improvement scheduling", () => {
  it("keeps a currently observed weakness eligible after an older pass", () => {
    const root = workspace();
    const current = scanWeaknesses(root);
    assert.ok(current.length > 0);
    fs.writeFileSync(
      path.join(root, ".bantam-improvements.json"),
      JSON.stringify(current.map(({ id, area }) => ({ id, area, passed: true }))),
    );

    const scheduler = new ImprovementScheduler(root);
    const ranked = scheduler.rankCandidates(current);

    assert.equal(ranked.length, current.length);
    assert.ok(scheduler.nextImprovement());
    assert.ok(current.some(({ id }) => id === scheduler.nextImprovement().id));
  });

  it("boosts weak areas in proportion to observed failure rate", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, ".bantam-improvements.json"), JSON.stringify([
      { id: "quality-failure-1", area: "quality", passed: false },
      { id: "quality-failure-2", area: "quality", passed: false },
      { id: "reliable-pass", area: "reliability", passed: true },
    ]));
    const scheduler = new ImprovementScheduler(root);
    const ranked = scheduler.rankCandidates([
      { id: "quality", area: "quality", impact: 3, effort: 2 },
      { id: "reliability", area: "reliability", impact: 4, effort: 2 },
    ]);

    assert.deepEqual(ranked.map(({ id }) => id), ["quality", "reliability"]);
    assert.equal(ranked[0].score, 3);
    assert.deepEqual(ranked[0].evidence, {
      areaFailureRate: 1,
      areaSamples: 2,
    });
  });

  it("uses dependency and enablement signals from the priority engine", () => {
    const scheduler = new ImprovementScheduler(workspace());
    const ranked = scheduler.rankCandidates([
      {
        id: "plain",
        area: "quality",
        impact: 2,
        effort: 1,
      },
      {
        id: "unblocks-others",
        area: "architecture",
        impact: 1.8,
        effort: 1,
        enables: ["follow-up-a", "follow-up-b"],
      },
    ]);

    assert.deepEqual(ranked.map(({ id }) => id), ["unblocks-others", "plain"]);
    assert.equal(ranked[0].score, 2.52);
    assert.equal(ranked[0].prioritySignals.enabled, 2);
  });

  it("uses damped occurrence counts to favor concrete recurring evidence", () => {
    const scheduler = new ImprovementScheduler(workspace());
    const ranked = scheduler.rankCandidates([
      {
        id: "generic-mechanism",
        area: "reliability",
        impact: 4,
        effort: 2,
      },
      {
        id: "observed-gap",
        area: "quality",
        impact: 2,
        effort: 2,
        occurrences: 16,
      },
    ]);

    assert.deepEqual(ranked.map(({ id }) => id), ["observed-gap", "generic-mechanism"]);
    assert.equal(ranked[0].prioritySignals.freq, 5);
    assert.equal(ranked[0].score, 5);
  });

  it("does not call fully successful areas weak", () => {
    const log = new ImprovementLog();
    log.record({ id: "one", area: "quality", passed: true });
    log.record({ id: "two", area: "reliability", passed: true });

    assert.deepEqual(log.suggestPriorities(), []);
  });

  it("rejects malformed candidate collections", () => {
    const scheduler = new ImprovementScheduler(workspace());
    assert.throws(
      () => scheduler.rankCandidates({ id: "not-an-array" }),
      /must be an array/,
    );
  });
});
