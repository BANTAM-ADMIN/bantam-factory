import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyClaudeDelegate,
  buildClaudePrintArgs,
  formatClaudeDelegate,
  loadClaudeDelegate,
  parseClaudeStreamJson,
  runClaudeDelegate,
} from "../src/claude-delegate.js";
import {
  formatNativeDelegate,
  loadNativeDelegate,
} from "../src/native-delegate.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-claude-delegate-test-"));
  fs.writeFileSync(path.join(root, "source.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  return root;
}

const stream = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "session-1", model: "claude-opus-5" }),
  JSON.stringify({
    type: "assistant", session_id: "session-1", message: {
      model: "claude-opus-5",
      usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 8 },
      content: [
        { type: "thinking", thinking: "inspect" },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", name: "Edit", input: { file_path: "source.js" } },
        { type: "text", text: "working" },
      ],
    },
  }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } }),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: "session-1",
    result: "done", num_turns: 2, total_cost_usd: 0.1234,
    usage: { input_tokens: 15, cache_creation_input_tokens: 25, cache_read_input_tokens: 160, output_tokens: 30 },
  }),
].join("\n");

test("Claude delegate arguments are noninteractive, streamed, bounded to project settings, and editable", () => {
  const args = buildClaudePrintArgs({ model: "opus", effort: "xhigh", task: "fix it", allowedTools: ["Bash(npm test)"] });
  assert.ok(args.includes("--print"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", "project"]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("acceptEdits"));
  assert.deepEqual(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2), ["--allowedTools", "Bash(npm test)"]);
  assert.equal(args.at(-1), "fix it");
});

test("Claude stream parser retains events, tool trajectory, and provider usage", () => {
  const parsed = parseClaudeStreamJson(`${stream}\nnot-json\n`);
  assert.equal(parsed.sessionId, "session-1");
  assert.equal(parsed.model, "claude-opus-5");
  assert.equal(parsed.finalMessage, "done");
  assert.deepEqual(parsed.usage, {
    turns: 2,
    inputTokens: 200,
    cachedInputTokens: 160,
    cacheCreationInputTokens: 25,
    cacheMissTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: null,
    totalTokens: 230,
    costUsd: 0.1234,
  });
  assert.equal(parsed.eventSummary.commands, 1);
  assert.equal(parsed.eventSummary.fileChanges, 1);
  assert.equal(parsed.eventSummary.toolUses, 2);
  assert.equal(parsed.eventSummary.toolResults, 1);
  assert.equal(parsed.parseErrors.length, 1);
});

test("Claude delegate runs outside the source, preserves its full raw stream, verifies, and leaves source untouched", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  let observedWorkspace;
  let launchedArgs;
  const result = await runClaudeDelegate({
    workspace: source,
    task: "add answer",
    model: "opus",
    effort: "high",
    verificationScript: "npm test",
    processRunner: async (_file, commandArgs, options) => {
      launchedArgs = commandArgs;
      observedWorkspace = options.cwd;
      fs.writeFileSync(path.join(options.cwd, "answer.js"), "export const answer = 42;\n");
      return {
        stdout: stream, stderr: "trace", code: 0, signal: null, timedOut: false,
        aborted: false, bufferExceeded: false,
      };
    },
    verifier: async (_cwd, command) => ({
      command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok",
    }),
  });
  assert.equal(path.relative(source, observedWorkspace).startsWith(`..${path.sep}`), true);
  assert.equal(fs.existsSync(path.join(source, "answer.js")), false);
  assert.equal(result.artifact.result.pass, true);
  assert.ok(launchedArgs.includes("Bash(npm test)"));
  assert.equal(result.artifact.model, "claude-opus-5");
  assert.deepEqual(result.artifact.finalDiff.files, ["answer.js"]);
  assert.equal(result.artifact.runtimeWorkspace, null);
  assert.equal(fs.readFileSync(result.artifact.transcript.streamPath, "utf8"), stream);
  assert.equal(fs.readFileSync(result.artifact.transcript.stderrPath, "utf8"), "trace");
  assert.equal(result.artifact.transcript.stderrBytes, 5);
  assert.match(result.artifact.transcript.stderrSha256, /^[a-f0-9]{64}$/);
  assert.equal(loadClaudeDelegate(result.directory).artifact.id, result.artifact.id);
  assert.equal(loadNativeDelegate(result.directory).artifact.kind, "bantam-claude-delegate");
  assert.match(formatClaudeDelegate(result.artifact), /native Claude Code delegate/);
  assert.match(formatNativeDelegate(result.artifact), /claude-stream\.jsonl/);
});

test("Claude delegate apply is baseline-bound, candidate-verified, and transactional", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const run = await runClaudeDelegate({
    workspace: source,
    task: "add answer",
    verificationScript: "npm test",
    processRunner: async (_file, _args, options) => {
      fs.writeFileSync(path.join(options.cwd, "answer.js"), "export const answer = 42;\n");
      return { stdout: stream, stderr: "", code: 0, signal: null, timedOut: false, aborted: false, bufferExceeded: false };
    },
    verifier: async (_cwd, command) => ({ command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok" }),
  });
  const applied = await applyClaudeDelegate({
    artifactPath: run.artifactPath,
    verifier: async (_cwd, command) => ({ command, pass: true, status: "pass", exitCode: 0, durationMs: 1, detail: "ok" }),
  });
  assert.equal(applied.transaction.state, "committed");
  assert.equal(fs.readFileSync(path.join(source, "answer.js"), "utf8"), "export const answer = 42;\n");
});

test("Claude CLI failures are not mislabeled as successful candidates", async (t) => {
  const source = workspace();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const run = await runClaudeDelegate({
    workspace: source,
    task: "fail",
    processRunner: async () => ({
      stdout: "", stderr: "nope", code: 1, signal: null, timedOut: false,
      aborted: false, bufferExceeded: false,
    }),
  });
  assert.equal(run.artifact.result.pass, false);
  assert.equal(run.artifact.result.status, "claude-failed");
});
