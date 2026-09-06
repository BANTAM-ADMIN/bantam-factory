import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyCodexDelegate,
  buildCodexExecArgs,
  formatCodexDelegate,
  loadCodexDelegate,
  parseCodexJsonl,
  runCodexDelegate,
} from "../src/codex-delegate.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-delegate-test-"));
  fs.writeFileSync(path.join(root, "source.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  return root;
}

const jsonl = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "c", type: "command_execution", command: "npm test" } }),
  JSON.stringify({ type: "item.completed", item: { id: "f", type: "file_change" } }),
  JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } }),
  JSON.stringify({ type: "turn.completed", usage: {
    input_tokens: 1000,
    cached_input_tokens: 750,
    output_tokens: 80,
    reasoning_output_tokens: 30,
  } }),
].join("\n");

test("Codex delegate arguments pin native safety, model, effort, and workspace", () => {
  const args = buildCodexExecArgs({
    model: "sol",
    effort: "xhigh",
    workspace: "/tmp/work",
    task: "fix it",
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("gpt-5.6-sol"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(args.at(-1), "fix it");
});

test("native delegation selects exact Astra without substituting another model or weakening isolation", () => {
  for (const model of ["astra", "codex-astra", "gpt-6-astra"]) {
    const args = buildCodexExecArgs({ model, effort: "medium", workspace: "/tmp/work", task: "fix it" });
    assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
    assert.ok(args.includes('model_reasoning_effort="medium"'));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
  for (const effort of ["none", "minimal"]) {
    assert.throws(() => buildCodexExecArgs({ model: "astra", effort, workspace: "/tmp/work", task: "fix it" }), /invalid delegate reasoning effort/);
  }
  assert.throws(() => buildCodexExecArgs({ model: "unrecognized-model", effort: "medium", workspace: "/tmp/work", task: "fix it" }), /unsupported delegate model/);
});

test("Codex delegate can attach screenshots to a native visual-review pass", () => {
  const args = buildCodexExecArgs({
    model: "sol", effort: "high", workspace: "/tmp/work", task: "review it", images: ["/tmp/frame.png"],
  });
  assert.deepEqual(args.slice(-4), ["--image", "/tmp/frame.png", "--", "review it"]);
});

test("Codex delegate sandbox bypass is explicit", () => {
  const args = buildCodexExecArgs({ model: "sol", effort: "high", workspace: "/tmp/work", task: "fix it", bypassSandbox: true });
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("workspace-write"));
});

test("Codex JSONL parser preserves events and normalizes complete usage", () => {
  const parsed = parseCodexJsonl(`${jsonl}\nnot-json\n`);
  assert.equal(parsed.threadId, "thread-1");
  assert.equal(parsed.finalMessage, "done");
  assert.deepEqual(parsed.usage, {
    turns: 1,
    inputTokens: 1000,
    cachedInputTokens: 750,
    cacheMissTokens: 250,
    outputTokens: 80,
    reasoningOutputTokens: 30,
    totalTokens: 1080,
  });
  assert.equal(parsed.eventSummary.commands, 1);
  assert.equal(parsed.eventSummary.fileChanges, 1);
  assert.equal(parsed.parseErrors.length, 1);
});

test("delegate runs in an external snapshot, verifies, persists evidence, and leaves source untouched", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  let observedWorkspace;
  const processRunner = async (_file, _args, options) => {
    observedWorkspace = options.cwd;
    fs.writeFileSync(path.join(options.cwd, "answer.js"), "export const answer = 42;\n");
    return {
      stdout: jsonl, stderr: "", code: 0, signal: null, timedOut: false,
      aborted: false, bufferExceeded: false,
    };
  };
  const result = await runCodexDelegate({
    workspace: source,
    task: "add answer",
    model: "terra",
    effort: "medium",
    verificationScript: "npm test",
    processRunner,
    verifier: async (_cwd, command) => ({
      command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok",
    }),
  });
  assert.equal(path.relative(source, observedWorkspace).startsWith(`..${path.sep}`), true);
  assert.equal(fs.existsSync(path.join(source, "answer.js")), false);
  assert.equal(result.artifact.result.pass, true);
  assert.equal(result.artifact.model, "gpt-5.6-terra");
  assert.equal(result.artifact.usage.cachedInputTokens, 750);
  assert.equal(fs.readFileSync(result.artifact.transcript.streamPath, "utf8"), jsonl);
  assert.equal(result.artifact.transcript.eventCount, 6);
  assert.equal(result.artifact.transcript.stderrBytes, 0);
  assert.match(result.artifact.transcript.stderrSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.artifact.finalDiff.files, ["answer.js"]);
  assert.equal(result.artifact.runtimeWorkspace, null);
  assert.equal(loadCodexDelegate(result.directory).artifact.id, result.artifact.id);
  assert.match(formatCodexDelegate(result.artifact), /cache 750 hit\/250 miss/);
});

test("delegate visual review attaches a rendered screenshot to a second native Codex pass", async (t) => {
  const source = workspace();
  const screenshot = path.join(source, "frame.png");
  fs.writeFileSync(screenshot, "not-a-real-png");
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const calls = [];
  const run = await runCodexDelegate({
    workspace: source,
    task: "build a scene",
    visualReview: true,
    processRunner: async (_file, args, options) => {
      calls.push(args);
      if (calls.length === 1) fs.writeFileSync(path.join(options.cwd, "index.html"), "<canvas></canvas>");
      return { stdout: jsonl, stderr: "", code: 0, signal: null, timedOut: false, aborted: false, bufferExceeded: false };
    },
    previewRunner: () => ({ screenshot, previewStatus: "pass" }),
    verifier: async (_cwd, command) => ({ command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok" }),
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("--image"));
  assert.ok(calls[1].includes(screenshot));
  assert.equal(run.artifact.visualReview.screenshotCaptured, true);
});

test("visual review can recover a verifier-passing candidate after the build turn times out", async (t) => {
  const source = workspace();
  const screenshot = path.join(source, "frame.png");
  fs.writeFileSync(screenshot, "not-a-real-png");
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  let calls = 0;
  const run = await runCodexDelegate({
    workspace: source,
    task: "build a scene",
    verificationScript: "npm test",
    visualReview: true,
    processRunner: async (_file, _args, options) => {
      calls += 1;
      if (calls === 1) {
        fs.writeFileSync(path.join(options.cwd, "index.html"), "<canvas></canvas>");
        return { stdout: jsonl, stderr: "", code: null, signal: "SIGTERM", timedOut: true, aborted: false, bufferExceeded: false };
      }
      return { stdout: jsonl, stderr: "", code: 0, signal: null, timedOut: false, aborted: false, bufferExceeded: false };
    },
    previewRunner: () => ({ screenshot, previewStatus: "pass" }),
    verifier: async (_cwd, command) => ({ command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok" }),
  });
  assert.equal(calls, 2);
  assert.equal(run.artifact.visualReview.recoveredFromBuildTimeout, true);
  assert.equal(run.artifact.result.status, "pass");
  assert.equal(run.artifact.result.pass, true);
});

test("delegate apply is explicit, baseline-bound, candidate-verified, and transactional", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const run = await runCodexDelegate({
    workspace: source,
    task: "add answer",
    verificationScript: "npm test",
    processRunner: async (_file, _args, options) => {
      fs.writeFileSync(path.join(options.cwd, "answer.js"), "export const answer = 42;\n");
      return {
        stdout: jsonl, stderr: "", code: 0, signal: null, timedOut: false,
        aborted: false, bufferExceeded: false,
      };
    },
    verifier: async (_cwd, command) => ({
      command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok",
    }),
  });
  const applied = await applyCodexDelegate({
    artifactPath: run.artifactPath,
    verifier: async (_cwd, command) => ({
      command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok",
    }),
  });
  assert.equal(applied.transaction.state, "committed");
  assert.equal(fs.readFileSync(path.join(source, "answer.js"), "utf8"), "export const answer = 42;\n");
});

test("delegate failures are not mislabeled as successful candidates", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const run = await runCodexDelegate({
    workspace: source,
    task: "fail",
    processRunner: async () => ({
      stdout: "", stderr: "nope", code: 1, signal: null, timedOut: false,
      aborted: false, bufferExceeded: false,
    }),
  });
  assert.equal(run.artifact.result.pass, false);
  assert.equal(run.artifact.result.status, "codex-failed");
});
