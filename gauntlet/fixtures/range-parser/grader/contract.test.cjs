const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const load = () => import(pathToFileURL(path.join(process.env.CANDIDATE_ROOT, "src/parse-ranges.js")).href + `?t=${Date.now()}`);

test("signed, descending, whitespace, and first-appearance dedupe", async () => {
  const { parseRanges } = await load();
  assert.deepEqual(parseRanges(" 3 - 1, -2--4, 2, 3 "), [3, 2, 1, -2, -3, -4]);
  assert.deepEqual(parseRanges(""), []);
  assert.deepEqual(parseRanges("2,1-3"), [2, 1, 3]);
});

test("rejects malformed and unsafe input", async () => {
  const { parseRanges } = await load();
  for (const value of ["1,,2", "x", "1-", "--", "9007199254740992"]) {
    assert.throws(() => parseRanges(value), TypeError);
  }
});
