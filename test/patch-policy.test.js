import assert from "node:assert/strict";
import test from "node:test";

import { PATCH_ACTION_FEATURE, actionDefinition } from "../src/action-protocol.js";
import { decidePatchAction } from "../src/patch-policy.js";

test("broad module migrations expose the guarded atomic patch action", () => {
  const decision = decidePatchAction(
    "Complete the normalization migration across every module in src/adapters.",
    "auto",
  );

  assert.deepEqual(decision, {
    mode: "auto",
    enabled: true,
    reason: "auto-mechanical-consistency",
  });
});

test("atomic patch supports a bounded broad-module change set", () => {
  const definition = actionDefinition("patch", {
    features: [PATCH_ACTION_FEATURE],
  });
  const edits = definition.fields.find((field) => field.key === "edits");

  assert.equal(edits.maxItems, 16);
});
