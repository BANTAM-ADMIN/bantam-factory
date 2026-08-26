import test from "node:test";
import assert from "node:assert/strict";

import { deliverableNotice } from "../src/logic/deliverable-watch.js";

test("silent while the deliverable exists", () => {
  assert.equal(deliverableNotice({ missing: [], turnsUsed: 40 }), null);
});

test("silent before the run has had time to produce anything", () => {
  assert.equal(deliverableNotice({ missing: ["data.comp"], turnsUsed: 3 }), null);
});

test("speaks once the run has had time and the file is still absent", () => {
  const n = deliverableNotice({ missing: ["data.comp"], turnsUsed: 8 });
  assert.ok(n);
  assert.match(n.text, /data\.comp does not exist yet/);
  // the specific failure this exists for: grading a simulation instead of the file
  assert.match(n.text, /simulated result scores zero/);
  assert.match(n.text, /RUN that program on the real file/);
});

test("spaces out repeats and stops after a few — a per-turn reminder is noise", () => {
  assert.ok(deliverableNotice({ missing: ["a.out"], turnsUsed: 8, noticesSoFar: 0 }));
  assert.equal(deliverableNotice({ missing: ["a.out"], turnsUsed: 9, noticesSoFar: 1 }), null);
  assert.ok(deliverableNotice({ missing: ["a.out"], turnsUsed: 20, noticesSoFar: 1 }));
  assert.equal(deliverableNotice({ missing: ["a.out"], turnsUsed: 99, noticesSoFar: 3 }), null);
});

test("pluralises so the message reads correctly for several files", () => {
  const n = deliverableNotice({ missing: ["x.csv", "y.csv"], turnsUsed: 8 });
  assert.match(n.text, /x\.csv, y\.csv do not exist yet/);
  assert.deepEqual(n.paths, ["x.csv", "y.csv"]);
});
