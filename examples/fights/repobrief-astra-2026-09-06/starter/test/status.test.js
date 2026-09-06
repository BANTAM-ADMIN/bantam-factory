import assert from "node:assert/strict";
import test from "node:test";
import { cli, failure, git, repository, successJson, tempDirectory, write } from "./helpers.js";

test("status reports actual root, branch, HEAD and staged/worktree/untracked changes", t => {
  const root = repository(t, { files: { "tracked.txt": "old\n", "nested/keep.txt": "keep\n", ".gitignore": "ignored/\n" } });
  write(root, "tracked.txt", "staged\n");
  git(root, "add", "tracked.txt");
  write(root, "tracked.txt", "worktree\n");
  write(root, "notes with spaces.txt", "new\n");
  write(root, "ignored/cache.txt", "ignored\n");
  const result = successJson(root, ["status", "--repo", root + "/nested", "--json"]);
  assert.equal(result.root, root);
  assert.equal(result.branch, "main");
  assert.equal(result.head, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(result.changes, [
    { path: "notes with spaces.txt", index: "?", worktree: "?" },
    { path: "tracked.txt", index: "M", worktree: "M" },
  ]);
});

test("human status is useful and non-repositories fail honestly", t => {
  const root = repository(t);
  write(root, "handoff note.txt", "pending\n");
  const human = cli(root, ["status"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /main/);
  assert.ok(human.stdout.includes("handoff note.txt"));
  const outside = tempDirectory(t);
  failure(outside, ["status", "--repo", outside, "--json"]);
});
