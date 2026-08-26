import assert from "node:assert/strict";
import test from "node:test";
import { KeyedTaskPool } from "../src/keyed-task-pool.js";
import { runPlan } from "../src/run-plan.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test("coalesces exact Promise identity and reuses a key after settlement", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const gate = deferred();
  let calls = 0;
  const first = pool.run("same", () => { calls += 1; return gate.promise; });
  const duplicate = pool.run("same", () => { calls += 1; return "wrong"; });
  assert.strictEqual(first, duplicate);
  gate.resolve("ok");
  assert.equal(await first, "ok");
  assert.equal(calls, 1);
  await pool.onIdle();
  assert.notStrictEqual(pool.run("same", () => "again"), first);
});

test("runPlan preserves input order and first duplicate payload", async () => {
  const reason = { code: "NO" };
  const results = await runPlan([
    { key: "a", payload: 2 },
    { key: "bad", payload: 4 },
    { key: "a", payload: 99 }
  ], async (payload, key) => {
    if (key === "bad") throw reason;
    return payload * 3;
  }, { concurrency: 2 });
  assert.deepEqual(results, [
    { key: "a", status: "fulfilled", value: 6 },
    { key: "bad", status: "rejected", reason },
    { key: "a", status: "fulfilled", value: 6 }
  ]);
});

// --- Repro strengthened from the TASK's stated invariants, not from the hidden
// --- grader. Each test below quotes the clause it exercises. The original suite
// --- runs everything at concurrency 1 with a single key, so it cannot observe
// --- queue drain, FIFO across distinct keys, capacity release on a synchronous
// --- throw, or onIdle with queued work -- which is where the failures live.

// "runs at most concurrency unique tasks at once"
test("never exceeds the concurrency limit", async () => {
  const pool = new KeyedTaskPool({ concurrency: 2 });
  let live = 0, peak = 0;
  const gates = [];
  const runs = ["a", "b", "c", "d"].map((k) => pool.run(k, () => {
    live += 1; peak = Math.max(peak, live);
    const g = deferred(); gates.push(g);
    return g.promise.then(() => { live -= 1; return k; });
  }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the limit of 2`);
  while (gates.length) gates.shift().resolve();
  await new Promise((r) => setTimeout(r, 0));
  while (gates.length) gates.shift().resolve();
  assert.deepEqual(await Promise.all(runs), ["a", "b", "c", "d"]);
});

// "starts unique queued keys FIFO"
test("starts queued keys in first-in order", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const started = [];
  const gate = deferred();
  const first = pool.run("first", () => { started.push("first"); return gate.promise; });
  const rest = ["b", "c", "d"].map((k) => pool.run(k, () => { started.push(k); return k; }));
  gate.resolve("first");
  await Promise.all([first, ...rest]);
  assert.deepEqual(started, ["first", "b", "c", "d"]);
});

// "handle synchronous throws without leaking capacity"
test("a synchronous throw does not leak a slot", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  await assert.rejects(pool.run("boom", () => { throw new Error("sync"); }));
  assert.equal(await pool.run("after", () => "ok"), "ok", "capacity was not released");
});

// "resolve every pending onIdle waiter only when both running and queued work are empty"
test("onIdle waits for queued work, and a long queue drains", async () => {
  const pool = new KeyedTaskPool({ concurrency: 2 });
  const done = [];
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
  for (const k of keys) pool.run(k, async () => { done.push(k); return k; });
  let settled = false;
  const idle = pool.onIdle().then(() => { settled = true; });
  assert.equal(settled, false, "onIdle resolved while work was still queued");
  await idle;
  assert.equal(done.length, 12, "the queue did not fully drain");
});

// "coalesces an already QUEUED or running key by returning the exact same
// Promise without invoking the later task" -- the original suite only ever
// coalesces a RUNNING key (concurrency 1, single key), so the queued half of
// that clause was never exercised.
test("coalesces a queued key, not just a running one", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const blocker = deferred();
  const gate = deferred();
  const started = [];

  const running = pool.run("busy", () => { started.push("busy"); return blocker.promise; });
  const queued = pool.run("later", () => { started.push("later"); return gate.promise; });
  const duplicate = pool.run("later", () => { started.push("must-not-run"); return "wrong"; });

  assert.strictEqual(duplicate, queued, "a duplicate of a QUEUED key must return the same Promise");
  assert.deepEqual(started, ["busy"], "the queued task must not have started yet");

  blocker.resolve("b");
  await running;
  gate.resolve("l");
  assert.equal(await queued, "l");
  assert.equal(await duplicate, "l");
  assert.deepEqual(started, ["busy", "later"], "the coalesced duplicate task must never be invoked");
  await pool.onIdle();
});

// "Keep the key coalesced until settlement, then allow reuse."
//
// SETTLEMENT, not idleness. The key must be reusable the moment its value is
// observed -- immediately after `await`, with no onIdle in between. An earlier
// version of this test awaited pool.onIdle() before reusing the key, which let a
// pool that retires keys on idle (or in a later microtask) pass while failing the
// real contract. That leniency hid the defect through five oracle revisions.
test("retires a key as soon as its settlement is observed, without waiting for idle", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const gate = deferred();
  const first = pool.run("k", () => gate.promise);
  assert.strictEqual(pool.run("k", () => "no"), first, "still coalesced while running");

  gate.resolve("done");
  assert.equal(await first, "done");

  // No onIdle here, deliberately.
  const again = pool.run("k", () => "fresh");
  assert.notStrictEqual(again, first, "the key must be reusable the instant its settlement is observed");
  assert.equal(await again, "fresh");
  await pool.onIdle();
});

// The same rule while other work is still in flight: settling one key must retire
// it even though the pool is nowhere near idle.
test("retires a settled key while the pool is still busy", async () => {
  const pool = new KeyedTaskPool({ concurrency: 2 });
  const held = deferred();
  const gate = deferred();
  const busy = pool.run("busy", () => held.promise);
  const target = pool.run("target", () => gate.promise);

  gate.resolve("first");
  assert.equal(await target, "first");

  const reused = pool.run("target", () => "second");
  assert.notStrictEqual(reused, target, "a settled key must retire even while the pool is busy");
  assert.equal(await reused, "second");

  held.resolve("done");
  await busy;
  await pool.onIdle();
});

// "resolve every pending onIdle waiter only when BOTH running and queued work
// are empty" -- a waiter registered while only one task is running must still
// wait for work queued AFTER it registered. A pool that resolves waiters when
// the running set empties, without re-checking the queue, passes every earlier
// test here and fails this one.
test("onIdle waiters registered before later work still wait for it", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const gate = deferred();
  const order = [];

  const first = pool.run("first", () => gate.promise);
  const waiters = [pool.onIdle(), pool.onIdle()].map((p) => p.then(() => order.push("idle")));
  const queued = pool.run("queued", () => { order.push("queued-ran"); return "two"; });

  gate.resolve("one");
  await first;
  assert.equal(await queued, "two");
  await Promise.all(waiters);

  assert.equal(order.filter((o) => o === "idle").length, 2, "both waiters must resolve");
  assert.equal(order[0], "queued-ran", "no waiter may resolve before the queued work ran");
});

// "run requires a non-empty string key" -- ANY non-empty string, including names
// that collide with Object.prototype. A pool keyed by a plain object silently
// mishandles these; a Map does not.
test("prototype-named keys behave like any other key", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const started = [];
  const gate = deferred();
  const a = pool.run("__proto__", () => { started.push("__proto__"); return gate.promise; });
  const dup = pool.run("__proto__", () => { started.push("nope"); return "wrong"; });
  const b = pool.run("constructor", () => { started.push("constructor"); return "C"; });

  assert.strictEqual(dup, a, "__proto__ must coalesce like any key");
  gate.resolve("A");
  assert.equal(await a, "A");
  assert.equal(await b, "C");
  assert.deepEqual(started, ["__proto__", "constructor"]);

  const fresh = pool.run("__proto__", () => "again");
  assert.notStrictEqual(fresh, a, "the key must be reusable after settlement");
  assert.equal(await fresh, "again");
  await pool.onIdle();
});

// "starts unique queued keys FIFO" at scale: a drain that recurses per
// completion can exhaust the stack on a long queue.
test("a long queue drains completely and in order", async () => {
  const pool = new KeyedTaskPool({ concurrency: 2 });
  const values = await Promise.all(
    Array.from({ length: 400 }, (_, i) => pool.run(`key-${i}`, () => i)),
  );
  assert.equal(values.length, 400);
  assert.equal(values.at(-1), 399);
  await pool.onIdle();
});

// "runPlan validates its ENTIRE { key, payload } array and worker BEFORE
// starting work" -- one bad entry anywhere means no worker call happens at all.
// A runPlan that validates lazily as it iterates passes every other test here.
test("runPlan validates the whole plan before running anything", async () => {
  let calls = 0;
  const worker = () => { calls += 1; };

  await assert.rejects(runPlan(
    [{ key: "valid", payload: 1 }, { key: "", payload: 2 }],
    worker,
    { concurrency: 2 },
  ), TypeError);
  assert.equal(calls, 0, "no work may start when any entry is invalid");

  await assert.rejects(runPlan([{ key: "a", payload: 1 }], "not-a-function"), TypeError);
  assert.equal(calls, 0);
});

// "never mutates inputs" and "preserves reason identity".
test("runPlan preserves reason identity and does not mutate its inputs", async () => {
  const reason = { code: "NOPE" };
  const steps = [{ key: "a", payload: 1 }, { key: "b", payload: 2 }];
  const snapshot = JSON.parse(JSON.stringify(steps));

  const results = await runPlan(steps, async (payload, key) => {
    if (key === "b") throw reason;
    return payload;
  }, { concurrency: 2 });

  assert.deepEqual(steps, snapshot, "the input plan must not be mutated");
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected, "the failing step must be reported as rejected");
  assert.strictEqual(rejected.reason, reason, "the exact rejection reason must survive");
});

// "runs at most concurrency unique tasks at once" -- AT ALL TIMES, including
// while draining. A pool that releases the whole queue when a slot frees keeps
// FIFO order and settles everything, so every other test here passes; only a
// live concurrency check during the drain catches it.
test("respects the concurrency limit while draining, not just at admission", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const started = [];
  const gates = new Map();
  const gateFor = (k) => { const g = deferred(); gates.set(k, g); return g.promise; };

  const blocker = pool.run("blocker", () => { started.push("blocker"); return gateFor("blocker"); });
  const rest = ["a", "b", "c"].map((k) => pool.run(k, () => { started.push(k); return gateFor(k); }));

  assert.deepEqual(started, ["blocker"], "only one task may start at concurrency 1");

  gates.get("blocker").resolve("done");
  await blocker;
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["blocker", "a"],
    "exactly ONE queued task may start when a single slot frees");

  gates.get("a").resolve("a");
  await rest[0];
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["blocker", "a", "b"], "still one at a time");

  // At concurrency 1, c cannot have started yet -- it only gets a gate once b
  // frees the slot, so each gate must be resolved in turn.
  gates.get("b").resolve("b");
  await rest[1];
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started, ["blocker", "a", "b", "c"], "the last queued task starts only after b frees the slot");

  gates.get("c").resolve("c");
  await Promise.all(rest);
  await pool.onIdle();
});

// The same invariant at concurrency 2, tracking live count across the whole run
// rather than only at admission.
test("peak concurrency holds across the entire run", async () => {
  const pool = new KeyedTaskPool({ concurrency: 2 });
  let live = 0, peak = 0;
  const gates = [];
  const runs = Array.from({ length: 6 }, (_, i) => pool.run(`k${i}`, () => {
    live += 1; peak = Math.max(peak, live);
    const g = deferred(); gates.push(g);
    return g.promise.then((v) => { live -= 1; return v; });
  }));

  for (let round = 0; round < 6; round++) {
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(peak <= 2, `concurrency exceeded during drain: peak ${peak}`);
    const g = gates.shift();
    if (g) g.resolve("ok");
  }
  await Promise.all(runs);
  await pool.onIdle();
  assert.ok(peak <= 2, `concurrency exceeded overall: peak ${peak}`);
});

// "KeyedTaskPool accepts { concurrency = 2 }, rejects invalid concurrency with
// RangeError" -- nothing in this suite exercised the constructor at all. A pool
// whose guard is `if (concurrency < 1) throw` passes every other test here and
// silently accepts 1.5, NaN and "2".
// `null` and `{}` are deliberately NOT in this list. The task writes
// `{ concurrency = 2 }`, which under destructuring-default semantics makes `null`
// invalid, but under `?? 2` makes it the default -- and the contract does not
// settle which. A reference implementation using `?? 2` satisfies the contract in
// full, so asserting either way here invents a requirement. Measured cost of
// having done so: one run thrashed three consecutive edits on this single
// assertion and was killed by the wall clock without ever producing a verdict.
test("rejects invalid concurrency with RangeError", () => {
  for (const bad of [0, -1, 1.5, NaN, "2"]) {
    assert.throws(
      () => new KeyedTaskPool({ concurrency: bad }),
      RangeError,
      `concurrency ${JSON.stringify(bad)} must be rejected with RangeError`,
    );
  }
  // The documented default and ordinary positive integers must still work.
  assert.doesNotThrow(() => new KeyedTaskPool());
  assert.doesNotThrow(() => new KeyedTaskPool({ concurrency: 1 }));
  assert.doesNotThrow(() => new KeyedTaskPool({ concurrency: 8 }));
});

// "run requires a non-empty string key and function task" -- validated
// SYNCHRONOUSLY, i.e. run() throws rather than returning a rejected promise.
test("run validates its arguments synchronously", () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  for (const bad of ["", null, 7, {}]) {
    assert.throws(() => pool.run(bad, () => 1), TypeError, `key ${JSON.stringify(bad)} must throw`);
  }
  for (const bad of [null, "nope", 7]) {
    assert.throws(() => pool.run("k", bad), TypeError, "a non-function task must throw");
  }
});

// "a task failure is observed through the returned Promise, not as a synchronous
// throw from run" -- the mirror of the rule above, and easy to break while fixing it.
test("a task's synchronous throw surfaces as a rejected promise, not a throw from run", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const reason = new Error("boom");
  let returned;
  assert.doesNotThrow(() => { returned = pool.run("k", () => { throw reason; }); });
  assert.ok(returned instanceof Promise);
  await assert.rejects(returned, (e) => e === reason);
  await pool.onIdle();
});

// "coalesces an already queued or running key ... WITHOUT INVOKING THE LATER TASK".
// The suite asserted the promise identity of that clause but never its second
// half. An implementation that submits steps sequentially -- awaiting each before
// submitting the next -- retires every key before its duplicate arrives, so
// nothing coalesces and the worker runs once per STEP instead of once per KEY.
// It then passes the results-only assertion above by threading the first payload
// through a side Map, which produces identical values from a second invocation.
// Counting invocations is the only thing that separates the two.
test("runPlan invokes the worker once per key, not once per step", async () => {
  const calls = [];
  const results = await runPlan([
    { key: "shared", payload: 3 },
    { key: "other", payload: 5 },
    { key: "shared", payload: 999 }
  ], async (payload, key) => { calls.push(key); return payload * 2; }, { concurrency: 1 });

  assert.equal(calls.length, 2, `the duplicate key must not invoke the task again (saw ${calls.join(", ")})`);
  assert.deepEqual([...calls].sort(), ["other", "shared"]);
  assert.equal(results[0].value, 6, "first payload wins");
  assert.equal(results[2].value, 6, "the duplicate reports the coalesced value");
  assert.notStrictEqual(results[0], results[2], "each input step gets its own result object");
});

// "starts unique queued keys FIFO" + "Keep the key coalesced until settlement,
// then allow reuse". The existing retirement test reuses a key that ran
// IMMEDIATELY; this one reuses a key that had to wait in the queue behind a
// blocker. An implementation that retires on the queue-drain path but not on the
// settle path passes the first and fails this one.
test("a key that ran from the queue is reusable the instant it settles", async () => {
  const pool = new KeyedTaskPool({ concurrency: 1 });
  const blocker = deferred();
  const gate = deferred();
  const starts = [];

  const running = pool.run("blocker", () => { starts.push("blocker"); return blocker.promise; });
  const queued = pool.run("later", () => { starts.push("later"); return gate.promise; });
  const duplicate = pool.run("later", () => { starts.push("never"); return "never"; });
  assert.strictEqual(queued, duplicate, "a queued key coalesces too");

  blocker.resolve("b");
  await running;
  await Promise.resolve();
  assert.deepEqual(starts, ["blocker", "later"], "the queued key starts once the slot frees");

  gate.resolve("L");
  assert.equal(await queued, "L");
  const again = pool.run("later", () => "fresh");
  assert.notStrictEqual(again, queued, "reuse must not return the retired promise");
  assert.equal(await again, "fresh");
  assert.deepEqual(starts, ["blocker", "later"], "the coalesced duplicate never ran");
  await pool.onIdle();
});
