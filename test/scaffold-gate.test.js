import assert from "node:assert/strict";
import test from "node:test";

import {
  isFullDeliverableRun,
  assessScaffold,
  createScaffoldState,
  SCAFFOLD_DEFAULTS,
} from "../src/scaffold-gate.js";

const DELIVS = ["/app/gpt2.c"];

test("isFullDeliverableRun: recognizes running the compiled binary", () => {
  assert.equal(isFullDeliverableRun('cd /app && ./a.out gpt2-124M.ckpt vocab.bpe "Hi"', DELIVS), true);
  assert.equal(isFullDeliverableRun("gcc -O3 -lm /app/gpt2.c -o /app/a.out", DELIVS), true);
});

test("isFullDeliverableRun: an inline python oracle is NOT a full run (it's the wheelbarrow)", () => {
  assert.equal(isFullDeliverableRun('python3 -c "import numpy; print(1)"', DELIVS), false);
  assert.equal(isFullDeliverableRun("python3 oracle.py", DELIVS), false, "a separate script is not the deliverable");
});

test("isFullDeliverableRun: running an interpreted deliverable counts", () => {
  assert.equal(isFullDeliverableRun("python3 solve.py < in.txt", ["solve.py"]), true);
});

test("stays quiet before the threshold", () => {
  const s = createScaffoldState();
  let last = { steer: false };
  for (let i = 0; i < SCAFFOLD_DEFAULTS.runsBeforeNudge - 1; i++) {
    last = assessScaffold({ a: "shell", c: "./a.out x y z" }, { deliverables: DELIVS }, s);
    assert.equal(last.steer, false);
  }
  assert.equal(s.deliverableRuns, SCAFFOLD_DEFAULTS.runsBeforeNudge - 1);
});

test("fires once the whole program has been run enough with no oracle", () => {
  const s = createScaffoldState();
  let r;
  for (let i = 0; i < SCAFFOLD_DEFAULTS.runsBeforeNudge; i++) {
    r = assessScaffold({ a: "shell", c: "./a.out a b c" }, { deliverables: DELIVS, oracleExists: () => false }, s);
  }
  assert.equal(r.steer, true);
  assert.match(r.message, /\[scaffold\]/);
  assert.match(r.message, /wheelbarrow/);
  assert.match(r.message, /oracle/i);
});

test("NEVER fires if a separate verifier/oracle already exists", () => {
  const s = createScaffoldState();
  let r;
  for (let i = 0; i < SCAFFOLD_DEFAULTS.runsBeforeNudge + 5; i++) {
    r = assessScaffold({ a: "shell", c: "gcc /app/gpt2.c -o /app/a.out && ./a.out w" }, { deliverables: DELIVS, oracleExists: () => true }, s);
  }
  assert.equal(r.steer, false, "wheelbarrow built → gate silent");
});

test("fires at most twice, then goes quiet", () => {
  const s = createScaffoldState();
  let fires = 0;
  for (let i = 0; i < 40; i++) {
    const r = assessScaffold({ a: "shell", c: "./a.out z" }, { deliverables: DELIVS, oracleExists: () => false }, s);
    if (r.steer) fires++;
  }
  assert.equal(fires, 2, "nudges twice, never nags forever");
});

test("no named deliverable → never fires", () => {
  const s = createScaffoldState();
  const r = assessScaffold({ a: "shell", c: "./a.out" }, { deliverables: [] }, s);
  assert.equal(r.steer, false);
});

test("non-shell actions and non-runs are ignored", () => {
  const s = createScaffoldState();
  assert.equal(assessScaffold({ a: "write_file", p: "/app/gpt2.c" }, { deliverables: DELIVS }, s).steer, false);
  assert.equal(assessScaffold({ a: "shell", c: "ls -la" }, { deliverables: DELIVS }, s).steer, false);
  assert.equal(s.deliverableRuns, 0, "neither counted as a deliverable run");
});
