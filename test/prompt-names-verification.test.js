import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";

// tb6 (.bantam/runs/2026-08-16T17-22-16-517Z.json) made ZERO shell calls in 60
// turns and leaned entirely on auto-verify. Searching all 82 of its prompts for
// the configured command — `node --test …` — returns nothing. Meanwhile the
// harness told it:
//
//   [auto-verify] … reading and reasoning is not verification, so I ran them
//                 for you
//   [implementation-response] … run the configured verification after your
//                 latest edit, then emit `done`
//
// Two instructions to run a command whose name the model was never given. The
// prompt's own rules even say "Run test commands directly". It could not.

function promptCapturingModel(sink) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete(prompt) {
      if (sink.prompt === null) sink.prompt = String(prompt);
      return {
        content: JSON.stringify({ a: "done", summary: "done" }),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

async function promptFor(t, { verificationScript }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-verify-name-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "a.js"), "export const a = 1;\n");
  const sink = { prompt: null };
  await runAgent({
    task: "Adjust a.js.",
    workspace,
    model: promptCapturingModel(sink),
    maxTurns: 1,
    interactive: true,
    useGrammar: false,
    grounding: false,
    shellSandbox: "host",
    verificationScript,
  });
  return sink.prompt ?? "";
}

describe("the prompt names the verification command", () => {
  it("states the configured command verbatim", async (t) => {
    const prompt = await promptFor(t, { verificationScript: "node --test test/foo.test.js" });
    assert.match(prompt, /node --test test\/foo\.test\.js/,
      "the model is told to run the configured verification; it must be told what that is");
  });

  it("tells the model to run it rather than wait", async (t) => {
    const prompt = await promptFor(t, { verificationScript: "npm test" });
    assert.match(prompt, /Verification for this task/);
    assert.match(prompt, /run it yourself with shell/);
  });

  it("says nothing when no verification is configured", async (t) => {
    const prompt = await promptFor(t, { verificationScript: null });
    assert.doesNotMatch(prompt, /Verification for this task/,
      "inventing a verification command the run does not have would be worse than silence");
  });
});
