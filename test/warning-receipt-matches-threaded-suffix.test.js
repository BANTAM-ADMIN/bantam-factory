// The interactive warning receipt was renamed to "done with caveats" (the
// verdict.kind === 'warning' branch prints that label) but the sessionLog
// entry that branch pushed still appended '(unverified)' to the summary.
// That sessionLog line is the thread every LATER request sees — so the person
// read "done with caveats" while the next request's context called the same
// work "unverified". This test pins the threaded suffix to the receipt label
// so they cannot drift apart again.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "bantam.js"), "utf8");
const lines = source.split("\n");

// Find the warning branch start
let warningIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('verdict.kind === "warning"')) {
    warningIdx = i;
    break;
  }
}
assert.ok(warningIdx >= 0, "warning branch found in bin/bantam.js");

// From the warning branch, find the receipt label (the paint("33", "...") in console.log)
let receiptLabel = null;
// Find the sessionLog suffix
let threadedSuffix = null;

for (let i = warningIdx; i < Math.min(warningIdx + 20, lines.length); i++) {
  const line = lines[i];
  // Receipt: console.log with paint("33", "⚠ <label>")
  if (!receiptLabel && line.includes('console.log') && line.includes('paint("33"')) {
    const m = line.match(/paint\("33",\s*"([^"]+)"\)/);
    if (m) receiptLabel = m[1];
  }
  // Thread: sessionLog.push with a suffix in parentheses
  if (!threadedSuffix && line.includes('sessionLog.push')) {
    const m = line.match(/\(([^)]+)\)`/);
    if (m) threadedSuffix = m[1];
  }
}

test("the threaded sessionLog suffix matches the receipt label", () => {
  assert.ok(receiptLabel, `receipt label found (got: ${receiptLabel})`);
  assert.ok(threadedSuffix, `threaded suffix found (got: ${threadedSuffix})`);
  // The receipt label is like "⚠ done with caveats"; the suffix is the wording without the icon
  const receiptWording = receiptLabel.replace(/^⚠\s*/, "");
  assert.equal(
    threadedSuffix,
    receiptWording,
    `sessionLog suffix "${threadedSuffix}" must match receipt wording "${receiptWording}"`
  );
});
