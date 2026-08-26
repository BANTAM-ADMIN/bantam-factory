// Operator report (2026-08-25): a user watching the interactive feed saw the
// steers and thought the run was failing. Signage is for the worker; the
// showroom shows the work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubStationNotes } from "../src/logic/station-notes.js";

test("a steer appended to real output is stripped; the output survives", () => {
  const obs = "exit 0\n3 passed\n\n[verify-cadence] 6 edits have landed since you last ran ANY verification. Run the test suite NOW.";
  assert.equal(scrubStationNotes(obs, { show: false }), "exit 0\n3 passed");
});

test("a pure steer observation becomes empty (nothing to show)", () => {
  const obs = "[regenerate-from-formula] 4 patches have landed on src/f.js…";
  assert.equal(scrubStationNotes(obs, { show: false }), "");
});

test("multiple stacked notes all go; multiple kinds", () => {
  const obs = "replaced 1 occurrence in a.js\n\n[fix-tests] evidence pinned for \"t\" (red x2)\n\n[contract-arbitration] name the owner.";
  assert.equal(scrubStationNotes(obs, { show: false }), "replaced 1 occurrence in a.js");
});

test("[timeout] and [interrupted] are user-facing and survive", () => {
  const obs = "partial output\n\n[timeout] command exceeded 30s and was stopped";
  assert.equal(scrubStationNotes(obs, { show: false }), obs);
  const obs2 = "[interrupted] stopped by the user";
  assert.equal(scrubStationNotes(obs2, { show: false }), obs2);
});

test("BANTAM_SHOW_STATIONS=1 (show flag) restores the full shop-floor view", () => {
  const obs = "exit 0\n\n[verify-cadence] run the suite";
  assert.equal(scrubStationNotes(obs, { show: true }), obs);
});

test("ordinary bracketed content inside a line is untouched", () => {
  const obs = "array indexing: a[0] returned [1, 2, 3]";
  assert.equal(scrubStationNotes(obs, { show: false }), obs);
});
