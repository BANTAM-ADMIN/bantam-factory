// Native Codex delegation.
//
// This is intentionally separate from BANTAM's constrained Codex transport.
// A delegate owns its complete agent/tool loop inside an external materialized
// workspace. BANTAM owns the immutable baseline, final evidence, verification,
// and the only path that can apply candidate bytes to the live checkout.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";
import { captureFinalDiff, prepareDiffBaseline } from "./diff.js";
import { runProcess } from "./process-runner.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceTransaction } from "./workspace-transaction.js";
import { runPreviewSync } from "./logic/preview.js";

const KIND = "bantam-codex-delegate";
const MODELS = Object.freeze({
  astra: "gpt-6-astra",
  "codex-astra": "gpt-6-astra",
  "gpt-6-astra": "gpt-6-astra",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
});
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export async function runCodexDelegate({
  workspace,
  task,
  model = "gpt-5.6-sol",
  effort = "high",
  verificationScript = null,
  visualReview = false,
  bypassSandbox = false,
  timeoutMs = 900_000,
  verifyTimeoutMs = 120_000,
  stateRoot = null,
  runtimeRoot = null,
  id = null,
  codexCommand = "codex",
  processRunner = runProcess,
  verifier = defaultVerifier,
  previewRunner = runPreviewSync,
  onEvent = () => {},
} = {}) {
  const source = requireDirectory(workspace, "delegate workspace");
  const request = requiredString(task, "delegate task");
  const selectedModel = normalizeModel(model);
  const selectedEffort = normalizeEffort(effort);
  const verify = optionalString(verificationScript);
  const root = path.resolve(stateRoot ?? path.join(source, ".bantam", "delegates"));
  const runId = id ?? delegateId();
  const directory = path.join(root, runId);
  if (fs.existsSync(directory)) throw new Error(`delegate run already exists: ${runId}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const storeRoot = path.join(root, "_workspace-store");
  const store = new WorkspaceStore(storeRoot);
  const baseline = store.capture(source, {
    message: `BANTAM delegate ${runId} baseline`,
    excludePaths: [path.join(source, ".bantam"), root],
  });
  const ownedRuntime = runtimeRoot === null;
  const runtime = ownedRuntime
    ? fs.mkdtempSync(path.join(os.tmpdir(), `bantam-delegate-${runId}-`))
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
  const streamPath = path.join(directory, "codex-stream.jsonl");
  const stderrPath = path.join(directory, "codex-stderr.log");
  const emit = (event) => {
    const record = { time: new Date().toISOString(), runId, event };
    fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    onEvent(record);
  };
  const codexArgs = buildCodexExecArgs({
    model: selectedModel,
    effort: selectedEffort,
    workspace: candidateWorkspace,
    task: delegatePrompt(request, verify),
    bypassSandbox,
  });
  emit({ type: "delegate_started", model: selectedModel, effort: selectedEffort });
  const processResult = await processRunner(codexCommand, codexArgs, {
    cwd: candidateWorkspace,
    timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    onOutput: ({ stream, text }) => {
      if (stream === "stderr") onEvent({ time: new Date().toISOString(), runId, event: {
        type: "delegate_progress",
        text,
      } });
    },
  });
  // A native turn can exhaust its wall clock after it has already written a
  // complete candidate (for example while narrating a final self-check). For a
  // visual-review run, a fresh authoritative verifier may safely establish
  // that this partial trajectory produced a reviewable page. The second native
  // pass then becomes the completion authority; ordinary delegate runs retain
  // the stricter primary-turn requirement.
  const buildVerification = visualReview && !processSucceeded(processResult) && verify
    ? await verifier(candidateWorkspace, verify, verifyTimeoutMs)
    : null;
  let visualPass = null;
  if (visualReview && (processSucceeded(processResult) || buildVerification?.pass)) {
    try {
      const preview = previewRunner(candidateWorkspace, undefined, { interact: true });
      if (preview.screenshot && fs.existsSync(preview.screenshot)) {
        emit({ type: "delegate_visual_review_started" });
        const visualResult = await processRunner(codexCommand, buildCodexExecArgs({
          model: selectedModel,
          effort: selectedEffort,
          workspace: candidateWorkspace,
          images: [preview.screenshot],
          task: visualDirectorPrompt(request, verify),
          bypassSandbox,
        }), {
          cwd: candidateWorkspace,
          timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          onOutput: ({ stream, text }) => {
            if (stream === "stderr") onEvent({ time: new Date().toISOString(), runId, event: {
              type: "delegate_progress", text,
            } });
          },
        });
        visualPass = {
          screenshotCaptured: true,
          previewStatus: preview.previewStatus,
          recoveredFromBuildTimeout: Boolean(buildVerification?.pass),
          process: compactProcess(visualResult),
        };
        processResult.stdout = `${processResult.stdout || ""}\n${visualResult.stdout || ""}`;
        processResult.stderr = `${processResult.stderr || ""}\n${visualResult.stderr || ""}`;
        if (!processSucceeded(visualResult)) processResult.code = visualResult.code || 1;
      } else visualPass = { screenshotCaptured: false, reason: "preview returned no screenshot" };
    } catch (error) {
      visualPass = { screenshotCaptured: false, reason: String(error.message || error).slice(0, 500) };
    }
  }
  const stdout = String(processResult.stdout ?? "");
  const stderr = String(processResult.stderr ?? "");
  fs.writeFileSync(streamPath, stdout, { mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });
  const parsed = parseCodexJsonl(stdout);
  const finalDiff = captureFinalDiff(candidateWorkspace);
  const candidate = store.capture(candidateWorkspace, {
    parent: baseline.commit,
    message: `BANTAM delegate ${runId} candidate`,
    excludePaths: [path.join(candidateWorkspace, ".bantam")],
  });
  const verification = verify
    ? await verifier(candidateWorkspace, verify, verifyTimeoutMs)
    : null;
  const recoveredVisualPass = Boolean(
    buildVerification?.pass
    && visualPass?.screenshotCaptured
    && visualPass?.process?.exitCode === 0
    && !visualPass?.process?.timedOut
    && !visualPass?.process?.aborted
    && (verification ? verification.pass : true),
  );
  const status = recoveredVisualPass ? "pass"
    : processResult.timedOut ? "timeout"
    : processResult.aborted ? "interrupted"
      : processResult.bufferExceeded ? "output-limit"
        : processResult.error ? "error"
          : processResult.code !== 0 ? "codex-failed"
            : verification ? verification.status : "unverified";
  const pass = recoveredVisualPass || (processResult.code === 0
    && !processResult.timedOut
    && !processResult.aborted
    && !processResult.bufferExceeded
    && (verification ? verification.pass : true));
  const artifact = {
    schema: 1,
    kind: KIND,
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
    model: selectedModel,
    effort: selectedEffort,
    execution: {
      command: codexCommand,
      args: redactArgs(codexArgs),
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
      format: "codex-jsonl",
      streamPath,
      stderrPath,
      bytes: Buffer.byteLength(stdout),
      sha256: sha256(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stderrSha256: sha256(stderr),
      eventCount: parsed.events.length,
    },
    visualReview: visualPass,
    threadId: parsed.threadId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    eventSummary: parsed.eventSummary,
    usage: parsed.usage,
    verification,
    finalDiff,
    result: { status, pass },
  };
  writeJsonAtomic(path.join(directory, "artifact.json"), artifact);
  emit({ type: "delegate_completed", status, pass, usage: parsed.usage });
  if (ownedRuntime) {
    // Candidate bytes remain durable in WorkspaceStore. Do not retain a second
    // executable checkout full of dependencies and model-generated files.
    fs.rmSync(runtime, { recursive: true, force: true });
    artifact.runtimeWorkspace = null;
    writeJsonAtomic(path.join(directory, "artifact.json"), artifact);
  }
  return { artifact, artifactPath: path.join(directory, "artifact.json"), directory };
}

export function buildCodexExecArgs({ model, effort, workspace, task, images = [], bypassSandbox = false }) {
  return [
    ...(bypassSandbox ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    "exec",
    "--json",
    "--ephemeral",
    // Reuse native Codex authentication but not the operator's personal MCP,
    // plugin, hook, model, or sandbox configuration. Delegate experiments must
    // be reproducible and must not silently widen their execution surface.
    "--ignore-user-config",
    ...(bypassSandbox ? [] : ["--sandbox", "workspace-write"]),
    "--skip-git-repo-check",
    "--model", normalizeModel(model),
    "--config", `model_reasoning_effort="${normalizeEffort(effort)}"`,
    "--cd", path.resolve(workspace),
    ...images.flatMap((image) => ["--image", path.resolve(image)]),
    // Codex accepts one or more values for --image. The delimiter keeps the
    // task from being parsed as one more image path when a visual review is
    // attached.
    ...(images.length > 0 ? ["--"] : []),
    requiredString(task, "delegate prompt"),
  ];
}

function processSucceeded(result) {
  return result && result.code === 0 && !result.timedOut && !result.aborted && !result.bufferExceeded && !result.error;
}

function compactProcess(result) {
  return {
    exitCode: Number.isInteger(result?.code) ? result.code : null,
    timedOut: Boolean(result?.timedOut),
    aborted: Boolean(result?.aborted),
    bufferExceeded: Boolean(result?.bufferExceeded),
  };
}

function visualDirectorPrompt(task, verifier) {
  return `You are reviewing the current browser game after its first implementation. The attached image is its actual rendered opening frame. Act as a visual director and senior front-end engineer: inspect the screenshot and current source, then improve the page in place where needed. Preserve the task contract, but prioritize a deliberate focal subject, readable silhouette, depth across foreground/midground/background, coherent palette, restraint in HUD decoration, and a scene that feels authored rather than a checklist of named objects. Do not merely describe issues: edit the implementation, rerender if useful, and run the verifier before finishing.${verifier ? `\n\nAuthoritative verifier: ${verifier}` : ""}\n\nOriginal task: ${task}`;
}

export function parseCodexJsonl(text) {
  const events = [];
  const parseErrors = [];
  let threadId = null;
  let finalMessage = "";
  const usage = {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  const eventSummary = { total: 0, commands: 0, fileChanges: 0, messages: 0, reasoning: 0, errors: 0 };
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
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (event.type === "turn.completed") {
      usage.turns++;
      const row = event.usage ?? {};
      usage.inputTokens += number(row.input_tokens);
      usage.cachedInputTokens += number(row.cached_input_tokens);
      usage.outputTokens += number(row.output_tokens);
      usage.reasoningOutputTokens += number(row.reasoning_output_tokens);
    }
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "agent_message") {
      eventSummary.messages++;
      if (typeof item.text === "string") finalMessage = item.text;
    }
    if (item?.type === "command_execution" && event.type === "item.completed") eventSummary.commands++;
    if (item?.type === "file_change" && event.type === "item.completed") eventSummary.fileChanges++;
    if (item?.type === "reasoning" && event.type === "item.completed") eventSummary.reasoning++;
    if (event.type === "error" || event.type === "turn.failed") eventSummary.errors++;
  }
  usage.cacheMissTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { events, parseErrors, threadId, finalMessage, usage, eventSummary };
}

export function loadCodexDelegate(fileOrDirectory) {
  const resolved = path.resolve(requiredString(fileOrDirectory, "delegate artifact"));
  const file = fs.statSync(resolved).isDirectory() ? path.join(resolved, "artifact.json") : resolved;
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  requireArtifact(artifact);
  return { artifact, artifactPath: file };
}

export async function applyCodexDelegate({
  artifactPath,
  workspace = null,
  verificationScript = null,
  timeoutMs = 120_000,
  verifier = defaultVerifier,
} = {}) {
  const { artifact, artifactPath: file } = loadCodexDelegate(artifactPath);
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `bantam-delegate-apply-${artifact.id}-`));
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
      metadata: { kind: "codex-delegate-apply", delegateId: artifact.id },
    });
    transaction.prepare();
    transaction.apply();
    try {
      const liveVerification = await verifier(live, verify, timeoutMs);
      if (!liveVerification.pass) throw new Error(`live verifier ${liveVerification.status}`);
      transaction.markVerified(liveVerification);
      transaction.markPromoted({ kind: "operator-selected-codex-delegate" });
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

export function formatCodexDelegate(artifact) {
  requireArtifact(artifact);
  const u = artifact.usage;
  return [
    `${artifact.model} · ${artifact.effort} · native Codex delegate`,
    `status: ${artifact.result.status}${artifact.result.pass ? " (pass)" : ""}`,
    `time: ${formatDuration(artifact.execution.durationMs)} · native turns: ${u.turns}`,
    `usage: input ${formatNumber(u.inputTokens)} · cache ${formatNumber(u.cachedInputTokens)} hit/${formatNumber(u.cacheMissTokens)} miss · output ${formatNumber(u.outputTokens)} · reasoning ${formatNumber(u.reasoningOutputTokens)}`,
    `work: ${artifact.eventSummary.commands} commands · ${artifact.eventSummary.fileChanges} file changes · ${artifact.finalDiff.fileCount ?? 0} changed files`,
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
    "Work independently as the native Codex coding agent in this isolated candidate workspace.",
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
    throw new Error("invalid Codex delegate artifact");
  }
}

function normalizeModel(value) {
  const key = String(value ?? "").trim().toLowerCase();
  const model = MODELS[key];
  if (!model) throw new Error(`unsupported delegate model: ${value}; use sol, terra, or astra`);
  return model;
}

function normalizeEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!EFFORTS.has(effort)) throw new Error(`invalid delegate reasoning effort: ${value}`);
  return effort;
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

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms ?? 0)) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
