import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFactoryCommand } from "../src/factory-cli.js";

const LOCAL = "http://127.0.0.1:8085";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-factory-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(["BANTAM_API_URL", "BANTAM_API_DIALECT"].map(key => [key, process.env[key]]));
  process.env.BANTAM_API_URL = "https://hosted-provider.invalid/v1";
  process.env.BANTAM_API_DIALECT = "chat";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let stdout = "", stderr = "";
  return {
    root,
    io: { cwd: root, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } },
    output: () => ({ stdout, stderr }),
  };
}

function assertLocal(model) {
  assert.equal(model.endpoint, LOCAL);
  assert.equal(model.apiUrl, null, "explicit local endpoint must suppress the hosted API environment");
  assert.equal(model.apiMode, false);
  assert.equal(model.chatDialect, false, "hosted chat dialect must not change the explicit raw local route");
  assert.equal(model.codex, false);
}

test("factory build explicit endpoint overrides hosted transport environment", async t => {
  const { root, io, output } = setup(t);
  const workspace = path.join(root, "source");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "value.txt"), "old\n");
  let inspected = false;
  const code = await runFactoryCommand([
    "factory", "build", "Change value to new", "--workspace", workspace,
    "--endpoint", LOCAL, "--verify", "true", "--factory-home", path.join(root, "factory"), "--json",
  ], {
    ...io,
    runAgentFn: async ({ model, workspace: candidate }) => {
      assertLocal(model); inspected = true;
      fs.writeFileSync(path.join(candidate, "value.txt"), "new\n");
      return { reachedDone: true, turns: [], rejectedOutputs: [] };
    },
    verifier: async () => ({ pass: true, status: "pass" }),
  });
  assert.equal(code, 0, output().stderr);
  assert.equal(inspected, true);
  assert.equal(JSON.parse(output().stdout).status, "released");
});

for (const command of ["contract-edges", "contract-plan", "test-scenario"]) {
  test(`factory ${command} explicit endpoint overrides hosted transport environment`, async t => {
    const { root, io, output } = setup(t);
    const catalog = path.join(root, "catalog.json");
    fs.writeFileSync(catalog, "[]\n");
    let inspected = false;
    const cell = async ({ model }) => {
      assertLocal(model); inspected = true;
      return { jobId: "local-selection", status: "released", selection: {}, line: { events: [] } };
    };
    const code = await runFactoryCommand([
      "factory", command, "The lookup must handle a missing key",
      "--catalog", catalog, "--expected", "missing-key",
      ...(command === "test-scenario" ? ["--edge-id", "missing-key"] : []),
      "--endpoint", LOCAL, "--factory-home", path.join(root, "factory"), "--json",
    ], { ...io, runContractEdgeFactoryCellFn: cell, runContractTestPlanFactoryCellFn: cell, runTestScenarioFactoryCellFn: cell });
    assert.equal(code, 0, output().stderr);
    assert.equal(inspected, true);
  });
}

test("factory selection without explicit endpoint retains configured API transport", async t => {
  const { root, io, output } = setup(t);
  const catalog = path.join(root, "catalog.json");
  fs.writeFileSync(catalog, "[]\n");
  let inspected = false;
  const code = await runFactoryCommand([
    "factory", "contract-edges", "The lookup must handle a missing key",
    "--catalog", catalog, "--expected", "missing-key", "--factory-home", path.join(root, "factory"), "--json",
  ], {
    ...io,
    runContractEdgeFactoryCellFn: async ({ model }) => {
      assert.equal(model.apiUrl, "https://hosted-provider.invalid/v1");
      assert.equal(model.apiMode, true);
      assert.equal(model.chatDialect, true);
      inspected = true;
      return { jobId: "configured-selection", status: "released", selection: {}, line: { events: [] } };
    },
  });
  assert.equal(code, 0, output().stderr);
  assert.equal(inspected, true);
});
