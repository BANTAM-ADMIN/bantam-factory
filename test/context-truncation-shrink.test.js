import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../src/agent.js";

// llama.cpp does not THROW when the prompt overruns the slot — it silently trims
// the prompt to fit and returns a generation cut short, flagged only by
// `truncated: true`. The context_overflow shrink path existed but was reachable
// only through a thrown error, so it never fired for the failure it exists for:
// tune-mjcf (2026-08-21) reached turn 76 with a 47.8k prompt on a 48k slot
// (--ctx-size 96000 --parallel 2), every generation after that was cut after a
// few hundred tokens, each rejected as unterminated JSON at ~2.5 minutes apiece,
// and nothing bantam could see said why. The server log did:
//   stop processing: n_tokens = 48127, truncated = 1

function truncatingModel(outputs) {
  let calls = 0;
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      calls += 1;
      // First call: the server trimmed the prompt and cut the answer short.
      if (calls === 1) {
        return { content: '{"a":"shell","c":"echo hi', tokens: 9, stoppedEos: false, stoppedLimit: false,
          truncated: true, promptTokens: 48127, timings: {} };
      }
      return { content: outputs.shift(), tokens: 5, stoppedEos: true, stoppedLimit: false, truncated: false, promptTokens: 900, timings: {} };
    },
  };
}

test("a truncated response shrinks history and re-asks, instead of being rejected as a bad action", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trunc-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const events = [];
  const model = truncatingModel([
    '{"a":"done","summary":"finished"}',
  ]);
  const result = await runAgent({
    task: "Say done.",
    workspace, model, maxTurns: 3, interactive: true, useGrammar: false, grounding: false, shellSandbox: "host",
    onEvent: (e) => events.push(e),
  });
  const trims = events.filter((e) => e.type === "context_trim");
  assert.equal(trims.length, 1, `expected exactly one context_trim, got ${trims.length}`);
  assert.equal(trims[0].cause, "truncated");
  assert.equal(trims[0].promptTokens, 48127, "the prompt size that overran must be recorded");
  assert.equal(result.metrics?.contextTrims, 1);
  // The cut-short output must NOT have been counted as a model mistake.
  assert.equal(result.metrics?.invalid ?? 0, 0, "a server-truncated response is not an invalid action");
  assert.equal(model.prompts.length, 2, "re-asked once after the trim");
});
