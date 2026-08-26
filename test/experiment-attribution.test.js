import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatExperimentSummary,
  hashJson,
  normalizeExperimentSpec,
  summarizeExperiment,
} from "../src/experiment.js";
import {
  EvidenceError,
  fixtureRunMatchesSpec,
  validatePromotionEvidence,
  validatePromotionAttribution,
} from "../src/promotion-evidence.js";

test("promotion fixture identity accepts resolved catalog paths without weakening names", () => {
  assert.equal(
    fixtureRunMatchesSpec("adapter-migration", "gauntlet/fixtures/adapter-migration"),
    true,
  );
  assert.equal(fixtureRunMatchesSpec("adapter-migration", "adapter-migration"), true);
  assert.equal(fixtureRunMatchesSpec("other", "gauntlet/fixtures/adapter-migration"), false);
  assert.equal(fixtureRunMatchesSpec("adapter-migration", "gauntlet/fixtures/other"), false);
});

function manifest(rejections) {
  return {
    id: "causal-attribution",
    name: "causal-attribution",
    status: "complete",
    specSha256: "abc123",
    spec: {
      rounds: 1,
      fixtures: ["toggle"],
      passAtK: [1],
      arms: [
        {
          name: "control",
          env: { BANTAM_PREVIEW_GATE: "0" },
          model: {},
        },
        {
          name: "treatment",
          env: { BANTAM_PREVIEW_GATE: "1" },
          model: {},
        },
      ],
    },
    schedule: [
      {
        arm: "control",
        round: 1,
        status: "complete",
        durationMs: 1,
        runs: [{
          name: "toggle",
          status: "contract-fail",
          contractStatus: "fail",
          contractTests: 1,
          contractPassed: 0,
          artifactPath: "runs/control/toggle.json",
          gateRejections: {},
        }],
      },
      {
        arm: "treatment",
        round: 1,
        status: "complete",
        durationMs: 1,
        runs: [{
          name: "toggle",
          status: "pass",
          gateRejections: rejections ? { preview: rejections } : {},
        }],
      },
    ],
  };
}

function visualManifest({ hints = 1, revisions = 0 } = {}) {
  const input = manifest(0);
  input.spec.arms[0].env = { BANTAM_VISUAL_COMPLETION_AUDIT: "0" };
  input.spec.arms[1].env = { BANTAM_VISUAL_COMPLETION_AUDIT: "1" };
  input.schedule[1].runs[0].visualCompletionAuditHints = hints;
  input.schedule[1].runs[0].visualCompletionAuditRevisions = revisions;
  return input;
}

function visualCoverageManifest({ hints = 1, revisions = 0 } = {}) {
  const input = manifest(0);
  input.spec.arms[0].env = { BANTAM_VISUAL_ALT_COVERAGE: "0" };
  input.spec.arms[1].env = { BANTAM_VISUAL_ALT_COVERAGE: "1" };
  input.schedule[1].runs[0].visualAltCoverageHints = hints;
  input.schedule[1].runs[0].visualAltCoverageRevisions = revisions;
  return input;
}

test("experiment summary marks inactive opt-in mechanisms as non-attributable", () => {
  const summary = formatExperimentSummary(manifest(0));
  assert.match(summary, /## Gate interventions/);
  assert.match(summary, /\| treatment \| preview \| 0 \|/);
  assert.match(summary, /## Attribution warnings/);
  assert.match(summary, /quality and efficiency deltas are non-attributable/);
  assert.match(summary, /## Failure evidence/);
  assert.match(
    summary,
    /\| control \| 1 \| toggle \| contract-fail \| fail \(0\/1 passed\) \| \[open\]\(runs\/control\/toggle\.json\) \|/,
  );
});

test("experiment summary aggregates real gate interventions without an inactivity warning", () => {
  const input = manifest(2);
  const totals = summarizeExperiment(input);
  assert.equal(totals.arms.treatment.gateRejections.preview, 2);

  const summary = formatExperimentSummary(input);
  assert.match(summary, /\| treatment \| preview \| 2 \|/);
  assert.doesNotMatch(summary, /## Attribution warnings/);
});

test("promotion rejects a candidate whose opt-in mechanism never intervened", () => {
  const input = manifest(0);
  const totals = summarizeExperiment(input);
  assert.throws(
    () => validatePromotionAttribution(input.spec, totals, "treatment"),
    (error) => error instanceof EvidenceError && /zero interventions.*non-attributable/.test(error.message),
  );
});

test("promotion accepts attributable gate evidence and returns its intervention count", () => {
  const input = manifest(2);
  const totals = summarizeExperiment(input);
  assert.deepEqual(
    validatePromotionAttribution(input.spec, totals, "treatment"),
    [{ env: "BANTAM_PREVIEW_GATE", gate: "preview", rejections: 2 }],
  );
});

test("visual audit attribution requires an observed post-audit alt revision", () => {
  const inactive = visualManifest({ hints: 2, revisions: 0 });
  const inactiveTotals = summarizeExperiment(inactive);
  assert.match(
    formatExperimentSummary(inactive),
    /Visual completion audit interventions \(hints \/ alt revisions\): control 0 \/ 0 · treatment 2 \/ 0/,
  );
  assert.match(formatExperimentSummary(inactive), /quality and efficiency deltas are non-attributable/);
  assert.throws(
    () => validatePromotionAttribution(inactive.spec, inactiveTotals, "treatment"),
    /zero interventions.*non-attributable/,
  );

  const active = visualManifest({ hints: 2, revisions: 1 });
  assert.deepEqual(
    validatePromotionAttribution(active.spec, summarizeExperiment(active), "treatment"),
    [{
      env: "BANTAM_VISUAL_COMPLETION_AUDIT",
      gate: "visual_completion_audit",
      rejections: 1,
    }],
  );
});

test("visual coverage attribution requires an observed post-hint alt revision", () => {
  const inactive = visualCoverageManifest({ hints: 1, revisions: 0 });
  assert.match(
    formatExperimentSummary(inactive),
    /Visual alt coverage interventions \(hints \/ alt revisions\): control 0 \/ 0 · treatment 1 \/ 0/,
  );
  assert.match(formatExperimentSummary(inactive), /quality and efficiency deltas are non-attributable/);
  assert.throws(
    () => validatePromotionAttribution(
      inactive.spec,
      summarizeExperiment(inactive),
      "treatment",
    ),
    /zero interventions.*non-attributable/,
  );

  const active = visualCoverageManifest({ hints: 1, revisions: 1 });
  assert.deepEqual(
    validatePromotionAttribution(active.spec, summarizeExperiment(active), "treatment"),
    [{
      env: "BANTAM_VISUAL_ALT_COVERAGE",
      gate: "visual_alt_coverage",
      rejections: 1,
    }],
  );
});

test("promotion backfills gate totals only for legacy schedules", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-legacy-attribution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = normalizeExperimentSpec({
    schema: 1,
    name: "legacy",
    fixtures: ["toggle"],
    rounds: 1,
    arms: [{ name: "control" }, { name: "treatment" }],
  });
  const schedule = [
    {
      sequence: 0,
      round: 1,
      arm: "control",
      seed: null,
      status: "complete",
      durationMs: 1,
      runs: [{ name: "toggle", status: "pass" }],
    },
    {
      sequence: 1,
      round: 1,
      arm: "treatment",
      seed: null,
      status: "complete",
      durationMs: 1,
      runs: [{ name: "toggle", status: "pass" }],
    },
  ];
  const manifest = {
    schema: 1,
    kind: "bantam-experiment",
    id: "legacy",
    status: "complete",
    spec,
    specSha256: hashJson(spec),
    schedule,
    candidateVersionRef: `sha256:${"a".repeat(64)}`,
    workspaceTree: "b".repeat(40),
  };
  manifest.totals = summarizeExperiment(manifest);
  for (const totals of Object.values(manifest.totals.arms)) delete totals.gateRejections;
  fs.writeFileSync(path.join(root, "spec.json"), `${JSON.stringify(spec)}\n`);
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);

  const evidence = validatePromotionEvidence(root, {
    candidateVersionRef: manifest.candidateVersionRef,
    workspaceTree: manifest.workspaceTree,
  });
  assert.equal(evidence.candidate, "treatment");

  for (const entry of manifest.schedule) {
    for (const row of entry.runs) row.gateRejections = {};
  }
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () => validatePromotionEvidence(root, {
      candidateVersionRef: manifest.candidateVersionRef,
      workspaceTree: manifest.workspaceTree,
    }),
    /totals do not match/,
  );
});
