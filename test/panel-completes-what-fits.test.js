import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fullyRenderedPaths, renderOpenFiles } from "../src/open-files.js";

// Measured on the ticket-B rerun (.bantam/runs/2026-08-16T14-11-45-620Z.json):
//
//   completeOpenFileResidencies: 0     across all 60 turns
//   src/agent.js          5527 lines — 56 turns partial, 0 complete
//   src/fixture-runner.js  668 lines — 54 turns partial, 0 complete
//
// Only two files were ever in the panel and neither was ever whole. The
// 668-line one needs ~36,112 rendered bytes (content + "N\t" prefixes) and the
// panel budget is 48,000 — it fits. It stayed a fragment because the
// COMPLETABILITY test compared against PRIMARY_MAX_BYTES (24,000), a cap meant
// for shaping files that must be clipped. The budget was never the constraint;
// a constant was. Same shape as the two-independent-ceilings defect.

function workspaceWithLines(rel, lineCount, width = 44) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-panel-"));
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = `const x = "${"y".repeat(Math.max(1, width))}";`;
  fs.writeFileSync(full, `${Array.from({ length: lineCount }, () => body).join("\n")}\n`);
  return dir;
}

test("a file that fits the panel budget renders completely", () => {
  // ~668 lines x ~60 bytes ≈ 40KB rendered: over the 24,000 per-file default,
  // under the 48,000 panel budget. This is the ticket-B file's shape.
  const dir = workspaceWithLines("src/fixture-runner.js", 668);
  const complete = fullyRenderedPaths(dir, ["src/fixture-runner.js"], {});
  assert.equal(complete.get("src/fixture-runner.js"), 669,
    "a file the panel has room for must not be clipped by a per-file constant");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("completion survives the line cap, not just the byte cap", () => {
  // 668 lines against a 600-line primary cap: passing the byte test and then
  // losing the tail to MAX_LINES is still a fragment, and a fragment gets re-read.
  const dir = workspaceWithLines("src/fixture-runner.js", 668, 10);
  const text = renderOpenFiles(dir, ["src/fixture-runner.js"], {});
  assert.match(text, /\n668\t/, "the last line must be present");
  assert.doesNotMatch(text, /more lines omitted|panel truncated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file genuinely larger than the whole panel is still clipped", () => {
  const dir = workspaceWithLines("src/huge.js", 20000);
  const complete = fullyRenderedPaths(dir, ["src/huge.js"], {});
  assert.equal(complete.has("src/huge.js"), false,
    "the budget is still a real ceiling — this fix raises it to the panel, not to infinity");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an un-completable giant does not starve a completable neighbour", () => {
  // The ticket-B pairing exactly: one file that can never fit beside one that can.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-panel-pair-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  // ~46 bytes/line, matching the real src/fixture-runner.js (30,768 bytes over
  // 668 lines → ~36,112 rendered). A wider synthetic exceeds the budget left
  // after the giant's seam and hits the separate drop-rather-than-fragment rule.
  const line = `const x = "${"y".repeat(30)}";`;
  fs.writeFileSync(path.join(dir, "src/agent.js"), `${Array.from({ length: 5527 }, () => line).join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "src/fixture-runner.js"), `${Array.from({ length: 668 }, () => line).join("\n")}\n`);

  const complete = fullyRenderedPaths(dir, ["src/agent.js", "src/fixture-runner.js"], {});
  assert.equal(complete.has("src/fixture-runner.js"), true,
    "the giant takes a bounded seam budget; the file that fits gets completed");
  assert.equal(complete.has("src/agent.js"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the file being EDITED outranks files that were merely read", () => {
  // tb4 (2026-08-16, .bantam/runs/2026-08-16T16-16-10-688Z.json) turn 16:
  // src/fixture-runner.js complete in the panel. Turn 17: the model issues a
  // `replace` against it and the file is gone — two test files it had just read
  // displaced it. The flight recorder logged edit-target-absent on turns 17,
  // 38, 39 and 40: four edits authored against a file it could not see.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-editpri-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  const line = `const x = "${"y".repeat(30)}";`;
  const write = (rel, count) =>
    fs.writeFileSync(path.join(dir, rel), `${Array.from({ length: count }, () => line).join("\n")}\n`);
  write("src/agent.js", 5527);          // un-completable giant, takes a seam budget
  write("src/fixture-runner.js", 668);  // the edit target
  write("test/a.test.js", 110);
  write("test/b.test.js", 277);

  // Recency order puts the just-read test files first, exactly as in tb4.
  const openList = ["test/a.test.js", "test/b.test.js", "src/agent.js", "src/fixture-runner.js"];

  const without = renderOpenFiles(dir, openList, {});
  assert.ok(!without.includes("# src/fixture-runner.js"),
    "precondition: recency alone drops the edit target (this is the bug)");

  const mutationFocusByPath = new Map([["src/fixture-runner.js", [{ start: 240, end: 300 }]]]);
  const withPriority = renderOpenFiles(dir, openList, { mutationFocusByPath });
  assert.ok(withPriority.includes("# src/fixture-runner.js"),
    "the file being edited must stay in the panel");
  assert.equal(fullyRenderedPaths(dir, openList, { mutationFocusByPath }).has("src/fixture-runner.js"), true,
    "and it should be whole, not a fragment");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("edit priority is stable and does not reorder within a group", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-editpri2-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(dir, "src", name), "export const x = 1;\n");
  }
  const openList = ["src/a.js", "src/b.js", "src/c.js"];
  // No edit targets: ordering (and therefore the panel) is untouched.
  const before = renderOpenFiles(dir, openList, {});
  const after = renderOpenFiles(dir, openList, { mutationFocusByPath: new Map() });
  assert.equal(after, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

// tb11 turn 62 (2026-08-16, .bantam/runs/2026-08-16T19-21-23-939Z.json): the
// model ran edit_lines on src/fixture-runner.js — a file it had ALREADY edited
// earlier in the same run — with the file absent from the panel entirely, which
// the recorder logged as edit-target-absent. Two causes.
//
// A mutation focus is perishable: it is deleted whenever the edit's new text
// cannot be located afterwards, and the file quietly stops counting as an edit
// target. Having been edited in this run does not perish.
//
// And "drop rather than fragment" — right for a file merely read, since a
// fragment invites a re-read — starved the edit target: the loop skipped it for
// being too large, then spent its budget on smaller neighbours. A fragment of
// the file under the cursor beats its absence.

function multiFileWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-edit-target-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  const body = (n) => `${Array.from({ length: n }, (_, i) => `const x${i} = "${"y".repeat(30)}";`).join("\n")}\n`;
  for (const [rel, lines] of Object.entries({
    "src/agent.js": 5667,                      // un-completable giant
    "src/scope-guard.js": 400,                 // read only
    "test/artifact-attachments.test.js": 300,  // edited
    "test/impossible-scope.test.js": 200,      // read only
    "src/fixture-runner.js": 668,              // edited, and large
  })) fs.writeFileSync(path.join(dir, rel), body(lines));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Recency order from tb11 turn 62: the edit target sits last.
const TB11_OPEN_LIST = [
  "test/artifact-attachments.test.js",
  "src/scope-guard.js",
  "test/impossible-scope.test.js",
  "src/agent.js",
  "src/fixture-runner.js",
];

test("a file edited earlier in the run stays in the panel", (t) => {
  const dir = multiFileWorkspace(t);
  const text = renderOpenFiles(dir, TB11_OPEN_LIST, {
    // its mutation focus was dropped; only the edited-set remembers it
    mutationFocusByPath: new Map([["test/artifact-attachments.test.js", [{ start: 95, end: 105 }]]]),
    editedPaths: new Set(["src/fixture-runner.js", "test/artifact-attachments.test.js"]),
  });
  assert.ok(text.includes("# src/fixture-runner.js"), "the edit target must be present");
  assert.ok(text.includes("# test/artifact-attachments.test.js"), "and so must the other one");
});

test("a read-only neighbour yields its place to an edit target", (t) => {
  const dir = multiFileWorkspace(t);
  const text = renderOpenFiles(dir, TB11_OPEN_LIST, {
    mutationFocusByPath: new Map(),
    editedPaths: new Set(["src/fixture-runner.js", "test/artifact-attachments.test.js"]),
  });
  assert.ok(!text.includes("# src/scope-guard.js"),
    "a file merely read is what should drop when the budget is tight");
});

test("without an edited set the old drop-rather-than-fragment rule stands", (t) => {
  const dir = multiFileWorkspace(t);
  const text = renderOpenFiles(dir, TB11_OPEN_LIST, {});
  assert.ok(!text.includes("# src/fixture-runner.js"),
    "precondition: recency alone loses it — this is what tb11 hit");
});
