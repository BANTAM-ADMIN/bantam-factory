import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const app = path.resolve(process.env.REPOBRIEF_CANDIDATE_ROOT ?? process.cwd(), "bin/repobrief.js");

function fixtureEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

export function tempDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repobrief-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

export function write(root, relative, body) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

export function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 7000,
    env: fixtureEnvironment(),
  }).trimEnd();
}

export function repository(t, { files = { "tracked.txt": "original\n" }, commit = true } = {}) {
  const parent = tempDirectory(t);
  const root = path.join(parent, "repository with spaces");
  fs.mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "RepoBrief Test");
  git(root, "config", "user.email", "repobrief-test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  if (commit) {
    git(root, "add", "--all");
    git(root, "commit", "--allow-empty", "-m", "fixture baseline");
  }
  return fs.realpathSync(root);
}

export function cli(root, args, { cwd = root } = {}) {
  const result = spawnSync(process.execPath, [app, ...args], {
    cwd, encoding: "utf8", timeout: 7000, maxBuffer: 1024 * 1024,
    env: fixtureEnvironment(),
  });
  assert.equal(result.error, undefined, `CLI transport failed: ${result.error?.message}`);
  assert.equal(result.signal, null, `CLI terminated by ${result.signal}: ${result.stderr}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function successJson(root, args, options) {
  const result = cli(root, args, options);
  assert.equal(result.status, 0, `expected CLI success: ${result.stderr}\n${result.stdout}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout must be one JSON value: ${error.message}\n${result.stdout}`); }
  return parsed;
}

export function failure(root, args, options) {
  const result = cli(root, args, options);
  assert.equal(result.status, 1, `expected exit 1: ${JSON.stringify(result)}`);
  assert.ok(result.stderr.trim(), "a useful stderr error is required");
  return result;
}

export const sha256 = body => crypto.createHash("sha256").update(body).digest("hex");
export function expectedCapture(root, relativePaths) {
  const files = Object.fromEntries([...relativePaths].sort().map(p => [p, sha256(fs.readFileSync(path.join(root, p)))]));
  const treeDigest = sha256(Object.keys(files).sort().map(p => p + "\0" + files[p] + "\n").join(""));
  return { files, treeDigest };
}

export function childArgs(script, ...args) {
  return [process.execPath, "-e", script, ...args];
}

export function receipts(root) {
  const value = successJson(root, ["receipts", "--repo", root, "--json"]);
  assert.ok(Array.isArray(value.receipts));
  return value.receipts;
}
