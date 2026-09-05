import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkspaceProbe } from "../src/workspace-probe.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-probe-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every workspace probe uses a readonly Docker mount and the injected runner", async (t) => {
  const workspace = fixture(t);
  for (const kind of ["edge_smoke", "spec_example", "lexical_smoke", "type_contract"]) {
    let calls = 0;
    const result = await runWorkspaceProbe({
      workspace, kind, task: "test contract", shellSandbox: "docker",
      processRunner: async (file, args) => {
        calls++;
        assert.equal(file, "docker");
        assert.ok(args.includes("--read-only"));
        assert.ok(args.includes(`${workspace}:${workspace}:ro`));
        assert.ok(args.includes("none"));
        const stages = fs.readdirSync(path.join(workspace, ".bantam", "probes"));
        assert.equal(stages.length, 1);
        const helper = path.join(workspace, ".bantam", "probes", stages[0], "probe.mjs");
        assert.ok(fs.readFileSync(helper, "utf8").includes("node:fs"));
        assert.ok(args.at(-1).includes(helper));
        return { code: 0, stdout: "[]", stderr: "" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(fs.readdirSync(path.join(workspace, ".bantam", "probes")), []);
  }
});

test("failed, malformed, timed out and interrupted probes never become empty findings", async (t) => {
  const workspace = fixture(t);
  const cases = [
    [{ code: 125, stderr: "no image" }, "error"],
    [{ code: 0, stdout: "not json" }, "error"],
    [{ code: 0, stdout: "{}" }, "error"],
    [{ timedOut: true, code: null, stdout: "[]" }, "timeout"],
    [{ aborted: true, code: null, stdout: "[]" }, "interrupted"],
  ];
  for (const [outcome, status] of cases) {
    const result = await runWorkspaceProbe({ workspace, kind: "edge_smoke", shellSandbox: "host", processRunner: async () => outcome });
    assert.equal(result.status, status);
    assert.equal(result.findings, undefined);
  }
});

test("probe staging refuses a workspace symlink before writing outside it", async (t) => {
  const workspace = fixture(t), outside = fixture(t);
  fs.symlinkSync(outside, path.join(workspace, ".bantam"));
  let called = false;
  const result = await runWorkspaceProbe({ workspace, kind: "edge_smoke", processRunner: async () => { called = true; } });
  assert.equal(result.status, "error");
  assert.match(result.detail, /real directory/);
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("unknown sandbox mode fails closed instead of selecting a host shell", async (t) => {
  let called = false;
  const result = await runWorkspaceProbe({ workspace: fixture(t), kind: "edge_smoke", shellSandbox: "dokcer", processRunner: async () => { called = true; } });
  assert.equal(result.status, "error");
  assert.equal(called, false);
});

test("probe cleanup failure remains a typed error rather than escaping the loop", { skip: process.getuid?.() === 0 }, async (t) => {
  const workspace = fixture(t);
  let stage;
  const result = await runWorkspaceProbe({ workspace, kind: "edge_smoke", shellSandbox: "host", processRunner: async () => {
    const parent = path.join(workspace, ".bantam", "probes");
    stage = path.join(parent, fs.readdirSync(parent)[0]);
    fs.chmodSync(stage, 0);
    return { code: 0, stdout: "[]", stderr: "" };
  } });
  if (stage) fs.chmodSync(stage, 0o700);
  assert.equal(result.status, "error");
  assert.match(result.detail, /staging cleanup failed/);
  assert.equal(result.findings, undefined);
});

test("explicit host probing still executes valid contract helpers with a scrubbed environment", async (t) => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(workspace, "collections.js"), "export function normalizeTags(value) { return [String(value)]; }");
  const result = await runWorkspaceProbe({
    workspace, kind: "type_contract", task: "normalizeTags accepts an array of strings.", shellSandbox: "host",
  });
  assert.equal(result.status, "ok");
  assert.ok(result.findings.some((f) => f.fn === "normalizeTags"));
});
