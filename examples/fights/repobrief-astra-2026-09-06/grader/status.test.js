import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, repository, successJson, write } from "../starter/test/helpers.js";

test("external/status: individual nested files, staged addition, unstaged deletion and ignores", t => {
  const root = repository(t, { files: { "delete me.txt": "remove\n", "keep.txt": "keep\n", ".gitignore": "cache/\n" } });
  fs.unlinkSync(path.join(root, "delete me.txt"));
  write(root, "staged addition.txt", "added\n");
  git(root, "add", "staged addition.txt");
  write(root, "new directory/b.txt", "b\n");
  write(root, "new directory/a.txt", "a\n");
  write(root, "cache/hidden.txt", "ignored\n");
  const status = successJson(root, ["status", "--json"]);
  assert.equal(status.root, root);
  assert.deepEqual(status.changes, [
    { path: "delete me.txt", index: " ", worktree: "D" },
    { path: "new directory/a.txt", index: "?", worktree: "?" },
    { path: "new directory/b.txt", index: "?", worktree: "?" },
    { path: "staged addition.txt", index: "A", worktree: " " },
  ]);
});

test("external/status: detached and unborn HEAD, cwd default, and clean arrays", t => {
  const root = repository(t, { files: { "nested/keep.txt": "tracked\n" } });
  const head = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--detach", head);
  const detached = successJson(root, ["status", "--json"], { cwd: path.join(root, "nested") });
  assert.equal(detached.root, root);
  assert.equal(detached.branch, null);
  assert.equal(detached.head, head);
  assert.deepEqual(detached.changes, []);
  const unbornRoot = repository(t, { files: {}, commit: false });
  const unborn = successJson(unbornRoot, ["status", "--json"]);
  assert.equal(unborn.branch, "main");
  assert.equal(unborn.head, null);
  assert.deepEqual(unborn.changes, []);
});

test("external/status: rename destinations are not confused with the second NUL path", t => {
  const root = repository(t, { files: { "old name.txt": "rename this unchanged content\n" } });
  git(root, "mv", "old name.txt", "new name.txt");
  const status = successJson(root, ["status", "--json"]);
  assert.deepEqual(status.changes, [{ path: "new name.txt", index: "R", worktree: " " }]);
});
