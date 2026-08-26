import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundedSelectionDomain,
  readJiggedSelection,
  recoverSelection,
  selectionPrefill,
} from "../src/factory/stations/bounded-selection.js";

const DOMAIN = boundedSelectionDomain({
  id: "t", answerKey: "statusId", instruction: "i",
  catalog: [{ id: "status-200", description: "ok" }, { id: "status-404", description: "gone" }],
  items: [{ id: "a", expected: "status-200", body: "b" }],
});

// The jig is the fixture that makes the wrong output impossible, as opposed to
// the repair that cleans it up afterwards. These pin the difference, because a
// jig that quietly falls back to repair would be a repair with better marketing.
describe("poka-yoke selection jig", () => {
  it("opens the answer so the worker cannot emit an envelope", () => {
    // The worker's first token lands inside a JSON string. There is no position
    // at which it could write a fence.
    assert.equal(selectionPrefill(DOMAIN), '{"statusId":"');
  });

  it("reads a jigged emission without repairing anything", () => {
    const read = readJiggedSelection(DOMAIN, 'status-404"}');
    assert.deepEqual(read.parsed, { statusId: "status-404" });
    assert.equal(read.repaired, false);
    assert.equal(read.jigged, true);
  });

  it("tolerates a worker that stops after the id", () => {
    assert.deepEqual(readJiggedSelection(DOMAIN, 'status-200"').parsed, { statusId: "status-200" });
  });

  it("fails closed when the worker writes something with no closing quote", () => {
    // A jig removes one failure mode; it does not make the gauge unnecessary,
    // and it must not invent an answer when the emission is unusable.
    assert.equal(readJiggedSelection(DOMAIN, "I think it is fine").parsed, null);
    assert.equal(readJiggedSelection(DOMAIN, "").parsed, null);
  });

  it("does not silently accept a fenced emission, which is the defect it prevents", () => {
    // If a fence ever arrives on the jig path, the setup is wrong and the
    // reader must not paper over it — that is what the repair path is for.
    const read = readJiggedSelection(DOMAIN, '```json\n{"statusId":"status-200"}\n```');
    assert.notDeepEqual(read.parsed, { statusId: "status-200" });
  });

  it("still recovers a fenced emission on the unjigged path", () => {
    const read = recoverSelection('```json\n{"statusId":"status-200"}\n```');
    assert.deepEqual(read.parsed, { statusId: "status-200" });
    assert.equal(read.repaired, true);
  });
});
