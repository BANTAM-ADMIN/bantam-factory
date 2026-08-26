import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEvalObservation } from "../src/eval-observation.js";

test("evaluation observations remove TAP timing and disposable workspace volatility", () => {
  const first = [
    "cwd: /tmp/bantam-eval-Ab12",
    "# Subtest: /tmp/bantam-eval-Ab12/test/public.test.js",
    "  duration_ms: 12.345",
    "# duration_ms 98.7",
  ].join("\n");
  const second = [
    "cwd: /tmp/bantam-eval-Zz99",
    "# Subtest: /tmp/bantam-eval-Zz99/test/public.test.js",
    "  duration_ms: 44.001",
    "# duration_ms 101.2",
  ].join("\n");

  const normalizedFirst = normalizeEvalObservation(first, { workspace: "/tmp/bantam-eval-Ab12" });
  const normalizedSecond = normalizeEvalObservation(second, { workspace: "/tmp/bantam-eval-Zz99" });
  assert.equal(normalizedFirst, normalizedSecond);
  assert.match(normalizedFirst, /cwd: <workspace>/);
  assert.match(normalizedFirst, /duration_ms: <elapsed>/);
  assert.match(normalizedFirst, /# duration_ms <elapsed>/);
  assert.doesNotMatch(normalizedFirst, /bantam-eval|12\.345|98\.7/);
});
