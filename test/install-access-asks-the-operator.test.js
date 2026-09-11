// Operator ask (2026-09-11): a package install in the offline Docker sandbox
// used to be a terminal block with only a prose remedy. The same operator hook
// that grants network for a classified fetch now grants it for a classified
// install — allow once, allow for the session, or decline — and --allow-installs
// (BANTAM_ALLOW_INSTALLS=1) pre-approves installs for a headless run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor } from "../src/executor.js";
import { classifyOfflineInstall } from "../src/offline-install.js";

function makeWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "bantam-install-")); }
const INSTALL = { a: "shell", c: "npm install lodash" };

function executor(ws, opts = {}) {
  // A fake docker runner: the test asserts the composed command, never shells out.
  const seen = { calls: 0, network: null, command: null };
  const ex = new Executor(ws, {
    shellSandbox: "docker",
    shellNetwork: false,
    processRunner: async (file, args) => {
      seen.calls++;
      seen.network = !args.includes("none");
      seen.command = args.at(-1);
      return { code: 0, stdout: "installed ok", stderr: "" };
    },
    ...opts,
  });
  return { ex, seen };
}

test("no hook (headless): an install stays a terminal block and never reaches docker", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const { ex, seen } = executor(ws);
  const r = await ex.execute(INSTALL);
  assert.ok(r.blocked, "still terminal without an operator decision");
  assert.equal(r.blocked.reason, "default-docker-no-network");
  assert.match(String(r.observation), /\[offline-install\]/);
  assert.equal(seen.calls, 0, "nothing was spawned");
});

test("operator approves once: the install runs with network, and the next one asks again", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex, seen } = executor(ws, {
    onNetRequest: async ({ command, kind }) => {
      asked++;
      assert.equal(command, "npm install lodash");
      assert.equal(kind, "install", "the hook is told this is an install, not a fetch");
      return "allow-once";
    },
  });
  const r = await ex.execute(INSTALL);
  assert.equal(asked, 1);
  assert.equal(seen.calls, 1, "the approved install ran");
  assert.equal(seen.network, true, "the approved command gets network");
  assert.equal(r.blocked, undefined);
  assert.match(String(r.observation), /installed ok/);
  await ex.execute(INSTALL);
  assert.equal(asked, 2, "a one-time grant does not persist");
  assert.equal(ex.shellNetwork, false);
});

test("allow-session flips shellNetwork on; the next install runs without asking", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex } = executor(ws, { onNetRequest: async () => { asked++; return "allow-session"; } });
  await ex.execute(INSTALL);
  await ex.execute(INSTALL);
  assert.equal(asked, 1);
  assert.equal(ex.shellNetwork, true);
});

test("a decline keeps the install blocked and says the operator declined", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const { ex, seen } = executor(ws, { onNetRequest: async () => "deny" });
  const r = await ex.execute(INSTALL);
  assert.ok(r.blocked);
  assert.match(String(r.observation), /DECLINED/);
  assert.equal(seen.calls, 0, "a declined install never runs");
});

test("a throwing hook declines safely", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const { ex, seen } = executor(ws, { onNetRequest: async () => { throw new Error("ui died"); } });
  const r = await ex.execute(INSTALL);
  assert.ok(r.blocked);
  assert.match(String(r.observation), /DECLINED/);
  assert.equal(seen.calls, 0);
});

test("installPolicy allow pre-approves each install with no hook and no TTY", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex, seen } = executor(ws, {
    installPolicy: "allow",
    onNetRequest: async () => { asked++; return "deny"; },
  });
  const r = await ex.execute(INSTALL);
  assert.equal(asked, 0, "an explicit allow policy does not prompt");
  assert.equal(seen.calls, 1);
  assert.equal(seen.network, true);
  assert.equal(r.blocked, undefined);
});

test("installPolicy deny wins even when a hook is wired", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex, seen } = executor(ws, {
    installPolicy: "deny",
    onNetRequest: async () => { asked++; return "allow-session"; },
  });
  const r = await ex.execute(INSTALL);
  assert.equal(asked, 0);
  assert.ok(r.blocked);
  assert.equal(seen.calls, 0);
});

test("BANTAM_ALLOW_INSTALLS=1 is the env form of --allow-installs", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const previous = process.env.BANTAM_ALLOW_INSTALLS;
  process.env.BANTAM_ALLOW_INSTALLS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.BANTAM_ALLOW_INSTALLS;
    else process.env.BANTAM_ALLOW_INSTALLS = previous;
  });
  const ex = new Executor(ws, {
    shellSandbox: "docker",
    shellNetwork: false,
    processRunner: async () => ({ code: 0, stdout: "installed ok", stderr: "" }),
  });
  assert.equal(ex.installPolicy, "allow");
  const r = await ex.execute(INSTALL);
  assert.equal(r.blocked, undefined);
});

test("an unknown installPolicy is rejected at construction", (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.throws(() => new Executor(ws, { shellSandbox: "docker", installPolicy: "maybe" }), /installPolicy/);
});

test("an exec-style offline block stays a retryable observation, never a prompt", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex } = executor(ws, { onNetRequest: async () => { asked++; return "allow-session"; } });
  const r = await ex.execute({ a: "shell", c: "npx tsc --noEmit" });
  assert.equal(asked, 0, "npx may already be local; no network decision is needed to say so");
  assert.equal(r.blocked, undefined);
  assert.match(String(r.observation), /node_modules\/\.bin/);
});

test("classification records where the install lands and whether it persists", () => {
  const project = classifyOfflineInstall("npm install lodash");
  assert.equal(project.scope, "project");
  assert.equal(project.persistent, true);

  const global = classifyOfflineInstall("npm install -g typescript");
  assert.equal(global.scope, "global");
  assert.equal(global.persistent, false);

  const system = classifyOfflineInstall("apk add --no-cache chromium");
  assert.equal(system.scope, "system");
  assert.equal(system.persistent, false);
  assert.match(system.message, /BANTAM_SHELL_MOUNT_RO/);
  assert.doesNotMatch(system.message, /node_modules\/\.bin/);

  const venv = classifyOfflineInstall("uv sync");
  assert.equal(venv.scope, "project");
});

test("a project tool's browser download is a network install, not an exec", () => {
  // The exact shape that ran offline and died on EAI_AGAIN at cdn.playwright.dev.
  for (const cmd of [
    "./node_modules/.bin/playwright install chromium",
    "npx playwright install chromium",
    "npm exec playwright install chromium",
    "playwright install chromium",
    "npx puppeteer browsers install chrome",
    "cypress install",
  ]) {
    const c = classifyOfflineInstall(cmd);
    assert.ok(c?.blocked, `${cmd} needs the operator's network decision`);
    assert.notEqual(c.operation, "exec", `${cmd} must not be treated as a local-binary exec`);
    assert.doesNotMatch(c.message, /node_modules\/\.bin/, "the exec fallback would send it straight back to the offline command");
  }
});

test("browser downloads are classified by scope and persist in the sandbox HOME", () => {
  const c = classifyOfflineInstall("./node_modules/.bin/playwright install chromium");
  assert.equal(c.ecosystem, "browser");
  assert.equal(c.scope, "browser");
  assert.equal(c.persistent, true);
  assert.match(c.message, /persistent sandbox HOME/);
});

test("the operator prompt fires for a playwright download, and approval runs it with network", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const { ex, seen } = executor(ws, {
    onNetRequest: async ({ kind, classification }) => {
      asked++;
      assert.equal(kind, "install");
      assert.equal(classification.ecosystem, "browser");
      return "allow-once";
    },
  });
  const r = await ex.execute({ a: "shell", c: "./node_modules/.bin/playwright install chromium" });
  assert.equal(asked, 1, "the download prompted instead of running offline");
  assert.equal(seen.calls, 1);
  assert.equal(seen.network, true);
  assert.equal(r.blocked, undefined);
});

test("without approval a browser download is blocked before it can fail on DNS", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const { ex, seen } = executor(ws);
  const r = await ex.execute({ a: "shell", c: "npx playwright install chromium" });
  assert.ok(r.blocked);
  assert.equal(seen.calls, 0, "no EAI_AGAIN: nothing spawned");
});

