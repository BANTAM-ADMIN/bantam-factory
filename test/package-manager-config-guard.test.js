import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  detectScopeViolations,
  isPackageManagerConfigPath,
  isRunnerConfigPath,
  snapshotTree,
} from "../src/scope-guard.js";

test("package-manager execution config is recognized at any workspace depth", () => {
  const protectedPaths = [
    ".npmrc",
    "packages/api/.npmrc",
    ".yarnrc",
    "apps/web/.yarnrc.yml",
    ".yarn/plugins/plugin-a.cjs",
    "tools/.yarn/releases/yarn.cjs",
    ".pnp.cjs",
    "tools/.pnp.loader.mjs",
    "yarn.config.cjs",
    ".pnpmfile.cjs",
    "tools/pnpmfile.js",
    "packages/api/.pnpmfile.mjs",
    "pnpm-workspace.yaml",
  ];
  for (const relative of protectedPaths) {
    assert.equal(isPackageManagerConfigPath(relative), true, relative);
    assert.equal(isRunnerConfigPath(relative), true, relative);
  }
  assert.equal(isPackageManagerConfigPath(".npmrc.example"), false);
  assert.equal(isPackageManagerConfigPath(".yarn/cache/pkg.zip"), false);
});

test("scope integrity rejects added, modified, and deleted package-manager config", () => {
  assert.deepEqual(
    detectScopeViolations(
      new Map([
        [".yarnrc.yml", "old-yarn-config"],
        ["packages/api/.npmrc", "old-npm-config"],
      ]),
      new Map([
        ["packages/api/.npmrc", "injected-script-shell"],
        ["pnpm-workspace.yaml", "injected-workspace-config"],
      ]),
    ),
    [
      {
        path: ".yarnrc.yml",
        kind: "runner-config-tampering",
        change: "deleted",
      },
      {
        path: "packages/api/.npmrc",
        kind: "runner-config-tampering",
        change: "modified",
      },
      {
        path: "pnpm-workspace.yaml",
        kind: "runner-config-injection",
        change: "added",
      },
    ],
  );
});

test("scope snapshots do not hide an injected npmrc symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-package-config-"));
  try {
    const before = snapshotTree(root);
    fs.symlinkSync("attacker-controlled-npmrc", path.join(root, ".npmrc"));
    const violations = detectScopeViolations(before, snapshotTree(root));
    assert.deepEqual(violations, [{
      path: ".npmrc",
      kind: "runner-config-injection",
      change: "added",
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
