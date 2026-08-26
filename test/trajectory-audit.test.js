import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditExperimentTrajectories, writeExperimentTrajectoryAudit } from "../src/trajectory-audit.js";

test("trajectory audit verifies full logs and derives bounded candidate facts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trajectory-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localPath = path.join(root, "local.json");
  const requestBody = "{}";
  const responseBody = "{}";
  fs.writeFileSync(localPath, JSON.stringify({
    kind: "bantam-run",
    modelCalls: [{ status: "ok", request: { body: requestBody, bodySha256: crypto.createHash("sha256").update(requestBody).digest("hex") }, response: { rawBody: responseBody, bodySha256: crypto.createHash("sha256").update(responseBody).digest("hex") } }],
    turns: [
      { parsedAction: { a: "read_file" }, observation: "[open_files] Not re-read: src/a.js" },
      { parsedAction: { a: "shell", c: "npm test" }, observation: "1 passed\nexit code: 0" },
      { parsedAction: { a: "shell", c: "npm test" }, observation: "1 passed\nexit code: 0" },
    ],
    finalDiff: { text: "+ Array.from({ length: concurrency }, run)" },
  }));
  const stream = '{"type":"turn.completed"}\n';
  const streamPath = path.join(root, "stream.jsonl");
  fs.writeFileSync(streamPath, stream);
  const nativePath = path.join(root, "native.json");
  fs.writeFileSync(nativePath, JSON.stringify({
    kind: "bantam-codex-delegate",
    transcript: { streamPath, sha256: crypto.createHash("sha256").update(stream).digest("hex"), eventCount: 1 },
    execution: { parseErrors: [] },
    events: [{ type: "turn.completed" }],
    finalDiff: { text: "+ Math.min(concurrency, input.length)" },
  }));
  const claudePath = path.join(root, "claude.json");
  fs.writeFileSync(claudePath, JSON.stringify({
    kind: "bantam-claude-delegate",
    transcript: { streamPath, sha256: crypto.createHash("sha256").update(stream).digest("hex"), eventCount: 2 },
    execution: { parseErrors: [] },
    events: [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "This command requires approval" }] } },
    ],
    finalDiff: { text: "+ Math.min(concurrency, items.length)" },
  }));
  const manifest = { id: "audit", schedule: [{ arm: "local", round: 1, runs: [
    { name: "task", artifactPath: "local.json" },
  ] }, { arm: "codex", round: 1, runs: [
    { name: "task", artifactPath: "native.json" },
  ] }, { arm: "claude", round: 1, runs: [
    { name: "task", artifactPath: "claude.json" },
  ] }] };
  const report = auditExperimentTrajectories({ outputDir: root, manifest });
  assert.equal(report.artifactsAudited, 3);
  assert.equal(report.runs[0].logIntegrity, "pass");
  assert.ok(report.runs[0].issues.some((issue) => issue.code === "repeated-bantam-command"));
  assert.ok(report.hypotheses.some((item) => item.id === "reuse-green-verification-until-edit"));
  assert.ok(report.runs[2].issues.some((issue) => issue.code === "verifier-permission-denied"));
  assert.ok(report.hypotheses.some((item) => item.id === "bound-worker-spawn-by-available-work"));
  const written = writeExperimentTrajectoryAudit(root, manifest);
  assert.ok(fs.existsSync(path.join(root, written.jsonPath)));
  assert.ok(fs.existsSync(path.join(root, written.markdownPath)));
});

test("trajectory audit recomputes BANTAM API body hashes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trajectory-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "local.json"), JSON.stringify({
    kind: "bantam-run",
    modelCalls: [{ status: "ok", request: { body: "request", bodySha256: "bad" }, response: { rawBody: "response", bodySha256: "bad" } }],
    turns: [],
  }));
  const report = auditExperimentTrajectories({ outputDir: root, manifest: {
    schedule: [{ arm: "local", round: 1, runs: [{ name: "task", artifactPath: "local.json" }] }],
  } });
  assert.equal(report.status, "fail");
  assert.equal(report.runs[0].issues[0].code, "api-record-hash");
});

test("trajectory audit fails closed when a native raw stream is absent or changed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trajectory-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "native.json"), JSON.stringify({
    kind: "bantam-codex-delegate", events: [{ type: "turn.completed" }], execution: { parseErrors: [] },
  }));
  const report = auditExperimentTrajectories({ outputDir: root, manifest: {
    schedule: [{ arm: "native", round: 1, runs: [{ name: "task", artifactPath: "native.json" }] }],
  } });
  assert.equal(report.status, "fail");
  assert.equal(report.runs[0].issues[0].code, "raw-native-stream-missing");
});

test("trajectory audit reconstructs context loss findings from exact API prompts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-trajectory-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exactPrompt = "<|im_start|>system\nrules\n<|im_end|>\n"
    + "<|im_start|>user\nTask: fix\n<|im_end|>\n"
    + "<|im_start|>user\n<observation>\nERROR: anchor failed\n</observation>\n<|im_end|>\n"
    + "<|im_start|>assistant\n";
  const body = JSON.stringify({ prompt: exactPrompt });
  const response = "{}";
  fs.writeFileSync(path.join(root, "local.json"), JSON.stringify({
    kind: "bantam-run",
    modelCalls: [0, 1].map((index) => ({
      index,
      status: "ok",
      request: { body, bodySha256: crypto.createHash("sha256").update(body).digest("hex") },
      response: { rawBody: response, bodySha256: crypto.createHash("sha256").update(response).digest("hex") },
    })),
    turns: [
      { i: 0, modelCallIndex: 0, parsedAction: { a: "replace", p: "src/a.js", old: "a", new: "b" }, editApplied: false, observation: "ERROR: anchor failed\nAssertionError: expected a actual b" },
      { i: 1, modelCallIndex: 1, parsedAction: { a: "read_file", p: "src/a.js" }, observation: "source" },
    ],
  }));
  const report = auditExperimentTrajectories({ outputDir: root, manifest: {
    schedule: [{ arm: "local", round: 1, runs: [{ name: "task", artifactPath: "local.json" }] }],
  } });

  assert.ok(report.runs[0].issues.some((item) => item.code === "context-evidence-loss"));
  assert.ok(report.runs[0].issues.some((item) => item.code === "failed-edit-recovery-context-gap"));
  assert.ok(report.hypotheses.some((item) => item.id === "retain-decisive-failure-evidence"));
  assert.equal(report.runs[0].observations.contextFlightRecorder.priorEvidenceLinesMissing, 1);
});
