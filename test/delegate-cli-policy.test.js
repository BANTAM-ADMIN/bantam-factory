import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("native delegate execution is research-only and requires explicit consent", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-delegate-policy-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  const cli = path.resolve("bin/bantam.js");
  const result = spawnSync(process.execPath, [
    cli,
    "delegate", "run",
    "--workspace", workspace,
    "--task", "do not execute",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, BANTAM_NO_FACTS: "1" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /research-only/i);
  assert.match(result.stderr, /--yes/);
  assert.match(result.stderr, /codex-terra/);
  assert.equal(fs.existsSync(path.join(workspace, ".bantam")), false);
});
