import assert from "node:assert/strict";
import test from "node:test";
import { runGraph } from "../src/scheduler.js";

const settleWithin = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runGraph did not settle within ${ms}ms (${label})`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

test("runs a linear chain in dependency order", async () => {
  const started = [];
  const results = await settleWithin(runGraph([
    { id: "a" },
    { id: "b", deps: ["a"] },
    { id: "c", deps: ["b"] },
  ], async (task) => { started.push(task.id); return task.id.toUpperCase(); }), 10000, "chain");

  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(results, [
    { id: "a", status: "fulfilled", value: "A" },
    { id: "b", status: "fulfilled", value: "B" },
    { id: "c", status: "fulfilled", value: "C" },
  ]);
});

test("rejects an unknown dependency before running anything", async () => {
  let calls = 0;
  await assert.rejects(
    runGraph([{ id: "a" }, { id: "b", deps: ["ghost"] }], async () => { calls += 1; }),
    TypeError,
  );
  assert.equal(calls, 0, "validation happens before any task runs");
});

test("rejects a dependency cycle before running anything", async () => {
  let calls = 0;
  await assert.rejects(
    runGraph([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }], async () => { calls += 1; }),
    TypeError,
  );
  assert.equal(calls, 0);
});

test("rejects duplicate ids and invalid concurrency", async () => {
  await assert.rejects(runGraph([{ id: "a" }, { id: "a" }], async () => 1), TypeError);
  for (const bad of [0, -1, 1.5, "2"]) {
    await assert.rejects(runGraph([{ id: "a" }], async () => 1, { concurrency: bad }), RangeError);
  }
});

// "a failed task's dependents are SKIPPED, transitively" -- a naive implementation
// marks direct dependents rejected and leaves deeper ones pending forever.
test("skips dependents of a failure, transitively", async () => {
  const reason = { code: "no" };
  const results = await settleWithin(runGraph([
    { id: "root" },
    { id: "mid", deps: ["root"] },
    { id: "leaf", deps: ["mid"] },
  ], async (task) => {
    if (task.id === "root") throw reason;
    return task.id;
  }), 10000, "skip");

  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.root.status, "rejected");
  assert.strictEqual(by.root.reason, reason);
  assert.equal(by.mid.status, "skipped", "a direct dependent is skipped, not rejected");
  assert.equal(by.leaf.status, "skipped", "and so is its dependent");
});

// "an unrelated branch still runs to completion"
test("a failure in one branch does not stop another", async () => {
  const results = await settleWithin(runGraph([
    { id: "bad" },
    { id: "badChild", deps: ["bad"] },
    { id: "good" },
  ], async (task) => {
    if (task.id === "bad") throw new Error("x");
    return task.id;
  }), 10000, "sibling");

  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.badChild.status, "skipped");
  assert.equal(by.good.status, "fulfilled");
});

// "runs at most concurrency tasks at once"
test("never exceeds the concurrency limit", async () => {
  let live = 0;
  let peak = 0;
  const tasks = [{ id: "seed" }];
  for (let i = 0; i < 10; i += 1) tasks.push({ id: `t${i}`, deps: ["seed"] });

  await settleWithin(runGraph(tasks, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live -= 1;
    return 1;
  }, { concurrency: 2 }), 15000, "concurrency");

  assert.ok(peak <= 2, `peak ${peak} exceeded the limit of 2`);
});

// "among tasks that become ready at the same moment, start the earliest in input
// order" -- a stack instead of a queue reverses this and passes everything else.
test("breaks ties by input order", async () => {
  const started = [];
  await settleWithin(runGraph([
    { id: "gate" },
    { id: "third", deps: ["gate"] },
    { id: "second", deps: ["gate"] },
    { id: "first", deps: ["gate"] },
  ], async (task) => { started.push(task.id); return 1; }, { concurrency: 1 }), 10000, "order");

  assert.deepEqual(started, ["gate", "third", "second", "first"],
    `saw ${started.join(",")}`);
});

test("returns one result per input task, in input order, and does not mutate inputs", async () => {
  const tasks = Object.freeze([
    Object.freeze({ id: "x" }),
    Object.freeze({ id: "y", deps: Object.freeze(["x"]) }),
  ]);
  const results = await settleWithin(runGraph(tasks, async (t) => t.id), 10000, "shape");
  assert.deepEqual(results.map((r) => r.id), ["x", "y"]);
  assert.equal(results.length, 2);
});

test("an empty graph resolves to an empty result list", async () => {
  assert.deepEqual(await settleWithin(runGraph([], async () => 1), 5000, "empty"), []);
});
