import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceStore } from "../src/workspace-store.js";

test("workspace capture ignores unrelated ancestor repository exclusions", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-store-parent-"));
  const workspace = path.join(parent, "ignored", "project");
  const storeRoot = path.join(workspace, ".bantam", "store");
  const materialized = path.join(parent, "materialized");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  execFileSync("git", ["init", "--quiet", parent]);
  fs.writeFileSync(path.join(parent, ".gitignore"), "ignored/\n");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace, "src", "index.js"), "export const value = 1;\n");

  const store = new WorkspaceStore(storeRoot);
  const captured = store.capture(workspace, {
    excludePaths: [path.join(workspace, ".bantam")],
  });
  assert.equal(captured.files, 2);

  store.materialize(captured.commit, materialized);
  assert.equal(
    fs.readFileSync(path.join(materialized, "src", "index.js"), "utf8"),
    "export const value = 1;\n",
  );
  assert.equal(fs.existsSync(path.join(materialized, ".bantam")), false);
});
