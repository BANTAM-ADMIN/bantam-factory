// report_shape done-gate: the done summary is the only thing most users read, and
// small models spend it on a trailing promise ("I'll also update the docs") or a
// hedged success ("should work now"). Both are named precisely and bounced exactly
// once; the gate is bounded and can never trap a run.

import assert from "node:assert/strict";
import test from "node:test";

import { reportShapeObjection } from "../src/report-guard.js";

test("report_shape fires on a summary that promises future work", () => {
  const obj = reportShapeObjection(
    "All 9 tests pass. I'll also update the docs next.",
    0,
  );
  assert.equal(typeof obj, "string");
  assert.ok(obj.length > 0, "expected a non-null objection message");
  assert.match(obj, /promise of future work/);
});

test("report_shape fires on a summary that hedges success", () => {
  const obj = reportShapeObjection("The fix should work now.", 0);
  assert.equal(typeof obj, "string");
  assert.ok(obj.length > 0, "expected a non-null objection message");
  assert.match(obj, /unverified-success hedge/);
});

test("report_shape stays silent on a summary that leads with an observed outcome", () => {
  assert.equal(
    reportShapeObjection("All 9 tests pass; the failing case now asserts the exit code is 0.", 0),
    null,
  );
});

test("report_shape stays silent on an empty summary", () => {
  assert.equal(reportShapeObjection("", 0), null);
  assert.equal(reportShapeObjection(undefined, 0), null);
});

test("report_shape stays silent once the rejection bound is reached", () => {
  assert.equal(reportShapeObjection("I'll also update the docs.", 1), null);
  assert.equal(reportShapeObjection("I'll also update the docs.", 0, { maxRejections: 0 }), null);
});
