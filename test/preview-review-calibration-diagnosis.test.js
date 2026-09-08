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

// A browser that hangs consumes whatever budget it is given, so a larger one
// buys nothing. Measured across two CI runs: a healthy launch on the runner
// takes 4.5-5.4s, and a starved one, reproduced locally on two loaded cores,
// takes 6s. A sick one produced nothing at 25000 ms and nothing at 75000 ms.
// Calibration therefore keeps the preview runner's own default and exposes an
// override for a host that genuinely needs one.

test("calibration leaves the preview budget to the runner by default", () => {
  assert.equal(calibrationPreviewTimeoutMs({}), null);
});

test("an explicit budget is honoured and a nonsense one is ignored", () => {
  assert.equal(calibrationPreviewTimeoutMs({ BANTAM_CALIBRATION_PREVIEW_TIMEOUT_MS: "90000" }), 90000);
  for (const bad of ["0", "-1", "abc", "", "1.5"]) {
    assert.equal(calibrationPreviewTimeoutMs({ BANTAM_CALIBRATION_PREVIEW_TIMEOUT_MS: bad }), null,
      `nonsense value ${JSON.stringify(bad)} must fall back to the runner default`);
  }
});

test("no override means no timeoutMs is forced on the runner", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let seen = null;
  await assert.rejects(runWith(root, (workspace, entry, options) => {
    seen = options;
    return { ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0, browserTimedOut: true };
  }), /browser ran out of time/i);
  assert.equal(seen?.timeoutMs, undefined);
});

// The runner records the browser's own stderr whenever the browser did not
// exit cleanly, a SIGKILL from the timeout included. The first diagnosis
// printed that tail only for a non-zero exit code, and a killed browser
// reports no code at all, so the one place the cause is actually written was
// withheld from every timeout.

test("a timed-out browser still reports what it printed", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: true, browserExit: null,
      browserStderrTail: "Fontconfig error: Cannot load default config file",
    })),
    /Fontconfig error: Cannot load default config file/,
  );
});

test("a silent browser says the output was empty rather than inventing a cause", async (t) => {
  const root = scriptedManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runWith(root, () => ({
      ok: true, screenshot: "/nowhere/preview.png", screenshotBytes: 0,
      browserTimedOut: true, browserExit: null, browserStderrTail: "",
    })),
    /printed nothing/i,
  );
});
