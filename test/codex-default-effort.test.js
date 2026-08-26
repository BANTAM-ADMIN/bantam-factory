import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ModelClient } from "../src/model.js";

// Measured 2026-07-31, gpt-5.6-terra, both directions consistent across two
// fixtures. Every arm PASSED; the extra effort bought nothing.
//
//   adapter-migration      turns  input    output  reasoning
//     low                    9    222,750   3,659       443
//     medium                 8    186,376   3,321       438
//     high  (old default)    9    231,517   5,325     1,681
//     xhigh                  9    237,598   6,506     2,864
//
//   keyed-task-pool-strong turns  input    output  reasoning  wall
//     medium                 8    237,270   2,743       826    65s
//     high  (old default)    9    291,501   3,753     1,659    84s
//
// Reasoning tokens scale 6.5x from low to xhigh with flat quality. Against the
// old default, medium is -19% input, -27% output, -50% reasoning and -23% wall.
//
// This is a DEFAULT, not a ceiling: BANTAM_CODEX_EFFORT and --codex-effort still
// select any level, and the harder an under-specified task is the more likely a
// higher level earns itself. What the evidence rules out is paying for high on
// every run by default.

describe("default Codex reasoning effort", () => {
  it("defaults to medium rather than high", () => {
    const client = new ModelClient({ codex: true, model: "gpt-5.6-terra" });
    assert.equal(client.codexEffort, "medium");
  });

  it("still honours an explicit effort", () => {
    const client = new ModelClient({ codex: true, model: "gpt-5.6-terra", codexEffort: "xhigh" });
    assert.equal(client.codexEffort, "xhigh");
  });
});
