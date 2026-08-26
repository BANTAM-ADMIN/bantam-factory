const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = process.env.CANDIDATE_ROOT;
const load = (file) => import(
  `${pathToFileURL(path.join(root, "src", file)).href}?t=${Date.now()}-${Math.random()}`
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const turn = async () => { await Promise.resolve(); await Promise.resolve(); };

test("validates synchronously but reports task failures asynchronously", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  for (const concurrency of [0, -1, 1.5, NaN, "2"]) {
    assert.throws(() => new KeyedTaskPool({ concurrency }), RangeError);
  }
  const pool = new KeyedTaskPool();
  assert.throws(() => pool.run("", () => 1), TypeError);
  assert.throws(() => pool.run("valid", null), TypeError);
  const reason = { code: "sync-task" };
  let returned;
  assert.doesNotThrow(() => {
    returned = pool.run("task", () => { throw reason; });
  });
  assert.ok(returned instanceof Promise);
  await assert.rejects(returned, (error) => error === reason);
  await pool.onIdle();
});

test("coalesces queued work, preserves FIFO, and retires before settlement is observed", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const blocker = deferred();
  const xGate = deferred();
  const starts = [];
  const running = pool.run("blocker", () => { starts.push("blocker"); return blocker.promise; });
  const x = pool.run("__proto__", () => { starts.push("x"); return xGate.promise; });
  const duplicate = pool.run("__proto__", () => { starts.push("wrong"); return "wrong"; });
  const y = pool.run("constructor", () => { starts.push("y"); return "Y"; });
  assert.strictEqual(x, duplicate);
  await turn();
  assert.deepEqual(starts, ["blocker"]);
  blocker.resolve("done");
  await running;
  await turn();
  assert.deepEqual(starts, ["blocker", "x"]);
  xGate.resolve("X");
  assert.equal(await x, "X");
  const again = pool.run("__proto__", () => "fresh");
  assert.notStrictEqual(again, x);
  assert.equal(await again, "fresh");
  assert.equal(await y, "Y");
  assert.deepEqual(starts, ["blocker", "x", "y"]);
});

test("idle waiters include queued work and long queues drain", async () => {
  const { KeyedTaskPool } = await load("keyed-task-pool.js");
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const gate = deferred();
  const first = pool.run("first", () => gate.promise);
  const waits = [pool.onIdle(), pool.onIdle()];
  const queued = pool.run("queued", () => "two");
  gate.resolve("one");
  await first;
  assert.equal(await queued, "two");
  await Promise.all(waits);
  const values = await Promise.all(Array.from(
    { length: 1200 },
    (_, index) => pool.run(`key-${index}`, () => index),
  ));
  assert.equal(values.at(-1), 1199);
  await pool.onIdle();
});

test("runPlan validates atomically and preserves identities without mutation", async () => {
  const { runPlan } = await load("run-plan.js");
  let calls = 0;
  await assert.rejects(runPlan([
    { key: "valid", payload: 1 },
    { key: "", payload: 2 },
  ], () => { calls += 1; }), TypeError);
  assert.equal(calls, 0);
  const reason = Object.freeze({ code: "identity" });
  const firstPayload = Object.freeze({ n: 3 });
  const ignoredPayload = Object.freeze({ n: 999 });
  const steps = Object.freeze([
    Object.freeze({ key: "shared", payload: firstPayload }),
    Object.freeze({ key: "bad", payload: Object.freeze({ n: 4 }) }),
    Object.freeze({ key: "shared", payload: ignoredPayload }),
  ]);
  const seen = [];
  const results = await runPlan(steps, (payload, key) => {
    seen.push([payload, key]);
    if (key === "bad") throw reason;
    return payload.n + 1;
  }, { concurrency: 1 });
  assert.equal(seen.length, 2);
  assert.strictEqual(seen.find(([, key]) => key === "shared")[0], firstPayload);
  assert.equal(results[0].value, 4);
  assert.equal(results[2].value, 4);
  assert.notStrictEqual(results[0], results[2]);
  assert.strictEqual(results[1].reason, reason);
});
