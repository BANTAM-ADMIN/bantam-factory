import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { verificationVerdict } from "../src/done-guard.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-instruction-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "keep.txt"), "original");
  return workspace;
}

function scripted(actions) {
  let call = 0;
  return { assistantPrefill: "", actTemperature: null, async complete() {
    return { content: JSON.stringify(actions[Math.min(call++, actions.length - 1)]), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
  } };
}

const options = {
  task: "Implement deliverable.txt. Do not modify keep.txt.",
  interactive: true, useGrammar: false, grounding: false, completionAudit: false, stateAudit: "off", shellSandbox: "host",
};

test("ordinary interactive agent enforces named prohibition before repeated direct edits", async (t) => {
  const workspace = fixture(t);
  const result = await runAgent({ ...options, workspace, maxTurns: 5, model: scripted([
    { a: "write_file", p: "keep.txt", content: "forbidden" },
    { a: "write_file", p: "keep.txt", content: "forbidden again" },
    { a: "write_file", p: "deliverable.txt", content: "implemented" },
    { a: "done", summary: "Implemented deliverable.txt." },
  ]) });
  assert.equal(result.done, true);
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "original");
  assert.equal(result.metrics.immutableEditRejections, 2);
  assert.equal(result.turns[0].editApplied, false);
  assert.equal(result.turns[1].editApplied, false);
});

test("ordinary interactive agent restores forbidden shell writes and invalidates their green output", async (t) => {
  const workspace = fixture(t);
  const result = await runAgent({ ...options, workspace, maxTurns: 1, model: scripted([
    { a: "shell", c: "printf forbidden > keep.txt; printf implemented > deliverable.txt; printf 'all 5 tests passed\\n'" },
  ]) });
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(workspace, "deliverable.txt"), "utf8"), "implemented");
  assert.equal(result.turns[0].shellScopeRollback.clean, true);
  assert.equal(verificationVerdict(result.turns[0]), "fail");
});
