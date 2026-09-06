import assert from "node:assert/strict";
import test from "node:test";

import {
  comparedAgainstTarget,
  taskStatesTarget,
  unsimulatedTargetObjection,
} from "../src/logic/simulate-to-target.js";

// TB2 dna-insert (2026-08-21): the task supplies both plasmids and asks for
// primers converting one into the other. The run spent 195/200 turns checking
// anneal lengths and melting temperatures — all green — and never built the
// product to compare against the desired plasmid. The grader derived the
// annealed region its own way (locating the insert inside rc(rev)+fwd) and
// measured 2 nucleotides against a floor of 15.

const DNA = "The file sequences.fasta contains the sequence for a circular input plasmid, and a desired output plasmid. "
  + "Design primers so that the input plasmid will be converted to the output plasmid.";
const COMP = "Write me data.comp such that running `cat data.comp | /app/decomp` gives exactly data.txt.";
const CIPHER = "Create ciphertext.bin so that decrypting it produces exactly the supplied plaintext.txt.";
const sh = (c) => ({ action: { a: "shell", c }, observation: "" });

test("recognises a stated end state", () => {
  assert.equal(taskStatesTarget(DNA), true, "desired output plasmid + converted into");
  assert.equal(taskStatesTarget(COMP), true, "gives exactly data.txt");
  assert.equal(taskStatesTarget(CIPHER), true, "cipher output must reproduce supplied plaintext");
  assert.equal(taskStatesTarget("Produce a report that is identical to reference.md"), true);
});

test("an output file with no stated contents is NOT a target", () => {
  for (const t of [
    "Write the best move for white to /app/move.txt",
    "Install nginx and write the config to /etc/nginx/nginx.conf",
    "Summarise the log and save it to summary.txt",
    "Invalid graphs produce nonempty stderr, no stdout, and exit 2.",
    "The CLI produces JSON followed by a newline, exits 0, and writes no stderr.",
    "Convert a dependency graph into a deterministic execution plan.",
    "The parser gives a helpful error for malformed records.",
  ]) assert.equal(taskStatesTarget(t), false, t);
});

test("generic CLI shape/error requirements are not task-supplied computed targets", () => {
  const task = "Repair an offline job CLI. Read a JSON graph and print only its plan as JSON followed by newline. "
    + "Invalid arguments, unreadable input, invalid JSON, or invalid graphs produce nonempty stderr, no stdout, and exit 2. "
    + "Importing the module must not run the CLI.";
  assert.equal(taskStatesTarget(task), false);
  assert.equal(unsimulatedTargetObjection([], 0, { task }), null);
  assert.ok(unsimulatedTargetObjection([], 0, { task: task + " The desired output is provided in reference.json." }));
});

test("objects when only the RULES were checked", () => {
  const turns = [sh("python3 -c \"print(tm(fwd), len(anneal))\""), sh("cat primers.fasta")];
  assert.equal(comparedAgainstTarget(turns), false);
  const msg = unsimulatedTargetObjection(turns, 0, { task: DNA });
  assert.ok(msg);
  assert.match(msg, /The target is the gauge/);
  for (const task of [COMP, CIPHER]) assert.ok(unsimulatedTargetObjection(turns, 0, { task }));
});

test("a real comparison silences it", () => {
  for (const c of [
    "cat data.comp | ./decomp > /tmp/out.txt && diff data.txt /tmp/out.txt",
    "cmp built.bin expected.bin",
    'python3 -c "assert product == desired_plasmid"',
    "sha256sum out.txt expected.txt",
  ]) {
    assert.equal(comparedAgainstTarget([sh(c)]), true, c);
    assert.equal(unsimulatedTargetObjection([sh(c)], 0, { task: DNA }), null, c);
  }
});

test("a comparison written into a script counts", () => {
  const turns = [
    { action: { a: "write_file", p: "check.py", content: "assert product == expected_plasmid\n" }, observation: "wrote" },
    sh("python3 check.py"),
  ];
  assert.equal(comparedAgainstTarget(turns), true);
});

test("accepted Node output assertions are comparison evidence across all source edit actions", () => {
  // Exact assertion shape from an accepted CLI source check; the gate must not
  // pretend no comparison exists merely because Node spells it assert.equal.
  const source = `assert.equal(r.stdout, '{"order":["a"],"ready":["a"],"blocked":[]}\\n');`;
  const actions = [
    { a: "write_file", p: "test/cli.test.js", content: source },
    { a: "replace", p: "test/cli.test.js", old: "old check", new: source },
    { a: "edit_lines", p: "test/cli.test.js", start: 1, end: 1, new: source },
    { a: "patch", edits: [{ p: "test/cli.test.js", old: "old check", new: source }] },
    { a: "write_batch", files: [{ p: "test/cli.test.js", content: source }] },
  ];
  for (const action of actions) {
    const accepted = { action, editApplied: true, observation: "accepted source edit" };
    assert.equal(comparedAgainstTarget([accepted]), true, action.a);
    assert.equal(unsimulatedTargetObjection([accepted], 0, { task: CIPHER }), null);
    for (const rejected of [
      { ...accepted, editApplied: false },
      { ...accepted, editOutcome: { applied: false } },
      { action, observation: "[scope] This edit was NOT applied." },
      { action, observation: "ERROR: source did not parse" },
    ]) assert.equal(comparedAgainstTarget([rejected]), false, action.a);
  }
});

test("Node strict and deep equality call spellings count but old/deleted or response text does not", () => {
  for (const method of ["equal", "strictEqual", "deepEqual", "deepStrictEqual", "strict.equal"]) {
    assert.equal(comparedAgainstTarget([sh(`node -e 'assert.${method}(actual, expected)'`)]), true, method);
  }
  assert.equal(comparedAgainstTarget([{ action: { a: "replace", p: "check.js",
    old: "assert.equal(actual, expected)", new: "console.log(actual)" }, editApplied: true }]), false);
  assert.equal(comparedAgainstTarget([{ action: { a: "respond", content: "assert.equal(actual, expected)" } }]), false);
});

test("blocked commands and requested-but-not-executed comparisons are not evidence", () => {
  const comparison = "cmp actual.txt expected.txt";
  for (const turn of [
    { ...sh(comparison), observation: "[repetition] This command was not executed." },
    { ...sh(comparison), shellExecution: null },
    { ...sh(comparison), shellExecution: { command: comparison, exitCode: null } },
    { ...sh(comparison), shellExecution: { command: comparison, exitCode: 0, invalidated: true } },
    { ...sh(comparison), shellExecution: { command: "printf skipped", exitCode: 0 } },
    { ...sh(comparison), shellScopeRollback: { violations: [{ path: "test.js" }] } },
  ]) assert.equal(comparedAgainstTarget([turn]), false);
  assert.equal(comparedAgainstTarget([{ ...sh("requested command"),
    shellExecution: { command: comparison, exitCode: 0 } }]), true);
});

test("bounded to one bounce", () => {
  const turns = [sh("cat primers.fasta")];
  assert.ok(unsimulatedTargetObjection(turns, 0, { task: DNA }));
  assert.equal(unsimulatedTargetObjection(turns, 1, { task: DNA }), null);
});
