import assert from "node:assert/strict";
import test from "node:test";

import { reconstructWorkspaceAt, summarizeTurns, rewindPlan } from "../src/rewind.js";

// A tiny synthetic run: write, edit, edit — so we can assert exact state at each turn.
const ART = {
  runId: "r1",
  turns: [
    { i: 0, parsedAction: { a: "write_file", p: "/app/x.c", content: "int a=1;\nint b=2;\n" }, observation: "wrote" },
    { i: 1, parsedAction: { a: "shell", c: "gcc x.c" }, observation: "exit 0" },
    { i: 2, parsedAction: { a: "replace", p: "/app/x.c", old: "int a=1;", new: "int a=9;" }, observation: "replaced" },
    { i: 3, parsedAction: { a: "replace", p: "/app/x.c", old: "int b=2;", new: "int b=8;" }, observation: "replaced" },
  ],
};

test("reconstructs exact workspace at each turn (rewind is lossless)", () => {
  assert.equal(reconstructWorkspaceAt(ART, 0)["/app/x.c"], "int a=1;\nint b=2;\n");
  assert.equal(reconstructWorkspaceAt(ART, 1)["/app/x.c"], "int a=1;\nint b=2;\n", "shell turn changes nothing");
  assert.equal(reconstructWorkspaceAt(ART, 2)["/app/x.c"], "int a=9;\nint b=2;\n", "first replace applied");
  assert.equal(reconstructWorkspaceAt(ART, 3)["/app/x.c"], "int a=9;\nint b=8;\n", "both replaces applied");
});

test("a replace whose `old` is absent leaves the file untouched (NO_CHANGE parity)", () => {
  const art = { turns: [
    { i: 0, parsedAction: { a: "write_file", p: "/f", content: "hello" } },
    { i: 1, parsedAction: { a: "replace", p: "/f", old: "NOTHERE", new: "x" } },
  ] };
  assert.equal(reconstructWorkspaceAt(art, 1)["/f"], "hello");
});

test("summarizeTurns flags failing observations and lists actions", () => {
  const rows = summarizeTurns(ART);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kind, "write_file");
  assert.equal(rows[0].target, "/app/x.c");
  // a segfault observation gets the ✗ marker
  const withFail = summarizeTurns({ turns: [{ i: 0, parsedAction: { a: "shell", c: "./a.out" }, observation: "exit 139 segfault" }] });
  assert.equal(withFail[0].ok, "✗");
});

test("rewindPlan reports files and a ready resume command", () => {
  const plan = rewindPlan(ART, 2, { artifactPath: "/tmp/run.json", workspace: "/tmp/ws" });
  assert.equal(plan.throughTurn, 2);
  assert.equal(plan.fileCount, 1);
  assert.match(plan.command, /--resume-run \/tmp\/run\.json --through-turn 2/);
  assert.match(plan.command, /--workspace \/tmp\/ws/);
});
