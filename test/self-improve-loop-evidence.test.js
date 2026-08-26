import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runSelfImproveLoop } from "../src/self-improve.js";

const temporary = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-improve-loop-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  return root;
}

afterEach(() => {
  while (temporary.length) {
    fs.rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

describe("self-improvement cycle evidence", () => {
  it("does not call a test-only success an improvement when reload fails", async () => {
    const root = workspace();
    let verifyCalls = 0;
    let callback;
    const result = await runSelfImproveLoop({
      workspace: root,
      maxCycles: 1,
      logPath: path.join(root, "evidence.json"),
      buildFn: () => [{ file: "candidate.js", action: "created" }],
      testFn: () => "passed",
      reloadFn: () => ({ ok: false, message: "not loaded" }),
      verifyFn: () => {
        verifyCalls++;
        return { ok: true };
      },
      onCycle: (_cycle, _candidate, evidence) => {
        callback = evidence;
      },
    });

    assert.equal(result.results[0].testPassed, true);
    assert.equal(result.results[0].passed, false);
    assert.equal(result.log.entries[0].passed, false);
    assert.equal(result.log.entries[0].reloaded, false);
    assert.equal(verifyCalls, 0);
    assert.equal(callback.passed, false);
  });

  it("requires configured verification and records thrown stage failures", async () => {
    const root = workspace();
    const verificationFailure = await runSelfImproveLoop({
      workspace: root,
      maxCycles: 1,
      logPath: path.join(root, "verify-evidence.json"),
      buildFn: () => [{ file: "candidate.js", action: "created" }],
      testFn: () => true,
      reloadFn: () => ({ ok: true }),
      verifyFn: () => ({ ok: false, message: "not integrated" }),
    });
    assert.equal(verificationFailure.results[0].passed, false);
    assert.equal(verificationFailure.log.entries[0].verified, false);

    const thrownReload = await runSelfImproveLoop({
      workspace: root,
      maxCycles: 1,
      logPath: path.join(root, "reload-evidence.json"),
      buildFn: () => [{ file: "candidate.js", action: "created" }],
      testFn: () => "passed",
      reloadFn: () => {
        throw new Error("reload exploded");
      },
    });
    assert.equal(thrownReload.results[0].passed, false);
    assert.match(thrownReload.results[0].reloadResult.message, /reload exploded/);
  });

  it("does not log a no-change test pass as a successful improvement", async () => {
    const root = workspace();
    let reloadCalls = 0;
    const result = await runSelfImproveLoop({
      workspace: root,
      maxCycles: 1,
      logPath: path.join(root, "evidence.json"),
      buildFn: () => [],
      testFn: () => "passed",
      reloadFn: () => {
        reloadCalls++;
        return { ok: true };
      },
    });

    assert.equal(result.results[0].testPassed, true);
    assert.equal(result.results[0].passed, false);
    assert.equal(result.log.entries[0].passed, false);
    assert.equal(reloadCalls, 0);
  });

  it("uses the evidence-aware scheduler and attempts each candidate once per run", async () => {
    const root = workspace();
    const repeated = [
      "const normalizedValueForStableComparison = String(value).trim().toLowerCase();",
      "const substantiveSegmentsForStableComparison = normalizedValueForStableComparison.split(/\\s+/).filter(Boolean);",
      "return substantiveSegmentsForStableComparison.map((segment) => segment.replace(/[^a-z0-9]/g, '')).join('-');",
    ].join("\n");
    for (const name of ["one", "two", "three"]) {
      fs.writeFileSync(path.join(root, "src", `${name}.js`), [
        `export function ${name}(value) {`,
        repeated,
        "}",
        "",
      ].join("\n"));
    }
    const logPath = path.join(root, ".bantam-improvements.json");
    fs.writeFileSync(logPath, JSON.stringify([
      { id: "previous-quality-failure", area: "code-quality", passed: false },
    ]));

    const result = await runSelfImproveLoop({
      workspace: root,
      maxCycles: 2,
      logPath,
      buildFn: (candidate) => [{ file: `${candidate.id}.js`, action: "planned" }],
      testFn: () => "passed",
    });

    assert.equal(result.results[0].candidate.id, "dedupe-patterns");
    assert.equal(
      new Set(result.results.filter(({ candidate }) => candidate).map(({ candidate }) => candidate.id)).size,
      2,
    );
  });

  it("rejects malformed builder output before recording evidence", async () => {
    const root = workspace();
    const logPath = path.join(root, "evidence.json");

    await assert.rejects(
      runSelfImproveLoop({
        workspace: root,
        maxCycles: 1,
        logPath,
        buildFn: () => ({ file: "not-an-array" }),
        testFn: () => "passed",
      }),
      /buildFn must return an array/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(logPath, "utf8")), []);
  });
});
