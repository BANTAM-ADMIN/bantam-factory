import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("returns a first-attempt success", async () => {
  assert.equal(await retry(async () => 7), 7);
});
