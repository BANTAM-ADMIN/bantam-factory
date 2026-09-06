import assert from "node:assert/strict";
import test from "node:test";
import { DONE_GATES } from "../src/done-gates.js";
import { unresolvedRunFailure, unresolvedEvidenceObjection } from "../src/logic/evidence-guard.js";
import { deliverableTurnEvidence, recordTurns } from "../src/logic/runlog.js";
import { legacyProcessObservation, nonZeroExit } from "../src/logic/deliverable-signals.js";
import { verificationEvidence, verificationReceipt } from "../src/verification-evidence.js";

const receipt = (status = "pass", overrides = {}) => ({
  schema: 1, source: "shell", command: "npm test 2>&1", generation: 13,
  exitCode: status === "fail" ? 1 : 0, status, ...overrides,
});
const shell = (record, observation = "exit 0\n# pass 3\n# fail 0") => ({
  parsedAction: { a: "shell", c: "npm test 2>&1" },
  verificationEvidence: record, observation,
});

test("RepoBrief card 1 and card 3: successful receipts survive assignment prose appended to output", () => {
  for (const [generation, requirement] of [
    [13, "A non-repository directory must exit 1, write a useful nonempty error to stderr."],
    [8, "A missing/empty label is a usage error: exit 1 with nonempty stderr."],
  ]) {
    const evidence = verificationEvidence({
      command: "npm test 2>&1", generation,
      execution: { exitCode: 0, stdout: "# pass 3\n# fail 0\n", stderr: "" },
    });
    const turn = shell(verificationReceipt(evidence),
      `$ npm test 2>&1\nexit 0\n# pass 3\n# fail 0\n\n[guidance]\n${requirement}`);
    assert.equal(unresolvedRunFailure([turn]), null);
    assert.equal(unresolvedEvidenceObjection([turn], 0, { workspaceGeneration: generation }), null);
    assert.equal(recordTurns([turn]).asof("run", "deliverable", 0).v, "pass");
  }
});

test("typed verdict AND typed failure reason take precedence over contradictory transcript text", () => {
  assert.equal(unresolvedRunFailure([shell(receipt(), "Segmentation fault\nFAILED\nexit 9")]), null);
  assert.deepEqual(unresolvedRunFailure([shell(receipt("fail", { exitCode: 7 }),
    "exit 0\n# pass 3\n# fail 0\n\n[guidance]\nSIGSEGV")]),
  { cmd: "npm test 2>&1", reason: "exit 7", idx: 0 });
  assert.equal(unresolvedRunFailure([shell(receipt("fail", { exitCode: 0 }))]).reason, "test-failure");
});

test("null/unavailable typed evidence cannot become proof through prose or a legacy stamp", () => {
  for (const record of [null, receipt("unverified"), receipt("pass", { invalidated: true }),
    receipt("pass", { timedOut: true })]) {
    const uncertain = { ...shell(record), scopedVerify: { verdict: "pass" } };
    assert.equal(deliverableTurnEvidence(uncertain), null);
    assert.equal(unresolvedRunFailure([shell(receipt("fail")), uncertain]).idx, 0);
  }
});

test("standalone process receipts govern edited extensionless deliverable runs", () => {
  const edit = { action: { a: "write_file", p: "tool" }, observation: "wrote tool" };
  const turn = { action: { a: "shell", c: "python3 tool" }, verificationEvidence: null,
    shellExecution: { command: "python3 tool", generation: 13, exitCode: 0 },
    observation: "exit 1\n\n[guidance]\nFAILED" };
  assert.equal(unresolvedRunFailure([edit, turn]), null);
  turn.shellExecution.exitCode = 4;
  assert.equal(unresolvedRunFailure([edit, turn]).reason, "exit 4");
  for (const invalid of [{ invalidated: true }, { timedOut: true }, { interrupted: true },
    { bufferExceeded: true }, { blocked: true }, { error: "not spawned" }, { exitCode: null }]) {
    assert.equal(deliverableTurnEvidence({ ...turn, shellExecution: { ...turn.shellExecution, ...invalid } },
      { editedNames: new Set(["tool"]) }), null);
  }
});

test("current generation cannot be cleared by stale or generationless passing evidence", () => {
  for (const generation of [12, undefined]) {
    const turns = [shell(receipt("fail")), shell(receipt("pass", { generation }))];
    assert.equal(unresolvedRunFailure(turns, { workspaceGeneration: 13 }).idx, 0);
    const gate = DONE_GATES.find((entry) => entry.name === "evidence");
    assert.match(gate.evaluate({ turns, count: () => 0, workspaceGeneration: 13 }), /exit 1/);
    assert.equal(unresolvedRunFailure(turns), null, "historical callers can query without a current generation");
  }
  assert.equal(unresolvedRunFailure([shell(receipt("fail"))], { workspaceGeneration: 14 }), null,
    "do not claim an old failure describes the new tree; freshness has its own gate");
});

test("automatic/scoped verification uses its own receipt command on an edit turn", () => {
  for (const source of ["automatic", "scoped", "landing"]) {
    const edit = { action: { a: "replace", p: "impl.js" },
      verificationEvidence: receipt("pass", { source, command: "./verify-project" }) };
    assert.equal(unresolvedRunFailure([shell(receipt("fail")), edit]), null);
    edit.verificationEvidence.status = "fail";
    edit.verificationEvidence.exitCode = 2;
    assert.deepEqual(unresolvedRunFailure([edit]), { cmd: "./verify-project", reason: "exit 2", idx: 0 });
  }
});

test("legacy failure parsing stops at annotations and requires an actual exit-status line", () => {
  const action = { a: "shell", c: "npm test" };
  for (const annotation of ["guidance", "completion-audit", "review", "assignment"]) {
    const observation = `exit 0\n3 passed\n\n[${annotation}]\nexit 1\nFAILED\nSIGSEGV`;
    assert.equal(unresolvedRunFailure([{ action, observation }]), null);
    assert.equal(legacyProcessObservation(observation), "exit 0\n3 passed");
    assert.equal(deliverableTurnEvidence({ action, observation: `[${annotation}]\nexit 0` }), null);
  }
  assert.equal(nonZeroExit("A non-repository directory must exit 1."), null);
  for (const status of ["exit 1", "exit=2", "exit code: 3", "exit status 4", "returncode: 5"]) {
    assert.ok(unresolvedRunFailure([{ action, observation: status }]));
  }
  assert.equal(unresolvedRunFailure([{ action, observation: "exit 0\n[stderr]\nSegmentation fault" }]).reason, "crash");
  assert.equal(unresolvedRunFailure([{ action, observation: "exit 1" },
    { action, observation: "[repetition] same check; exit 0" }]).idx, 0);
});

test("unknown bracketed process logs and metadata-only prefixes cannot clear a prior failure", () => {
  const action = { a: "shell", c: "npm test" };
  const failure = { action, observation: "exit 1" };
  for (const observation of [
    "$ npm test\ncwd: /workspace\n[error] test failed\nexit 1",
    "$ npm test\nexit 0\n[error] inner process failed\nexit 1",
    "$ npm test\ncwd: /workspace\n[guidance]\nexit 0",
    "$ npm test\ncwd: /workspace\nsandbox: host\n",
  ]) {
    const uncertain = { action, observation };
    assert.equal(deliverableTurnEvidence(uncertain), null, observation);
    assert.equal(unresolvedRunFailure([failure, uncertain]).idx, 0);
  }
});
