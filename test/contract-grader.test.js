import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  findContractGrader,
  parseTapCounts,
  runContractGrader,
} from "../src/contract-grader.js";

const temporary = new Set();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-contract-grader-"));
  temporary.add(root);
  const fixtureDir = path.join(root, "fixture");
  const workspace = path.join(root, "candidate");
  fs.mkdirSync(path.join(fixtureDir, "grader"), { recursive: true });
  fs.mkdirSync(workspace);
  return {
    root,
    fixtureDir,
    workspace,
    grader: path.join(fixtureDir, "grader", "contract.test.cjs"),
  };
}

afterEach(() => {
  for (const directory of temporary) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporary.clear();
});

describe("contract grader", () => {
  it("finds only a regular hidden grader and returns an absolute path", () => {
    const state = fixture();
    assert.equal(findContractGrader(state.fixtureDir), null);

    fs.mkdirSync(state.grader);
    assert.equal(findContractGrader(state.fixtureDir), null);
    fs.rmdirSync(state.grader);

    fs.writeFileSync(state.grader, "module.exports = {};\n");
    assert.equal(findContractGrader(state.fixtureDir), state.grader);

    const linkFixture = path.join(state.root, "linked-fixture");
    fs.mkdirSync(path.join(linkFixture, "grader"), { recursive: true });
    fs.symlinkSync(state.grader, path.join(linkFixture, "grader", "contract.test.cjs"));
    assert.equal(findContractGrader(linkFixture), null);
  });

  it("returns null without spawning when a fixture has no grader", async () => {
    const state = fixture();
    assert.equal(findContractGrader(), null);
    assert.equal(findContractGrader(""), null);
    assert.equal(await runContractGrader({
      fixtureDir: state.fixtureDir,
      workspace: state.workspace,
    }), null);
    assert.equal(await runContractGrader(), null);
  });

  it("runs a passing suite against the candidate root, strips nested-test context, and clips detail", async () => {
    const state = fixture();
    fs.writeFileSync(path.join(state.workspace, "value.txt"), "candidate bytes\n");
    fs.writeFileSync(state.grader, [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'test("candidate", () => {',
      '  assert.equal(fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, "value.txt"), "utf8"), "candidate bytes\\n");',
      '  console.log("detail-" + "x".repeat(500));',
      "});",
      "",
    ].join("\n"));

    const result = await runContractGrader({
      fixtureDir: state.fixtureDir,
      workspace: state.workspace,
      outputLimit: 100,
    });

    assert.equal(result.status, "pass");
    assert.equal(result.pass, true);
    assert.equal(result.tests, 1);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.ok(result.durationMs >= 0);
    assert.ok(result.detail.length <= 100);
    assert.match(result.detail, /clipped/);
  });

  it("reports a failed assertion and TAP totals without conflating it with a spawn error", async () => {
    const state = fixture();
    fs.writeFileSync(state.grader, [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("failure", () => assert.equal(1, 2));',
      "",
    ].join("\n"));

    const result = await runContractGrader({
      fixtureDir: state.fixtureDir,
      workspace: state.workspace,
    });

    assert.equal(result.status, "fail");
    assert.equal(result.pass, false);
    assert.equal(result.tests, 1);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.exitCode, 1);
    assert.match(result.detail, /AssertionError|Expected values/);
  });

  it("kills a hanging grader process group at the timeout boundary", async () => {
    const state = fixture();
    fs.writeFileSync(state.grader, [
      'const test = require("node:test");',
      'test("hang", async () => new Promise(() => setInterval(() => {}, 1_000)));',
      "",
    ].join("\n"));

    const result = await runContractGrader({
      fixtureDir: state.fixtureDir,
      workspace: state.workspace,
      timeoutMs: 100,
    });

    assert.equal(result.status, "timeout");
    assert.equal(result.pass, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGKILL");
    assert.match(result.detail, /TAP version|contract grader timeout/);
  });

  it("surfaces process-start failures as grader errors", async () => {
    const state = fixture();
    fs.writeFileSync(state.grader, 'require("node:test").test("ok", () => {});\n');
    const missingWorkspace = path.join(state.root, "missing-workspace");

    const result = await runContractGrader({
      fixtureDir: state.fixtureDir,
      workspace: missingWorkspace,
    });

    assert.equal(result.status, "error");
    assert.equal(result.pass, false);
    assert.equal(result.tests, null);
    assert.equal(result.exitCode, 1);
    assert.match(result.detail, /ENOENT|no such file/i);
  });

  it("parses TAP totals independently and leaves absent counts null", () => {
    assert.deepEqual(parseTapCounts([
      "TAP version 13",
      "# tests 12",
      "# pass 10",
      "# fail 2",
    ].join("\n")), {
      tests: 12,
      passed: 10,
      failed: 2,
    });
    assert.deepEqual(parseTapCounts("ordinary output"), {
      tests: null,
      passed: null,
      failed: null,
    });
  });
});
