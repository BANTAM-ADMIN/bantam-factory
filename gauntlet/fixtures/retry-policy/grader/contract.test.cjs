const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const load = () => import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/retry.js")).href + `?t=${Date.now()}`);

test("uses exact attempts and delays only before retries", async () => {
  const { retry } = await load();
  const calls = [], delays = [];
  const value = await retry(async (attempt) => {
    calls.push(attempt);
    if (attempt < 3) throw new Error(`e${attempt}`);
    return "ok";
  }, {
    attempts: 3,
    delay: async (attempt, error) => delays.push([attempt, error.message]),
  });
  assert.equal(value, "ok");
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(delays, [[1, "e1"], [2, "e2"]]);
});

test("honors predicate and preserves original error", async () => {
  const { retry } = await load();
  const original = new Error("stop");
  let calls = 0;
  await assert.rejects(() => retry(async () => { calls++; throw original; }, {
    attempts: 5,
    shouldRetry: () => false,
  }), (error) => error === original);
  assert.equal(calls, 1);
});

test("validates attempts", async () => {
  const { retry } = await load();
  for (const attempts of [0, -1, 1.5, Infinity]) {
    await assert.rejects(() => retry(async () => 1, { attempts }), TypeError);
  }
});
