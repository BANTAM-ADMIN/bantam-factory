import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPLETION_AUDIT_MARKER,
  PLAN_AUDIT_MARKER,
  STATE_AUDIT_MARKER,
  completionAuditEnabled,
  completionAuditHint,
  completionAuditReanchor,
  extractMissingEnvironmentVariables,
  stateAuditEngagement,
  taskExplicitSpecDocumentPaths,
} from "../src/completion-audit.js";

describe("completion audit", () => {
  it("enables by default and recognizes only explicit truthy settings", () => {
    assert.equal(completionAuditEnabled(undefined), true);
    for (const value of ["1", "TRUE", "yes", "On"]) {
      assert.equal(completionAuditEnabled(value), true, value);
    }
    for (const value of ["0", "false", "off", "", null]) {
      assert.equal(completionAuditEnabled(value), false, String(value));
    }
  });

  it("extracts and de-duplicates only task-named prose document paths", () => {
    assert.deepEqual(
      taskExplicitSpecDocumentPaths(
        "Follow ./docs/Spec.md, docs/spec.md, ../guide.rst and README. Ignore src/app.js.",
      ),
      ["docs/Spec.md", "../guide.rst", "README"],
    );
    assert.deepEqual(taskExplicitSpecDocumentPaths(null), []);
  });

  it("grounds a missing environment check in an explicit, authoritative, unedited document", () => {
    const task = [
      "Follow docs/runtime.md.",
      "MY_SECRET is the named setting.",
      "PATH and BANTAM_INTERNAL must be unset too.",
    ].join(" ");
    const documents = [{
      path: "./docs/runtime.md",
      successfulRead: true,
      edited: false,
      text: "The MY_SECRET environment variable must be unset.",
    }];

    assert.deepEqual(extractMissingEnvironmentVariables({ task, documents }), ["MY_SECRET"]);
    assert.deepEqual(extractMissingEnvironmentVariables({ task, documents }, { max: 0 }), []);
    assert.deepEqual(extractMissingEnvironmentVariables({
      task,
      documents: [{ ...documents[0], edited: true }],
    }), []);
    assert.deepEqual(extractMissingEnvironmentVariables({
      task,
      documents: [{ ...documents[0], path: "docs/other.md" }],
    }), []);
  });

  it("does not infer absence from mentions, ambiguous acronyms, or denied variables", () => {
    const task = [
      "API is absent.",
      "Set FEATURE_FLAG to true.",
      "PATH must be unset.",
      "BANTAM_PRIVATE must not be set.",
      "MY_TOKEN must be undefined.",
      "SECOND_TOKEN must be absent.",
    ].join(" ");

    // The production cap intentionally permits only one task-grounded check.
    assert.deepEqual(extractMissingEnvironmentVariables({ task }, { max: 99 }), ["MY_TOKEN"]);
  });

  it("emits only after trusted green evidence on a changed workspace", () => {
    const turn = {
      action: { a: "write_file" },
      scopedVerify: { verdict: "pass", command: "./bin/verify" },
    };
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn,
    });

    assert.match(hint, /\[completion-audit\] The trusted configured verification is green/);
    assert.equal(completionAuditHint({
      enabled: false,
      workspaceChanged: true,
      emitted: false,
      turn,
    }), null);
    assert.equal(completionAuditHint({
      enabled: true,
      workspaceChanged: false,
      emitted: false,
      turn,
    }), null);
    assert.equal(completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: true,
      turn,
    }), null);
    assert.equal(completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: { ...turn, scopedVerify: { verdict: "fail", command: "./bin/verify" } },
    }), null);
  });

  it("uses test-accurate wording and prioritizes the plan audit specialization", () => {
    const directTest = {
      action: { a: "shell", c: "node --test test/example.test.js" },
      observation: "# pass 2\n# fail 0\nexit 0",
    };
    const planHint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: directTest,
      planAudit: true,
      stateAudit: true,
      stateRisks: [{ path: "src/cache.js", line: 4, message: "stale cleanup" }],
    });

    assert.ok(planHint.startsWith(`\n\n${COMPLETION_AUDIT_MARKER} Tests are green.`));
    assert.ok(planHint.includes(PLAN_AUDIT_MARKER));
    assert.equal(planHint.includes(STATE_AUDIT_MARKER), false);
  });

  it("includes focused state risks when the state audit is selected", () => {
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: {
        action: { a: "write_file" },
        scopedVerify: { verdict: "pass", command: "npm test" },
      },
      stateAudit: true,
      stateRisks: [{ path: "src/cache.js", line: 8, message: "unguarded cleanup" }],
    });

    assert.ok(hint.includes(STATE_AUDIT_MARKER));
    assert.match(hint, /src\/cache\.js:8 unguarded cleanup/);
  });

  it("specializes keyed Promise audits around publication, reentrancy, and observable settlement", () => {
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: {
        action: { a: "shell", c: "npm test" },
        observation: "# pass 1\n# fail 0\nexit 0",
      },
      stateAudit: true,
      stateAuditReason: "auto-keyed-promise-lifecycle",
    });

    assert.match(hint, /publish key → Promise before invoking user task code/i);
    assert.match(hint, /synchronously reenter with the same key/i);
    assert.match(hint, /before fulfillment or rejection becomes observable/i);
    assert.match(hint, /capture a synchronously thrown task's returned Promise/i);
    assert.match(hint, /await assert\.rejects\(first, expectedReason\)/i);
    assert.match(hint, /never use `assert\.equal\(await first, value\)`/i);
    assert.match(hint, /nested = subject\.run\(key, \(\) => "must not run"\)/i);
    assert.match(hint, /nested === first/i);
    assert.match(hint, /immediately after an observed fulfillment and an observed rejection/i);
  });

  it("specializes abort audits without injecting keyed-cache instructions", () => {
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: {
        action: { a: "shell", c: "npm test" },
        observation: "# pass 1\n# fail 0\nexit 0",
      },
      stateAudit: true,
      stateAuditReason: "auto-async-abort-lifecycle",
    });

    assert.match(hint, /abort while those workers are still blocked/i);
    assert.match(hint, /remove that exact listener before resolving/i);
    assert.match(hint, /synchronous throws become per-item rejected results/i);
    assert.doesNotMatch(hint, /same-key reentrancy|key-to-Promise/i);
  });

  it("uses Datalog completion context to propagate keyed TTL freshness into size", () => {
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      task: "Implement a cache whose get always returns a Promise. Validate key and loader. Concurrent misses for the same key return the exact same Promise. invalidate fences an older in-flight completion. TTL begins when loading resolves, ttlMs 0 is immediately stale, and size() returns only currently fresh settled entries.",
      turn: {
        action: { a: "shell", c: "npm test" },
        observation: "# pass 4\n# fail 0\nexit 0",
      },
      stateAudit: true,
      stateAuditReason: "auto-keyed-promise-lifecycle",
    });

    assert.match(hint, /\[derived-completion-context\]/);
    assert.match(hint, /Store each settled entry's own TTL/);
    assert.match(hint, /assert `size\(\) === 0`/);
    assert.doesNotMatch(hint, /sparse collection slots|shared wrapper object/);
  });

  it("keeps per-input result record identity in the ordinary requirement audit", () => {
    const hint = completionAuditHint({
      enabled: true,
      workspaceChanged: true,
      emitted: false,
      turn: {
        action: { a: "shell", c: "npm test" },
        observation: "# pass 1\n# fail 0\nexit 0",
      },
    });

    assert.match(hint, /one result per input/i);
    assert.match(hint, /independent result record for each input/i);
    assert.match(hint, /shared wrapper object is not multiple results/i);
  });

  it("reanchors only a fired audit with a non-empty assignment", () => {
    assert.equal(completionAuditReanchor("Fix it", "ordinary output"), "");
    assert.equal(completionAuditReanchor(" ", COMPLETION_AUDIT_MARKER), "");
    assert.match(
      completionAuditReanchor("Fix exact behavior", `prefix ${COMPLETION_AUDIT_MARKER}`),
      /^\[completion-audit\] POST-GREEN COMPLETION AUDIT:/,
    );
    const hint = completionAuditReanchor("long assignment ".repeat(2000), COMPLETION_AUDIT_MARKER);
    assert.ok(hint.length < 700);
    assert.doesNotMatch(hint, /<open_files>|Exact assignment:|long assignment/);
    assert.match(hint, /absent or stale, read_file/);
  });

  it("recognizes substantive state-audit actions without crediting duplicates or verification", () => {
    assert.equal(stateAuditEngagement(null), false);
    assert.equal(stateAuditEngagement({ a: "read_file" }, { duplicate: true }), false);
    assert.equal(stateAuditEngagement({ a: "write_file" }, { directEditSucceeded: true }), true);
    assert.equal(stateAuditEngagement({ a: "read_file" }), true);
    assert.equal(stateAuditEngagement({ a: "search" }), true);
    assert.equal(stateAuditEngagement({
      a: "inspect",
      ops: [{ a: "list_files" }, { a: "read_file" }],
    }), true);
    assert.equal(stateAuditEngagement({
      a: "inspect",
      ops: [{ a: "list_files" }],
    }), false);
    assert.equal(stateAuditEngagement(
      { a: "shell", c: "node -e 'console.log(1)'" },
      { observation: "exit 0" },
    ), true);
    assert.equal(stateAuditEngagement(
      { a: "shell", c: "npm test" },
      { observation: "# pass 1\n# fail 0\nexit 0" },
    ), false);
  });
});
