import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "../src/merge-config.js";

test("combines top-level properties", () => {
  assert.deepEqual(mergeConfig({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});
