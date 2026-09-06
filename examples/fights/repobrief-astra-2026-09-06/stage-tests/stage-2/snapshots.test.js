import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { expectedCapture, failure, repository, successJson, write } from "./helpers.js";

test("named snapshots persist exact content hashes and diff by added/modified/deleted paths", t => {
  const root = repository(t, { files: { "tracked.txt": "original\n", "gone.txt": "remove me\n", ".gitignore": "cache/\n" } });
  write(root, "new note.txt", "untracked\n");
  write(root, "cache/ignored.txt", "not captured\n");
  const expected = expectedCapture(root, ["tracked.txt", "gone.txt", ".gitignore", "new note.txt"]);
  const snap = successJson(root, ["snapshot", "--repo", root, "--name", "handoff"]);
  assert.deepEqual(snap, { name: "handoff", ...expected });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".repobrief/snapshots/handoff.json"), "utf8")), snap);
  assert.equal(successJson(root, ["diff", "--name", "handoff", "--json"]).current, true);
  write(root, "tracked.txt", "changed\n");
  fs.unlinkSync(path.join(root, "gone.txt"));
  write(root, "added.txt", "new\n");
  assert.deepEqual(successJson(root, ["diff", "--name", "handoff", "--json"]), {
    name: "handoff", added: ["added.txt"], modified: ["tracked.txt"], deleted: ["gone.txt"], current: false,
  });
  const status = successJson(root, ["status", "--json"]);
  assert.ok(status.changes.every(row => !row.path.startsWith(".repobrief")));
});

test("snapshot names are safe, immutable, and unknown names do not fabricate baselines", t => {
  const root = repository(t);
  successJson(root, ["snapshot", "--name", "valid-name_1.0"]);
  const file = path.join(root, ".repobrief/snapshots/valid-name_1.0.json");
  const before = fs.readFileSync(file, "utf8");
  write(root, "tracked.txt", "changed\n");
  failure(root, ["snapshot", "--name", "valid-name_1.0"]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  for (const name of ["../escape", ".", "two words", "a".repeat(65)]) failure(root, ["snapshot", "--name", name]);
  failure(root, ["diff", "--name", "missing", "--json"]);
});
