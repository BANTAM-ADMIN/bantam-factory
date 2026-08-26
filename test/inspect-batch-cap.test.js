import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { INSPECT_MAX_OPS, actionPromptMenu } from "../src/action-protocol.js";

// `inspect` batches read-only ops into one turn. The cap was a hard 6, and on a
// 12-module migration the model hit it twice -- reading 3, then 6, then 6 -- so
// three turns went to reads that fit in one.
//
// Measured cost of the cap on that run: mean 273 characters per read op, so
// twelve ops is about 3,300 characters of observation. It was spending two full
// round trips, and their token cost, to avoid under 2KB of text -- and rendered
// observations are clipped anyway, so the size risk was already bounded.
//
// The cap and the help text must move together: a grammar that permits twelve ops
// while the prompt advertises "1-6" leaves the extra capacity unused, which is
// worse than not having it.

describe("the inspect batch cap", () => {
  it("is a single source of truth", () => {
    assert.ok(Number.isInteger(INSPECT_MAX_OPS) && INSPECT_MAX_OPS >= 1);
  });

  it("advertises exactly the cap the grammar enforces", () => {
    const menu = actionPromptMenu({ features: [] });
    assert.match(menu, new RegExp(`1-${INSPECT_MAX_OPS} read-only ops`),
      `the prompt must advertise the real cap of ${INSPECT_MAX_OPS}`);
  });

  // Raising the cap to 12 was measured and REVERTED: it saved a turn (9 -> 8) and
  // cost 61% more cache misses, because one wide batch makes one large observation
  // and sticky slimming later rewrites that whole block at once. Fewer, smaller
  // observations churn less. The test pins the measured default rather than the
  // intuition that wider batching must be better.
  it("keeps the measured default rather than the intuitive one", () => {
    assert.equal(INSPECT_MAX_OPS, 6);
  });
});
