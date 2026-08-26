// Constants recalled from memory shift (arm-C's GGML enum, one slot off,
// 2026-08-18). The provenance footer fires when an edit lands a literal
// int-keyed table, pointing the worker at reading the authoritative source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { constantTableFooter } from "../src/edit-context.js";

test("an int-keyed table in an edit draws the provenance note", () => {
  const note = constantTableFooter({ a: "write_file", p: "tool", content: "QUANTS = {\n  12: (\"Q4_K\", 2),\n  13: (\"Q5_K\", 2),\n  14: (\"Q6_K\", 2),\n}" });
  assert.match(note, /\[provenance\]/);
  assert.match(note, /do not trust recall/);
});

test("ordinary code with few numeric keys stays quiet", () => {
  assert.equal(constantTableFooter({ a: "replace", p: "x.py", new: "retries = {1: true}" }), "");
  assert.equal(constantTableFooter({ a: "replace", p: "x.py", new: "if x > 3: return y[0]" }), "");
});
