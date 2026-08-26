// continuity_reconcile done-gate: the prose still describes the same thing two
// conflicting ways (same noun, same attribute, two values — or two different
// durations in one passage). The gate names each conflict and bounces, bounded
// by maxRejections so it can never trap the run.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { continuityReconcileObjection } from "../src/logic/continuity-anchors.js";

// A temp workspace with one narrative prose file; removed afterwards.
function withWorkspace(prose, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-reconcile-"));
  try {
    fs.writeFileSync(path.join(dir, "chapter1.md"), prose, "utf8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("continuity_reconcile fires when the prose gives the same noun two quantities", () => {
  withWorkspace(
    "The crew counted forty crates on the manifest.\nBy morning only thirty crates were left.\n",
    (ws) => {
      const obj = continuityReconcileObjection(ws, 0);
      assert.equal(typeof obj, "string");
      assert.ok(obj.length > 0, "expected a non-null objection message");
      assert.match(obj, /\[continuity\]/);
      assert.match(obj, /crate/);
      assert.match(obj, /forty/);
      assert.match(obj, /thirty/);
    },
  );
});

test("continuity_reconcile fires when one passage gives two different durations", () => {
  withWorkspace(
    "He waited three days for a reply, then a week passed with nothing.\n",
    (ws) => {
      const obj = continuityReconcileObjection(ws, 0);
      assert.equal(typeof obj, "string");
      assert.ok(obj.length > 0, "expected a non-null objection message");
      assert.match(obj, /\[continuity\]/);
      assert.match(obj, /two different durations/);
    },
  );
});

test("continuity_reconcile stays silent when the prose is consistent", () => {
  withWorkspace(
    "The crew counted forty crates on the manifest.\nBy morning forty crates were still there.\n",
    (ws) => {
      assert.equal(continuityReconcileObjection(ws, 0), null);
    },
  );
});

test("continuity_reconcile stays silent on an empty workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-reconcile-"));
  try {
    assert.equal(continuityReconcileObjection(dir, 0), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continuity_reconcile stays silent once the rejection bound is reached", () => {
  withWorkspace(
    "The crew counted forty crates on the manifest.\nBy morning only thirty crates were left.\n",
    (ws) => {
      assert.equal(continuityReconcileObjection(ws, 2), null);
    },
  );
});
