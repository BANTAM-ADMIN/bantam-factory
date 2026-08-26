import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../src/ttl-cache.js";

test("stores a live value", () => {
  let time = 10;
  const cache = createTtlCache({ now: () => time });
  cache.set("a", 7, 5);
  assert.equal(cache.get("a"), 7);
});
