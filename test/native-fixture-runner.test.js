import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runExperiment } from "../src/experiment-runner.js";
import { normalizeExperimentSpec } from "../src/experiment.js";
import { runNativeFixture } from "../src/native-fixture-runner.js";
import { WorkspaceStore } from "../src/workspace-store.js";

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-native-fixture-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = temp(t);
  const dir = path.join(root, "fixture");
  fs.mkdirSync(path.join(dir, "repo", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "repo", "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
    name: "native-proof",
    task: "Implement src/answer.js without changing tests.",
    verify: "node --test",
    editable: ["src"],
  }));
  fs.writeFileSync(path.join(dir, "repo", "test", "public.test.js"), "// immutable public test\n");
  return { root, dir };
}

function fakeDelegate({ mutate, execution = { durationMs: 20 }, finalMessage = "" }) {
  return async ({ workspace, stateRoot, provider, model, effort }) => {
    const runDir = path.join(stateRoot, "delegate-run");
    const storeRoot = path.join(stateRoot, "_workspace-store");
    fs.mkdirSync(runDir, { recursive: true });
    const store = new WorkspaceStore(storeRoot);
    const baseline = store.capture(workspace, { message: "baseline" });
    mutate(workspace);
    const candidate = store.capture(workspace, { parent: baseline.commit, message: "candidate" });
    const artifactPath = path.join(runDir, "artifact.json");
    const artifact = {
      schema: 1,
      kind: provider === "claude" ? "bantam-claude-delegate" : "bantam-codex-delegate",
      provider,
      id: "delegate-run",
      model,
      effort,
      storeRoot,
      baseline,
      candidate,
      verification: { status: "pass", pass: true },
      execution,
      finalMessage,
      usage: {
        turns: 2,
        inputTokens: 100,
        cachedInputTokens: 60,
        cacheMissTokens: 40,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        costUsd: 0.01,
      },
      result: { status: "pass", pass: true },
    };
    fs.writeFileSync(artifactPath, JSON.stringify(artifact));
    return { artifact, artifactPath, directory: runDir };
  };
}

test("native fixture delegates receive independent hidden and scope grading", async (t) => {
  const { root, dir } = fixture(t);
  const output = path.join(root, "evidence");
  const row = await runNativeFixture({
    dir,
    arm: { name: "claude", model: { runtime: "native-claude", name: "sonnet", effort: "high" } },
    outputDir: output,
    experiment: { id: "league", arm: "claude", round: 1 },
    runNativeDelegateFn: fakeDelegate({
      mutate(workspace) {
        fs.writeFileSync(path.join(workspace, "src", "answer.js"), "export const answer = 42;\n");
      },
    }),
    runContractGraderFn: async ({ workspace }) => ({
      status: fs.existsSync(path.join(workspace, "src", "answer.js")) ? "pass" : "fail",
      pass: fs.existsSync(path.join(workspace, "src", "answer.js")),
      tests: 3,
      passed: 3,
      failed: 0,
      durationMs: 5,
    }),
  });

  assert.equal(row.status, "pass");
  assert.equal(row.contractPassed, 3);
  assert.equal(row.scopeViolations, 0);
  assert.equal(row.nativeProvider, "claude");
  assert.equal(row.inputTok, 100);
  const artifact = JSON.parse(fs.readFileSync(path.resolve(output, "delegate-run", "artifact.json"), "utf8"));
  assert.deepEqual(artifact.publicResult, { status: "pass", pass: true });
  assert.equal(artifact.independentEvaluation.contract.pass, true);
  assert.equal(artifact.experiment.id, "league");
});

test("native fixture cannot earn a pass after modifying a public test", async (t) => {
  const { root, dir } = fixture(t);
  const row = await runNativeFixture({
    dir,
    arm: { name: "native-codex", model: { runtime: "native-codex", name: "terra", effort: "medium" } },
    outputDir: path.join(root, "evidence"),
    runNativeDelegateFn: fakeDelegate({
      mutate(workspace) {
        fs.writeFileSync(path.join(workspace, "test", "public.test.js"), "// weakened\n");
      },
    }),
    runContractGraderFn: async () => ({ status: "pass", pass: true, tests: 1, passed: 1, failed: 0, durationMs: 1 }),
  });
  assert.equal(row.status, "cheated");
  assert.equal(row.scopeViolations, 1);
  assert.equal(row.scopeViolationDetails[0].kind, "test-tampering");
});

test("experiment scheduler dispatches a native-only arm without constructing a model client", async (t) => {
  const { root, dir } = fixture(t);
  const calls = [];
  const spec = {
    schema: 1,
    name: "native league smoke",
    fixtures: [dir],
    rounds: 1,
    arms: [{ name: "claude", model: { runtime: "native-claude", name: "sonnet", effort: "low" } }],
  };
  const outcome = await runExperiment({
    spec,
    fixtures: [{ name: "native-proof", dir }],
    outputDir: path.join(root, "experiment"),
    runNativeFixtureFn: async (options) => {
      calls.push(options);
      return { name: "native-proof", status: "pass", turns: 1, requests: 1 };
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(outcome.manifest.schedule[0].effectiveModel.runtime, "native-claude");
  assert.equal(outcome.manifest.schedule[0].runs[0].escalation.action, "complete");
  assert.equal(outcome.manifest.totals.arms.claude.passed, 1);
  assert.deepEqual(outcome.manifest.totals.arms.claude.escalationActions, { complete: 1 });
});

test("experiment model schema validates native provider-specific settings", () => {
  const spec = normalizeExperimentSpec({
    schema: 1,
    name: "mixed league",
    fixtures: ["fixture"],
    arms: [
      { name: "native-codex", model: { runtime: "native-codex", name: "terra", effort: "ultra", bypassSandbox: true } },
      { name: "claude", model: { runtime: "native-claude", name: "opus", effort: "max", permissionMode: "accept-edits" } },
    ],
  });
  assert.equal(spec.arms[0].model.bypassSandbox, true);
  assert.equal(spec.arms[1].model.permissionMode, "acceptEdits");
  assert.throws(() => normalizeExperimentSpec({
    schema: 1,
    name: "bad claude effort",
    fixtures: ["fixture"],
    arms: [{ name: "claude", model: { runtime: "native-claude", name: "opus", effort: "ultra" } }],
  }), /invalid claude model effort/);
  assert.throws(() => normalizeExperimentSpec({
    schema: 1,
    name: "wrong bypass runtime",
    fixtures: ["fixture"],
    arms: [{ name: "claude", model: { runtime: "native-claude", name: "sonnet", bypassSandbox: true } }],
  }), /bypassSandbox is only valid for native-codex/);
});

test("native fixture forwards explicit Codex sandbox bypass and classifies sandbox failure as infrastructure", async (t) => {
  const { root, dir } = fixture(t);
  let received;
  const delegate = fakeDelegate({
    mutate() {},
    execution: { durationMs: 20, stderr: "fs sandbox helper failed: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" },
    finalMessage: "Blocked by workspace sandbox failure",
  });
  const row = await runNativeFixture({
    dir,
    arm: { name: "native-codex", model: { runtime: "native-codex", name: "terra", bypassSandbox: true } },
    outputDir: path.join(root, "evidence"),
    runNativeDelegateFn: async (options) => {
      received = options;
      return delegate(options);
    },
    runContractGraderFn: async () => ({ status: "fail", pass: false, tests: 1, passed: 0, failed: 1, durationMs: 1 }),
  });
  assert.equal(received.bypassSandbox, true);
  assert.equal(row.status, "native-sandbox-error");
});
