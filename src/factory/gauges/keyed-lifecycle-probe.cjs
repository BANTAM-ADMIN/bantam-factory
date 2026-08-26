// Public-contract-derived focused gauge for the async keyed lifecycle cell.
// This is intentionally separate from every fixture's hidden contract grader.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = process.cwd();
const load = (file) => import(`${pathToFileURL(path.join(root, "src", file)).href}?factory=${Date.now()}-${Math.random()}`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = async () => { await Promise.resolve(); await Promise.resolve(); };

test("factory gauge: queued duplicates coalesce and drain stays within capacity", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const blocker = deferred();
  const gates = new Map();
  const started = [];
  let live = 0;
  let peak = 0;
  const run = (key, gate) => pool.run(key, () => {
    started.push(key);
    live++;
    peak = Math.max(peak, live);
    return gate.promise.finally(() => { live--; });
  });
  const first = run("blocker", blocker);
  const aGate = deferred();
  gates.set("a", aGate);
  const a = run("a", aGate);
  const duplicate = pool.run("a", () => { throw new Error("duplicate task ran"); });
  const bGate = deferred();
  gates.set("b", bGate);
  const b = run("b", bGate);
  assert.strictEqual(duplicate, a);
  assert.deepEqual(started, ["blocker"]);
  blocker.resolve("blocker");
  await first;
  await turn();
  assert.deepEqual(started, ["blocker", "a"]);
  assert.equal(peak, 1);
  aGate.resolve("a");
  await a;
  await turn();
  assert.deepEqual(started, ["blocker", "a", "b"]);
  bGate.resolve("b");
  await b;
  await pool.onIdle();
  assert.equal(peak, 1);
});

test("factory gauge: keys retire before fulfillment and rejection are observable", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const fulfilled = pool.run("fulfilled", () => "one");
  assert.equal(await fulfilled, "one");
  const fulfilledAgain = pool.run("fulfilled", () => "two");
  assert.notStrictEqual(fulfilledAgain, fulfilled);
  assert.equal(await fulfilledAgain, "two");

  const reason = Object.freeze({ code: "factory-rejection" });
  let rejected;
  assert.doesNotThrow(() => { rejected = pool.run("rejected", () => { throw reason; }); });
  await assert.rejects(rejected, (error) => error === reason);
  const rejectedAgain = pool.run("rejected", () => "reused");
  assert.notStrictEqual(rejectedAgain, rejected);
  assert.equal(await rejectedAgain, "reused");
  await pool.onIdle();
});

test("factory gauge: synchronous reentrancy sees the published key association", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  let nested;
  const first = pool.run("same", () => {
    nested = pool.run("same", () => "must-not-run");
    return "outer";
  });
  assert.strictEqual(nested, first);
  assert.equal(await first, "outer");
  await pool.onIdle();
});

test("factory gauge: idle waiters include work queued after registration", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const gate = deferred();
  const order = [];
  const first = pool.run("first", () => gate.promise);
  const idle = pool.onIdle().then(() => order.push("idle"));
  const queued = pool.run("queued", () => { order.push("queued"); return "done"; });
  gate.resolve("first");
  await first;
  assert.equal(await queued, "done");
  await idle;
  assert.deepEqual(order, ["queued", "idle"]);
});
