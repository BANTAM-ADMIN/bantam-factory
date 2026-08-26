import assert from "node:assert/strict";
import test from "node:test";
import { RepetitionGuard } from "../src/repetition.js";

// break-filter-js (2026-08-20): `python xtest.py` rerun 47x, 45 with the
// byte-identical all-fail result, only candidate LABELS changing between runs,
// each preceded by a write (which clears exact-dedup). The run exits 0, so the
// failure track never engaged. This track catches the flat-result loop.

const run = { a: "shell", c: "cd /app && python xtest.py" };
const obs = (label) => `$ cd /app && python xtest.py\ncwd: /app\nexit 0\n${label}1_img_srcdoc: detected=False text=None\n   filtered: <img srcdoc="&lt;svg&gt;">`;

test("fires after NOPROGRESS_RERUNS identical-result runs, across intervening edits", () => {
  const g = new RepetitionGuard();
  const labels = "PQRSTUVW".split("");
  let steer = null;
  for (let i = 0; i < labels.length; i++) {
    steer = g.check(run);                 // before executing
    g.record(run, obs(labels[i]), { turn: i });  // result varies only by label
    g.noteWorkspaceChanged();             // the write between runs
  }
  assert.ok(steer && /\[no-progress\]/.test(steer.observation), `should steer; got ${steer && steer.observation}`);
  assert.ok(g.noProgressSteers >= 1);
});

test("does NOT fire when the result actually changes each run (real progress)", () => {
  const g = new RepetitionGuard();
  for (let i = 0; i < 8; i++) {
    g.check(run);
    g.record(run, `$ ${run.c}\nexit 0\n${i} candidates passed`, { turn: i }); // bare count changes
    g.noteWorkspaceChanged();
  }
  assert.equal(g.noProgressSteers, 0, "changing results must reset the streak");
});

test("does NOT fire for a couple of repeats (below threshold)", () => {
  const g = new RepetitionGuard();
  let steer = null;
  for (let i = 0; i < 3; i++) { steer = g.check(run); g.record(run, obs("X"), { turn: i }); }
  assert.equal(steer, null);
});
