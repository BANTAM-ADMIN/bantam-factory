// The carve-off's TDD turn (chat r0 @ 2026-08-17T22:29) ran to its 60-turn cap
// and wrapped up honestly — but ended "I'm going to proceed with ... now",
// with no "Next:" line, so the REPL's Enter-continuation had nothing to offer
// and the session just said "bye". Root cause: the midpoint and landing-window
// budget notes are !interactive only — a person's run gets no countdown at
// all after the opening budget line. Interactive runs now get a landing note
// that asks for exactly the wrap-up the Enter machinery consumes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

test("an interactive run near its cap is told to land with a Next: line", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-landing-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const n of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(workspace, `${n}.js`), `export const ${n} = 1;\n`);

  const model = scriptedModel([
    JSON.stringify({ a: "read_file", p: "a.js" }),
    JSON.stringify({ a: "read_file", p: "b.js" }),
    JSON.stringify({ a: "read_file", p: "c.js" }),
    JSON.stringify({ a: "respond", text: "Done looking. Next: read d.js for completeness." }),
  ]);

  const result = await runAgent({
    task: "Survey these modules.",
    workspace,
    model,
    maxTurns: 5,
    interactive: true,
    useGrammar: false,
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
  });

  assert.equal(result.responded, true);
  const budgetNotes = result.turns
    .map((turn) => String(turn.observation ?? ""))
    .filter((obs) => obs.includes("[budget]"));
  assert.ok(budgetNotes.length >= 1, "the landing window speaks to interactive runs too");
  assert.match(budgetNotes[0], /Next:/, "the note asks for the wrap-up shape the Enter-continuation consumes");
  assert.match(budgetNotes[0], /what remains|what is done|IS done/i, "and for an honest done-vs-remaining report");
});
