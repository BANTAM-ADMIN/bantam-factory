import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "bin", "run-dev.sh");
let tempDir;
let mockNode;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-run-dev-test-"));
  mockNode = path.join(tempDir, "mock-node");
  fs.writeFileSync(mockNode, "#!/usr/bin/env bash\nprintf 'mock-node:%s\\n' \"$*\"\n");
  fs.chmodSync(mockNode, 0o755);
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(launcher, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BANTAM_NODE_BIN: mockNode },
  });
}

function isolatedLauncher() {
  const fixtureRoot = fs.mkdtempSync(path.join(tempDir, "fixture-"));
  const binDir = path.join(fixtureRoot, "bin");
  fs.mkdirSync(binDir);
  fs.copyFileSync(launcher, path.join(binDir, "run-dev.sh"));
  fs.chmodSync(path.join(binDir, "run-dev.sh"), 0o755);
  fs.writeFileSync(path.join(binDir, "bantam.js"), "void 0;\n");
  return { fixtureRoot, launcher: path.join(binDir, "run-dev.sh") };
}

describe("development launcher", () => {
  it("runs smoke against this checkout's development entrypoint", () => {
    const result = run(["--smoke"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mock-node:.*\/bin\/bantam\.js health/);
    assert.match(result.stdout, /smoke OK — development Bantam is alive/);
  });

  it("maps the documented --task shorthand to the run command", () => {
    const result = run(["--task", "repair it", "--workspace", "/tmp/example"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /mock-node:.*\/bin\/bantam\.js run --task repair it --workspace \/tmp\/example/,
    );
  });

  it("passes explicit commands through unchanged", () => {
    const result = run(["health"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mock-node:.*\/bin\/bantam\.js health/);
    assert.doesNotMatch(result.stdout, /bantambuild\.js/);
  });

  it("refuses to trust a partial dependency directory", () => {
    const fixture = isolatedLauncher();
    fs.mkdirSync(path.join(fixture.fixtureRoot, "node_modules", "acorn"), { recursive: true });
    fs.mkdirSync(path.join(fixture.fixtureRoot, "node_modules", "acorn-walk"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.fixtureRoot, "node_modules", "acorn-walk", "package.json"),
      '{"version":"8.3.5"}\n',
    );

    const result = spawnSync(fixture.launcher, ["health"], {
      cwd: fixture.fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, BANTAM_NODE_BIN: mockNode },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing incomplete or mismatched dependency/);
    assert.equal(fs.existsSync(path.join(fixture.fixtureRoot, "node_modules", "acorn", "package.json")), false);
  });
});
