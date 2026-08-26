import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// The auto-verify block is gated on `verificationScript`. SWE-bench withholds
// its graders by design, so on that deck the whole thing is inert: the triggers
// fire and nothing happens, because the ACTION needs a command the benchmark
// does not provide.
//
// django-11211 (2026-08-17, benches/swebench/runs/) made 14 edits across 40
// turns with ZERO shell calls, hit the cap, and was never told it had not run
// anything. The one annotation that says so was unreachable.

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-unverified-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "a.js"), "module.exports = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const act = (o) => JSON.stringify(o);
const model = (script) => ({
  assistantPrefill: "",
  actTemperature: null,
  async complete() {
    return { content: script.shift() ?? act({ a: "read_file", p: "a.js" }), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  },
});

const steered = (result) => result.turns.filter((turn) => /\[auto-verify\] You have made \d+ edit\(s\)/.test(String(turn.observation ?? ""))).length;

describe("editing with no verify command configured", () => {
  it("says so when edits pile up unchecked", async (t) => {
    const dir = workspace(t);
    const script = Array.from({ length: 10 }, (_, i) => act({ a: "write_file", p: "a.js", content: `module.exports = ${i + 2};\n` }));
    const result = await runAgent({
      task: "Adjust a.js. Run the project's tests with `node --test`.",
      workspace: dir,
      model: model(script),
      maxTurns: 12,
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
      // no verificationScript: the SWE-bench shape
    });
    assert.equal(steered(result), 1, "it must say so, once");
    const note = result.turns.map((turn) => String(turn.observation ?? "")).find((o) => /You have made \d+ edit\(s\)/.test(o));
    assert.match(note, /No verify command is configured/);
    assert.match(note, /Run the project's own tests/);
  });

  it("stays quiet when a verify command exists", async (t) => {
    // There the real auto-verify runs the command and reports a verdict; two
    // annotations for the same condition would be noise.
    const dir = workspace(t);
    const script = Array.from({ length: 10 }, (_, i) => act({ a: "write_file", p: "a.js", content: `module.exports = ${i + 2};\n` }));
    const result = await runAgent({
      task: "Adjust a.js.",
      workspace: dir,
      model: model(script),
      maxTurns: 12,
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
      verificationScript: "node --test",
    });
    assert.equal(steered(result), 0);
  });

  it("resets after the model runs something, so a second spiral is caught", async (t) => {
    const dir = workspace(t);
    const edits = (n) => Array.from({ length: n }, (_, i) => act({ a: "write_file", p: "a.js", content: `module.exports = ${i + 2};\n` }));
    const result = await runAgent({
      task: "Adjust a.js. Run the project's tests with `node --test`.",
      workspace: dir,
      model: model([...edits(6), act({ a: "shell", c: "node --test" }), ...edits(6)]),
      maxTurns: 16,
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });
    assert.equal(steered(result), 2, "once per spiral, not once per run");
  });
});
