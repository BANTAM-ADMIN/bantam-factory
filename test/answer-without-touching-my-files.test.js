import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { EDIT_ACTIONS } from "../src/edit-actions.js";

// Asking a coding agent about your code without letting it touch anything is a
// first-class use, and bantam had no way to say it. The system prompt already
// tells the model "if the user asks a QUESTION the deliverable is an ANSWER, not
// a file change" — but nothing enforces it.
//
// Observed 2026-08-17 on the joblog project: asked "how does it decide
// FINISHED vs FAILED? Just explain it, don't change anything yet", bantam
// answered the question accurately AND rewrote statusOf across six edit turns.
// The answer was good; the instruction was ignored.
//
// runAgent has taken `excludeActions` all along — it masks the verbs out of the
// grammar and guards them again at execution. It was never reachable from the
// CLI, so a user could not ask for it.

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-readonly-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","private":true}');
  fs.writeFileSync(path.join(dir, "impl.js"), "export const value = 1;\n");
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

test("an edit is refused when the caller asked for answers only", async (t) => {
  const dir = project(t);
  const before = fs.readFileSync(path.join(dir, "impl.js"), "utf8");
  const r = await runAgent({
    task: "How does impl.js work? Explain, do not change anything.",
    workspace: dir,
    model: model([
      JSON.stringify({ a: "replace", p: "impl.js", old: "value = 1", new: "value = 2" }),
      JSON.stringify({ a: "respond", text: "it exports a constant" }),
    ]),
    maxTurns: 4,
    useGrammar: false,          // the grammar mask is bypassed here on purpose:
    excludeActions: [...EDIT_ACTIONS],   // this proves the EXECUTION guard also holds
    shellSandbox: "host",
  });
  assert.equal(fs.readFileSync(path.join(dir, "impl.js"), "utf8"), before, "the file must be untouched");
  // The guard rejects at PARSE time, so the edit never becomes a turn at all —
  // it lands in rejectedOutputs and the model is asked again. That is the
  // stronger placement: the action is refused before anything can run it.
  const refused = (r.rejectedOutputs ?? []).find((x) => x.kind === "caller_policy");
  assert.ok(refused, `the refusal should be recorded: ${JSON.stringify(r.rejectedOutputs ?? []).slice(0, 200)}`);
  assert.match(String(refused.error ?? ""), /disabled by the caller policy/i);
  assert.ok(!r.turns.some((x) => x.parsedAction?.a === "replace"), "and it never became a turn");
});

test("reading and answering still work", async (t) => {
  const dir = project(t);
  const r = await runAgent({
    task: "What does impl.js export?",
    workspace: dir,
    model: model([
      JSON.stringify({ a: "read_file", p: "impl.js" }),
      JSON.stringify({ a: "respond", text: "a constant named value" }),
    ]),
    maxTurns: 4,
    useGrammar: false,
    excludeActions: [...EDIT_ACTIONS],
    shellSandbox: "host",
  });
  const read = r.turns.find((x) => x.parsedAction?.a === "read_file");
  assert.ok(read, "read_file must remain available");
  assert.match(String(read.observation ?? ""), /export const value/, "and actually return the file");
});
