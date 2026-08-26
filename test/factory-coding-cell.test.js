import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  applyFactoryCodingCell,
  auditFactoryTraveler,
  runFactoryCodingCell,
} from "../src/factory.js";
import { runFactoryCommand } from "../src/factory-cli.js";

const temporary = new Set();

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-factory-cell-test-"));
  temporary.add(root);
  const workspace = path.join(root, "source");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "value.txt"), "old\n");
  fs.writeFileSync(path.join(workspace, "verify.js"), [
    "import fs from 'node:fs';",
    "if (fs.readFileSync('value.txt', 'utf8') !== 'new\\n') process.exit(1);",
  ].join("\n"));
  return { root, workspace, factoryRoot: path.join(workspace, ".bantam", "factory") };
}

function successfulAgent({ focused = null } = {}) {
  return async ({ workspace, onEvent }) => {
    assert.notEqual(path.basename(workspace), "source");
    fs.writeFileSync(path.join(workspace, "value.txt"), "new\n");
    onEvent({ type: "action", action: "write_file", path: "value.txt" });
    return {
      reachedDone: true,
      interrupted: false,
      blocked: false,
      modelFailure: null,
      summary: "updated candidate",
      verification: focused,
      metrics: { turns: 1, tokens: 123, modelRequests: 1 },
      turns: [{}],
      rejectedOutputs: [],
    };
  };
}

function sink() {
  let value = "";
  return { write(chunk) { value += chunk; }, text() { return value; } };
}

describe("BANTAMFACTORY isolated coding cell", () => {
  it("manufactures and verifies a durable candidate without touching the source", async () => {
    const { workspace, factoryRoot } = fixture();
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-release",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
    });

    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "old\n");
    assert.equal(built.line.supervisor.status, "released");
    assert.notEqual(built.manifest.candidate.tree, built.manifest.baseline.tree);
    assert.equal(built.manifest.finalInspection.pass, true);
    assert.equal(fs.existsSync(built.manifestPath), true);
    assert.equal(auditFactoryTraveler(built.line.events).terminal, true);
    assert.deepEqual(
      built.line.supervisor.stations.map((station) => station.stationAttempt),
      ["intake-1", "implementation-1", "inspection-1"],
    );
    const implementation = built.line.supervisor.stations.find((station) => station.stationAttempt === "implementation-1");
    assert.equal(implementation.performance.turns, 1);
    assert.equal(implementation.performance.modelRequests, 1);
    assert.equal(implementation.performance.outputTokens, 123);
    assert.equal(implementation.performance.totalTokens, 123);
    assert.equal(implementation.performance.operationMs >= 0, true);
  });

  it("applies only a released candidate and verifies the live transaction", async () => {
    const { workspace, factoryRoot } = fixture();
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-apply",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
    });
    const applied = await applyFactoryCodingCell({ manifestPath: built.manifestPath });

    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "new\n");
    assert.equal(applied.verification.pass, true);
    assert.equal(applied.transaction.state, "committed");
    const persisted = JSON.parse(fs.readFileSync(built.manifestPath, "utf8"));
    assert.equal(persisted.status, "applied");
    assert.equal(persisted.apply.transaction.state, "committed");
  });

  it("contains a candidate rejected by final inspection and refuses promotion", async () => {
    const { workspace, factoryRoot } = fixture();
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-contained",
      task: "make a bad candidate",
      verificationScript: "node verify.js",
      runAgentFn: async ({ workspace: candidate }) => {
        fs.writeFileSync(path.join(candidate, "value.txt"), "wrong\n");
        return { reachedDone: true, turns: [], rejectedOutputs: [] };
      },
    });

    assert.equal(built.line.supervisor.status, "blocked");
    assert.deepEqual(built.line.supervisor.chassis.contained, [`tree:${built.manifest.candidate.tree}`]);
    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "old\n");
    await assert.rejects(
      applyFactoryCodingCell({ manifestPath: built.manifestPath }),
      /job is blocked, not released/,
    );
  });

  it("stops at the model station when its focused gauge is red", async () => {
    const { workspace, factoryRoot } = fixture();
    let finalCalls = 0;
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-focused-red",
      task: "change old to new",
      focusedVerificationScript: "node focused.js",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent({ focused: { status: "fail", detail: "focused red" } }),
      verifier: async () => {
        finalCalls++;
        return { pass: true, status: "pass" };
      },
    });

    assert.equal(built.line.supervisor.status, "blocked");
    assert.equal(finalCalls, 0);
    assert.equal(built.line.supervisor.stations.some((station) => station.stationAttempt === "inspection-1"), false);
  });

  it("classifies model transport or quota failure as factory infrastructure", async () => {
    const { workspace, factoryRoot } = fixture();
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-worker-unavailable",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: async () => ({
        reachedDone: false,
        modelFailure: { code: "quota", message: "worker quota exhausted" },
        metrics: { turns: 0, tokens: 0, modelRequests: 1 },
        turns: [],
        rejectedOutputs: [],
      }),
    });

    assert.equal(built.line.supervisor.status, "blocked");
    assert.equal(built.line.supervisor.firstAbnormal.code, "gauge-infrastructure-implementation");
    assert.equal(built.line.supervisor.stations.find((station) => station.stationAttempt === "implementation-1").gaugeStatus, "infrastructure");
    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "old\n");
  });

  it("rejects a verifier that changes authored chassis bytes", async () => {
    const { workspace, factoryRoot } = fixture();
    const built = await runFactoryCodingCell({
      workspace,
      root: factoryRoot,
      jobId: "cell-mutating-gauge",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
      verifier: async (candidate) => {
        fs.writeFileSync(path.join(candidate, "gauge-output.txt"), "unrecorded\n");
        return { pass: true, status: "pass" };
      },
    });

    assert.equal(built.manifest.finalInspection.status, "mutated-workspace");
    assert.equal(built.line.supervisor.status, "blocked");
    assert.equal(fs.existsSync(path.join(workspace, "gauge-output.txt")), false);
  });

  it("refuses stale-baseline promotion and rolls back a red live verification", async () => {
    const first = fixture();
    const stale = await runFactoryCodingCell({
      workspace: first.workspace,
      root: first.factoryRoot,
      jobId: "cell-stale",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
    });
    fs.writeFileSync(path.join(first.workspace, "value.txt"), "operator edit\n");
    await assert.rejects(applyFactoryCodingCell({ manifestPath: stale.manifestPath }), /live workspace changed/);
    assert.equal(fs.readFileSync(path.join(first.workspace, "value.txt"), "utf8"), "operator edit\n");

    const second = fixture();
    const releasable = await runFactoryCodingCell({
      workspace: second.workspace,
      root: second.factoryRoot,
      jobId: "cell-rollback",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
    });
    let calls = 0;
    await assert.rejects(applyFactoryCodingCell({
      manifestPath: releasable.manifestPath,
      verifier: async () => {
        calls++;
        return calls === 1
          ? { pass: true, status: "pass" }
          : { pass: false, status: "fail" };
      },
    }), /apply rolled back/);
    assert.equal(fs.readFileSync(path.join(second.workspace, "value.txt"), "utf8"), "old\n");

    const third = fixture();
    const protectedBuild = await runFactoryCodingCell({
      workspace: third.workspace,
      root: third.factoryRoot,
      jobId: "cell-mutating-apply-gauge",
      task: "change old to new",
      verificationScript: "node verify.js",
      runAgentFn: successfulAgent(),
    });
    await assert.rejects(applyFactoryCodingCell({
      manifestPath: protectedBuild.manifestPath,
      verifier: async (candidate) => {
        fs.writeFileSync(path.join(candidate, "gauge-output.txt"), "unrecorded\n");
        return { pass: true, status: "pass" };
      },
    }), /mutated-workspace/);
    assert.equal(fs.readFileSync(path.join(third.workspace, "value.txt"), "utf8"), "old\n");
    assert.equal(fs.existsSync(path.join(third.workspace, "gauge-output.txt")), false);
  });

  it("exposes separated build and confirmed apply commands to operators", async () => {
    const { workspace, factoryRoot } = fixture();
    const output = sink();
    const errors = sink();
    assert.equal(await runFactoryCommand([
      "factory", "build", "change old to new",
      "--verify", "node verify.js",
      "--job-id", "cell-cli",
      "--factory-home", factoryRoot,
    ], {
      cwd: workspace,
      stdout: output,
      stderr: errors,
      runAgentFn: successfulAgent(),
    }), 0);
    assert.match(output.text(), /status: released/);
    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "old\n");

    const statsOutput = sink();
    assert.equal(await runFactoryCommand([
      "factory", "stats", "--factory-home", factoryRoot, "--json",
    ], { cwd: workspace, stdout: statsOutput, stderr: errors }), 0);
    const stats = JSON.parse(statsOutput.text());
    const implementation = stats.stations.find((station) => station.workerRef === "bantam-agent:injected");
    assert.equal(implementation.samples, 1);
    assert.equal(implementation.turns.mean, 1);
    assert.equal(implementation.totalTokens.mean, 123);

    const watchOutput = sink();
    assert.equal(await runFactoryCommand([
      "factory", "watch", "cell-cli", "--once", "--factory-home", factoryRoot, "--json",
    ], { cwd: workspace, stdout: watchOutput, stderr: errors }), 0);
    assert.equal(JSON.parse(watchOutput.text()).condition, "released");

    assert.equal(await runFactoryCommand([
      "factory", "apply", "cell-cli", "--factory-home", factoryRoot,
    ], { cwd: workspace, stdout: output, stderr: errors }), 2);
    assert.match(errors.text(), /repeat with --yes/);
    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "old\n");

    assert.equal(await runFactoryCommand([
      "factory", "apply", "cell-cli", "--yes", "--factory-home", factoryRoot,
    ], { cwd: workspace, stdout: output, stderr: errors }), 0);
    assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "new\n");
    assert.match(output.text(), /APPLIED/);
  });
});
