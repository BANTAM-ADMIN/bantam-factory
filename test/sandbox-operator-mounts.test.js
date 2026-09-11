// The sandbox's host tool mounts are how a system tool reaches the container at
// all (the host /usr is bind-mounted read-only over the image's). These tests
// pin the two operator-facing levers added 2026-09-11: a host browser outside a
// system root is mounted automatically, and BANTAM_SHELL_MOUNT_RO exposes an
// extra host root read-only without opening private home directories.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShellProcess, operatorReadOnlyMounts } from "../src/executor.js";

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("BANTAM_SHELL_MOUNT_RO exposes an extra host root read-only at the same path", (t) => {
  const dir = tmp(t, "bantam-mount-");
  fs.writeFileSync(path.join(dir, "tool"), "x");
  const real = fs.realpathSync(dir);
  assert.deepEqual(operatorReadOnlyMounts(dir), [["-v", `${real}:${real}:ro`]]);
});

test("BANTAM_SHELL_MOUNT_RO de-duplicates repeated roots", (t) => {
  const dir = tmp(t, "bantam-mount-");
  const real = fs.realpathSync(dir);
  assert.deepEqual(operatorReadOnlyMounts(`${dir}:${dir}`), [["-v", `${real}:${real}:ro`]]);
});

test("BANTAM_SHELL_MOUNT_RO refuses relative, missing, root and private-home paths", (t) => {
  const home = tmp(t, "bantam-home-");
  const secret = path.join(home, ".ssh");
  fs.mkdirSync(secret);
  assert.throws(() => operatorReadOnlyMounts("relative/path"), /absolute/);
  assert.throws(() => operatorReadOnlyMounts(path.join(home, "missing")), /does not exist/);
  assert.throws(() => operatorReadOnlyMounts("/"), /filesystem root/);
  assert.throws(() => operatorReadOnlyMounts(secret, { home }), /private home/);
  // The documented passthrough accepts the exposure.
  const real = fs.realpathSync(secret);
  assert.deepEqual(operatorReadOnlyMounts(secret, { home, passthrough: "1" }), [["-v", `${real}:${real}:ro`]]);
});

test("an unset BANTAM_SHELL_MOUNT_RO adds no mounts", () => {
  assert.deepEqual(operatorReadOnlyMounts(undefined), []);
  assert.deepEqual(operatorReadOnlyMounts(""), []);
});

test("a host browser outside a system root is mounted read-only into the sandbox", async (t) => {
  const root = tmp(t, "bantam-browser-");
  const bin = path.join(root, "chrome-linux");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "google-chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const workspace = tmp(t, "bantam-browser-ws-");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  t.after(() => { process.env.PATH = previous; });

  let args = null;
  await runShellProcess(workspace, "true", {
    shellSandbox: "docker",
    shellNetwork: false,
    processRunner: async (file, composed) => { args = composed; return { code: 0, stdout: "", stderr: "" }; },
  });
  const real = fs.realpathSync(bin);
  assert.ok(args.includes(`${real}:${real}:ro`), "the browser root is bind-mounted read-only");
  assert.ok(args.includes("none"), "the browser mount does not turn the network on");
});
