import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgent } from "../src/agent.js";
import { deliveryFor, BLOCK, OFF } from "../src/gate-policy.js";

// The permissive implementation all six lexical-smoke-gate-ab runs converged on:
// coerce rather than reject. normalizeTags("a") -> ["a"] instead of throwing.
const TASK = "Implement src/adapters/collections.js. "
  + "normalizeTags accepts an array of strings, trims entries, and never mutates the input.";

const PERMISSIVE = `export function normalizeTags(value) {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => String(v).trim()).filter(Boolean);
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-typegate-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, "src", "adapters"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"type":"module"}');
  return ws;
}

async function run(ws) {
  return runAgent({
    task: TASK, workspace: ws,
    model: scriptedModel([
      JSON.stringify({ a: "write_file", p: "src/adapters/collections.js", content: PERMISSIVE }),
      JSON.stringify({ a: "done", summary: "normalizeTags implemented per the contract." }),
      JSON.stringify({ a: "done", summary: "Tightened the type check." }),
    ]),
    maxTurns: 4,
    completionAudit: false, stateAudit: "off", interactive: false,
    useGrammar: false, grounding: false, shellSandbox: "host",
  });
}

async function withFlag(value, fn) {
  const prev = process.env.BANTAM_TYPE_CONTRACT_GATE;
  if (value === undefined) delete process.env.BANTAM_TYPE_CONTRACT_GATE;
  else process.env.BANTAM_TYPE_CONTRACT_GATE = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.BANTAM_TYPE_CONTRACT_GATE;
    else process.env.BANTAM_TYPE_CONTRACT_GATE = prev;
  }
}

describe("type contract done-gate", () => {
  it("is off by default so it cannot change existing runs", () => {
    assert.equal(deliveryFor("type_contract", { interactive: false }), OFF);
  });

  it("blocks autonomously when the candidate flag is set", async () => {
    await withFlag("1", () => {
      assert.equal(deliveryFor("type_contract", { interactive: false }), BLOCK);
    });
  });

  it("bounces a done whose code coerces instead of rejecting", async (t) => {
    const result = await withFlag("1", () => run(workspace(t)));

    assert.equal(result.metrics.typeContractRejections, 1);
    const bounced = result.turns.find((turn) => String(turn.observation ?? "").includes("[type-contract-smoke]"));
    assert.ok(bounced, "expected a turn carrying the type-contract bounce");
    assert.match(String(bounced.observation), /normalizeTags\("a"\)/);
    assert.match(String(bounced.observation), /array of strings/);
  });

  // Negative control: identical run, flag unset. If this ever reports a rejection
  // the gate has stopped being opt-in and every recorded baseline is invalidated.
  it("leaves the same run untouched when the flag is unset", async (t) => {
    const result = await withFlag(undefined, () => run(workspace(t)));

    assert.equal(result.metrics.typeContractRejections, 0);
    assert.equal(
      result.turns.some((turn) => String(turn.observation ?? "").includes("[type-contract-smoke]")),
      false,
    );
  });
});
