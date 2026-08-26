import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repositoryRoot, "scripts/c1-localization-experiment.mjs");
const outputs = new Set();

afterEach(() => {
  for (const directory of outputs) fs.rmSync(directory, { recursive: true, force: true });
  outputs.clear();
});

function run(repetitions = 2) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-c1-loc-"));
  outputs.add(out);
  const result = spawnSync(process.execPath, [script, "--repetitions", String(repetitions), "--out", out], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { ...result, evidence: JSON.parse(fs.readFileSync(path.join(out, "evidence/c1-localization.json"), "utf8")) };
}

describe("C1 localization experiment", () => {
  it("scores the baseline C1 actually names — an ordinary BANTAM run summary", () => {
    const { status, stdout, evidence } = run(2);
    assert.equal(status, 0, stdout);
    assert.equal(evidence.comparison.baselineScored, true);
    assert.match(evidence.comparison.baselineUsed, /BANTAM agent run summary/);
    // The baseline must actually have detected the defect, or the comparison is
    // against a control that did nothing.
    assert.equal(evidence.comparison.baseline.detectedTheDefect, evidence.comparison.baseline.readings);
  });

  it("shows instrumentation alone does not localize better than the summary", () => {
    const { evidence } = run(2);
    const { baseline, instrumented } = evidence.comparison;
    // The compatibility line maps the whole agent loop onto one station, so it
    // names where the defect was detected and still leaves every operation in
    // that station under suspicion. If this ever flips, the compatibility line
    // gained resolution and the claim should be restated, not the test relaxed.
    assert.equal(evidence.comparison.instrumentationAloneImprovesLocalization, false);
    assert.equal(instrumented.namedTheCreatingOperation, 0);
    assert.equal(baseline.namedTheCreatingOperation, 0);
  });

  it("shows decomposition does localize better, and names the planted operation", () => {
    const { evidence } = run(2);
    const { baseline, decomposed } = evidence.comparison;
    assert.equal(evidence.comparison.decompositionImprovesLocalization, true);
    assert.equal(decomposed.namedTheCreatingOperation, decomposed.readings);
    assert.equal(decomposed.meanImplicatedOperations, 1);
    assert.ok(decomposed.meanImplicatedOperations < baseline.meanImplicatedOperations);
    // Detected mid-route rather than at the end of the run.
    assert.match(decomposed.detectionPoint, /operation 3 of 4/);
    assert.equal(baseline.detectionPoint, "end-of-run");
  });

  it("is the single authority for the C1 evidence file", () => {
    // Two scripts once wrote c1-localization.json, so whichever ran last decided
    // whether a rung was earned. The decomposition experiment must not write it.
    const other = fs.readFileSync(path.join(repositoryRoot, "scripts/decomposition-experiment.mjs"), "utf8");
    assert.ok(!other.includes('write("c1-localization.json"'), "decomposition-experiment must not write the C1 evidence");
    assert.ok(!other.includes('write("c1-defect-corpus.json"'), "decomposition-experiment must not write the C1 corpus");
  });
});
