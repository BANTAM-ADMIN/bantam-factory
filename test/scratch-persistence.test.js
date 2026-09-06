// The worker's /tmp is its scratch bench: probe dumps and test coupons are
// evidence, not waste. A tmpfs discarded them with the container (2026-08-18
// bake-off, arm-B's real-file dumps) and its pages ate the memory cap.
// Scratch must persist WITHOUT entering the project tree or test discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scratchMountArgs, runShellProcess } from "../src/executor.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-scratch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "workspace"), pool = path.join(root, "private-pool");
  fs.mkdirSync(ws);
  return { root, ws, pool, env: { BANTAM_SCRATCH_ROOT: pool } };
}
const source = args => args[1].slice(0, -":/tmp:rw".length);

test("scratch is a persistent private bind outside the workspace", (t) => {
  const { ws, env, pool } = fixture(t);
  const args = scratchMountArgs(ws, env), dir = source(args);
  assert.equal(args[0], "-v");
  assert.equal(path.dirname(dir), pool);
  assert.match(path.basename(dir), /^[a-f0-9]{64}$/);
  assert.ok(!dir.startsWith(ws + path.sep));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(dir, "persistent-receipt.txt"), "survives");
  assert.deepEqual(scratchMountArgs(ws, env), args);
  assert.equal(fs.readFileSync(path.join(source(scratchMountArgs(ws, env)), "persistent-receipt.txt"), "utf8"), "survives");
  assert.deepEqual(fs.readdirSync(ws), [], "managed scratch creates no project files");
});

test("BANTAM_SCRATCH_TMPFS=1 restores the ephemeral tmpfs", () => {
  const args = scratchMountArgs("/anywhere", { BANTAM_SCRATCH_TMPFS: "1" });
  assert.deepEqual(args, ["--tmpfs", "/tmp:rw,exec,nosuid,nodev"]);
});

test("no workspace falls back to tmpfs rather than mounting nothing", () => {
  const args = scratchMountArgs(null, {});
  assert.equal(args[0], "--tmpfs");
});

test("canonical aliases share a scratch identity; different workspaces do not", t => {
  const { root, ws, env } = fixture(t), alias = path.join(root, "alias"), second = path.join(root, "second");
  fs.symlinkSync(ws, alias);fs.mkdirSync(second);
  assert.deepEqual(scratchMountArgs(alias, env), scratchMountArgs(ws, env));
  assert.notDeepEqual(scratchMountArgs(second, env), scratchMountArgs(ws, env));
});

test("recreating a workspace at the same path does not inherit deleted-worker scratch", t => {
  const { root, ws, env } = fixture(t), first = scratchMountArgs(ws, env);
  fs.renameSync(ws, path.join(root, "retired-workspace"));fs.mkdirSync(ws);
  assert.notDeepEqual(scratchMountArgs(ws, env), first);
});

test("worker-controlled legacy scratch symlinks cannot choose a host mount", t => {
  const { root, ws, env } = fixture(t), outside = path.join(root, "outside");
  fs.mkdirSync(outside);fs.mkdirSync(path.join(ws, ".bantam"));fs.symlinkSync(outside, path.join(ws, ".bantam", "scratch"));
  const args = scratchMountArgs(ws, env);
  assert.notEqual(source(args), outside);
  assert.ok(fs.lstatSync(path.join(ws, ".bantam", "scratch")).isSymbolicLink(), "legacy artifacts are not silently deleted or migrated");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("pool must be private and disjoint; symlink roots and child binds fail closed", t => {
  const { root, ws, env, pool } = fixture(t);
  for (const bad of [ws, path.join(ws, "scratch"), root, "relative"])
    assert.throws(() => scratchMountArgs(ws, { BANTAM_SCRATCH_ROOT: bad }), /scratch|SCRATCH_ROOT/);
  const outside = path.join(root, "outside");fs.mkdirSync(outside, { mode: 0o700 });fs.symlinkSync(outside, pool);
  assert.throws(() => scratchMountArgs(ws, env), /symlink/);fs.unlinkSync(pool);
  fs.mkdirSync(pool, { mode: 0o777 });fs.chmodSync(pool, 0o777);
  assert.throws(() => scratchMountArgs(ws, env), /private/);fs.chmodSync(pool, 0o700);
  const dir = source(scratchMountArgs(ws, env));fs.renameSync(dir, dir + "-retired");fs.symlinkSync(outside, dir);
  assert.throws(() => scratchMountArgs(ws, env), /symlink/);
});

test("temporary workspace mountpoints are owned and cannot be redirected through scratch symlinks", t => {
  const { root, ws, env } = fixture(t);
  if (!fs.realpathSync(ws).startsWith("/tmp/")) return;
  const dir = source(scratchMountArgs(ws, env));
  const mountpoint = path.join(dir, path.relative("/tmp", fs.realpathSync(ws)));
  assert.equal(fs.statSync(mountpoint).uid, process.getuid());
  const first = path.join(dir, path.relative("/tmp", fs.realpathSync(ws)).split(path.sep)[0]);
  fs.renameSync(first, first + "-retired");fs.symlinkSync(root, first);
  assert.throws(() => scratchMountArgs(ws, env), /mountpoint/);
});

test("readonly verifier stays ephemeral and fixture-owned scratch retains its explicit binding", async t => {
  const { root, ws } = fixture(t), dedicated = path.join(root, "fixture-scratch");fs.mkdirSync(dedicated);
  const calls = [], processRunner = async (_file, args) => { calls.push(args);return { code: 0, stdout: "", stderr: "" }; };
  await runShellProcess(ws, "true", { shellSandbox: "docker", workspaceReadOnly: true, processRunner });
  assert.ok(calls[0].includes("/tmp:rw,exec,nosuid,nodev"));
  assert.ok(!calls[0].some(arg => /:\/tmp:rw$/.test(arg)));
  await runShellProcess(ws, "true", { shellSandbox: "docker", fixtureScratch: dedicated, processRunner });
  assert.ok(calls[1].includes(`${dedicated}:/tmp:rw`));assert.ok(calls[1].includes(`${fs.realpathSync(ws)}:/probe:rw`));
});

test("live Docker keeps /tmp across worker calls without polluting independent Node test discovery", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST !== "1", timeout: 45000,
}, async t => {
  const { ws, env, pool } = fixture(t);
  const previous = process.env.BANTAM_SCRATCH_ROOT;process.env.BANTAM_SCRATCH_ROOT = pool;
  t.after(() => { if (previous === undefined) delete process.env.BANTAM_SCRATCH_ROOT;else process.env.BANTAM_SCRATCH_ROOT = previous; });
  fs.mkdirSync(path.join(ws, "test"));
  fs.writeFileSync(path.join(ws, "test", "public.test.cjs"), "require('node:test')('public contract', () => require('node:assert/strict').equal(2+2,4));\n");
  const script = "const fs=require('fs'),os=require('os'),path=require('path');const d=fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-proof-'));fs.writeFileSync(path.join(d,'target.txt'),'receipt');fs.symlinkSync(path.join(d,'target.txt'),path.join(d,'link.txt'));fs.writeFileSync('/tmp/persistent-receipt.txt','survives');";
  const shell = { shellSandbox: "docker", shellNetwork: false, timeoutMs: 15000 };
  const first = await runShellProcess(ws, `node -e '${script.replaceAll("'", "'\\''")}'`, shell);
  assert.equal(first.code, 0, first.stderr);
  const second = await runShellProcess(ws, "node -e 'if(require(\"fs\").readFileSync(\"/tmp/persistent-receipt.txt\",\"utf8\")!==\"survives\")process.exit(1)'", shell);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(fs.readdirSync(ws), ["test"]);
  const verified = await runShellProcess(ws, "node --test", { ...shell, workspaceReadOnly: true });
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /public contract/);
  const dir = source(scratchMountArgs(ws, env));
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith("snapshot-proof-")));
});
