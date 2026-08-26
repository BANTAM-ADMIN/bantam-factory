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
const sh = (c) => ({ action: { a: "shell", c }, observation: "" });

test("recognises a stated end state", () => {
  assert.equal(taskStatesTarget(DNA), true, "desired output plasmid + converted into");
  assert.equal(taskStatesTarget(COMP), true, "gives exactly data.txt");
  assert.equal(taskStatesTarget("Produce a report that is identical to reference.md"), true);
});

test("an output file with no stated contents is NOT a target", () => {
  for (const t of [
    "Write the best move for white to /app/move.txt",
    "Install nginx and write the config to /etc/nginx/nginx.conf",
    "Summarise the log and save it to summary.txt",
  ]) assert.equal(taskStatesTarget(t), false, t);
});

test("objects when only the RULES were checked", () => {
  const turns = [sh("python3 -c \"print(tm(fwd), len(anneal))\""), sh("cat primers.fasta")];
  assert.equal(comparedAgainstTarget(turns), false);
  const msg = unsimulatedTargetObjection(turns, 0, { task: DNA });
  assert.ok(msg);
  assert.match(msg, /The target is the gauge/);
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

test("bounded to one bounce", () => {
  const turns = [sh("cat primers.fasta")];
  assert.ok(unsimulatedTargetObjection(turns, 0, { task: DNA }));
  assert.equal(unsimulatedTargetObjection(turns, 1, { task: DNA }), null);
});
