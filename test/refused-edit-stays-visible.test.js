// A file the model is trying to edit and cannot see is one it must edit blind.
//
// tb23 (2026-08-17, .bantam/runs/2026-08-17T07-32-51-234Z.json) refused six
// consecutive edit_lines on src/fixture-runner.js for syntax while that file was
// absent from the panel on every one of those turns. The split is total: every
// edit it made to a file IN the panel landed (turns 8, 22, 27, 40, 56) and every
// edit to a file outside it failed (32, 36, 37, 39, 46, 48, 50, 53). It reached
// its test suite once in 60 turns and hit the cap.
//
// editRecoveryPath already pins a file whose exact-match edit failed, and its
// comment states the intent — "so recovery can never point to hidden bytes".
// It is set from failedEditPath(), which answers the narrower question "did
// `old` fail to match", so a syntax or collateral refusal never reached it. The
// seam focus set for those refusals had no panel entry to attach to.

process.env.BANTAM_OPEN_FILES = "2";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const { runAgent } = await import("../src/agent.js");

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-refused-pin-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  // The edit target, and enough other files to push it out of a two-entry panel.
  fs.writeFileSync(path.join(dir, "target.js"), "function keep() {\n  return 1;\n}\nmodule.exports = keep;\n");
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(dir, name), `${"// filler\n".repeat(80)}module.exports = 1;\n`);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingModel(outputs, prompts) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete(prompt) {
      prompts.push(String(prompt ?? ""));
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

const act = (o) => JSON.stringify(o);

describe("a refused edit keeps its target visible", () => {
  it("pins the file after a SYNTAX refusal, not only an anchor mismatch", async (t) => {
    const dir = workspace(t);
    const prompts = [];
    const script = [
      // Read the other files so target.js falls out of a two-entry panel.
      act({ a: "read_file", p: "a.js" }),
      act({ a: "read_file", p: "b.js" }),
      act({ a: "read_file", p: "c.js" }),
      // An edit that leaves the file unparseable: refused for syntax, not anchors.
      act({ a: "replace", p: "target.js", old: "  return 1;\n}", new: "  return 1;", line: 2 }),
      act({ a: "respond", text: "what now" }),   // the turn that must SEE target.js
      act({ a: "done", summary: "finished" }),
    ];

    const result = await runAgent({
      task: "Adjust target.js.",
      workspace: dir,
      model: recordingModel(script, prompts),
      maxTurns: script.length + 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: "host",
    });

    const refusedAt = result.turns.findIndex((turn) => /^ERROR: refused — valid JavaScript/.test(String(turn.observation ?? "")));
    assert.ok(refusedAt >= 0, "the edit must be refused for syntax for this test to mean anything");

    const next = prompts[refusedAt + 1];
    assert.ok(next, "there must be a turn after the refusal");
    assert.match(
      next,
      /^# target\.js \(current, \d+ lines\)/m,
      "the file the model is trying to edit must be in the panel it authors the retry against",
    );
  });
});
