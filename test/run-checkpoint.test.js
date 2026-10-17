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

test("checkpoints retain the exact post-execution assertion review separately from failed execution", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-review-checkpoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "partial.json");
  const checkpoint = new RunCheckpoint({ dest: destination, autosaveEvery: 0 });
  const failedAssertionReview = { schema: 1, executionEvidence: false,
    sourceSha256: "a".repeat(64), site: { start: 50, end: 75, expression: "assert.equal(read(), 'x')" },
    review: { verdict: "revise", reason: "Reset should return empty bytes.", executionEvidence: false } };
  checkpoint.note({ type: "action", action: { a: "shell", c: "node check-reset.cjs" } });
  checkpoint.note({ type: "observation", observation: "assertion failed",
    failedAssertionReview, shellExecution: { exitCode: 1 } });
  const expected = structuredClone(failedAssertionReview);
  failedAssertionReview.review.verdict = "grounded";
  assert.equal(checkpoint.flush("test"), true);
  const saved = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.deepEqual(saved.turns[0].failedAssertionReview, expected);
  assert.equal(saved.turns[0].shellExecution.exitCode, 1);
});

test('crash evidence preserves the pending output checkpoint until the file is committed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-output-checkpoint-pointer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dest = path.join(directory, 'partial.json');
  const checkpoint = new RunCheckpoint({ dest, autosaveEvery: 0 });
  checkpoint.note({ type: 'output_checkpoint_saved', id: 'run/attempt', target: 'story.txt', draftPath: '.bantam/draft.txt', rawPath: '.bantam/raw.json', stoppedLimit: true });
  const saved = JSON.parse(fs.readFileSync(dest));
  assert.equal(saved.pendingOutputCheckpoint, 'run/attempt');
  assert.equal(saved.outputCheckpoints[0].target, 'story.txt');
  checkpoint.note({ type: 'output_checkpoint_committed', id: 'run/attempt' });
  checkpoint.flush('test');
  assert.equal(JSON.parse(fs.readFileSync(dest)).pendingOutputCheckpoint, null);
});
