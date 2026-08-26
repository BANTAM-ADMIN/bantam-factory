import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repositoryRoot, "scripts/c2-containment-experiment.mjs");
const outputs = new Set();

afterEach(() => {
  for (const directory of outputs) fs.rmSync(directory, { recursive: true, force: true });
  outputs.clear();
});

// The experiment is the C2 evidence, so it has to be repeatable on demand rather
// than a result someone once observed. Three repetitions is enough to prove every
// arm behaves; the recorded evidence is produced at twenty.
function run(repetitions = 3) {
  // Its own output directory, so verifying the experiment can never replace the
  // recorded twenty-article evidence with a three-article one.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-c2-"));
  outputs.add(out);
  const result = spawnSync(process.execPath, [script, "--repetitions", String(repetitions), "--out", out], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, "evidence", name), "utf8"));
  return { ...result, evidence: read("c2-containment.json"), cost: read("c2-containment-cost.json") };
}

describe("C2 containment experiment", () => {
  it("demonstrates the four arms and exits zero", () => {
    const { status, stdout, evidence } = run(3);
    assert.equal(status, 0, stdout);

    // The contrast the C2 claim rests on: same defect, same route, one gauge.
    assert.equal(evidence.plantedDefect.escapedControlRoute, true);
    assert.equal(evidence.plantedDefect.escapesInControl, 3);
    assert.equal(evidence.plantedDefect.stoppedByGauge, true);
    assert.equal(evidence.plantedDefect.stopsInTreatment, 3);

    // Containment means the suspect product was never consumed, not merely that
    // somebody logged a failure.
    assert.equal(evidence.plantedDefect.downstreamConsumers, 0);

    // A gauge that stops clean work has not prevented anything.
    assert.equal(evidence.cleanControl.falseStops, 0);
    assert.equal(evidence.cleanControl.released, 3);
  });

  it("reports the gauge's blind spot instead of only its successes", () => {
    const { evidence } = run(3);
    // A key-set gauge cannot see value corruption. If this ever reads 0, either
    // the gauge grew a capability nobody documented or the arm stopped testing
    // what it claims to test — both need looking at, not updating.
    assert.equal(evidence.coverage.uncoveredDefectEscapes, 3);
    assert.match(evidence.coverage.gaugeDoesNotCover, /preserves the key set/);
  });

  it("cites sources that exist, as the claim ledger requires of a measurement", () => {
    const { evidence } = run(3);
    assert.ok(Array.isArray(evidence.sources) && evidence.sources.length > 0);
    for (const source of evidence.sources) {
      assert.ok(fs.existsSync(path.join(repositoryRoot, source)), `missing cited source ${source}`);
    }
    const { cost } = run(3);
    assert.equal(typeof cost.prevention.totalCost, "number");
    for (const source of cost.sources) {
      assert.ok(fs.existsSync(path.join(repositoryRoot, source)), `missing cited source ${source}`);
    }
  });
});
