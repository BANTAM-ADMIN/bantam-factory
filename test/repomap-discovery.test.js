import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  mapTool,
  mapUsable,
  repoMapCandidates,
  resolveRepoMapDir,
} from "../src/logic/repomap.js";
import { buildToolRegistry } from "../src/logic/tools.js";

const created = [];
const originalEnv = {
  BANTAM_MAP_MIN_FILES: process.env.BANTAM_MAP_MIN_FILES,
  BANTAM_NO_MAP: process.env.BANTAM_NO_MAP,
  BANTAM_REPOMAP_DIR: process.env.BANTAM_REPOMAP_DIR,
};

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function jsWorkspace() {
  const workspace = tempDir("bantam-repomap-workspace-");
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(
      path.join(workspace, `module-${i}.js`),
      `export function module${i}() { return ${i}; }\n`,
    );
  }
  return workspace;
}

function fakeRepoMap(marker = "override-map") {
  const dir = tempDir("bantam-repomap-implementation-");
  fs.writeFileSync(
    path.join(dir, "extract_js.cjs"),
    'process.stdout.write(JSON.stringify({ files: [] }));\n',
  );
  fs.writeFileSync(
    path.join(dir, "query.py"),
    [
      "import pathlib",
      "import sys",
      `print("${marker}:" + pathlib.Path.cwd().name + ":" + sys.argv[1])`,
      "",
    ].join("\n"),
  );
  return dir;
}

function restoreEnv() {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv();
  while (created.length) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
});

describe("repo_map discovery", () => {
  it("derives the bundled and exact sibling candidates from the module location", () => {
    const moduleDir = path.join(
      path.sep,
      "fixture",
      "BANTAM",
      "BANTAMBUILD",
      "src",
      "logic",
    );
    assert.deepEqual(repoMapCandidates(moduleDir), {
      bundledDir: path.join(path.sep, "fixture", "BANTAM", "BANTAMBUILD", "repo_map"),
      siblingDir: path.join(path.sep, "fixture", "BANTAM", "repo_map"),
    });
  });

  it("finds the exact sibling used by the BANTAMBUILD development layout", () => {
    delete process.env.BANTAM_REPOMAP_DIR;
    const layout = tempDir("bantam-repomap-layout-");
    const build = path.join(layout, "BANTAMBUILD");
    const bundled = path.join(build, "repo_map");
    const sibling = path.join(layout, "repo_map");
    fs.mkdirSync(build);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "query.py"), "print('fixture')\n");

    assert.equal(fs.existsSync(bundled), false, "fixture expects no bundled repo_map");
    assert.equal(fs.statSync(path.join(sibling, "query.py")).isFile(), true);
    assert.equal(
      resolveRepoMapDir(undefined, { bundledDir: bundled, siblingDir: sibling }),
      fs.realpathSync(sibling),
    );
  });

  it("uses BANTAM_REPOMAP_DIR for both registry gating and map execution", () => {
    const workspace = jsWorkspace();
    const implementation = fakeRepoMap();
    const laterImplementation = fakeRepoMap("late-map");
    process.env.BANTAM_REPOMAP_DIR = implementation;
    process.env.BANTAM_MAP_MIN_FILES = "1";
    delete process.env.BANTAM_NO_MAP;

    assert.equal(mapUsable(workspace), true);
    const registry = buildToolRegistry({
      workspace,
      stats: { files: 5, refreshes: 0 },
      mapRevision: 0,
    });
    const map = registry.get("map");

    assert.ok(map, "the validated override should pass the availability gate");
    // The registry must execute the implementation that passed its gate even
    // if an ambient variable changes before the lazy first query.
    process.env.BANTAM_REPOMAP_DIR = laterImplementation;
    assert.equal(map.answer("brief"), `override-map:${path.basename(implementation)}:brief`);
  });

  it("treats an invalid explicit override as authoritative and fails closed", () => {
    const workspace = jsWorkspace();
    const missing = path.join(tempDir("bantam-repomap-missing-"), "does-not-exist");
    process.env.BANTAM_REPOMAP_DIR = missing;
    process.env.BANTAM_MAP_MIN_FILES = "1";
    delete process.env.BANTAM_NO_MAP;

    assert.equal(resolveRepoMapDir(), null);
    assert.equal(mapUsable(workspace), false);
    assert.equal(
      buildToolRegistry({
        workspace,
        stats: { files: 5, refreshes: 0 },
        mapRevision: 0,
      }).get("map"),
      undefined,
    );
    assert.match(
      mapTool(workspace).answer("brief"),
      /^\[map\] unavailable: repo_map extractor directory is unavailable or invalid$/,
    );
  });

  it("rejects an override that has a query script but lacks the needed extractor", () => {
    const workspace = jsWorkspace();
    const incomplete = tempDir("bantam-repomap-incomplete-");
    fs.writeFileSync(path.join(incomplete, "query.py"), "print('must not run')\n");
    process.env.BANTAM_REPOMAP_DIR = incomplete;
    process.env.BANTAM_MAP_MIN_FILES = "1";

    assert.equal(mapUsable(workspace), false);
    assert.match(
      mapTool(workspace).answer("brief"),
      /^\[map\] unavailable: repo_map extractor directory is unavailable or invalid$/,
    );
  });

  it("keeps extracted structure private and removes it when the tool is disposed", () => {
    const workspace = jsWorkspace();
    const implementation = tempDir("bantam-repomap-private-");
    fs.writeFileSync(
      path.join(implementation, "extract_js.cjs"),
      'process.stdout.write(JSON.stringify({ files: [] }));\n',
    );
    fs.writeFileSync(
      path.join(implementation, "query.py"),
      [
        "import os",
        "import stat",
        "artifact = os.environ['STRUCT']",
        "file_mode = oct(stat.S_IMODE(os.stat(artifact).st_mode))",
        "dir_mode = oct(stat.S_IMODE(os.stat(os.path.dirname(artifact)).st_mode))",
        "print(artifact + '|' + file_mode + '|' + dir_mode)",
        "",
      ].join("\n"),
    );

    const map = mapTool(workspace, { rmDir: implementation });
    const [artifact, fileMode, dirMode] = map.answer("brief").split("|");
    assert.equal(fileMode, "0o600");
    assert.equal(dirMode, "0o700");
    assert.equal(fs.statSync(artifact).isFile(), true);

    map.dispose();
    assert.equal(fs.existsSync(artifact), false);
  });
});
