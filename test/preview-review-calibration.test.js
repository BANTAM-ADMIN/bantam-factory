import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditPreviewReviewCalibration,
  classifyPreviewReview,
  runPreviewReviewCalibration,
  scorePreviewReviewRows,
} from "../src/preview-review-calibration.js";
import { chromiumSkipReason, networkSkipReason } from "./helpers/env-guards.js";

const _chromiumSkip = chromiumSkipReason();
const _networkSkip = await networkSkipReason();

test("preview review verdict parsing is strict and case-insensitive", () => {
  assert.equal(classifyPreviewReview("RESULT: REPAIR\n- clipped"), "repair");
  assert.equal(classifyPreviewReview("result: clear"), "clear");
  assert.equal(classifyPreviewReview("Looks fine."), "invalid");
});

test("preview review scores separate false positives and false negatives", () => {
  const rows = [
    { model: "terra", expected: "repair", observed: "repair", correct: true },
    { model: "terra", expected: "repair", observed: "clear", correct: false },
    { model: "terra", expected: "clear", observed: "repair", correct: false },
    { model: "terra", expected: "clear", observed: "clear", correct: true },
  ];
  const [score] = scorePreviewReviewRows(rows, [{ name: "terra", effort: "medium" }]);
  assert.equal(score.truePositives, 1);
  assert.equal(score.falseNegatives, 1);
  assert.equal(score.trueNegatives, 1);
  assert.equal(score.falsePositives, 1);
  assert.equal(score.accuracy, 0.5);
});

test("calibration persists hash-linked screenshots and independently audits results", { skip: _chromiumSkip && _networkSkip ? _networkSkip : _chromiumSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-calibration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = path.join(root, "cases");
  fs.mkdirSync(cases);
  fs.writeFileSync(path.join(cases, "clear.html"), "<main><h1>Visible</h1></main>");
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    schema: 1,
    name: "scripted",
    cases: [{
      id: "clear",
      entry: "cases/clear.html",
      expected: "clear",
      task: "The visible heading must be Visible.",
    }],
  }));
  const outputRoot = path.join(root, "evidence");
  const { evidencePath, evidence } = await runPreviewReviewCalibration({
    manifestPath: path.join(root, "manifest.json"),
    outputRoot,
    models: [{ name: "terra", effort: "medium" }],
    reviewer: async () => ({
      output: "RESULT: CLEAR\n- The required heading is visible.",
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
    }),
  });

  assert.equal(evidence.strict, true);
  assert.equal(auditPreviewReviewCalibration(evidencePath).status, "pass");
  fs.appendFileSync(path.join(outputRoot, evidence.cases[0].screenshot), "tamper");
  assert.equal(auditPreviewReviewCalibration(evidencePath).status, "fail");
});

test("calibration audit binds the archived task contract and derived prompt", { skip: _chromiumSkip && _networkSkip ? _networkSkip : _chromiumSkip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-preview-contract-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "cases"));
  fs.writeFileSync(path.join(root, "cases", "page.html"), "<h1>Signal Garden</h1>");
  fs.writeFileSync(path.join(root, "source.json"), JSON.stringify({
    schema: 1,
    cases: [{
      id: "page",
      entry: "cases/page.html",
      expected: "clear",
      task: "The heading must be Signal Garden.",
    }],
  }));
  const { evidencePath } = await runPreviewReviewCalibration({
    manifestPath: path.join(root, "source.json"),
    outputRoot: path.join(root, "evidence"),
    models: [{ name: "terra", effort: "medium" }],
    reviewer: async () => "RESULT: CLEAR",
  });
  const archived = path.join(root, "evidence", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(archived, "utf8"));
  manifest.cases[0].task = "A different contract.";
  fs.writeFileSync(archived, JSON.stringify(manifest));
  const report = auditPreviewReviewCalibration(evidencePath);
  assert.equal(report.status, "fail");
  assert.match(report.failures.join("\n"), /manifest hash mismatch|contract mismatch|prompt hash mismatch/);
});
