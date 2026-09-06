import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { expectedCapture, git, repository, successJson, tempDirectory, write } from "../starter/test/helpers.js";

test("external/snapshot: ignore rules, tracked ignored paths, empty files, symlinks and metadata", t => {
  const root = repository(t, { files: { "tracked.txt": "tracked even when ignored\n", "missing.txt": "later deleted\n", ".gitignore": "cache/\n" } });
  write(root, ".gitignore", "cache/\ntracked.txt\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore rule does not untrack a file");
  write(root, "untracked empty.txt", "");
  write(root, "cache/ignored.txt", "no\n");
  fs.unlinkSync(path.join(root, "missing.txt"));
  const outside = tempDirectory(t);
  write(outside, "private.txt", "must not be followed\n");
  fs.symlinkSync(path.join(outside, "private.txt"), path.join(root, "file-link"));
  fs.symlinkSync(outside, path.join(root, "directory-link"));
  fs.symlinkSync(path.join(root, "tracked.txt"), path.join(root, "internal-link"));
  write(root, ".repobrief/internal.txt", "always excluded\n");
  git(root, "add", "-f", ".repobrief/internal.txt");
  const expected = expectedCapture(root, [".gitignore", "tracked.txt", "untracked empty.txt"]);
  const snap = successJson(root, ["snapshot", "--name", "edges"]);
  assert.deepEqual(snap, { name: "edges", ...expected });
  assert.equal(successJson(root, ["diff", "--name", "edges", "--json"]).current, true);
  const status = successJson(root, ["status", "--json"]);
  assert.ok(status.changes.every(row => row.path !== ".repobrief" && !row.path.startsWith(".repobrief/")));
});

test("external/diff: mtimes and staging do not stand in for working-tree bytes", t => {
  const root = repository(t, { files: { "nested/a.txt": "same\n", "b.txt": "before\n" } });
  const original = fs.statSync(path.join(root, "b.txt"));
  successJson(root, ["snapshot", "--name", "baseline", "--repo", path.join(root, "nested")]);
  const later = new Date(Date.now() + 86400000);
  fs.utimesSync(path.join(root, "nested/a.txt"), later, later);
  write(root, "b.txt", "before\n");
  assert.equal(successJson(root, ["diff", "--name", "baseline", "--json"]).current, true);
  write(root, "b.txt", "after!\n");
  fs.utimesSync(path.join(root, "b.txt"), original.atime, original.mtime);
  git(root, "add", "b.txt");
  write(root, "z new.txt", "last\n");
  write(root, "a new.txt", "first\n");
  assert.deepEqual(successJson(root, ["diff", "--name", "baseline", "--json"]), {
    name: "baseline", added: ["a new.txt", "z new.txt"], modified: ["b.txt"], deleted: [], current: false,
  });
  write(root, "b.txt", "before\n");
  const diff = successJson(root, ["diff", "--name", "baseline", "--json"]);
  assert.deepEqual(diff.modified, [], "the index may differ while current bytes match the snapshot");
});
