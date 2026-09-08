import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calibrationPreviewTimeoutMs,
  runPreviewReviewCalibration,
} from "../src/preview-review-calibration.js";

// A calibration run that produced no pixels reported one sentence: "calibration
// screenshot missing for <case>". Measured on CI 2026-09-08: the browser hit
// its budget at 26.6s on a cold shared runner and wrote no PNG. The runner had
// already computed browserTimedOut, screenshotCaptureTimedOut, browserExit and
// a stderr tail; the calibration discarded all of it, so a timeout, a crashed
// browser and a missing binary were indistinguishable from the failure text.

function scriptedManifest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-calibration-diagnosis-"));
  const cases = path.join(root, "cases");
  fs.mkdirSync(cases);
  fs.writeFileSync(path.join(cases, "clear.html"), "<main><h1>Visible</h1></main>");
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    schema: 1,
    name: "scripted",
    cases: [{ id: "clear", entry: "cases/clear.html", expected: "clear", task: "The visible heading must be Visible." }],
  }));
  return root;
}

const runWith = (root, preview) => runPreviewReviewCalibration({
  manifestPath: path.join(root, "manifest.json"),
  outputRoot: path.join(root, "evidence"),
  models: [{ name: "terra", effort: "medium" }],
  preview,
  reviewer: async () => ({ output: "RESULT: CLEAR", usage: {} }),
});

test("a browser that ran out of time says so", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: true, screenshotCaptureTimedOut: false, browserExit: null, browserStderrTail: "",
    })),
    /browser ran out of time/i,
  );
});

test("a screenshot capture that ran out of time is named separately", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: false, screenshotCaptureTimedOut: true, browserExit: 0, browserStderrTail: "",
    })),
    /screenshot capture ran out of time/i,
  );
});

test("a browser that exited non-zero reports its code and stderr tail", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: false, screenshotCaptureTimedOut: false, browserExit: 133,
      browserStderrTail: "Failed to move to new namespace",
    })),
    /exit 133[\s\S]*Failed to move to new namespace/i,
  );
});

test("every diagnosis still names the case it belongs to", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: true, screenshotCaptureTimedOut: false, browserExit: null, browserStderrTail: "",
    })),
    /for clear\b/,
  );
});

// The default preview budget is tuned for the interactive operator loop, where
// a human is waiting. Calibration is a batch evidence run over a whole manifest
// and inherited that budget, which is what expired on CI.

test("calibration asks for more browser time than the interactive default", () => {
  assert.ok(calibrationPreviewTimeoutMs({}) > 25000,
    `expected a budget above the 25s interactive default, got ${calibrationPreviewTimeoutMs({})}`);
});

test("the calibration browser budget is overridable and validated", () => {
  assert.equal(calibrationPreviewTimeoutMs({ BANTAM_CALIBRATION_PREVIEW_TIMEOUT_MS: "90000" }), 90000);
  for (const bad of ["0", "-1", "abc", "", "1.5"]) {
    assert.equal(calibrationPreviewTimeoutMs({ BANTAM_CALIBRATION_PREVIEW_TIMEOUT_MS: bad }),
      calibrationPreviewTimeoutMs({}), `rejected value ${JSON.stringify(bad)} must fall back to the default`);
  }
});

test("the budget reaches the preview runner", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seen = null;
  await assert.rejects(runWith(root, (workspace, entry, options) => {
    seen = options;
    return { ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0, browserTimedOut: true };
  }), /browser ran out of time/i);
  assert.equal(seen?.timeoutMs, calibrationPreviewTimeoutMs({}));
});
