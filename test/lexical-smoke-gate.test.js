import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../src/agent.js";
import { deliveryFor, BLOCK, OFF } from "../src/gate-policy.js";

// The recorded specimen (adapter-migration, local 27B, 2026-07-30): the advisory
// [lexical-contract-audit] fired in 3/3 runs and was ignored in 3/3, each ending
// in a confident done with 26-32 turns of budget left. This asserts the same fact
// delivered as a GATE actually bounces the done -- the delivery asymmetry.
const TASK = 'Implement parseEnabled in src/adapters/enabled.js. '
  + 'parseEnabled accepts booleans or trimmed case-insensitive "true"/"false" strings.';

// Case-SENSITIVE compare: the exact narrowing all three recorded runs wrote.
const BUGGY = `export function parseEnabled(value) {
  if (typeof value === "boolean") return value;
  const t = String(value).trim();
  if (t === "true") return true;
  if (t === "false") return false;
  throw new TypeError("bad");
}
`;

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

function workspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lexgate-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "src", "adapters"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  return ws;
}

async function run(ws) {
  const model = scriptedModel([
    JSON.stringify({ a: "write_file", p: "src/adapters/enabled.js", content: BUGGY }),
    JSON.stringify({ a: "done", summary: "parseEnabled implemented per the contract." }),
    JSON.stringify({ a: "done", summary: "Widened the comparison." }),
  ]);
  const result = await runAgent({
    task: TASK, workspace: ws, model, maxTurns: 4,
    completionAudit: false, stateAudit: "off", interactive: false,
    useGrammar: false, grounding: false, shellSandbox: "host",
  });
  return result;
}

describe("lexical smoke done-gate", () => {
  it("is off by default so it cannot change existing runs", () => {
    assert.equal(deliveryFor("lexical_smoke", { interactive: false, policy: undefined }), OFF);
  });

  it("blocks autonomously when the candidate flag is set", () => {
    const prev = process.env.BANTAM_LEXICAL_SMOKE_GATE;
    process.env.BANTAM_LEXICAL_SMOKE_GATE = "1";
    try {
      assert.equal(deliveryFor("lexical_smoke", { interactive: false }), BLOCK);
    } finally {
      if (prev === undefined) delete process.env.BANTAM_LEXICAL_SMOKE_GATE;
      else process.env.BANTAM_LEXICAL_SMOKE_GATE = prev;
    }
  });

  it("bounces a done whose code narrows a task-named language, carrying the failing call", async (t) => {
    const prev = process.env.BANTAM_LEXICAL_SMOKE_GATE;
    process.env.BANTAM_LEXICAL_SMOKE_GATE = "1";
    let result;
    try {
      result = await run(workspace(t));
    } finally {
      if (prev === undefined) delete process.env.BANTAM_LEXICAL_SMOKE_GATE;
      else process.env.BANTAM_LEXICAL_SMOKE_GATE = prev;
    }

    assert.equal(result.metrics.lexicalSmokeRejections, 1);
    const bounced = result.turns.find((turn) => String(turn.observation ?? "").includes("[lexical-smoke]"));
    assert.ok(bounced, "expected a turn carrying the lexical-smoke bounce");
    assert.match(String(bounced.observation), /parseEnabled\("TRUE"\)/);
  });

  // Negative control: identical run, flag unset. If this ever reports a rejection
  // the gate has stopped being opt-in and every recorded baseline is invalidated.
  it("leaves the same run untouched when the flag is unset", async (t) => {
    const prev = process.env.BANTAM_LEXICAL_SMOKE_GATE;
    delete process.env.BANTAM_LEXICAL_SMOKE_GATE;
    let result;
    try {
      result = await run(workspace(t));
    } finally {
      if (prev !== undefined) process.env.BANTAM_LEXICAL_SMOKE_GATE = prev;
    }

    assert.equal(result.metrics.lexicalSmokeRejections, 0);
    assert.equal(result.turns.some((turn) => String(turn.observation ?? "").includes("[lexical-smoke]")), false);
  });
});
