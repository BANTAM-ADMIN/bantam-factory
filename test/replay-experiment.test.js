import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import { portableReplayArtifactPath } from "../src/replay-experiment-cli.js";
import { auditReplayExperimentEvidence } from "../src/replay-experiment-audit.js";
import {
  formatReplayExperimentSummary,
  normalizeActionExpectation,
  normalizeReplayExperimentSpec,
  replayExperimentVerdict,
  runReplayExperiment,
  scoreReplayOutput,
} from "../src/replay-experiment.js";

const expectation = {
  verbs: ["replace", "patch"],
  paths: ["index.html"],
  contentAny: ["moon", "bird"],
  contentAll: ["alt="],
  forbidAny: ["invented"],
};

test("archived replay specs rebase the source artifact without copying it", () => {
  const project = path.resolve("/tmp/bantam-portable-replay");
  assert.equal(
    portableReplayArtifactPath(
      path.join(project, ".bantam", "replay-experiments", "trial"),
      path.join(project, ".bantam", "runs", "source.json"),
    ),
    "../../runs/source.json",
  );
});

test("semantic replay scoring requires the expected edit path and grounded content", () => {
  assert.equal(scoreReplayOutput(JSON.stringify({
    a: "replace",
    p: "index.html",
    old: "alt=\"city\"",
    new: "alt=\"greenhouse beneath a crescent moon\"",
  }), expectation).pass, true);

  assert.equal(scoreReplayOutput(JSON.stringify({
    a: "patch",
    edits: [{ p: "styles.css", old: "a", new: "moon" }],
  }), expectation).pass, false);
  assert.equal(scoreReplayOutput('{"a":"shell","c":"npm test"}', expectation).pass, false);
  assert.equal(scoreReplayOutput("not json", expectation).action, null);
});

test("replay scoring supports verified done decisions without weakening edit expectations", () => {
  const doneExpectation = normalizeActionExpectation({
    verbs: ["done"],
    contentAll: ["verified", "tests"],
    forbidAny: ["unverified"],
  });
  assert.deepEqual(doneExpectation.paths, []);
  assert.equal(
    scoreReplayOutput(
      JSON.stringify({ a: "done", summary: "Implemented the fix; verified all tests." }),
      doneExpectation,
    ).pass,
    true,
  );
  const shell = scoreReplayOutput(
    JSON.stringify({ a: "shell", c: "npm test" }),
    doneExpectation,
  );
  assert.equal(shell.pass, false);
  assert.match(shell.reasons.join("\n"), /verb shell is not allowed/);

  assert.throws(
    () => normalizeActionExpectation({
      verbs: ["replace"],
      contentAny: ["fixed"],
    }),
    /paths must contain at least one path for edit verbs/,
  );
});

test("strict replay scoring rejects edits that could not apply to the recorded turn", () => {
  const strict = { ...expectation, requireOldInPrompt: true };
  const action = JSON.stringify({
    a: "replace",
    p: "index.html",
    old: "alt=\"city\"",
    new: "alt=\"city beneath a crescent moon\"",
  });
  assert.equal(
    scoreReplayOutput(action, strict, {
      prompt: '# index.html\n12\t<img alt="city">',
    }).pass,
    true,
  );
  const forged = JSON.stringify({
    a: "replace",
    p: "index.html",
    old: "THIS NEVER EXISTED",
    new: "alt=\"city beneath a crescent moon\"",
  });
  assert.equal(
    scoreReplayOutput(forged, strict, {
      prompt: '# index.html\n12\t<img alt="city">',
    }).pass,
    false,
  );
  assert.match(
    scoreReplayOutput(forged, strict, { prompt: "" }).reasons.join("\n"),
    /no changed old text found/,
  );
});

test("strict replay specs reject verbs that cannot carry an old-text anchor", () => {
  const strictDefault = normalizeReplayExperimentSpec({
    name: "strict default verbs",
    artifact: "run.json",
    turn: 0,
    remedy: "correct the grounded mismatch",
    expectation: {
      paths: ["index.html"],
      contentAny: ["fixed"],
      requireOldInPrompt: true,
    },
  });
  assert.deepEqual(strictDefault.expectation.verbs, ["replace", "patch"]);
  for (const verb of ["write_file", "edit_lines"]) {
    assert.throws(
      () => normalizeReplayExperimentSpec({
        name: `invalid strict ${verb}`,
        artifact: "run.json",
        turn: 0,
        remedy: "correct the grounded mismatch",
        expectation: {
          verbs: ["replace", verb],
          paths: ["index.html"],
          contentAny: ["fixed"],
          requireOldInPrompt: true,
        },
      }),
      /cannot be satisfied.*old-text anchor/i,
    );
  }
});

test("replay experiment uses paired derived seeds and reports all-sample semantic lift", async () => {
  const requestBody = JSON.stringify({ prompt: "recorded prompt", seed: 42 });
  const artifact = {
    runId: "moonroot-failure",
    turns: [{
      modelCallIndex: 0,
      parsedAction: { a: "shell", c: "npm test" },
      rawOutput: '{"a":"shell","c":"npm test"}',
      observation: "",
    }],
    modelCalls: [{
      index: 0,
      request: { url: "http://localhost/completion", body: requestBody },
    }],
  };
  const spec = {
    name: "moonroot-replay",
    artifact: "failure.json",
    turn: 0,
    samples: 3,
    remedy: "Recheck the saved image evidence.",
    expectation,
  };
  const calls = [];
  const evidence = await runReplayExperiment({
    spec,
    artifact,
    now: () => "2026-07-29T00:00:00.000Z",
    ask: async (_replay, { arm, sample }) => {
      calls.push(`${sample}:${arm}`);
      return arm === "baseline"
        ? '{"a":"shell","c":"npm test"}'
        : JSON.stringify({
          a: "replace",
          p: "index.html",
          old: "alt=\"city\"",
          new: "alt=\"greenhouse beneath a crescent moon\"",
        });
    },
  });

  assert.deepEqual(calls, [
    "0:baseline", "0:candidate",
    "1:candidate", "1:baseline",
    "2:baseline", "2:candidate",
  ]);
  assert.deepEqual(evidence.pairs.map((pair) => pair.order), [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ]);
  assert.deepEqual(evidence.pairs.map((pair) => pair.seed), [42, 43, 44]);
  assert.equal(evidence.totals.baselinePasses, 0);
  assert.equal(evidence.totals.candidatePasses, 3);
  assert.equal(evidence.totals.pairing, "seed-paired");
  assert.equal(evidence.totals.orderBalance, "best-possible");
  assert.equal(evidence.totals.verdict, "supported");
  assert.match(formatReplayExperimentSummary(evidence), /candidate 3\/3/);
});

test("unseeded replay evidence counterbalances baseline and candidate call position", async () => {
  const artifact = {
    turns: [{
      modelCallIndex: 0,
      parsedAction: { a: "shell", c: "npm test" },
      rawOutput: '{"a":"shell","c":"npm test"}',
      observation: "",
    }],
    modelCalls: [{
      index: 0,
      request: {
        url: "codex-app-server://thread",
        body: JSON.stringify({ prompt: "recorded prompt" }),
      },
    }],
  };
  const calls = [];
  const artifactBytes = Buffer.from(JSON.stringify(artifact));
  let clockTick = 0;
  const evidence = await runReplayExperiment({
    spec: {
      name: "unseeded-order",
      artifact: "failure.json",
      turn: 0,
      samples: 2,
      remedy: "Recheck the evidence.",
      expectation,
    },
    artifact,
    artifactSha256: crypto.createHash("sha256").update(artifactBytes).digest("hex"),
    clock: () => {
      clockTick += 10;
      return clockTick;
    },
    ask: async (_replay, { arm, sample }) => {
      calls.push(`${sample}:${arm}`);
      return {
        content: '{"a":"shell","c":"npm test"}',
        usage: {
          provider: "codex",
          model: "gpt-5.6-terra",
          requests: 1,
          inputTokens: arm === "baseline" ? 100 : 120,
          outputTokens: arm === "baseline" ? 10 : 12,
          totalTokens: arm === "baseline" ? 110 : 132,
          cacheHitTokens: 40,
          cacheMissTokens: arm === "baseline" ? 60 : 80,
          reasoningTokens: arm === "baseline" ? 2 : 3,
          costUsd: 0,
          codexRequests: 1,
        },
      };
    },
  });
  assert.deepEqual(calls, [
    "0:baseline", "0:candidate",
    "1:candidate", "1:baseline",
  ]);
  assert.equal(evidence.totals.pairing, "counterbalanced-unseeded");
  assert.equal(evidence.totals.orderBalance, "exact");
  assert.deepEqual(evidence.totals.efficiency, {
    baseline: {
      durationMs: 20,
      usage: {
        requests: 2,
        inputTokens: 200,
        outputTokens: 20,
        totalTokens: 220,
        cacheHitTokens: 80,
        cacheMissTokens: 120,
        reasoningTokens: 4,
        costUsd: 0,
        codexRequests: 2,
      },
    },
    candidate: {
      durationMs: 20,
      usage: {
        requests: 2,
        inputTokens: 240,
        outputTokens: 24,
        totalTokens: 264,
        cacheHitTokens: 80,
        cacheMissTokens: 160,
        reasoningTokens: 6,
        costUsd: 0,
        codexRequests: 2,
      },
    },
    providerReportedCalls: 4,
    unreportedCalls: 0,
  });
  assert.equal(
    auditReplayExperimentEvidence(evidence, { artifactBytes }).status,
    "pass",
  );
  assert.equal(evidence.integrity.armReceipts, "sha256-v1");
  assert.match(evidence.pairs[0].baseline.receiptSha256, /^[a-f0-9]{64}$/);

  const coherentlyTampered = structuredClone(evidence);
  coherentlyTampered.pairs[0].candidate.usage.inputTokens++;
  coherentlyTampered.totals.efficiency.candidate.usage.inputTokens++;
  const receiptAudit = auditReplayExperimentEvidence(coherentlyTampered, { artifactBytes });
  assert.equal(receiptAudit.status, "fail");
  assert.match(receiptAudit.failures.join("\n"), /receipt SHA-256/);

  const resealedRequest = structuredClone(evidence);
  resealedRequest.pairs[0].candidate.requestBodySha256 = "0".repeat(64);
  resealedRequest.pairs[0].candidate.receiptSha256 = testArmReceiptSha256(
    resealedRequest.pairs[0].candidate,
    { arm: "candidate", sample: 0 },
  );
  const requestAudit = auditReplayExperimentEvidence(resealedRequest, { artifactBytes });
  assert.equal(requestAudit.status, "fail");
  assert.match(requestAudit.failures.join("\n"), /request body SHA-256/);

  const missingReceipt = structuredClone(evidence);
  delete missingReceipt.pairs[0].baseline.receiptSha256;
  assert.match(
    auditReplayExperimentEvidence(missingReceipt, { artifactBytes }).failures.join("\n"),
    /receipt SHA-256/,
  );

  const legacy = structuredClone(evidence);
  delete legacy.integrity;
  for (const pair of legacy.pairs) {
    delete pair.baseline.receiptSha256;
    delete pair.candidate.receiptSha256;
  }
  assert.equal(
    auditReplayExperimentEvidence(legacy, { artifactBytes }).status,
    "pass",
  );

  const tampered = structuredClone(evidence);
  tampered.totals.efficiency.candidate.usage.inputTokens++;
  tampered.pairs[0].baseline.durationMs = -1;
  const tamperedAudit = auditReplayExperimentEvidence(tampered, { artifactBytes });
  assert.equal(tamperedAudit.status, "fail");
  assert.match(tamperedAudit.failures.join("\n"), /invalid request duration/);
  assert.match(tamperedAudit.failures.join("\n"), /totals.efficiency/);

  const single = await runReplayExperiment({
    spec: {
      name: "unseeded-single-order",
      artifact: "failure.json",
      turn: 0,
      samples: 1,
      remedy: "Recheck the evidence.",
      expectation,
    },
    artifact,
    ask: async () => '{"a":"shell","c":"npm test"}',
  });
  assert.equal(single.totals.pairing, "single-order-unseeded");
  assert.equal(single.totals.orderBalance, "not-applicable");
  assert.match(formatReplayExperimentSummary(single), /Sampling: single-order-unseeded/);
});

test("replay experiment validation is bounded and verdicts do not overclaim", () => {
  assert.throws(
    () => normalizeReplayExperimentSpec({
      name: "bad",
      artifact: "run.json",
      turn: 0,
      samples: 9,
      remedy: "x",
      expectation,
    }),
    /samples must be an integer from 1 to 8/,
  );
  assert.throws(
    () => normalizeReplayExperimentSpec({
      name: "bad",
      artifact: "run.json",
      turn: 0,
      remedy: "x",
      expectation: { ...expectation, paths: ["../../outside"] },
    }),
    /workspace-relative/,
  );
  assert.equal(replayExperimentVerdict({
    samples: 3,
    baselinePasses: 1,
    candidatePasses: 2,
  }), "partial-lift");
  assert.equal(replayExperimentVerdict({
    samples: 3,
    baselinePasses: 2,
    candidatePasses: 1,
  }), "regression");
  assert.equal(replayExperimentVerdict({
    samples: 3,
    baselinePasses: 0,
    candidatePasses: 3,
    errors: 1,
  }), "inconclusive");
  assert.equal(replayExperimentVerdict({
    samples: 3,
    baselinePasses: 0,
    candidatePasses: 3,
    paired: false,
  }), "supported-unpaired");
});

function testArmReceiptSha256(value, { arm, sample }) {
  const sha256 = (input) =>
    crypto.createHash("sha256").update(String(input)).digest("hex");
  return sha256(JSON.stringify({
    schema: 1,
    sample,
    arm,
    fidelity: value.fidelity ?? null,
    requestBodySha256: value.requestBodySha256 ?? null,
    rawOutputSha256: sha256(value.rawOutput ?? ""),
    durationMs: value.durationMs,
    usage: value.usage ?? null,
    error: value.error ?? null,
  }));
}
