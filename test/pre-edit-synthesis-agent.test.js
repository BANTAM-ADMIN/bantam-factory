import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../src/agent.js";

const ASSISTANT_PREFILL = "<|im_start|>assistant\n<think>\n</think>\n\n";

function workspace(t, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-pre-edit-synthesis-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "src", "value.js"), "export const value = 1;\n");
  return root;
}

function sourceThenEditModel(reasoning = "The named source is now visible. Preserve its export and change only the requested value.") {
  const actions = [
    JSON.stringify({ a: "read_file", p: "src/value.js" }),
    JSON.stringify({
      a: "replace",
      p: "src/value.js",
      old: "export const value = 1;",
      new: "export const value = 2;",
    }),
  ];
  return {
    assistantPrefill: ASSISTANT_PREFILL,
    thinkMarkers: { open: "<think>\n", close: "</think>" },
    stop: [],
    actTemperature: null,
    prompts: [],
    actionCalls: 0,
    reasoningCalls: 0,
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      const text = String(prompt);
      this.prompts.push(text);
      if (text.endsWith("<think>\n")) {
        this.reasoningCalls++;
        return {
          content: reasoning,
          tokens: 1,
          stoppedEos: true,
          stoppedLimit: false,
          timings: {},
        };
      }
      this.actionCalls++;
      return {
        content: actions.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}

async function run(root, model, preEditSynthesis, onEvent = () => {}) {
  return runAgent({
    task: "Update src/value.js so its exported value is 2.",
    workspace: root,
    model,
    maxTurns: 2,
    thinkMode: "auto",
    preEditSynthesis,
    completionAudit: false,
    stateAudit: "off",
    interactive: true,
    useGrammar: false,
    grounding: false,
    shellSandbox: "host",
    onEvent,
  });
}

test("post-inspection synthesis fires exactly once before the first edit", async (t) => {
  const previousLean = process.env.BANTAM_THINK_LEAN;
  process.env.BANTAM_THINK_LEAN = "1";
  try {
    const events = [];
    const model = sourceThenEditModel();
    const root = workspace(t, "on");
    const result = await run(root, model, true, (event) => events.push(event));

    assert.equal(model.reasoningCalls, 1);
    assert.equal(model.actionCalls, 2);
    assert.equal(result.metrics.preEditSynthesisAttempts, 1);
    assert.equal(result.metrics.preEditSynthesisThinks, 1);
    assert.equal(events.filter((event) => event.type === "pre_edit_synthesis_attempt").length, 1);
    assert.equal(events.filter((event) => event.type === "pre_edit_synthesis").length, 1);
    assert.deepEqual(events.find((event) => event.type === "pre_edit_synthesis")?.paths, ["src/value.js"]);
    assert.equal(result.turns[0].action.a, "read_file");
    assert.equal(result.turns[1].action.a, "replace");
    assert.equal(fs.readFileSync(path.join(root, "src", "value.js"), "utf8"), "export const value = 2;\n");
  } finally {
    if (previousLean === undefined) delete process.env.BANTAM_THINK_LEAN;
    else process.env.BANTAM_THINK_LEAN = previousLean;
  }
});

test("disabled control does not add a reasoning request", async (t) => {
  const previousLean = process.env.BANTAM_THINK_LEAN;
  process.env.BANTAM_THINK_LEAN = "1";
  try {
    const model = sourceThenEditModel();
    const result = await run(workspace(t, "off"), model, false);

    assert.equal(model.reasoningCalls, 0);
    assert.equal(model.actionCalls, 2);
    assert.equal(result.metrics.preEditSynthesisAttempts, 0);
    assert.equal(result.metrics.preEditSynthesisThinks, 0);
    assert.deepEqual(result.turns.map((turn) => turn.action.a), ["read_file", "replace"]);
  } finally {
    if (previousLean === undefined) delete process.env.BANTAM_THINK_LEAN;
    else process.env.BANTAM_THINK_LEAN = previousLean;
  }
});

test("empty synthesis is recorded as an attempt, not successful reasoning", async (t) => {
  const previousLean = process.env.BANTAM_THINK_LEAN;
  process.env.BANTAM_THINK_LEAN = "1";
  try {
    const events = [];
    const model = sourceThenEditModel("");
    const result = await run(workspace(t, "empty"), model, true, (event) => events.push(event));

    assert.equal(model.reasoningCalls, 1);
    assert.equal(result.metrics.preEditSynthesisAttempts, 1);
    assert.equal(result.metrics.preEditSynthesisThinks, 0);
    assert.equal(events.filter((event) => event.type === "pre_edit_synthesis_attempt").length, 1);
    assert.equal(events.filter((event) => event.type === "pre_edit_synthesis").length, 0);
    assert.equal(events.filter((event) => event.type === "pre_edit_synthesis_empty").length, 1);
  } finally {
    if (previousLean === undefined) delete process.env.BANTAM_THINK_LEAN;
    else process.env.BANTAM_THINK_LEAN = previousLean;
  }
});
