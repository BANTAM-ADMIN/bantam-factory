import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { launchPinnedChannel } from "../src/channel-launcher.js";
import { LaneStore } from "../src/lane-store.js";

const temporary = new Set();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(directory);
  return directory;
}

function writeFile(root, relative, contents) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
  return destination;
}

function childStub() {
  return [
    'import fs from "node:fs";',
    "const descriptor = process.env.BANTAM_PINNED_BINDING_FD;",
    "const binding = descriptor",
    '  ? JSON.parse(fs.readFileSync(Number(descriptor), "utf8"))',
    "  : null;",
    "const dependency = process.env.BANTAM_TEST_IMPORT",
    "  ? (await import(process.env.BANTAM_TEST_IMPORT)).value",
    "  : null;",
    "fs.writeFileSync(process.env.BANTAM_TEST_LAUNCH_OUTPUT, JSON.stringify({",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  depth: process.env.BANTAM_CHANNEL_LAUNCH_DEPTH,",
    '  hasNodeOptions: Object.hasOwn(process.env, "NODE_OPTIONS"),',
    '  hasNodePath: Object.hasOwn(process.env, "NODE_PATH"),',
    "  bindingDescriptor: descriptor ?? null,",
    "  binding,",
    "  dependency,",
    "  marker: process.env.BANTAM_TEST_MARKER ?? null,",
    "}));",
    "if (process.env.BANTAM_TEST_SELF_SIGNAL) {",
    "  process.kill(process.pid, process.env.BANTAM_TEST_SELF_SIGNAL);",
    "} else {",
    "  process.exit(Number(process.env.BANTAM_TEST_EXIT_CODE ?? 0));",
    "}",
    "",
  ].join("\n");
}

function fixture({
  manifest = {},
  packageText = null,
  cli = childStub(),
  extraFiles = {},
  symlink = null,
} = {}) {
  const root = tempDir("bantam-channel-launcher-");
  const harness = path.join(root, "harness");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(path.join(harness, "bin"), { recursive: true });
  const packageJson = packageText ?? `${JSON.stringify({
    name: "pinned-launcher-fixture",
    version: "1.0.0",
    type: "module",
    ...manifest,
  })}\n`;
  writeFile(harness, "package.json", packageJson);
  if (cli !== null) writeFile(harness, "bin/bantam.js", cli);
  for (const [relative, contents] of Object.entries(extraFiles)) {
    writeFile(harness, relative, contents);
  }
  if (symlink) {
    fs.symlinkSync(symlink.target, path.join(harness, symlink.relative));
  }

  const store = new LaneStore(stateHome);
  const checkpoint = store.workspaces.capture(harness, {
    message: "channel launcher fixture",
  });
  const versionRef = store.putVersion({
    kind: "bantam.harness-workspace",
    workspaceCommit: checkpoint.commit,
    workspaceTree: checkpoint.tree,
    files: checkpoint.files,
  });
  store.initChannel("dev", versionRef);
  const lane = store.createLane({
    laneId: "launcher-lane",
    channel: "dev",
    sourceWorkspace: harness,
  });
  return { root, harness, stateHome, store, checkpoint, versionRef, lane };
}

function launch(state, overrides = {}) {
  return launchPinnedChannel({
    store: state.store,
    channel: "dev",
    laneId: state.lane.laneId,
    expectedVersionRef: state.versionRef,
    ...overrides,
  });
}

function listenerCounts() {
  return Object.fromEntries(SIGNALS.map((signal) => [signal, process.listenerCount(signal)]));
}

afterEach(() => {
  for (const directory of temporary) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporary.clear();
});

describe("pinned channel launcher", () => {
  it("constructs an argv array without a shell, sanitizes Node injection, and preserves inputs", async () => {
    const state = fixture();
    const output = path.join(state.root, "result.json");
    const victim = path.join(state.root, "shell-expanded");
    const args = Object.freeze([
      "--task",
      `$(touch ${victim})`,
      "two words",
      "*.js",
      `;touch ${victim}`,
    ]);
    const env = Object.freeze({
      BANTAM_TEST_LAUNCH_OUTPUT: output,
      BANTAM_TEST_EXIT_CODE: "17",
      BANTAM_TEST_MARKER: "preserved",
      BANTAM_PINNED_BINDING_FD: "99",
      NODE_OPTIONS: "--require=/definitely/not/a/module",
      NODE_PATH: "/unverified/modules",
    });
    const beforeArgs = [...args];
    const beforeEnv = { ...env };
    const beforeListeners = listenerCounts();

    const code = await launch(state, { args, env });

    assert.equal(code, 17);
    assert.deepEqual(args, beforeArgs);
    assert.deepEqual(env, beforeEnv);
    assert.deepEqual(listenerCounts(), beforeListeners);
    assert.equal(fs.existsSync(victim), false);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(result.argv, [
      "run",
      "--lane", state.lane.laneId,
      "--state-home", state.stateHome,
      ...args,
    ]);
    assert.equal(result.cwd, state.lane.workspacePath);
    assert.equal(result.depth, "1");
    assert.equal(result.hasNodeOptions, false);
    assert.equal(result.hasNodePath, false);
    assert.equal(result.bindingDescriptor, null);
    assert.equal(result.marker, "preserved");
    assert.deepEqual(fs.readdirSync(path.join(state.stateHome, "harness-worktrees")), []);
  });

  it("provides experiment provenance over a private descriptor and removes launch files", async () => {
    const state = fixture();
    const output = path.join(state.root, "experiment.json");

    const code = await launch(state, {
      command: "experiment",
      args: ["spec file.json", "--dry-run"],
      env: { BANTAM_TEST_LAUNCH_OUTPUT: output },
    });

    assert.equal(code, 0);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(result.argv, [
      "experiment",
      "--lane", state.lane.laneId,
      "--state-home", state.stateHome,
      "spec file.json",
      "--dry-run",
    ]);
    assert.equal(result.bindingDescriptor, "3");
    assert.equal(result.binding.kind, "bantam.pinned-channel-launch");
    assert.equal(result.binding.channel, "dev");
    assert.equal(result.binding.laneId, state.lane.laneId);
    assert.equal(result.binding.stateHome, state.stateHome);
    assert.deepEqual(fs.readdirSync(path.join(state.stateHome, "harness-worktrees")), []);
  });

  it("propagates a child signal as the conventional process exit code", async () => {
    const state = fixture();
    const output = path.join(state.root, "signal.json");

    const code = await launch(state, {
      env: {
        BANTAM_TEST_LAUNCH_OUTPUT: output,
        BANTAM_TEST_SELF_SIGNAL: "SIGTERM",
      },
    });

    assert.equal(code, 143);
    assert.equal(fs.existsSync(output), true);
  });

  it("forwards a signal that arrives while the child process is being established", {
    skip: process.platform === "win32",
  }, async (t) => {
    const state = fixture();
    const output = path.join(state.root, "signal-race.json");
    const kills = [];
    const originalOn = process.on.bind(process);
    let injected = false;
    t.mock.method(process, "kill", (pid, signal) => {
      kills.push({ pid, signal });
      return true;
    });
    t.mock.method(process, "on", (eventName, listener) => {
      const result = originalOn(eventName, listener);
      if (!injected && eventName === "SIGTERM") {
        injected = true;
        listener();
      }
      return result;
    });

    const code = await launch(state, {
      env: { BANTAM_TEST_LAUNCH_OUTPUT: output },
    });

    assert.equal(code, 143);
    assert.equal(kills.length, 1);
    assert.equal(kills[0].signal, "SIGTERM");
    assert.ok(kills[0].pid < 0, "the detached child process group is targeted");
  });

  it("rejects recursive, mismatched, unsupported, and unhistorical launches", async () => {
    const state = fixture();

    await assert.rejects(
      launch(state, { env: { BANTAM_CHANNEL_LAUNCH_DEPTH: "1" } }),
      /recursive channel launch/i,
    );
    await assert.rejects(
      launch(state, { channel: "regular" }),
      /pinned to dev, not regular/i,
    );
    await assert.rejects(
      launch(state, { expectedVersionRef: "sha256:not-the-pinned-version" }),
      /harness ref mismatch/i,
    );
    await assert.rejects(
      launch(state, { command: "shell" }),
      /unsupported pinned harness command/i,
    );

    const status = state.store.status(state.lane.laneId);
    const unhistoricalStore = {
      root: state.store.root,
      status: () => status,
      channelHasVersion: () => false,
    };
    await assert.rejects(
      launchPinnedChannel({
        store: unhistoricalStore,
        channel: "dev",
        laneId: state.lane.laneId,
        expectedVersionRef: state.versionRef,
      }),
      /not in dev history/i,
    );
  });

  it("rejects attempts to override launcher-owned arguments and malformed tokens", async () => {
    const state = fixture();
    for (const args of [
      ["--lane", "other"],
      ["--lane=other"],
      ["--state-home", "/tmp/other"],
      ["--state-home=/tmp/other"],
      ["--workspace", "/tmp/other"],
      ["--workspace=/tmp/other"],
      ["--"],
    ]) {
      await assert.rejects(launch(state, { args }), /launcher owns|delimiter/i);
    }
    await assert.rejects(launch(state, { args: "not-an-array" }), /must be an array/i);
    await assert.rejects(launch(state, { args: [null] }), /must be strings/i);
    await assert.rejects(launch(state, { args: ["valid", 2] }), /must be strings/i);
    await assert.rejects(launch(state, { args: ["bad\0argument"] }), /NUL bytes/i);
    await assert.rejects(launch(state, { env: null }), /env must be an object/i);
    await assert.rejects(launch(state, { env: [] }), /env must be an object/i);
  });

  it("attaches only byte-matched dependencies from an explicit real directory", async () => {
    const state = fixture({
      manifest: { dependencies: { "fixture-dep": "1.0.0" } },
      extraFiles: { "package-lock.json": "fixture lock bytes\n" },
    });
    const dependencyRoot = path.join(state.root, "dependency-checkout");
    fs.mkdirSync(path.join(dependencyRoot, "node_modules", "fixture-dep"), { recursive: true });
    fs.copyFileSync(
      path.join(state.harness, "package.json"),
      path.join(dependencyRoot, "package.json"),
    );
    fs.copyFileSync(
      path.join(state.harness, "package-lock.json"),
      path.join(dependencyRoot, "package-lock.json"),
    );
    writeFile(
      dependencyRoot,
      "node_modules/fixture-dep/package.json",
      JSON.stringify({
        name: "fixture-dep",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFile(
      dependencyRoot,
      "node_modules/fixture-dep/index.js",
      'export const value = "verified dependency";\n',
    );

    await assert.rejects(
      launch(state),
      /--dependency-root DIR is required/i,
    );

    const output = path.join(state.root, "dependency.json");
    assert.equal(await launch(state, {
      dependencyRoot,
      env: {
        BANTAM_TEST_LAUNCH_OUTPUT: output,
        BANTAM_TEST_IMPORT: "fixture-dep",
      },
    }), 0);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).dependency, "verified dependency");

    fs.writeFileSync(path.join(dependencyRoot, "package-lock.json"), "changed lock\n");
    await assert.rejects(
      launch(state, { dependencyRoot }),
      /dependency package-lock\.json does not match pinned harness bytes/i,
    );

    const symlinkedRoot = path.join(state.root, "symlinked-dependencies");
    fs.symlinkSync(dependencyRoot, symlinkedRoot, "dir");
    await assert.rejects(
      launch(state, { dependencyRoot: symlinkedRoot }),
      /dependency root is not a real directory/i,
    );
  });

  it("rejects malformed manifests, missing CLIs, symlinks, and tree mismatches before spawning", async (t) => {
    const malformed = fixture({ packageText: "null\n" });
    await assert.rejects(
      launch(malformed),
      /invalid pinned package\.json.*object/i,
    );
    const malformedDependencies = fixture({
      manifest: { dependencies: ["not", "a", "map"] },
    });
    await assert.rejects(
      launch(malformedDependencies),
      /invalid pinned package\.json.*dependencies must be an object/i,
    );

    const missingCli = fixture({ cli: null });
    await assert.rejects(
      launch(missingCli),
      /pinned harness CLI does not exist/i,
    );

    const linked = fixture({
      symlink: { relative: "escape", target: "/tmp" },
    });
    await assert.rejects(
      launch(linked),
      /pinned harness contains a symbolic link: escape/i,
    );

    const mismatched = fixture();
    t.mock.method(mismatched.store.workspaces, "treeForWorkspace", () => ({
      tree: "not-the-recorded-tree",
      files: 0,
    }));
    await assert.rejects(
      launch(mismatched),
      /materialized harness bytes do not match recorded tree/i,
    );
  });

  it("rejects a planted worktree-root symlink", async () => {
    const state = fixture();
    const outside = path.join(state.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(state.stateHome, "harness-worktrees"), "dir");

    await assert.rejects(
      launch(state),
      /harness worktree root is not a real directory/i,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("cleans handlers and materialized bytes when process creation fails", async () => {
    const state = fixture();
    fs.rmSync(state.lane.workspacePath, { recursive: true, force: true });
    const beforeListeners = listenerCounts();

    await assert.rejects(
      launch(state, {
        env: { BANTAM_TEST_LAUNCH_OUTPUT: path.join(state.root, "never-written.json") },
      }),
      /ENOENT/,
    );

    assert.deepEqual(listenerCounts(), beforeListeners);
    assert.deepEqual(fs.readdirSync(path.join(state.stateHome, "harness-worktrees")), []);
  });
});
