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
