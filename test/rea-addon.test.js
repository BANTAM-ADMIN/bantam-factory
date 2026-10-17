import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REA_SOURCE, findReaRoot, installRea, nodeSupportsRea, reaAwarenessText, reaUnavailableReason, taskSuggestsRea,
} from "../src/rea-addon.js";
import { startReaMcpClient } from "../src/rea-mcp-client.js";
import { clipFullContext, oversizedReaResult } from "../src/executor.js";

function addonsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-rea-addon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fakeInstall = dir => {
  const root = path.join(dir, "rea", "node_modules", "rea-agents");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "rea.mjs"), "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "6.5.0" }));
  return root;
};

test("reverse-engineering tasks are recognized; ordinary coding tasks are not", () => {
  for (const task of ["what platform is game.smc for?", "inspect app.asar", "reverse engineer this firmware",
    "decompile Foo.class", "list the exports of lib.so"]) assert.ok(taskSuggestsRea(task), task);
  for (const task of ["add a health endpoint to server.js", "fix the failing test in src/app.ts",
    "write a README", "bump the version in package.json"]) assert.equal(taskSuggestsRea(task), false, task);
});

test("REA needs Node 22.19+, 24.11+ or 26+", () => {
  for (const v of ["22.19.0", "22.23.2", "24.11.0", "26.0.0"]) assert.ok(nodeSupportsRea(v), v);
  for (const v of ["20.18.0", "22.18.9", "23.5.0", "24.10.0"]) assert.equal(nodeSupportsRea(v), false, v);
});

test("REA is found by BANTAM_REA_ROOT first, then the add-on install, else reported missing", t => {
  const dir = addonsDir(t);
  const env = { BANTAM_ADDONS_DIR: dir };
  assert.equal(findReaRoot(env), null);
  assert.match(reaUnavailableReason(env), /bantam addons install rea/);
  const root = fakeInstall(dir);
  assert.equal(findReaRoot(env), root);
  assert.equal(findReaRoot({ ...env, BANTAM_REA_ROOT: "/elsewhere/rea" }), "/elsewhere/rea");
});

test("the client refuses to start without REA and says how to install it", async t => {
  const env = { ...process.env, BANTAM_ADDONS_DIR: addonsDir(t) };
  delete env.BANTAM_REA_ROOT; delete env.BANTAM_REA_MCP_ARGS;
  await assert.rejects(startReaMcpClient({ env }), /bantam addons install rea/);
});

test("install verifies the pinned fork tarball before npm sees it, and never runs REA's setup", async t => {
  const dir = addonsDir(t);
  const prior = process.env.BANTAM_ADDONS_DIR;
  process.env.BANTAM_ADDONS_DIR = dir;
  t.after(() => { if (prior === undefined) delete process.env.BANTAM_ADDONS_DIR; else process.env.BANTAM_ADDONS_DIR = prior; });
  if (!nodeSupportsRea()) return t.skip("this Node is below REA's range");
  const bytes = Buffer.from("fake tarball");
  const source = { version: "6.5.0", tarball: "https://example.test/dl/rea-agents-6.5.0.tgz",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  const calls = [];
  const run = (command, argv, opts) => { calls.push({ command, argv, cwd: opts.cwd }); fakeInstall(dir); return { status: 0 }; };
  const { root, version } = await installRea({ log() {}, run, source, download: async () => bytes });
  assert.equal(version, "6.5.0");
  assert.equal(root, path.join(dir, "rea", "node_modules", "rea-agents"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, path.join(dir, "rea"));
  const spec = calls[0].argv.at(-1);
  assert.equal(spec, path.join(dir, "rea", "rea-agents-6.5.0.tgz"));
  assert.deepEqual(fs.readFileSync(spec), bytes);
  assert.ok(!calls[0].argv.includes("setup"));
  await assert.rejects(installRea({ log() {}, run: () => ({ status: 1 }), source, download: async () => bytes }), /exited with status 1/);
  // A tampered or truncated download never reaches npm.
  const before = calls.length;
  await assert.rejects(installRea({ log() {}, run, source, download: async () => Buffer.from("tampered") }), /SHA-256 .* expected/);
  assert.equal(calls.length, before);
  // Without a tarball the source is a plain npm registry version.
  await installRea({ log() {}, run, source: { version: "7.0.0" }, download: async () => assert.fail("no download") });
  assert.equal(calls.at(-1).argv.at(-1), "rea-agents@7.0.0");
});

test("the pinned REA source is the BANTAM-ADMIN fork release, pinned by digest", () => {
  assert.match(REA_SOURCE.tarball, /^https:\/\/github\.com\/BANTAM-ADMIN\/rea\/releases\/download\//);
  assert.match(REA_SOURCE.sha256, /^[0-9a-f]{64}$/);
});

test("awareness text appears only for RE tasks without a connection, and never tells the model to install", t => {
  const env = { BANTAM_ADDONS_DIR: addonsDir(t) };
  assert.equal(reaAwarenessText("add a health endpoint", { env }), "");
  assert.equal(reaAwarenessText("inspect game.smc", { connected: true, env }), "");
  const missing = reaAwarenessText("inspect game.smc", { env });
  assert.match(missing, /not installed/);
  assert.match(missing, /Do not try to install or run it yourself/);
  if (nodeSupportsRea()) {
    fakeInstall(env.BANTAM_ADDONS_DIR);
    assert.match(reaAwarenessText("inspect game.smc", { env }), /installed but not enabled/);
  }
});

test("full-context output keeps everything up to its ceiling, then an even head and tail", () => {
  assert.equal(clipFullContext("x".repeat(100), "advice", 100), "x".repeat(100));
  const clipped = clipFullContext("A".repeat(60) + "Z".repeat(60), "read it in pages", 100);
  assert.ok(clipped.startsWith("A".repeat(50)) && clipped.endsWith("Z".repeat(50)));
  assert.match(clipped, /\[20 of 120 chars omitted; read it in pages\]/);
});

test("an oversized REA result is refused whole, never cut", () => {
  assert.equal(oversizedReaResult('{"rows":[]}', "open_binary", 100), '{"rows":[]}');
  const refused = oversizedReaResult(`{"rows":"${"r".repeat(200)}"}`, "open_binary", 100);
  assert.match(refused, /^ERROR: REA open_binary returned \d+ chars/);
  assert.match(refused, /Nothing from it was kept/);
  assert.doesNotMatch(refused, /rrrr/);
});
