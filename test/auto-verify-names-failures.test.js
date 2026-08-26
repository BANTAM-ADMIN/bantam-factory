import assert from "node:assert/strict";
import test from "node:test";

import { parseTestCounts, renderFailingTests } from "../src/logic/test-focus.js";

// Measured on tb4 (.bantam/runs/2026-08-16T16-16-10-688Z.json): auto-verify
// fired on turns 8, 17, 40 and 49. Each observation read
//
//   [auto-verify] You have edited but not run the tests in 9 turns … — FAIL:
//   TAP version 13 # Subtest: estimateCost covers every protocol action family
//   ok 1 - estimateCost covers every protocol action family …
//
// The model was told FAIL and then shown a wall of PASSING tests: clip() keeps
// the HEAD of the output, and the head of a 2,000-test TAP stream is "ok 1,
// ok 2, ok 3 …" with the failures thousands of lines down. It could not tell
// what broke, and did not run the tests itself until turn 54 of 60.
//
// executor.js already solved this for model-run shell commands. The renderer
// now lives in logic/test-focus.js so both paths share it.

function tapStreamWithBuriedFailure({ before = 1200, after = 800 } = {}) {
  const head = Array.from({ length: before }, (_, i) => `ok ${i + 1} - passing test ${i + 1}`);
  const failure = [
    `not ok ${before + 1} - an impossible editable scope ends the run early with the diagnosis`,
    "  ---",
    "  location: '/ws/test/unsatisfiable-scope.test.js:42:1'",
    "  ...",
  ];
  const tail = Array.from({ length: after }, (_, i) => `ok ${before + 2 + i} - later test ${i}`);
  const total = before + after + 1;
  return [
    ...head,
    ...failure,
    ...tail,
    `# tests ${total}`,
    `# pass ${total - 1}`,
    "# fail 1",
  ].join("\n");
}

test("a failure buried deep in a TAP stream is still named", () => {
  const output = tapStreamWithBuriedFailure();
  const counts = parseTestCounts(output);
  assert.equal(counts.failed, 1);
  assert.equal(counts.total, 2001);

  const rendered = renderFailingTests(output);
  assert.match(rendered, /an impossible editable scope ends the run early/,
    "the failing test's NAME is the fact the model needs");
  assert.match(rendered, /unsatisfiable-scope\.test\.js:42/, "with its location");
});

test("the digest survives head-clipping, which the raw log does not", () => {
  // The point of the fix: whatever the clip budget, the verdict and the names
  // sit at the very top where clipping cannot reach them.
  const output = tapStreamWithBuriedFailure();
  const counts = parseTestCounts(output);
  const digest = `VERDICT: ${counts.failed} of ${counts.total} tests FAILED (${counts.passed} passed).\n`
    + renderFailingTests(output);
  const observation = `${digest}${output.slice(0, 2000)}`;

  assert.ok(observation.slice(0, 2000).includes("an impossible editable scope"),
    "the failing name must be inside any sane clip window");
  assert.ok(!output.slice(0, 2000).includes("not ok"),
    "precondition: the raw head genuinely contains no failure (this was the bug)");
});

test("an all-passing run reports a clean verdict and no failure list", () => {
  const output = ["ok 1 - a", "ok 2 - b", "# tests 2", "# pass 2", "# fail 0"].join("\n");
  const counts = parseTestCounts(output);
  assert.equal(counts.failed, 0);
  assert.equal(renderFailingTests(output), "");
});

test("many failures are capped with a remainder note", () => {
  // Six rows, not ten: a controller block survives clipping by its first ~700
  // characters and ten rows overflow it, so tb15 lost the 7th onward from the
  // next prompt. Fewer rows that arrive beat more that are clipped.
  const rows = Array.from({ length: 14 }, (_, i) => `not ok ${i + 1} - failure number ${i + 1}`);
  const output = [...rows, "# tests 14", "# pass 0", "# fail 14"].join("\n");
  const rendered = renderFailingTests(output);
  assert.match(rendered, /… and 8 more/);
  assert.equal((rendered.match(/✗/g) ?? []).length, 6);
  assert.ok(rendered.length <= 700, "the whole digest must fit the preserved block head");
});

test("unparseable output yields no digest rather than a wrong one", () => {
  assert.equal(renderFailingTests("segmentation fault"), "");
  assert.equal(parseTestCounts("segmentation fault"), null);
});

// tb6 (.bantam/runs/2026-08-16T17-22-16-517Z.json) turn 18: the digest reached
// the model, but read
//
//   VERDICT: 177 of 1518 tests FAILED (1341 passed).
//   Failing tests:
//     ✗ /tmp/claude-1000/-home-…/tb6-ws/test/agent.test.js (/tmp/…/agent.test.js:1)
//
// ~250 characters per entry, the same absolute path twice, and the only fact
// conveyed is "agent.test.js". Those are node's FILE-level failures: the file
// never ran because something it imports stopped parsing — which is what the
// model had just done to src/agent.js. That is a different fact from a failing
// assertion and it is the one worth saying.

const WS = "/tmp/scratch/ws";

function fileLevelFailures(files, extra = []) {
  const rows = [];
  for (const f of files) {
    rows.push(`not ok 1 - ${WS}/test/${f}`, "  ---", `  location: '${WS}/test/${f}:1:1'`, "  ...");
  }
  for (const e of extra) {
    rows.push(`not ok 9 - ${e.name}`, "  ---", `  location: '${WS}/test/${e.file}:${e.line}:3'`, "  ...");
  }
  const total = files.length + extra.length;
  rows.push(`# tests ${total}`, "# pass 0", `# fail ${total}`);
  return rows.join("\n");
}

test("file-level failures are labelled as files that did not run", () => {
  const rendered = renderFailingTests(fileLevelFailures(["agent.test.js"]), { root: WS });
  assert.match(rendered, /test\/agent\.test\.js — the file did not run/);
});

test("paths are relative to the workspace", () => {
  const rendered = renderFailingTests(fileLevelFailures(["agent.test.js"]), { root: WS });
  assert.doesNotMatch(rendered, /\/tmp\/scratch\/ws/, "an absolute temp path is pure noise");
});

test("several non-running files get the shared-import diagnosis", () => {
  const rendered = renderFailingTests(
    fileLevelFailures(["agent.test.js", "executor.test.js", "prompt.test.js"]),
    { root: WS },
  );
  assert.match(rendered, /3 test files failed to RUN rather than failing an assertion/);
  assert.match(rendered, /one source file they all import no longer parsing/);
});

test("a single non-running file does not get the shared-import claim", () => {
  // One file proves nothing about a shared import; saying so would be a guess.
  const rendered = renderFailingTests(fileLevelFailures(["agent.test.js"]), { root: WS });
  assert.doesNotMatch(rendered, /failed to RUN rather than/);
});

test("named assertions are listed before file-level failures", () => {
  const rendered = renderFailingTests(
    fileLevelFailures(["a.test.js", "b.test.js"], [{ name: "a real assertion", file: "c.test.js", line: 42 }]),
    { root: WS },
  );
  const named = rendered.indexOf("a real assertion");
  const file = rendered.indexOf("the file did not run");
  assert.ok(named >= 0 && file >= 0 && named < file,
    "an assertion names what to fix; a non-running file only names where to look");
});

test("the shared-import diagnosis leads, ahead of the individual rows", () => {
  // It is the single most actionable line in the block, and per-block clipping
  // keeps only the first ~700 characters. Trailing it put it behind up to ten
  // `✗` rows and off the end: tb13 lost exactly this line on turns 9, 18, 27,
  // 35, 44, 53, 66, 75 and 84 (.bantam/runs/2026-08-16T20-40-12-127Z.json).
  const rendered = renderFailingTests(
    fileLevelFailures(Array.from({ length: 12 }, (_, i) => `f${i}.test.js`)),
    { root: WS },
  );
  const head = rendered.slice(0, 700);
  assert.match(head, /12 test files failed to RUN rather than failing an assertion/);
  assert.ok(
    rendered.indexOf("failed to RUN rather than") < rendered.indexOf("Failing tests:"),
    "the diagnosis must precede the list, not follow it",
  );
});

// tb16 (2026-08-16, .bantam/runs/2026-08-16T22-44-48-870Z.json) was told four
// separate times that 152-224 test files would not load, with the right
// diagnosis — "one source file they all import no longer parsing" — while it
// had edited exactly one source file all run. The harness knew which; it just
// did not say.

test("the load diagnosis names the file this run changed", () => {
  const rendered = renderFailingTests(
    fileLevelFailures(["a.test.js", "b.test.js", "c.test.js"]),
    { root: WS, suspects: new Set(["src/agent.js"]) },
  );
  assert.match(rendered, /You changed src\/agent\.js in this run — check that it still parses/);
});

test("test files the run wrote are not offered as the culprit", () => {
  // The model's own new test file cannot be the shared import that broke 150
  // unrelated files.
  const rendered = renderFailingTests(
    fileLevelFailures(["a.test.js", "b.test.js"]),
    { root: WS, suspects: new Set(["src/agent.js", "test/impossible-scope.test.js"]) },
  );
  assert.match(rendered, /You changed src\/agent\.js in this run/);
  assert.doesNotMatch(rendered, /impossible-scope\.test\.js in this run/);
});

test("no suspects means no claim", () => {
  const rendered = renderFailingTests(fileLevelFailures(["a.test.js", "b.test.js"]), { root: WS });
  assert.match(rendered, /failed to RUN rather than failing an assertion/);
  assert.doesNotMatch(rendered, /You changed/);
});

test("the diagnosis with a culprit still fits the preserved block head", () => {
  const rendered = renderFailingTests(
    fileLevelFailures(Array.from({ length: 12 }, (_, i) => `f${i}.test.js`)),
    { root: WS, suspects: new Set(["src/agent.js"]) },
  );
  assert.ok(rendered.slice(0, 700).includes("check that it still parses"),
    "the culprit must survive clipping, or naming it is pointless");
});

// tb16 was graded "verification: fail (exit 1)" on a workspace that passes
// 2,102 of 2,102 tests on the host. Through the sandbox it reported 190
// failures and 13 cancellations, of which 36 were `spawnSync git EAGAIN` and 5
// `spawn /usr/bin/node EAGAIN` — process-table exhaustion under a 256-PID cap,
// not a defect in the model's code. Raising the cap fixed the cause; saying so
// stops the next reader chasing phantoms.

test("spawn exhaustion is called out as an environment limit", () => {
  const output = [
    ...Array.from({ length: 5 }, (_, i) => `not ok ${i + 1} - something broke ${i}`),
    "  error: 'spawnSync git EAGAIN'",
    "  error: 'spawnSync git EAGAIN'",
    "  error: 'spawn /usr/bin/node EAGAIN'",
    "# tests 5", "# pass 0", "# fail 5",
  ].join("\n");
  const rendered = renderFailingTests(output, { root: WS });
  assert.match(rendered, /failed with EAGAIN\/ENOMEM/);
  assert.match(rendered, /environment limit, not your code/);
});

test("an ordinary failing suite gets no environment excuse", () => {
  const output = [
    "not ok 1 - a genuine assertion failure",
    "  error: 'Expected values to be strictly equal'",
    "# tests 1", "# pass 0", "# fail 1",
  ].join("\n");
  assert.doesNotMatch(renderFailingTests(output, { root: WS }), /EAGAIN/);
});

test("one stray EAGAIN is not enough to excuse a suite", () => {
  const output = [
    "not ok 1 - a genuine failure",
    "  error: 'spawnSync git EAGAIN'",
    "# tests 1", "# pass 0", "# fail 1",
  ].join("\n");
  assert.doesNotMatch(renderFailingTests(output, { root: WS }), /environment limit/);
});

// tb18 turn 72 (2026-08-16, .bantam/runs/2026-08-16T23-54-04-555Z.json): the
// model ran its own test file, and the next prompt kept the failing test's NAME
// while losing "Expected values to be strictly equal", "+ actual - expected"
// and "ERR_ASSERTION" to clipping — 9 of 16 decisive lines gone. It learned
// which test failed and not how, eight times across 53 turns, and never
// converged. parseTestFailures had expected/actual all along; the digest threw
// them away.

function assertionFailure(n, expected, actual) {
  return [
    `not ok ${n} - a normal editable list is unaffected`,
    "  ---",
    `  location: '${WS}/test/impossible-scope.test.js:8${n}:1'`,
    "  error: |-",
    "    Expected values to be strictly equal:",
    "  code: 'ERR_ASSERTION'",
    `  expected: ${expected}`,
    `  actual: ${actual}`,
    "  ...",
  ].join("\n");
}

test("a failing assertion carries its expected and actual", () => {
  const output = [assertionFailure(1, "true", "false"), "# tests 1", "# pass 0", "# fail 1"].join("\n");
  const rendered = renderFailingTests(output, { root: WS });
  assert.match(rendered, /expected true, got false/);
  assert.match(rendered, /impossible-scope\.test\.js:81/, "with its location");
});

test("a long expected value is bounded, not dumped", () => {
  const output = [
    assertionFailure(1, `'${"x".repeat(300)}'`, "'y'"),
    "# tests 1", "# pass 0", "# fail 1",
  ].join("\n");
  const rendered = renderFailingTests(output, { root: WS });
  assert.match(rendered, /…/, "the value is truncated");
  assert.ok(rendered.length <= 700, `digest must fit the preserved head, got ${rendered.length}`);
});

test("a file-level failure has no assertion to report", () => {
  const rendered = renderFailingTests(fileLevelFailures(["a.test.js"]), { root: WS });
  assert.doesNotMatch(rendered, /expected .*, got/);
});

test("six assertion rows still fit the preserved block head", () => {
  const rows = Array.from({ length: 6 }, (_, i) => assertionFailure(i + 1, "true", "false"));
  const output = [...rows, "# tests 6", "# pass 0", "# fail 6"].join("\n");
  const rendered = renderFailingTests(output, { root: WS });
  assert.ok(rendered.length <= 700, `got ${rendered.length}`);
  assert.equal((rendered.match(/expected true, got false/g) ?? []).length, 6);
});
