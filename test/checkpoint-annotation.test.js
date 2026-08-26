import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RunCheckpoint } from "../src/run-checkpoint.js";

test("a post-hoc annotation reaches the sealed turn in the checkpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  const ck = new RunCheckpoint({ dest: path.join(dir, "run.json"), autosaveEvery: 99 });
  ck.note({ type: "action", action: { a: "shell", c: "ls" } });
  ck.note({ type: "observation", observation: "$ ls\nexit 0" });
  // the observation event has SEALED the turn; now the agent appends to it
  ck.note({ type: "observation_annotated", turn: 0, observation: "$ ls\nexit 0\n\n[deliverable] out.txt does not exist yet." });
  const turns = ck.turns();
  assert.equal(turns.length, 1);
  assert.match(turns[0].observation, /\[deliverable\]/);
});

test("without the event, the checkpoint holds only what it was told — the bug this exists for", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  const ck = new RunCheckpoint({ dest: path.join(dir, "run.json"), autosaveEvery: 99 });
  ck.note({ type: "action", action: { a: "shell", c: "ls" } });
  ck.note({ type: "observation", observation: "$ ls\nexit 0" });
  assert.doesNotMatch(ck.turns()[0].observation, /\[deliverable\]/);
});
