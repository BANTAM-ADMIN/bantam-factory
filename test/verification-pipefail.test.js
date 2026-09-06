import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { classifyVerificationResult, runAgent } from "../src/agent.js";
import { Executor, runShellProcess } from "../src/executor.js";
import { verificationEvidence } from "../src/verification-evidence.js";

const PIPELINE = 'node -e "process.exit(7)" | tail -1';

describe("formal verification pipefail", () => {
  it("preserves a custom verifier crash through an ordinary tail filter", async (t) => {
    const workspace = temporaryWorkspace(t);
    fs.writeFileSync(path.join(workspace, "verify.mjs"), 'throw new Error("invalid fixture");\n');
    const executor = new Executor(workspace, { shellSandbox: "host" });
    const result = await executor.execute({ a: "shell", c: "node verify.mjs 2>&1 | tail -20" });
    assert.equal(result.shellExecution.exitCode, 1);
    assert.equal(result.shellExecution.pipefail, true);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "fail");
    assert.match(result.observation, /Error: invalid fixture/);
  });

  it("does not misclassify expected-error output from a successful custom check", async (t) => {
    const workspace = temporaryWorkspace(t);
    fs.writeFileSync(path.join(workspace, "verify.mjs"), 'console.log("Error: invalid fixture (expected and caught)");\n');
    const executor = new Executor(workspace, { shellSandbox: "host" });
    const result = await executor.execute({ a: "shell", c: "node verify.mjs 2>&1 | tail -20" });
    assert.equal(result.shellExecution.exitCode, 0);
    assert.equal(result.shellExecution.pipefail, true);
    assert.equal(verificationEvidence({ execution: result.shellExecution, generation: 0 }).status, "pass");
  });

  it("does not let a successful output filter hide a failing verifier", async (t) => {
    const workspace = temporaryWorkspace(t);
    const model = scriptedModel([
      JSON.stringify({ a: "done", summary: "finished" }),
    ]);

    const result = await runAgent({
      task: "Finish the task.",
      workspace,
      model,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: null,
      shellSandbox: "host",
      verificationScript: PIPELINE,
    });

    assert.equal(result.verification.status, "fail");
    assert.equal(result.verification.exitCode, 7);
  });

  it("leaves ordinary shell pipeline semantics unchanged unless pipefail is explicit", async (t) => {
    const workspace = temporaryWorkspace(t);

    const ordinary = await runShellProcess(workspace, PIPELINE, {
      shellSandbox: "host",
    });
    const strict = await runShellProcess(workspace, PIPELINE, {
      shellSandbox: "host",
      pipefail: true,
    });

    assert.equal(ordinary.code, 0);
    assert.equal(strict.code, 7);
  });

  it("passes verifier text as one unchanged argv element for host and Docker", async (t) => {
    const workspace = temporaryWorkspace(t);
    const command = String.raw`printf '%s\n' '$HOME;$(touch should-not-run);*'`;
    const calls = [];
    const processRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        aborted: false,
      };
    };

    await runShellProcess(workspace, command, {
      shellSandbox: "host",
      pipefail: true,
      processRunner,
    });
    await runShellProcess(workspace, command, {
      shellSandbox: "docker",
      dockerImage: "fixture/image:local",
      pipefail: true,
      processRunner,
    });
    await runShellProcess(workspace, command, {
      shellSandbox: "host",
      processRunner,
    });

    assert.equal(calls[0].file, "/bin/bash");
    assert.deepEqual(calls[0].args, ["-o", "pipefail", "-c", command]);
    assert.deepEqual(
      calls[1].args.slice(-6),
      ["fixture/image:local", "/bin/bash", "-o", "pipefail", "-c", command],
    );
    assert.equal(calls[2].file, "/bin/sh");
    assert.deepEqual(calls[2].args, ["-c", command]);
  });

  it("overlays managed workspace state as read-only after the writable root mount", async (t) => {
    const workspace = temporaryWorkspace(t);
    for (const relative of [".git", ".bantam", "node_modules"]) {
      fs.mkdirSync(path.join(workspace, relative));
    }
    let invocation = null;
    await runShellProcess(workspace, "node --test", {
      shellSandbox: "docker",
      dockerImage: "fixture/image:local",
      readOnlyWorkspacePaths: [".git", ".bantam", "node_modules"],
      processRunner: async (file, args) => {
        invocation = { file, args };
        return {
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          bufferExceeded: false,
          aborted: false,
        };
      },
    });

    const mounts = invocation.args
      .flatMap((value, index, values) => value === "-v" ? [values[index + 1]] : []);
    const rootMount = `${fs.realpathSync(workspace)}:${fs.realpathSync(workspace)}:rw`;
    assert.ok(mounts.includes(rootMount));
    const rootIndex = mounts.indexOf(rootMount);
    for (const relative of [".git", ".bantam", "node_modules"]) {
      const target = path.join(fs.realpathSync(workspace), relative);
      const overlay = `${fs.realpathSync(target)}:${target}:ro`;
      assert.ok(mounts.includes(overlay), overlay);
      assert.ok(mounts.indexOf(overlay) > rootIndex, `${relative} overlay must follow root`);
    }

    await assert.rejects(
      runShellProcess(workspace, "true", {
        shellSandbox: "docker",
        readOnlyWorkspacePaths: ["../escape"],
      }),
      /invalid read-only workspace path/,
    );
  });

  it("enforces managed read-only paths for direct file actions as well as shell", async (t) => {
    const workspace = temporaryWorkspace(t);
    fs.mkdirSync(path.join(workspace, "node_modules", "fixture"), { recursive: true });
    const dependency = path.join(workspace, "node_modules", "fixture", "index.js");
    fs.writeFileSync(dependency, "export const value = 1;\n");
    const executor = new Executor(workspace, {
      shellSandbox: "host",
      readOnlyWorkspacePaths: ["node_modules"],
    });

    for (const action of [
      { a: "replace", p: "node_modules/fixture/index.js", old: "1", new: "2" },
      { a: "edit_lines", p: "node_modules/fixture/index.js", start: 1, end: 1, new: "changed" },
      { a: "write_file", p: "node_modules/fixture/new.js", content: "changed\n" },
      { a: "delete_file", p: "node_modules/fixture/index.js" },
      { a: "move_file", from: "node_modules/fixture/index.js", to: "moved.js" },
      {
        a: "patch",
        edits: [{ p: "node_modules/fixture/index.js", old: "1", new: "2" }],
      },
    ]) {
      const result = await executor.execute(action);
      assert.match(result.observation, /read-only by workspace policy/);
    }
    assert.equal(fs.readFileSync(dependency, "utf8"), "export const value = 1;\n");
    assert.equal(fs.existsSync(path.join(workspace, "node_modules", "fixture", "new.js")), false);
  });

  it("mounts the complete verifier workspace read-only before entering it", async (t) => {
    const workspace = temporaryWorkspace(t);
    fs.writeFileSync(path.join(workspace, ".env"), "sentinel\n");
    let invocation = null;
    await runShellProcess(workspace, "node --test", {
      shellSandbox: "docker",
      dockerImage: "fixture/image:local",
      workspaceReadOnly: true,
      processRunner: async (file, args) => {
        invocation = { file, args };
        return {
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          bufferExceeded: false,
          aborted: false,
        };
      },
    });

    const root = fs.realpathSync(workspace);
    const rootReadOnly = `${root}:${root}:ro`;
    const rootWritable = `${root}:${root}:rw`;
    const mounts = invocation.args
      .flatMap((value, index, values) => value === "-v" ? [values[index + 1]] : []);
    assert.ok(mounts.includes(rootReadOnly));
    assert.ok(!mounts.includes(rootWritable));
    assert.ok(invocation.args.indexOf(rootReadOnly) < invocation.args.indexOf("-w"));
    assert.deepEqual(
      invocation.args.slice(-4),
      ["fixture/image:local", "/bin/sh", "-c", "node --test"],
    );

    await assert.rejects(
      runShellProcess(workspace, "true", {
        shellSandbox: "docker",
        workspaceReadOnly: "yes",
      }),
      /workspaceReadOnly must be a boolean/,
    );
  });

  it("keeps non-exit termination states out of pass/fail evidence", () => {
    const base = { code: 1, stdout: "partial output", stderr: "" };

    const outputKilled = classifyVerificationResult({
      ...base,
      bufferExceeded: true,
      signal: "SIGKILL",
    });
    const signaled = classifyVerificationResult({
      ...base,
      signal: "SIGTERM",
    });
    const spawnError = classifyVerificationResult({
      ...base,
      error: new Error("spawn failed"),
    });

    assert.equal(outputKilled.status, "unverified");
    assert.equal(outputKilled.bufferExceeded, true);
    assert.equal(signaled.status, "unverified");
    assert.equal(signaled.signal, "SIGTERM");
    assert.equal(spawnError.status, "unverified");
    assert.equal(spawnError.error, "spawn failed");
    assert.equal(classifyVerificationResult(base).status, "fail");
  });

  it("forwards explicit child markers to model shell and formal verifier processes", async (t) => {
    const workspace = temporaryWorkspace(t);
    const marker = { BANTAM_SELF_IMPROVE_CHILD: "1" };
    const executor = new Executor(workspace, {
      shellSandbox: "host",
      shellEnvOverrides: marker,
    });
    const shell = await executor.execute({
      a: "shell",
      c: "node -e \"process.stdout.write(process.env.BANTAM_SELF_IMPROVE_CHILD || 'missing')\"",
    });
    assert.match(shell.observation, /\b1\b/);

    const result = await runAgent({
      task: "Finish the task.",
      workspace,
      model: scriptedModel([JSON.stringify({ a: "done", summary: "finished" })]),
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: null,
      shellSandbox: "host",
      shellEnvOverrides: marker,
      verificationScript: [
        "node -e",
        "\"process.exit(process.env.BANTAM_SELF_IMPROVE_CHILD === '1' ? 0 : 9)\"",
      ].join(" "),
    });
    assert.equal(result.verification.status, "pass");
  });

  it("keeps every harness verifier Docker-offline and root-read-only despite ambient overrides", async (t) => {
    const workspace = temporaryWorkspace(t);
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
    for (const relative of [".git", ".bantam", "node_modules"]) {
      fs.mkdirSync(path.join(workspace, relative), { recursive: true });
      fs.writeFileSync(path.join(workspace, relative, ".keep"), "managed\n");
    }
    fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
      type: "module",
      scripts: { test: "node --test" },
    }));
    fs.writeFileSync(
      path.join(workspace, "src", "value.js"),
      "export function value() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(workspace, "test", "value.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { value } from "../src/value.js";',
        "test('value', () => assert.equal(value(), 1));",
        "",
      ].join("\n"),
    );

    const calls = [];
    const processRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        code: 0,
        signal: null,
        stdout: "# tests 1\n# pass 1\n# fail 0\n",
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        aborted: false,
      };
    };
    const ambient = {
      BANTAM_SHELL_SANDBOX: process.env.BANTAM_SHELL_SANDBOX,
      BANTAM_SHELL_NETWORK: process.env.BANTAM_SHELL_NETWORK,
      BANTAM_DOCKER_IMAGE: process.env.BANTAM_DOCKER_IMAGE,
    };
    process.env.BANTAM_SHELL_SANDBOX = "host";
    process.env.BANTAM_SHELL_NETWORK = "1";
    process.env.BANTAM_DOCKER_IMAGE = "ambient/unsafe:latest";

    let scopedResult;
    let autoResult;
    let scopedCalls;
    let autoCalls;
    try {
      scopedResult = await runAgent({
        task: "Update value behavior. When MY_SECRET is missing or unset, the verifier must still pass.",
        workspace,
        model: scriptedModel([
          JSON.stringify({ a: "shell", c: "printf ordinary-shell" }),
          JSON.stringify({
            a: "replace",
            p: "src/value.js",
            old: "return 1;",
            new: "return 2;",
          }),
          JSON.stringify({ a: "done", summary: "updated value behavior" }),
        ]),
        maxTurns: 3,
        interactive: true,
        useGrammar: false,
        grounding: true,
        scopedVerify: true,
        completionAudit: false,
        autoVerifyBlindEdits: 1,
        autoVerifyProbes: 0,
        autoVerifyStaleTurns: 0,
        shellSandbox: "docker",
        shellNetwork: false,
        dockerImage: "managed/verifier:test",
        readOnlyWorkspacePaths: [".git", ".bantam", "node_modules"],
        verificationWorkspaceReadOnly: true,
        shellProcessRunner: processRunner,
        verificationScript: "node --test test/*.test.js",
      });
      scopedCalls = calls.splice(0);

      autoResult = await runAgent({
        task: "Update the value implementation.",
        workspace,
        model: scriptedModel([
          JSON.stringify({
            a: "replace",
            p: "src/value.js",
            old: "return 2;",
            new: "return 3;",
          }),
          JSON.stringify({ a: "done", summary: "updated value implementation" }),
        ]),
        maxTurns: 2,
        interactive: true,
        useGrammar: false,
        grounding: null,
        scopedVerify: false,
        completionAudit: false,
        autoVerifyBlindEdits: 1,
        autoVerifyProbes: 0,
        autoVerifyStaleTurns: 0,
        shellSandbox: "docker",
        shellNetwork: false,
        dockerImage: "managed/verifier:test",
        readOnlyWorkspacePaths: [".git", ".bantam", "node_modules"],
        verificationWorkspaceReadOnly: true,
        shellProcessRunner: processRunner,
        verificationScript: "node --test test/*.test.js",
      });
      autoCalls = calls.splice(0);
    } finally {
      for (const [name, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    assert.equal(scopedResult.metrics.scopedVerifies, 1);
    assert.equal(scopedResult.metrics.environmentVerificationRuns, 1);
    assert.equal(autoResult.metrics.autoVerifies, 1);

    const root = fs.realpathSync(workspace);
    const rootRw = `${root}:${root}:rw`;
    const rootRo = `${root}:${root}:ro`;
    const mounts = (call) => call.args
      .flatMap((value, index, values) => value === "-v" ? [values[index + 1]] : []);
    const command = (call) => call.args.at(-1);
    const ordinary = scopedCalls.find((call) => command(call) === "printf ordinary-shell");
    assert.ok(ordinary, "ordinary implementation shell was not observed");
    assert.ok(mounts(ordinary).includes(rootRw), "implementation shell needs a writable root");
    assert.ok(!mounts(ordinary).includes(rootRo));

    const scopedVerifier = scopedCalls.find((call) => (
      command(call).includes("test/value.test.js")
    ));
    assert.ok(scopedVerifier, "harness scoped verifier was not observed");
    const environmentVerifier = scopedCalls.find((call) => (
      call.args.some((value) => String(value).startsWith("MY_SECRET="))
    ));
    assert.ok(environmentVerifier, "environment verifier was not observed");
    assert.ok(autoCalls.length >= 1, "blind-edit auto-verifier was not observed");

    const verifierCalls = [
      ...scopedCalls.filter((call) => call !== ordinary),
      ...autoCalls,
    ];
    for (const call of verifierCalls) {
      assert.equal(call.file, "docker");
      assert.ok(call.args.includes("--network"));
      assert.equal(call.args[call.args.indexOf("--network") + 1], "none");
      assert.ok(call.args.includes("managed/verifier:test"));
      assert.ok(!call.args.includes("ambient/unsafe:latest"));
      assert.ok(mounts(call).includes(rootRo), `verifier root was writable: ${command(call)}`);
      assert.ok(!mounts(call).includes(rootRw), `verifier exposed an rw root: ${command(call)}`);
    }
  });
});

function temporaryWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-verification-pipefail-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    async complete() {
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}
