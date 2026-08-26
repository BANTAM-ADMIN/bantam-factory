import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  stateAuditProbeDiagnostic,
  stateAuditProbePassed,
} from "../src/completion-audit.js";

function shellObservation(command, exitCode, output = "") {
  return [
    `$ ${command}`,
    "cwd: /workspace",
    `exit ${exitCode}`,
    output,
  ].filter(Boolean).join("\n");
}

describe("state-audit probe evidence", () => {
  it("accepts a successful inline Node probe", () => {
    const command = "node -e 'const assert = require(\"node:assert/strict\"); assert.equal(1, 1)'";

    assert.equal(stateAuditProbePassed(
      { a: "shell", c: command },
      { observation: shellObservation(command, 0) },
    ), true);
  });

  it("rejects an exit-zero inline script that only prints claimed results", () => {
    const command = "node -e 'console.log(\"reason identity:\", true); console.log(\"all probes passed\")'";
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: command },
      { observation: shellObservation(command, 0, "reason identity: true\nall probes passed") },
    ), false);
  });

  it("requires assertion probes to cover task-named lifecycle obligations", () => {
    const task = "get always returns a Promise. invalidate(key) must fence an older in-flight stale completion. TTL zero is immediately stale and size() returns only fresh entries.";
    const incomplete = "node -e 'const assert = require(\"node:assert/strict\"); const c = cache(); assert.equal(c.size(), 0); // ttlMs: 0'";
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: incomplete },
      { task, observation: shellObservation(incomplete, 0) },
    ), false);

    const complete = "node -e 'const assert = require(\"node:assert/strict\"); const c = cache(); c.invalidate(\"k\"); assert.equal(c.size(), 0); // ttlMs: 0'";
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: complete },
      { task, observation: shellObservation(complete, 0) },
    ), true);
  });

  it("accepts a passing plain signal-like abort probe recommended by completion context", () => {
    const command = [
      "node --input-type=module -e",
      `'import assert from "node:assert/strict"; let added, removed; const signal = { aborted: false, reason: "stop", addEventListener(_t, fn) { added = fn; }, removeEventListener(_t, fn) { removed = fn; } }; const pending = Promise.resolve(); signal.aborted = true; added = added || (() => {}); added(); await pending; assert.equal(signal.aborted, true); assert.equal(removed, undefined);'`,
    ].join(" ");
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: command },
      {
        observation: "$ probe\nexit 0\n",
        task: "Stop starting work when the AbortSignal aborts and remove the abort listener before resolving.",
      },
    ), true);

    const getterBacked = command.replace(
      "const signal = { aborted: false,",
      "let aborted = false; const signal = { get aborted() { return aborted; },",
    ).replace("signal.aborted = true", "aborted = true");
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: getterBacked },
      {
        observation: "$ probe\nexit 0\n",
        task: "Stop starting work when the AbortSignal aborts and remove the abort listener before resolving.",
      },
    ), true);
  });

  it("rejects failed, duplicate, blocked, or executor-rejected probes", () => {
    const command = "node -e 'throw new Error(\"stale settlement\")'";

    assert.equal(stateAuditProbePassed(
      { a: "shell", c: command },
      {
        observation: shellObservation(
          command,
          1,
          "Error: stale settlement",
        ),
      },
    ), false);
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: "node -e 'process.exit(0)'" },
      {
        duplicate: true,
        observation: shellObservation("node -e 'process.exit(0)'", 0),
      },
    ), false);
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: "node -e 'process.exit(0)'" },
      {
        blocked: { kind: "sandbox-policy" },
        observation: shellObservation("node -e 'process.exit(0)'", 0),
      },
    ), false);
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: "node -e 'process.exit(0)'" },
      { observation: "ERROR: shell execution was rejected before it started" },
    ), false);
  });

  it("does not mistake ordinary shell commands for focused probes", () => {
    for (const command of ["echo audited", "pwd", "ls"]) {
      assert.equal(stateAuditProbePassed(
        { a: "shell", c: command },
        { observation: shellObservation(command, 0) },
      ), false, command);
    }
  });

  it("rejects the unchanged configured verifier but accepts a narrower passing Node test", () => {
    const configuredVerification = "node --test test/*.test.js";
    const configuredOutput = [
      "TAP version 13",
      "# pass 12",
      "# fail 0",
    ].join("\n");

    assert.equal(stateAuditProbePassed(
      { a: "shell", c: configuredVerification },
      {
        configuredVerification,
        observation: shellObservation(
          configuredVerification,
          0,
          configuredOutput,
        ),
      },
    ), false);

    const focusedCommand = "node --test test/stale-settlement.test.js";
    assert.equal(stateAuditProbePassed(
      { a: "shell", c: focusedCommand },
      {
        configuredVerification,
        observation: shellObservation(
          focusedCommand,
          0,
          [
            "TAP version 13",
            "# pass 1",
            "# fail 0",
          ].join("\n"),
        ),
      },
    ), true);
  });

  it("identifies a temporal-dead-zone failure in a synchronous reentrancy probe", () => {
    const command = [
      "node --input-type=module -e '",
      "let nested;",
      "const first = pool.run(\"k\", () => {",
      "nested = pool.run(\"k\", () => 2);",
      "assert.strictEqual(nested, first);",
      "});'",
    ].join("\n");
    const diagnostic = stateAuditProbeDiagnostic(
      { a: "shell", c: command },
      shellObservation(command, 1, "ReferenceError: Cannot access 'first' before initialization"),
    );

    assert.match(diagnostic, /\[state-audit probe-invalid\]/);
    assert.match(diagnostic, /callback runs synchronously/i);
    assert.match(diagnostic, /inside the callback only assign/i);
    assert.match(diagnostic, /after the outer run returns/i);
    assert.match(diagnostic, /Do not edit production code/i);
  });

  it("identifies a rejected Promise incorrectly awaited as a value", () => {
    const command = `node --input-type=module -e '
      import assert from "node:assert/strict";
      const first = pool.run("k", () => { throw new Error("boom"); });
      assert.equal(await first, "boom");
    '`;
    const diagnostic = stateAuditProbeDiagnostic(
      { a: "shell", c: command },
      shellObservation(command, 1, "Error: boom"),
    );

    assert.match(diagnostic, /\[state-audit probe-invalid\]/);
    assert.match(diagnostic, /await assert\.rejects\(first, expectedReason\)/);
    assert.match(diagnostic, /Preserve rejection identity/);
    assert.match(diagnostic, /Do not edit production code/);
  });

  it("does not diagnose ordinary shell failures as broken lifecycle probes", () => {
    assert.equal(
      stateAuditProbeDiagnostic(
        { a: "shell", c: "npm test" },
        "ReferenceError: Cannot access 'first' before initialization",
      ),
      "",
    );
  });
});
