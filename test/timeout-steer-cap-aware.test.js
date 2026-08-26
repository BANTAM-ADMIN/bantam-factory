import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Executor } from "../src/executor.js";

// TB2 rstan-to-pystan (2026-08-21). The task's core operation is MCMC sampling,
// which runs for minutes. Our shell cap is 90s, so it was killed at 43%. The run
// then did exactly what this steer told it to — backgrounded the job and polled
// with `sleep 90 && tail -5 /tmp/pystan_run.log` — and the POLL was killed by
// the very same 90s cap, at 85% sampled. The advice recommended a pattern the
// cap defeats, so following it correctly still failed.
//
// A steer that names a timeout must keep its own suggestion inside that timeout.

function mkExec(t, timeoutMs) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-tmo-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return new Executor(ws, { shellTimeoutMs: timeoutMs, shellSandbox: "host" });
}

test("the suggested poll interval stays UNDER the cap that just fired", async (t) => {
  const ex = mkExec(t, 6000);
  const { observation } = await ex.execute({ a: "shell", c: "sleep 30" });
  assert.match(observation, /\[timeout\] Killed after 6s/);
  const m = observation.match(/sleep (\d+); tail/);
  assert.ok(m, `expected a concrete poll suggestion, got: ${observation.slice(0, 400)}`);
  assert.ok(Number(m[1]) < 6, `poll ${m[1]}s must be under the 6s cap, or the fix repeats the failure`);
});

test("it names long COMPUTATION, not just installs", async (t) => {
  const ex = mkExec(t, 6000);
  const { observation } = await ex.execute({ a: "shell", c: "sleep 30" });
  assert.match(observation, /MCMC sampling|takes minutes/i,
    "a legitimate long computation is not a runaway install");
});

test("it demands a liveness check, so a dead job is not mistaken for a slow one", async (t) => {
  const ex = mkExec(t, 6000);
  const { observation } = await ex.execute({ a: "shell", c: "sleep 30" });
  assert.match(observation, /kill -0/);
  assert.match(observation, /DEAD/);
});
