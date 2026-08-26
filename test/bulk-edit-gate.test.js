import assert from "node:assert/strict";
import test from "node:test";

import { assessBulkEdit, BULK_EDIT_DEFAULTS, createBulkEditState } from "../src/bulk-edit-gate.js";

// TB2 overfull-hbox (2026-08-21): 102 separate `replace` edits to input.tex,
// one word at a time, finishing with a substitution the grader rejected. No
// point edit can check a whole-file invariant, so one bad swap in a hundred
// sinks the task and the run cannot tell which one.

const rep = (p) => ({ a: "replace", p, old: "x", new: "y" });

test("stays quiet through ordinary editing", () => {
  const s = createBulkEditState();
  let last = { steer: false };
  for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge - 1; i++) {
    last = assessBulkEdit(rep("input.tex"), {}, s);
    assert.equal(last.steer, false, `fired early at edit ${i + 1}`);
  }
});

test("fires once one file has absorbed a loop's worth of point edits", () => {
  const s = createBulkEditState();
  let fired = null;
  for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
    const r = assessBulkEdit(rep("input.tex"), {}, s);
    if (r.steer) fired = r;
  }
  assert.ok(fired, "expected a steer");
  assert.equal(fired.path, "input.tex");
  assert.match(fired.message, /Write the script instead/);
  assert.match(fired.message, /RE-CHECK the invariant/);
});

test("edits SPREAD across files are not a hand-run loop", () => {
  const s = createBulkEditState();
  for (let i = 0; i < 30; i++) {
    const r = assessBulkEdit(rep(`src/file${i}.js`), {}, s);
    assert.equal(r.steer, false, "a broad refactor is not this antipattern");
  }
});

test("a run that already scripted its edits is never nudged", () => {
  const s = createBulkEditState();
  for (let i = 0; i < 40; i++) {
    const r = assessBulkEdit(rep("input.tex"), { scriptedEdit: () => true }, s);
    assert.equal(r.steer, false);
  }
});

test("bounded: it does not nag forever", () => {
  const s = createBulkEditState();
  let fires = 0;
  for (let i = 0; i < 300; i++) if (assessBulkEdit(rep("input.tex"), {}, s).steer) fires++;
  assert.ok(fires <= BULK_EDIT_DEFAULTS.maxFires, `fired ${fires} times`);
});

test("non-edit verbs are ignored", () => {
  const s = createBulkEditState();
  for (let i = 0; i < 40; i++) {
    assert.equal(assessBulkEdit({ a: "shell", c: "ls" }, {}, s).steer, false);
    assert.equal(assessBulkEdit({ a: "read_file", p: "input.tex" }, {}, s).steer, false);
  }
});

// winning-avg-corewars (2026-08-21): 42 write_file rewrites of my_warrior.red
// interleaved with 91 pmars battles, zero scripted loops, 99 turns — and this
// gate stayed silent, because write_file was not in EDIT_VERBS. A full rewrite of
// the SAME path is the same hand-run loop as a patch to it.
const wf = (p) => ({ a: "write_file", p, content: "dat 0,0" });
const sh = (c) => ({ a: "shell", c });

test("repeated write_file rewrites of ONE path are counted", () => {
  const s = createBulkEditState();
  let fired = null;
  for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
    const r = assessBulkEdit(wf("my_warrior.red"), {}, s);
    if (r.steer) fired = r;
  }
  assert.ok(fired, "42 rewrites went unnoticed before this");
  assert.equal(fired.path, "my_warrior.red");
});

test("an edit -> measure -> edit cycle is named as a hand-run SEARCH", () => {
  const s = createBulkEditState();
  let fired = null;
  for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
    assessBulkEdit(sh("pmars -b -r 100 my_warrior.red warriors/stone.red"), {}, s);
    const r = assessBulkEdit(wf("my_warrior.red"), {}, s);
    if (r.steer) fired = r;
  }
  assert.ok(fired);
  assert.match(fired.message, /running a SEARCH by hand/);
  assert.match(fired.message, /keep the best/);
});

test("edits with NO measurement between them get the plain message only", () => {
  const s = createBulkEditState();
  let fired = null;
  for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
    const r = assessBulkEdit(wf("notes.md"), {}, s);
    if (r.steer) fired = r;
  }
  assert.ok(fired);
  assert.doesNotMatch(fired.message, /running a SEARCH by hand/);
});

test("writing MANY DIFFERENT files is normal authoring", () => {
  const s = createBulkEditState();
  for (let i = 0; i < 30; i++) {
    assert.equal(assessBulkEdit(wf(`src/mod${i}.py`), {}, s).steer, false);
  }
});

// The gauge that stops this drifting again: the gate's verb set must be DERIVED
// from the protocol's canonical EDIT_ACTIONS, not restated. It was restated once
// and omitted write_file, so 42 rewrites of one file went uncounted for 99 turns.
// diagnose.js carries the same scar about edit_lines.
test("GAUGE: the verb set tracks the protocol's canonical EDIT_ACTIONS", async () => {
  const { EDIT_ACTIONS } = await import("../src/edit-actions.js");
  const expected = [...EDIT_ACTIONS].filter((v) => v !== "delete_file" && v !== "move_file");
  // Each verb must be built in ITS OWN protocol shape — write_batch carries
  // files[], patch carries edits[] — or the test proves nothing about the gate.
  const shapeFor = (verb) => (
    verb === "write_batch" ? { a: verb, files: [{ p: "f.txt", content: "x" }] }
      : verb === "patch" ? { a: verb, edits: [{ p: "f.txt", old: "a", new: "b" }] }
        : { a: verb, p: "f.txt", content: "x", old: "a", new: "b" }
  );
  for (const verb of expected) {
    const s = createBulkEditState();
    let fired = false;
    for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
      if (assessBulkEdit(shapeFor(verb), {}, s).steer) fired = true;
    }
    assert.ok(fired, `${verb} is a content edit in the protocol but this gate does not count it`);
  }
});

test("batch shapes are read through editPaths, not action.p", () => {
  for (const [label, action] of [
    ["write_batch", { a: "write_batch", files: [{ p: "my_warrior.red", content: "x" }] }],
    ["patch", { a: "patch", edits: [{ p: "input.tex", old: "a", new: "b" }] }],
  ]) {
    const s = createBulkEditState();
    let fired = null;
    for (let i = 0; i < BULK_EDIT_DEFAULTS.editsBeforeNudge; i++) {
      const r = assessBulkEdit(action, {}, s);
      if (r.steer) fired = r;
    }
    assert.ok(fired, `${label} carries its path in a sub-array and was missed`);
  }
});
