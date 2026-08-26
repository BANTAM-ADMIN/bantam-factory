// A no-net sandbox turned a version bump into a million failed installers
// (operator report, 2026-08-25). The gauge names the wall on the second
// distinct acquisition failure so the cleverness goes back on the task.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WalledGardenGauge } from "../src/logic/walled-garden.js";

const sh = (c) => ({ a: "shell", c });

test("two DISTINCT failed acquisitions draw the steer; the first does not", () => {
  const g = new WalledGardenGauge();
  assert.equal(g.note({ action: sh("apt-get install -y golang-1.22"), observation: "E: Could not connect to deb.debian.org" }), null);
  const r = g.note({ action: sh("curl -LO https://go.dev/dl/go1.22.tgz"), observation: "curl: (6) Could not resolve host: go.dev" });
  assert.ok(r);
  assert.match(r.note, /\[walled-garden\] 2 different/);
  assert.match(r.note, /STOP trying to acquire/);
});

test("repeating the SAME command does not double-count; a third distinct one re-fires once", () => {
  const g = new WalledGardenGauge();
  g.note({ action: sh("wget https://x/y.tgz"), observation: "failed: Temporary failure in name resolution" });
  g.note({ action: sh("wget https://x/y.tgz"), observation: "failed: Temporary failure in name resolution" });
  assert.equal(g._attempts.size, 1);
  assert.ok(g.note({ action: sh("pip install requests"), observation: "Could not connect to pypi.org" }));
  assert.equal(g.note({ action: sh("pip install requests"), observation: "Could not connect to pypi.org" }), null, "same size, no re-fire");
});

test("non-acquisition failures and local errors never trip it", () => {
  const g = new WalledGardenGauge();
  assert.equal(g.note({ action: sh("npm test"), observation: "connection refused" }), null, "not an acquisition");
  assert.equal(g.note({ action: sh("pip install x"), observation: "ERROR: No matching distribution found" }), null, "not a network failure");
  assert.equal(g.note({ action: { a: "read_file", p: "x" }, observation: "network is unreachable" }), null);
});

test("go install and git clone count as acquisition", () => {
  const g = new WalledGardenGauge();
  g.note({ action: sh("go install golang.org/dl/go1.22@latest"), observation: "dial tcp: lookup proxy.golang.org: connection timed out" });
  const r = g.note({ action: sh("git clone https://github.com/golang/go"), observation: "fatal: unable to access: Could not resolve host: github.com" });
  assert.ok(r);
});

test("wired: the flailing install spiral hears the steer through the real dispatcher", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-wall-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  // Deterministic wall: port 1 on localhost refuses instantly, so the test
  // holds on machines WITH network (the first version assumed no net and the
  // real curl quietly succeeded — the instrument lied).
  // Loopback URLs pass the net-fetch classifier (local services are legal)
  // and port 1 refuses instantly — a real, deterministic network failure.
  const outputs = [];
  outputs.push(JSON.stringify(sh("curl --max-time 5 http://127.0.0.1:1/go1.22.tgz")));
  outputs.push(JSON.stringify(sh("curl -LO --max-time 5 http://127.0.0.1:1/golang.tar.gz")));
  outputs.push(JSON.stringify({ a: "done", summary: "Wall named; adapting to installed toolchain." }));
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: "Get the newer Go toolchain working.", workspace: ws, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const obs = result.turns.map((t2) => String(t2.observation ?? ""));
  assert.doesNotMatch(obs[0], /\[walled-garden\]/, "first wall hit: quiet");
  assert.match(obs[1], /\[walled-garden\] 2 different/, "second distinct wall hit draws the steer");
  assert.ok(result.metrics.walledGardenSteers >= 1);
});
