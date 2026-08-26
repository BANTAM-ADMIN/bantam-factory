import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../src/agent.js";

// Integration proof for the keyed-task-pool round-03 specimen: a read -> test
// loop over an unchanged, already-green suite must let the anti-spiral counter
// climb. The unit test proves the classification; this proves the agent loop
// actually maintains the "changed since last verification" state.

const PASSING_TEST = `import test from "node:test";
import assert from "node:assert";
test("green", () => { assert.equal(1, 1); });
`;

function workspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-unchanged-verify-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "test"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(ws, "test", "public.test.js"), PASSING_TEST);
  fs.writeFileSync(path.join(ws, "src.js"), "export const x = 1;\n");
  return ws;
}

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

// The recorded spin: alternate a read of the same file with a rerun of the
// unchanged green suite. Nothing is edited, so no rerun is new evidence.
function spinScript(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({ a: "read_file", p: "src.js" }));
    out.push(JSON.stringify({ a: "shell", c: "node --test test/public.test.js" }));
  }
  return out;
}

async function run(ws) {
  return runAgent({
    task: "Investigate the module and confirm the suite is green.",
    workspace: ws,
    model: scriptedModel(spinScript(9)),
    maxTurns: 18,
    completionAudit: false, stateAudit: "off", interactive: false,
    useGrammar: false, grounding: false, shellSandbox: "host",
  });
}

describe("unchanged verification does not earn progress", () => {
  it("lets the anti-spiral counter climb when the fix is armed", async (t) => {
    const prev = process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS;
    process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS = "0";
    let armed;
    try {
      armed = await run(workspace(t));
    } finally {
      if (prev === undefined) delete process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS;
      else process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS = prev;
    }

    // With the fix, only the FIRST verification is credited; every later rerun of
    // the unchanged suite is not, so the counter accumulates across the spin.
    assert.ok(
      armed.metrics.maxProgresslessTurns >= 6,
      `counter should accumulate through the spin, got ${armed.metrics.maxProgresslessTurns}`,
    );
  });

  // Negative control: identical run, flag unset. If this ever starts accumulating,
  // the change has stopped being opt-in and every recorded baseline is invalidated.
  it("leaves the recorded behaviour untouched when the flag is unset", async (t) => {
    const prev = process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS;
    delete process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS;
    let base;
    try {
      base = await run(workspace(t));
    } finally {
      if (prev !== undefined) process.env.BANTAM_UNCHANGED_VERIFY_PROGRESS = prev;
    }

    // Every rerun resets the counter, so it oscillates near zero -- the bug.
    assert.ok(
      base.metrics.maxProgresslessTurns <= 2,
      `default behaviour should still oscillate near zero, got ${base.metrics.maxProgresslessTurns}`,
    );
  });
});
