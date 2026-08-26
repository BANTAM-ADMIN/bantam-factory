import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { SEARCH_STRATEGY_MARKER } from "../src/logic/search-strategy.js";

test("runAgent blocks a cosmetically varied exhausted search axis but keeps shell available", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-search-strategy-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const fakeJohn = path.join(workspace, "john");
  fs.writeFileSync(fakeJohn, `#!/bin/sh
printf '%s\\n' "$*" >> invocations.log
case "$*" in
  *--list=inc-modes*) printf '%s\\n' alpha digits ;;
  *--incremental=alpha:*) echo 'Unknown incremental mode: alpha:1-8' ;;
  *--incremental=alpha*) echo 'bounded search (timed out)'; exit 1 ;;
  *--incremental=digits*) echo '1g 0:00:00:01 DONE' ;;
esac
`);
  fs.chmodSync(fakeJohn, 0o755);

  const repeatedAlpha = JSON.stringify({
    a: "shell",
    c: "./john --incremental=alpha --fork=8 hashes.txt",
  });
  const model = scriptedPromptModel([
    JSON.stringify({ a: "shell", c: "./john --incremental=alpha --fork=2 hashes.txt" }),
    JSON.stringify({ a: "shell", c: "./john --incremental=alpha:1-8 hashes.txt" }),
    repeatedAlpha,
    JSON.stringify({ a: "shell", c: "./john --list=inc-modes" }),
    JSON.stringify({ a: "shell", c: "./john --incremental=digits hashes.txt" }),
    JSON.stringify({ a: "respond", text: "Changed the candidate domain after the failed search evidence." }),
  ]);
  const events = [];

  const result = await runAgent({
    task: "Inspect the bundled solver's bounded search behavior and explain what happened.",
    workspace,
    model,
    maxTurns: 6,
    maxInvalidPerTurn: 0,
    useGrammar: true,
    interactive: true,
    interactiveReconLimit: 20,
    progressAwareness: false,
    completionAudit: false,
    stateAudit: "off",
    planAudit: "off",
    grounding: false,
    shellSandbox: "host",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.done, true);
  assert.match(result.turns[2].observation, new RegExp(SEARCH_STRATEGY_MARKER));
  assert.match(result.turns[2].observation, /--list=inc-modes/);
  assert.ok(events.some((event) => event.type === "search_strategy_gate"));
  assert.equal(result.metrics.evidenceGateRejections, 1);
  assert.match(model.prompts[3], /change a real search axis/i);

  const invocations = fs.readFileSync(path.join(workspace, "invocations.log"), "utf8");
  assert.doesNotMatch(invocations, /--fork=8/, "the exhausted alpha proposal must not execute");
  assert.match(invocations, /--list=inc-modes/, "capability enumeration remains executable");
  assert.match(invocations, /--incremental=digits/, "a new domain remains executable");
});

function scriptedPromptModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() {
      return this.prompts.length;
    },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      const content = outputs.shift();
      if (content === undefined) throw new Error("scripted model exhausted");
      return {
        content,
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}
