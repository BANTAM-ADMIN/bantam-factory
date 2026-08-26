// Operator ask (2026-08-25): network is OFF by default; an internet fetch
// should pause and ask — allow once, allow for the session, or decline —
// and --dangerously-allow-net bypasses the asking entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor } from "../src/executor.js";

function makeWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "bantam-net-")); }
const FETCH = { a: "shell", c: "git clone http://127.0.0.1:1/tools.git cloned-tools" };

test("no hook (headless): classified fetch is refused, command never runs", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: false });
  const r = await ex.execute(FETCH);
  assert.match(r.observation, /\[network-blocked\]/);
  assert.ok(!fs.existsSync(path.join(ws, "cloned-tools")));
});

test("operator declines: refusal carries the declined note; command never runs", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: false, onNetRequest: async () => { asked++; return "deny"; } });
  const r = await ex.execute(FETCH);
  assert.equal(asked, 1);
  assert.match(r.observation, /operator was asked and DECLINED/);
  assert.ok(!fs.existsSync(path.join(ws, "cloned-tools")));
});

test("allow-once: the command executes (and fails on its own merits), next fetch asks again", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: false, onNetRequest: async () => { asked++; return "allow-once"; } });
  const r = await ex.execute(FETCH);
  assert.doesNotMatch(String(r.observation), /\[network-blocked\]/, "executed for real");
  await ex.execute(FETCH);
  assert.equal(asked, 2, "a one-time grant does not persist");
});

test("allow-session: shellNetwork flips on; no further asking", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: false, onNetRequest: async () => { asked++; return "allow-session"; } });
  await ex.execute(FETCH);
  await ex.execute(FETCH);
  assert.equal(asked, 1);
  assert.equal(ex.shellNetwork, true);
});

test("a throwing hook declines safely", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: false, onNetRequest: async () => { throw new Error("ui died"); } });
  const r = await ex.execute(FETCH);
  assert.match(r.observation, /DECLINED/);
});

test("shellNetwork true (the dangerously flag's effect): no classification, no asking", async (t) => {
  const ws = makeWs(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let asked = 0;
  const ex = new Executor(ws, { shellSandbox: "host", shellNetwork: true, onNetRequest: async () => { asked++; return "deny"; } });
  const r = await ex.execute(FETCH);
  assert.equal(asked, 0);
  assert.doesNotMatch(String(r.observation), /\[network-blocked\]/);
});
