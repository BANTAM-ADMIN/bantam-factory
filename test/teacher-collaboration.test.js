import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  assessLocalRun,
  buildTeacherPacket,
  loadTeacherCandidates,
  parseGrade,
  runTeacherCollaboration,
  saveTeacherCollaboration,
  synthesizeCouncil,
  TEACHER_ANALYSIS_SCHEMA,
  TEACHER_REVIEW_SCHEMA,
} from "../src/teacher-collaboration.js";

const temporary = new Set();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-teacher-council-"));
  temporary.add(dir);
  return dir;
}

function artifact({
  runId,
  modelId,
  task = "Implement a standards parser.",
  pass = true,
  turns = 7,
} = {}) {
  return {
    schema: 2,
    kind: "bantam-run",
    runId,
    task,
    modelId,
    result: {
      pass,
      status: pass ? "pass" : "fail",
      reachedDone: true,
      summary: pass ? "visible tests passed" : "verification failed",
      contract: null,
    },
    metrics: {
      turns,
      invalid: 0,
      protocolViolations: 0,
      duplicateActionRejections: 0,
      duplicateShellRejections: 0,
      noOpEdits: 0,
      generatedTokens: 100,
      actions: { read_file: 1, replace: 1, shell: 1, done: 1 },
    },
    turns: [
      {
        i: 0,
        reasoning: "I will use a permissive parser.",
        parsedAction: { a: "replace", p: "src/parser.js", old: "old", new: "new" },
        observation: "edit applied",
      },
      {
        i: 1,
        reasoning: "The visible tests pass.",
        parsedAction: { a: "done", summary: "finished" },
        observation: "verification passed",
      },
    ],
  };
}

function analysis(model) {
  const sol = model.includes("sol");
  return {
    verdict: "harness-gap",
    summary: sol
      ? "The harness did not force standards-boundary analysis."
      : "Visible tests did not challenge near-miss inputs.",
    hypotheses: [{
      slug: sol ? "standards-boundary-audit" : "near-miss-test-design",
      failureMode: sol
        ? "The local agent treats a named wire standard as permissive prose."
        : "The local agent stops after happy-path visible tests.",
      evidence: [
        "The local trajectory chose a permissive parser.",
        "The external grade is lower than both references.",
      ],
      mechanism: "No completion-time standards audit requests negative near-miss cases.",
      remedyType: sol ? "done-gate" : "test-oracle",
      remedy: sol
        ? "At done, require a standards grammar audit and at least one rejected near miss."
        : "Generate adversarial near-miss cases from normative formats before accepting green.",
      deliveryPoint: "before accepting done after verification",
      targets: sol
        ? ["src/done-gates.js", "test/standards-audit.test.js", "../../escape"]
        : ["src/edge-smoke.js", "test/edge-smoke.test.js"],
      falsificationTest: "Run paired parser fixtures with whitespace-wrapped and non-standard dates.",
      expectedLocalBehavior: "The local agent writes strict validation and rejects near misses.",
      confidence: sol ? 0.92 : 0.86,
    }],
    adversarialTests: [{
      name: sol ? "reject-nonstandard-date" : "near-miss-boundary",
      purpose: "Catch permissive parsing of a named standard.",
      setup: "Give happy-path visible tests and keep non-standard dates hidden.",
      assertion: "The candidate rejects all non-standard date forms.",
      guardsAgainst: "permissive standards parsing and premature completion",
    }],
    cautions: ["Do not hard-code the benchmark's answer."],
  };
}

function review(model) {
  const subjectSlug = model.includes("sol")
    ? "near-miss-test-design"
    : "standards-boundary-audit";
  return {
    verdict: "accept",
    summary: "The hypothesis is grounded and falsifiable.",
    hypotheses: [{
      slug: subjectSlug,
      verdict: "accept",
      reason: "The grade gap and trajectory directly support it.",
      requiredEvidence: "A paired fresh-task experiment.",
    }],
    missingRisks: ["Check false positives on libraries intentionally accepting extensions."],
    confidence: 0.9,
  };
}

afterEach(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

describe("teacher collaboration", () => {
  it("keeps teachers off for a clean local run unless proactive analysis is explicit", async () => {
    const local = artifact({ runId: "local", modelId: "qwen" });
    let calls = 0;
    const result = await runTeacherCollaboration({
      local,
      references: [
        artifact({ runId: "sol", modelId: "gpt-5.6-sol" }),
        artifact({ runId: "terra", modelId: "gpt-5.6-terra" }),
      ],
      invokeTeacher: async () => { calls++; return {}; },
    });

    assert.equal(result.status, "withheld");
    assert.equal(calls, 0);
    assert.equal(assessLocalRun(local).eligible, false);
    assert.equal(assessLocalRun(local, { force: true }).eligible, true);
  });

  it("runs independent analyses and reciprocal cross-reviews, accepting only consensus", async () => {
    const calls = [];
    const result = await runTeacherCollaboration({
      local: artifact({ runId: "local", modelId: "qwen" }),
      references: [
        artifact({ runId: "sol-run", modelId: "gpt-5.6-sol" }),
        artifact({ runId: "terra-run", modelId: "gpt-5.6-terra" }),
      ],
      grades: { local: "3/10", sol: "9/10", terra: "10/10" },
      invokeTeacher: async ({ model, phase, prompt, schema }) => {
        calls.push({ model, phase, prompt, schema });
        return JSON.stringify(phase === "analysis" ? analysis(model) : review(model));
      },
      usageForModel: (model) => ({ provider: "codex", model, requests: 2 }),
      now: () => new Date("2026-07-25T18:00:00.000Z"),
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(calls.map(({ model, phase }) => [model, phase]), [
      ["gpt-5.6-sol", "analysis"],
      ["gpt-5.6-terra", "analysis"],
      ["gpt-5.6-sol", "cross-review"],
      ["gpt-5.6-terra", "cross-review"],
    ]);
    assert.equal(calls[0].schema, TEACHER_ANALYSIS_SCHEMA);
    assert.equal(calls[2].schema, TEACHER_REVIEW_SCHEMA);
    assert.equal(result.report.council.verdict, "strong-consensus");
    assert.equal(result.report.candidates.length, 2);
    assert.equal(result.report.usage["gpt-5.6-sol"].requests, 2);
    assert.ok(result.report.candidates.every((candidate) => (
      candidate.source === "teacher-collaboration"
      && candidate.promotionEligible === false
      && candidate.evidence.adversarialTests.length > 0
      && candidate.evidence.citedEvidence.length > 0
      && /^[a-f0-9]{64}$/.test(candidate.evidence.trajectoryComparisonSha256)
      && candidate.targets.length > 0
    )));
    assert.ok(result.report.candidates[0].targets.every((target) => !target.includes("..")));
  });

  it("rejects incomparable artifacts before making a teacher call", async () => {
    let calls = 0;
    await assert.rejects(
      runTeacherCollaboration({
        local: artifact({ runId: "local", modelId: "qwen", pass: false }),
        references: [
          artifact({ runId: "sol", modelId: "gpt-5.6-sol", task: "A different task." }),
          artifact({ runId: "terra", modelId: "gpt-5.6-terra" }),
        ],
        invokeTeacher: async () => { calls++; },
      }),
      /exact same task/,
    );
    assert.equal(calls, 0);
  });

  it("clusters cross-accepted semantic duplicates while preserving corroboration", () => {
    const sol = analysis("gpt-5.6-sol");
    const terra = analysis("gpt-5.6-terra");
    terra.hypotheses[0] = {
      ...sol.hypotheses[0],
      slug: "strict-standards-near-misses",
      failureMode: `${sol.hypotheses[0].failureMode} The visible oracle misses near-miss inputs.`,
      remedy: `${sol.hypotheses[0].remedy} Generate hidden near-miss probes.`,
      confidence: 0.88,
    };
    const council = synthesizeCouncil({
      analyses: [
        { model: "gpt-5.6-sol", analysis: sol },
        { model: "gpt-5.6-terra", analysis: terra },
      ],
      reviews: [
        {
          reviewer: "gpt-5.6-terra",
          subject: "gpt-5.6-sol",
          review: {
            ...review("gpt-5.6-terra"),
            hypotheses: [{
              slug: sol.hypotheses[0].slug,
              verdict: "accept",
              reason: "grounded",
              requiredEvidence: "paired test",
            }],
          },
        },
        {
          reviewer: "gpt-5.6-sol",
          subject: "gpt-5.6-terra",
          review: {
            ...review("gpt-5.6-sol"),
            hypotheses: [{
              slug: terra.hypotheses[0].slug,
              verdict: "accept",
              reason: "grounded",
              requiredEvidence: "paired test",
            }],
          },
        },
      ],
    });

    assert.equal(council.accepted.length, 2);
    assert.equal(council.recommendations.length, 1);
    assert.deepEqual(
      council.recommendations[0].corroborating.map(({ sourceModel }) => sourceModel),
      ["gpt-5.6-sol", "gpt-5.6-terra"],
    );
  });

  it("persists hash-bound reports and loads their candidates, ignoring tampering", async () => {
    const root = tempDir();
    const result = await runTeacherCollaboration({
      local: artifact({ runId: "local", modelId: "qwen", pass: false }),
      references: [
        artifact({ runId: "sol", modelId: "gpt-5.6-sol" }),
        artifact({ runId: "terra", modelId: "gpt-5.6-terra" }),
      ],
      invokeTeacher: async ({ model, phase }) => (
        phase === "analysis" ? analysis(model) : review(model)
      ),
      now: () => new Date("2026-07-25T18:00:00.000Z"),
    });
    const file = saveTeacherCollaboration(root, result.report);

    const loaded = loadTeacherCandidates(root);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].evidence.reportId, result.report.id);

    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.candidates[0].proposal = "silently lower the verifier";
    fs.writeFileSync(file, JSON.stringify(tampered));
    assert.deepEqual(loadTeacherCandidates(root), []);
  });

  it("refuses to write or load reports through symlinked private state", async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(root, ".bantam"));
    fs.symlinkSync(outside, path.join(root, ".bantam", "teacher-collaboration"), "dir");
    const result = await runTeacherCollaboration({
      local: artifact({ runId: "local", modelId: "qwen", pass: false }),
      references: [
        artifact({ runId: "sol", modelId: "gpt-5.6-sol" }),
        artifact({ runId: "terra", modelId: "gpt-5.6-terra" }),
      ],
      invokeTeacher: async ({ model, phase }) => (
        phase === "analysis" ? analysis(model) : review(model)
      ),
    });

    assert.throws(() => saveTeacherCollaboration(root, result.report), /symlink/);
    assert.deepEqual(loadTeacherCandidates(root), []);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("raises recurring mechanisms only after independent evidence from distinct tasks", async () => {
    const root = tempDir();
    const runCouncil = async (task, suffix, stamp) => runTeacherCollaboration({
      local: artifact({ runId: `local-${suffix}`, modelId: "qwen", pass: false, task }),
      references: [
        artifact({ runId: `sol-${suffix}`, modelId: "gpt-5.6-sol", task }),
        artifact({ runId: `terra-${suffix}`, modelId: "gpt-5.6-terra", task }),
      ],
      invokeTeacher: async ({ model, phase }) => (
        phase === "analysis" ? analysis(model) : review(model)
      ),
      now: () => new Date(stamp),
    });
    const first = await runCouncil("Task one", "one", "2026-07-25T18:00:00.000Z");
    saveTeacherCollaboration(root, first.report);
    assert.equal(
      loadTeacherCandidates(root).filter((candidate) => candidate.id.startsWith("teacher-recurring-")).length,
      0,
    );

    const second = await runCouncil("Task two", "two", "2026-07-25T18:01:00.000Z");
    saveTeacherCollaboration(root, second.report);
    const recurring = loadTeacherCandidates(root)
      .filter((candidate) => candidate.id.startsWith("teacher-recurring-"));

    assert.equal(recurring.length, 2);
    assert.ok(recurring.every((candidate) => (
      candidate.occurrences === 2
      && candidate.impact === 5
      && candidate.promotionEligible === false
      && candidate.evidence.distinctTasks === 2
      && candidate.evidence.reports.length === 2
    )));
    const oracle = recurring.find((candidate) => candidate.id.includes("test-oracle"));
    assert.ok(oracle.targets.includes("src/done-gates.js"));
    assert.ok(oracle.targets.includes("src/done-guard.js"));
    assert.ok(oracle.targets.includes("src/completion-audit.js"));
    assert.ok(oracle.targets.includes("src/agent.js"));
    assert.equal(oracle.targets.length, 6);
  });

  it("redacts credentials and bounds the shared evidence packet", () => {
    const local = artifact({ runId: "local", modelId: "qwen" });
    local.task += " key sk-secretsecretsecret12345";
    local.turns[0].observation = "Authorization: Bearer secret-token";
    const sol = artifact({ runId: "sol", modelId: "gpt-5.6-sol", task: local.task });
    const terra = artifact({ runId: "terra", modelId: "gpt-5.6-terra", task: local.task });

    const packet = buildTeacherPacket({ local, references: [sol, terra] });
    const serialized = JSON.stringify(packet);
    assert.doesNotMatch(serialized, /sk-secret|secret-token/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.ok(serialized.length < 50_000);
    assert.equal(packet.trajectoryComparison.kind, "bantam.trajectory-comparison");
    assert.match(packet.trajectoryComparison.sha256, /^[a-f0-9]{64}$/);
  });

  it("parses external grades strictly", () => {
    assert.deepEqual(parseGrade("3/10"), { passed: 3, tests: 10, rate: 0.3 });
    assert.throws(() => parseGrade("11/10"), /invalid grade/);
    assert.throws(() => parseGrade("pass"), /expected passed\/tests/);
  });
});
