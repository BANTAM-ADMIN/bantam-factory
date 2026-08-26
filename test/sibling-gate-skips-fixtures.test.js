import assert from "node:assert/strict";
import test from "node:test";

import { detectSiblings } from "../src/logic/completeness-critic.js";

// tb11 (2026-08-16) finished the ticket, emitted `done`, and the sibling-symbol
// gate answered:
//
//   `runAgentCore` (you changed it in src/agent.js) is also defined in
//   gauntlet/fixtures/retry-consolidation-haystack/repo/src/platform/agent.js:258
//   — a file you never examined. Examine each listed site and apply the
//   equivalent change where it applies.
//
// That path is a deliberately frozen copy of an old agent.js, the haystack a
// retrieval benchmark searches. Applying the ticket's change there would
// corrupt the fixture. It carries no `test/` segment, so the existing
// test-and-repro exclusion let it through, and the gate spent the run's last
// turns steering toward a file it must never touch.
//
// A fixture or vendored tree is DATA, not a sibling implementation.

function groundDefining(...files) {
  const rows = files.map((f) => [f, "runAgentCore"]);
  return { db: { query: (relation) => (relation === "defines" ? rows : []) } };
}

const findings = (...files) => detectSiblings({
  ground: groundDefining(...files),
  editedSymbols: new Set(["runAgentCore"]),
  visited: new Set(["src/agent.js"]),
  workspace: process.cwd(),
});

test("a benchmark fixture copy is not reported as a sibling", () => {
  const out = findings("src/agent.js", "gauntlet/fixtures/retry-consolidation-haystack/repo/src/platform/agent.js");
  assert.deepEqual(out, []);
});

test("vendored and installed trees are not siblings either", () => {
  for (const other of [
    "node_modules/some-pkg/lib/agent.js",
    "vendor/upstream/agent.js",
    "third_party/agent.js",
    "test/fixtures/agent.js",
    "src/__fixtures__/agent.js",
  ]) {
    assert.deepEqual(findings("src/agent.js", other), [], `${other} must be excluded`);
  }
});

test("a genuine second implementation is still reported", () => {
  const out = findings("src/agent.js", "src/platform/agent.js");
  assert.equal(out.length, 1, "a real sibling in the source tree is exactly what this gate is for");
  assert.match(JSON.stringify(out), /src\/platform\/agent\.js/);
});
