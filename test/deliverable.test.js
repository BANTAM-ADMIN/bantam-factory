import assert from "node:assert/strict";
import test from "node:test";

import {
  namedDeliverables,
  assessDeliverable,
  createDeliverableState,
  DELIVERABLE_STALL_DEFAULTS,
} from "../src/deliverable.js";

const GPT2_TASK = 'I have downloaded the gpt-2 weights stored as a TF .ckpt. Write me a '
  + 'dependency-free C file that samples from the model. Call your program /app/gpt2.c, I will '
  + 'compile with gcc -O3 -lm. It should read the .ckpt and the vocab.bpe file. I will run it '
  + '/app/a.out gpt2-124M.ckpt vocab.bpe "input".';

test("namedDeliverables extracts the code deliverable and excludes input data files", () => {
  const d = namedDeliverables(GPT2_TASK);
  assert.ok(d.includes("/app/gpt2.c"), "picks the .c deliverable");
  // input data files have no code extension → must NOT be flagged as deliverables
  assert.ok(!d.some((p) => p.includes(".ckpt")), "no .ckpt");
  assert.ok(!d.some((p) => p.includes(".bpe")), "no .bpe");
  // a.out is the compiled artifact, not a source file → excluded
  assert.ok(!d.includes("/app/a.out"), "no a.out");
});

test("namedDeliverables handles relative and multiple targets", () => {
  const d = namedDeliverables("Create solve.py and a helper util.js in ./src.");
  assert.ok(d.includes("solve.py"));
  assert.ok(d.includes("util.js"));
});

test("no deliverables named → never steers", () => {
  const s = createDeliverableState();
  assert.equal(assessDeliverable(200, [], () => false, s).steer, false);
});

test("does not steer before the action threshold", () => {
  const s = createDeliverableState();
  const r = assessDeliverable(DELIVERABLE_STALL_DEFAULTS.after - 1, ["/app/gpt2.c"], () => false, s);
  assert.equal(r.steer, false);
});

test("steers when the deliverable is still missing past the threshold", () => {
  const s = createDeliverableState();
  const r = assessDeliverable(DELIVERABLE_STALL_DEFAULTS.after, ["/app/gpt2.c"], () => false, s);
  assert.equal(r.steer, true);
  assert.equal(r.target, "/app/gpt2.c");
  assert.match(r.message, /\[deliverable\]/);
  assert.match(r.message, /WRITE \/app\/gpt2\.c/);
});

test("goes quiet the moment the deliverable exists", () => {
  const s = createDeliverableState();
  const exists = (p) => p === "/app/gpt2.c";
  assert.equal(assessDeliverable(300, ["/app/gpt2.c"], exists, s).steer, false);
});

test("re-nudges at most once per `after` turns while stalled, not every turn", () => {
  const s = createDeliverableState();
  const after = DELIVERABLE_STALL_DEFAULTS.after;
  assert.equal(assessDeliverable(after, ["/app/gpt2.c"], () => false, s).steer, true, "first fire");
  assert.equal(assessDeliverable(after + 1, ["/app/gpt2.c"], () => false, s).steer, false, "not next turn");
  assert.equal(assessDeliverable(after + 5, ["/app/gpt2.c"], () => false, s).steer, false, "not 5 turns later");
  assert.equal(assessDeliverable(after * 2, ["/app/gpt2.c"], () => false, s).steer, true, "re-fires after another `after`");
});

test("a thrown exists() is treated as 'missing', never a crash", () => {
  const s = createDeliverableState();
  const r = assessDeliverable(100, ["/app/gpt2.c"], () => { throw new Error("fs boom"); }, s);
  assert.equal(r.steer, true); // missing → steer, no crash
});
