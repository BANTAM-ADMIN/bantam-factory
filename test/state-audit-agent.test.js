import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runAgent } from "../src/agent.js";
import {
  STATE_AUDIT_DEFERRAL,
  STATE_AUDIT_MARKER,
} from "../src/completion-audit.js";

const CONFIGURED_VERIFIER = "node --test test/*.test.js";
const INLINE_PROBE = [
  "node --input-type=module -e",
  "'import assert from \"node:assert/strict\"; await Promise.resolve(); assert.equal(1, 1); process.stdout.write(\"state-audit-probe\")'",
].join(" ");
const INVALID_TDZ_PROBE = [
  "node --input-type=module -e",
  "'const first = pool.run(\"k\", () => assert.strictEqual(nested, first)); // tdz-probe'",
].join(" ");

const KEYED_PROMISE_TASK = [
  "Implement a dependency-free keyed asynchronous work pool in Node.js.",
  "Complete src/keyed-task-pool.js and do not modify the tests or package.json.",
  "Coalesce a key already queued or running: return the exact same Promise object",
  "and never invoke the later task.",
  "Keep a key coalesced until its task settles.",
  "Allow that key to be submitted again after settlement.",
  "Catch synchronous throws, free the slot, and continue queued work.",
].join(" ");

describe("state-audit agent lifecycle", () => {
  it("keeps the default keyed-Promise audit pending until focused probe evidence", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-state-audit-agent-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "state-audit-agent-fixture",
        private: true,
        type: "module",
        scripts: { test: CONFIGURED_VERIFIER },
      }),
    );
    fs.writeFileSync(
      path.join(workspace, "src", "keyed-task-pool.js"),
      [
        "export class KeyedTaskPool {",
        "  run() {",
        '    throw new Error("TODO");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, "test", "public.test.js"),
      [
        'import test from "node:test";',
        'test("fixture", () => {});',
        "",
      ].join("\n"),
    );

    // Exercise the production default, independent of the invoking process.
    const priorStateAudit = process.env.BANTAM_STATE_AUDIT;
    delete process.env.BANTAM_STATE_AUDIT;
    t.after(() => {
      if (priorStateAudit === undefined) delete process.env.BANTAM_STATE_AUDIT;
      else process.env.BANTAM_STATE_AUDIT = priorStateAudit;
    });

    const model = scriptedModel([
      {
        a: "replace",
        p: "src/keyed-task-pool.js",
        old: 'throw new Error("TODO");',
        new: 'return Promise.resolve("ready");',
      },
      { a: "shell", c: CONFIGURED_VERIFIER },
      { a: "shell", c: CONFIGURED_VERIFIER },
      { a: "done", summary: "first completion attempt" },
      { a: "shell", c: INVALID_TDZ_PROBE },
      { a: "done", summary: "second completion attempt" },
      { a: "shell", c: INLINE_PROBE },
      { a: "done", summary: "completed after focused state probe" },
    ]);
    const shell = fakeShellRunner();

    const result = await runAgent({
      task: KEYED_PROMISE_TASK,
      workspace,
      model,
      maxTurns: 8,
      verificationScript: CONFIGURED_VERIFIER,
      completionAudit: true,
      planAudit: "off",
      interactive: false,
      useGrammar: false,
      grounding: null,
      preGate: false,
      dedupeActions: false,
      progressAwareness: false,
      autoVerifyBlindEdits: 0,
      autoVerifyProbes: 0,
      autoVerifyStaleTurns: 0,
      testFocus: false,
      regressionGuard: false,
      diagnoseStuckTests: false,
      shellSandbox: "host",
      shellProcessRunner: shell.run,
    });

    assert.equal(result.metrics.stateAuditPolicy.mode, "auto");
    assert.equal(result.metrics.stateAuditPolicy.enabled, true);
    assert.equal(
      result.metrics.stateAuditPolicy.reason,
      "auto-keyed-promise-lifecycle",
    );
    assert.equal(result.metrics.stateAuditHints, 1);
    assert.equal(result.metrics.stateAuditEngagements, 2);
    assert.equal(result.metrics.stateAuditDoneDeferrals, 2);
    assert.equal(model.completeOptions[0].codexAdaptiveRebase, true);
    const firstSuppressedRebase = model.completeOptions.findIndex(
      (options) => options.codexAdaptiveRebase === false,
    );
    assert.ok(firstSuppressedRebase > 0, "the audit begins after ordinary implementation turns");
    assert.ok(
      model.completeOptions
        .slice(firstSuppressedRebase)
        .every((options) => options.codexAdaptiveRebase === false),
      "the complete post-green audit phase suppresses optional adaptive Codex rebasing",
    );
    assert.equal(result.metrics.stateAuditProbeDiagnostics, 1);

    assert.equal(result.turns.length, 8);
    assert.ok(result.turns[1].observation.includes(STATE_AUDIT_MARKER));
    assert.match(result.turns[1].observation, /capture a synchronously thrown task's returned Promise/i);
    assert.match(result.turns[1].observation, /independent result record for each input/i);
    assert.match(model.prompts[2], /STATE AUDIT BLOCKER/);
    assert.match(model.prompts[2], /capture the returned Promise.*only then await/s);
    assert.equal(result.turns[2].action.c, CONFIGURED_VERIFIER);
    assert.ok(result.turns[3].observation.startsWith(STATE_AUDIT_DEFERRAL));
    assert.equal(result.turns[4].action.c, INVALID_TDZ_PROBE);
    assert.match(result.turns[4].observation, /\[state-audit probe-invalid\]/);
    assert.ok(result.turns[5].observation.startsWith(STATE_AUDIT_DEFERRAL));
    assert.equal(result.turns[6].action.c, INLINE_PROBE);
    assert.match(result.turns[6].observation, /state-audit-probe/);
    assert.equal(result.turns[7].action.a, "done");

    assert.equal(result.reachedDone, true);
    assert.equal(result.summary, "completed after focused state probe");
    assert.equal(result.verification.status, "pass");
    assert.ok(
      shell.commands.filter((command) => command.includes("node --test")).length >= 3,
      "the two model verifiers and terminal verifier should use the fake runner",
    );

    for (const index of [1, 2, 3, 4, 5]) {
      assert.equal(
        result.turns[index].stateAudit.pending,
        true,
        `turn ${index + 1} should retain the pending state audit`,
      );
    }
    for (const index of [6, 7]) {
      assert.equal(
        result.turns[index].stateAudit.pending,
        false,
        `turn ${index + 1} should retain the resolved state audit`,
      );
    }
    assert.equal(result.turns[7].stateAudit.deferralsUsed, 2);
  });

  it("restores a pending audit across resume until focused probe evidence", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-state-audit-resume-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "state-audit-resume-fixture",
        private: true,
        type: "module",
        scripts: { test: CONFIGURED_VERIFIER },
      }),
    );
    fs.writeFileSync(
      path.join(workspace, "src", "keyed-task-pool.js"),
      [
        "export class KeyedTaskPool {",
        "  run() {",
        '    throw new Error("TODO");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspace, "test", "public.test.js"),
      [
        'import test from "node:test";',
        'test("fixture", () => {});',
        "",
      ].join("\n"),
    );

    const priorStateAudit = process.env.BANTAM_STATE_AUDIT;
    delete process.env.BANTAM_STATE_AUDIT;
    t.after(() => {
      if (priorStateAudit === undefined) delete process.env.BANTAM_STATE_AUDIT;
      else process.env.BANTAM_STATE_AUDIT = priorStateAudit;
    });

    const phaseOneShell = fakeShellRunner();
    const phaseOne = await runAgent({
      task: KEYED_PROMISE_TASK,
      workspace,
      model: scriptedModel([
        {
          a: "replace",
          p: "src/keyed-task-pool.js",
          old: 'throw new Error("TODO");',
          new: 'return Promise.resolve("ready");',
        },
        { a: "shell", c: CONFIGURED_VERIFIER },
        { a: "read_file", p: "src/keyed-task-pool.js" },
      ]),
      maxTurns: 3,
      verificationScript: CONFIGURED_VERIFIER,
      completionAudit: true,
      planAudit: "off",
      interactive: false,
      useGrammar: false,
      grounding: null,
      openFilesView: false,
      preGate: false,
      dedupeActions: false,
      progressAwareness: false,
      autoVerifyBlindEdits: 0,
      autoVerifyProbes: 0,
      autoVerifyStaleTurns: 0,
      testFocus: false,
      regressionGuard: false,
      diagnoseStuckTests: false,
      shellSandbox: "host",
      shellProcessRunner: phaseOneShell.run,
    });

    assert.equal(phaseOne.reachedDone, false);
    assert.equal(phaseOne.turns.length, 3);
    assert.equal(phaseOne.metrics.stateAuditHints, 1);
    assert.equal(phaseOne.metrics.stateAuditEngagements, 1);
    assert.equal(phaseOne.metrics.stateAuditDoneDeferrals, 0);
    assert.ok(phaseOne.turns[1].observation.includes(STATE_AUDIT_MARKER));
    assert.equal(phaseOne.turns[1].stateAudit.pending, true);
    assert.equal(phaseOne.turns[2].action.a, "read_file");
    assert.equal(phaseOne.turns[2].stateAudit.pending, true);
    assert.equal(phaseOne.turns[2].stateAudit.hints, 1);
    assert.equal(phaseOne.turns[2].stateAudit.engagements, 1);
    assert.equal(phaseOne.turns[2].stateAudit.deferralsUsed, 0);

    const phaseTwoShell = fakeShellRunner();
    const phaseTwo = await runAgent({
      task: KEYED_PROMISE_TASK,
      workspace,
      model: scriptedModel([
        { a: "done", summary: "premature resumed completion" },
        { a: "shell", c: INLINE_PROBE },
        { a: "done", summary: "completed after resumed focused probe" },
      ]),
      maxTurns: 6,
      resumeTurns: phaseOne.turns,
      verificationScript: CONFIGURED_VERIFIER,
      completionAudit: true,
      planAudit: "off",
      interactive: false,
      useGrammar: false,
      grounding: null,
      openFilesView: false,
      preGate: false,
      dedupeActions: false,
      progressAwareness: false,
      autoVerifyBlindEdits: 0,
      autoVerifyProbes: 0,
      autoVerifyStaleTurns: 0,
      testFocus: false,
      regressionGuard: false,
      diagnoseStuckTests: false,
      shellSandbox: "host",
      shellProcessRunner: phaseTwoShell.run,
    });

    assert.equal(phaseTwo.turns.length, 6);
    assert.ok(phaseTwo.turns[3].observation.startsWith(STATE_AUDIT_DEFERRAL));
    assert.equal(phaseTwo.turns[3].stateAudit.pending, true);
    assert.equal(phaseTwo.turns[3].stateAudit.deferralsUsed, 1);
    assert.equal(phaseTwo.turns[4].action.c, INLINE_PROBE);
    assert.equal(phaseTwo.turns[4].stateAudit.pending, false);
    assert.equal(phaseTwo.turns[4].stateAudit.evidence, "focused-probe");
    assert.equal(phaseTwo.turns[5].action.a, "done");
    assert.equal(phaseTwo.turns[5].stateAudit.pending, false);
    assert.equal(phaseTwo.turns[5].stateAudit.deferralsUsed, 1);

    assert.equal(phaseTwo.metrics.stateAuditHints, 1);
    assert.equal(phaseTwo.metrics.stateAuditEngagements, 2);
    assert.equal(phaseTwo.metrics.stateAuditDoneDeferrals, 1);
    assert.equal(phaseTwo.reachedDone, true);
    assert.equal(phaseTwo.summary, "completed after resumed focused probe");
    assert.equal(phaseTwo.verification.status, "pass");
  });

  it("keeps a per-input wrapper risk pending after an unrelated lifecycle probe", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-state-audit-wrapper-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "state-audit-wrapper-fixture",
        private: true,
        type: "module",
        scripts: { test: CONFIGURED_VERIFIER },
      }),
    );
    fs.writeFileSync(path.join(workspace, "src", "run-plan.js"), "// TODO\n");
    fs.writeFileSync(
      path.join(workspace, "test", "public.test.js"),
      'import test from "node:test"; test("fixture", () => {});\n',
    );

    const aliased = [
      "export async function runPlan(steps, worker) {",
      "  const results = new Map();",
      '  results.set("shared", { key: "shared", status: "fulfilled", value: 4 });',
      "  for (const step of steps) {",
      '    if (typeof worker !== "function") throw new TypeError("bad worker");',
      "  }",
      "  return steps.map((step) => results.get(step.key));",
      "}",
      "",
    ].join("\n");
    const shell = fakeShellRunner();
    const result = await runAgent({
      task: KEYED_PROMISE_TASK,
      workspace,
      model: scriptedModel([
        { a: "write_file", p: "src/run-plan.js", content: aliased },
        { a: "shell", c: CONFIGURED_VERIFIER },
        { a: "shell", c: INLINE_PROBE },
        { a: "done", summary: "wrapper still aliased" },
        {
          a: "replace",
          p: "src/run-plan.js",
          old: [
            "  for (const step of steps) {",
            '    if (typeof worker !== "function") throw new TypeError("bad worker");',
            "  }",
          ].join("\n"),
          new: [
            '  if (typeof worker !== "function") throw new TypeError("bad worker");',
            "  for (const step of steps) {",
            "    void step;",
            "  }",
          ].join("\n"),
        },
        {
          a: "replace",
          p: "src/run-plan.js",
          old: "  return steps.map((step) => results.get(step.key));",
          new: "  return steps.map((step) => ({ ...results.get(step.key) }));",
        },
        { a: "shell", c: CONFIGURED_VERIFIER },
        { a: "done", summary: "independent result wrappers verified" },
      ]),
      maxTurns: 8,
      verificationScript: CONFIGURED_VERIFIER,
      completionAudit: true,
      planAudit: "off",
      interactive: false,
      useGrammar: false,
      grounding: null,
      openFilesView: false,
      preGate: false,
      dedupeActions: false,
      progressAwareness: false,
      autoVerifyBlindEdits: 0,
      autoVerifyProbes: 0,
      autoVerifyStaleTurns: 0,
      testFocus: false,
      regressionGuard: false,
      diagnoseStuckTests: false,
      shellSandbox: "host",
      shellProcessRunner: shell.run,
    });

    assert.match(result.turns[1].observation, /same stored result record/i);
    assert.match(result.turns[1].observation, /empty collection bypasses the precondition/i);
    assert.equal(result.turns[2].stateAudit.evidence, "focused-probe-partial");
    assert.equal(result.turns[2].stateAudit.pending, true);
    assert.match(result.turns[2].observation, /independent wrapper per input/i);
    assert.ok(result.turns[3].observation.startsWith(STATE_AUDIT_DEFERRAL));
    assert.equal(result.turns[3].stateAudit.pending, true);
    assert.equal(result.turns[7].stateAudit.evidence, "static-remediation");
    assert.equal(result.turns[7].stateAudit.pending, false);
    assert.equal(result.reachedDone, true);
    assert.equal(result.summary, "independent result wrappers verified");
  });
});

function scriptedModel(actions) {
  const remaining = actions.map((action) => JSON.stringify(action));
  const model = {
    assistantPrefill: "",
    actTemperature: null,
    completeOptions: [],
    prompts: [],
    async complete(prompt, options = {}) {
      assert.ok(remaining.length > 0, "scripted model exhausted its actions");
      model.prompts.push(prompt);
      model.completeOptions.push(options);
      return {
        content: remaining.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
  return model;
}

function fakeShellRunner() {
  const commands = [];
  return {
    commands,
    async run(_file, args) {
      const command = String(args.at(-1) ?? "");
      commands.push(command);
      if (command.includes("tdz-probe")) {
        return {
          code: 1,
          signal: null,
          stdout: "",
          stderr: "ReferenceError: Cannot access 'first' before initialization",
          timedOut: false,
          bufferExceeded: false,
          aborted: false,
        };
      }
      const stdout = command.includes("state-audit-probe")
        ? "state-audit-probe"
        : [
            "TAP version 13",
            "1..1",
            "# tests 1",
            "# pass 1",
            "# fail 0",
          ].join("\n");
      return {
        code: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        aborted: false,
      };
    },
  };
}
