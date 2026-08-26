const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const load = () => import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/merge-config.js")).href + `?t=${Date.now()}`);

test("deep merges objects, replaces arrays, and preserves inputs", async () => {
  const { mergeConfig } = await load();
  const base = { db: { host: "a", flags: { ssl: true } }, list: [1, 2] };
  const override = { db: { port: 9, flags: { trace: true } }, list: [3] };
  const baseCopy = structuredClone(base), overrideCopy = structuredClone(override);
  assert.deepEqual(mergeConfig(base, override), {
    db: { host: "a", port: 9, flags: { ssl: true, trace: true } },
    list: [3],
  });
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(override, overrideCopy);
});

test("blocks prototype pollution at every depth", async () => {
  const { mergeConfig } = await load();
  const attack = JSON.parse('{"safe":{"constructor":{"prototype":{"polluted":"yes"}}},"__proto__":{"polluted":"yes"}}');
  const result = mergeConfig({ safe: { retained: true } }, attack);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result, { safe: { retained: true } });
});
