import assert from "node:assert/strict";
import test from "node:test";

import { isComputeShellCommand } from "../src/progress-awareness.js";
import {
  ranASearch,
  taskDemandsSearch,
  unsearchedChoiceObjection,
} from "../src/logic/unsearched-choice.js";

// TB2 constraints-scheduling (2026-08-21): nine hard constraints, three ICS
// calendars, "find the earliest valid slot" — answered in prose after two shell
// calls (`cat` to look, `cat >` to write). It chose 09:00 and missed Bob's
// stated "no meetings before 10 AM". compute-dont-reason was verifiably in that
// run's prompt bytes and was waved past; a rule advises, a gate enforces.

const TASK = "Find a 1-hour meeting slot for Alice, Bob, and Carol ... Find the earliest valid time slot "
  + "that satisfies all hard constraints. Create /app/meeting_scheduled.ics";
const opts = { task: TASK, isCompute: isComputeShellCommand };
const sh = (c) => ({ action: { a: "shell", c }, observation: "" });

test("recognises a decidable search: a superlative over a candidate space", () => {
  assert.equal(taskDemandsSearch(TASK), true);
  assert.equal(taskDemandsSearch("Find the shortest path between the two nodes and write it to out.txt"), true);
  assert.equal(taskDemandsSearch("Print all valid moves, one per line"), true);
});

test("an ordinary build is NOT a search — the gate must stay out of the way", () => {
  for (const t of [
    "Write a compressor to /app/compress.py",
    "Fix the failing test in src/app.js",
    "Install nginx and configure it to log requests",
    "Build a byte-budget packer, not a claim about optimal model context. Missing array slots are invalid.",
  ]) assert.equal(taskDemandsSearch(t), false, t);
});

test('Node module-mode assertions are computation, including the live worker spelling', () => {
  assert.equal(isComputeShellCommand('node --input-type=module -e "console.log(1)"'),true);
  assert.equal(isComputeShellCommand('node --test test/boundary.test.js'),true);
  assert.equal(isComputeShellCommand('node --version'),false);
  assert.equal(isComputeShellCommand('cat script.mjs'),false);
});

test("looking and writing are not searching", () => {
  const turns = [sh("cat /app/alice_calendar.ics"), sh("cat > /app/meeting_scheduled.ics << 'EOF'\nBEGIN:VCALENDAR\nEOF")];
  assert.equal(ranASearch(turns, isComputeShellCommand), false);
  const msg = unsearchedChoiceObjection(turns, 0, opts);
  assert.ok(msg, "expected an objection");
  assert.match(msg, /ENUMERATE the candidate space in code/);
});

test("executing a search silences it", () => {
  const turns = [sh("cat /app/alice_calendar.ics"), sh('python3 -c "for h in range(9,18): print(h)"')];
  assert.equal(ranASearch(turns, isComputeShellCommand), true);
  assert.equal(unsearchedChoiceObjection(turns, 0, opts), null);
});

test("a search written to a file and run also counts", () => {
  const turns = [
    { action: { a: "write_file", p: "solve.py", content: "for slot in candidates:\n  if ok(slot): print(slot)" }, observation: "wrote" },
    sh("python3 solve.py"),
  ];
  assert.equal(ranASearch(turns, isComputeShellCommand), true);
});

test("bounded to one bounce", () => {
  const turns = [sh("cat /app/alice_calendar.ics")];
  assert.ok(unsearchedChoiceObjection(turns, 0, opts));
  assert.equal(unsearchedChoiceObjection(turns, 1, opts), null);
});

test("SEAM: the real done-gate chain reaches it", async () => {
  const { evaluateDoneGates } = await import("../src/done-gates.js");
  const d = evaluateDoneGates({
    turns: [sh("cat /app/alice_calendar.ics")],
    task: TASK,
    workspace: process.cwd(),
    interactive: false,
    verifierConfigured: true,
    workspaceGeneration: 0,
    ledgerMax: 0,
    panelComplete: new Set(),
    readWorkspaceFile: () => null,
    count: (n) => (["empty_done", "premature_done"].includes(n) ? 99 : 0),
  });
  assert.ok(d, "chain produced no decision");
  assert.equal(d.gate, "unsearched_choice");
});
