import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingContractAudit, currentFocusedAuditWitness, contractAuditRecoveryNote, isFocusedAuditCommand, VERIFICATION_RECEIPTS_SCHEMA } from "../src/contract-audit-recovery.js";
import { verificationEvidence, verificationReceipt, shellExecutionReceipt } from "../src/verification-evidence.js";
import { buildAssertionProbe } from "../src/contract-assertion-spec.js";
import { canonicalEncode } from "../src/factory/fact-fabric.js";
import { projectProbeEvidence } from "../src/probe-evidence.js";
import { runContractAssertionStation } from "../src/contract-assertion-station.js";
import { clipKeepingControllerAnnotation } from "../src/prompt.js";

const audit = { contractStateAudit: { focus: "collection-preconditions", status: "report", promptSha256: "audit-hash", report: "An unconditional precondition may be skipped with no entries.", sources: [] } };
const options = { generation: 1, configuredCommand: "npm test" };
const check = (command = "node --test test/edge.test.js", generation = 1, executionChanges = {}) => {
  const execution = { command, executedCommand: command, exitCode: 0, stdout: "", stderr: "", ...executionChanges };
  return { verificationEvidence: verificationReceipt(verificationEvidence({ execution, generation, configuredCommand: "npm test" })),
    shellExecution: shellExecutionReceipt(execution, { generation }) };
};
const project = () => check("npm test");

function orderedCheck(row, turn) {
  row = JSON.parse(JSON.stringify(row));
  return { ...row, verificationReceipts: { schema: VERIFICATION_RECEIPTS_SCHEMA,
    authority: "controller-execution-order", turn,
    entries: [{ sequence: 0, verificationEvidence: row.verificationEvidence ?? null,
      shellExecution: row.shellExecution ?? null }] } };
}

test("outer shell whitespace preserves direct assertion recognition and actual ordered execution credit", () => {
  const direct = `node --input-type=module -e "\nimport assert from 'node:assert/strict';\nimport {spawnSync} from 'node:child_process';\nconst child=spawnSync(process.execPath,['-e','process.exit(0)']);\nassert.equal(child.status,0);\n"`;
  for (const whitespace of ["\n", " \t\n\n"]) {
    const command = whitespace + direct + whitespace;
    assert.equal(isFocusedAuditCommand(command), true);
    const row = orderedCheck(check(command), 1);
    assert.equal(row.verificationEvidence, null, "an inline assertion retains shell-only execution authority");
    assert.equal(row.shellExecution.executedCommand, command, "the execution is not rewritten");
    const pending = pendingContractAudit([audit, row], options);
    assert.equal(pending.needsFocused, false);
    assert.equal(pending.needsProject, true);
    assert.equal(pendingContractAudit([audit, row, orderedCheck(project(), 2)], options), null);
    assert.ok(pendingContractAudit([audit, orderedCheck(check(command, 1, { exitCode: 1 }), 1), project()], options));
    assert.ok(pendingContractAudit([audit, orderedCheck(check(command, 0), 1), project()], options));
  }
});

test("recorder-request trimming accepts outer whitespace only, never different command or executed-status identity", () => {
  const workspace = "/tmp/contract-whitespace-ws";
  for (const prefix of ["", `cd '${workspace}' && `]) {
    const command = ` \n${prefix}node --test test/edge.test.js\n\t`;
    const row = orderedCheck(check(command, 1, { cwd: workspace, stdout: "# tests 1\n# pass 1\n# fail 0\n" }), 1);
    assert.notEqual(row.verificationEvidence.command, row.shellExecution.command);
    const opts = { ...options, workspace };
    assert.equal(pendingContractAudit([audit, row], opts).needsFocused, false);
    for (const alter of [
      r => { r.verificationEvidence.command = r.verificationEvidence.command.replace("edge.test.js", "other.test.js"); },
      r => { r.verificationEvidence.executedCommand = r.verificationEvidence.executedCommand.trim(); },
      r => { r.verificationEvidence.statusCommand = r.verificationEvidence.statusCommand.trim(); },
      r => { r.shellExecution.cwd = "/tmp/foreign"; },
    ]) {
      const broken = structuredClone(row); alter(broken);
      // Keep aliases internally serialized; the pair, not an alias mismatch,
      // must reject the contradiction.
      broken.verificationReceipts.entries[0] = { sequence: 0,
        verificationEvidence: broken.verificationEvidence, shellExecution: broken.shellExecution };
      assert.equal(pendingContractAudit([audit, broken], opts).needsFocused, true);
    }
  }
});

test("outer whitespace normalization does not hide extra commands, open quotes or escaped terminal arguments", () => {
  for (const command of [
    "node check-api.mjs\nfalse\n", "node check-api.mjs; echo PASS\n",
    "node check-api.mjs | tail\n", "node check-api.mjs && npm test\n",
    "node 'check-api.mjs\n", 'node "check-api.mjs\n',
    "node check-api.mjs\\\n", "node check-api.mjs\\ \n",
  ]) {
    assert.equal(isFocusedAuditCommand(command), false, JSON.stringify(command));
    assert.equal(pendingContractAudit([audit, orderedCheck(check(command), 1)], options).needsFocused, true);
  }
  const quoted = orderedCheck(check("node 'check-api.mjs '\n"), 1);
  quoted.verificationEvidence = { ...check("node check-api.mjs").verificationEvidence,
    executedCommand: quoted.shellExecution.executedCommand, statusCommand: quoted.shellExecution.executedCommand };
  quoted.verificationReceipts.entries[0].verificationEvidence = quoted.verificationEvidence;
  assert.equal(pendingContractAudit([audit, quoted], options).needsFocused, true, "quoted argv whitespace is not recorder trimming");
});

test("two actual current-generation inconclusive Node checks suggest a standalone file without credit", () => {
  const unknown = suffix => check(`node check-api.mjs; node -e 'console.log("${suffix}")'`);
  const first = orderedCheck(unknown("FIRST"), 1), second = orderedCheck(unknown("SECOND"), 2);
  assert.equal(first.verificationEvidence.status, "unverified");
  const turns = [audit, first, second];
  const before = JSON.stringify(turns);
  const pending = pendingContractAudit(turns, options);
  assert.equal(pending.focusedCheckRecovery, "standalone-node-file");
  assert.equal(pending.needsFocused, true);
  assert.equal(pending.needsProject, true);
  assert.equal(JSON.stringify(turns), before, "advisory projection does not alter receipts");
  assert.equal(pendingContractAudit([audit, first], options).focusedCheckRecovery, null);
  const focused = orderedCheck(check("node check-api.mjs"), 3);
  assert.equal(pendingContractAudit([...turns, focused], options).focusedCheckRecovery, null);
  assert.equal(pendingContractAudit([...turns, focused, orderedCheck(project(), 4)], options), null);
  const failed = i => orderedCheck(check(`node --input-type=module -e 'import assert from "node:assert/strict"; assert.ok(false)'`, 1, { exitCode: 1 }), i);
  assert.equal(pendingContractAudit([audit, failed(1), failed(2)], options).focusedCheckRecovery, "standalone-node-file");
});

test("standalone-file advice ignores prose, old generations, pre-audit checks, blocked and conflicting receipts", () => {
  const command = "node check-api.mjs; echo PASS";
  const second = orderedCheck(check(command), 2);
  for (const row of [
    { parsedAction: { a: "shell", c: command }, observation: "passed twice" },
    orderedCheck(check(command, 0), 1),
    orderedCheck(check(command, 1, { blocked: true }), 1),
    orderedCheck(check(command, 1, { timedOut: true }), 1),
    orderedCheck(check("python check_api.py; echo PASS"), 1),
  ]) assert.equal(pendingContractAudit([audit, row, second], options).focusedCheckRecovery, null);
  const foreign = orderedCheck(check(command), 1);
  const unrecognized = orderedCheck(check("node -e 'console.log(1)'"), 1);
  const pending = pendingContractAudit([audit, unrecognized, second], options);
  assert.equal(pending.focusedCheckRecovery, 'standalone-node-file', 'successful but unrecognized checks now count as admission attempts, never proof');
  assert.equal(pending.needsFocused, true);
  foreign.verificationEvidence.command = "node check-foreign.mjs; echo PASS";
  assert.equal(pendingContractAudit([audit, foreign, second], options).focusedCheckRecovery, null);
  assert.equal(pendingContractAudit([check(command), { ...audit, ...check(command) }, check(command)], options).focusedCheckRecovery, null);
});

test("stale focus context names observed cleanup without granting stale execution credit", () => {
  const removed = { sourceEditedByShell: true, shellChangedPaths: ["check-api.mjs"],
    workspaceCoherence: { fingerprints: { "check-api.mjs": "missing" } } };
  const turns = [audit, check("node check-api.mjs"), project(), removed];
  const before = JSON.stringify(turns);
  const pending = pendingContractAudit(turns, { ...options, generation: 2 });
  assert.deepEqual(pending.missing, ["focused-execution", "project-verification"]);
  assert.deepEqual(pending.staleFocus, { command: "node check-api.mjs", generation: 1, turn: 1,
    changedPaths: ["check-api.mjs"], removedPaths: ["check-api.mjs"] });
  const note = clipKeepingControllerAnnotation("[repetition] Repeated DONE is blocked.\n" + contractAuditRecoveryNote(pending) + "\nworking note ".repeat(1000));
  for (const phrase of [/generation 1 -> 2/, /check-api.mjs \(removed\)/, /not current proof/, /cleanup BEFORE/]) assert.match(note, phrase);
  assert.equal(JSON.stringify(turns), before, "context projection cannot mutate evidence");
  assert.equal(pendingContractAudit([...turns, check("node check-api.mjs", 2), check("npm test", 2)], { ...options, generation: 2 }), null);
  assert.equal(pendingContractAudit([audit, check("node check-api.mjs"), project(), { parsedAction: { a: "read_file", p: "check-api.mjs" } }], options), null);
});

test("stale focus advice rejects failed, forged and mismatched receipt aliases and bounds paths", () => {
  const clean = check("node check-api.mjs");
  for (const row of [check("node check-api.mjs", 1, { exitCode: 1 }),
    { ...clean, verificationEvidence: { ...clean.verificationEvidence, source: "model" } },
    { ...clean, shellExecution: { ...clean.shellExecution, command: "node check-other.mjs" } },
    { ...clean, verificationReceipts: { schema: "forged" } },
    { ...clean, controllerStop: { kind: "stop" } }]) {
    assert.equal(pendingContractAudit([audit, row], { ...options, generation: 2 }).staleFocus, null);
  }
  const paths = ["../escape", "/absolute", "newline\nfile", ...Array.from({length: 20}, (_, i) => `file${i}.js`)];
  const pending = pendingContractAudit([audit, clean, { sourceEditedByShell: true, shellChangedPaths: paths }], { ...options, generation: 2 });
  assert.deepEqual(pending.staleFocus.changedPaths, paths.slice(3, 9));
  assert.deepEqual(pending.staleFocus.removedPaths, [], "changed is not evidence of removal");
});

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
  for (const phrase of [/actual public API/, /zero-work/, /before scaling a fuzz run/, /Repair only a demonstrated defect/, /No extra work turns/, /DONE-only/, /focused-execution/, /project-verification/, /node --test test\/edge.test.js/, /python check_api.py/, /not oracle correctness/]) assert.match(note, phrase);
  assert.equal(contractAuditRecoveryNote(null), "");
});

test("recovery prioritizes the current valid-path executable diagnostic before bounded, falsifiable audit prose", () => {
  const pending = pendingContractAudit([audit], options);
  pending.report = "AUDIT_PREDICTION_SENTINEL " + "unverified prediction ".repeat(300);
  const note = contractAuditRecoveryNote(pending);
  assert.match(note, /^\[contract-audit-recovery\] Next: assert the current diagnostic/);
  assert.match(note, /For a Node CLI/);
  assert.match(note, /Other CLIs require their actual runtime/);
  const reportAt = note.indexOf("AUDIT_PREDICTION_SENTINEL");
  for (const phrase of ["console.log(condition)", "node:assert/strict", "one valid-path case first",
    "spawnSync(process.execPath, [entry, ...args]", "assert.equal(child.status, expectedStatus, child.stderr)",
    "Do not simulate the CLI", "After the focused assertion", "falsifiable model hypothesis",
    "NOT an established defect", "do not change correct behavior"]) {
    assert.ok(note.indexOf(phrase) >= 0 && note.indexOf(phrase) < reportAt, phrase);
  }
  assert.match(note, /Review excerpt truncated; the full audit remains recorded/);
  assert.ok(note.length < 3500, "bounded review must not crowd out executable guidance or enlarge the previous budget");
});

test("the complete recovery instruction survives a repetition block's real 700-character clip", () => {
  const note = contractAuditRecoveryNote(pendingContractAudit([audit], options));
  const executive = note.split("\n")[0];
  assert.ok(executive.length <= 550);
  const observation = "[repetition] Repeated DONE is blocked.\n" + note
    + "\n[working-checkpoint; model hypothesis]\n" + "stale reasoning ".repeat(1100);
  assert.ok(observation.length > 16000);
  const delivered = clipKeepingControllerAnnotation(observation);
  assert.ok(delivered.includes(executive), "test complete rendered advice, not merely its marker");
  for (const phrase of ["observed task-valid failure outranks the unverified audit hypothesis",
    "spawnSync(process.execPath,[entry,...args])", "assert child.status and output",
    "focused-execution + project-verification", "then exactly: npm test", "No echoes or filters"]) {
    assert.ok(delivered.includes(phrase), phrase);
  }
});

test("the displayed inline assertion shape qualifies only as a direct check; log-only and echoed variants still do not", () => {
  const note = contractAuditRecoveryNote(pendingContractAudit([audit], options));
  const command = note.match(/`(node -e '[^']+')`/)[1];
  assert.equal(isFocusedAuditCommand(command), true, "shape recognition, not execution of unbound example variables");
  assert.match(note, /supply actual\/expected from the public call first/);
  assert.equal(pendingContractAudit([audit, check(command), project()], options), null);
  for (const invalid of [command.replace("assert.deepEqual(actual, expected)", "console.log(actual === expected)"),
    `${command}; echo "EXIT=$?"`, `node -e 'console.log(true)'`]) {
    assert.equal(isFocusedAuditCommand(invalid), false, invalid);
    assert.ok(pendingContractAudit([audit, check(invalid), project()], options), invalid);
  }
  const cli = `node -e 'const assert=require("node:assert/strict"); const {spawnSync}=require("node:child_process"); const child=spawnSync(process.execPath,[entry,...args],{encoding:"utf8"}); assert.equal(child.status,expectedStatus,child.stderr);'`;
  assert.equal(isFocusedAuditCommand(cli), true);
  assert.ok(pendingContractAudit([audit, check(cli, 1, { exitCode: 1 }), project()], options), "a failed actual assertion never receives credit");
});

test("pending audit preserves current generation and exact configured project identity for phase guidance", () => {
  const pending = pendingContractAudit([audit], { generation: 7, configuredCommand: "  python3 -m pytest tests/unit  " });
  assert.equal(pending.generation, 7);
  assert.equal(pending.configuredCommand, "python3 -m pytest tests/unit");
  assert.equal(pending.needsFocused, true);
  assert.match(contractAuditRecoveryNote(pending), /After the focused assertion, execute exactly this configured project command:\npython3 -m pytest tests\/unit\n/);
  const unspecified = pendingContractAudit([audit]);
  assert.equal(unspecified.generation, null);
  assert.equal(unspecified.configuredCommand, null);
});

test("an accepted focused assertion receives only the remaining exact configured project instruction", () => {
  for (const configuredCommand of ["npm test", "node --test test/project.test.js", "python3 -m pytest tests/unit"]) {
    const pending = pendingContractAudit([audit, check()], { generation: 1, configuredCommand });
    assert.equal(pending.needsFocused, false);
    assert.equal(pending.needsProject, true);
    assert.equal(pending.configuredCommand, configuredCommand);
    assert.equal(pending.generation, 1);
    const note = contractAuditRecoveryNote(pending);
    assert.match(note, /Focused assertion accepted at turn 2 for generation 1\. Only project-verification remains\./);
    assert.ok(note.includes(`Next action: execute exactly this configured project command:\n${configuredCommand}\n`));
    assert.match(note, /Do not repeat the focused check or emit DONE yet/);
    assert.match(note, /not interchangeable with this configured command/);
    assert.doesNotMatch(note, /An unconditional precondition|Proposed fixture|Accepted launch shapes|focused-execution \+/);
    assert.ok(note.length < 600, "completed focus must not replay the broad review and stale instructions");
  }
  const rejected = pendingContractAudit([audit, check(), check(undefined, 1, { exitCode: 1 })], options);
  assert.equal(rejected.needsFocused, true);
  assert.doesNotMatch(contractAuditRecoveryNote(rejected), /Focused assertion accepted/);
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

const orderedOptions = { ...workspaceOptions, verificationWorkspaceReadOnly: true };
function measuredCheck(command = "node --test test/edge.test.js", source = "shell", changes = {}) {
  const execution = { command, executedCommand: command, exitCode: 0,
    stdout: "# tests 3\n# pass 3\n# fail 0\n", stderr: "", cwd: auditWorkspace,
    workspaceReadOnly: source !== "shell", sandbox: "docker:test", pipefail: true, ...changes };
  return {
    verificationEvidence: verificationReceipt(verificationEvidence({ execution, generation: 1,
      configuredCommand: "npm test", source })),
    shellExecution: source === "shell" ? shellExecutionReceipt(execution, { generation: 1 }) : null,
  };
}
function orderedTurn(rows, turn = 1) {
  // Exercise serialized values, not object identity or unrecorded in-memory data.
  const entries = JSON.parse(JSON.stringify(rows.map((row, sequence) => ({ sequence, ...row }))));
  return {
    verificationReceipts: { schema: VERIFICATION_RECEIPTS_SCHEMA,
      authority: "controller-execution-order", turn, entries },
    verificationEvidence: entries.findLast(entry => entry.verificationEvidence)?.verificationEvidence ?? null,
    shellExecution: entries.find(entry => entry.shellExecution)?.shellExecution ?? null,
  };
}
const measuredProject = (changes = {}) => measuredCheck("npm test", "landing", changes);

test("extra passing checks retain a complete pair on the unchanged tree, including serialized resume", () => {
  for (const ordered of [true, false]) {
    const rows = [audit, measuredCheck('node test/smoke.js'), measuredProject(),
      measuredCheck('node test/perf.js'), measuredCheck('node test/shots.js')];
    const turns = rows.map((row, i) => ordered && i ? orderedTurn([row], i) : row);
    const before = JSON.stringify(turns);
    assert.equal(pendingContractAudit(turns, orderedOptions), null);
    assert.deepEqual(currentFocusedAuditWitness(turns, orderedOptions), {
      command: 'node test/smoke.js', turn: 1, generation: 1,
    }, 'protect the focused check that actually preceded the accepted project execution');
    assert.equal(pendingContractAudit(JSON.parse(before), orderedOptions), null);
    assert.equal(JSON.stringify(turns), before, 'evaluation does not rewrite receipts');
    assert.ok(pendingContractAudit(turns, {...orderedOptions, generation: 2}));
    assert.ok(pendingContractAudit([...turns, audit], orderedOptions));
  }
  const together = orderedTurn([measuredCheck(), measuredProject(), measuredCheck('node test/perf.js')]);
  assert.equal(pendingContractAudit([audit, together], orderedOptions), null);
});

test("a later failed, opaque, interrupted or stale check still invalidates the completed pair", () => {
  const prefix = [audit, orderedTurn([measuredCheck(), measuredProject()])];
  for (const changes of [
    {exitCode: 1}, {timedOut: true}, {aborted: true}, {stdout: '# tests 0\n# pass 0\n# fail 0\n'},
  ]) {
    const bad = orderedTurn([measuredCheck(undefined, 'shell', changes)], 2);
    assert.ok(pendingContractAudit([...prefix, bad], orderedOptions), JSON.stringify(changes));
  }
  const opaque = orderedTurn([measuredCheck('node test/perf.js | tail -5')], 2);
  assert.ok(pendingContractAudit([...prefix, opaque], orderedOptions));
  const failed = orderedTurn([measuredCheck(undefined, 'shell', {exitCode: 1})], 2);
  const recoveredFocus = orderedTurn([measuredCheck()], 3);
  assert.equal(pendingContractAudit([...prefix, failed, recoveredFocus], orderedOptions).needsProject, true);
  assert.equal(pendingContractAudit([...prefix, failed, recoveredFocus, orderedTurn([measuredProject()], 4)], orderedOptions), null);
});

test("ordered actual focused and landing executions on one turn discharge without losing the shell proof", () => {
  const row = orderedTurn([measuredCheck(), measuredProject()]);
  assert.equal(row.verificationEvidence.source, "landing");
  assert.equal(row.shellExecution.command, "node --test test/edge.test.js");
  assert.equal(pendingContractAudit([audit, row], orderedOptions), null);
  assert.equal(pendingContractAudit(JSON.parse(JSON.stringify([audit, row])), orderedOptions), null);
  assert.ok(pendingContractAudit([audit, { verificationEvidence: row.verificationEvidence,
    shellExecution: row.shellExecution }], orderedOptions), "legacy aliases cannot establish two executions or their order");
});

test("reversed receipt order and a pre-audit same-turn envelope cannot discharge a new review", () => {
  const reversed = orderedTurn([measuredProject(), measuredCheck()]);
  const pending = pendingContractAudit([audit, reversed], orderedOptions);
  assert.equal(pending.needsFocused, false);
  assert.equal(pending.needsProject, true);
  assert.equal(pendingContractAudit([audit, reversed, orderedTurn([measuredProject()], 2)], orderedOptions), null);
  assert.ok(pendingContractAudit([{ ...audit, ...orderedTurn([measuredCheck(), measuredProject()], 0) }], orderedOptions));
  assert.ok(pendingContractAudit([orderedTurn([measuredCheck(), measuredProject()], 0), audit], orderedOptions));
});

test("bare arrays, missing authority, forged sequence or turn, and malformed envelopes fail closed", () => {
  const mutations = [
    row => { row.verificationReceipts = row.verificationReceipts.entries; },
    row => { delete row.verificationReceipts.authority; },
    row => { row.verificationReceipts.authority = "model"; },
    row => { row.verificationReceipts.schema = 1; },
    row => { row.verificationReceipts.turn = 0; },
    row => { row.verificationReceipts.entries[1].sequence = 0; },
    row => { row.verificationReceipts.entries.reverse(); },
    row => { delete row.verificationReceipts.entries[0].shellExecution; },
    row => { row.verificationReceipts.entries = []; },
    row => { row.verificationReceipts.entries[0].verificationEvidence = "passed"; },
    row => { row.verificationReceipts = null; },
    row => { row.verificationReceipts.entries = Array.from({ length: 17 }, (_, sequence) => ({ sequence, ...measuredProject() })); },
  ];
  for (const mutate of mutations) {
    const row = orderedTurn([measuredCheck(), measuredProject()]); mutate(row);
    assert.ok(pendingContractAudit([audit, row], orderedOptions), mutate.toString());
  }
});

test("contradictory legacy aliases cannot hide failure, stale generation, or invalidation behind an ordered envelope", () => {
  for (const field of ["verificationEvidence", "shellExecution"]) {
    for (const patch of [{ generation: 0 }, { invalidated: true }, { exitCode: 1 }, { outputSha256: "foreign" }]) {
      const row = orderedTurn([measuredCheck(), measuredProject()]);
      row[field] = { ...row[field], ...patch };
      assert.ok(pendingContractAudit([audit, row], orderedOptions), `${field} ${JSON.stringify(patch)}`);
    }
  }
  const row = orderedTurn([measuredCheck(), measuredProject()]);
  row.verificationEvidence = { status: "pass", observation: "all checks passed" };
  assert.ok(pendingContractAudit([audit, row], orderedOptions));
});

test("ordered shell proof must match its actual command, cwd, generation and process metadata even without cd", () => {
  for (const patch of [
    { command: "node --test test/other.test.js" }, { executedCommand: "node --test test/other.test.js" },
    { cwd: "/tmp/elsewhere" }, { cwd: null }, { generation: 0 }, { workspaceReadOnly: true },
    { sandbox: "host" }, { exitCode: 1 }, { invalidated: true }, { timedOut: true },
  ]) {
    const focused = measuredCheck(); Object.assign(focused.shellExecution, patch);
    assert.ok(pendingContractAudit([audit, orderedTurn([focused, measuredProject()])], orderedOptions), JSON.stringify(patch));
  }
  const focused = measuredCheck(); focused.shellExecution = null;
  assert.ok(pendingContractAudit([audit, orderedTurn([focused, measuredProject()])], orderedOptions), "shell proof alone has no execution partner");
});

test("ordered failure, unknown status, zero counts and invalidated executions clear credit instead of borrowing a parallel success", () => {
  for (const patch of [
    { status: "fail" }, { status: "unverified" }, { schema: 2 }, { source: "model" },
    { generation: 0 }, { exitCode: 1 }, { invalidated: true }, { blocked: true },
    { statusScope: "final-configured-command" }, { statusCommand: "node check-other.mjs" },
    { counts: null }, { counts: { passed: 0, failed: 0, total: 0 } },
    { counts: { passed: 0, failed: 0, total: 3 } }, { counts: { passed: 2, failed: 1, total: 3 } },
    { counts: { passed: 4, failed: 0, total: 3 } }, { counts: { passed: 1.5, failed: 0, total: 3 } },
    { countsScope: "multiple-summaries" },
  ]) {
    const focused = measuredCheck(); Object.assign(focused.verificationEvidence, patch);
    assert.ok(pendingContractAudit([audit, orderedTurn([focused, measuredProject()])], orderedOptions), JSON.stringify(patch));
  }
  const failed = measuredCheck(undefined, "shell", { exitCode: 1 });
  assert.ok(pendingContractAudit([audit, orderedTurn([measuredCheck(), measuredProject(), failed])], orderedOptions));
  assert.equal(pendingContractAudit([audit, orderedTurn([failed, measuredCheck(), measuredProject()])], orderedOptions), null,
    "only a later complete focused/project pair can recover after an observed failure");
  const unknown = measuredCheck("MODE=test node --test test/edge.test.js", "shell", { stdout: "" });
  assert.ok(pendingContractAudit([audit, orderedTurn([unknown, measuredProject()])], orderedOptions),
    "an environment prefix cannot bypass measured Node test counts");
});

test("ordered controller project evidence binds the exact configured command, workspace and readonly profile", () => {
  for (const patch of [
    { command: "npm run other" }, { executedCommand: "npm test; echo done" },
    { configuredCommand: null }, { configuredCommand: "npm run other" }, { statusCommand: "npm run other" },
    { cwd: "/tmp/elsewhere" }, { cwd: null }, { workspaceReadOnly: false }, { workspaceReadOnly: null },
    { generation: 0 }, { counts: { passed: 0, failed: 0, total: 0 } },
  ]) {
    const broad = measuredProject(); Object.assign(broad.verificationEvidence, patch);
    assert.ok(pendingContractAudit([audit, orderedTurn([measuredCheck(), broad])], orderedOptions), JSON.stringify(patch));
  }
  assert.equal(pendingContractAudit([audit, orderedTurn([measuredCheck(), measuredCheck("npm test")])], orderedOptions), null,
    "actual writable worker-shell project checks preserve established compatibility");
});

test("ordered bound cd checks and direct inline assertions qualify, but Planner's echoed compound remains unverified", () => {
  const focused = measuredCheck(`cd ${auditWorkspace} && node --test test/edge.test.js`, "shell", {
    executedCommand: `cd ${auditWorkspace} && node --test --test-timeout=30000 test/edge.test.js`,
  });
  assert.equal(pendingContractAudit([audit, orderedTurn([focused, measuredProject()])], orderedOptions), null);
  const inline = `node -e 'const a=require("node:assert/strict");a.deepEqual([],[]);'`;
  const direct = measuredCheck(inline);
  assert.equal(direct.verificationEvidence, null);
  assert.equal(pendingContractAudit([audit, orderedTurn([direct, measuredProject()])], orderedOptions), null);
  const masked = measuredCheck(`cd ${auditWorkspace} && ${inline}; echo "exit=$?"; npm test 2>&1; echo "exit=$?"`);
  assert.equal(masked.verificationEvidence.status, "unverified");
  assert.ok(pendingContractAudit([audit, orderedTurn([masked, measuredProject()])], orderedOptions));
});

test("controller stop, rollback or failed station cannot borrow unrelated ordinary same-turn ordered proof", () => {
  for (const patch of [{ controllerStop: { kind: "progress-gate" } }, { shellScopeRollback: { violations: ["protected"] } }]) {
    assert.ok(pendingContractAudit([audit, { ...orderedTurn([measuredCheck(), measuredProject()]), ...patch }], orderedOptions));
  }
  const { review, station } = stationCase(); station.status = "assertion_failed";
  assert.ok(pendingContractAudit([{ ...review, contractAssertion: station,
    ...orderedTurn([measuredCheck(), measuredProject()], 0) }], orderedOptions));
});

test("configured Node suite retains its identity with only the executor's bounded injected timeout", () => {
  const configured = "node --test test/project.test.js";
  const makeProject = executedCommand => {
    const execution = { command: configured, executedCommand, exitCode: 0,
      stdout: "# tests 3\n# pass 3\n# fail 0\n", stderr: "", cwd: auditWorkspace,
      workspaceReadOnly: true, sandbox: "docker:test", pipefail: true };
    return { verificationEvidence: verificationReceipt(verificationEvidence({ execution, command: configured,
      configuredCommand: configured, generation: 1, source: "landing" })), shellExecution: null };
  };
  const settings = { ...orderedOptions, configuredCommand: configured };
  for (const timeout of [5000, 30000, 60000]) {
    const actual = `node --test --test-timeout=${timeout} test/project.test.js`;
    assert.equal(isFocusedAuditCommand(actual, configured), false, "the configured suite is not its own focused witness");
    assert.equal(pendingContractAudit([audit, orderedTurn([measuredCheck(), makeProject(actual)])], settings), null);
    const { review, station } = stationCase(); station.projectVerification = makeProject(actual).verificationEvidence;
    assert.equal(pendingContractAudit([{ ...review, contractAssertion: station }], settings), null,
      "station nested execution keeps its existing strong order/binding with injected timeout");
  }
  for (const actual of [
    "node --test --test-timeout=4999 test/project.test.js",
    "node --test --test-timeout=60001 test/project.test.js",
    "node --test --test-timeout=30000 test/other.test.js",
    "node --test --test-timeout=30000 --test-name-pattern=edge test/project.test.js",
    "node --test --test-timeout=30000 --test-timeout=30000 test/project.test.js",
    "node --test test/project.test.js --test-timeout=30000",
    "node --test --test-timeout=30000 test/project.test.js; echo done",
  ]) {
    assert.ok(pendingContractAudit([audit, orderedTurn([measuredCheck(), makeProject(actual)])], settings), actual);
  }
  const explicit = "node --test --test-timeout=15000 test/project.test.js";
  const changed = makeProject("node --test --test-timeout=30000 test/project.test.js");
  changed.verificationEvidence.command = changed.verificationEvidence.configuredCommand = explicit;
  assert.ok(pendingContractAudit([audit, orderedTurn([measuredCheck(), changed])], { ...settings, configuredCommand: explicit }),
    "never replace a configured explicit timeout");
});
