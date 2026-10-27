import assert from "node:assert/strict";
import test from "node:test";

import { contextModeForRequest, resolveContextMode } from "../src/logic/session-modes.js";

test("the extension default stays active for every request and provider", () => {
  for (const changeShaped of [false, true]) {
    for (const localSlot of [false, true]) {
      const pick = contextModeForRequest({ resolved: resolveContextMode(), changeShaped, localSlot });
      assert.equal(pick.mode, "extension");
      assert.equal(pick.applied, false, "the default needs no per-request override");
      assert.equal(pick.reason, "default");
    }
  }
});

test("an operator's explicit or remembered choice is never overridden", () => {
  for (const source of ["--context-mode rebuild", "BANTAM_PROMPT_TRAJECTORY", "BANTAM_IMMUTABLE_HISTORY", "remembered"]) {
    const pick = contextModeForRequest({ resolved: { mode: "rebuild", source }, changeShaped: false, localSlot: true });
    assert.equal(pick.mode, "rebuild", source);
    assert.equal(pick.applied, false, source);
  }
});
