import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import { admitCohortRun, definePreregistration } from "../src/factory/preregistration.js";
import { abortAdmittedAttempt, beginAdmittedAttempt, commitAdmittedEvidence } from "../scripts/c3-bounded-work-order-cohort.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repositoryRoot, "scripts/c3-bounded-work-order-cohort.mjs");
const roots = new Set();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  fs.mkdirSync(path.join(repositoryRoot, ".bantam"), { recursive: true });
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".bantam/prereg-integration-"));
  roots.add(root);
  const resultTarget = path.relative(repositoryRoot, path.join(root, "evidence/c3-station-cohort.json")).split(path.sep).join("/");
  const plan = definePreregistration({
    schema: 1, kind: "bantam.factory-preregistration", id: "c3-integration-control",
    question: "does the real C3 executable honor its preregistration before inference?",
    designerRef: "agent:designer", arms: ["bounded", "embedded"],
    primaryOutcome: "first-pass-comparison",
    decisionRule: { op: "wilson-superiority", candidateArm: "bounded", controlArm: "embedded", z: 1.96 },
    outcomes: { accepted: "superiority established", rejected: "superiority not established" },
    articlesPerArm: 20,
    powerAnalysis: { method: "integration-control-only", alpha: 0.05, power: 0.8, targetEffect: 0.2, unit: "cohens-h" },
    frozenSettings: { temperature: 0, thinking: false, worker: "fixture-worker" },
    resultTarget,
  });
  const planFile = path.join(root, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const admission = admitCohortRun({ plan, runnerRef: "agent:runner", scorerRef: "agent:scorer", repositoryRoot });
  return { admission, root, planFile, resultFile: path.resolve(repositoryRoot, resultTarget) };
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("C3 executable preregistration interlock", () => {
  it("refuses before endpoint discovery when no plan is supplied", () => {
    const result = run(["--endpoint", "http://127.0.0.1:9/v1/chat/completions"]);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /--preregistration PLAN is required/);
    assert.doesNotMatch(result.stderr, /no model/);
  });

  it("refuses an overwrite of its fixed result target before endpoint discovery", () => {
    const { root, planFile, resultFile } = fixture();
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, '{"prior":true}\n');
    const result = run([
      "--preregistration", planFile,
      "--runner", "agent:runner",
      "--scorer", "agent:scorer",
      "--out", path.relative(repositoryRoot, root),
      "--endpoint", "http://127.0.0.1:9/v1/chat/completions",
    ]);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /prior result exists/);
    assert.doesNotMatch(result.stderr, /no model/);
  });

  it("admits a fresh exact plan before attempting worker discovery", () => {
    const { root, planFile, resultFile } = fixture();
    const result = run([
      "--preregistration", planFile,
      "--runner", "agent:runner",
      "--scorer", "agent:scorer",
      "--out", path.relative(repositoryRoot, root),
      "--endpoint", "http://127.0.0.1:9/v1/chat/completions",
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /preregistration: prereg:/);
    assert.match(result.stderr, /no model/);
    const attempts = fs.readdirSync(path.dirname(resultFile)).filter((name) => name.includes(".attempt-"));
    assert.equal(attempts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(resultFile), attempts[0]), "utf8")).status, "aborted");
    assert.equal(fs.existsSync(`${resultFile}.preregistration.lock`), false);
  });

  it("reserves before work and retains a committed attempt record", () => {
    const { admission, resultFile } = fixture();
    const lease = beginAdmittedAttempt({ admission, file: resultFile, now: new Date("2026-08-03T00:00:00.000Z") });
    assert.equal(JSON.parse(fs.readFileSync(lease.attemptFile, "utf8")).status, "started");
    assert.equal(fs.existsSync(lease.lock), true);
    commitAdmittedEvidence({ lease, evidence: { run: 1 } });
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), { run: 1 });
    assert.equal(JSON.parse(fs.readFileSync(lease.attemptFile, "utf8")).status, "committed");
    assert.equal(fs.existsSync(lease.lock), false);
  });

  it("refuses a target changed after admission and retains aborted attempts", () => {
    const { admission, resultFile } = fixture();
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, '{"concurrent":true}\n');
    assert.throws(() => beginAdmittedAttempt({ admission, file: resultFile }), /changed after preregistration admission/);
    fs.unlinkSync(resultFile);
    const lease = beginAdmittedAttempt({ admission, file: resultFile });
    abortAdmittedAttempt(lease, "planted worker failure");
    const attempt = JSON.parse(fs.readFileSync(lease.attemptFile, "utf8"));
    assert.equal(attempt.status, "aborted");
    assert.match(attempt.error, /planted worker failure/);
  });

  it("does not remove a lock owned by another cohort", () => {
    const { admission, resultFile } = fixture();
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    const lock = `${resultFile}.preregistration.lock`;
    fs.writeFileSync(lock, "other-run");
    assert.throws(() => beginAdmittedAttempt({ admission, file: resultFile }), /EEXIST/);
    assert.equal(fs.readFileSync(lock, "utf8"), "other-run");
  });

  it("does not remove a foreign lock that replaces its lock after acquisition", () => {
    const { admission, resultFile } = fixture();
    const lease = beginAdmittedAttempt({ admission, file: resultFile });
    fs.unlinkSync(lease.lock);
    fs.writeFileSync(lease.lock, "replacement-owner", { flag: "wx" });
    abortAdmittedAttempt(lease, "planted replacement race");
    assert.equal(fs.readFileSync(lease.lock, "utf8"), "replacement-owner");
    fs.unlinkSync(lease.lock);
  });
});
