import test from "node:test";
import assert from "node:assert/strict";
import { orderedMap } from "../src/ordered-map.js";

test("maps values", async () => {
  assert.deepEqual(await orderedMap([1, 2, 3], async (value) => value * 2, { concurrency: 1 }), [2, 4, 6]);
});
