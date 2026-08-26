#!/usr/bin/env node

import path from "node:path";

import {
  auditPreviewReviewCalibration,
  runPreviewReviewCalibration,
} from "../src/preview-review-calibration.js";

const args = process.argv.slice(2);
if (args[0] === "--audit") {
  const report = auditPreviewReviewCalibration(args[1]);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "pass" ? 0 : 1;
} else {
  const manifestPath = args[0] ?? "creative-suite/preview-review-calibration/manifest.json";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputRoot = path.resolve(args[1] ?? `.bantam/preview-review-calibrations/${stamp}`);
  const { evidence, evidencePath } = await runPreviewReviewCalibration({
    manifestPath,
    outputRoot,
    onEvent(event) {
      if (event.type === "review_started") {
        console.error(`review ${event.case} · ${event.model}`);
      } else if (event.type === "review_finished") {
        console.error(`  ${event.observed} · expected ${event.expected} · ${event.correct ? "correct" : "MISS"}`);
      }
    },
  });
  console.log(JSON.stringify({
    status: evidence.status,
    strict: evidence.strict,
    evidence: evidencePath,
    scores: evidence.scores,
  }, null, 2));
  process.exitCode = evidence.strict ? 0 : 1;
}
