import assert from "node:assert/strict";
import test from "node:test";
import * as adapters from "../src/index.js";

test("exports the twelve migration adapters", () => {
  assert.equal(Object.keys(adapters).length, 12);
  assert.ok(Object.values(adapters).every((value) => typeof value === "function"));
});

test("keeps established happy-path behavior", () => {
  assert.equal(adapters.normalizeId(" abc "), "abc");
  assert.equal(adapters.parseCount("12"), 12);
  assert.equal(adapters.parseEnabled("true"), true);
  assert.deepEqual(adapters.normalizeTags(["a", "b"]), ["a", "b"]);
  assert.equal(adapters.normalizeDate("2026-01-02T00:00:00.000Z"), "2026-01-02T00:00:00.000Z");
});
