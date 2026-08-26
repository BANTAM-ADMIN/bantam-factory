import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RunCheckpoint } from "../src/run-checkpoint.js";

test("run checkpoints preserve workspace coherence needed for safe resume", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-checkpoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "partial.json");
  const checkpoint = new RunCheckpoint({
    dest: destination,
    autosaveEvery: 0,
  });
  const workspaceCoherence = {
    fingerprints: { "src/value.js": "file:33188:4:fixture-sha" },
    pendingPaths: ["src/value.js"],
  };

  checkpoint.note({
    type: "action",
    action: { a: "read_file", p: "src/value.js" },
    rawOutput: '{"a":"read_file","p":"src/value.js"}',
  });
  checkpoint.note({
    type: "observation",
    observation: "src/value.js (1 lines, showing 1-1)\nvalue",
    workspaceCoherence,
  });

  assert.deepEqual(checkpoint.turns()[0].workspaceCoherence, workspaceCoherence);
  assert.equal(checkpoint.flush("test"), true);
  const saved = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.deepEqual(saved.turns[0].workspaceCoherence, workspaceCoherence);
});
