// Native Claude Code delegation.
//
// Claude owns its complete agent/tool loop inside an isolated materialized
// workspace. BANTAM owns the immutable baseline, the byte-level candidate,
// complete CLI stream evidence, independent verification, and explicit apply.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";
import { captureFinalDiff, prepareDiffBaseline } from "./diff.js";
import { runProcess } from "./process-runner.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceTransaction } from "./workspace-transaction.js";

const KIND = "bantam-claude-delegate";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function runClaudeDelegate({
  workspace,
  task,
  model = "opus",
  effort = "high",
  verificationScript = null,
  permissionMode = "acceptEdits",
  timeoutMs = 900_000,
  verifyTimeoutMs = 120_000,
  stateRoot = null,
  runtimeRoot = null,
  id = null,
  claudeCommand = "claude",
  processRunner = runProcess,
  verifier = defaultVerifier,
  onEvent = () => {},
} = {}) {
  const source = requireDirectory(workspace, "delegate workspace");
  const request = requiredString(task, "delegate task");
  const selectedModel = normalizeModel(model);
  const selectedEffort = normalizeEffort(effort);
  const selectedPermissionMode = normalizePermissionMode(permissionMode);
  const verify = optionalString(verificationScript);
  const root = path.resolve(stateRoot ?? path.join(source, ".bantam", "delegates"));
  const runId = id ?? delegateId();
  const directory = path.join(root, runId);
  if (fs.existsSync(directory)) throw new Error(`delegate run already exists: ${runId}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const storeRoot = path.join(root, "_workspace-store");
  const store = new WorkspaceStore(storeRoot);
  const baseline = store.capture(source, {
    message: `BANTAM Claude delegate ${runId} baseline`,
    excludePaths: [path.join(source, ".bantam"), root],
  });
  const ownedRuntime = runtimeRoot === null;
  const runtime = ownedRuntime
    ? fs.mkdtempSync(path.join(os.tmpdir(), `bantam-claude-delegate-${runId}-`))
    : path.resolve(runtimeRoot);
  const candidateWorkspace = path.join(runtime, "workspace");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  store.materialize(baseline.commit, candidateWorkspace);
  copyRuntimeDependencies(source, candidateWorkspace);
  const diffBaseline = prepareDiffBaseline(candidateWorkspace);
  if (diffBaseline.status !== "prepared") {
    throw new Error(`delegate diff baseline unavailable: ${diffBaseline.reason}`);
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const eventsPath = path.join(directory, "events.jsonl");
  const streamPath = path.join(directory, "claude-stream.jsonl");
  const stderrPath = path.join(directory, "claude-stderr.log");
  const emit = (event) => {
    const record = { time: new Date().toISOString(), runId, event };
    fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    onEvent(record);
  };
  const claudeArgs = buildClaudePrintArgs({
    model: selectedModel,
    effort: selectedEffort,
    task: delegatePrompt(request, verify),
    permissionMode: selectedPermissionMode,
    allowedTools: verify ? [`Bash(${verify})`] : [],
  });
  emit({
    type: "delegate_started",
    provider: "claude",
    model: selectedModel,
    effort: selectedEffort,
    permissionMode: selectedPermissionMode,
  });
  const processResult = await processRunner(claudeCommand, claudeArgs, {
    cwd: candidateWorkspace,
    timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    onOutput: ({ stream, text }) => {
      if (stream === "stderr") onEvent({
        time: new Date().toISOString(),
        runId,
        event: { type: "delegate_progress", text },
      });
    },
  });
  const stdout = String(processResult.stdout ?? "");
  const stderr = String(processResult.stderr ?? "");
  fs.writeFileSync(streamPath, stdout, { mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });

  const parsed = parseClaudeStreamJson(stdout);
  const finalDiff = captureFinalDiff(candidateWorkspace);
  const candidate = store.capture(candidateWorkspace, {
    parent: baseline.commit,
    message: `BANTAM Claude delegate ${runId} candidate`,
    excludePaths: [path.join(candidateWorkspace, ".bantam")],
  });
  const verification = verify
    ? await verifier(candidateWorkspace, verify, verifyTimeoutMs)
    : null;
  const status = processResult.timedOut ? "timeout"
    : processResult.aborted ? "interrupted"
      : processResult.bufferExceeded ? "output-limit"
        : processResult.error ? "error"
          : processResult.code !== 0 ? "claude-failed"
            : parsed.resultError ? "claude-failed"
              : verification ? verification.status : "unverified";
  const pass = processResult.code === 0
    && !processResult.timedOut
    && !processResult.aborted
    && !processResult.bufferExceeded
    && !parsed.resultError
    && (verification ? verification.pass : true);
  const artifact = {
    schema: 1,
    kind: KIND,
    provider: "claude",
    id: runId,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceWorkspace: source,
    directory,
    storeRoot,
    runtimeWorkspace: candidateWorkspace,
    baseline,
    candidate,
    task: request,
    model: parsed.model ?? selectedModel,
    requestedModel: selectedModel,
    effort: selectedEffort,
    execution: {
      command: claudeCommand,
      args: redactArgs(claudeArgs),
      permissionMode: selectedPermissionMode,
      exitCode: Number.isInteger(processResult.code) ? processResult.code : null,
      signal: processResult.signal ?? null,
      timedOut: Boolean(processResult.timedOut),
      aborted: Boolean(processResult.aborted),
      bufferExceeded: Boolean(processResult.bufferExceeded),
      durationMs: Date.now() - started,
      stderr: stderr.slice(0, 40_000),
      parseErrors: parsed.parseErrors,
    },
    transcript: {
      format: "claude-stream-json",
      streamPath,
      stderrPath,
      bytes: Buffer.byteLength(stdout),
      sha256: sha256(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stderrSha256: sha256(stderr),
      eventCount: parsed.events.length,
      includesPartialMessages: true,
    },
    sessionId: parsed.sessionId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    eventSummary: parsed.eventSummary,
    usage: parsed.usage,
    verification,
    finalDiff,
    result: { status, pass },
  };
  writeJsonAtomic(path.join(directory, "artifact.json"), artifact);
  emit({ type: "delegate_completed", provider: "claude", status, pass, usage: parsed.usage });
  if (ownedRuntime) {
    fs.rmSync(runtime, { recursive: true, force: true });
    artifact.runtimeWorkspace = null;
    writeJsonAtomic(path.join(directory, "artifact.json"), artifact);
  }
  return { artifact, artifactPath: path.join(directory, "artifact.json"), directory };
}

export function buildClaudePrintArgs({ model, effort, task, permissionMode = "acceptEdits", allowedTools = [] }) {
  if (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new TypeError("Claude allowedTools must be an array of non-empty strings");
  }
  return [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--disable-slash-commands",
    // Preserve project instructions while excluding personal/local settings.
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", normalizePermissionMode(permissionMode),
    ...(allowedTools.length ? ["--allowedTools", ...allowedTools] : []),
    "--model", normalizeModel(model),
    "--effort", normalizeEffort(effort),
    requiredString(task, "delegate prompt"),
  ];
}

export function parseClaudeStreamJson(text) {
  const events = [];
  const parseErrors = [];
  let sessionId = null;
  let model = null;
  let finalMessage = "";
  let resultUsage = null;
  let resultTurns = null;
  let resultCostUsd = null;
  let resultError = false;
  const assistantUsage = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  const eventSummary = {
    total: 0, commands: 0, fileChanges: 0, toolUses: 0,
    toolResults: 0, messages: 0, reasoning: 0, errors: 0,
  };

  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let event;
    try { event = JSON.parse(raw); }
    catch {
      parseErrors.push({ line: index + 1, text: raw.slice(0, 500) });
      continue;
    }
    events.push(event);
    eventSummary.total++;
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") model = event.model;
    }
    if (event.type === "assistant") {
      const message = event.message ?? {};
      if (typeof message.model === "string") model = message.model;
      const row = message.usage ?? {};
      assistantUsage.input += number(row.input_tokens);
      assistantUsage.cacheCreate += number(row.cache_creation_input_tokens);
      assistantUsage.cacheRead += number(row.cache_read_input_tokens);
      assistantUsage.output += number(row.output_tokens);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && typeof block.text === "string") {
          eventSummary.messages++;
          finalMessage = block.text;
        } else if (block?.type === "thinking") {
          eventSummary.reasoning++;
        } else if (block?.type === "tool_use") {
          eventSummary.toolUses++;
          if (block.name === "Bash") eventSummary.commands++;
          if (block.name === "Edit" || block.name === "Write" || block.name === "NotebookEdit") {
            eventSummary.fileChanges++;
          }
        }
      }
    }
    if (event.type === "user") {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type === "tool_result") eventSummary.toolResults++;
      }
    }
    if (event.type === "result") {
      if (typeof event.result === "string") finalMessage = event.result;
      if (event.usage && typeof event.usage === "object") resultUsage = event.usage;
      if (Number.isFinite(Number(event.num_turns))) resultTurns = Number(event.num_turns);
      if (Number.isFinite(Number(event.total_cost_usd))) resultCostUsd = Number(event.total_cost_usd);
      resultError = Boolean(event.is_error) || event.subtype === "error";
      if (resultError) eventSummary.errors++;
    }
  }

  const source = resultUsage ?? {
    input_tokens: assistantUsage.input,
    cache_creation_input_tokens: assistantUsage.cacheCreate,
    cache_read_input_tokens: assistantUsage.cacheRead,
    output_tokens: assistantUsage.output,
  };
  const uncached = number(source.input_tokens);
  const cacheCreate = number(source.cache_creation_input_tokens);
  const cacheRead = number(source.cache_read_input_tokens);
  const output = number(source.output_tokens);
  const usage = {
    turns: resultTurns ?? events.filter((event) => event.type === "assistant").length,
    inputTokens: uncached + cacheCreate + cacheRead,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    cacheMissTokens: uncached + cacheCreate,
    outputTokens: output,
    reasoningOutputTokens: null,
    totalTokens: uncached + cacheCreate + cacheRead + output,
    costUsd: resultCostUsd,
  };
  return {
    events, parseErrors, sessionId, model, finalMessage,
    usage, eventSummary, resultError,
  };
}

export function loadClaudeDelegate(fileOrDirectory) {
  const resolved = path.resolve(requiredString(fileOrDirectory, "delegate artifact"));
  const file = fs.statSync(resolved).isDirectory() ? path.join(resolved, "artifact.json") : resolved;
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  requireArtifact(artifact);
  return { artifact, artifactPath: file };
}

export async function applyClaudeDelegate({
  artifactPath,
  workspace = null,
  verificationScript = null,
  timeoutMs = 120_000,
  verifier = defaultVerifier,
} = {}) {
  const { artifact, artifactPath: file } = loadClaudeDelegate(artifactPath);
  const live = path.resolve(workspace ?? artifact.sourceWorkspace);
  if (live !== path.resolve(artifact.sourceWorkspace)) {
    throw new Error("delegate apply workspace does not match its source workspace");
  }
  const verify = optionalString(verificationScript) ?? optionalString(artifact.verification?.command);
  if (!verify) throw new Error("delegate apply requires a verifier");
  const store = new WorkspaceStore(artifact.storeRoot);
  const liveTree = store.treeForWorkspace(live, {
    excludePaths: [path.join(live, ".bantam")],
  }).tree;
  if (liveTree !== artifact.baseline.tree) {
    throw new Error("delegate apply refused: live workspace changed since the baseline");
  }
  if (artifact.candidate.tree === artifact.baseline.tree) {
    throw new Error("delegate apply refused: candidate is byte-identical to the baseline");
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-claude-delegate-apply-${artifact.id}-`));
  try {
    const baselineRoot = path.join(temp, "baseline");
    const candidateRoot = path.join(temp, "candidate");
    store.materialize(artifact.baseline.commit, baselineRoot);
    store.materialize(artifact.candidate.commit, candidateRoot);
    copyRuntimeDependencies(live, candidateRoot);
    const candidateVerification = await verifier(candidateRoot, verify, timeoutMs);
    if (!candidateVerification.pass) {
      throw new Error(`delegate apply refused: candidate verifier ${candidateVerification.status}`);
    }
    const transaction = new WorkspaceTransaction({
      workspace: live,
      baselineRoot,
      candidateRoot,
      transactionRoot: path.join(path.dirname(file), "transactions"),
      id: `apply-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
      metadata: { kind: "claude-delegate-apply", delegateId: artifact.id },
    });
    transaction.prepare();
    transaction.apply();
    try {
      const liveVerification = await verifier(live, verify, timeoutMs);
      if (!liveVerification.pass) throw new Error(`live verifier ${liveVerification.status}`);
      transaction.markVerified(liveVerification);
      transaction.markPromoted({ kind: "operator-selected-claude-delegate" });
      transaction.commit();
      return { artifact: file, workspace: live, verification: liveVerification, transaction: transaction.view() };
    } catch (error) {
      transaction.rollback({ reason: `delegate live verification failed: ${error.message}` });
      throw new Error(`delegate apply rolled back: ${error.message}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function formatClaudeDelegate(artifact) {
  requireArtifact(artifact);
  const u = artifact.usage;
  return [
    `${artifact.model} · ${artifact.effort} · native Claude Code delegate`,
    `status: ${artifact.result.status}${artifact.result.pass ? " (pass)" : ""}`,
    `time: ${formatDuration(artifact.execution.durationMs)} · native turns: ${formatNumber(u.turns)}`,
    `usage: input ${formatNumber(u.inputTokens)} · cache ${formatNumber(u.cachedInputTokens)} hit/${formatNumber(u.cacheMissTokens)} miss · output ${formatNumber(u.outputTokens)} · cost ${formatMoney(u.costUsd)}`,
    `work: ${artifact.eventSummary.commands} commands · ${artifact.eventSummary.fileChanges} file changes · ${artifact.finalDiff.fileCount ?? 0} changed files`,
    `transcript: ${artifact.transcript.eventCount} events · ${artifact.transcript.bytes.toLocaleString("en-US")} bytes · ${artifact.transcript.streamPath}`,
    artifact.verification ? `verifier: ${artifact.verification.status} · ${formatDuration(artifact.verification.durationMs)}` : "verifier: none",
    artifact.finalMessage ? `\n${artifact.finalMessage}` : "",
  ].filter(Boolean).join("\n");
}

async function defaultVerifier(workspace, command, timeoutMs) {
  const started = Date.now();
  const result = await runProcess("/bin/bash", ["-o", "pipefail", "-c", command], {
    cwd: workspace,
    timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const status = result.timedOut ? "timeout"
    : result.aborted ? "interrupted"
      : result.error ? "error"
        : result.code === 0 ? "pass" : "fail";
  return {
    command,
    pass: status === "pass",
    status,
    exitCode: Number.isInteger(result.code) ? result.code : null,
    durationMs: Date.now() - started,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 16_000),
  };
}

function delegatePrompt(task, verifier) {
  return [
    "Work independently as the native Claude Code coding agent in this isolated candidate workspace.",
    "Complete the user's task with the smallest sound change. Inspect the repository, edit files, and run focused tests as needed.",
    "All file paths supplied to editing tools must be relative to the candidate workspace; never use its absolute filesystem path as an edit target.",
    verifier
      ? `Before finishing, run this authoritative verifier and report its result: ${verifier}`
      : "Before finishing, run an appropriate focused verification if the task changes files.",
    "Do not merely describe a proposed patch when the task asks for implementation.",
    "",
    `User task: ${task}`,
  ].join("\n");
}

function copyRuntimeDependencies(source, destination) {
  const from = path.join(source, "node_modules");
  const to = path.join(destination, "node_modules");
  if (isRealDirectory(from) && !fs.existsSync(to)) {
    fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
  }
}

function isRealDirectory(value) {
  try {
    const stat = fs.lstatSync(value);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function redactArgs(args) {
  const copy = [...args];
  if (copy.length) copy[copy.length - 1] = "[TASK PROMPT RECORDED IN artifact.task]";
  return copy;
}

function requireArtifact(value) {
  if (!value || value.schema !== 1 || value.kind !== KIND || typeof value.id !== "string") {
    throw new Error("invalid Claude delegate artifact");
  }
}

function normalizeModel(value) {
  const model = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9._:-]+$/.test(model)) throw new Error(`invalid Claude delegate model: ${value}`);
  return model;
}

function normalizeEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!EFFORTS.has(effort)) throw new Error(`invalid Claude delegate effort: ${value}`);
  return effort;
}

function normalizePermissionMode(value) {
  const mode = String(value ?? "").trim();
  if (mode !== "acceptEdits" && mode !== "auto") {
    throw new Error(`invalid Claude delegate permission mode: ${value}; use acceptEdits or auto`);
  }
  return mode;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireDirectory(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function delegateId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(6).toString("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : "n/a";
}

function formatMoney(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(4)}` : "n/a";
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms ?? 0)) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
