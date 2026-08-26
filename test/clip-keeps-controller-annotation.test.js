import assert from "node:assert/strict";
import test from "node:test";

import { clipKeepingControllerAnnotation } from "../src/prompt.js";
import { OBS_MAX } from "../src/clip.js";

// tb7 turns 9, 18 and 27 (2026-08-16, .bantam/runs/2026-08-16T18-00-31-834Z.json).
// The context flight recorder reported, of the previous outcome:
//
//   transform: { changed: false, decisiveLinesDropped: 0 }
//   decisiveEvidence: { lines: 5, residentLines: 2, missingLines: 3,
//     missingSamples: ["81 test files failed to RUN rather than failing an
//     assertion — that is normally one source file they all import no longer
//     parsing. Fix that first.", …] }
//
// Nothing transformed the observation. It was clipped. A controller annotation
// is APPENDED to tool output, and clipText keeps a big head plus a 1,000-char
// tail, so on any observation past budget the harness's own words land in the
// clipped middle while the surviving tail is raw runner noise. The harness
// computed the single most decisive fact of the run and then deleted it.

const DIAGNOSIS = "81 test files failed to RUN rather than failing an assertion — "
  + "that is normally one source file they all import no longer parsing. Fix that first.";

function observationWithAppendedAnnotation() {
  const body = ["replaced 1 occurrence in src/agent.js"]
    .concat(Array.from({ length: 400 }, (_, i) => `context line ${i} of the edit impact report`))
    .join("\n");
  const annotation = [
    "[auto-verify] You have edited but not run the tests in 9 turns — so I ran them for you — FAIL:",
    "VERDICT: 81 of 1500 tests FAILED (1419 passed).",
    "Failing tests:",
    "  ✗ test/a.test.js — the file did not run",
    DIAGNOSIS,
    ...Array.from({ length: 200 }, (_, i) => `ok ${i} - noisy passing tap line`),
  ].join("\n");
  return `${body}\n${annotation}`;
}

test("the controller annotation survives clipping", () => {
  const kept = clipKeepingControllerAnnotation(observationWithAppendedAnnotation(), true);
  assert.ok(kept.includes(DIAGNOSIS), "the decisive line must reach the next prompt");
  assert.match(kept, /VERDICT: 81 of 1500 tests FAILED/);
});

test("plain clipping loses it — this is the bug being fixed", () => {
  const plain = clipKeepingControllerAnnotation(observationWithAppendedAnnotation(), false);
  assert.ok(!plain.includes(DIAGNOSIS),
    "precondition: head+tail clipping drops an appended annotation");
});

test("the result still respects the observation budget", () => {
  const kept = clipKeepingControllerAnnotation(observationWithAppendedAnnotation(), true);
  assert.ok(kept.length <= OBS_MAX, `expected <= ${OBS_MAX}, got ${kept.length}`);
});

test("tool output is not evicted entirely by a huge annotation", () => {
  // The annotation gets first call on the budget, not all of it: the output it
  // comments on is what makes it actionable.
  const kept = clipKeepingControllerAnnotation(observationWithAppendedAnnotation(), true);
  assert.match(kept, /replaced 1 occurrence in src\/agent\.js/,
    "the head of the tool output must survive too");
});

test("an observation within budget is returned untouched", () => {
  const small = "replaced 1 occurrence in a.js\n[auto-verify] VERDICT: all 3 tests passed.";
  assert.equal(clipKeepingControllerAnnotation(small, true), small);
});

test("an observation with no annotation clips exactly as before", () => {
  const plain = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const viaNew = clipKeepingControllerAnnotation(plain, true);
  const viaOld = clipKeepingControllerAnnotation(plain, false);
  assert.equal(viaNew, viaOld, "no annotation means no behavior change");
});

// The fixture above is synthetic and put a single annotation past the clip
// window. Real observations are not shaped like that, and the difference
// mattered: the FIRST version of this fix preserved one suffix starting at the
// FIRST annotation, which on real bytes was strictly worse than plain clipping.
//
// tb9 turn 8 (2026-08-16, .bantam/runs/2026-08-16T18-34-07-754Z.json), measured:
//   6,044 chars; annotations at 51 [impact], 324 [peer], 1448 [impact],
//   1681 [auto-verify], 5253 [fix-tests]; "VERDICT:" at 1,819 — 30% in.
// Plain clipping keeps a ~2,960-char head, so the verdict SURVIVED it. The
// suffix approach kept the suffix's head and tail and dropped its middle —
// exactly where the verdict sat — rendering 2,452 chars with [impact], [peer]
// and [fix-tests] present and [auto-verify] gone. The recorder duly reported
// "VERDICT: 187 of 1393 tests FAILED" missing from the next prompt.
//
// So the guarantee has to be per-BLOCK, not per-suffix.

function realShapedObservation() {
  const pad = (label, lines) => Array.from({ length: lines }, (_, i) => `${label} ${i}`).join("\n");
  return [
    "replaced 1 occurrence in src/agent.js at line 5274",
    "[impact] Cross-file references for symbols in this edit —",
    pad("  referenced in file", 4),
    "[peer] `editScopeRefusal` is also handled elsewhere in this repo.",
    pad("  peer detail line", 30),
    "[impact] second impact block",
    pad("  more impact detail", 4),
    "[auto-verify] You have edited but not run the tests in 9 turns — FAIL:",
    "VERDICT: 187 of 1393 tests FAILED (1206 passed).",
    "Failing tests:",
    "  ✗ rejects recursive, mismatched, unsupported launches (test/channel-launcher.test.js:242)",
    pad("ok - noisy passing tap line", 120),
    "[fix-tests] the test that must pass:",
    pad("  test source line", 10),
  ].join("\n");
}

test("every annotation block keeps its head, including one in the middle", () => {
  const obs = realShapedObservation();
  assert.ok(obs.length > OBS_MAX, "precondition: the observation is over budget");
  const kept = clipKeepingControllerAnnotation(obs, true);

  assert.match(kept, /VERDICT: 187 of 1393 tests FAILED/, "the middle annotation's verdict must survive");
  assert.match(kept, /\[auto-verify\]/);
  assert.match(kept, /\[fix-tests\]/, "and the last annotation");
  assert.match(kept, /\[peer\]/, "and an early one");
  assert.match(kept, /rejects recursive, mismatched/, "the failing test name rides with the verdict");
  assert.ok(kept.length <= OBS_MAX);
});

test("quoted tool output inside a block is what gets dropped, not the block", () => {
  const kept = clipKeepingControllerAnnotation(realShapedObservation(), true);
  assert.match(kept, /chars of quoted output clipped/,
    "the noisy TAP tail is the right thing to lose");
});

// The protected-tag list had drifted behind the code. Counting annotation tags
// across the 2026-08-16 runs: `ledger` was the most frequent of all (77
// occurrences) and unprotected, along with `budget` (41), `peer` (19) and
// `pipe-guard` (4) — the last of which carries the exact command to re-send
// after a refused test pipe. Several were steers added in this same session
// that clipping could remove before the model ever read them.

test("recently added harness steers are protected from clipping", () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `tool output line ${i} of the read window`).join("\n");
  const observation = [
    filler(60),
    "[ledger] Skipped 2 read op(s) already in your read history: src/a.js 1-50, src/b.js 1-50.",
    filler(40),
    "[pipe-guard] Send exactly this instead:",
    "  node --test $(ls test/*.test.js)",
    filler(40),
    "[peer] `tampered` is also handled elsewhere in this repo.",
    filler(40),
  ].join("\n");

  assert.ok(observation.length > OBS_MAX, "precondition: over budget");
  const kept = clipKeepingControllerAnnotation(observation, true);
  for (const marker of ["[ledger]", "[pipe-guard]", "[peer]", "Send exactly this instead"]) {
    assert.ok(kept.includes(marker), `${marker} must survive clipping`);
  }
});

test("tool output wearing a bracket is not protected", () => {
  // `[stderr]` is a label on command output, not the harness speaking; it must
  // stay eligible for clipping or the exemption swallows the thing it guards.
  const filler = (n) => Array.from({ length: n }, (_, i) => `noise line ${i} of raw command output`).join("\n");
  const observation = [filler(200), "[stderr]", filler(200)].join("\n");
  const kept = clipKeepingControllerAnnotation(observation, true);
  const plain = clipKeepingControllerAnnotation(observation, false);
  assert.equal(kept, plain, "no annotation recognized means ordinary clipping");
});
