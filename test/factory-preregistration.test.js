import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { admitCohortRun, definePreregistration, loadPreregistration, scoreAgainstPlan, verifyPreregisteredCohortEvidence } from "../src/factory/preregistration.js";

const roots = new Set();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-prereg-")); roots.add(root); return root; };

const PLAN = {
  schema: 1, kind: "bantam.factory-preregistration", id: "c3-powered-rerun",
  question: "is a bounded work order materially more reliable than the same obligation embedded?",
  designerRef: "agent:opus-2", arms: ["bounded", "embedded"],
  primaryOutcome: "first-pass-comparison",
  decisionRule: { op: "wilson-superiority", candidateArm: "bounded", controlArm: "embedded", z: 1.96 },
  outcomes: {
    accepted: "bounded first-pass yield advantage established at the planned threshold",
    rejected: "bounded first-pass yield advantage not established at the planned sample size",
  },
  articlesPerArm: 535,
  powerAnalysis: { method: "two-proportion-cohens-h", alpha: 0.05, power: 0.8, targetEffect: 0.1212, unit: "cohens-h" },
  frozenSettings: { thinking: false, temperature: 0, worker: "qwen-27b" },
  resultTarget: ".bantam/factory-claims/evidence/c3-station-cohort.json",
};

function admission(plan, overrides = {}) {
  const { repositoryRoot = temp(), ...rest } = overrides;
  return admitCohortRun({ plan, runnerRef: "agent:opus", scorerRef: "agent:codex-audit", repositoryRoot, ...rest });
}

describe("cohort preregistration", () => {
  it("round-trips a content-addressed plan and rejects identity tampering", () => {
    const root = temp(); const file = path.join(root, "plan.json");
    const plan = definePreregistration(PLAN); fs.writeFileSync(file, JSON.stringify(plan));
    assert.equal(loadPreregistration(file).ref, plan.ref);
    assert.notEqual(definePreregistration({ ...PLAN, articlesPerArm: 536 }).ref, plan.ref);
    assert.throws(() => definePreregistration({ ...plan, question: "changed" }), /content hash/);
  });

  it("requires distinct arms, an executable rule, a power statement, and a fixed result target", () => {
    for (const key of ["primaryOutcome", "decisionRule", "outcomes", "powerAnalysis", "frozenSettings", "resultTarget"]) {
      const broken = { ...PLAN }; delete broken[key];
      assert.throws(() => definePreregistration(broken), new RegExp(`missing: ${key}`));
    }
    assert.throws(() => definePreregistration({ ...PLAN, arms: ["bounded", "bounded"] }), /duplicates/);
    assert.throws(() => definePreregistration({ ...PLAN, decisionRule: { ...PLAN.decisionRule, op: "choose-best-looking-metric" } }), /unsupported/);
    assert.throws(() => definePreregistration({ ...PLAN, decisionRule: { ...PLAN.decisionRule, candidateArm: "ghost" } }), /declared plan arms/);
    assert.throws(() => definePreregistration({ ...PLAN, decisionRule: { ...PLAN.decisionRule, controlArm: "bounded" } }), /must be distinct/);
    assert.throws(() => definePreregistration({ ...PLAN, powerAnalysis: { ...PLAN.powerAnalysis, power: 1 } }), /strictly between/);
    assert.throws(() => definePreregistration({ ...PLAN, resultTarget: "../outside.json" }), /within the repository/);
  });

  it("canonicalizes declared identities so whitespace cannot bypass role separation", () => {
    const plan = definePreregistration(PLAN);
    assert.equal(admission(plan).admitted, true);
    assert.equal(admission(plan, { runnerRef: plan.designerRef }).admitted, false);
    assert.equal(admission(plan, { scorerRef: plan.designerRef }).admitted, false);
    assert.equal(admission(plan, { scorerRef: "agent:opus" }).admitted, false);
    assert.throws(() => admission(plan, { runnerRef: `${plan.designerRef} ` }), /surrounding whitespace/);
  });

  it("binds a rerun to the plan's fixed target, exact prior bytes, and a fourth role", () => {
    const root = temp(); const resultsFile = path.join(root, PLAN.resultTarget);
    fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
    const prior = Buffer.from('{"old":true}\n'); fs.writeFileSync(resultsFile, prior);
    const plan = definePreregistration(PLAN);
    assert.equal(admission(plan, { repositoryRoot: root }).admitted, false);
    const digest = crypto.createHash("sha256").update(prior).digest("hex");
    const override = { reason: "new preregistered question approved before execution", approvedByRef: "agent:fable", priorResultSha256: digest };
    const allowed = admission(plan, { repositoryRoot: root, rerunOverride: override });
    assert.equal(allowed.admitted, true, JSON.stringify(allowed.blockers));
    assert.equal(allowed.existingResultSha256, digest);
    assert.equal(admission(plan, { repositoryRoot: root, rerunOverride: { ...override, priorResultSha256: "0".repeat(64) } }).admitted, false);
    assert.equal(admission(plan, { repositoryRoot: root, rerunOverride: { ...override, approvedByRef: "agent:opus" } }).admitted, false);
  });

  it("rejects an override when no prior result exists", () => {
    const result = admission(definePreregistration(PLAN), {
      rerunOverride: { reason: "not actually a rerun", approvedByRef: "agent:fable", priorResultSha256: "0".repeat(64) },
    });
    assert.equal(result.admitted, false);
    assert.match(result.blockers[0], /no prior result/);
  });

  it("computes the planned statistic from raw arm counts and binds scorer, plan, and admission", () => {
    const plan = definePreregistration(PLAN); const admitted = admission(plan);
    const accepted = scoreAgainstPlan({
      plan, admission: admitted, scorerRef: "agent:codex-audit",
      measurements: { "first-pass-comparison": { bounded: { passed: 530, of: 535 }, embedded: { passed: 480, of: 535 } }, tokenRatio: 0.4 },
    });
    assert.equal(accepted.verdict, "accepted");
    assert.equal(accepted.analysis.accepted, true);
    assert.deepEqual(accepted.unplanned, ["tokenRatio"]);
    assert.match(accepted.ref, /^cohort-score:sha256:/);
    assert.throws(() => scoreAgainstPlan({ plan, admission: { ...admitted, runnerRef: "agent:forged" }, scorerRef: "agent:codex-audit", measurements: { "first-pass-comparison": { bounded: { passed: 530, of: 535 }, embedded: { passed: 480, of: 535 } } } }), /content hash/);
    assert.throws(() => scoreAgainstPlan({ plan, admission: admitted, scorerRef: "agent:other", measurements: { "first-pass-comparison": {} } }), /scorer/);
    const otherPlan = definePreregistration({ ...PLAN, id: "other-plan" });
    assert.throws(() => scoreAgainstPlan({ plan: otherPlan, admission: admitted, scorerRef: "agent:codex-audit", measurements: { "first-pass-comparison": {} } }), /does not belong/);
  });

  it("makes the measured null final even when a caller supplies flattering Boolean and cost fields", () => {
    const plan = definePreregistration({ ...PLAN, id: "sixty-article-null", articlesPerArm: 60 }); const admitted = admission(plan);
    const rejected = scoreAgainstPlan({
      plan, admission: admitted, scorerRef: "agent:codex-audit",
      measurements: {
        "first-pass-comparison": { bounded: { passed: 56, of: 60 }, embedded: { passed: 54, of: 60 } },
        differenceEstablished: true, tokenRatio: 0.37, wallRatio: 0.16,
      },
    });
    assert.equal(rejected.verdict, "rejected");
    assert.equal(rejected.analysis.accepted, false);
    assert.deepEqual(rejected.unplanned, ["differenceEstablished", "tokenRatio", "wallRatio"]);
  });

  it("refuses a small flattering sample when the plan froze a larger n", () => {
    const plan = definePreregistration(PLAN); const admitted = admission(plan);
    assert.throws(() => scoreAgainstPlan({
      plan, admission: admitted, scorerRef: "agent:codex-audit",
      measurements: { "first-pass-comparison": { bounded: { passed: 5, of: 5 }, embedded: { passed: 0, of: 5 } } },
    }), /planned 535 articles/);
  });

  it("verifies the plan/admission/score chain against every retained article row", () => {
    const plan = definePreregistration({ ...PLAN, id: "five-article-control", articlesPerArm: 5 });
    const admitted = admission(plan);
    const score = scoreAgainstPlan({
      plan, admission: admitted, scorerRef: "agent:codex-audit",
      measurements: { "first-pass-comparison": { bounded: { passed: 5, of: 5 }, embedded: { passed: 0, of: 5 } } },
    });
    const articles = [
      ...Array.from({ length: 5 }, () => ({ arm: "bounded", pass: true, repaired: false })),
      ...Array.from({ length: 5 }, () => ({ arm: "embedded", pass: false, repaired: false })),
    ];
    const evidence = { preregistration: { plan, admission: admitted, score }, articles };
    assert.equal(verifyPreregisteredCohortEvidence(evidence, { expectedResultTarget: PLAN.resultTarget }).score.verdict, "accepted");
    const tampered = structuredClone(evidence); tampered.articles[0].pass = false;
    assert.throws(() => verifyPreregisteredCohortEvidence(tampered, { expectedResultTarget: PLAN.resultTarget }), /counts do not match/);
    assert.throws(() => verifyPreregisteredCohortEvidence(evidence, { expectedResultTarget: "evidence/other.json" }), /different evidence file/);
  });

  it("refuses absent or malformed raw primary measurements", () => {
    const plan = definePreregistration(PLAN); const admitted = admission(plan);
    assert.equal(scoreAgainstPlan({ plan, admission: admitted, scorerRef: "agent:codex-audit", measurements: { tokenRatio: 0.4 } }).verdict, "unscoreable");
    assert.throws(() => scoreAgainstPlan({ plan, admission: admitted, scorerRef: "agent:codex-audit", measurements: { "first-pass-comparison": true } }), /must be an object/);
  });
});
