import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";
import { SOURCE_PROVENANCE_MARKER } from "../src/logic/source-provenance.js";

const TASK = "You need to create a file called \"/app/solution.txt\" with the word found in \"secret_file.txt\" in the \"secrets.7z\" archive.";

test("runAgent keeps source computation available and blocks the recorded forced guess", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-source-provenance-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "secrets.7z"), "7z-bytes");
  fs.writeFileSync(path.join(workspace, "secret_file.txt"), "honeybear\n");

  const model = scriptedPromptModel([
    // This exact class of source parser was misclassified as recon in the
    // failed run. With thresholds set to one, the next turn crosses every old
    // force-edit boundary immediately.
    JSON.stringify({
      a: "shell",
      c: `python3 -c "data=open('secrets.7z','rb').read(); print(len(data))"`,
    }),
    // At this point the progress threshold is already spent. Exact derivation
    // must still be allowed to discover a bundled tool/API; the generic gate's
    // "write a draft now" exit is impossible while the value is unknown.
    JSON.stringify({ a: "list_dir", p: "." }),
    JSON.stringify({ a: "shell", c: "ls -1 . | head" }),
    // Replay the actual lexical guess. The provenance station must refuse it.
    // The production arena workspace is /app. This hermetic test workspace is
    // a temporary directory, so use the equivalent workspace-relative alias.
    JSON.stringify({ a: "write_file", p: "solution.txt", content: "secret" }),
    // Produce a real source-linked value witness, then copy it.
    JSON.stringify({
      a: "shell",
      c: `python3 -c "print(open('secret_file.txt').read().strip())"`,
    }),
    JSON.stringify({ a: "write_file", p: "solution.txt", content: "honeybear" }),
    JSON.stringify({
      a: "shell",
      c: `python3 -c "assert open('solution.txt').read() == 'honeybear'; print('verified')"`,
    }),
    JSON.stringify({ a: "done", summary: "Recovered and verified the witnessed value." }),
  ]);
  const events = [];

  const result = await runAgent({
    task: TASK,
    workspace,
    model,
    maxTurns: 10,
    maxInvalidPerTurn: 0,
    useGrammar: true,
    interactive: false,
    progressAwareness: true,
    progressNudgeAfter: 1,
    progressNudgeCooldown: 1,
    autoForceEditAfter: 1,
    completionAudit: false,
    stateAudit: "off",
    planAudit: "off",
    grounding: false,
    verificationPolicy: "after_edit",
    shellSandbox: "host",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.done, true);
  assert.equal(fs.readFileSync(path.join(workspace, "solution.txt"), "utf8"), "honeybear");
  assert.equal(result.metrics.wrapUpMasks, 0, "source derivation must not activate the force-draft grammar");
  assert.equal(result.metrics.progressGateRejections, 0, "source evidence discovery must not hit the draft-or-terminate gate");
  assert.equal(result.metrics.evidenceGateRejections, 1);
  assert.ok(events.some((event) => event.type === "source_provenance_gate"));
  assert.ok(events.some((event) => event.type === "progress_nudge"));
  assert.ok(model.prompts.every((prompt) => !prompt.includes("[commit] You have investigated enough")));
  assert.match(model.prompts[0], new RegExp(SOURCE_PROVENANCE_MARKER));
  assert.match(model.prompts[1], /exact transcription task/);
  assert.match(result.turns[1].observation, /secret_file\.txt/);
  assert.match(result.turns[2].observation, /secrets\.7z/);
  assert.match(result.turns[3].observation, /unsupported guess/);
  assert.match(result.turns[4].observation, /honeybear/);
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
