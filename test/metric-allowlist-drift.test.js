import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// fixture-runner.js copies metrics into the run artifact through a hand-maintained
// ALLOWLIST. A metric counted in agent.js but missing from that list is silently
// dropped -- it looks recorded, and every later analysis reads it as zero or absent.
//
// This has now happened twice. The gate-engagement counters were invisible until
// someone traced a gate by hand, and blastRadiusNotes was counted correctly while
// the artifact showed "(absent)" -- so a feature that WAS working could not be
// measured, which is indistinguishable from one that is not.
//
// Derived, not restated: the list of metrics is read out of agent.js source rather
// than written down here, so the two cannot drift apart the way BOOLEAN_FLAGS did
// from bin/bantam.js.

const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/artifact.js", import.meta.url), "utf8");

describe("run metrics reach the artifact", () => {
  it("captures the agent's counters verbatim rather than by hand-maintained list", () => {
    assert.match(runner, /\.\.\.serializableCopy\(m \?\? \{\}\)/,
      "the curated list dropped 34 of 42 counters; the verbatim capture is what stops the next one going missing");
  });

  it("records every counter the agent increments", () => {
    const counted = new Set();
    // metrics.x = (metrics.x ?? 0) + 1
    for (const m of agent.matchAll(/metrics\.([A-Za-z][\w]*)\s*=\s*\(metrics\.\1\s*\?\?\s*0\)/g)) {
      counted.add(m[1]);
    }
    assert.ok(counted.size > 5, `expected to find agent counters, found ${counted.size}`);

    // Satisfied either by an explicit curated field or by the verbatim capture.
    const capturesEverything = /\.\.\.serializableCopy\(m \?\? \{\}\)/.test(runner);
    if (capturesEverything) return;

    const missing = [...counted].filter((name) => !runner.includes(`${name}:`)).sort();
    assert.deepEqual(missing, [],
      "these metrics are counted in agent.js but never reach the artifact, so they "
      + `read as absent in every analysis: ${missing.join(", ")}`);
  });
});
