import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { buildArtifact } from "../src/artifact.js";
import { RunCheckpoint } from "../src/run-checkpoint.js";

const CONTRACT = "# ORIGINAL_BOUNDARY_CONTRACT\nImplement an incremental stream parser. Chunks may split anywhere. At EOF emit any nonempty pending record, preserving trailing empty fields. Empty streams emit nothing.\n";
const TASK = "Repair the incremental stream parser according to REQUIREMENTS.md. Run npm test.";
const GREEN = "TAP version 13\nok 1 - parser\n1..1\n# tests 1\n# pass 1\n# fail 0\n";
const source = (version) => `// CURRENT_SOURCE_VERSION_${version}\n`
  + "// The parser keeps only a current field and row; input boundaries must not discard pending data.\n".repeat(5)
  + `export function createParser() { let pending = ''; return { write(chunk) { pending += chunk; return []; }, end() { const row = pending ? [[pending]] : []; pending = ''; return row; }, version: ${version} }; }\n`;
const write = (version) => ({ a: "write_file", p: "src/parser.js", content: source(version) });
const verify = { a: "shell", c: "npm test" };
const done = { a: "done", summary: "Updated parser and checked the configured suite." };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-agent-contract-audit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "REQUIREMENTS.md"), CONTRACT);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/parser.test.js" } }));
  fs.writeFileSync(path.join(workspace, "src/parser.js"), "export const initial = true;\n");
  fs.writeFileSync(path.join(workspace, "test/parser.test.js"), "// TEST_ORACLE_NOT_FOR_AUDIT\nimport test from 'node:test';\ntest('parser', () => {});\n");
  return workspace;
}

async function run(workspace, actions, extra = {}) {
  const auditPrompts = [], actionPrompts = [];
  const model = { assistantPrefill: "", actTemperature: null,
    async complete(prompt) {
      if (String(prompt).includes("You are a source-code state-machine auditor.")) {
        auditPrompts.push(String(prompt));
        return { content: "AUDIT_HYPOTHESIS_ONLY: compare each terminal state with its pending data; this is not a verified counterexample.", tokens: 12 };
      }
      actionPrompts.push(String(prompt));
      return { content: JSON.stringify(actions.shift() ?? done), tokens: 1, stoppedEos: true, timings: {} };
    },
  };
  const result = await runAgent({ workspace, task: TASK, model, maxTurns: 10,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
    verificationScript: "npm test", shellProcessRunner: async () => ({ code: 0, stdout: GREEN, stderr: "" }),
    completionAudit: false, stateAudit: "off", contractStateAudit: "auto", diagnoseStuckTests: false,
    testFocus: false, regressionGuard: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    ...extra,
  });
  return { result, auditPrompts, actionPrompts };
}

test("first substantial edit audits once; a changed generation reaching green gets at most one further audit", async (t) => {
  const { result, auditPrompts } = await run(fixture(t), [
    { a: "read_file", p: "test/parser.test.js" }, write(1), verify,
    write(2), verify, write(3), verify, done,
  ]);
  const audited = result.turns.filter((turn) => turn.contractStateAudit);
  assert.equal(audited.length, 2);
  assert.equal(auditPrompts.length, 2);
  assert.equal(result.metrics.contractStateAudits, 2);
  assert.equal(result.metrics.contractStateAuditTokens, 24);
  assert.deepEqual(audited.map((turn) => turn.contractStateAudit.generation), [1, 2]);
  assert.equal(audited[0].action.a, "write_file");
  assert.equal(audited[0].verificationEvidence, null, "a model report cannot manufacture a test receipt");
  assert.equal(audited[0].contractStateAudit.status, "report");
  assert.equal(audited[0].contractStateAudit.advisory, true);
  assert.equal(audited[1].action.a, "shell");
  assert.equal(audited[1].verificationEvidence.status, "pass");
  assert.equal(audited[1].verificationEvidence.source, "shell");
  assert.equal(audited[1].verificationEvidence.counts.passed, 1);
  assert.equal(result.turns[2].contractStateAudit, undefined, "green in the already-audited generation is not a second audit");
  for (const prompt of auditPrompts) {
    assert.match(prompt, /ORIGINAL_BOUNDARY_CONTRACT/);
    assert.doesNotMatch(prompt, /TEST_ORACLE_NOT_FOR_AUDIT|You are Bantam|AUDIT_HYPOTHESIS_ONLY/);
  }
  assert.match(auditPrompts[0], /CURRENT_SOURCE_VERSION_1/);
  assert.match(auditPrompts[1], /CURRENT_SOURCE_VERSION_2/);
  assert.doesNotMatch(auditPrompts[1], /CURRENT_SOURCE_VERSION_1/);
});

test("independent audits keep original supplied contract bytes after the primary edits the document", async (t) => {
  const workspace = fixture(t);
  const changed = "# MUTABLE_DOCUMENT_NOT_AN_ORACLE\nEOF may silently discard records.\n";
  const { result, auditPrompts } = await run(workspace, [
    { a: "write_file", p: "REQUIREMENTS.md", content: changed }, write(1), verify, done,
  ]);
  assert.equal(fs.readFileSync(path.join(workspace, "REQUIREMENTS.md"), "utf8"), changed);
  assert.equal(auditPrompts.length, 1);
  assert.match(auditPrompts[0], /ORIGINAL_BOUNDARY_CONTRACT/);
  assert.doesNotMatch(auditPrompts[0], /MUTABLE_DOCUMENT_NOT_AN_ORACLE|EOF may silently discard/);
  assert.equal(result.turns[0].contractStateAudit, undefined, "a documentation-only edit is not substantial source");
});

test("explicitly disabled contract audits add no auxiliary model calls", async (t) => {
  const { result, auditPrompts, actionPrompts } = await run(fixture(t), [write(1), verify, done], { contractStateAudit: "off" });
  assert.equal(auditPrompts.length, 0);
  assert.equal(result.metrics.contractStateAudits ?? 0, 0);
  assert.ok(result.turns.every((turn) => !turn.contractStateAudit));
  assert.equal(actionPrompts.length, result.turns.length);
});

test("resuming a trajectory with two audit receipts never resets the per-run audit cap", async (t) => {
  const workspace = fixture(t);
  const checkpoint = new RunCheckpoint({ autosaveEvery: 0 });
  const first = await run(workspace, [write(1), verify, write(2), verify, done], { onEvent: (event) => checkpoint.note(event) });
  assert.equal(first.auditPrompts.length, 2);
  const film = buildArtifact({ runId: "audit-resume", stamp: "test", model: {}, result: first.result });
  const resumeTurns = JSON.parse(JSON.stringify(film.turns));
  assert.deepEqual(checkpoint.turns().filter((turn) => turn.contractStateAudit).map((turn) => turn.contractStateAudit),
    resumeTurns.filter((turn) => turn.contractStateAudit).map((turn) => turn.contractStateAudit));
  const resumed = await run(workspace, [write(3), verify, done], {
    resumeTurns, maxTurns: first.result.turns.length + 5,
  });
  assert.equal(resumed.auditPrompts.length, 0);
  assert.equal(resumed.result.metrics.contractStateAudits ?? 0, 0);
  assert.equal(resumed.result.turns.filter((turn) => turn.contractStateAudit).length, 2);
});
