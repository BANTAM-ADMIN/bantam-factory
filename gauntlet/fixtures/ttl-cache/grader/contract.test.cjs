const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const load = () => import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/ttl-cache.js")).href + `?t=${Date.now()}`);

test("uses injected time and expires exactly at deadline", async () => {
  const { createTtlCache } = await load();
  let time = 100;
  const cache = createTtlCache({ now: () => time });
  cache.set("x", 3, 5);
  time = 104; assert.equal(cache.get("x"), 3);
  time = 105; assert.equal(cache.get("x"), undefined);
  assert.equal(cache.has("x"), false);
});

test("zero TTL and invalid TTL", async () => {
  const { createTtlCache } = await load();
  const cache = createTtlCache({ now: () => 20 });
  cache.set("zero", 1, 0);
  assert.equal(cache.has("zero"), false);
  for (const ttl of [-1, Infinity, NaN, "5"]) assert.throws(() => cache.set("x", 1, ttl), TypeError);
});

test("delete and clear", async () => {
  const { createTtlCache } = await load();
  const cache = createTtlCache({ now: () => 0 });
  cache.set("a", 1, 10).set("b", 2, 10);
  assert.equal(cache.delete("a"), true);
  cache.clear();
  assert.equal(cache.has("b"), false);
});
