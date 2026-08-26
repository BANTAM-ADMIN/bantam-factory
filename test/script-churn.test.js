import assert from "node:assert/strict";
import test from "node:test";
import { throwawayFamily, assessScriptChurn, createChurnState, CHURN_DEFAULTS } from "../src/script-churn.js";

test("throwawayFamily parses numbered throwaway scripts, ignores real files", () => {
  assert.equal(throwawayFamily("dbg1.py"), "dbg");
  assert.equal(throwawayFamily("/app/debug_3.js"), "debug");
  assert.equal(throwawayFamily("try2.c"), "try");
  assert.equal(throwawayFamily("attempt-4.py"), "attempt");
  assert.equal(throwawayFamily("test12.py"), "test");
  assert.equal(throwawayFamily("solve.py"), null);
  assert.equal(throwawayFamily("/app/gpt2.c"), null);
});

test("fires once a family passes the threshold, naming family + count", () => {
  const s = createChurnState();
  let r;
  for (let i = 1; i <= CHURN_DEFAULTS.familyThreshold; i++) {
    r = assessScriptChurn({ a: "write_file", p: `dbg${i}.py` }, s);
  }
  assert.equal(r.steer, true);
  assert.equal(r.family, "dbg");
  assert.equal(r.count, CHURN_DEFAULTS.familyThreshold);
  assert.match(r.message, /\[churn\]/);
  assert.match(r.message, /ONE script that runs the whole loop/);
});

test("stays quiet below threshold", () => {
  const s = createChurnState();
  for (let i = 1; i < CHURN_DEFAULTS.familyThreshold; i++) {
    assert.equal(assessScriptChurn({ a: "write_file", p: `dbg${i}.py` }, s).steer, false);
  }
});

test("re-writing the SAME numbered path does not inflate the count", () => {
  const s = createChurnState();
  for (let i = 0; i < 20; i++) assessScriptChurn({ a: "write_file", p: "dbg1.py" }, s);
  assert.equal(s.families.get("dbg").size, 1);
});

test("non-throwaway writes are ignored", () => {
  const s = createChurnState();
  assert.equal(assessScriptChurn({ a: "write_file", p: "/app/program.py" }, s).steer, false);
  assert.equal(assessScriptChurn({ a: "shell", c: "ls" }, s).steer, false);
});

test("fires at most twice", () => {
  const s = createChurnState();
  let fires = 0;
  for (let i = 1; i <= 40; i++) if (assessScriptChurn({ a: "write_file", p: `dbg${i}.py` }, s).steer) fires++;
  assert.equal(fires, 2);
});

test("catches throwaway scripts created via SHELL redirect/heredoc/tee, not just write_file", () => {
  const s = createChurnState();
  let r;
  for (let i = 1; i <= CHURN_DEFAULTS.familyThreshold; i++) {
    r = assessScriptChurn({ a: "shell", c: `cat > /tmp/probe${i}.py <<'EOF'\nprint(1)\nEOF` }, s);
  }
  assert.equal(r.steer, true, "shell-created probe scripts count");
  assert.equal(r.family, "probe");
});

test("mixed write_file + shell of the same family accumulate together", () => {
  const s = createChurnState();
  assessScriptChurn({ a: "write_file", p: "dbg1.py" }, s);
  assessScriptChurn({ a: "shell", c: "python - > dbg2.py" }, s);
  assessScriptChurn({ a: "shell", c: "tee dbg3.py" }, s);
  assessScriptChurn({ a: "write_file", p: "dbg4.py" }, s);
  const r = assessScriptChurn({ a: "shell", c: "cat foo > dbg5.py" }, s);
  assert.equal(r.steer, true);
  assert.equal(r.count, 5);
});

test("generalized: catches render1.py … render5.py churn (family not on any keyword list)", () => {
  const s = createChurnState();
  let r;
  for (let i = 1; i <= CHURN_DEFAULTS.familyThreshold; i++) {
    r = assessScriptChurn({ a: "write_file", p: `render${i}.py` }, s);
  }
  assert.equal(r.steer, true, "render-churn must fire");
  assert.equal(r.family, "render");
});

test("generalized: also catches churn run via shell (python3 render7.py …)", () => {
  const s = createChurnState();
  let r;
  for (let i = 1; i <= CHURN_DEFAULTS.familyThreshold; i++) {
    r = assessScriptChurn({ a: "shell", c: `python3 render${i}.py` }, s);
  }
  assert.equal(r.steer, true);
  assert.equal(r.family, "render");
});

test("generalized: numbered DATA/output files are NOT counted (only scripts churn)", () => {
  const s = createChurnState();
  for (let i = 1; i <= 8; i++) {
    assessScriptChurn({ a: "write_file", p: `render${i}.bmp` }, s);
    assessScriptChurn({ a: "shell", c: `sqlite3 out${i}.csv` }, s);
  }
  // no script family accumulated
  let anyFire = false;
  for (const [, set] of s.families) if (set.size >= CHURN_DEFAULTS.familyThreshold) anyFire = true;
  assert.equal(anyFire, false, "data/output files must not trip the churn gate");
});

test("generalized: a lone semantically-numbered deliverable does not fire", () => {
  const s = createChurnState();
  // writing gpt2.c many times is one distinct file → never reaches threshold
  for (let i = 0; i < 10; i++) assessScriptChurn({ a: "write_file", p: "gpt2.c" }, s);
  const fam = s.families.get("gpt");
  assert.ok(!fam || fam.size < CHURN_DEFAULTS.familyThreshold, "single deliverable must not fire");
})


// build-pov-ray (2026-08-21). The run wrote dl.sh, dl2.sh … dl8.sh hunting a
// download URL. run.json recorded TWO script_churn events — both at the same
// count — because the model writes a script and then runs it, and both actions
// name it. maxFires is 2, so one crossing spent the whole budget and the gate
// had nothing left to say when the run kept going to dl8.
test("one threshold crossing fires ONCE, even though write+run both name the script", () => {
  const s = createChurnState();
  let fires = 0;
  for (const n of ["dl", "dl2", "dl3", "dl4", "dl5", "dl6", "dl7", "dl8"]) {
    if (assessScriptChurn({ a: "write_file", p: `${n}.sh`, content: "x" }, s).steer) fires++;
    if (assessScriptChurn({ a: "shell", c: `bash ${n}.sh 2>&1` }, s).steer) fires++;
  }
  assert.equal(fires, 1, "write-then-run must not spend two fires on a single crossing");
});

// The same run showed the other half: the fire point used to be `size % stride
// === 0`, an EQUALITY. One action can name two new scripts at once, so the count
// steps 4 → 6 and never equals 5. The gate then waits for 10 and a run that
// jumps in pairs sails past every fire point forever.
test("a count that JUMPS past the threshold still fires (crossing, not equality)", () => {
  const s = createChurnState();
  let fires = 0;
  for (const pair of [["dl2", "dl3"], ["dl4", "dl5"], ["dl6", "dl7"]]) {
    if (assessScriptChurn({ a: "shell", c: `bash ${pair[0]}.sh; bash ${pair[1]}.sh` }, s).steer) fires++;
  }
  assert.equal(s.families.get("dl").size, 6, "six distinct scripts accumulated");
  assert.equal(fires, 1, "skipping over the exact threshold must not skip the gate");
});


// gcode-to-text (2026-08-21) wrote render_v1 … render_v11 and text_v1 … text_v7,
// and the gate counted NONE of them. The stem class was `[a-zA-Z][a-zA-Z]{0,30}?[_-]?`
// — a separator allowed only at the END — so it cannot span "render_v", and
// starting the match at "v" is impossible because `_` is a word character and
// there is no \b before it. Every separator-bearing throwaway name was invisible.
test("a stem with an INTERIOR separator is still a throwaway family", () => {
  const s = createChurnState();
  let fires = 0;
  for (let i = 1; i <= 11; i++) {
    if (assessScriptChurn({ a: "write_file", p: `render_v${i}.py`, content: "x" }, s).steer) fires++;
  }
  assert.equal(s.families.get("render_v")?.size, 11, "render_v1..v11 are one family of eleven");
  assert.equal(fires, 2, "fires on each threshold crossing, not once and not never");

  const s2 = createChurnState();
  for (let i = 1; i <= 5; i++) assessScriptChurn({ a: "write_file", p: `parse_out${i}.py` }, s2);
  assert.equal(s2.families.get("parse_out")?.size, 5);

  // and the number still never leaks into the stem
  const s3 = createChurnState();
  assessScriptChurn({ a: "write_file", p: "gpt2.c" }, s3);
  assert.ok((s3.families.get("gpt")?.size ?? 0) < CHURN_DEFAULTS.familyThreshold);
});

// The generic steer says "write one script that runs the whole loop". When each
// iteration ends with the model LOOKING at an image, no script can make that
// decision — gcode-to-text ran render_vN then `view_image text_vN.png`, eleven
// times, and the advice was unachievable. The achievable version is to batch the
// look: compose the variants into one labelled grid and view it once.
test("a loop whose decision is perception gets batch-the-look, not script-the-loop", () => {
  const s = createChurnState();
  let msg = null;
  for (let i = 1; i <= 6; i++) {
    assessScriptChurn({ a: "query", q: `view_image text_v${i}.png` }, s);
    const r = assessScriptChurn({ a: "write_file", p: `render_v${i}.py`, content: "x" }, s);
    if (r.steer) msg = r.message;
  }
  assert.ok(msg, "the gate must still fire");
  assert.match(msg, /\[churn\/visual\]/);
  assert.match(msg, /BATCH THE LOOK/);

  const plain = createChurnState();
  let plainMsg = null;
  for (let i = 1; i <= 6; i++) {
    const r = assessScriptChurn({ a: "write_file", p: `dbg${i}.py`, content: "x" }, plain);
    if (r.steer) plainMsg = r.message;
  }
  assert.ok(plainMsg);
  assert.doesNotMatch(plainMsg, /\[churn\/visual\]/, "a non-visual loop keeps the plain advice");
});


// A view_image ACTION is not the only evidence a loop is visual, and on a
// RESUMED run it is not available at all: churn state is rebuilt fresh, so the
// first crossing can fire before this session has seen one. Measured on
// gcode-to-text's resume (2026-08-21) — script_churn fired, `churn/visual`
// appeared ZERO times in the observations, and the run went on to render_v29.
// The scripts themselves say what kind of loop it is.
test("a visual loop is recognised from the scripts, not just from a view_image action", () => {
  const s = createChurnState();
  let msg = null;
  for (let i = 1; i <= 6; i++) {
    const r = assessScriptChurn({
      a: "write_file",
      p: `render_v${i}.py`,
      content: 'from PIL import Image, ImageDraw\nimg = Image.new("L", (9, 9))\nimg.save("out.png")',
    }, s);
    if (r.steer) msg = r.message;
  }
  assert.ok(msg, "the gate must fire");
  assert.match(msg, /\[churn\/visual\]/, "no view_image action was ever seen, and it still knows");

  const compute = createChurnState();
  let computeMsg = null;
  for (let i = 1; i <= 6; i++) {
    const r = assessScriptChurn({ a: "write_file", p: `dbg${i}.py`, content: "print(sum(range(10)))" }, compute);
    if (r.steer) computeMsg = r.message;
  }
  assert.ok(computeMsg);
  assert.doesNotMatch(computeMsg, /\[churn\/visual\]/, "a compute loop keeps the plain advice");
});
