import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

// BANTAM_SCOPED_VERIFY=1 deterministically broke
// test/agent.test.js — "invalidates a broken-tree brief when the regression
// guard restores prior bytes". Found by turning the option on for a ticket run
// and having the workspace's own baseline gate refuse to start.
//
// The mechanism: a scoped verify reset turnsSinceVerify along with the two edit
// streaks, so the staleness trigger never fired, the configured FULL verify
// never ran, and the regression guard never obtained the comparable pass counts
// it protects with. Enabling per-edit feedback silently disabled the thing that
// restores a broken tree.
//
// scoped-verify.js states the contract this violates in its own header: a scoped
// green "is always a genuine subset of a full green, never a claim beyond it".
// Standing in for the full verify is exactly a claim beyond it.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-scoped-guard-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "value.js"), "export const value = 1;\n");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/value.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { value } from '../value.js';",
    "test('value stays one', () => { assert.equal(value, 1); });",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const model = (lines) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: lines.shift() ?? JSON.stringify({ a: "done", summary: "d" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

test("a scoped verify does not stop the full verify from ever going stale", async (t) => {
  const dir = workspace(t);
  // Twelve blind edits — enough turns for the staleness trigger (default 8) to
  // become reachable at all. With the clock reset by scoped verifies, and the
  // blind streak zeroed by them too, it never was.
  const edits = Array.from({ length: 12 }, (_, i) => JSON.stringify({
    a: "replace", p: "value.js", old: `value = ${i + 1}`, new: `value = ${i + 2}`,
  }));
  const r = await runAgent({
    task: "Edit value.js repeatedly.",
    workspace: dir,
    model: model(edits),
    maxTurns: edits.length + 2,
    useGrammar: false,
    shellSandbox: "host",
    scopedVerify: true,
    grounding: true,          // scoped verify needs the impact graph to fire at all
    verificationScript: "node --test test/value.test.js",
  });
  const scoped = r.metrics?.scopedVerifies ?? 0;
  assert.ok(scoped > 0, `the scenario must actually exercise scoped verify; got ${scoped}`);
  assert.ok(
    (r.metrics?.autoVerifies ?? 0) > 0,
    `the configured verify must still run: ${JSON.stringify({
      autoVerifies: r.metrics?.autoVerifies, scoped, turns: r.turns.length,
    })}`,
  );
});
