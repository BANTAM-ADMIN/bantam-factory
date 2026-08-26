import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { refusedEditFocusForTest } from "../src/agent.js";
import { renderOpenFiles } from "../src/open-files.js";

// Measured on the ticket-B rerun (.bantam/runs/2026-08-16T14-11-45-620Z.json):
// the model sent the SAME edit_lines at src/agent.js:1513 nine times across
// turns 21-54 and never landed it. The context flight recorder names the cause
// without ambiguity —
//
//   completeOpenFileResidencies: 0
//   failed-edit-target-partial:  11
//   turn 54 openFiles: src/agent.js (5533 lines) shownRanges [[257,342],[530,543]]
//   turn 54 targets:   src/agent.js status "partial", grounding "not-visible"
//
// The recovery machinery pinned the FILE (editRecoveryPath) but not the SEAM,
// so every retry was authored against remembered structure. The prompt was
// 72,184 chars — there was room to show line 1513; nothing chose to.

function workspaceWith(rel, lineCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-seam-"));
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const lines = [];
  for (let i = 1; i <= lineCount; i += 1) lines.push(`const line${i} = ${i};`);
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
  return dir;
}

test("a refused edit_lines pins the seam it was aiming at", () => {
  const focus = refusedEditFocusForTest({ a: "edit_lines", p: "src/agent.js", start: 1513, end: 1513 }, "/nonexistent");
  const ranges = focus.get("src/agent.js");
  assert.ok(ranges?.length, "the failed seam must be located from the action's own coordinates");
  assert.ok(ranges[0].start < 1513 && ranges[0].end > 1513,
    `the window must straddle the edit line, got ${JSON.stringify(ranges[0])}`);
});

test("the seam is padded enough to show enclosing structure", () => {
  const [range] = refusedEditFocusForTest({ a: "edit_lines", p: "f.js", start: 1513, end: 1513 }, "/nonexistent").get("f.js");
  assert.ok(range.end - range.start >= 100,
    "an unbalanced delimiter is unreadable from the edited lines alone");
});

test("a refused replace is anchored by its OLD text, which still exists", () => {
  // currentEditFocus looks for the NEW text; a refusal wrote nothing, so only
  // the old side can be found in the file as it stands.
  const dir = workspaceWith("src/agent.js", 2000);
  const focus = refusedEditFocusForTest(
    { a: "replace", p: "src/agent.js", old: "const line1513 = 1513;", new: "const line1513 = 0;" },
    dir,
  );
  const [range] = focus.get("src/agent.js");
  assert.ok(range.start < 1513 && range.end > 1513,
    `expected a window around the anchor, got ${JSON.stringify(range)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the pinned seam actually reaches the rendered panel", () => {
  const dir = workspaceWith("src/agent.js", 2000);
  const focusByPath = new Map([["src/agent.js", [{ start: 1453, end: 1573 }]]]);
  const view = renderOpenFiles(dir, ["src/agent.js"], { focusByPath });
  const text = String(view?.text ?? view ?? "");
  assert.ok(text.includes("const line1513"),
    "the seam the edit failed on must be visible in <open_files>, not merely the file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a refused whole-file write pins nothing (there is no seam to pin)", () => {
  const focus = refusedEditFocusForTest({ a: "write_file", p: "src/new.js", content: "x" }, "/nonexistent");
  assert.equal(focus.size, 0);
});
