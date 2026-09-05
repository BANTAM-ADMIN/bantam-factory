import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { runShellProcess } from "../src/executor.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}');
  for (const [key, value] of Object.entries({ BANTAM_TYPE_CONTRACT_GATE: "1", BANTAM_SPEC_GAP_AUTO: "0" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  return { root, workspace };
}

function run(workspace, source, options = {}) {
  let call = 0;
  const actions = [
    { a: "write_file", p: "collections.js", content: source },
    { a: "done", summary: "normalizeTags implemented per the contract." },
  ];
  const model = { assistantPrefill: "", actTemperature: null, async complete() {
    return { content: JSON.stringify(actions[Math.min(call++, actions.length - 1)]), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  } };
  return runAgent({
    workspace, task: "Implement collections.js. normalizeTags accepts an array of strings, trims entries, and never mutates the input.",
    model, maxTurns: 4, completionAudit: false, stateAudit: "off", interactive: false, useGrammar: false, grounding: false,
    shellSandbox: "docker", ...options,
  });
}

test("agent smoke gates use the configured sandbox runner", async (t) => {
  const { workspace } = setup(t);
  let calls = 0;
  const result = await run(workspace, "export function normalizeTags(v) { return v; }", {
    shellProcessRunner: async (file, args) => {
      calls++;
      assert.equal(file, "docker");
      assert.ok(args.includes(`${workspace}:${workspace}:ro`));
      return { code: 0, stdout: "[]", stderr: "" };
    },
  });
  assert.equal(result.done, true);
  assert.equal(calls, 1);
});

test("a failed probe cannot be bypassed by repeating done after its first bounce", async (t) => {
  const { workspace } = setup(t);
  let calls = 0;
  const result = await run(workspace, "export function normalizeTags(v) { return v; }", {
    shellProcessRunner: async () => { calls++; return { code: 125, stdout: "", stderr: "sandbox unavailable" }; },
  });
  assert.equal(result.done, false);
  assert.equal(calls, 3);
  assert.equal(result.metrics.typeContractRejections, 3);
  assert.ok(result.turns.slice(1).every((turn) => /no passing proof/.test(turn.observation)));
});

test("ordinary shell runner rejects misspelled sandbox mode without execution", async (t) => {
  const { workspace } = setup(t);
  let calls = 0;
  await assert.rejects(runShellProcess(workspace, "true", { shellSandbox: "dokcer", processRunner: async () => { calls++; } }), /expected docker or explicit host/);
  assert.equal(calls, 0);
});

test("live agent smoke probe cannot execute a top-level host canary", {
  skip: process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? false : "set BANTAM_LIVE_SANDBOX_TEST=1 for the Docker integration canary",
}, async (t) => {
  const { root, workspace } = setup(t), marker = path.join(root, "outside-canary.txt");
  const source = [
    "import fs from 'node:fs';",
    `try { fs.writeFileSync(${JSON.stringify(marker)}, 'harmless'); } catch {}`,
    "export function normalizeTags(v) { if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new TypeError(); return v.map(x => x.trim()); }",
  ].join("\n");
  const result = await run(workspace, source);
  assert.equal(result.done, true);
  assert.equal(fs.existsSync(marker), false);
});
