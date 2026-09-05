import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verificationEvidence, verificationReceipt } from "../src/verification-evidence.js";
import { verificationVerdict } from "../src/done-guard.js";
import { createTestProvenance } from "../src/test-provenance.js";
import { runAgent } from "../src/agent.js";

const output = "# tests 4\n# pass 4\n# fail 0\n";
const evidence = (overrides = {}, options = {}) => verificationEvidence({
  execution: { command: "npm test", exitCode: 0, stdout: output, stderr: "", ...overrides },
  generation: 3, configuredCommand: "npm test", ...options,
});

test("verification requires execution, retains command/generation and hashes its raw output", () => {
  assert.equal(verificationEvidence({ observation: "# pass 0\n# fail 32" }), null);
  const record = evidence();
  assert.equal(record.command, "npm test");
  assert.equal(record.generation, 3);
  assert.deepEqual(record.counts, { passed: 4, failed: 0, total: 4 });
  assert.equal(record.status, "pass");
  assert.equal(verificationReceipt(record).rawOutput, undefined);
  assert.match(verificationReceipt(record).outputSha256, /^[a-f0-9]{64}$/);
});

test("timeouts, cancellation, infrastructure errors and restored scope never supply proof", () => {
  for (const overrides of [{ timedOut: true }, { interrupted: true }, { aborted: true },
    { error: "spawn failed" }, { bufferExceeded: true }, { exitCode: null }, { blocked: true }]) {
    const record = evidence(overrides);
    assert.equal(record.status, "unverified");
    assert.equal(record.counts, null);
  }
  assert.equal(evidence({}, { invalidated: true }).status, "unverified");
});

test("raw syntax diagnostics are not counts; swallowed nonzero failures are not green", () => {
  assert.equal(evidence({ stdout: "ERROR: test/csv.test.js:62:32 failed to parse", exitCode: 1 }).counts, null);
  assert.equal(evidence({ stdout: "# pass 3\n# fail 1\n" }).status, "fail");
  assert.equal(evidence({ command: "echo '4 passed'", stdout: "4 passed" }), null);
});

test("typed metadata wins over rendered commentary and legacy films remain readable", () => {
  const action = { a: "shell", c: "npm test" };
  assert.equal(verificationVerdict({ action, verificationEvidence: evidence(), observation: "exit 1\n# fail 32" }), "pass");
  assert.equal(verificationVerdict({ action, verificationEvidence: null, observation: "exit 0\n# pass 4\n# fail 0" }), null);
  assert.equal(verificationVerdict({ action, verificationEvidence: evidence({ timedOut: true }), scopedVerify: { verdict: "pass" } }), null);
  assert.equal(verificationVerdict({ action, observation: "exit 0\n# pass 4\n# fail 0" }), "pass");
});

test("empty suites are unverified and multiple summaries cannot seed a regression baseline", () => {
  assert.equal(evidence({ stdout: '# pass 0\n# fail 0\n# skipped 4\n' }).status, 'unverified');
  const multiple = evidence({ stdout: '# pass 30\n# fail 0\n# pass 4\n# fail 0\n' });
  assert.equal(multiple.counts, null);
  assert.equal(multiple.countsScope, 'multiple-summaries');
  assert.equal(multiple.status, 'pass');
  assert.equal(evidence({ stdout: '# pass 30\n# fail 0\n# pass 2\n# fail 2\n' }).status, 'fail');
});

test("masked runner crashes are uncertainty, not an invented passing or failing suite", () => {
  const record = evidence({ command: 'python broken.py || true', stdout: 'Traceback (most recent call last):\nSyntaxError: bad input' });
  assert.equal(record.status, 'unverified');
  assert.equal(record.counts, null);
  assert.match(record.uncertainty, /outer shell success/);
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-evidence-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "test/base.test.js"), "test('supplied', () => {\n  assert.equal(value, 1);\n});\n");
  return root;
}

test("test provenance distinguishes appended assertions inside a supplied file", (t) => {
  const root = workspace(t);
  const classify = createTestProvenance(root);
  assert.equal(classify({ file: "test/base.test.js", line: 1 }), "baseline");
  fs.appendFileSync(path.join(root, "test/base.test.js"), "test('new', () => {\n  assert.equal(value, 999);\n});\n");
  assert.equal(classify({ file: "test/base.test.js", line: 4 }), "self-authored");
  assert.equal(classify({ file: "test/base.test.js", line: 1 }), "baseline-context-changed");
  fs.writeFileSync(path.join(root, "test/new.test.js"), "test('new', () => {});\n");
  assert.equal(classify({ file: "test/new.test.js", line: 1 }), "generated");
  assert.equal(classify({ file: "/etc/passwd", line: 1 }), "unknown");
});

test("incomplete provenance snapshots do not call unobserved tests generated", (t) => {
  const root = workspace(t);
  assert.equal(createTestProvenance(root, { maxBytes: 1 })({ file: "test/base.test.js", line: 1 }), "unknown");
  assert.equal(createTestProvenance(root, { protectedPath: () => true })({ file: "test/base.test.js", line: 1 }), "protected");
  const protectedTest = createTestProvenance(root, { protectedPath: () => true });
  fs.appendFileSync(path.join(root, "test/base.test.js"), "test('added', () => {});\n");
  assert.equal(protectedTest({ file: "test/base.test.js", line: 4 }), "protected");
});

function model(actions) {
  return { assistantPrefill: "", actTemperature: null,
    async complete() { return { content: JSON.stringify(actions.shift() ?? { a: "done", summary: "done" }), tokens: 1, timings: {} }; },
  };
}

test("a refused syntax edit never seeds first-measurement or flaky-suite feedback", async (t) => {
  const root = workspace(t);
  const result = await runAgent({
    workspace: root, task: "Repair the CSV parser.", useGrammar: false, shellSandbox: "host", maxTurns: 2,
    autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0,
    model: model([{ a: "write_file", p: "test/csv.test.js", content: "\n".repeat(61) + "const invalid = ;" }]),
  });
  const edit = result.turns.find((turn) => turn.action?.a === "write_file");
  assert.equal(edit.editOutcome.reason, "syntax_invalid");
  assert.equal(edit.verificationEvidence, null);
  assert.equal(result.metrics.firstMeasurementNotices ?? 0, 0);
  assert.equal(result.metrics.flakySuiteNotices ?? 0, 0);
  assert.doesNotMatch(edit.observation, /\[baseline\]|\[flaky-suite\]|\[fix-tests\]/);
});

test("automatic runs retain their actual command on edit turns", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "impl.txt"), "old");
  const result = await runAgent({
    // Keep this automatic-only receipt outside the landing window: a later
    // actual landing execution correctly supersedes its source on that turn.
    workspace: root, task: "Update impl.txt.", useGrammar: false, shellSandbox: "host", maxTurns: 4,
    verificationScript: "printf '# pass 4\\n# fail 0\\n'", autoVerifyBlindEdits: 1,
    model: model([{ a: "write_file", p: "impl.txt", content: "new" }]),
  });
  const edit = result.turns.find((turn) => turn.action?.a === "write_file");
  assert.equal(edit.verificationEvidence.source, "automatic");
  assert.equal(edit.verificationEvidence.command, "printf '# pass 4\\n# fail 0\\n'");
  assert.equal(edit.verificationEvidence.status, "pass");
  assert.equal(edit.verificationEvidence.generation, 1);
});
