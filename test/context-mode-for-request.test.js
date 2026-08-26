import assert from "node:assert/strict";
import test from "node:test";

import { contextModeForRequest } from "../src/logic/session-modes.js";

// Measured 2026-08-24, same request, same local slot: rebuild 71.5 s of prefill
// (cache_n pinned at the head checkpoint), extension 9-12 s. Extension's one
// cost — stale file bodies staying in context — needs edits to exist. So for a
// request that is not change-shaped, on a local slot, with the mode left at
// its DEFAULT, rebuild is unambiguously the wrong dial. Pick extension there.
// An operator's explicit or remembered choice is never overridden.

const DEFAULT = { mode: "rebuild", source: "default" };

test("a read-only request on a local slot at the default mode runs extension", () => {
  const pick = contextModeForRequest({ resolved: DEFAULT, changeShaped: false, localSlot: true });
  assert.equal(pick.mode, "extension");
  assert.equal(pick.applied, true);
  assert.match(pick.reason, /read-only request/);
});

test("a change-shaped request keeps the measured default", () => {
  const pick = contextModeForRequest({ resolved: DEFAULT, changeShaped: true, localSlot: true });
  assert.equal(pick.mode, "rebuild");
  assert.equal(pick.applied, false);
});

test("a remote provider keeps the default — there is no slot checkpoint to protect", () => {
  const pick = contextModeForRequest({ resolved: DEFAULT, changeShaped: false, localSlot: false });
  assert.equal(pick.mode, "rebuild");
  assert.equal(pick.applied, false);
});

test("an operator's explicit or remembered choice is never overridden", () => {
  for (const source of ["--context-mode rebuild", "BANTAM_PROMPT_TRAJECTORY", "BANTAM_IMMUTABLE_HISTORY", "remembered"]) {
    const pick = contextModeForRequest({ resolved: { mode: "rebuild", source }, changeShaped: false, localSlot: true });
    assert.equal(pick.mode, "rebuild", source);
    assert.equal(pick.applied, false, source);
  }
});
