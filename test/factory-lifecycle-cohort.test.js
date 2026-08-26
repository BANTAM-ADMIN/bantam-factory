import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  formatLifecycleCohort,
  loadLifecycleCohort,
  runLifecycleCohort,
} from "../src/factory.js";
import { runFactoryCommand } from "../src/factory-cli.js";

const fixture = path.resolve("gauntlet/fixtures/keyed-task-pool-strong");
const temporary = new Set();

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lifecycle-cohort-test-"));
  temporary.add(directory);
  return directory;
}

function runners(calls, { fail = null, hidden = false } = {}) {
  return Object.fromEntries(["native", "bantam", "factory"].map((arm) => [arm, async (context) => {
    calls.push({ arm, baseline: context.baseline.tree, model: context.model, effort: context.effort });
    if (fail === arm) throw new Error(`${arm} transport unavailable`);
    return {
      status: "pass",
      pass: true,
      baselineTree: context.baseline.tree,
      candidateTree: `${context.baseline.tree.slice(0, 36)}${arm.length.toString(16).padStart(4, "0")}`,
      public: { status: "pass", pass: true },
      contract: { status: "pass", pass: true, tests: 4, passed: 4, failed: 0 },
      durationMs: arm.length * 100,
      usage: { turns: arm.length, requests: arm.length, totalTokens: arm.length * 1000 },
      artifact: `/evidence/${arm}.json`,
      hiddenVisibleToWorker: hidden && arm === "native",
    };
  }]));
}

describe("lifecycle comparison cohort", () => {
  it("runs an explicit balanced arm order from one baseline and writes an auditable manifest", async () => {
    const calls = [];
    const result = await runLifecycleCohort({
      fixtureDir: fixture,
      root: root(),
      id: "cohort-green",
      model: "terra",
      effort: "medium",
      order: ["factory", "native", "bantam"],
      armRunners: runners(calls),
    });

    assert.deepEqual(calls.map((call) => call.arm), ["factory", "native", "bantam"]);
    assert.equal(new Set(calls.map((call) => call.baseline)).size, 1);
    assert.equal(result.manifest.comparability.valid, true);
    assert.equal(result.manifest.summary.passed, 3);
    assert.match(result.manifest.ref, /^cohort:cohort-green:sha256:/);
    assert.deepEqual(loadLifecycleCohort(result.manifestPath), result.manifest);
    assert.match(formatLifecycleCohort(result.manifest), /passed 3\/3/);
  });

  it("retains an infrastructure arm and continues the remaining production order", async () => {
    const calls = [];
    const result = await runLifecycleCohort({
      fixtureDir: fixture,
      root: root(),
      id: "cohort-infrastructure",
      armRunners: runners(calls, { fail: "bantam" }),
    });
    assert.deepEqual(calls.map((call) => call.arm), ["native", "bantam", "factory"]);
    const failed = result.manifest.arms.find((arm) => arm.id === "bantam");
    assert.equal(failed.status, "infrastructure");
    assert.match(failed.error, /transport unavailable/);
    assert.equal(result.manifest.summary.completed, 3);
    assert.equal(result.manifest.summary.passed, 2);
  });

  it("marks hidden-verifier exposure or a changed baseline as non-comparable", async () => {
    const calls = [];
    const exposed = runners(calls, { hidden: true });
    const original = exposed.factory;
    exposed.factory = async (context) => ({ ...(await original(context)), baselineTree: "0".repeat(40) });
    const result = await runLifecycleCohort({ fixtureDir: fixture, root: root(), id: "cohort-invalid", armRunners: exposed });
    assert.equal(result.manifest.comparability.valid, false);
    assert.equal(result.manifest.comparability.checks.identicalBaseline, false);
    assert.equal(result.manifest.comparability.checks.hiddenBoundary, false);
  });

  it("rejects incomplete arm orders and detects manifest tampering", async () => {
    await assert.rejects(runLifecycleCohort({ fixtureDir: fixture, root: root(), order: ["native", "factory"] }), /order must contain exactly/);
    const result = await runLifecycleCohort({ fixtureDir: fixture, root: root(), id: "cohort-tamper", armRunners: runners([]) });
    const changed = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    changed.arms[0].pass = false;
    fs.writeFileSync(result.manifestPath, JSON.stringify(changed));
    assert.throws(() => loadLifecycleCohort(result.manifestPath), /reference mismatch/);
  });

  it("requires explicit cohort authority and supports run/show through the factory CLI", async () => {
    const factoryRoot = root();
    const built = await runLifecycleCohort({ fixtureDir: fixture, root: factoryRoot, id: "cohort-cli", armRunners: runners([]) });
    const refusedError = sink();
    assert.equal(await runFactoryCommand(["factory", "cohort", "run", fixture, "--factory-home", factoryRoot], { stderr: refusedError, stdout: sink() }), 2);
    assert.match(refusedError.text(), /repeat with --yes/);

    let received = null;
    const stdout = sink();
    const code = await runFactoryCommand([
      "factory", "cohort", "run", fixture, "--yes", "--id", "fresh", "--model", "terra",
      "--effort", "medium", "--order", "factory,native,bantam", "--factory-home", factoryRoot, "--json",
    ], {
      stdout,
      stderr: sink(),
      runLifecycleCohortFn: async (options) => { received = options; return built; },
    });
    assert.equal(code, 0);
    assert.equal(received.id, "fresh");
    assert.equal(received.order, "factory,native,bantam");
    assert.equal(JSON.parse(stdout.text()).kind, "bantam.factory-lifecycle-cohort");

    const shown = sink();
    assert.equal(await runFactoryCommand(["factory", "cohort", "show", "cohort-cli", "--factory-home", factoryRoot], { stdout: shown, stderr: sink() }), 0);
    assert.match(shown.text(), /passed 3\/3/);
  });
});

function sink() { let value = ""; return { write(chunk) { value += chunk; }, text() { return value; } }; }
