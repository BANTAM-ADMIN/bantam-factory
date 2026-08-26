import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceCoherenceTracker } from "../src/workspace-coherence.js";

test("workspace coherence detects exact same-size out-of-band edits", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-coherence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.js"), "old\n");
  const tracker = new WorkspaceCoherenceTracker(workspace);
  tracker.watch("source.js");

  fs.writeFileSync(path.join(workspace, "source.js"), "new\n");
  assert.deepEqual(tracker.scan(), ["source.js"]);
  assert.deepEqual(tracker.scan(), []);
});

test("workspace coherence distinguishes owned refreshes from later external changes", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-coherence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.js"), "one\n");
  const tracker = new WorkspaceCoherenceTracker(workspace);
  tracker.watch("source.js");

  fs.writeFileSync(path.join(workspace, "source.js"), "owned\n");
  tracker.refresh("source.js");
  assert.deepEqual(tracker.scan(), []);

  fs.rmSync(path.join(workspace, "source.js"));
  assert.deepEqual(tracker.scan(), ["source.js"]);
});

test("workspace coherence bounds watched state and refuses escaping paths", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-coherence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(workspace, name), name);
  const tracker = new WorkspaceCoherenceTracker(workspace, { maxPaths: 2 });
  tracker.watch(["../outside", "a", "b", "c"]);

  fs.writeFileSync(path.join(workspace, "a"), "changed");
  fs.writeFileSync(path.join(workspace, "b"), "changed");
  fs.writeFileSync(path.join(workspace, "c"), "changed");
  assert.deepEqual(tracker.scan().sort(), ["b", "c"]);
});

test("workspace coherence snapshots restore an exact resume baseline", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-coherence-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "source.js"), "before\n");
  const first = new WorkspaceCoherenceTracker(workspace);
  first.watch("source.js");
  const snapshot = first.snapshot();

  fs.writeFileSync(path.join(workspace, "source.js"), "after!\n");
  const resumed = new WorkspaceCoherenceTracker(workspace);
  resumed.restore(snapshot);
  assert.deepEqual(resumed.scan(), ["source.js"]);
  assert.deepEqual(resumed.scan(), []);
});
