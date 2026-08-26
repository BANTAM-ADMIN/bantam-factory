import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotWorkspace, restoreWorkspace, SNAPSHOT_DEFAULTS } from "../src/workspace-snapshot.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";

function mkworkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-ws-"));
  return dir;
}

test("captures small text source files", () => {
  const dir = mkworkspace();
  fs.writeFileSync(path.join(dir, "gpt2.c"), "int main(){return 0;}\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "util.py"), "print('hi')\n");
  const snap = snapshotWorkspace(dir);
  const paths = snap.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["gpt2.c", "src/util.py"]);
  assert.match(snap.files.find((f) => f.path === "gpt2.c").content, /int main/);
});

test("NEVER swallows the weights: binary files are skipped, not embedded", () => {
  const dir = mkworkspace();
  // a TF checkpoint / ELF a.out both contain NUL bytes early
  fs.writeFileSync(path.join(dir, "gpt2-124M.ckpt"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x99]));
  fs.writeFileSync(path.join(dir, "a.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]));
  fs.writeFileSync(path.join(dir, "gpt2.c"), "// source\n");
  const snap = snapshotWorkspace(dir);
  assert.deepEqual(snap.files.map((f) => f.path), ["gpt2.c"], "only the source is captured");
  const skippedNames = snap.skipped.map((s) => s.path).sort();
  assert.ok(skippedNames.includes("gpt2-124M.ckpt"), "ckpt skipped");
  assert.ok(skippedNames.includes("a.out"), "a.out skipped");
  assert.ok(snap.skipped.every((s) => s.why === "binary"), "reason recorded as binary");
});

test("skips oversized files and records why", () => {
  const dir = mkworkspace();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(SNAPSHOT_DEFAULTS.perFileCap + 1));
  fs.writeFileSync(path.join(dir, "small.txt"), "ok");
  const snap = snapshotWorkspace(dir);
  assert.deepEqual(snap.files.map((f) => f.path), ["small.txt"]);
  assert.equal(snap.skipped.find((s) => s.path === "big.txt").why, "too-big");
});

test("excludes regenerable/huge directories", () => {
  const dir = mkworkspace();
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports=1");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  fs.writeFileSync(path.join(dir, "keep.js"), "1");
  const snap = snapshotWorkspace(dir);
  assert.deepEqual(snap.files.map((f) => f.path), ["keep.js"]);
});

test("restoreWorkspace round-trips and refuses escapes", () => {
  const src = mkworkspace();
  fs.writeFileSync(path.join(src, "gpt2.c"), "ROUNDTRIP\n");
  const snap = snapshotWorkspace(src);
  const dest = mkworkspace();
  const r = restoreWorkspace(snap, dest);
  assert.deepEqual(r.written, ["gpt2.c"]);
  assert.equal(fs.readFileSync(path.join(dest, "gpt2.c"), "utf8"), "ROUNDTRIP\n");
  // path traversal must be refused
  const evil = { files: [{ path: "../escape.txt", content: "no" }, { path: "/etc/pwn", content: "no" }] };
  const r2 = restoreWorkspace(evil, dest);
  assert.equal(r2.written.length, 0);
  assert.equal(r2.failed.length, 2);
  assert.ok(!fs.existsSync(path.join(path.dirname(dest), "escape.txt")));
});

test("restoreWorkspace with skipExisting fills gaps but never clobbers task inputs", () => {
  const dir = mkworkspace();
  // resume snapshot carries both the model's file and a copy of a task input
  const snap = { files: [
    { path: "gpt2.c", content: "MODEL-WORK\n" },
    { path: "vocab.bpe", content: "STALE-COPY\n" },
  ] };
  // operator staged the REAL task input already; it must survive
  fs.writeFileSync(path.join(dir, "vocab.bpe"), "REAL-INPUT\n");
  const r = restoreWorkspace(snap, dir, { skipExisting: true });
  assert.deepEqual(r.written, ["gpt2.c"]);
  assert.deepEqual(r.skippedExisting, ["vocab.bpe"]);
  assert.equal(fs.readFileSync(path.join(dir, "gpt2.c"), "utf8"), "MODEL-WORK\n");
  assert.equal(fs.readFileSync(path.join(dir, "vocab.bpe"), "utf8"), "REAL-INPUT\n", "task input not clobbered");
});

test("checkpoint embeds the workspace snapshot on autosave (schema 3)", () => {
  const dir = mkworkspace();
  fs.writeFileSync(path.join(dir, "gpt2.c"), "int main(){}\n");
  const dest = path.join(mkworkspace(), "run.json");
  const cp = new RunCheckpoint({
    dest,
    meta: { runId: "t", task: "build gpt2.c", workspace: dir },
    autosaveEvery: 1,
  });
  // drive one full turn (action then observation) → triggers autosave at turn 1
  cp.note({ type: "action", kind: "shell", command: "gcc gpt2.c" });
  cp.note({ type: "observation", text: "ok" });
  const body = JSON.parse(fs.readFileSync(dest, "utf8"));
  assert.equal(body.schema, 3);
  assert.ok(body.workspaceSnapshot, "snapshot present");
  const f = body.workspaceSnapshot.files.find((x) => x.path === "gpt2.c");
  assert.ok(f && /int main/.test(f.content), "gpt2.c bytes embedded");
});
