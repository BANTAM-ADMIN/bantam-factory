// A swap had no post-condition. Measured 2026-08-22 against a decoy server:
// startRegisteredModel printed "Model is up." for a launch script that started
// nothing, swapModel returned {ok:true, ms:3} after its stop step returned
// false, and a registry saying slots=2 was satisfied by a server reporting 4.
// Every one of those reported success with the machine in the wrong state.
// These are the gates. They fail closed, and they name what they saw.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test, { after } from "node:test";

import { startRegisteredModel, swapModel, switchToModel } from "../src/model-launcher.js";
import { liveModelLockHolders, modelLockPath } from "../src/model-lock.js";

const cleanups = [];
after(() => { for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } } });

function haveFuser() {
  try { execFileSync("which", ["fuser"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** A registry whose scripts exist on disk, driven through the real loader. */
function withRegistry(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-postcond-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const priorModels = process.env.BANTAM_MODELS;
  const priorLedger = process.env.BANTAM_SWAP_LEDGER;
  cleanups.push(() => {
    if (priorModels === undefined) delete process.env.BANTAM_MODELS; else process.env.BANTAM_MODELS = priorModels;
    if (priorLedger === undefined) delete process.env.BANTAM_SWAP_LEDGER; else process.env.BANTAM_SWAP_LEDGER = priorLedger;
  });
  for (const m of models) {
    m.script ??= path.join(dir, `${m.name}.sh`);
    if (!fs.existsSync(m.script)) fs.writeFileSync(m.script, "#!/usr/bin/env bash\nexit 0\n");
  }
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify(models));
  process.env.BANTAM_MODELS = file;
  process.env.BANTAM_SWAP_LEDGER = path.join(dir, "ledger.json");
  return dir;
}

/** A server that answers /health and reports `slots` slots — the decoy. */
async function decoy({ slots = 4, id = "qwen3-8b-q4" } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end("{}"); return; }
    if (req.url === "/slots") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.from({ length: slots }, () => ({ n_ctx: 1 }))));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test("a launch script that starts nothing is not 'up' just because the port answers", { skip: haveFuser() ? false : "fuser not available" }, async () => {
  const { endpoint } = await decoy({ slots: 4 });
  withRegistry([{ name: "decoy", endpoint, slots: 4 }]);
  const target = { name: "decoy", endpoint, slots: 4, script: null };
  // Point at a script that exits immediately without starting anything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noop-launch-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  target.script = path.join(dir, "noop.sh");
  fs.writeFileSync(target.script, "#!/usr/bin/env bash\nexit 0\n");

  let said = "";
  const got = await startRegisteredModel(target, { waitMs: 5000, out: (s) => { said += s; } });
  assert.equal(got, null, "the pre-existing server must not count as our launch");
  assert.match(said, /still held/i, `the message must name what it saw, got: ${said}`);
});

test("a swap whose stop failed refuses, and never starts anything", async () => {
  withRegistry([{ name: "target", endpoint: "http://127.0.0.1:1" }]);
  let started = false;
  const r = await swapModel("target", {
    out: () => {},
    stop: async () => false,
    start: async () => { started = true; return "http://127.0.0.1:1"; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not|still/i);
  assert.equal(started, false, "a failed stop must not be followed by a start");
});

test("a swap verifies the profile that is actually resident", async () => {
  const { endpoint } = await decoy({ slots: 4 });
  withRegistry([{ name: "twoslot", endpoint, slots: 2 }]);
  const r = await swapModel("twoslot", {
    out: () => {},
    stop: async () => true,
    start: async (target) => target.endpoint,
  });
  assert.equal(r.ok, false, "registry says 2 slots, the live server reports 4");
  assert.match(r.error, /4/);
  assert.match(r.error, /2/);
});

test("a matching profile passes the same gate", async () => {
  const { endpoint } = await decoy({ slots: 2 });
  withRegistry([{ name: "twoslot", endpoint, slots: 2 }]);
  const r = await swapModel("twoslot", { out: () => {}, stop: async () => true, start: async (t) => t.endpoint });
  assert.equal(r.ok, true, r.error);
});

test("an unverifiable profile is reported as unverified, not silently passed", async () => {
  withRegistry([{ name: "bare", endpoint: "http://127.0.0.1:1" }]);
  const r = await swapModel("bare", { out: () => {}, stop: async () => true, start: async (t) => t.endpoint });
  assert.equal(r.ok, true);
  assert.match(String(r.unverified), /neither slots nor match/i, "the absence of a check must be visible, not assumed");
});

test("a swap refuses while another live run holds the model lock", async () => {
  const dir = withRegistry([{ name: "held", endpoint: "http://127.0.0.1:8085" }]);
  const lockDir = path.join(dir, "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore" });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const file = modelLockPath({ endpoint: "http://127.0.0.1:8085", lockDir });
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));

  const holders = liveModelLockHolders({ endpoint: "http://127.0.0.1:8085", lockDir });
  assert.equal(holders.length, 1);
  assert.equal(holders[0].pid, child.pid);

  let started = false;
  const r = await swapModel("held", {
    out: () => {},
    lockDir,
    stop: async () => true,
    start: async () => { started = true; return "http://127.0.0.1:8085"; },
  });
  assert.equal(r.ok, false, "a swap restarts the server and would kill the holder's run");
  assert.match(r.error, new RegExp(String(child.pid)));
  assert.equal(started, false);

  // A dead holder is not a holder: the lock is stale, the swap proceeds.
  child.kill("SIGKILL");
  await new Promise((r2) => setTimeout(r2, 300));
  assert.deepEqual(liveModelLockHolders({ endpoint: "http://127.0.0.1:8085", lockDir }), []);
});

test("an explicit force overrides the lock, because the operator may mean it", async () => {
  const dir = withRegistry([{ name: "held", endpoint: "http://127.0.0.1:1" }]);
  const lockDir = path.join(dir, "locks2");
  fs.mkdirSync(lockDir, { recursive: true });
  const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore" });
  cleanups.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  fs.writeFileSync(modelLockPath({ endpoint: "http://127.0.0.1:1", lockDir }), JSON.stringify({ pid: child.pid }));
  const r = await swapModel("held", {
    out: () => {}, lockDir, force: true,
    stop: async () => true, start: async (t) => t.endpoint,
  });
  assert.equal(r.ok, true, r.error);
});

test("`:model X` does not call a different resident profile 'already running'", async () => {
  // Every profile in the real registry shares one endpoint and declares no
  // `match`, so switchToModel's already-healthy branch accepted whatever was
  // loaded. A 4-slot crew server satisfied a request for the 2-slot profile.
  const { endpoint } = await decoy({ slots: 4 });
  const dir = withRegistry([{ name: "twoslot", endpoint, slots: 2 }]);
  const target = { name: "twoslot", label: "twoslot", endpoint, slots: 2, script: path.join(dir, "twoslot.sh") };
  const switched = [];
  const model = { switchTo: (ep, opts) => switched.push([ep, opts]) };
  let said = "";

  const ok = await switchToModel(model, target, {
    out: (s) => { said += s; },
    // The server cannot be stopped here (it is the test's own decoy), so the
    // assertion is that it REFUSED rather than declaring victory.
    stop: async () => false,
  });
  assert.equal(ok, false, "a 4-slot server must not satisfy a 2-slot profile");
  assert.equal(switched.length, 0, "nothing should have been switched to");
  assert.match(said, /4 slot|different profile/i, `say what was seen, got: ${said}`);
});

test("switchToModel carries the profile through on a fresh start, not just when already up", async () => {
  const { endpoint } = await decoy({ slots: 2 });
  const dir = withRegistry([{ name: "twoslot", endpoint, slots: 2 }]);
  const target = { name: "twoslot", label: "twoslot", endpoint, slots: 2, profile: "qwen", script: path.join(dir, "twoslot.sh") };
  const switched = [];
  const ok = await switchToModel({ switchTo: (ep, opts) => switched.push([ep, opts]) }, target, { out: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(switched, [[endpoint, { profile: "qwen" }]]);
});
