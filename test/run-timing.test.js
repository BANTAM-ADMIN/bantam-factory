// Station wall-clock. A run reported one number per turn (tookMs) and one for
// the whole run, so a 4-second turn could be 3.8s of prefill or 3.8s of running
// tests and nothing told them apart. "Measure station wall-clock to find the
// next choke" needs the breakdown, and every input for it is already in the
// artifact: turns carry tookMs and modelCallIndex, model calls carry
// startedAt/completedAt and the server's own prompt_ms / predicted_ms.
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeRunTiming, formatRunTiming } from "../src/logic/run-timing.js";

const artifact = {
  turns: [
    { i: 0, tookMs: 3000, modelCallIndex: 0, parsedAction: { a: "read_file" } },
    { i: 1, tookMs: 9000, modelCallIndex: 2, parsedAction: { a: "shell" } },
    { i: 2, tookMs: 2000, modelCallIndex: 3, parsedAction: { a: "shell" } },
    { i: 3, tookMs: 1000, modelCallIndex: 4, parsedAction: { a: "done" } },
  ],
  modelCalls: [
    // turn 0: one call, 1s, mostly prefill
    { index: 0, startedAt: "2026-08-22T10:00:00.000Z", completedAt: "2026-08-22T10:00:01.000Z",
      response: { normalized: { timings: { prompt_ms: 800, predicted_ms: 200 } } } },
    // turn 1: two calls (think phase + action), 2s total — the turn took 9s,
    // so 7s of it was the shell command, not the model. modelCallIndex records
    // the LAST call of a turn (measured on a real 100-turn artifact), so turn 1
    // carries index 2 and owns calls #1 and #2.
    { index: 1, startedAt: "2026-08-22T10:00:04.000Z", completedAt: "2026-08-22T10:00:05.000Z",
      response: { normalized: { timings: { prompt_ms: 500, predicted_ms: 500 } } } },
    { index: 2, startedAt: "2026-08-22T10:00:05.000Z", completedAt: "2026-08-22T10:00:06.000Z",
      response: { normalized: { timings: { prompt_ms: 400, predicted_ms: 600 } } } },
    { index: 3, startedAt: "2026-08-22T10:00:13.000Z", completedAt: "2026-08-22T10:00:14.000Z",
      response: { normalized: { timings: { prompt_ms: 300, predicted_ms: 700 } } } },
    { index: 4, startedAt: "2026-08-22T10:00:15.000Z", completedAt: "2026-08-22T10:00:15.500Z",
      response: { normalized: { timings: { prompt_ms: 100, predicted_ms: 400 } } } },
  ],
};

test("a run splits into model time and everything else", () => {
  const a = analyzeRunTiming(artifact);
  assert.equal(a.totalMs, 15000);
  assert.equal(a.modelMs, 4500, "1000 + 1000 + 1000 + 1000 + 500");
  assert.equal(a.otherMs, 10500, "actions and harness — the part tookMs used to hide");
  assert.equal(a.prefillMs, 2100);
  assert.equal(a.genMs, 2400);
});

test("model calls are attributed to the turn that issued them", () => {
  const a = analyzeRunTiming(artifact);
  const t1 = a.turns.find((t) => t.i === 1);
  assert.equal(t1.calls, 2, "the think phase and the action call both belong to turn 1");
  assert.equal(t1.modelMs, 2000);
  assert.equal(t1.otherMs, 7000, "the shell command, which is the real cost of that turn");
});

test("stations rank by total time so the choke is obvious", () => {
  const a = analyzeRunTiming(artifact);
  assert.equal(a.stations[0].verb, "shell", "11s across 2 calls beats read_file's 3s");
  assert.equal(a.stations[0].calls, 2);
  assert.equal(a.stations[0].totalMs, 11000);
  assert.equal(a.stations[0].meanMs, 5500);
  // Ranking on the NON-model share is what identifies a slow station: a station
  // that is slow only because the prompt was long is not the station's fault.
  assert.equal(a.stations[0].otherMs, 8000);
});

test("the slowest turns are listed so a single stall is visible", () => {
  const a = analyzeRunTiming(artifact);
  assert.equal(a.slowestTurns[0].i, 1);
  assert.equal(a.slowestTurns[0].tookMs, 9000);
});

test("the run-level split always reconciles to 100%", () => {
  // Per-turn otherMs is clamped at zero, so summing it can exceed the total when
  // a retry straddles a boundary — on a real artifact that printed "model 81% /
  // other 41%". The run-level numbers are derived from the totals so they add up.
  const a = analyzeRunTiming(artifact);
  assert.equal(a.modelMs + a.otherMs, a.totalMs);
  assert.ok(a.modelMs <= a.totalMs, "model time cannot exceed the run");
});

test("turns whose calls outlive them are counted, not hidden", () => {
  const skewed = {
    turns: [{ i: 0, tookMs: 100, modelCallIndex: 0, parsedAction: { a: "shell" } }],
    modelCalls: [{ index: 0, startedAt: "2026-08-22T10:00:00.000Z", completedAt: "2026-08-22T10:00:09.000Z",
                   response: { normalized: { timings: {} } } }],
  };
  const a = analyzeRunTiming(skewed);
  assert.equal(a.overAttributed, 1, "the data-quality signal must be visible, not smoothed away");
  assert.equal(a.modelMs + a.otherMs, a.totalMs);
});

test("a run with no model calls still reports its wall clock", () => {
  const a = analyzeRunTiming({ turns: [{ i: 0, tookMs: 500, parsedAction: { a: "done" } }], modelCalls: [] });
  assert.equal(a.totalMs, 500);
  assert.equal(a.modelMs, 0);
  assert.equal(a.otherMs, 500);
});

test("an empty or malformed artifact returns null rather than zeros", () => {
  assert.equal(analyzeRunTiming({ turns: [], modelCalls: [] }), null);
  assert.equal(analyzeRunTiming(null), null);
  assert.equal(analyzeRunTiming({}), null);
});

test("the report names the split, the stations and the units", () => {
  const text = formatRunTiming(analyzeRunTiming(artifact)).join("\n");
  assert.match(text, /model/i);
  assert.match(text, /prefill/i);
  assert.match(text, /shell/);
  assert.match(text, /%/, "shares, so a reader can see where the run went");
});

test("a run killed mid-flight still profiles, from the model-call timestamps", () => {
  // A timed-out run's artifact is assembled from a checkpoint, so no turn
  // carries tookMs and metrics.durationMs is absent — which is exactly the run
  // you most want to profile. write-compressor timed out at 1800s with 48 turns
  // and 67 model calls, and the station clock reported 0s for all of it.
  const killed = {
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "shell" } },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "write_file" } },
    ],
    modelCalls: [
      { index: 0, startedAt: "2026-08-22T10:00:00.000Z", completedAt: "2026-08-22T10:00:06.000Z",
        response: { normalized: { timings: { prompt_ms: 1000, predicted_ms: 5000 } } } },
      { index: 1, startedAt: "2026-08-22T10:00:10.000Z", completedAt: "2026-08-22T10:00:20.000Z",
        response: { normalized: { timings: { prompt_ms: 2000, predicted_ms: 8000 } } } },
    ],
  };
  const a = analyzeRunTiming(killed);
  assert.ok(a, "a timed-out run must still analyse");
  assert.equal(a.estimated, true, "and must SAY the span is inferred, not measured");
  assert.equal(a.totalMs, 20000, "first call start to last call end");
  assert.equal(a.modelMs, 16000);
  assert.equal(a.prefillMs, 3000);
  assert.equal(a.genMs, 13000);
  assert.equal(a.modelMs + a.otherMs, a.totalMs, "shares still reconcile");
  assert.match(formatRunTiming(a).join("\n"), /estimated/i);
});

test("a normal run is not marked estimated", () => {
  assert.equal(analyzeRunTiming(artifact).estimated, false);
});
