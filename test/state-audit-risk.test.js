import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findStateAuditRisksInSource } from "../src/state-audit-risk.js";

describe("state-audit static risks", () => {
  it("flags the duel's unconditional active-Promise cleanup in finally and catch paths", () => {
    const source = `export class KeyedTaskPool {
  _start(key, task, resolve, reject) {
    this._running.add(key);
    try {
      const result = task();
      Promise.resolve(result)
        .then(resolve, reject)
        .finally(() => {
          this._running.delete(key);
          this._activePromises.delete(key);
          this._drain();
        });
    } catch (error) {
      reject(error);
      this._running.delete(key);
      this._activePromises.delete(key);
      this._drain();
    }
  }
}`;
    const expectedLines = source.split("\n")
      .map((line, index) => line.includes("this._activePromises.delete") ? index + 1 : null)
      .filter(Boolean);

    const risks = findStateAuditRisksInSource(source, "src/keyed-task-pool.js");

    assert.deepEqual(risks.map(({ path, line, kind }) => ({ path, line, kind })), expectedLines.map((line) => ({
      path: "src/keyed-task-pool.js",
      line,
      kind: "unguarded-settlement-cleanup",
    })));
    assert.ok(risks.every(({ message }) => message.includes("`_activePromises`")));
  });

  it("does not flag cleanup guarded by the settling operation's identity", () => {
    const source = `promise.finally(() => {
  if (this._activePromises.get(key) === promise) {
    this._activePromises.delete(key);
  }
});`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/guarded.js"),
      [],
    );
  });

  it("does not flag deletion from an unrelated map", () => {
    const source = `promise.finally(() => {
  this.cache.delete(key);
});`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/cache.js"),
      [],
    );
  });

  it("flags clearing an operation identity counter", () => {
    const source = `export class Requests {
  reset() {
    this.sequenceByKey.clear();
  }
}`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/requests.js").map(
        ({ path, line, kind }) => ({ path, line, kind }),
      ),
      [{
        path: "src/requests.js",
        line: 3,
        kind: "identity-reset",
      }],
    );
  });

  it("flags one stored result wrapper reused for duplicate input rows", () => {
    const source = `export async function runPlan(steps) {
  const results = new Map();
  results.set("shared", { key: "shared", status: "fulfilled", value: 4 });
  return steps.map((step) => results.get(step.key));
}`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/run-plan.js").map(
        ({ path, line, kind }) => ({ path, line, kind }),
      ),
      [{
        path: "src/run-plan.js",
        line: 4,
        kind: "shared-result-wrapper",
      }],
    );
  });

  it("does not flag a fresh per-input wrapper around a stored result", () => {
    const source = `export async function runPlan(steps) {
  const results = new Map();
  results.set("shared", { key: "shared", status: "fulfilled", value: 4 });
  return steps.map((step) => ({ ...results.get(step.key) }));
}`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/run-plan.js"),
      [],
    );
  });

  it("flags a function-wide worker check nested inside the collection loop", () => {
    const source = `export async function runPlan(steps, worker) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      throw new TypeError("bad step");
    }
    if (typeof worker !== "function") {
      throw new TypeError("worker must be a function");
    }
  }
}`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/run-plan.js").map(
        ({ path, line, kind }) => ({ path, line, kind }),
      ),
      [{
        path: "src/run-plan.js",
        line: 7,
        kind: "loop-scoped-parameter-validation",
      }],
    );
  });

  it("does not flag worker validation performed before the collection loop", () => {
    const source = `export async function runPlan(steps, worker) {
  if (typeof worker !== "function") {
    throw new TypeError("worker must be a function");
  }
  for (const step of steps) {
    if (!step) throw new TypeError("bad step");
  }
}`;

    assert.deepEqual(
      findStateAuditRisksInSource(source, "src/run-plan.js"),
      [],
    );
  });
});
