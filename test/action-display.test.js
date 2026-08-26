import test from "node:test";
import assert from "node:assert/strict";

import { formatQueryAction } from "../src/action-display.js";

test("query action labels preserve the complete query for terminal wrapping", () => {
  const query = "concept how context is assembled before sending to the model — what gets included, excluded, and retained between turns";

  assert.equal(formatQueryAction(query), `query "${query}"`);
  assert.ok(formatQueryAction(query).includes("retained between turns"));
});

test("query action labels tolerate absent query text", () => {
  assert.equal(formatQueryAction(), 'query ""');
});
