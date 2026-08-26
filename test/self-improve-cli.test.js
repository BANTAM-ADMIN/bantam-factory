import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "bantam.js");
const temporary = [];

function cliChildEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  // The parent verifier deliberately carries this recursion marker. These
  // children are isolated CLI-front-door probes, not nested controller work.
  delete env.BANTAM_SELF_IMPROVE_CHILD;
  return env;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-cli-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "bantam",
    private: true,
    type: "module",
    bin: { bantam: "bin/bantam.js" },
    scripts: { test: "node --test test/*.test.js" },
  }));
  fs.writeFileSync(path.join(root, ".gitignore"), ".bantam/\nnode_modules/\n");
  fs.writeFileSync(path.join(root, "bin", "bantam.js"), "export {};\n");
  fs.writeFileSync(path.join(root, "bin", "run-dev.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(root, "src", "agent.js"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "self-improve.js"), "export {};\n");
  for (let index = 0; index < 6; index++) {
    fs.writeFileSync(path.join(root, "src", `module-${index}.js`), `export const value${index} = ${index};\n`);
  }
  return root;
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("self-improvement CLI front door", () => {
  it("runs a model-free, write-free plan before endpoint detection", () => {
    const workspace = fixture();
    const before = fs.readdirSync(workspace).sort();
    const result = spawnSync(process.execPath, [
      cli,
      "self-improve",
      "--plan",
      "--workspace",
      workspace,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: cliChildEnv({
        BANTAM_ENDPOINT: "http://127.0.0.1:1",
        BANTAM_NO_ROOSTER: "1",
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Self-improvement plan/);
    assert.match(result.stdout, /no .*files were changed/i);
    assert.deepEqual(fs.readdirSync(workspace).sort(), before);
    assert.equal(fs.existsSync(path.join(workspace, ".bantam")), false);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /model:|unreachable/i);
  });

  it("binds the default self-improvement workspace to this exact launcher checkout", () => {
    const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-cwd-"));
    temporary.push(unrelatedCwd);
    const result = spawnSync(process.execPath, [cli, "self-improve", "--plan"], {
      cwd: unrelatedCwd,
      encoding: "utf8",
      env: cliChildEnv({
        BANTAM_ENDPOINT: "http://127.0.0.1:1",
        BANTAM_NO_ROOSTER: "1",
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Self-improvement plan|No self-improvement candidates/);
    assert.equal(fs.existsSync(path.join(unrelatedCwd, ".bantam")), false);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /model:|unreachable/i);
  });

  it("rejects an explicit unrelated workspace without writing controller state", () => {
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-improve-invalid-"));
    temporary.push(unrelated);
    fs.mkdirSync(path.join(unrelated, "src"));
    fs.writeFileSync(path.join(unrelated, "package.json"), '{"name":"other","type":"module"}\n');
    const result = spawnSync(process.execPath, [
      cli,
      "self-improve",
      "--plan",
      "--workspace",
      unrelated,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: cliChildEnv({
        BANTAM_ENDPOINT: "http://127.0.0.1:1",
        BANTAM_NO_ROOSTER: "1",
      }),
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /exact Bantam development checkout/i);
    assert.equal(fs.existsSync(path.join(unrelated, ".bantam")), false);
  });

  it("documents the governed command without probing a model", () => {
    const result = spawnSync(process.execPath, [cli, "self-improve", "--help"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: cliChildEnv({ BANTAM_ENDPOINT: "http://127.0.0.1:1" }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /private exact lane/);
    assert.match(result.stdout, /--no-apply/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /model:|unreachable/i);
  });

  it("treats --dry-run as model-free planning and rejects safety-flag typos", () => {
    const dryRun = spawnSync(process.execPath, [cli, "self-improve", "--dry-run"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: cliChildEnv({ BANTAM_ENDPOINT: "http://127.0.0.1:1" }),
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Self-improvement plan|No self-improvement candidates/);
    assert.doesNotMatch(`${dryRun.stdout}\n${dryRun.stderr}`, /unreachable/i);

    const typo = spawnSync(process.execPath, [
      cli,
      "self-improve",
      "--plan",
      "--no-aply",
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: cliChildEnv({ BANTAM_ENDPOINT: "http://127.0.0.1:1" }),
    });
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /does not recognize --no-aply/i);
  });
});
