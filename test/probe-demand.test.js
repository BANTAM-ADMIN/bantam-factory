import assert from "node:assert/strict";
import test from "node:test";

import { isQualifyingProbe, probeDemandObjection } from "../src/logic/probe-demand.js";

const VLQ_TASK = "Encode a series of numbers, treating each as a maximum 32-bit unsigned integer. Incomplete sequences must throw an error.";
const shellTurn = (c) => ({ action: { a: "shell", c } });

test("bounces a done with named bounds, green audit, and no inline probe", () => {
  const msg = probeDemandObjection(VLQ_TASK, [shellTurn("npm test")], 0,
    { enabled: true, auditEmitted: true });
  assert.ok(msg, "must object");
  assert.match(msg, /32-bit/);
  assert.match(msg, /inline probe/);
  assert.match(msg, /Do not rerun the unchanged suite/);
});

test("a prior inline probe satisfies the gate; suite reruns do not", () => {
  assert.equal(probeDemandObjection(VLQ_TASK, [shellTurn('node -e "check(0xFFFFFFFF)"')], 0,
    { enabled: true, auditEmitted: true }), null);
  assert.equal(probeDemandObjection(VLQ_TASK, [shellTurn("node --input-type=module -e 'x'")], 0,
    { enabled: true, auditEmitted: true }), null);
  assert.ok(probeDemandObjection(VLQ_TASK, [shellTurn("npm test"), shellTurn("node --test")], 0,
    { enabled: true, auditEmitted: true }), "bare suite rerun is not a probe");
});

test("bounded to one rejection; off without flag, audit, or named requirements", () => {
  const on = { enabled: true, auditEmitted: true };
  assert.equal(probeDemandObjection(VLQ_TASK, [], 1, on), null, "second done passes");
  assert.equal(probeDemandObjection(VLQ_TASK, [], 0, { enabled: false, auditEmitted: true }), null);
  assert.equal(probeDemandObjection(VLQ_TASK, [], 0, { enabled: true, auditEmitted: false }), null);
  assert.equal(probeDemandObjection("Tidy the styles.", [], 0, on), null, "no named requirements");
});

test("isQualifyingProbe recognizes focused node --test but not bare", () => {
  assert.equal(isQualifyingProbe("node --test test/focus.test.js"), true);
  assert.equal(isQualifyingProbe("node --test"), false);
  assert.equal(isQualifyingProbe("npm test"), false);
});
