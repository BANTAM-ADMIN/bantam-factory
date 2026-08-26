// notes_documentation done-gate: the task produced a notes/changelog deliverable,
// but it doesn't document a same-attribute repair the model actually made (derived
// from the model's OWN edits — the attribute value it edited away in a non-notes
// prose file). Bounded by maxRejections so it can never trap the run.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { notesDocumentationObjection } from "../src/logic/continuity-anchors.js";

// A temp workspace holding the prose file the model edited and the notes file;
// removed afterwards.
function withWorkspace(prose, notes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-doc-"));
  try {
    fs.writeFileSync(path.join(dir, "chapter1.md"), prose, "utf8");
    fs.writeFileSync(path.join(dir, "NOTES.md"), notes, "utf8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The model edited "forty crates" down to "thirty crates" in the prose — a
// same-attribute (quantity) repair that the notes must document.
const repairTurn = {
  parsedAction: { a: "replace", p: "chapter1.md", old: "forty crates", new: "thirty crates" },
};

test("notes_documentation fires when the notes omit a same-attribute repair the model made", () => {
  withWorkspace(
    "The crew counted thirty crates on the manifest.\n",
    "- Fixed a typo in the opening paragraph.\n",
    (ws) => {
      const obj = notesDocumentationObjection([repairTurn], ws, 0);
      assert.equal(typeof obj, "string");
      assert.ok(obj.length > 0, "expected a non-null objection message");
      assert.match(obj, /\[notes\]/);
      assert.match(obj, /crate/);
      assert.match(obj, /forty/);
    },
  );
});

test("notes_documentation stays silent when the notes document the repair", () => {
  withWorkspace(
    "The crew counted thirty crates on the manifest.\n",
    "- Reconciled the crate count: changed \"forty crates\" to \"thirty crates\".\n",
    (ws) => {
      assert.equal(notesDocumentationObjection([repairTurn], ws, 0), null);
    },
  );
});

test("notes_documentation stays silent when there is no notes deliverable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-doc-"));
  try {
    fs.writeFileSync(path.join(dir, "chapter1.md"), "The crew counted thirty crates.\n", "utf8");
    assert.equal(notesDocumentationObjection([repairTurn], dir, 0), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes_documentation stays silent when the model made no attribute repair", () => {
  withWorkspace(
    "The crew counted forty crates on the manifest.\n",
    "- Fixed a typo in the opening paragraph.\n",
    (ws) => {
      const turns = [{ parsedAction: { a: "replace", p: "chapter1.md", old: "the the", new: "the" } }];
      assert.equal(notesDocumentationObjection(turns, ws, 0), null);
    },
  );
});

test("notes_documentation stays silent once the rejection bound is reached", () => {
  withWorkspace(
    "The crew counted thirty crates on the manifest.\n",
    "- Fixed a typo in the opening paragraph.\n",
    (ws) => {
      assert.equal(notesDocumentationObjection([repairTurn], ws, 2), null);
    },
  );
});
