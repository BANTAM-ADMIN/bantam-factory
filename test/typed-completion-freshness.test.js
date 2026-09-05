import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prematureDoneObjection, ranVerification, unverifiedEditObjection } from "../src/done-guard.js";

const receipt = (status = "pass", overrides = {}) => ({
  schema: 1, source: "shell", command: "npm test", configuredCommand: "npm test",
  generation: 1, exitCode: status === "fail" ? 1 : 0, status,
  counts: { passed: status === "pass" ? 3 : 2, failed: status === "fail" ? 1 : 0, total: 3 },
  ...overrides,
});
const shell = (record) => ({ action: { a: "shell", c: record?.command ?? "npm test" }, verificationEvidence: record });
const edit = (record = null) => ({
  action: { a: "write_file", p: "impl.js", content: "export const n = 1;" },
  editOutcome: { applied: true, reason: "applied", paths: ["impl.js"] },
  verificationEvidence: record,
});

test("an automatic or scoped run on an edit turn clears an earlier real suite failure", () => {
  for (const source of ["automatic", "scoped"]) {
    const turns = [shell(receipt("fail", { generation: 0 })), edit(receipt("pass", { source }))];
    assert.equal(prematureDoneObjection(turns, 0, { workspaceGeneration: 1 }), null);
    assert.equal(unverifiedEditObjection(turns, 0, { workspaceGeneration: 1 }), null);
  }
});

test("legacy scoped stamps on edit turns retain suite precedence", () => {
  const turns = [
    { action: { a: "shell", c: "npm test" }, observation: "# pass 2\n# fail 1" },
    { action: { a: "write_file", p: "impl.js" }, observation: "wrote impl.js", scopedVerify: { verdict: "pass", command: "npm test" } },
  ];
  assert.equal(prematureDoneObjection(turns), null);
});

test("same-turn restore invalidates a pre-restoration verification receipt", () => {
  const turns = [edit(receipt("pass", { source: "automatic" }))];
  assert.match(prematureDoneObjection(turns, 0, { workspaceGeneration: 2 }), /earlier workspace state/);
  assert.match(unverifiedEditObjection(turns, 0, { workspaceGeneration: 2 }), /never ran anything/);
  turns.push(shell(receipt("pass", { generation: 2 })));
  assert.equal(prematureDoneObjection(turns, 0, { workspaceGeneration: 2 }), null);
  assert.equal(unverifiedEditObjection(turns, 0, { workspaceGeneration: 2 }), null);
});

test("typed receipts missing generation cannot certify a known current generation", () => {
  const turns = [edit(), shell(receipt("pass", { generation: undefined }))];
  assert.match(prematureDoneObjection(turns, 0, { workspaceGeneration: 2 }), /earlier workspace state/);
  assert.match(unverifiedEditObjection(turns, 0, { workspaceGeneration: 2 }), /never ran anything/);
  assert.equal(prematureDoneObjection(turns), null, "generation-free historical callers remain supported");
});

test("unverified typed outcomes cannot clear a prior failure through prose or legacy stamps", () => {
  for (const record of [null, receipt("unverified")]) {
    const uncertain = { ...shell(record), observation: "# pass 3\n# fail 0\nexit 0", scopedVerify: { verdict: "pass" } };
    assert.equal(ranVerification(uncertain), false);
    assert.match(prematureDoneObjection([shell(receipt("fail")), uncertain], 0, { workspaceGeneration: 1 }), /failing tests/);
    assert.match(unverifiedEditObjection([edit(), uncertain], 0, { workspaceGeneration: 1 }), /never ran anything/);
  }
});

test("a successful deliverable launch does not replace a real suite verdict", () => {
  const launch = shell(receipt("pass", { command: "node impl.js", configuredCommand: null }));
  assert.match(prematureDoneObjection([shell(receipt("fail")), launch]), /failing tests/);
});

test("configured nonstandard verifier retains its actual command and outranks deliverable launches", () => {
  const custom = "./verify-project";
  const turns = [edit(receipt("fail", { source: "automatic", command: custom, configuredCommand: custom }))];
  assert.match(prematureDoneObjection(turns, 0, { workspaceGeneration: 2 }), /verify-project/);
  turns.push(shell(receipt("pass", { command: "node impl.js", configuredCommand: null })));
  assert.match(prematureDoneObjection(turns, 0, { workspaceGeneration: 1 }), /failing tests/);
});

test("typed absence cannot become probe proof from harmless-looking feedback", () => {
  const turns = [edit(), {
    action: { a: "shell", c: "node -e 'require(\"./impl.js\")'" },
    observation: "Confirmation required before running impl.js.", verificationEvidence: null,
  }];
  assert.match(unverifiedEditObjection(turns, 0, { verifierConfigured: false, workspaceGeneration: 1 }), /never ran anything/);
});

test("no-verifier inline probes use raw exit and current generation, never rendered prose", () => {
  const command = "node -e 'require(\"./impl.js\")'";
  const probe = {
    action: { a: "shell", c: command }, verificationEvidence: null,
    observation: "ERROR: this rendered annotation is not the process result",
    shellExecution: { command, exitCode: 0, generation: 1, invalidated: false },
  };
  const opts = { verifierConfigured: false, workspaceGeneration: 1 };
  assert.equal(unverifiedEditObjection([edit(), probe], 0, opts), null);
  assert.match(unverifiedEditObjection([edit(), { ...probe, verificationEvidence: receipt("unverified") }], 0, opts), /never ran anything/);
  assert.match(prematureDoneObjection([edit(), { ...probe, verificationEvidence: receipt("fail") }], 0, opts), /failing tests/);
  for (const invalid of [{ exitCode: 1 }, { generation: 0 }, { generation: undefined },
    { invalidated: true }, { timedOut: true }, { interrupted: true }, { error: "spawn failed" },
    { bufferExceeded: true }, { blocked: true }, { command: "cat impl.js" }]) {
    const turn = { ...probe, observation: "exit 0", shellExecution: { ...probe.shellExecution, ...invalid } };
    assert.match(unverifiedEditObjection([edit(), turn], 0, opts), /never ran anything/);
  }
});

test("raw execution of a newly edited extensionless deliverable remains valid exercise", () => {
  const changed = edit();
  changed.action.p = "tool";
  changed.editOutcome.paths = ["tool"];
  const command = "python3 tool --help";
  const probe = { action: { a: "shell", c: command }, verificationEvidence: null,
    shellExecution: { command, exitCode: 0, generation: 1 }, observation: "" };
  assert.equal(unverifiedEditObjection([changed, probe], 0, { verifierConfigured: false, workspaceGeneration: 1 }), null);
});

test("known-failure escape uses complete typed failure names, not rendered names", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-typed-known-reds-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, ".bantam"));
  fs.writeFileSync(path.join(workspace, ".bantam", "known-failures.json"), JSON.stringify(["inherited red"]));
  const record = receipt("fail", { failingTests: ["inherited red"] });
  const opts = { workspace, workspaceGeneration: 1 };
  assert.equal(prematureDoneObjection([edit(), shell(record)], 0, opts), null);
  for (const overrides of [{ failingTests: ["new failure"] }, { failingTests: [] },
    { failingTestsComplete: false }, { counts: { passed: 1, failed: 2, total: 3 } },
    { countsScope: "multiple-summaries" }]) {
    const run = { ...shell({ ...record, ...overrides }), observation: "not ok 1 - inherited red" };
    assert.match(prematureDoneObjection([edit(), run], 0, opts), /failing tests/);
  }
});
