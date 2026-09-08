import assert from "node:assert/strict";
import test from "node:test";

import { previewBrowserAttempts, runPreviewSync } from "../src/logic/preview.js";

// Measured on CI across four runs 2026-09-08: a Chromium launch on a GitHub
// runner intermittently hangs, consumes its whole budget whatever the budget
// is, and writes no PNG. It struck three different browser-driven tests in
// three separate runs and left the fourth entirely green, so the browser is a
// nondeterministic external process, not a failing assertion. Three causes
// were investigated and dropped: an undersized budget, a profile collision
// between concurrent launches, and CPU starvation. None reproduces locally.
//
// A hang that produced nothing is the one safe thing to retry: there is no
// partial result to corrupt and nothing to undo. The retry is bounded and
// counted on the report, because a preview that quietly costs twice its
// budget is worse than one that says it did.

const REPORT = (over = {}) => JSON.stringify({
  ok: true, url: "http://127.0.0.1:1/x", entry: "index.html",
  screenshot: "/dev/null/preview.png", screenshotBytes: 4096,
  browserTimedOut: false, browserExit: 0, visibleTextLength: 8, ...over,
});

const HUNG = REPORT({ screenshotBytes: 0, browserTimedOut: true, browserExit: null });

function runWith(runs, options = {}) {
  const calls = [];
  const report = runPreviewSync("/tmp", "index.html", {
    chromium: "/nonexistent/chromium",
    runRunner: () => { calls.push(1); return runs[calls.length - 1] ?? runs[runs.length - 1]; },
    ...options,
  });
  return { report, attempts: calls.length };
}

test("a browser that hangs with no pixels is retried once", () => {
  const { report, attempts } = runWith([HUNG, REPORT()]);
  assert.equal(attempts, 2, "the hung attempt should have been retried");
  assert.equal(report.screenshotBytes, 4096);
  assert.equal(report.browserRetries, 1, "the retry must be reported, not hidden");
});

test("a browser that worked first time is not retried", () => {
  const { report, attempts } = runWith([REPORT()]);
  assert.equal(attempts, 1);
  assert.equal(report.browserRetries, 0);
});

test("a page that renders nothing without hanging is a result, not a retry", () => {
  const { attempts } = runWith([REPORT({ screenshotBytes: 0, browserTimedOut: false })]);
  assert.equal(attempts, 1, "only a timed-out browser with no pixels is retried");
});

test("retries are bounded and the last report is kept", () => {
  const { report, attempts } = runWith([HUNG, HUNG, HUNG, HUNG]);
  assert.equal(attempts, previewBrowserAttempts({}), "must stop at the attempt limit");
  assert.equal(report.browserRetries, previewBrowserAttempts({}) - 1);
  assert.equal(report.browserTimedOut, true, "a persistent hang is still reported as one");
});

test("the attempt count is configurable and validated", () => {
  assert.equal(previewBrowserAttempts({}), 2);
  assert.equal(previewBrowserAttempts({ BANTAM_PREVIEW_BROWSER_ATTEMPTS: "1" }), 1);
  assert.equal(previewBrowserAttempts({ BANTAM_PREVIEW_BROWSER_ATTEMPTS: "3" }), 3);
  for (const bad of ["0", "-2", "abc", "", "2.5", "99"]) {
    assert.equal(previewBrowserAttempts({ BANTAM_PREVIEW_BROWSER_ATTEMPTS: bad }), 2,
      `nonsense value ${JSON.stringify(bad)} must fall back to the default`);
  }
});

test("retrying can be switched off entirely", () => {
  const { report, attempts } = runWith([HUNG, REPORT()], { attempts: 1 });
  assert.equal(attempts, 1);
  assert.equal(report.browserRetries, 0);
  assert.equal(report.screenshotBytes, 0);
});
