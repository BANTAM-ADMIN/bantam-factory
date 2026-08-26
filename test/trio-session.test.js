import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyTrioArm,
  buildTrioComparison,
  formatTrioComparison,
  loadTrioManifest,
  TrioSession,
} from "../src/trio-session.js";

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trio-"));
  fs.writeFileSync(path.join(root, "source.js"), "export const value = 'baseline';\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  return root;
}

function fakeModel(arm) {
  return {
    endpoint: arm.name === "local" ? "http://localhost:8085" : null,
    modelName: arm.model.name ?? "local",
    profileName: arm.name,
    codex: arm.model.runtime === "codex",
    async health() { return true; },
    metadata() {
      return { provider: this.codex ? "codex" : "local", model: this.modelName };
    },
    usageSummary() {
      return {
        requests: 2,
        inputTokens: arm.name === "local" ? 100 : 200,
        outputTokens: 25,
        cacheHitTokens: 10,
        cacheMissTokens: 90,
        reasoningTokens: this.codex ? 8 : 0,
        costUsd: 0,
      };
    },
    requestLog() { return []; },
    close() { this.closed = true; },
  };
}

function resultFor(arm, task) {
  return {
    done: true,
    reachedDone: true,
    summary: `${arm} completed ${task}`,
    responded: false,
    interrupted: false,
    blocked: null,
    modelFailure: null,
    warnings: [],
    verification: { status: "pass", detail: "ok", exitCode: 0 },
    turns: [],
    rejectedOutputs: [],
    integrity: null,
    metrics: {
      turns: arm === "local" ? 3 : 2,
      invalid: 0,
      protocolViolations: 0,
      tokens: 25,
      thinkTokens: arm === "local" ? 0 : 8,
      actionTokens: 17,
      durationMs: 50,
      actions: { write_file: 1 },
    },
  };
}

const readyPreflight = async () => ({
  pass: true,
  status: "pass",
  exitCode: 0,
  durationMs: 1,
  detail: "ok",
});

test("trio runs arms concurrently in isolated persistent workspaces", async (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const starts = [];
  let resolveAllStarted;
  let rejectAllStarted;
  const allStarted = new Promise((resolve, reject) => {
    resolveAllStarted = resolve;
    rejectAllStarted = reject;
  });
  const concurrencyDeadline = setTimeout(
    () => rejectAllStarted(new Error("three trio arms did not enter concurrently")),
    1000,
  );
  t.after(() => clearTimeout(concurrencyDeadline));
  const session = new TrioSession({
    workspace,
    id: "parallel-isolation",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: readyPreflight,
    runAgentImpl: async ({ task, workspace: lane }) => {
      const arm = path.basename(lane);
      starts.push({ arm, at: Date.now() });
      if (starts.length === 3) {
        clearTimeout(concurrencyDeadline);
        resolveAllStarted();
      }
      await allStarted;
      fs.writeFileSync(path.join(lane, "answer.txt"), `${arm}: ${task}\n`);
      return resultFor(arm, task);
    },
  });
  t.after(() => {
    session.close();
    if (session.runtimeRoot) fs.rmSync(session.runtimeRoot, { recursive: true, force: true });
  });

  await session.start();
  const before = fs.readFileSync(path.join(workspace, "source.js"), "utf8");
  const outcome = await session.runTurn("repair it");

  assert.equal(outcome.rows.length, 3);
  assert.equal(outcome.comparison.allPassed, true);
  assert.deepEqual(outcome.comparison.rows.map((row) => row.arm), ["local", "sol", "terra"]);
  assert.equal(starts.length, 3);
  assert.equal(fs.readFileSync(path.join(workspace, "source.js"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(workspace, "answer.txt")), false);
  const runningManifest = session.view();
  assert.equal(
    path.relative(workspace, runningManifest.runtimeRoot).startsWith(`..${path.sep}`),
    true,
    "executable lane copies must live outside the source tree",
  );
  assert.equal(
    fs.readdirSync(path.join(workspace, ".bantam"), { recursive: true })
      .some((entry) => String(entry).endsWith(".test.js")),
    false,
    "inert trio evidence must not contain recursively discoverable test copies",
  );
  for (const arm of ["local", "sol", "terra"]) {
    const lane = runningManifest.arms[arm].workspace;
    assert.equal(fs.readFileSync(path.join(lane, "answer.txt"), "utf8"), `${arm}: repair it\n`);
  }
  const manifest = loadTrioManifest(session.directory);
  assert.equal(manifest.turnCount, 1);
  assert.equal(Object.keys(manifest.arms).length, 3);
  assert.equal(buildTrioComparison(manifest).rows.length, 3);
  assert.ok(fs.existsSync(path.join(session.directory, "report", "index.html")));
  assert.ok(fs.existsSync(path.join(session.directory, "summary.md")));
});

test("advisory trio turns are read-only responses and are not graded as verifier failures", async (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const session = new TrioSession({
    workspace,
    id: "advisory-policy",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: async () => {
      throw new Error("advisory turns must not run implementation preflight");
    },
    runAgentImpl: async (options) => {
      calls.push(options);
      return {
        ...resultFor(path.basename(options.workspace), options.task),
        responded: true,
        summary: "Add a task-intent gate.",
        verification: { status: "skipped", detail: "workspace unchanged" },
        metrics: { ...resultFor("sol", options.task).metrics, actions: { respond: 1 } },
      };
    },
  });
  t.after(() => {
    session.close();
    if (session.runtimeRoot) fs.rmSync(session.runtimeRoot, { recursive: true, force: true });
  });

  await session.start();
  const outcome = await session.runTurn(
    "Take a look at our BANTAMBUILD directory. Give me your suggestions for the highest-value thing we could add.",
  );

  assert.equal(outcome.comparison.mode, "advisory");
  assert.equal(outcome.comparison.allPassed, true);
  assert.deepEqual(outcome.rows.map((row) => row.status), ["response", "response", "response"]);
  for (const options of calls) {
    assert.equal(options.verificationPolicy, "after_edit");
    assert.equal(options.advisoryMode, true);
    assert.equal(options.progressAwareness, false);
    assert.equal(options.autoForceEditAfter, 0);
    assert.ok(options.excludeActions.includes("write_file"));
    assert.ok(options.excludeActions.includes("shell"));
    assert.ok(options.excludeActions.includes("done"));
  }
  assert.match(
    formatTrioComparison(outcome.comparison),
    /all arms responded safely/,
  );
});

test("implementation preflight mirrors dependencies and fails closed on missing toolchain", async (t) => {
  const workspace = tempWorkspace();
  fs.mkdirSync(path.join(workspace, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "fixture", "index.js"), "export default true;\n");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const session = new TrioSession({
    workspace,
    id: "dependency-preflight",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: async (lane) => {
      assert.equal(fs.existsSync(path.join(lane, "node_modules", "fixture", "index.js")), true);
      return readyPreflight();
    },
    runAgentImpl: async (options) => {
      calls.push(options);
      return resultFor(path.basename(options.workspace), options.task);
    },
  });
  t.after(() => {
    session.close();
    if (session.runtimeRoot) fs.rmSync(session.runtimeRoot, { recursive: true, force: true });
  });
  await session.start();
  await session.runTurn("repair it");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].readOnlyWorkspacePaths, ["node_modules"]);

  const blockedWorkspace = tempWorkspace();
  t.after(() => fs.rmSync(blockedWorkspace, { recursive: true, force: true }));
  let agentCalls = 0;
  const blocked = new TrioSession({
    workspace: blockedWorkspace,
    id: "blocked-preflight",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: async () => ({
      pass: false,
      status: "fail",
      exitCode: 1,
      detail: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'acorn' imported from src/api-check.js",
    }),
    runAgentImpl: async () => {
      agentCalls++;
      return resultFor("local", "repair it");
    },
  });
  t.after(() => {
    blocked.close();
    if (blocked.runtimeRoot) fs.rmSync(blocked.runtimeRoot, { recursive: true, force: true });
  });
  await blocked.start();
  await assert.rejects(blocked.runTurn("repair it"), /implementation preflight failed/);
  assert.equal(agentCalls, 0);
  assert.equal(blocked.view().turnCount, 0);
});

test("trio apply verifies one arm and refuses a stale live baseline", async (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const session = new TrioSession({
    workspace,
    id: "safe-apply",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: readyPreflight,
    runAgentImpl: async ({ task, workspace: lane }) => {
      const arm = path.basename(lane);
      fs.writeFileSync(path.join(lane, "answer.txt"), `${arm}: ${task}\n`);
      return resultFor(arm, task);
    },
  });
  t.after(() => {
    session.close();
    if (session.runtimeRoot) fs.rmSync(session.runtimeRoot, { recursive: true, force: true });
  });
  await session.start();
  await session.runTurn("choose safely");

  const verifierCalls = [];
  const applied = await applyTrioArm({
    sessionDir: session.directory,
    arm: "terra",
    runVerifier: async (root, command) => {
      verifierCalls.push({ root, command });
      return { pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok" };
    },
  });
  assert.equal(applied.arm, "terra");
  assert.equal(fs.readFileSync(path.join(workspace, "answer.txt"), "utf8"), "terra: choose safely\n");
  assert.equal(verifierCalls.length, 2);

  const staleWorkspace = tempWorkspace();
  t.after(() => fs.rmSync(staleWorkspace, { recursive: true, force: true }));
  const stale = new TrioSession({
    workspace: staleWorkspace,
    id: "stale-apply",
    verificationScript: "npm test",
    modelFactory: async (arm) => fakeModel(arm),
    preflightVerifier: readyPreflight,
    runAgentImpl: async ({ task, workspace: lane }) => {
      const arm = path.basename(lane);
      fs.writeFileSync(path.join(lane, "answer.txt"), `${arm}: ${task}\n`);
      return resultFor(arm, task);
    },
  });
  t.after(() => {
    stale.close();
    if (stale.runtimeRoot) fs.rmSync(stale.runtimeRoot, { recursive: true, force: true });
  });
  await stale.start();
  await stale.runTurn("do not overwrite me");
  fs.writeFileSync(path.join(staleWorkspace, "human.txt"), "new human work\n");
  await assert.rejects(
    applyTrioArm({
      sessionDir: stale.directory,
      arm: "local",
      runVerifier: async () => ({ pass: true, status: "pass" }),
    }),
    /live workspace changed since the trio baseline/,
  );
  assert.equal(fs.existsSync(path.join(staleWorkspace, "answer.txt")), false);
  assert.equal(fs.readFileSync(path.join(staleWorkspace, "human.txt"), "utf8"), "new human work\n");
});

test("trio rejects unavailable arms before running a task", async (t) => {
  const workspace = tempWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const session = new TrioSession({
    workspace,
    id: "unavailable-arm",
    modelFactory: async (arm) => ({
      ...fakeModel(arm),
      async health() { return arm.name !== "sol"; },
    }),
  });
  t.after(() => {
    if (session.runtimeRoot) fs.rmSync(session.runtimeRoot, { recursive: true, force: true });
  });
  await assert.rejects(session.start(), /trio model\(s\) unavailable: sol/);
  const manifest = loadTrioManifest(session.directory);
  assert.equal(manifest.status, "failed");
});
