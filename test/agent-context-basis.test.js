import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import { buildArtifact } from "../src/artifact.js";

const CONTRACT = "# ORIGINAL_SUPPLIED_CONTEXT_BASIS\nImplement an incremental stream parser. Chunks may split anywhere. At EOF flush pending records; an empty stream emits nothing.\n";
const TASK = "Repair the incremental stream parser according to REQUIREMENTS.md. Run npm test.";
const CHANGED_CONTRACT = "# EDITED_DOCUMENT_NOT_SUPPLIED_AUTHORITY\nAn incremental parser may discard pending records at EOF.\n";
const source = (version) => `// CURRENT_SOURCE_${version}\n`
  + "// State and pending data must be considered together at the public parser boundaries.\n".repeat(6)
  + `export function parse() { return ${version}; }\n`;
const testSource = (name) => "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + `test('${name}', () => { assert.equal(0, 1); });\n`;
const writeSource = (version) => ({ a: "write_file", p: "src/parser.js", content: source(version) });
const writeGenerated = { a: "write_file", p: "test/generated.test.js", content: testSource("generated expectation") };
const verify = { a: "shell", c: "npm test" };
const verifyAgain = { a: "shell", c: "node --test test/provided.test.js test/generated.test.js" };

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-context-basis-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(workspace, "test"));
  fs.writeFileSync(path.join(workspace, "REQUIREMENTS.md"), CONTRACT);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }));
  fs.writeFileSync(path.join(workspace, "src/parser.js"), source(0));
  fs.writeFileSync(path.join(workspace, "test/provided.test.js"), testSource("provided expectation"));
  return workspace;
}

function relocate(t, workspace) {
  const relocated = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-context-relocated-"));
  t.after(() => fs.rmSync(relocated, { recursive: true, force: true }));
  fs.cpSync(workspace, relocated, { recursive: true });
  return relocated;
}

function failedOutput(workspace) {
  const blocks = [["provided", "provided expectation"], ["generated", "generated expectation"]]
    .map(([file, name], i) => `not ok ${i + 1} - ${name}\n  ---\n  location: '${workspace}/test/${file}.test.js:3:1'\n  error: 'Expected values to be strictly equal'\n  code: 'ERR_ASSERTION'\n  expected: 1\n  actual: 0\n  operator: 'strictEqual'\n  ...`);
  return `TAP version 13\n${blocks.join("\n")}\n1..2\n# tests 2\n# pass 0\n# fail 2\n`;
}

function filmTurns(result) {
  return JSON.parse(JSON.stringify(buildArtifact({ runId: "context-basis", stamp: "test", model: {}, result }).turns));
}

async function run(workspace, actions, extra = {}) {
  const auditPrompts = [];
  const model = { assistantPrefill: "", actTemperature: null, async complete(prompt) {
    if (String(prompt).includes("You are a source-code state-machine auditor.")) {
      auditPrompts.push(String(prompt));
      return { content: "No supported counterexample established; this is not verification.", tokens: 8 };
    }
    assert.ok(actions.length, "stub model must not receive unexpected action requests");
    return { content: JSON.stringify(actions.shift()), tokens: 1, stoppedEos: true, timings: {} };
  } };
  const result = await runAgent({ workspace, task: TASK, model,
    maxTurns: (extra.resumeTurns?.length ?? 0) + actions.length,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
    verificationScript: "npm test",
    shellProcessRunner: async () => ({ code: 1, stdout: failedOutput(workspace), stderr: "" }),
    completionAudit: false, stateAudit: "off", contractStateAudit: "off", diagnoseStuckTests: false,
    testFocus: true, regressionGuard: false, autoVerifyBlindEdits: 0, autoVerifyProbes: 0, autoVerifyStaleTurns: 0,
    ...extra,
  });
  return { result, auditPrompts };
}

test("artifact round-trip and relocated resume preserve supplied versus generated test authority", async (t) => {
  const workspace = fixture(t);
  const first = await run(workspace, [writeGenerated, verify]);
  const firstFocus = first.result.turns.at(-1).observation;
  assert.match(firstFocus, /Test provenance: baseline/);
  assert.match(firstFocus, /Test provenance: generated/);
  const resumeTurns = filmTurns(first.result);
  assert.equal(resumeTurns.filter((turn) => turn.contextBasis).length, 1);
  assert.equal(resumeTurns[0].contextBasis.schema, 1);
  assert.ok(resumeTurns[0].contextBasis.testProvenance.originals.some(([file]) => file === "test/provided.test.js"));
  assert.ok(!resumeTurns[0].contextBasis.testProvenance.originals.some(([file]) => file === "test/generated.test.js"));
  const relocated = relocate(t, workspace);
  const resumed = await run(relocated, [verifyAgain], { resumeTurns });
  const focus = resumed.result.turns.at(-1).observation;
  assert.match(focus, /Test provenance: baseline/);
  assert.match(focus, /Test provenance: generated/);
  assert.doesNotMatch(focus, /Test provenance: unknown/);
  assert.equal(resumed.result.turns.filter((turn) => turn.contextBasis).length, 1);
  assert.deepEqual(resumed.result.turns[0].contextBasis, resumeTurns[0].contextBasis);
});

test("a resumed independent audit uses original supplied document bytes after source and document edits", async (t) => {
  const workspace = fixture(t);
  const first = await run(workspace, [writeSource(1), { a: "write_file", p: "REQUIREMENTS.md", content: CHANGED_CONTRACT }]);
  assert.equal(fs.readFileSync(path.join(workspace, "REQUIREMENTS.md"), "utf8"), CHANGED_CONTRACT);
  const resumeTurns = filmTurns(first.result);
  assert.deepEqual(resumeTurns[0].contextBasis.suppliedTaskDocuments, [{ path: "REQUIREMENTS.md", text: CONTRACT, truncated: false }]);
  const resumed = await run(relocate(t, workspace), [writeSource(2)], { resumeTurns, contractStateAudit: "auto" });
  assert.equal(resumed.auditPrompts.length, 1);
  assert.match(resumed.auditPrompts[0], /ORIGINAL_SUPPLIED_CONTEXT_BASIS/);
  assert.match(resumed.auditPrompts[0], /CURRENT_SOURCE_2/);
  assert.doesNotMatch(resumed.auditPrompts[0], /EDITED_DOCUMENT_NOT_SUPPLIED_AUTHORITY|CURRENT_SOURCE_1/);
});

test("legacy resume without a saved context basis does not promote current tests or documents to supplied authority", async (t) => {
  const workspace = fixture(t);
  const first = await run(workspace, [writeGenerated, { a: "write_file", p: "REQUIREMENTS.md", content: CHANGED_CONTRACT }]);
  const resumeTurns = filmTurns(first.result).map(({ contextBasis, ...turn }) => turn);
  const resumed = await run(relocate(t, workspace), [writeSource(2), verifyAgain], { resumeTurns, contractStateAudit: "auto" });
  const focus = resumed.result.turns.at(-1).observation;
  assert.equal([...focus.matchAll(/Test provenance: unknown/g)].length, 2);
  assert.doesNotMatch(focus, /Test provenance: baseline|Test provenance: generated/);
  assert.equal(resumed.auditPrompts.length, 0, "current edited documents cannot reactivate an original-contract audit");
  const recovered = resumed.result.turns.slice(resumeTurns.length).find((turn) => turn.contextBasis)?.contextBasis;
  assert.deepEqual(recovered.suppliedTaskDocuments, []);
  assert.equal(recovered.testProvenance.complete, false);
  assert.deepEqual(recovered.testProvenance.originals, []);
});
