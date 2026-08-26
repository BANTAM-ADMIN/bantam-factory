import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// scaffold-first used to say: build your own oracle. On a task that HANDS you
// the oracle (write-compressor's /app/decomp) that advice produced a 48-turn
// Python re-implementation of the decoder that was never once actually run.
// The provided reference must be named as the oracle BEFORE "write your own".
const src = fs.readFileSync(new URL("../src/prompt-rules.js", import.meta.url), "utf8");
const rule = src.slice(src.indexOf('id: "scaffold-first"'));
const text = rule.slice(rule.indexOf("text: `") + 7, rule.indexOf("`,", rule.indexOf("text: `")));

test("scaffold-first names a PROVIDED reference as the oracle before suggesting a self-written one", () => {
  const provided = text.indexOf("ORACLE IS ALREADY HANDED TO YOU");
  const selfWritten = text.indexOf("write a small, trusted ORACLE yourself");
  assert.ok(provided >= 0, "the provided-oracle clause is missing");
  assert.ok(selfWritten >= 0);
  assert.ok(provided < selfWritten, "provided-oracle must come FIRST");
});

test("it forbids re-implementing a provided reference to understand it", () => {
  assert.match(text, /Do NOT re-implement it/);
  assert.match(text, /pipe your candidate through the REAL one/);
});

test("the round-trip gate names the PROVIDED decoder, not a self-made one", () => {
  assert.match(text, /round-trip through the PROVIDED decoder/);
});
