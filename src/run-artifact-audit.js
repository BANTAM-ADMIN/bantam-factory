// Read-only, model-free integrity audit for a complete BANTAM run artifact.
//
// The auditor deliberately does not import or execute anything from the task
// workspace. It validates durable evidence: attachment bytes, normalized tool
// envelopes, usage attribution arithmetic, and Codex prompt delivery.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { auditCodexPromptDelivery } from "./codex-artifact-audit.js";
import { changedFilesFromDiff, hashText } from "./diff.js";
import { fixtureEvaluatorRoot } from "./fixture-provenance.js";

const TOOL_STATUSES = new Set(["pass", "partial", "failed", "blocked", "error"]);
const USAGE_FIELDS = Object.freeze([
  "requests",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheHitTokens",
  "cacheMissTokens",
  "reasoningTokens",
  "costUsd",
  "codexRequests",
]);
const MAX_FAILURES = 64;

export function auditRunArtifact(artifact, { artifactPath = null } = {}) {
  const failures = [];
  const warnings = [];
  const fail = (check, code, message, detail = {}) => {
    if (failures.length < MAX_FAILURES) failures.push({ check, code, message, ...detail });
  };
  const warn = (check, code, message) => warnings.push({ check, code, message });
  const checks = {};

  checks.identity = auditIdentity(artifact, fail);
  checks.toolOutcomes = auditToolOutcomes(artifact, fail, warn);
  checks.usage = auditUsage(artifact, fail, warn);
  checks.attachments = auditAttachments(artifact, artifactPath, fail, warn);
  checks.finalDiff = auditFinalDiff(artifact, fail, warn);

  const prompt = auditCodexPromptDelivery(artifact);
  checks.codexPrompt = {
    status: prompt.status,
    calls: prompt.calls,
    auditedCalls: prompt.auditedCalls,
    exactCalls: prompt.exactCalls,
  };
  for (const item of prompt.failures) {
    fail("codexPrompt", item.code, item.message, { callIndex: item.callIndex });
  }

  return {
    schema: 1,
    status: failures.length ? "fail" : "pass",
    artifactPath: artifactPath ? path.resolve(artifactPath) : null,
    runId: typeof artifact?.runId === "string" ? artifact.runId : null,
    checks,
    failures,
    warnings,
  };
}

export function auditRunArtifactFile(filePath) {
  const resolved = path.resolve(filePath);
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    return {
      schema: 1,
      status: "fail",
      artifactPath: resolved,
      runId: null,
      checks: {},
      failures: [{
        check: "artifact",
        code: "unreadable",
        message: String(error?.message ?? error).slice(0, 500),
      }],
      warnings: [],
    };
  }
  return auditRunArtifact(artifact, { artifactPath: resolved });
}

export function formatRunArtifactAudit(report) {
  const labels = Object.entries(report.checks ?? {})
    .map(([name, check]) => `${name}=${check.status}`)
    .join(" ");
  const lines = [
    `${String(report.status).toUpperCase()}  ${report.artifactPath ?? "<memory>"}${labels ? `  ${labels}` : ""}`,
  ];
  for (const failure of report.failures ?? []) {
    lines.push(`  [${failure.check}/${failure.code}] ${failure.message}`);
  }
  for (const warning of report.warnings ?? []) {
    lines.push(`  warning [${warning.check}/${warning.code}] ${warning.message}`);
  }
  return lines.join("\n");
}

function auditIdentity(artifact, fail) {
  let valid = true;
  const reject = (code, message) => {
    valid = false;
    fail("identity", code, message);
  };
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    reject("shape", "artifact must be an object");
    return { status: "fail" };
  }
  if (!Number.isInteger(artifact.schema) || artifact.schema < 1) {
    reject("schema", "artifact schema must be a positive integer");
  }
  if (artifact.kind !== "bantam-run") reject("kind", 'artifact kind must be "bantam-run"');
  if (typeof artifact.runId !== "string" || !artifact.runId) reject("run_id", "runId is missing");
  if (!Array.isArray(artifact.turns)) reject("turns", "turns must be an array");
  if (!artifact.metrics || typeof artifact.metrics !== "object") reject("metrics", "metrics are missing");
  if (artifact.fixtureProvenance !== undefined) {
    const expected = fixtureEvaluatorRoot(artifact.fixtureProvenance);
    if (!expected) {
      reject("fixture_provenance_shape", "fixture provenance is malformed");
    } else if (expected !== artifact.fixtureProvenance.evaluatorSha256) {
      reject("fixture_provenance_hash", "fixture evaluator root does not match its components");
    }
  }
  return { status: valid ? "pass" : "fail" };
}

function auditToolOutcomes(artifact, fail, warn) {
  if (!Array.isArray(artifact?.turns)) return { status: "fail", outcomes: 0 };
  const turnsWithOutcome = artifact.turns.filter((turn) => turn?.toolOutcome !== undefined);
  const storedCounts = artifact?.metrics?.toolOutcomeCounts;
  if (!turnsWithOutcome.length && storedCounts === undefined) {
    warn("toolOutcomes", "legacy_missing", "artifact predates normalized tool outcome evidence");
    return { status: "not-applicable", outcomes: 0 };
  }
  const counts = {};
  const toolUsageBySource = {};
  let valid = true;
  for (const [position, turn] of artifact.turns.entries()) {
    if (turn?.toolOutcome === undefined) continue;
    const outcome = turn.toolOutcome;
    const reject = (code, message) => {
      valid = false;
      fail("toolOutcomes", code, message, { turn: turn.i ?? position });
    };
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      reject("shape", "tool outcome must be an object");
      continue;
    }
    if (outcome.schema !== 1) reject("schema", "tool outcome schema must be 1");
    if (!TOOL_STATUSES.has(outcome.status)) reject("status", `invalid tool outcome status ${String(outcome.status)}`);
    if (turn.queryTool != null && outcome.tool !== turn.queryTool) {
      reject("tool_mismatch", `outcome tool ${String(outcome.tool)} does not match routed tool ${turn.queryTool}`);
    }
    if (outcome.status === "blocked" && (!outcome.blocked || typeof outcome.blocked !== "object")) {
      reject("blocked_evidence", "blocked outcome has no blocked evidence");
    }
    if (typeof outcome.terminal !== "boolean") reject("terminal", "tool outcome terminal must be boolean");
    if (outcome.blocked && typeof outcome.blocked === "object"
        && typeof outcome.blocked.terminal === "boolean"
        && outcome.blocked.terminal !== outcome.terminal) {
      reject("terminal_mismatch", "tool outcome terminal disagrees with blocked evidence");
    }
    if (outcome.retryable !== null && typeof outcome.retryable !== "boolean") {
      reject("retryable", "tool outcome retryable must be boolean or null");
    }
    if (!Array.isArray(outcome.artifacts) || !Array.isArray(outcome.failures)) {
      reject("arrays", "tool outcome artifacts and failures must be arrays");
    }
    if (outcome.usage != null) {
      const source = outcome?.details?.usageSource;
      if (!isRecord(outcome.usage)) {
        reject("usage_shape", "tool outcome usage must be an object or null");
      } else if (typeof source !== "string" || !/^[a-z][a-z0-9_]*$/.test(source)) {
        reject("usage_source", "tool outcome usage requires a normalized details.usageSource");
      } else {
        const total = toolUsageBySource[source]
          ?? Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
        for (const field of USAGE_FIELDS) {
          const value = outcome.usage[field];
          if (!Number.isFinite(value) || value < 0) {
            reject("usage_value", `tool outcome usage.${field} must be a nonnegative finite number`);
          } else {
            total[field] += value;
          }
        }
        toolUsageBySource[source] = total;
      }
    }
    if (TOOL_STATUSES.has(outcome.status)) {
      counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    }
  }
  if (!storedCounts || typeof storedCounts !== "object" || Array.isArray(storedCounts)) {
    valid = false;
    fail("toolOutcomes", "counts_missing", "aggregate tool outcome counts are missing");
  } else {
    for (const [status, count] of Object.entries(storedCounts)) {
      if (!TOOL_STATUSES.has(status) || !Number.isSafeInteger(count) || count < 0) {
        valid = false;
        fail("toolOutcomes", "counts_shape", `invalid aggregate tool outcome count ${status}=${String(count)}`);
      }
    }
    if (!sameCountMap(counts, storedCounts)) {
      valid = false;
      fail(
        "toolOutcomes",
        "counts_mismatch",
        `aggregate counts ${JSON.stringify(storedCounts)} do not match turns ${JSON.stringify(counts)}`,
      );
    }
  }
  for (const [source, usage] of Object.entries(toolUsageBySource)) {
    const sourceTotal = artifact?.metrics?.usageBySource?.[source];
    if (!isRecord(sourceTotal)) {
      valid = false;
      fail("toolOutcomes", "usage_source_missing", `tool usage source ${source} is absent from run accounting`);
      continue;
    }
    for (const field of USAGE_FIELDS) {
      if (!numbersEqual(usage[field], sourceTotal[field])) {
        valid = false;
        fail(
          "toolOutcomes",
          "usage_mismatch",
          `${source}.${field}: tool outcomes sum to ${usage[field]}, source accounting is ${String(sourceTotal[field])}`,
        );
      }
    }
  }
  return {
    status: valid ? "pass" : "fail",
    outcomes: turnsWithOutcome.length,
    counts,
    usageSources: Object.keys(toolUsageBySource).length,
  };
}

function auditUsage(artifact, fail, warn) {
  const aggregate = artifact?.metrics?.usage;
  const bySource = artifact?.metrics?.usageBySource;
  if (aggregate == null) {
    warn("usage", "legacy_missing", "artifact has no aggregate usage snapshot to reconcile");
    return { status: "not-applicable", sources: objectSize(bySource) };
  }
  let valid = true;
  if (!isRecord(aggregate)) {
    fail("usage", "aggregate_shape", "aggregate usage must be an object");
    return { status: "fail", sources: objectSize(bySource) };
  }
  if (!isRecord(bySource)) {
    fail("usage", "sources_shape", "usageBySource must be an object");
    return { status: "fail", sources: 0 };
  }
  const sums = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  for (const [source, usage] of Object.entries(bySource)) {
    if (!/^[a-z][a-z0-9_]*$/.test(source) || !isRecord(usage)) {
      valid = false;
      fail("usage", "source_shape", `invalid usage source ${source}`);
      continue;
    }
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (!Number.isFinite(value) || value < 0) {
        valid = false;
        fail("usage", "source_value", `${source}.${field} must be a nonnegative finite number`);
      } else {
        sums[field] += value;
      }
    }
  }
  for (const field of USAGE_FIELDS) {
    const expected = aggregate[field];
    if (!Number.isFinite(expected) || expected < 0) {
      valid = false;
      fail("usage", "aggregate_value", `usage.${field} must be a nonnegative finite number`);
    } else if (!numbersEqual(sums[field], expected)) {
      valid = false;
      fail("usage", "reconciliation", `${field}: sources sum to ${sums[field]}, aggregate is ${expected}`);
    }
  }
  return { status: valid ? "pass" : "fail", sources: Object.keys(bySource).length, sums };
}

function auditAttachments(artifact, artifactPath, fail, warn) {
  const attachments = artifact?.attachments;
  if (attachments === undefined) {
    warn("attachments", "missing", "artifact has no attachment archival evidence");
    return { status: "not-applicable", files: 0, bytes: 0 };
  }
  if (!artifactPath) {
    warn("attachments", "path_required", "attachment bytes require an artifact file path");
    return { status: "not-applicable", files: attachments?.files?.length ?? 0, bytes: 0 };
  }
  if (!isRecord(attachments) || !Array.isArray(attachments.files)) {
    fail("attachments", "shape", "attachment metadata is malformed");
    return { status: "fail", files: 0, bytes: 0 };
  }
  let valid = true;
  let bytes = 0;
  const root = path.dirname(path.resolve(artifactPath));
  if (attachments.schema !== 1) {
    valid = false;
    fail("attachments", "schema", "attachment schema must be 1");
  }
  if (!["captured", "partial", "none", "error"].includes(attachments.status)) {
    valid = false;
    fail("attachments", "status", `invalid attachment status ${String(attachments.status)}`);
  }
  if (!Array.isArray(attachments.omitted)) {
    valid = false;
    fail("attachments", "omitted", "attachment omissions must be an array");
  }
  if (!Number.isSafeInteger(attachments.totalBytes) || attachments.totalBytes < 0) {
    valid = false;
    fail("attachments", "total_bytes_shape", "attachment totalBytes must be a nonnegative safe integer");
  }
  if (attachments.status === "none" && attachments.files.length !== 0) {
    valid = false;
    fail("attachments", "status_files", "none status cannot contain archived files");
  }
  if (["captured", "partial"].includes(attachments.status) && attachments.files.length === 0) {
    valid = false;
    fail("attachments", "status_files", `${attachments.status} status requires an archived file`);
  }
  if (attachments.files.length > 0 && attachments.indexPath == null) {
    valid = false;
    fail("attachments", "index_missing", "archived files require an attachment index");
  }
  const seenPaths = new Set();
  for (const [index, item] of attachments.files.entries()) {
    if (!isRecord(item) || !safeRelative(item.path) || !safeRelative(item.sourcePath)) {
      valid = false;
      fail("attachments", "path", `attachment ${index} has an unsafe source or archive path`);
      continue;
    }
    if (seenPaths.has(item.path)) {
      valid = false;
      fail("attachments", "duplicate_path", `attachment ${index} repeats archive path ${item.path}`);
    }
    seenPaths.add(item.path);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      valid = false;
      fail("attachments", "bytes_shape", `attachment ${index} bytes must be a nonnegative safe integer`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(item.sha256 ?? ""))) {
      valid = false;
      fail("attachments", "sha256_shape", `attachment ${index} SHA-256 is malformed`);
    }
    const resolved = path.resolve(root, item.path);
    if (!inside(root, resolved)) {
      valid = false;
      fail("attachments", "escape", `attachment ${index} escapes the artifact directory`);
      continue;
    }
    let data;
    try {
      data = readRegularNoSymlinks(root, item.path);
    } catch (error) {
      valid = false;
      fail("attachments", "unreadable", `attachment ${index}: ${String(error?.message ?? error)}`);
      continue;
    }
    bytes += data.length;
    if (item.bytes !== data.length) {
      valid = false;
      fail("attachments", "bytes", `attachment ${index} records ${item.bytes} bytes but contains ${data.length}`);
    }
    const digest = sha256(data);
    if (item.sha256 !== digest) {
      valid = false;
      fail("attachments", "sha256", `attachment ${index} SHA-256 mismatch`);
    }
  }
  if (attachments.totalBytes !== bytes) {
    valid = false;
    fail("attachments", "total_bytes", `attachments total ${attachments.totalBytes} does not match ${bytes}`);
  }
  if (attachments.indexPath != null) {
    if (!safeRelative(attachments.indexPath)) {
      valid = false;
      fail("attachments", "index_path", "attachment index path is unsafe");
    } else {
      try {
        const index = JSON.parse(readRegularNoSymlinks(root, attachments.indexPath).toString("utf8"));
        if (JSON.stringify(index) !== JSON.stringify(attachments)) {
          valid = false;
          fail("attachments", "index_mismatch", "attachment index does not match artifact metadata");
        }
      } catch (error) {
        valid = false;
        fail("attachments", "index_unreadable", String(error?.message ?? error));
      }
    }
  }
  return { status: valid ? "pass" : "fail", files: attachments.files.length, bytes };
}

function auditFinalDiff(artifact, fail, warn) {
  const diff = artifact?.finalDiff;
  if (diff == null) {
    warn("finalDiff", "missing", "artifact has no final workspace diff evidence");
    return { status: "not-applicable", files: 0 };
  }
  if (!isRecord(diff)) {
    fail("finalDiff", "shape", "finalDiff must be an object or null");
    return { status: "fail", files: 0 };
  }
  if (diff.status !== "captured") {
    warn("finalDiff", "unavailable", `final diff was not captured: ${String(diff.reason ?? diff.status)}`);
    return { status: "not-applicable", files: 0 };
  }
  let valid = true;
  const reject = (code, message) => {
    valid = false;
    fail("finalDiff", code, message);
  };
  if (diff.format !== "git-unified-diff") reject("format", `unsupported final diff format ${String(diff.format)}`);
  if (typeof diff.text !== "string") {
    reject("text", "captured final diff has no text");
    return { status: "fail", files: 0 };
  }
  if (diff.truncated === true) {
    if (!Number.isSafeInteger(diff.bytes) || diff.bytes < Buffer.byteLength(diff.text, "utf8")) {
      reject("bytes", "truncated diff byte count is inconsistent with retained text");
    }
    if (!/^[a-f0-9]{64}$/.test(String(diff.sha256 ?? ""))) {
      reject("sha256_shape", "truncated diff SHA-256 is malformed");
    }
    warn(
      "finalDiff",
      "truncated",
      "full diff was truncated before persistence; its pre-truncation hash cannot be independently recomputed",
    );
    return { status: valid ? "partial" : "fail", files: Array.isArray(diff.files) ? diff.files.length : 0 };
  }
  if (diff.truncated !== false) reject("truncated", "captured final diff truncated flag must be boolean");
  const bytes = Buffer.byteLength(diff.text, "utf8");
  if (diff.bytes !== bytes) reject("bytes", `final diff records ${String(diff.bytes)} bytes but contains ${bytes}`);
  if (diff.sha256 !== hashText(diff.text)) reject("sha256", "final diff SHA-256 mismatch");
  const files = changedFilesFromDiff(diff.text);
  if (!Array.isArray(diff.files) || JSON.stringify(diff.files) !== JSON.stringify(files)) {
    reject("files", "final diff file list does not match diff text");
  }
  if (diff.fileCount !== files.length) {
    reject("file_count", `final diff fileCount ${String(diff.fileCount)} does not match ${files.length}`);
  }
  return { status: valid ? "pass" : "fail", files: files.length, bytes };
}

function readRegularNoSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${relative}`);
  }
  const descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`not a regular file: ${relative}`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) return false;
  return !value.split(/[\\/]/).some((part) => !part || part === ".." || part === ".");
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectSize(value) {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function sameCountMap(actual, stored) {
  const clean = (value) => Object.fromEntries(Object.entries(value)
    .filter(([, count]) => Number(count) !== 0)
    .sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(clean(actual)) === JSON.stringify(clean(stored));
}

function numbersEqual(a, b) {
  return Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9);
}
