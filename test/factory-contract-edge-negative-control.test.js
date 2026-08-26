import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateContractEdgeResponse } from "../src/factory.js";

// The negative control for the contract-edge gauge.
//
// PROOF-PROGRAM.md lists "the instrument cannot distinguish real passing and
// failing artifacts" among its stop conditions, and C3 cites this gauge when it
// claims a bounded work order is more reliable. A gauge that has only ever been
// shown accepting good products is not evidence for anything: the yield it
// reports would look identical if it accepted everything.
//
// So this file exists to make the gauge fail. Each case is a product a careless
// worker could plausibly emit, and every one must be rejected with the specific
// reason — a gauge that rejects everything for one generic reason is barely
// better than one that accepts everything, because it cannot route rework.
//
// Written by PROBE against a gauge PROBE did not build. That separation is the
// point: the ledger can check that a control ran and passed, but it cannot tell
// a strong control from a weak one, so the only protection is that the author of
// the instrument is not the author of its control.

const CATALOG = [
  { id: "empty-input", description: "the input collection is empty" },
  { id: "missing-key", description: "a looked-up key is absent" },
  { id: "case-insensitive", description: "keys differ only by case" },
];

const conforming = (edges) => JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges });

describe("contract-edge gauge negative control", () => {
  it("accepts a conforming selection, so the rejections below mean something", () => {
    const result = validateContractEdgeResponse(conforming(["empty-input", "missing-key"]), CATALOG);
    assert.equal(result.pass, true);
    assert.equal(result.code, "conforming");
    assert.deepEqual(result.selection.edges, ["empty-input", "missing-key"]);
  });

  it("rejects an id that is not in the issued catalog", () => {
    // The failure that matters most: a plausible, well-formed, invented answer.
    const result = validateContractEdgeResponse(conforming(["empty-input", "off-by-one"]), CATALOG);
    assert.equal(result.pass, false);
    assert.equal(result.code, "unknown-edge");
    assert.equal(result.selection, null);
  });

  it("rejects output that is not JSON at all", () => {
    for (const raw of ["", "   ", "I think it is empty-input.", "```json\n{}\n```"]) {
      const result = validateContractEdgeResponse(raw, CATALOG);
      assert.equal(result.pass, false, raw);
      assert.ok(["invalid-json", "invalid-object", "schema-expansion"].includes(result.code), `${raw} -> ${result.code}`);
    }
  });

  it("rejects a widened envelope rather than ignoring the extra keys", () => {
    // A worker that adds a confidence score or a rationale has changed the
    // contract. Silently dropping the extra field would let the die drift.
    const widened = JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: ["empty-input"], confidence: 0.9 });
    const result = validateContractEdgeResponse(widened, CATALOG);
    assert.equal(result.pass, false);
    assert.equal(result.code, "schema-expansion");
  });

  it("rejects a wrong schema or kind even when the edges are valid", () => {
    const wrongSchema = JSON.stringify({ schema: 2, kind: "bantam.contract-edge-selection", edges: ["empty-input"] });
    assert.equal(validateContractEdgeResponse(wrongSchema, CATALOG).code, "invalid-envelope");
    const wrongKind = JSON.stringify({ schema: 1, kind: "bantam.something-else", edges: ["empty-input"] });
    assert.equal(validateContractEdgeResponse(wrongKind, CATALOG).code, "invalid-envelope");
  });

  it("rejects a repeated id instead of quietly deduplicating it", () => {
    const result = validateContractEdgeResponse(conforming(["empty-input", "empty-input"]), CATALOG);
    assert.equal(result.pass, false);
    assert.equal(result.code, "duplicate-edge");
  });

  it("rejects non-string edges", () => {
    const result = validateContractEdgeResponse(conforming(["empty-input", 7]), CATALOG);
    assert.equal(result.pass, false);
    assert.equal(result.code, "unknown-edge");
  });

  it("distinguishes its rejections, so rework can be routed by reason", () => {
    // A gauge whose every failure reports the same code cannot tell a malformed
    // emission from a wrong judgment, and the two need different rework paths.
    const codes = new Set([
      validateContractEdgeResponse("not json", CATALOG).code,
      validateContractEdgeResponse(conforming(["invented"]), CATALOG).code,
      validateContractEdgeResponse(conforming(["empty-input", "empty-input"]), CATALOG).code,
      validateContractEdgeResponse(JSON.stringify({ schema: 1, kind: "bantam.contract-edge-selection", edges: [], extra: 1 }), CATALOG).code,
    ]);
    assert.equal(codes.size, 4, `expected four distinct rejection reasons, got ${[...codes].join(", ")}`);
  });
});
