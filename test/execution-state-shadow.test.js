import assert from "node:assert/strict";
import test from "node:test";

import { deriveExecutionStateShadow } from "../src/logic/execution-state-shadow.js";

test("execution state is derived only from universal trajectory facts", () => {
  assert.equal(deriveExecutionStateShadow().phase, "investigate");
  assert.equal(deriveExecutionStateShadow({ residentSourceCount: 1 }).phase, "implement");
  assert.equal(deriveExecutionStateShadow({ residentSourceCount: 1, lastEditTurn: 2 }).phase, "verify");
  assert.equal(deriveExecutionStateShadow({ lastEditTurn: 2, lastVerdictTurn: 3, lastVerdict: "pass" }).phase, "land");
  assert.equal(deriveExecutionStateShadow({ lastEditTurn: 2, lastVerdictTurn: 3, lastVerdict: "fail" }).phase, "repair");
  assert.equal(deriveExecutionStateShadow({ lastEditTurn: 2, lastVerdictTurn: 3, lastVerdict: "pass", pendingBlockerCount: 1 }).phase, "repair");
});

test("execution state shadow is explicitly observe-only", () => {
  const result = deriveExecutionStateShadow({ residentSourceCount: 3 });
  assert.equal(result.mode, "shadow");
  assert.equal(result.authority, "observe-only");
  assert.ok(result.proof);
});

test("source-grounded pre-edit boundary requires every literal named source", () => {
  const partial = deriveExecutionStateShadow({
    residentSourceCount: 2,
    namedSourceCount: 2,
    residentNamedSourceCount: 1,
  });
  assert.deepEqual(partial.boundaries, []);

  const ready = deriveExecutionStateShadow({
    residentSourceCount: 2,
    namedSourceCount: 2,
    residentNamedSourceCount: 2,
  });
  assert.deepEqual(ready.boundaries, ["source_grounded_pre_edit"]);
  assert.ok(ready.boundaryProofs.source_grounded_pre_edit);

  const edited = deriveExecutionStateShadow({
    residentSourceCount: 2,
    namedSourceCount: 2,
    residentNamedSourceCount: 2,
    lastEditTurn: 3,
  });
  assert.deepEqual(edited.boundaries, []);
});
