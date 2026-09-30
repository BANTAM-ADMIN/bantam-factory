import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeSavedChatRun, listSavedChatRuns } from "../src/chat-resume-picker.js";

test("lists chat artifacts newest-first and ignores unrelated or malformed files", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-chat-picker-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, ".bantam", "runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "older.json"), JSON.stringify({
    kind: "bantam-chat-run", startedAt: "2026-01-01T00:00:00Z", request: "older", turns: [],
  }));
  fs.writeFileSync(path.join(dir, "newer.json"), JSON.stringify({
    kind: "bantam-chat-run", startedAt: "2026-02-01T00:00:00Z", request: "newer", turns: [],
  }));
  fs.writeFileSync(path.join(dir, "not-chat.json"), JSON.stringify({ kind: "other", turns: [] }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  const runs = listSavedChatRuns(workspace);
  assert.deepEqual(runs.map((run) => run.artifact.request), ["newer", "older"]);
  assert.match(describeSavedChatRun(runs[0]), /2026-02-01 00:00  saved  newer/);
  assert.equal(listSavedChatRuns(workspace, { limit: 1 }).length, 1);
});
