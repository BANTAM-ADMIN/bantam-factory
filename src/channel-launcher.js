// Launch a lane with the exact immutable harness version it pinned.
//
// No shell is involved. The harness is materialized into a fresh private
// directory, checked against its recorded Git tree, then invoked with fixed
// lane/state arguments. Runtime dependencies are accepted only from an
// explicit checkout whose package and lockfile bytes match the pinned tree.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createPinnedLaunchAttestation,
  PINNED_BINDING_FD_ENV,
} from "./pinned-experiment-binding.js";

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const FORBIDDEN_FORWARD_FLAGS = ["--lane", "--state-home", "--workspace"];
const UNPINNED_NODE_ENV = ["NODE_OPTIONS", "NODE_PATH"];

export async function launchPinnedChannel({
  store,
  channel,
  laneId,
  expectedVersionRef,
  command = "run",
  dependencyRoot = null,
  args = [],
  env = process.env,
}) {
  assertEnvironment(env);
  if (String(env?.BANTAM_CHANNEL_LAUNCH_DEPTH ?? "")) {
    throw new Error("recursive channel launch is not allowed");
  }
  const lane = store.status(laneId);
  if (lane.channel !== channel) {
    throw new Error(`lane ${laneId} is pinned to ${lane.channel}, not ${channel}`);
  }
  if (lane.channelVersionRef !== expectedVersionRef) {
    throw new Error(
      `lane harness ref mismatch: expected ${expectedVersionRef}, found ${lane.channelVersionRef}`,
    );
  }
  if (!store.channelHasVersion(channel, expectedVersionRef)) {
    throw new Error(`lane harness ref is not in ${channel} history: ${expectedVersionRef}`);
  }
  const launchCommand = requireLaunchCommand(command);
  assertSafeForwardArgs(args);

  const runsRoot = path.join(store.root, "harness-worktrees");
  ensurePrivateDirectory(runsRoot);
  const destination = fs.mkdtempSync(path.join(runsRoot, `${channel}-`));
  try {
    const restored = store.materializeHarnessVersion(expectedVersionRef, destination);
    const actual = store.workspaces.treeForWorkspace(destination, {
      baselineCommit: restored.commit,
    });
    if (actual.tree !== restored.tree) {
      throw new Error(`materialized harness bytes do not match recorded tree: ${expectedVersionRef}`);
    }

    // A Git tree pins a symlink's target text, not the bytes it resolves to.
    // Reject links before attaching the one explicit, verified node_modules
    // link below, otherwise imports could escape into mutable host content.
    assertNoSymlinks(destination);
    const cli = requireRegularFile(path.join(destination, "bin", "bantam.js"), "pinned harness CLI");
    attachVerifiedDependencies(destination, dependencyRoot);
    const childEnv = { ...env, BANTAM_CHANNEL_LAUNCH_DEPTH: "1" };
    delete childEnv[PINNED_BINDING_FD_ENV];
    // Both variables can execute or resolve code before/from outside the
    // verified harness tree. Runtime selection must not be ambient.
    for (const name of UNPINNED_NODE_ENV) delete childEnv[name];
    let bindingDescriptor = null;
    let bindingDirectory = null;
    if (launchCommand === "experiment") {
      const opened = openBindingDescriptor(runsRoot, createPinnedLaunchAttestation({
        channel,
        laneId,
        stateHome: store.root,
        harnessRoot: destination,
      }));
      bindingDescriptor = opened.descriptor;
      bindingDirectory = opened.directory;
      childEnv[PINNED_BINDING_FD_ENV] = "3";
    }
    let child = null;
    let forwardedSignal = null;
    const signalHandlers = new Map();
    for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        if (forwardedSignal !== null) return;
        forwardedSignal = signalName;
        if (child) signalChildProcess(child, signalName);
      };
      signalHandlers.set(signalName, handler);
      process.on(signalName, handler);
    }
    try {
      child = spawn(process.execPath, [
        cli,
        launchCommand,
        "--lane", laneId,
        "--state-home", store.root,
        ...args,
      ], {
        cwd: lane.workspacePath,
        env: childEnv,
        stdio: bindingDescriptor === null
          ? "inherit"
          : ["inherit", "inherit", "inherit", bindingDescriptor],
        // Keep the pinned harness out of the selector's terminal process group.
        // The selector can then forward one signal deliberately instead of both
        // processes receiving the terminal signal and racing through cleanup.
        detached: process.platform !== "win32",
      });
      // A selector signal can arrive after handlers are installed but before
      // spawn returns. Deliver the remembered signal once the child exists.
      if (forwardedSignal !== null) signalChildProcess(child, forwardedSignal);
      if (bindingDescriptor !== null) {
        fs.closeSync(bindingDescriptor);
        bindingDescriptor = null;
        fs.rmSync(bindingDirectory, { recursive: true, force: true });
        bindingDirectory = null;
      }
      const result = await waitForChild(child);
      if (forwardedSignal !== null) return signalExitCode(forwardedSignal);
      if (Number.isInteger(result.code)) return result.code;
      return signalExitCode(result.signal);
    } finally {
      if (bindingDescriptor !== null) fs.closeSync(bindingDescriptor);
      if (bindingDirectory !== null) fs.rmSync(bindingDirectory, { recursive: true, force: true });
      for (const [signalName, handler] of signalHandlers) process.off(signalName, handler);
    }
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

function openBindingDescriptor(root, attestation) {
  const directory = fs.mkdtempSync(path.join(root, "binding-"));
  const file = path.join(directory, "launch.json");
  fs.writeFileSync(file, `${JSON.stringify(attestation)}\n`, { mode: 0o600 });
  return {
    descriptor: fs.openSync(file, "r"),
    directory,
  };
}

function requireLaunchCommand(value) {
  const command = String(value ?? "");
  if (command !== "run" && command !== "experiment") {
    throw new Error(`unsupported pinned harness command: ${command || "(missing)"}`);
  }
  return command;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function signalChildProcess(child, signalName) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signalName);
    else process.kill(-child.pid, signalName);
  } catch (error) {
    // The close event can race the selector's signal handler. A missing child
    // already reached the state we wanted; surface every other failure.
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalExitCode(signalName) {
  if (signalName === "SIGHUP") return 129;
  if (signalName === "SIGINT") return 130;
  if (signalName === "SIGTERM") return 143;
  if (signalName === "SIGKILL") return 137;
  return 1;
}

function assertNoSymlinks(root) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`pinned harness contains a symbolic link: ${path.relative(root, full)}`);
      }
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
}

function attachVerifiedDependencies(harnessRoot, dependencyRoot) {
  const harnessPackage = requireRegularFile(path.join(harnessRoot, "package.json"), "pinned package.json");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(harnessPackage, "utf8")); }
  catch (error) { throw new Error(`invalid pinned package.json: ${error.message}`); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("invalid pinned package.json: expected an object");
  }
  const dependencyCount = dependencyNames(manifest, "dependencies").length
    + dependencyNames(manifest, "optionalDependencies").length;
  if (dependencyCount === 0) return;
  if (!dependencyRoot) {
    throw new Error("pinned harness has dependencies; --dependency-root DIR is required");
  }

  const root = requireRealDirectory(path.resolve(dependencyRoot), "dependency root");
  if (pathsOverlap(root, harnessRoot)) throw new Error("dependency root must be outside the materialized harness");
  assertSameFile(harnessPackage, path.join(root, "package.json"), "package.json");
  for (const name of LOCKFILES) {
    const pinned = path.join(harnessRoot, name);
    const supplied = path.join(root, name);
    if (fs.existsSync(pinned) || fs.existsSync(supplied)) assertSameFile(pinned, supplied, name);
  }
  const modules = requireRealDirectory(path.join(root, "node_modules"), "dependency root node_modules");
  const destination = path.join(harnessRoot, "node_modules");
  if (fs.existsSync(destination)) throw new Error(`materialized harness unexpectedly contains node_modules: ${destination}`);
  fs.symlinkSync(modules, destination, "dir");
}

function assertSafeForwardArgs(args) {
  if (!Array.isArray(args)) throw new Error("forwarded harness arguments must be an array");
  for (const token of args) {
    if (typeof token !== "string") {
      throw new Error("forwarded harness arguments must be strings");
    }
    if (token.includes("\0")) {
      throw new Error("forwarded harness arguments must not contain NUL bytes");
    }
    if (token === "--") throw new Error("a second argument delimiter is not allowed");
    if (FORBIDDEN_FORWARD_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`))) {
      throw new Error(`channel launcher owns ${token.split("=")[0]}`);
    }
  }
}

function assertEnvironment(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("channel launcher env must be an object");
  }
}

function dependencyNames(manifest, field) {
  const value = manifest[field];
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid pinned package.json: ${field} must be an object`);
  }
  return Object.keys(value);
}

function ensurePrivateDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  requireRealDirectory(directory, "harness worktree root");
}

function requireRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new Error(`${label} does not exist: ${file}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file: ${file}`);
  return file;
}

function requireRealDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch { throw new Error(`${label} does not exist: ${directory}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
  return directory;
}

function assertSameFile(first, second, label) {
  const left = requireRegularFile(first, `pinned ${label}`);
  const right = requireRegularFile(second, `dependency ${label}`);
  if (!fs.readFileSync(left).equals(fs.readFileSync(right))) {
    throw new Error(`dependency ${label} does not match pinned harness bytes`);
  }
}

function pathsOverlap(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
