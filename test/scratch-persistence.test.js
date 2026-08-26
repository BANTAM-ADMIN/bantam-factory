// The worker's /tmp is its scratch bench: probe dumps and test coupons are
// evidence, not waste. A tmpfs discarded them with the container (2026-08-18
// bake-off, arm-B's real-file dumps) and its pages ate the memory cap.
// scratchMountArgs bind-mounts <workspace>/.bantam/scratch at /tmp instead,
// so the swarf survives into the run bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scratchMountArgs } from "../src/executor.js";

test("scratch is a persistent bind mount under the workspace", (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-scratch-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const args = scratchMountArgs(ws, {});
  assert.equal(args[0], "-v");
  assert.match(args[1], /\.bantam\/scratch:\/tmp:rw$/);
  assert.ok(fs.existsSync(path.join(ws, ".bantam", "scratch")), "scratch dir created");
});

test("BANTAM_SCRATCH_TMPFS=1 restores the ephemeral tmpfs", () => {
  const args = scratchMountArgs("/anywhere", { BANTAM_SCRATCH_TMPFS: "1" });
  assert.deepEqual(args, ["--tmpfs", "/tmp:rw,exec,nosuid,nodev"]);
});

test("no workspace falls back to tmpfs rather than mounting nothing", () => {
  const args = scratchMountArgs(null, {});
  assert.equal(args[0], "--tmpfs");
});
