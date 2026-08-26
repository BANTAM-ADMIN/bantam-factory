const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

async function load() {
  return import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/ordered-map.js")).href + `?t=${Date.now()}`);
}

test("preserves order while respecting concurrency", async () => {
  const { orderedMap } = await load();
  let active = 0, peak = 0;
  const result = await orderedMap([30, 5, 15, 1], async (delay) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return delay;
  }, { concurrency: 2 });
  assert.deepEqual(result, [30, 5, 15, 1]);
  assert.ok(peak <= 2);
});

test("validates concurrency and supports empty input", async () => {
  const { orderedMap } = await load();
  assert.deepEqual(await orderedMap([], async () => 1, { concurrency: 3 }), []);
  await assert.rejects(() => orderedMap([1], async (x) => x, { concurrency: 0 }), TypeError);
  await assert.rejects(() => orderedMap([1], async (x) => x, { concurrency: 1.5 }), TypeError);
});
