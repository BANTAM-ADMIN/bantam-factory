// Hidden contract for dependency-scheduler.
//
// Calibrated against four specimens before use:
//   reference implementation       4/4 pass
//   rejects dependents (not skip)  fails the propagation test
//   stack instead of queue         fails the input-order test, and only that one
//   redundant sort removed         passes, correctly: behaviour is identical
//
// Every runGraph call is bounded. A submission whose graph never settles drains
// the event loop with a pending promise and node exits before any per-test
// timeout fires, so EVERY test reports cancelledByParent and one defect looks
// like four. Observed with an implementation that marked direct dependents
// rejected while leaving their own dependents pending forever.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = process.env.CANDIDATE_ROOT;
const load = () => import(
  `${pathToFileURL(path.join(root, "src", "scheduler.js")).href}?t=${Date.now()}-${Math.random()}`
);

function settleWithin(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    // Deliberately NOT unref'd. A hung submission leaves nothing else keeping the
    // event loop alive, so an unref'd timer lets node exit before the timeout can
    // fire -- which is the very cascade this helper exists to prevent. The timer
    // is cleared on the winning path below.
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`runGraph did not settle within ${ms}ms (${label})`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

test("validates the whole graph before running anything", { timeout: 20000 }, async () => {
  const { runGraph } = await load();
  let calls = 0;
  const run = async () => { calls += 1; };

  await assert.rejects(runGraph([{ id: "a" }, { id: "b", deps: ["nope"] }], run), TypeError);
  assert.equal(calls, 0, "an unknown dependency must be caught before any task runs");

  await assert.rejects(runGraph([
    { id: "a", deps: ["c"] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] },
  ], run), TypeError);
  assert.equal(calls, 0, "a cycle must be caught before any task runs");

  await assert.rejects(runGraph([{ id: "a" }, { id: "a" }], run), TypeError);
  await assert.rejects(runGraph([{ id: "a" }], run, { concurrency: 0 }), RangeError);
  assert.equal(calls, 0);
});

// The interaction that matters: a failure must SKIP dependents transitively, not
// reject them, while independent branches continue to completion.
test("propagates failure as skipped, transitively, without harming siblings", { timeout: 20000 }, async () => {
  const { runGraph } = await load();
  const reason = { code: "boom" };
  const graph = runGraph([
    { id: "root" },
    { id: "mid", deps: ["root"] },
    { id: "leaf", deps: ["mid"] },
    { id: "other" },
    { id: "otherLeaf", deps: ["other"] },
  ], async (task) => {
    if (task.id === "root") throw reason;
    return task.id.toUpperCase();
  }, { concurrency: 2 });

  const results = await settleWithin(graph, 15000, "failure propagation");
  const by = Object.fromEntries(results.map((r) => [r.id, r]));

  assert.equal(by.root.status, "rejected");
  assert.strictEqual(by.root.reason, reason, "rejection identity must survive");
  assert.equal(by.mid.status, "skipped", "a direct dependent of a failure is skipped, not rejected");
  assert.equal(by.leaf.status, "skipped", "skipping must be transitive");
  assert.equal(by.other.status, "fulfilled", "an independent branch must still run");
  assert.equal(by.otherLeaf.status, "fulfilled");
  assert.equal(results.length, 5);
  assert.deepEqual(results.map((r) => r.id), ["root", "mid", "leaf", "other", "otherLeaf"],
    "results follow input order");
});

// Determinism under concurrency: when several tasks become ready at the SAME
// moment, the earliest in input order runs first. An implementation using a stack
// rather than a queue gets a plausible but different order here.
test("breaks ties by input order when several tasks become ready at once", { timeout: 20000 }, async () => {
  const { runGraph } = await load();
  const started = [];
  const graph = runGraph([
    { id: "gate" },
    { id: "c", deps: ["gate"] },
    { id: "b", deps: ["gate"] },
    { id: "a", deps: ["gate"] },
  ], async (task) => { started.push(task.id); return task.id; }, { concurrency: 1 });

  const results = await settleWithin(graph, 15000, "input-order tiebreak");
  assert.deepEqual(started, ["gate", "c", "b", "a"],
    `simultaneous ready tasks must start in input order, saw ${started.join(",")}`);
  assert.equal(results.every((r) => r.status === "fulfilled"), true);
});

test("never exceeds concurrency and still drains a wide graph", { timeout: 30000 }, async () => {
  const { runGraph } = await load();
  let live = 0;
  let peak = 0;
  const tasks = [{ id: "seed" }];
  for (let i = 0; i < 40; i += 1) tasks.push({ id: `t${i}`, deps: ["seed"] });

  const graph = runGraph(tasks, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live -= 1;
    return 1;
  }, { concurrency: 3 });

  const results = await settleWithin(graph, 25000, "wide graph drain");
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  assert.equal(results.length, 41);
  assert.equal(results.every((r) => r.status === "fulfilled"), true, "the graph must fully drain");
});
