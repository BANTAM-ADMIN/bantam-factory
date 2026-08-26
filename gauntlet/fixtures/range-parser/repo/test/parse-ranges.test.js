import test from "node:test";
import assert from "node:assert/strict";
import { parseRanges } from "../src/parse-ranges.js";

test("parses ascending ranges", () => {
  assert.deepEqual(parseRanges("1-3,5"), [1, 2, 3, 5]);
});
