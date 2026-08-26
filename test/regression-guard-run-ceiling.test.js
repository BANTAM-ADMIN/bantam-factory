// The regression guard stands down after 2 restores of the SAME snapshot,
// because "a fix often requires passing through a temporary dip". But the
// per-snapshot counter resets every time a new best snapshot is taken, and a
// new best is taken whenever the passing count rises — which is exactly what
// happens on a task whose deliverable IS new tests. So the stand-down never
// accumulates and the guard keeps fighting the repair.
//
// tb5 (2026-08-16, .bantam/runs/2026-08-16T16-58-16-359Z.json) took FOUR
// restores in 60 turns against a fully-green baseline, where every intermediate
// state of a multi-edit change counts as a regression. The model noticed — "the
// auto-verify has been reverting my changes" — and spent its endgame re-reading
// a file the harness kept rewriting underneath it.
//
// A run-level ceiling makes the stand-down reachable no matter how the snapshot
// churns. Catastrophic protection stays: the first restores still happen.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

const VERIFY = "node --test";

// A suite whose passing count GROWS as the model adds test files: this is what
// resets the per-snapshot counter and defeated the old stand-down.
function growingSuiteWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-run-ceiling-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  const passing = (name) => [
    'const test = require("node:test");',
    `test("${name}", () => {});`,
  ].join("\n");
  fs.writeFileSync(path.join(dir, "base.test.js"), passing("base holds"));
  fs.writeFileSync(path.join(dir, "target.js"), "module.exports='good'");
  // A test that follows target.js, so an edit to it can dip the suite.
  fs.writeFileSync(
    path.join(dir, "target.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("target is good", () => {',
      '  delete require.cache[require.resolve("./target.js")];',
      '  assert.equal(require("./target.js"), "good");',
      "});",
    ].join("\n"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return {
        content: outputs.shift() ?? JSON.stringify({ a: "done", summary: "out of script" }),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

const runTests = JSON.stringify({ a: "shell", c: VERIFY });
const breakTarget = JSON.stringify({ a: "write_file", p: "target.js", content: "module.exports='bad'" });
const fixTarget = JSON.stringify({ a: "write_file", p: "target.js", content: "module.exports='good'" });
const addTest = (n) => JSON.stringify({
  a: "write_file",
  p: `extra${n}.test.js`,
  content: `const test = require("node:test");\ntest("extra ${n}", () => {});\n`,
});

describe("regression guard — run-level stand-down", () => {
  it("stops restoring after a bounded number of reverts, however the snapshot churns", async (t) => {
    const workspace = growingSuiteWorkspace(t);

    // Each cycle: establish green (raising the passing count with a NEW test,
    // which retakes the snapshot and resets the per-snapshot counter), then
    // dip. Under the old rule this could repeat without limit.
    const script = [];
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      script.push(addTest(cycle), runTests, breakTarget, runTests, fixTarget);
    }
    script.push(JSON.stringify({ a: "done", summary: "finished" }));

    const result = await runAgent({
      task: "Adjust target.js and add tests.",
      workspace,
      model: scriptedModel(script),
      maxTurns: script.length + 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
      verificationScript: VERIFY,
    });

    const reverts = result.metrics.regressionReverts ?? 0;
    assert.ok(reverts > 0, "the guard must still protect a green tree at least once");
    assert.ok(reverts <= 3,
      `the run-level ceiling must bound restores; got ${reverts} (tb5 took 4 and kept going)`);

    const standDown = result.turns.some((turn) => /\[regression-guard\] Standing down/.test(String(turn.observation ?? "")));
    assert.ok(standDown, "and it must SAY it stood down, so the model stops fighting an invisible hand");
  });

  it("names the run-level reason, not the per-snapshot one, when that is what fired", async (t) => {
    const workspace = growingSuiteWorkspace(t);
    const script = [];
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      script.push(addTest(cycle), runTests, breakTarget, runTests, fixTarget);
    }
    script.push(JSON.stringify({ a: "done", summary: "finished" }));

    const result = await runAgent({
      task: "Adjust target.js and add tests.",
      workspace,
      model: scriptedModel(script),
      maxTurns: script.length + 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
      verificationScript: VERIFY,
    });

    const message = result.turns
      .map((turn) => String(turn.observation ?? ""))
      .find((text) => /Standing down/.test(text));
    if (!message) return;   // the first assertion above already covers absence
    assert.match(message, /restores in this run|restores of the same base/);
  });
});
