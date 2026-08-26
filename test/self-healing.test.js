import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SelfHealing from "../src/self-healing.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-healing-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function write(workspace, relative, content) {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function failingLengthOutput(expected = 5, actual = 4) {
  return [
    "TAP version 13",
    "not ok 1 - length boundary",
    `  expected: ${expected}`,
    `  actual: ${actual}`,
    `  error: expected array with length ${expected} got ${actual}`,
  ].join("\n");
}

describe("SelfHealing construction and parsing", () => {
  it("keeps API defaults and accepts zero attempts", (t) => {
    const workspace = fixture(t);
    const defaults = new SelfHealing({ workspace });
    const disabled = new SelfHealing({ workspace, maxAttempts: 0 });
    assert.equal(defaults.maxAttempts, 3);
    assert.equal(disabled.maxAttempts, 0);
    assert.equal(defaults.heuristics.length, 6);
    assert.deepEqual(defaults.fixes, []);
  });

  it("parses TAP failures and expected/actual values", (t) => {
    const sh = new SelfHealing({ workspace: fixture(t) });
    const failures = sh._parseFailures([
      "not ok 1 - first",
      "  expected: true",
      "  actual: false",
      "not ok 2 - second",
      "  expected: 5",
      "  actual: 3",
    ].join("\n"));
    assert.equal(failures.length, 2);
    assert.equal(failures[0].expected, "true");
    assert.equal(failures[0].actual, "false");
    assert.equal(failures[1].id, 2);
  });

  it("parses standalone assertion and type errors", (t) => {
    const sh = new SelfHealing({ workspace: fixture(t) });
    assert.equal(sh._parseFailures("AssertionError: expected 1 to equal 2")[0].type, "AssertionError");
    assert.equal(
      sh._parseFailures("TypeError: Cannot read properties of undefined (reading 'name')")[0].type,
      "TypeError",
    );
  });
});

describe("SelfHealing test boundary", () => {
  it("refuses an implicit full-suite run", (t) => {
    const sh = new SelfHealing({ workspace: fixture(t) });
    assert.throws(
      () => sh.heal(),
      /requires one explicit testFile or an injected testRunner/,
    );
  });

  it("rejects globs and paths outside the workspace", (t) => {
    const workspace = fixture(t);
    const sh = new SelfHealing({ workspace });
    assert.throws(() => sh._runTests({ testFile: "test/*.test.js" }), /concrete file/);
    assert.throws(() => sh._runTests({ testFile: "../outside.test.js" }), /escapes workspace/);
  });

  it("rejects an ancestor symlink that resolves outside the workspace", (t) => {
    const workspace = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-healing-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    write(outside, "escaped.test.js", "void 0;\n");
    fs.symlinkSync(outside, path.join(workspace, "test", "escape"), "dir");
    const sh = new SelfHealing({ workspace });

    assert.throws(
      () => sh._runTests({ testFile: "test/escape/escaped.test.js" }),
      /test file real path escapes workspace/,
    );
  });

  it("invokes node with argv and shell disabled", (t) => {
    const workspace = fixture(t);
    const target = write(workspace, "test/literal;name.test.js", "void 0;\n");
    let call;
    const sh = new SelfHealing({
      workspace,
      spawnSync(command, args, options) {
        call = { command, args, options };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(sh._runTests({ testFile: path.relative(workspace, target) }), []);
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, ["--test", target]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, workspace);
    assert.equal(call.options.env.BANTAM_SELF_HEAL_VALIDATION, "1");
  });

  it("runs one real, hermetic test file", (t) => {
    const workspace = fixture(t);
    write(
      workspace,
      "test/one.test.cjs",
      "const test=require('node:test'); test('one',()=>{});\n",
    );
    const sh = new SelfHealing({ workspace, testTimeoutMs: 5_000 });
    assert.deepEqual(sh._runTests({ testFile: "test/one.test.cjs" }), []);
  });

  it("accepts an injected runner without a test file", (t) => {
    const sh = new SelfHealing({
      workspace: fixture(t),
      testRunner: () => ({ passed: false, output: failingLengthOutput() }),
    });
    const failures = sh._runTests();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message, "length boundary");
  });
});

describe("SelfHealing diagnosis and proposals", () => {
  it("diagnose is pure even when test edits are enabled", (t) => {
    const workspace = fixture(t);
    const file = write(
      workspace,
      "test/value.test.js",
      "assert.strictEqual(value, 100);\n",
    );
    const before = fs.readFileSync(file);
    const sh = new SelfHealing({ workspace, allowTestEdits: true });

    const diagnosis = sh.diagnose([
      { message: "expected 100 to equal 200" },
      { message: "Cannot find module './missing.js'" },
    ]);

    assert.equal(diagnosis.total, 2);
    assert.equal(diagnosis.matched, 2);
    assert.equal(diagnosis.byType["wrong-assertion"], 1);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it("heuristics propose bytes without applying them", (t) => {
    const workspace = fixture(t);
    const file = write(
      workspace,
      "src/count.js",
      "export function enough(items) {\n  return items.length >= 5;\n}\n",
    );
    const before = fs.readFileSync(file, "utf8");
    const sh = new SelfHealing({ workspace });
    const proposal = sh._offByOne(
      { message: "expected array with length 5 got 4" },
      {},
    );

    assert.equal(proposal.type, "off-by-one");
    assert.match(proposal.after, /\.length >= 4/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("test-file repair proposals are disabled by default", (t) => {
    const workspace = fixture(t);
    write(workspace, "test/value.test.js", "assert.strictEqual(value, 100);\n");
    const sh = new SelfHealing({ workspace });
    assert.equal(sh._wrongAssertion({ message: "expected 100 to equal 200" }), null);
  });
});

describe("SelfHealing transactional validation", () => {
  it("keeps a candidate only after the explicit validation passes", (t) => {
    const workspace = fixture(t);
    const file = write(
      workspace,
      "src/count.js",
      "export function enough(items) {\n  return items.length >= 5;\n}\n",
    );
    let calls = 0;
    const sh = new SelfHealing({
      workspace,
      maxAttempts: 1,
      testRunner() {
        calls++;
        if (calls === 1) return { passed: false, output: failingLengthOutput() };
        return {
          passed: fs.readFileSync(file, "utf8").includes(".length >= 4"),
          output: "",
        };
      },
    });

    const result = sh.heal();
    assert.equal(result.healed, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.fixes[0].validated, true);
    assert.match(fs.readFileSync(file, "utf8"), /\.length >= 4/);
    assert.deepEqual(sh.fixes, result.fixes);
  });

  it("restores exact bytes and mode when validation fails", (t) => {
    const workspace = fixture(t);
    const file = write(
      workspace,
      "src/count.js",
      Buffer.from("export function enough(items) {\n  return items.length >= 5;\n}\n"),
    );
    fs.chmodSync(file, 0o640);
    const before = fs.readFileSync(file);
    const beforeMode = fs.statSync(file).mode;
    let calls = 0;
    const sh = new SelfHealing({
      workspace,
      maxAttempts: 1,
      testRunner() {
        calls++;
        return { passed: false, output: failingLengthOutput() };
      },
    });

    const result = sh.heal();
    assert.equal(calls, 2);
    assert.equal(result.healed, 0);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.statSync(file).mode, beforeMode);
  });

  it("restores exact bytes when the validation runner throws", (t) => {
    const workspace = fixture(t);
    const file = write(
      workspace,
      "src/count.js",
      "export function enough(items) {\n  return items.length >= 5;\n}\n",
    );
    const before = fs.readFileSync(file);
    let calls = 0;
    const sh = new SelfHealing({
      workspace,
      maxAttempts: 1,
      testRunner() {
        calls++;
        if (calls === 1) return { passed: false, output: failingLengthOutput() };
        throw new Error("validator crashed");
      },
    });

    assert.throws(() => sh.heal(), /validator crashed/);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it("returns unresolved failures when no safe candidate exists", (t) => {
    const workspace = fixture(t);
    const sh = new SelfHealing({
      workspace,
      testRunner: () => ({
        passed: false,
        failures: [{ id: 1, message: "network unavailable" }],
      }),
    });
    const result = sh.heal();
    assert.equal(result.attempts, 0);
    assert.deepEqual(result.remaining, ["network unavailable"]);
  });

  it("reset clears committed fix state", (t) => {
    const sh = new SelfHealing({ workspace: fixture(t), testRunner: () => true });
    sh.fixes = [{ type: "test" }];
    sh.attempts = 2;
    sh.reset();
    assert.deepEqual(sh.fixes, []);
    assert.equal(sh.attempts, 0);
  });
});

describe("SelfHealing file discovery", () => {
  it("discovers only files under the configured temporary workspace", (t) => {
    const workspace = fixture(t);
    const source = write(workspace, "src/nested/source.js", "export const x = 1;\n");
    const testFile = write(workspace, "test/nested/source.test.js", "void 0;\n");
    const sh = new SelfHealing({ workspace });
    assert.deepEqual(sh._findSourceFiles(), [source]);
    assert.deepEqual(sh._findTestFiles(), [testFile]);
  });
});
