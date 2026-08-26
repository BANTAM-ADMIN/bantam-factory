import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatReplayMine,
  loadReplayCoverage,
  mineReplayCohorts,
  selectReplayFailureMode,
} from "../src/replay-mine.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runArtifact({
  task,
  pass,
  status,
  model = "gpt-5.6-terra",
  experimentId = "test-experiment",
  experimentArm = "control",
  fixtureProvenance,
}) {
  return {
    schema: 2,
    kind: "bantam-run",
    runId: `${pass ? "pass" : "fail"}-${model}`,
    task,
    experiment: experimentId
      ? { id: experimentId, name: experimentId, arm: experimentArm, round: 1 }
      : null,
    ...(fixtureProvenance ? { fixtureProvenance } : {}),
    model: { metadata: { model } },
    result: {
      pass,
      status,
      contract: pass
        ? { pass: true, detail: "" }
        : { pass: false, detail: "AssertionError\nThe input did not match the required contract." },
    },
    turns: [{
      i: 0,
      modelCallIndex: 0,
      parsedAction: { a: "done", summary: "done" },
    }],
    modelCalls: [{
      index: 0,
      request: {
        url: "codex-app-server://thread",
        body: JSON.stringify({ prompt: "recorded prompt" }),
      },
    }],
  };
}

function fixtureProvenance(seed) {
  const component = (name) => sha256(Buffer.from(`${seed}:${name}`));
  const value = {
    schema: 1,
    taskSpecSha256: component("task"),
    repoTreeSha256: component("repo"),
    graderTreeSha256: component("grader"),
  };
  value.evaluatorSha256 = sha256(Buffer.from([
    "bantam-fixture-evaluator-v1",
    value.taskSpecSha256,
    value.repoTreeSha256,
    value.graderTreeSha256,
  ].join("\0")));
  return value;
}

test("replay miner returns only exact-task mixed outcomes with replayable failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-mine-"));
  try {
    const write = (name, value) =>
      fs.writeFileSync(path.join(tempDir, name), JSON.stringify(value));
    write("failure.json", runArtifact({
      task: "Fix the exact task.",
      pass: false,
      status: "contract-fail",
    }));
    write("reference.json", runArtifact({
      task: "Fix the exact task.",
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    }));
    write("task-drift.json", runArtifact({
      task: "Fix the exact task, plus one changed requirement.",
      pass: true,
      status: "pass",
    }));
    write("unverified.json", runArtifact({
      task: "Another task.",
      pass: false,
      status: "unverified",
    }));
    fs.writeFileSync(path.join(tempDir, "malformed.json"), "{");

    const report = mineReplayCohorts({ roots: [tempDir] });
    assert.equal(report.status, "witness-only");
    assert.match(report.studyEvidenceBoundary, /audit-replay/);
    assert.match(report.rankingBoundary, /not causal/i);
    assert.match(report.failureModeBoundary, /every artifact remains/i);
    assert.equal(report.cohorts.length, 1);
    assert.equal(report.cohorts[0].replayableFailures.length, 1);
    assert.deepEqual(report.cohorts[0].replayableFailures[0].candidateReplayTurns, [0]);
    assert.equal(report.candidateReplayTurns, 1);
    assert.equal(report.priorStudyTurnsExcluded, 0);
    assert.equal(report.cohorts[0].references.length, 1);
    assert.equal(report.cohorts[0].references[0].model, "gpt-5.6-sol");
    assert.match(report.cohorts[0].replayableFailures[0].failureSummary, /input did not match/);
    assert.equal(report.ignored.malformed, 1);
    assert.match(formatReplayMine(report), /do not identify a causal remedy/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner bounds evidence separately from irrelevant corpus JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-scale-"));
  try {
    for (let index = 0; index < 8; index++) {
      fs.writeFileSync(
        path.join(tempDir, `config-${index}.json`),
        JSON.stringify({ name: `copied package ${index}` }),
      );
    }
    fs.writeFileSync(path.join(tempDir, "failure.json"), JSON.stringify(runArtifact({
      task: "Fix the exact scalable task.",
      pass: false,
      status: "contract-fail",
    })));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task: "Fix the exact scalable task.",
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));

    const report = mineReplayCohorts({
      roots: [tempDir],
      maxFiles: 2,
      maxScanFiles: 10,
    });
    assert.equal(report.scannedJsonFiles, 10);
    assert.equal(report.evidenceJsonFiles, 2);
    assert.equal(report.runArtifacts, 2);
    assert.equal(report.ignored.nonRun, 8);
    assert.equal(report.cohorts.length, 1);

    fs.writeFileSync(path.join(tempDir, "third-run.json"), JSON.stringify(runArtifact({
      task: "Another task.",
      pass: true,
      status: "pass",
    })));
    assert.throws(
      () => mineReplayCohorts({
        roots: [tempDir],
        maxFiles: 2,
        maxScanFiles: 11,
      }),
      /2-evidence-file bound/i,
    );
    assert.throws(
      () => mineReplayCohorts({
        roots: [tempDir],
        maxFiles: 20,
        maxScanFiles: 10,
      }),
      /10-JSON scan bound/i,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner does not mix runs graded by different evaluator identities", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-evaluator-"));
  try {
    const write = (name, value) =>
      fs.writeFileSync(path.join(tempDir, name), JSON.stringify(value));
    write("legacy-failure.json", runArtifact({
      task: "Implement the exact browser contract.",
      pass: false,
      status: "contract-fail",
      experimentId: "legacy-before-grader-change",
    }));
    write("legacy-reference.json", runArtifact({
      task: "Implement the exact browser contract.",
      pass: true,
      status: "pass",
      experimentId: "legacy-after-grader-change",
    }));
    assert.equal(mineReplayCohorts({ roots: [tempDir] }).cohorts.length, 0);

    const provenance = fixtureProvenance("same-fixture");
    write("captured-failure.json", runArtifact({
      task: "Implement a captured fixture contract.",
      pass: false,
      status: "contract-fail",
      experimentId: "captured-one",
      fixtureProvenance: provenance,
    }));
    write("captured-reference.json", runArtifact({
      task: "Implement a captured fixture contract.",
      pass: true,
      status: "pass",
      experimentId: "captured-two",
      fixtureProvenance: provenance,
    }));
    const report = mineReplayCohorts({ roots: [tempDir] });
    assert.equal(report.cohorts.length, 1);
    assert.equal(report.cohorts[0].evaluatorIdentity.status, "captured-fixture");
    assert.equal(report.cohorts[0].evaluatorIdentity.sha256, provenance.evaluatorSha256);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner identifies and optionally excludes completed cross-arm contrasts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-contrast-"));
  try {
    fs.writeFileSync(path.join(tempDir, "failure.json"), JSON.stringify(runArtifact({
      task: "Extract exact visual facts.",
      pass: false,
      status: "contract-fail",
      experimentId: "pixel-facts-ab",
      experimentArm: "semantic-only",
    })));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task: "Extract exact visual facts.",
      pass: true,
      status: "pass",
      experimentId: "pixel-facts-ab",
      experimentArm: "pixel-facts",
    })));

    const report = mineReplayCohorts({ roots: [tempDir], untreatedOnly: true });
    assert.equal(report.cohorts.length, 1);
    assert.equal(report.crossArmExperimentContrasts, 1);
    assert.match(report.experimentContrastBoundary, /does not.*prove/i);
    assert.deepEqual(report.cohorts[0].experimentContrasts, [{
      id: "pixel-facts-ab",
      name: "pixel-facts-ab",
      failingArms: ["semantic-only"],
      passingArms: ["pixel-facts"],
      failureRuns: 1,
      passingRuns: 1,
    }]);
    assert.match(formatReplayMine(report), /CONTRAST pixel-facts-ab/);

    const novel = mineReplayCohorts({
      roots: [tempDir],
      untreatedOnly: true,
      uncontrastedOnly: true,
    });
    assert.equal(novel.filter, "untreated-only+uncontrasted");
    assert.equal(novel.cohorts.length, 0);
    assert.equal(novel.excludedCrossArmContrastedCohorts, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner identifies only exact hash-and-turn prior studies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-study-mine-"));
  try {
    const failurePath = path.join(tempDir, "failure.json");
    fs.writeFileSync(failurePath, JSON.stringify(runArtifact({
      task: "Repair this studied task.",
      pass: false,
      status: "contract-fail",
    })));
    const failureSha256 = sha256(fs.readFileSync(failurePath));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task: "Repair this studied task.",
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));
    const study = ({ name, sourceSha256, turn, status = "complete", verdict = "supported" }) => ({
      schema: 1,
      kind: "bantam-replay-experiment",
      name,
      status,
      spec: { samples: 1, turn },
      artifact: { sha256: sourceSha256, turn },
      pairs: [{ sample: 0 }],
      totals: { samples: 1, verdict },
    });
    fs.writeFileSync(path.join(tempDir, "exact-study.json"), JSON.stringify(study({
      name: "exact prior study",
      sourceSha256: failureSha256,
      turn: 0,
    })));
    fs.writeFileSync(path.join(tempDir, "wrong-turn.json"), JSON.stringify(study({
      name: "wrong turn",
      sourceSha256: failureSha256,
      turn: 1,
    })));
    fs.writeFileSync(path.join(tempDir, "wrong-hash.json"), JSON.stringify(study({
      name: "wrong artifact",
      sourceSha256: "a".repeat(64),
      turn: 0,
    })));
    fs.writeFileSync(path.join(tempDir, "incomplete.json"), JSON.stringify(study({
      name: "incomplete",
      sourceSha256: failureSha256,
      turn: 0,
      status: "running",
    })));

    const report = mineReplayCohorts({ roots: [tempDir] });
    assert.equal(report.replayStudyArtifacts, 3);
    assert.equal(report.indexedArtifactTurns, 3);
    assert.equal(report.duplicateReplayStudyArtifacts, 0);
    assert.equal(report.ignored.invalidStudy, 1);
    const failure = report.cohorts[0].replayableFailures[0];
    assert.deepEqual(failure.studiedReplayableTurns, [0]);
    assert.deepEqual(failure.attemptedReplayableTurns, []);
    assert.deepEqual(failure.untreatedReplayableTurns, []);
    assert.equal(failure.replayableTurnEvidence[0].studies.length, 1);
    assert.equal(failure.replayableTurnEvidence[0].studies[0].name, "exact prior study");

    fs.writeFileSync(path.join(tempDir, "exact-study.json"), JSON.stringify(study({
      name: "exact attempted study",
      sourceSha256: failureSha256,
      turn: 0,
      status: "complete_with_errors",
      verdict: "inconclusive",
    })));
    const attemptedReport = mineReplayCohorts({ roots: [tempDir] });
    const attemptedFailure = attemptedReport.cohorts[0].replayableFailures[0];
    assert.deepEqual(attemptedFailure.studiedReplayableTurns, []);
    assert.deepEqual(attemptedFailure.attemptedReplayableTurns, [0]);
    assert.deepEqual(attemptedFailure.untreatedReplayableTurns, []);

    const untreated = mineReplayCohorts({ roots: [tempDir], untreatedOnly: true });
    assert.equal(untreated.filter, "untreated-only");
    assert.equal(untreated.cohorts.length, 0);
    assert.equal(untreated.candidateReplayTurns, 0);
    assert.equal(untreated.priorStudyTurnsExcluded, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner can exclude SHA-pinned failures with explicit current coverage evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-coverage-"));
  try {
    const failurePath = path.join(tempDir, "failure.json");
    fs.writeFileSync(failurePath, JSON.stringify(runArtifact({
      task: "Repair a historically covered failure.",
      pass: false,
      status: "contract-fail",
    })));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task: "Repair a historically covered failure.",
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));
    const artifactSha256 = sha256(fs.readFileSync(failurePath));
    const registryPath = path.join(tempDir, "coverage.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      schema: 1,
      kind: "bantam-replay-coverage",
      failures: [{
        artifactSha256,
        mechanism: "forced continuation after premature response",
        evidence: ["test/agent.test.js"],
      }],
    }));
    const coverage = loadReplayCoverage(registryPath);
    const visible = mineReplayCohorts({ roots: [tempDir], coverage });
    assert.equal(visible.cohorts.length, 1);
    assert.equal(visible.declaredCoveredFailures, 1);
    assert.equal(
      visible.cohorts[0].replayableFailures[0].declaredCoverage.mechanism,
      "forced continuation after premature response",
    );
    assert.match(formatReplayMine(visible), /Declared covered failures 1/);

    const uncovered = mineReplayCohorts({
      roots: [tempDir],
      coverage,
      uncoveredOnly: true,
    });
    assert.equal(uncovered.filter, "uncovered");
    assert.equal(uncovered.cohorts.length, 0);
    assert.equal(uncovered.replayableFailures, 0);
    assert.equal(uncovered.declaredCoveredFailures, 1);
    assert.match(uncovered.declaredCoverageBoundary, /does not prove/i);

    assert.throws(
      () => mineReplayCohorts({
        roots: [tempDir],
        coverage: [{
          artifactSha256,
          mechanism: "",
          evidence: ["test/agent.test.js"],
        }],
      }),
      /mechanism is required/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner transparently prioritizes the decision after a task-relevant edit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-rank-"));
  try {
    const task = "Build index.html and styles.css from the supplied image.";
    const failure = runArtifact({ task, pass: false, status: "contract-fail" });
    failure.turns = [
      {
        i: 0,
        modelCallIndex: 0,
        parsedAction: { a: "query", q: "view_image assets/source.png" },
        observation: "visible image evidence",
      },
      {
        i: 1,
        modelCallIndex: 1,
        parsedAction: { a: "write_file", p: "index.html", content: "incomplete page" },
        observation: "wrote index.html",
      },
      {
        i: 2,
        modelCallIndex: 2,
        parsedAction: { a: "write_file", p: "styles.css", content: "styles" },
        observation: "wrote styles.css",
      },
      {
        i: 3,
        modelCallIndex: 3,
        parsedAction: { a: "shell", c: "npm test" },
        observation: "VERDICT: 1 of 1 tests FAILED",
      },
      {
        i: 4,
        modelCallIndex: 4,
        parsedAction: { a: "replace", p: "index.html", old: "a", new: "b" },
        observation: "replaced index.html",
      },
      {
        i: 5,
        modelCallIndex: 5,
        parsedAction: { a: "done", summary: "done" },
        observation: "",
      },
    ];
    failure.modelCalls = failure.turns.map((turn) => ({
      index: turn.modelCallIndex,
      request: {
        url: "codex-app-server://thread",
        body: JSON.stringify({ prompt: `turn ${turn.i}` }),
      },
    }));
    fs.writeFileSync(path.join(tempDir, "failure.json"), JSON.stringify(failure));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task,
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));

    const report = mineReplayCohorts({ roots: [tempDir] });
    const ranked = report.cohorts[0].replayableFailures[0].priorityReplayTurns;
    assert.equal(ranked[0].turn, 2);
    assert.match(ranked[0].reasons.join("\n"), /immediately preceding.*index\.html/i);
    assert.match(ranked[0].reasons.join("\n"), /original action edits task-named path styles\.css/i);
    assert.ok(ranked[0].score > ranked.at(-1).score);
    assert.equal(
      report.cohorts[0].replayableFailures[0].candidateReplayTurns.length,
      6,
      "ranking must not discard lower-priority turns",
    );
    assert.equal(report.priorityReplayTurns, 5);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner reports a run-level scope failure instead of a passing contract log", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-scope-summary-"));
  try {
    const task = "Fix src/example.js without editing tests.";
    const cheated = runArtifact({ task, pass: false, status: "cheated" });
    cheated.result.verifyDetail = "scope violation (test-tampering): modified test/example.test.js";
    cheated.result.contract = {
      pass: true,
      status: "pass",
      detail: "TAP version 13\n# tests 2\n# pass 2\n# fail 0",
    };
    fs.writeFileSync(path.join(tempDir, "failure.json"), JSON.stringify(cheated));
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task,
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));
    const report = mineReplayCohorts({ roots: [tempDir] });
    const summary = report.cohorts[0].replayableFailures[0].failureSummary;
    assert.match(summary, /scope violation.*test-tampering/i);
    assert.doesNotMatch(summary, /TAP version/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay miner clusters equivalent assertion locations without merging distinct failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-failure-modes-"));
  try {
    const task = "Extract exact visual facts.";
    const detail = ({ line, actual }) => `TAP version 13
# Subtest: extracts exact colors
not ok 1 - extracts exact colors
  ---
  location: '/tmp/work/grader/contract.test.cjs:${line}:10'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    + '${actual}'
    - '#37d6c0'
  code: 'ERR_ASSERTION'
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> (/tmp/work/grader/contract.test.cjs:${line}:10)
  ...`;
    const writeFailure = (name, line, actual, model) => {
      const artifact = runArtifact({
        task,
        pass: false,
        status: "contract-fail",
        model,
      });
      artifact.runId = name;
      artifact.result.contract.detail = detail({ line, actual });
      fs.writeFileSync(path.join(tempDir, `${name}.json`), JSON.stringify(artifact));
    };
    writeFailure("same-a", 15, "#3bd6c6", "gpt-5.6-terra");
    writeFailure("same-b", 15, "#3dd6c6", "gpt-5.6-sol");
    writeFailure("different-line", 28, "object", "gpt-5.6-terra");
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task,
      pass: true,
      status: "pass",
      model: "gpt-5.6-sol",
    })));

    const report = mineReplayCohorts({ roots: [tempDir] });
    const cohort = report.cohorts[0];
    assert.equal(cohort.replayableFailures.length, 3);
    assert.equal(cohort.failureModes.length, 2);
    assert.deepEqual(cohort.failureModes.map((mode) => mode.count).sort(), [1, 2]);
    assert.equal(cohort.representativeReplayFailures.length, 2);
    assert.equal(report.replayableFailures, 3);
    assert.equal(report.failureModes, 2);
    const text = formatReplayMine(report);
    assert.match(text, /3 failures · 2 failure modes/);
    assert.match(text, /MODE [a-f0-9]{12} ×2/);

    const repeated = cohort.failureModes.find((mode) => mode.count === 2);
    const selected = selectReplayFailureMode(report, repeated.sha256.slice(0, 12));
    assert.equal(selected.failureModeFilter, repeated.sha256);
    assert.equal(selected.cohorts.length, 1);
    assert.equal(selected.replayableFailures, 2);
    assert.equal(selected.failureModes, 1);
    assert.equal(selected.representativeReplayFailures, 1);
    assert.equal(selected.cohorts[0].replayableFailures.length, 2);
    assert.equal(selected.cohorts[0].references.length, 1);
    assert.throws(
      () => selectReplayFailureMode(report, "not-a-hash"),
      /8-64 character hexadecimal/i,
    );
    assert.throws(
      () => selectReplayFailureMode(report, "00000000"),
      /not found/i,
    );
    const ambiguous = structuredClone(report);
    ambiguous.cohorts[0].failureModes[0].sha256 = `deadbeef${"0".repeat(56)}`;
    ambiguous.cohorts[0].failureModes[1].sha256 = `deadbeef${"1".repeat(56)}`;
    assert.throws(
      () => selectReplayFailureMode(ambiguous, "deadbeef"),
      /ambiguous/i,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("replay-mine CLI is model-free in both launchers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-replay-mine-cli-"));
  try {
    for (let index = 0; index < 120; index++) {
      const artifact = runArtifact({
        task: "One task.",
        pass: false,
        status: "contract-fail",
      });
      artifact.runId = `failure-${index}`;
      if (index === 119) {
        artifact.result.contract.detail = "AssertionError\nA distinct terminal failure.";
      }
      fs.writeFileSync(
        path.join(tempDir, `failure-${String(index).padStart(3, "0")}.json`),
        JSON.stringify(artifact),
      );
    }
    fs.writeFileSync(path.join(tempDir, "reference.json"), JSON.stringify(runArtifact({
      task: "One task.",
      pass: true,
      status: "pass",
      experimentArm: "treatment",
    })));
    for (const launcher of ["bantam.js", "bantambuild.js"]) {
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, "bin", launcher), "replay-mine", tempDir, "--untreated", "--json"],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.cohorts.length, 1);
      assert.equal(parsed.cohorts[0].replayableFailures.length, 120);
      assert.equal(parsed.cohorts[0].failureModes.length, 2);
      assert.ok(result.stdout.length > 100_000, "fixture must exercise buffered stdout");
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /^model:/m);

      const largestMode = parsed.cohorts[0].failureModes
        .sort((left, right) => right.count - left.count)[0];
      const selected = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "bin", launcher),
          "replay-mine",
          tempDir,
          "--untreated",
          "--mode",
          largestMode.sha256.slice(0, 12),
          "--json",
        ],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      assert.equal(selected.status, 0, `${launcher}: ${selected.stderr}`);
      const selectedReport = JSON.parse(selected.stdout);
      assert.equal(selectedReport.failureModeFilter, largestMode.sha256);
      assert.equal(selectedReport.replayableFailures, 119);
      assert.equal(selectedReport.failureModes, 1);
      assert.ok(selected.stdout.length < result.stdout.length);
      assert.doesNotMatch(`${selected.stdout}\n${selected.stderr}`, /^model:/m);

      const uncontrasted = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "bin", launcher),
          "replay-mine",
          tempDir,
          "--untreated",
          "--uncontrasted",
          "--json",
        ],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      );
      assert.equal(uncontrasted.status, 0, `${launcher}: ${uncontrasted.stderr}`);
      const uncontrastedReport = JSON.parse(uncontrasted.stdout);
      assert.equal(uncontrastedReport.cohorts.length, 0);
      assert.equal(uncontrastedReport.excludedCrossArmContrastedCohorts, 1);
      assert.doesNotMatch(`${uncontrasted.stdout}\n${uncontrasted.stderr}`, /^model:/m);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
