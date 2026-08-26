// The bounce form of "constants must be read, not recalled" — the 2026-08-18
// bake-off's measured escalation: three arms wrote three different
// hallucinated enum tables; the provenance HINT was waved past the same
// night. A done that ships an int-keyed table is bounced once unless the run's
// observations show at least two of its key->name pairs together (the shape a
// real source produces and recall does not).
import { test } from "node:test";
import assert from "node:assert/strict";
import { constantGroundingObjection, tableEntries } from "../src/logic/constant-grounding.js";

const TABLE = 'QUANTS = {\n    12: ("Q4_K", 144),\n    13: ("Q5_K", 176),\n    14: ("Q6_K", 210),\n}';

test("an ungrounded table bounces the done", () => {
  const turns = [
    { action: { a: "write_file", p: "gguf-scope", content: TABLE }, observation: "wrote 90 bytes" },
    { action: { a: "shell", c: "python3 gguf-scope f.gguf" }, observation: "Q4_K 275 tensors" },
  ];
  const msg = constantGroundingObjection(turns, 0);
  assert.ok(msg); assert.match(msg, /constant-grounding/); assert.match(msg, /never READ/);
});

test("a table whose pairs were sighted in a source read passes", () => {
  const turns = [
    { action: { a: "read_file", p: "site-packages/gguf/constants.py" },
      observation: "class GGMLQuantizationType(IntEnum):\n    Q4_K = 12\n    Q5_K = 13\n    Q6_K = 14" },
    { action: { a: "write_file", p: "gguf-scope", content: TABLE }, observation: "wrote 90 bytes" },
  ];
  assert.equal(constantGroundingObjection(turns, 0), null);
});

test("report-style output (names with counts, not keys) does not count as grounding", () => {
  const turns = [
    { action: { a: "write_file", p: "tool", content: TABLE }, observation: "wrote" },
    { action: { a: "shell", c: "python3 tool f.gguf" }, observation: "Q4_K   275 tensors  70.8 GiB\nQ5_K   165 tensors" },
  ];
  assert.ok(constantGroundingObjection(turns, 0), "counts alongside names must not ground the table");
});

test("small literal maps stay invisible; bounce budget respected", () => {
  assert.equal(tableEntries({ a: "replace", new: "x = {1: 'a'}" }).length, 0);
  const turns = [{ action: { a: "write_file", p: "t", content: TABLE }, observation: "w" }];
  assert.equal(constantGroundingObjection(turns, 1), null);
});
