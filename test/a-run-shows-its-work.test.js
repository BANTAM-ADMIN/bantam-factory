import assert from "node:assert/strict";
import test from "node:test";

import { demonstrationOf } from "../src/interactive-verdict.js";

// Mined from the operator's real sessions: praise follows demonstrations —
// "perfect. Ok, dial it in and test it out. Show me it working." A summary
// makes a claim; the receipt shows the thing running. The chat ✓ line now
// carries the last deliverable run's real output.

const shellTurn = (c, observation) => ({ parsedAction: { a: "shell", c }, observation });

test("the receipt is the last deliverable run's output", () => {
  const d = demonstrationOf({ turns: [
    shellTurn("node calc.js '1+2*3'", "$ node calc.js '1+2*3'\ncwd: /x\nexit 0\n7"),
    { parsedAction: { a: "read_file", p: "calc.js" }, observation: "…" },
  ] });
  assert.equal(d.command, "node calc.js '1+2*3'");
  assert.deepEqual(d.output, ["7"]);
});

test("probes and installs are not demonstrations", () => {
  const d = demonstrationOf({ turns: [
    shellTurn("npm install left-pad", "added 1 package"),
  ] });
  assert.equal(d, null);
});

test("no deliverable run means no receipt — absence is honest", () => {
  assert.equal(demonstrationOf({ turns: [
    { parsedAction: { a: "replace", p: "x.js" }, observation: "replaced 1 occurrence" },
  ] }), null);
});

test("an errored run is not a demonstration", () => {
  assert.equal(demonstrationOf({ turns: [
    shellTurn("node calc.js", "ERROR: refused"),
  ] }), null);
});

test("a paused run's edited files are listed, not hidden", async () => {
  const { editedPathsOf } = await import("../src/interactive-verdict.js");
  const res = { turns: [
    { parsedAction: { a: "write_file", p: "sw.js" }, observation: "wrote 1777 bytes" },
    { parsedAction: { a: "replace", p: "main.tsx" }, observation: "replaced 1 occurrence" },
    { parsedAction: { a: "replace", p: "main.tsx" }, observation: "replaced 1 occurrence" },
    { parsedAction: { a: "replace", p: "broken.ts" }, observation: "ERROR: old not found" },
    { parsedAction: { a: "read_file", p: "other.ts" }, observation: "1\tx" },
  ] };
  const { paths, more } = editedPathsOf(res);
  assert.deepEqual(paths, ["sw.js", "main.tsx"], "distinct successful edits in first-touch order");
  assert.equal(more, 0);
});
