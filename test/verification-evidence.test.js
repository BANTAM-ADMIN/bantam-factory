import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { verificationEvidence, verificationReceipt, verificationShellStatusRisk, shellExecutionReceipt } from "../src/verification-evidence.js";
import { verificationVerdict } from "../src/done-guard.js";
import { createTestProvenance } from "../src/test-provenance.js";
import { runAgent } from "../src/agent.js";

const output = "# tests 4\n# pass 4\n# fail 0\n";

test('named check summaries with zero executed cases cannot produce a passing receipt', () => {
  for (const label of ['UV check', 'Atlas checks', 'rig tests', 'Lifecycle suite']) {
    const record = verificationEvidence({execution:{command:'node test/uv-check.js',
      code:0, stdout:`${label}: 0 passed, 0 failed\n`, stderr:''}, configuredCommand:'npm test', generation:2});
    assert.equal(record.status, 'unverified', label);
    assert.equal(record.counts, null);
  }
  const failed = verificationEvidence({execution:{command:'node test/uv-check.js',
    code:0, stdout:'UV check: 16 passed, 1 failed\n', stderr:''}, generation:2});
  assert.equal(failed.status, 'fail', 'reported failures survive an erroneous exit zero');
  assert.deepEqual(failed.counts, {passed:16, failed:1, total:17});
});
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

test("unknown pipeline stages cannot be certified by outer zero, generic errors or printed pass counts", () => {
  for (const stdout of ["", "Error: invalid sha256\n    at verify (verify.mjs:4:1)", output]) {
    const record = evidence({ command: "node verify.mjs 2>&1 | tail -20", stdout });
    assert.equal(record.status, "unverified");
    assert.equal(record.counts, null);
    assert.match(record.uncertainty, /pipeline stage exits/);
    assert.equal(record.pipefail, null);
  }
  assert.equal(evidence({ command: "node verify.mjs | tail -20", exitCode: 2, stdout: "Error: invalid sha256" }).status, "fail");
});

test("real generic Node crash behind tail is unknown without pipefail and failed with pipefail", () => {
  const command = `${JSON.stringify(process.execPath)} -e 'throw new Error("invalid sha256")' 2>&1 | tail -20`;
  for (const pipefail of [false, true]) {
    const run = spawnSync(pipefail ? "/bin/bash" : "/bin/sh", pipefail ? ["-o", "pipefail", "-c", command] : ["-c", command], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.error, undefined);
    assert.match(run.stdout, /Error: invalid sha256/);
    assert.equal(run.status, pipefail ? 1 : 0);
    const record = evidence({ command, stdout: run.stdout, stderr: run.stderr, exitCode: run.status, pipefail }, { configuredCommand: command });
    assert.equal(record.status, pipefail ? "fail" : "unverified");
    assert.equal(record.pipefail, pipefail);
  }
});

test("successful expected-error checks remain successful, including trusted pure pipelines", () => {
  const diagnostics = "Expected failure caught: Error: invalid sha256\nSyntaxError: expected malformed input\nAssertionError: expected mismatch\nTraceback (most recent call last): expected fixture\n";
  for (const command of ["node verify.mjs", "node verify.mjs 2>&1", "node verify.mjs >| verifier.log",
    "node verify.mjs --pattern 'a|b'", 'node verify.mjs --pattern "a|b"', "node verify.mjs --pattern a\\|b",
    "node verify.mjs # | tail -20", "node verify.mjs;"]) {
    const record = evidence({ command, stdout: diagnostics });
    assert.equal(record.status, "pass", command);
    assert.equal(record.uncertainty, undefined);
  }
  for (const command of ["node verify.mjs 2>&1 | tail -20", "node verify.mjs |& tail -20",
    "node verify.mjs --pattern 'a; b || c' | tail -20;"]) {
    const record = evidence({ command, stdout: diagnostics, pipefail: true });
    assert.equal(record.status, "pass", command);
    assert.equal(record.counts, null);
    assert.equal(verificationReceipt(record).pipefail, true);
  }
  assert.equal(evidence({ command: "npm test | tail -20", pipefail: true }).status, "pass");
  assert.equal(evidence({ command: "npm test && echo 'expected Error: fixture'" }).status, "pass");
});

test("pipefail metadata cannot certify compounds which reset, swallow or background status", () => {
  for (const command of ["node verify.mjs | tail -20; true", "node verify.mjs | tail -20 || true",
    "node verify.mjs | tail -20\nprintf done", "set +o pipefail && node verify.mjs | tail -20",
    "node verify.mjs | tail -20 &", "node verify.mjs || true", "! node verify.mjs | tail -20",
    "eval 'node verify.mjs | tail -20'"]) {
    const record = evidence({ command, stdout: output, pipefail: true }, { configuredCommand: command });
    assert.equal(record.status, "unverified", command);
    assert.equal(record.counts, null);
    assert.match(record.uncertainty, /outer shell success/);
  }
});

test("nested shells and substitutions cannot borrow the outer pipeline guarantee", () => {
  for (const command of ["bash -c 'node verify.mjs 2>&1 | tail -20'",
    "env NO_COLOR=1 /bin/sh -c 'node verify.mjs | tail -20'",
    "NO_COLOR=1 bash -c 'node verify.mjs | tail -20'",
    'node verify.mjs "$(false | true)"', "node verify.mjs `false | true`",
    "(node verify.mjs | tail -20)"]) {
    assert.ok(verificationShellStatusRisk(command, { pipefail: true }), command);
    const record = evidence({ command, pipefail: true }, { configuredCommand: command });
    assert.equal(record.status, "unverified", command);
  }
  assert.equal(verificationShellStatusRisk("bash -c 'node verify.mjs 2>&1'", { pipefail: true }), null);
});

test("status classification follows executed command and preserves trusted pipefail in shell receipts", () => {
  const execution = { command: "node verify.mjs", executedCommand: "node verify.mjs | tail -20",
    exitCode: 0, stdout: output, stderr: "", pipefail: false, scratchDirectory: "/tmp/run-owned-scratch" };
  assert.equal(evidence(execution).status, "unverified");
  assert.equal(shellExecutionReceipt(execution, { generation: 3 }).pipefail, false);
  assert.equal(shellExecutionReceipt({ ...execution, pipefail: true }, { generation: 3 }).pipefail, true);
  assert.equal(shellExecutionReceipt(execution, { generation: 3 }).scratchDirectory, execution.scratchDirectory);
  assert.equal(evidence(execution).scratchDirectory, execution.scratchDirectory);
  assert.equal(evidence({ ...execution, pipefail: "true" }).status, "unverified", "only a boolean execution guarantee is accepted");
});

test("a final exact configured verifier retains its own scope without certifying earlier sequential probes", () => {
  for (const separator of ["\n", "; "]) {
    const command = `node -e "console.log('focused probe passed')"${separator}npm test`;
    const record = evidence({ command, stdout: `focused probe passed\n${output}`, pipefail: true });
    assert.equal(record.status, "pass");
    assert.equal(record.statusScope, "final-configured-command");
    assert.equal(record.statusCommand, "npm test");
    assert.equal(record.countsScope, "compound-output-single-summary");
    assert.deepEqual(record.counts, { passed: 4, failed: 0, total: 4 });
  }
  assert.equal(evidence({ command: "node verify.mjs; npm test", stdout: output + output }).counts, null);
  for (const command of ["node verify.mjs | tail -20; npm test", "true || npm test",
    "exit 0; npm test", "command exit 0; npm test", "builtin exit 0; npm test", "command -p exit 0; npm test",
    "exec node verify.mjs; npm test", "node verify.mjs & npm test", "npm test; true"]) {
    assert.equal(evidence({ command, pipefail: true }).status, "unverified", command);
  }
});

test("quoted interpreter heredoc body is data, while shell pipeline and masking suffixes remain visible", () => {
  const body = "import assert from 'node:assert/strict';\nconst text = 'Error: expected | diagnostic';\nassert.ok(text.includes('Error'));";
  const direct = `node --input-type=module - <<'EOF'\n${body}\nEOF`;
  assert.equal(evidence({ command: direct, stdout: "expected Error: fixture" }, { configuredCommand: direct }).status, "pass");
  const final = evidence({ command: `${direct}\nnpm test` });
  assert.equal(final.status, "pass");assert.equal(final.statusScope, "final-configured-command");
  const inferred = evidence({ command: `${direct}\nnpm test` }, { configuredCommand: null });
  assert.equal(inferred.status, "pass");assert.equal(inferred.statusScope, "final-test-command");
  const piped = `node --input-type=module - <<'EOF' 2>&1 | tail -20\n${body}\nEOF`;
  assert.equal(evidence({ command: piped }, { configuredCommand: piped }).status, "unverified");
  assert.equal(evidence({ command: piped, pipefail: true }, { configuredCommand: piped }).status, "pass");
  for (const command of [`${direct}\ntrue`, `${piped}\ntrue`, `${piped}\nnpm test`]) {
    assert.equal(evidence({ command, pipefail: true }, { source: "automatic" }).status, "unverified", command);
  }
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
