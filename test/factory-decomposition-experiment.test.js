import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repositoryRoot, "scripts/decomposition-experiment.mjs");
const outputs = new Set();

afterEach(() => {
  for (const directory of outputs) fs.rmSync(directory, { recursive: true, force: true });
  outputs.clear();
});

function run(repetitions = 2) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-decomp-"));
  outputs.add(out);
  const result = spawnSync(process.execPath, [script, "--repetitions", String(repetitions), "--out", out], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, "evidence", name), "utf8"));
  return { ...result, evidence: read("decomposition.json"), read };
}

describe("decomposition experiment", () => {
  it("runs both arms over every planted defect and exits zero", () => {
    const { status, stdout, evidence } = run(2);
    assert.equal(status, 0, stdout);
    // Four obligations, one planted defect each, in separate articles.
    assert.deepEqual(evidence.interfaces.names, ["normalize", "checksum", "index", "render"]);
    assert.equal(evidence.interfaces.uncovered, 0);
    assert.equal(evidence.summary.monolith.defectiveArticles, 8);
    assert.equal(evidence.summary.decomposed.defectiveArticles, 8);
  });

  it("shows decomposition's advantage is locus and waste, not detection rate", () => {
    const { evidence } = run(2);
    const { monolith, decomposed } = evidence.summary;

    // The control is not weakened: its end gauge re-derives the whole product,
    // so it catches everything the decomposed line catches.
    assert.equal(monolith.escaped, 0);
    assert.equal(decomposed.escaped, 0);
    assert.equal(monolith.detected, decomposed.detected);

    // The advantage is precision: the monolith implicates all four obligations,
    // the decomposed line names one.
    assert.equal(monolith.meanImplicatedOperations, 4);
    assert.equal(decomposed.meanImplicatedOperations, 1);
    assert.equal(evidence.localization.correctLocus, evidence.localization.articles);
    assert.equal(evidence.localization.falseLocus, 0);

    // And waste: work downstream of the defect runs in the monolith and does not
    // run in the decomposed line.
    assert.ok(monolith.meanOperationsOnSuspectMaterial > 0);
    assert.equal(decomposed.meanOperationsOnSuspectMaterial, 0);
  });

  it("keeps clean work moving through both arms without a false stop", () => {
    // The clean control is what caught the original gauge defect: material is
    // canonicalized in transit, so a gauge comparing serializations false-stops
    // every clean article. If either number moves off zero, look at the gauge
    // before believing the arm.
    const { evidence } = run(2);
    assert.equal(evidence.summary.monolith.falseStops, 0);
    assert.equal(evidence.summary.decomposed.falseStops, 0);
  });

  it("no longer writes the C1 evidence, having handed that comparison over", () => {
    const { read } = run(2);
    // This experiment's baseline is a monolithic FACTORY arm, not the BANTAM run
    // summary C1's bullet names. It used to emit c1-localization.json with
    // baselineScored:false to record the gap honestly. That gap is now closed by
    // scripts/c1-localization-experiment.mjs against the real agent loop, and two
    // scripts writing one evidence file meant whichever ran last decided whether
    // a rung was earned.
    assert.throws(() => read("c1-localization.json"), /ENOENT/);
    assert.throws(() => read("c1-defect-corpus.json"), /ENOENT/);
    // What it does still own is the C4 interface controls.
    const controls = read("c4-interface-controls.json");
    assert.equal(controls.interfaces.uncovered, 0);
  });
});
