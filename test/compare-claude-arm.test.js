import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeExternalArgs } from "../src/logic/compare-plan.js";

test("the four-arm Claude reference uses current noninteractive stream JSON flags", () => {
  const args = buildClaudeExternalArgs("fix it");
  assert.ok(args.includes("--print"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("acceptEdits"));
  assert.ok(!args.some((arg) => arg === "--output-format=tool" || arg === "tool"));
  assert.equal(args.at(-1), "fix it");
});
