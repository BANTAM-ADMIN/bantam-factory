import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  compileCompareSummary,
  runCompare,
} from "../src/logic/compare-plan.js";

const temporary = new Set();

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(dir);
  return dir;
}

function passingResult(editable, files = {}) {
  return {
    public: { pass: true },
    contract: { passed: 1, tests: 1 },
    scope: { editable: [...editable], violations: [] },
    files,
    durationMs: 1,
  };
}

afterEach(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  temporary.clear();
});

describe("comparison workspace isolation", () => {
  it("starts every arm from one immutable baseline and carries editable scope", async () => {
    const source = tempDir("bantam-compare-source-");
    const output = tempDir("bantam-compare-output-");
    fs.writeFileSync(path.join(source, "shared.txt"), "baseline\n");
    fs.writeFileSync(path.join(source, "untouched.txt"), "same\n");

    const starts = new Map();
    const workspaces = new Set();
    const result = await runCompare({
      task: "change shared.txt",
      workspace: source,
      out: output,
      only: ["bantam-dev", "bantam-regular"],
      editable: ["shared.txt"],
      runArm: async ({ armId, workspace, editable }) => {
        workspaces.add(workspace);
        starts.set(armId, fs.readFileSync(path.join(workspace, "shared.txt"), "utf8"));
        assert.equal(fs.existsSync(path.join(workspace, "written-by-prior-arm.txt")), false);
        fs.writeFileSync(path.join(workspace, "shared.txt"), `${armId}\n`);
        fs.writeFileSync(path.join(workspace, "written-by-prior-arm.txt"), `${armId}\n`);
        return passingResult(editable, {
          "shared.txt": `${armId}\n`,
        });
      },
    });

    assert.deepEqual(Object.fromEntries(starts), {
      "bantam-dev": "baseline\n",
      "bantam-regular": "baseline\n",
    });
    assert.equal(workspaces.size, 2);
    assert.equal(fs.readFileSync(path.join(source, "shared.txt"), "utf8"), "baseline\n");
    assert.deepEqual(result.summary.editable, ["shared.txt"]);
    assert.deepEqual(result.summary.arms[0].scope.editable, ["shared.txt"]);

    const persisted = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
    assert.deepEqual(persisted.editable, ["shared.txt"]);
  });

  it("rejects source symlinks before running any arm", async () => {
    const source = tempDir("bantam-compare-symlink-source-");
    const outside = tempDir("bantam-compare-symlink-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    fs.symlinkSync(outside, path.join(source, "escape"));
    let ran = false;

    await assert.rejects(
      runCompare({
        task: "inspect",
        workspace: source,
        out: tempDir("bantam-compare-symlink-output-"),
        only: ["bantam-dev"],
        runArm: async () => {
          ran = true;
          return passingResult([]);
        },
      }),
      /contains a symlink: escape/,
    );
    assert.equal(ran, false);
  });

  it("rejects an authored symlink created by an arm", async () => {
    const source = tempDir("bantam-compare-post-symlink-source-");
    const outside = tempDir("bantam-compare-post-symlink-outside-");
    fs.writeFileSync(path.join(source, "source.txt"), "baseline\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");

    await assert.rejects(
      runCompare({
        task: "inspect",
        workspace: source,
        out: tempDir("bantam-compare-post-symlink-output-"),
        only: ["bantam-dev"],
        runArm: async ({ workspace }) => {
          fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
          return passingResult([], { "escape.txt": "forged\n" });
        },
      }),
      /contains a symlink: escape\.txt/,
    );
  });

  it("recomputes files and scope instead of trusting an arm result", async () => {
    const source = tempDir("bantam-compare-regrade-source-");
    fs.writeFileSync(path.join(source, "source.txt"), "baseline\n");

    const result = await runCompare({
      task: "change source",
      workspace: source,
      out: tempDir("bantam-compare-regrade-output-"),
      only: ["bantam-dev"],
      editable: ["allowed.txt"],
      runArm: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, "source.txt"), "changed\n");
        return passingResult(["forged-scope"], { "forged.txt": "not present\n" });
      },
    });

    assert.deepEqual(result.results["bantam-dev"].scope.editable, ["allowed.txt"]);
    assert.deepEqual(result.results["bantam-dev"].scope.violations, [{
      path: "source.txt",
      kind: "out-of-scope",
      change: "modified",
    }]);
    assert.deepEqual(result.results["bantam-dev"].files, { "source.txt": "changed\n" });
  });

  it("does not run external arms without explicit consent", async () => {
    const source = tempDir("bantam-compare-consent-source-");
    fs.writeFileSync(path.join(source, "source.txt"), "baseline\n");
    let calls = 0;

    const result = await runCompare({
      task: "inspect",
      workspace: source,
      out: tempDir("bantam-compare-consent-output-"),
      only: ["codex"],
      runArm: async () => {
        calls++;
        return passingResult([]);
      },
    });

    assert.equal(calls, 0);
    assert.deepEqual(result.results, {});
  });
});

describe("compileCompareSummary", () => {
  it("preserves normalized editable scope in the top-level and arm views", () => {
    const summary = compileCompareSummary({
      task: "repair",
      editable: ["./src/", "src/"],
      results: {
        "bantam-dev": passingResult(["arm-supplied-substitute/"]),
      },
    });

    assert.deepEqual(summary.editable, ["src/"]);
    assert.deepEqual(summary.arms.find((arm) => arm.id === "bantam-dev").scope.editable, ["src/"]);
  });
});
