import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingContractAudit, contractAuditRecoveryNote, isFocusedAuditCommand } from "../src/contract-audit-recovery.js";
import { verificationEvidence, verificationReceipt, shellExecutionReceipt } from "../src/verification-evidence.js";
import { buildAssertionProbe } from "../src/contract-assertion-spec.js";
import { canonicalEncode } from "../src/factory/fact-fabric.js";
import { projectProbeEvidence } from "../src/probe-evidence.js";
import { runContractAssertionStation } from "../src/contract-assertion-station.js";

const audit = { contractStateAudit: { focus: "collection-preconditions", status: "report", promptSha256: "audit-hash", report: "An unconditional precondition may be skipped with no entries.", sources: [] } };
const options = { generation: 1, configuredCommand: "npm test" };
const check = (command = "node --test test/edge.test.js", generation = 1, executionChanges = {}) => {
  const execution = { command, executedCommand: command, exitCode: 0, stdout: "", stderr: "", ...executionChanges };
  return { verificationEvidence: verificationReceipt(verificationEvidence({ execution, generation, configuredCommand: "npm test" })),
    shellExecution: shellExecutionReceipt(execution, { generation }) };
};
const project = () => check("npm test");

test("audit prose and same-turn or old-generation green cannot discharge a new review", () => {
  for (const turns of [[audit], [check(), audit], [{ ...audit, ...check() }], [audit, { observation: "All tests pass" }], [audit, check(undefined, 0)]]) {
    assert.equal(pendingContractAudit(turns, options)?.promptSha256, "audit-hash");
  }
  assert.equal(pendingContractAudit([audit, check()], { generation: 1 }), null);
  assert.equal(pendingContractAudit([audit, check(), project()], options), null);
});

test("fresh broad suite alone cannot discharge; project verification follows focused execution", () => {
  const broad = pendingContractAudit([audit, project()], options);
  assert.equal(broad.needsFocused, true);
  assert.deepEqual(broad.missing, ["focused-execution", "project-verification"]);
  const focused = pendingContractAudit([audit, check()], options);
  assert.equal(focused.needsFocused, false);
  assert.equal(focused.needsProject, true);
  assert.deepEqual(focused.missing, ["project-verification"]);
  assert.ok(pendingContractAudit([audit, project(), check()], options), "an older suite is not the final project verification");
  assert.equal(pendingContractAudit([audit, project(), check(), project()], options), null);
  assert.ok(pendingContractAudit([audit, project()], { generation: 1 }), "unconfigured broad suite still is not focused");
  assert.ok(pendingContractAudit([audit, check(), check("NODE_ENV=other npm test")], options), "changed verifier environment is not the configured command");
});

test("subsequent mutations, another audit, stopped or rolled-back checks do not inherit old proof", () => {
  assert.ok(pendingContractAudit([audit, check(), project()], { ...options, generation: 2 }));
  assert.equal(pendingContractAudit([audit, check(), project(), audit], options)?.turn, 3);
  assert.ok(pendingContractAudit([audit, { ...check(), controllerStop: { kind: "progress-gate" } }, project()], options));
  assert.ok(pendingContractAudit([audit, { ...check(), shellScopeRollback: { violations: ["protected"] } }, project()], options));
  assert.ok(pendingContractAudit([audit, check()], {}));
  assert.ok(pendingContractAudit([audit, { editApplied: true, action: { a: "write_file", p: "test/edge.test.js" } }, project()], options));
});

test("invalid typed verification wins over a parallel clean shell and invalidates earlier credit", () => {
  for (const patch of [
    { status: "fail" }, { status: "unverified" }, { schema: 2 }, { source: "model" },
    { generation: 0 }, { exitCode: 1 }, { invalidated: true }, { blocked: true },
    { counts: { total: 0 } }, { counts: { failed: 1 } }, { outputSha256: "not-a-hash" },
  ]) {
    const row = check(); row.verificationEvidence = { ...row.verificationEvidence, ...patch };
    assert.ok(pendingContractAudit([audit, check(), project(), row], options), JSON.stringify(patch));
    assert.ok(pendingContractAudit([audit, row, project()], options), JSON.stringify(patch));
  }
  assert.ok(pendingContractAudit([audit, { verificationEvidence: { status: "pass", generation: 1 } }, project()], options));
});

test("abnormal process receipts, status masking, and compound final-only scope cannot supply focused proof", () => {
  for (const patch of [{ error: "runner failed" }, { blocked: true }, { timedOut: true }, { interrupted: true }, { bufferExceeded: true }, { exitCode: 127 }]) {
    assert.ok(pendingContractAudit([audit, check(undefined, 1, patch), project()], options), JSON.stringify(patch));
  }
  const invalidated = check(); invalidated.shellExecution.invalidated = true;
  assert.ok(pendingContractAudit([audit, invalidated, project()], options));
  for (const command of ["node check-api.mjs | tail", "node check-api.mjs; echo DONE", "node check-api.mjs && npm test", "node check-api.mjs; npm test"]) {
    assert.ok(pendingContractAudit([audit, check(command), project()], options), command);
  }
});

test("focused command classification is concrete and direct, never echo, broad test, or a print/preload flag", () => {
  for (const command of ["node --test test/edge.test.js", "node check-api.mjs", "python check_api.py", "python3 witness_case.py", "pytest test/test_edge.py::test_empty", "MODE=check node probe-api.cjs"]) {
    assert.equal(isFocusedAuditCommand(command), true, command);
  }
  for (const command of ["npm test", "node --test", "node --test test/*.test.js", "node --test --test-name-pattern edge.js", "node app.js", "node -p check-api.mjs", "node --require check-api.mjs", "python -m check_api.py", "echo 'node check-api.mjs'", "node check-api.mjs > out", "node check-api.mjs; echo DONE", "node check-api.mjs --help", 'node "$(echo check-api.mjs)"']) {
    assert.equal(isFocusedAuditCommand(command), false, command);
  }
  assert.equal(isFocusedAuditCommand("node --test test/edge.test.js", "node --test test/edge.test.js"), false, "configured broad selection is not its own independent focused check");
});

test("inline assertions use clean shell execution receipts without inventing a project verification proof", () => {
  const commands = [
    `node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal(1, 1);'`,
    `node -e 'const assert = require("node:assert"); assert.ok(true);'`,
    `python3 -c 'assert 1 == 1'`,
  ];
  for (const command of commands) {
    assert.equal(isFocusedAuditCommand(command), true, command);
    const row = check(command);
    assert.equal(row.verificationEvidence, null, "inline shell receipt must not become suite verification");
    assert.equal(pendingContractAudit([audit, row, project()], options), null, command);
  }
  for (const command of [`node -e 'console.log("assert.equal(1,1)")'`, `node -e 'assert.ok(true)'`, `python -c 'print("assert true")'`]) {
    assert.equal(isFocusedAuditCommand(command), false, command);
  }
});

test("a named Node test with a concrete file counts only when an actual case passed", () => {
  for (const command of [
    "node --test --test-timeout=30000 --test-name-pattern='one invalid entry' test/edge.test.js",
    "node --test --test-name-pattern 'one invalid entry' test/edge.test.js",
  ]) {
    assert.equal(isFocusedAuditCommand(command), true);
    const row = check(command, 1, { stdout: "# tests 26\n# pass 1\n# fail 0\n# skipped 25\n" });
    assert.equal(row.verificationEvidence.counts.passed, 1);
    assert.equal(pendingContractAudit([audit, row, project()], options), null);
    assert.ok(pendingContractAudit([audit, check(command), project()], options), "no measured case count cannot qualify a filtered run");
    const skipped = check(command, 1, { stdout: "# tests 26\n# pass 0\n# fail 0\n# skipped 26\n" });
    assert.ok(pendingContractAudit([audit, skipped, project()], options), "all skipped is not a checked hypothesis");
    const failed = check(command, 1, { exitCode: 1, stdout: "# tests 26\n# pass 0\n# fail 1\n# skipped 25\n" });
    assert.ok(pendingContractAudit([audit, failed, project()], options));
  }
  for (const command of ["node --test --test-name-pattern", "node --test --test-name-pattern='edge'", "node --test --test-name-pattern='edge' test/*.js", "node --test --test-only test/edge.test.js"]) {
    assert.equal(isFocusedAuditCommand(command), false, command);
  }
});

const auditWorkspace = "/tmp/bantam-contract-recovery-ws";
const workspaceOptions = { ...options, workspace: auditWorkspace };
function workspaceCheck(command, { cwd = auditWorkspace, generation = 1, ...executionChanges } = {}) {
  const row = check(command, generation, { cwd, pipefail: true,
    stdout: "# tests 12\n# pass 12\n# fail 0\n", ...executionChanges });
  // Keep this command-recognition fixture independent of serializer tests.
  // The runtime supplies this field; neither task text nor stdout is cwd proof.
  row.shellExecution.cwd = cwd;
  return row;
}
const workspaceFocused = () => workspaceCheck(`cd ${auditWorkspace} && node --test test/edge.test.js`, {
  executedCommand: `cd ${auditWorkspace} && node --test --test-timeout=30000 test/edge.test.js`,
});
const workspaceProject = () => workspaceCheck(`cd ${auditWorkspace} && npm test`, {
  stdout: "# tests 15\n# pass 15\n# fail 0\n",
});

test("repair7-style workspace-bound cd launches credit actual focused then project PASS receipts", () => {
  const focused = workspaceFocused(), broad = workspaceProject();
  assert.equal(focused.verificationEvidence.status, "pass");
  assert.equal(focused.verificationEvidence.counts.passed, 12);
  assert.equal(broad.verificationEvidence.status, "pass");
  assert.equal(broad.verificationEvidence.counts.passed, 15);
  assert.equal(pendingContractAudit([audit, focused], workspaceOptions)?.needsFocused, false);
  assert.equal(pendingContractAudit([audit, focused], workspaceOptions)?.needsProject, true);
  assert.equal(pendingContractAudit([audit, focused, broad], workspaceOptions), null);
  assert.ok(pendingContractAudit([audit, broad], workspaceOptions), "the configured broad command is not focused");
  assert.ok(pendingContractAudit([audit, broad, focused], workspaceOptions), "project PASS still must follow focused PASS");
  assert.ok(pendingContractAudit([audit, focused, broad], options), "no current workspace means no cd normalization");
});

test("literal quoted absolute workspace paths qualify without interpreting shell expansion", () => {
  const workspace = "/tmp/bantam contract recovery";
  for (const directory of [`'${workspace}'`, `"${workspace}"`]) {
    const focused = workspaceCheck(`cd ${directory} && node --test test/edge.test.js`, { cwd: workspace });
    const broad = workspaceCheck(`cd ${directory} && npm test`, { cwd: workspace });
    assert.equal(pendingContractAudit([audit, focused, broad], { ...options, workspace }), null, directory);
  }
});

test("cd normalization requires current workspace and exact typed execution cwd, never missing or foreign metadata", () => {
  for (const cwd of [undefined, null, "", "relative/workspace", "/tmp/other-workspace", `${auditWorkspace}/child`]) {
    const row = workspaceFocused();
    if (cwd === undefined) delete row.shellExecution.cwd;
    else row.shellExecution.cwd = cwd;
    assert.ok(pendingContractAudit([audit, row, workspaceProject()], workspaceOptions), `cwd ${JSON.stringify(cwd)}`);
  }
  for (const workspace of [undefined, null, "", "relative/workspace", "/tmp/other-workspace"]) {
    assert.ok(pendingContractAudit([audit, workspaceFocused(), workspaceProject()], { ...options, workspace }),
      `workspace ${JSON.stringify(workspace)}`);
  }
  const proofOnly = workspaceFocused(); delete proofOnly.shellExecution;
  proofOnly.verificationEvidence.cwd = auditWorkspace;
  assert.ok(pendingContractAudit([audit, proofOnly, workspaceProject()], workspaceOptions),
    "proof text alone must not supply the bound shell execution cwd");
  const conflictingCwd = workspaceFocused(); conflictingCwd.verificationEvidence.cwd = "/tmp/other-workspace";
  assert.ok(pendingContractAudit([audit, conflictingCwd, workspaceProject()], workspaceOptions),
    "a present verification cwd cannot contradict the actual shell cwd");
  const badProject = workspaceProject(); badProject.shellExecution.cwd = "/tmp/other-workspace";
  assert.equal(pendingContractAudit([audit, workspaceFocused(), badProject], workspaceOptions)?.needsProject, true);
});

test("cd recognition rejects another directory, substitutions, relative paths, opaque setup and status masks", () => {
  const direct = "node --test test/edge.test.js";
  const commands = [
    `cd /tmp/other-workspace && ${direct}`,
    `cd . && ${direct}`,
    `cd ./bantam-contract-recovery-ws && ${direct}`,
    `cd "$PWD" && ${direct}`,
    String.raw`cd "/tmp/\bantam-contract-recovery-ws" && ${direct}`,
    `cd "$(pwd)" && ${direct}`,
    `cd \`pwd\` && ${direct}`,
    `cd ${auditWorkspace}/../bantam-contract-recovery-ws && ${direct}`,
    `env MODE=test cd ${auditWorkspace} && ${direct}`,
    `command cd ${auditWorkspace} && ${direct}`,
    `sh -c 'cd ${auditWorkspace} && ${direct}'`,
    `cd ${auditWorkspace}; ${direct}`,
    `cd ${auditWorkspace} || ${direct}`,
    `true && cd ${auditWorkspace} && ${direct}`,
    `cd ${auditWorkspace} && mkdir fixture && ${direct}`,
    `cd ${auditWorkspace} && cd /tmp/other-workspace && ${direct}`,
    `cd ${auditWorkspace} && ${direct}; echo EXIT=$?`,
    `cd ${auditWorkspace} && ${direct} || true`,
    `cd ${auditWorkspace} && ${direct} | tail -20`,
    `cd ${auditWorkspace} && ${direct} && npm test`,
  ];
  for (const command of commands) {
    const row = workspaceCheck(command);
    assert.ok(pendingContractAudit([audit, row, workspaceProject()], workspaceOptions), command);
  }
});

test("a rewritten proof command cannot launder an unrelated or unsafe actual cd execution", () => {
  for (const actual of [
    `cd /tmp/other-workspace && node --test test/edge.test.js`,
    `cd ${auditWorkspace} && node --test test/edge.test.js; echo done`,
    `cd ${auditWorkspace} && node --test test/other.test.js`,
  ]) {
    const row = workspaceFocused();
    row.shellExecution.command = actual; row.shellExecution.executedCommand = actual;
    assert.ok(pendingContractAudit([audit, row, workspaceProject()], workspaceOptions), actual);
  }
  const forgedScope = workspaceCheck(`cd /tmp/other-workspace && node --test test/edge.test.js`);
  forgedScope.verificationEvidence.statusCommand = "node --test test/edge.test.js";
  assert.ok(pendingContractAudit([audit, forgedScope, workspaceProject()], workspaceOptions),
    "statusCommand must remain tied to actual execution, not an invented direct suffix");
  for (const field of ["command", "executedCommand", "statusCommand"]) {
    const row = workspaceFocused();
    row.verificationEvidence[field] = `cd ${auditWorkspace} && node --test test/other.test.js`;
    assert.ok(pendingContractAudit([audit, row, workspaceProject()], workspaceOptions), field);
  }
});

test("workspace-bound named tests still need measured nonzero cases and clean current-generation execution", () => {
  const command = `cd ${auditWorkspace} && node --test --test-name-pattern='one boundary' test/edge.test.js`;
  const passed = workspaceCheck(command, { stdout: "# tests 12\n# pass 1\n# fail 0\n# skipped 11\n" });
  assert.equal(pendingContractAudit([audit, passed, workspaceProject()], workspaceOptions), null);
  for (const execution of [
    { stdout: "" }, { stdout: "# tests 12\n# pass 0\n# fail 0\n# skipped 12\n" },
    { exitCode: 1 }, { generation: 0 }, { timedOut: true }, { blocked: true },
  ]) {
    assert.ok(pendingContractAudit([audit, workspaceCheck(command, execution), workspaceProject()], workspaceOptions),
      JSON.stringify(execution));
  }
  const rolledBack = workspaceFocused(); rolledBack.shellScopeRollback = { violations: ["test/protected.test.js"] };
  assert.ok(pendingContractAudit([audit, rolledBack, workspaceProject()], workspaceOptions));
});

test("unavailable/state-only audits and unbound probe projections do not invent proof", () => {
  assert.equal(pendingContractAudit([{ contractStateAudit: { ...audit.contractStateAudit, status: "unavailable" } }], options), null);
  assert.equal(pendingContractAudit([{ contractStateAudit: { ...audit.contractStateAudit, focus: "state-boundaries" } }], options), null);
  assert.equal(pendingContractAudit([], options), null);
  assert.ok(pendingContractAudit([audit, { probeEvidence: { status: "assertion_passed" } }, project()], options));
});

test("recovery names missing stages and requires a real public API assertion without arbitrary edits or oracle claims", () => {
  const note = contractAuditRecoveryNote(pendingContractAudit([audit], options));
  for (const phrase of [/actual public API/, /zero-work/, /before scaling a fuzz run/, /Repair only a demonstrated defect/, /No extra turns/, /focused-execution/, /project-verification/, /node --test test\/edge.test.js/, /python check_api.py/, /not oracle correctness/]) assert.match(note, phrase);
  assert.equal(contractAuditRecoveryNote(null), "");
});

const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const digest = value => `sha256:${hash(canonicalEncode(value))}`;
function stationCase() {
  const source = "export function f() { return null; }\n";
  const sources = [{ path: "api.mjs", sha256: hash(source) }];
  const review = { contractStateAudit: { ...audit.contractStateAudit, generation: 1,
    promptSha256: hash("independent API review"), taskSha256: hash("public API contract"), sources } };
  const spec = { module: "api.mjs", export: "f", fixtures: [], args: [], expect: { kind: "equals", value: null } };
  const inputs = [{ p: "api.mjs", sha256: hash(source), size: Buffer.byteLength(source), mode: 420 }];
  const question = "Does f return the declared empty result?";
  const action = buildAssertionProbe(spec, { inputs: inputs.map(({ p }) => ({ p })), question });
  const inputDigest = digest(inputs), experimentId = "probe:station-test";
  const probe = { schema: "bantam.probe-receipt.v1", experimentId, specDigest: digest(action),
    sourceDigest: inputDigest, sourceAfterDigest: inputDigest, sourceAfterError: null, question, inputs,
    stages: ["setup", "witness", "check"].map(stage => ({ stage, experimentId, sourceDigest: inputDigest,
      command: action[stage], commandDigest: digest(action[stage]), executed: true, code: 0,
      signal: null, timedOut: false, aborted: false, bufferExceeded: false, error: null,
      stdout: "", stderr: "", stdoutDigest: digest(""), stderrDigest: digest("") })) };
  const station = { schema: "bantam.contract-assertion.v1", status: "assertion_passed", generation: 1,
    auditPromptSha256: review.contractStateAudit.promptSha256, taskSha256: review.contractStateAudit.taskSha256,
    promptSha256: hash("case planner prompt"), sources, inputs, inputDigest, question, spec,
    specSha256: hash(canonicalEncode(spec)), probeSpecDigest: digest(action), probeEvidence: probe };
  return { review, station };
}
const stationProject = (generation = 1, workspaceReadOnly = true) => check("npm test", generation,
  { workspaceReadOnly, stdout: "# tests 3\n# pass 3\n# fail 0\n" }).verificationEvidence;

test("a bound controller station followed by nested fresh verification discharges even the same audit turn", () => {
  const { review, station } = stationCase();
  station.projectVerification = stationProject();
  assert.equal(projectProbeEvidence(station.probeEvidence).status, "assertion_passed");
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], {
    ...options, verificationWorkspaceReadOnly: true,
  }), null);
  assert.equal(pendingContractAudit([review, { contractAssertion: station }], options), null);
});

test("station credit waits for a later project check and cannot borrow an old or same-turn broad pass", () => {
  const { review, station } = stationCase();
  for (const turns of [
    [{ ...review, ...project(), contractAssertion: station }],
    [project(), review, { ...project(), contractAssertion: station }],
  ]) {
    const pending = pendingContractAudit(turns, options);
    assert.equal(pending.needsFocused, false);
    assert.equal(pending.needsProject, true);
  }
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }, project()], options), null);
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], { generation: 1 }), null);
});

test("claimed status or cached projection cannot replace measured stage outcomes or the fixed assertion", () => {
  const mutations = [
    station => { station.probeEvidence = { projection: { status: "assertion_passed" } }; },
    station => { station.probeEvidence.stages[2].code = 1; station.probeEvidence.projection = { status: "assertion_passed" }; },
    station => { station.probeEvidence.stages[1].executed = false; },
    station => { station.probeEvidence.stages[2].timedOut = true; },
    station => { station.probeEvidence.stages[2].experimentId = "probe:other"; },
    station => { station.status = "unavailable"; },
    station => { station.status = "assertion_failed"; },
    station => { station.spec = { command: "echo assertion_passed" }; },
    station => {
      for (const stage of station.probeEvidence.stages) {
        stage.command = "echo assertion_passed"; stage.commandDigest = digest(stage.command);
      }
      assert.equal(projectProbeEvidence(station.probeEvidence).status, "assertion_passed",
        "a generic print-only probe projection is insufficient for this controller station");
    },
  ];
  for (const mutate of mutations) {
    const { review, station } = stationCase();
    mutate(station); station.projectVerification = stationProject();
    const pending = pendingContractAudit([{ ...review, contractAssertion: station }], options);
    assert.equal(pending.needsFocused, true);
    assert.equal(pending.needsProject, true);
  }
});

test("station audit, generation, module, source and specification bindings fail closed", () => {
  const mutations = [
    station => { station.auditPromptSha256 = hash("different audit"); },
    station => { station.generation = 0; },
    station => { station.taskSha256 = hash("different task"); },
    station => { station.sources = []; },
    station => { station.sources = [{ path: "other.mjs", sha256: hash("other") }]; },
    station => { station.sources = [{ path: "api.mjs", sha256: hash("changed source") }]; },
    station => { station.sources = [{ path: "../api.mjs", sha256: hash("source") }]; },
    station => { station.spec.module = "other.mjs"; },
    station => { station.inputs[0].sha256 = hash("changed input"); },
    station => { station.inputs[0].mode = 4096; },
    station => { station.probeEvidence.sourceAfterDigest = digest("source changed during probe"); },
    station => { station.inputDigest = digest("unbound inputs"); },
    station => { station.specSha256 = hash("different specification"); },
    station => { station.probeSpecDigest = digest("different probe"); },
    station => { station.probeEvidence.specDigest = digest("different probe"); },
    station => { station.probeEvidence.stages[2].stdout = "altered output"; },
  ];
  for (const mutate of mutations) {
    const { review, station } = stationCase();
    mutate(station); station.projectVerification = stationProject();
    assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], options)?.needsFocused, true);
  }
  const { review, station } = stationCase();
  review.contractStateAudit.generation = 0;
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], options)?.needsFocused, true);
});

test("nested project proof must be current, exact, clean and match the selected verification environment", () => {
  for (const patch of [
    { command: "node --test test/other.test.js" }, { executedCommand: "npm test; echo done" },
    { statusCommand: "node check-other.mjs" }, { generation: 0 }, { status: "fail" }, { status: "unverified" },
    { exitCode: 1 }, { blocked: true }, { timedOut: true }, { outputSha256: "not-a-hash" },
    { counts: { passed: -1, failed: 0, total: 1 } }, { counts: { passed: 0, failed: 0, total: 0 } },
    { schema: 2 }, { source: "model" }, { statusScope: "final-configured-command" }, { workspaceReadOnly: false },
  ]) {
    const { review, station } = stationCase();
    station.projectVerification = { ...stationProject(), ...patch };
    const pending = pendingContractAudit([{ ...review, contractAssertion: station }], {
      ...options, verificationWorkspaceReadOnly: true,
    });
    assert.equal(pending.needsFocused, false, JSON.stringify(patch));
    assert.equal(pending.needsProject, true, JSON.stringify(patch));
  }
});

test("a failed station needs recovery, but does not remove the independent manual focused path", () => {
  const { review, station } = stationCase();
  station.status = "assertion_failed"; station.probeEvidence.stages[2].code = 1;
  assert.ok(pendingContractAudit([review, check(), project(), { contractAssertion: station }], options));
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }, check(), project()], options), null);
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }, check(undefined, 2), check("npm test", 2)], {
    ...options, generation: 2,
  }), null, "manual recovery remains available after repair on a new source generation");
});

test("actual station receipt shape composes with recovery using a mocked worker and process runner", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-station-recovery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = "export function f() { return null; }\n";
  fs.writeFileSync(path.join(workspace, "api.mjs"), source);
  const { review, station: example } = stationCase();
  let stages = 0;
  const station = await runContractAssertionStation({ workspace,
    task: "public API contract", generation: 1, audit: review.contractStateAudit,
    sources: [{ ...review.contractStateAudit.sources[0], text: source }],
    model: { async complete() { return { content: JSON.stringify(example.spec), tokens: 100 }; } },
    processRunner: async (file, args) => {
      assert.equal(file, "docker"); assert.ok(args.includes("none")); stages++;
      return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, bufferExceeded: false };
    },
  });
  assert.equal(stages, 3);
  assert.equal(station.status, "assertion_passed");
  station.projectVerification = stationProject();
  assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], {
    ...options, verificationWorkspaceReadOnly: true,
  }), null);
});
