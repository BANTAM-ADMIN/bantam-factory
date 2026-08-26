import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repositoryRoot, "scripts/c0-parity-experiment.mjs");
const outputs = new Set();

afterEach(() => {
  for (const directory of outputs) fs.rmSync(directory, { recursive: true, force: true });
  outputs.clear();
});

function run(repetitions = 2) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-c0-parity-"));
  outputs.add(out);
  const result = spawnSync(process.execPath, [script, "--repetitions", String(repetitions), "--out", out], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { ...result, evidence: JSON.parse(fs.readFileSync(path.join(out, "evidence/c0-parity.json"), "utf8")) };
}

describe("C0 parity experiment", () => {
  it("leaves the real agent loop's behavior unchanged under factory instrumentation", () => {
    const { evidence } = run(2);

    // The whole point of C0: describing a run as a factory job must not change
    // the run. Every one of these is a comparison between two executions of
    // src/agent.js, not of the factory line controller.
    assert.equal(evidence.workspace.identicalStartingTrees, true);
    assert.equal(evidence.workspace.identicalFinalTrees, true);
    assert.equal(evidence.model.identicalPrompts, true);
    assert.equal(evidence.model.requestDelta, 0);
    assert.equal(evidence.trajectory.identicalActions, true);
    assert.equal(evidence.trajectory.identicalTerminalDisposition, true);

    // The instrumented arm's traveler must reconstruct without trusting whoever
    // wrote it.
    assert.equal(evidence.reconstruction.travelersAudited, evidence.reconstruction.pairs);
    assert.equal(evidence.reconstruction.telemetryComplete, true);
  });

  it("records the instrumentation cost without turning scheduler noise into a verdict", () => {
    const { evidence } = run(2);
    // These millisecond-scale model-free arms are scheduler-sensitive: the
    // relative wall ratio has landed on both sides of 1.05 in full-suite runs.
    // Preserve it as telemetry, while the earned C0 durability bound is the
    // direct instrument: observation adds no durable sync per event.
    assert.ok(Number.isFinite(evidence.overhead.p95Ratio));
    assert.ok(evidence.overhead.p95Ratio >= 0);
    assert.ok(evidence.overhead.meanSelfReportedOverheadMs >= 0);
    assert.ok(evidence.overhead.meanControlWallMs > 0);
    assert.equal(evidence.overhead.noteFsyncsPerEvent, 0);
  });
});
