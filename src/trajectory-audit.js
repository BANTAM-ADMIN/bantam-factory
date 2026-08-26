// Model-free audit of every request/response or native CLI event stream in an
// experiment. Findings are hypotheses with evidence references; they are never
// promoted into runtime policy merely because one teacher produced them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { turnEditApplied } from "./edit-actions.js";
import { buildContextFlightRecorder } from "./context-flight-recorder.js";

export function auditExperimentTrajectories({ outputDir, manifest } = {}) {
  const root = path.resolve(outputDir);
  const runs = [];
  for (const entry of manifest?.schedule ?? []) {
    for (const row of entry.runs ?? []) {
      if (!row.artifactPath) continue;
      const artifactPath = path.resolve(root, row.artifactPath);
      runs.push(auditArtifact({ artifactPath, arm: entry.arm, round: entry.round, fixture: row.name }));
    }
  }
  const hypotheses = deriveHypotheses(runs);
  const issues = runs.reduce((sum, run) => sum + run.issues.length, 0);
  return {
    schema: 1,
    kind: "bantam-trajectory-audit",
    experimentId: manifest?.id ?? null,
    generatedAt: new Date().toISOString(),
    status: runs.some((run) => run.logIntegrity === "fail") ? "fail" : issues ? "findings" : "clean",
    artifactsAudited: runs.length,
    issues,
    runs,
    hypotheses,
    boundary: "Trajectory findings are candidate explanations, not promoted Datalog rules. Require recurrence or a preregistered replay before runtime actuation.",
  };
}

export function writeExperimentTrajectoryAudit(outputDir, manifest) {
  const report = auditExperimentTrajectories({ outputDir, manifest });
  const jsonPath = path.join(path.resolve(outputDir), "trajectory-audit.json");
  const markdownPath = path.join(path.resolve(outputDir), "trajectory-audit.md");
  writeJsonAtomic(jsonPath, report);
  writeTextAtomic(markdownPath, formatTrajectoryAudit(report));
  return {
    status: report.status,
    artifactsAudited: report.artifactsAudited,
    issues: report.issues,
    hypotheses: report.hypotheses.length,
    jsonPath: relative(outputDir, jsonPath),
    markdownPath: relative(outputDir, markdownPath),
  };
}

export function formatTrajectoryAudit(report) {
  const lines = [
    "# Experiment trajectory audit",
    "",
    `Status: ${report.status}`,
    `Artifacts audited: ${report.artifactsAudited}`,
    `Issues: ${report.issues}`,
    "",
    "## Full-log integrity and behavior",
    "",
    "| Arm | Fixture | Log | Requests/events | Actions/tools | Findings |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const run of report.runs) {
    lines.push(`| ${escapeCell(run.arm)} | ${escapeCell(run.fixture)} | ${run.logIntegrity} | ${run.records} | ${run.actions.length} | ${escapeCell(run.issues.map((issue) => issue.code).join(", ") || "none")} |`);
  }
  lines.push("", "## Candidate logic", "");
  if (!report.hypotheses.length) lines.push("No candidate rule emerged from this cohort.");
  for (const hypothesis of report.hypotheses) {
    lines.push(
      `### ${hypothesis.id}`,
      "",
      hypothesis.statement,
      "",
      `Evidence: ${hypothesis.evidence.join(", ")}`,
      "",
      "```prolog",
      ...hypothesis.facts,
      "```",
      "",
      `Status: ${hypothesis.status}`,
      "",
    );
  }
  lines.push("", `Boundary: ${report.boundary}`, "");
  return lines.join("\n");
}

function auditArtifact({ artifactPath, arm, round, fixture }) {
  if (!fs.statSync(artifactPath, { throwIfNoEntry: false })?.isFile()) {
    return base({ arm, round, fixture, artifactPath, kind: "missing", logIntegrity: "fail", issues: [
      issue("artifact-missing", "Scheduled row points to a missing artifact."),
    ] });
  }
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")); }
  catch (error) {
    return base({ arm, round, fixture, artifactPath, kind: "invalid", logIntegrity: "fail", issues: [
      issue("artifact-invalid", error.message),
    ] });
  }
  if (artifact.kind === "bantam-run") return auditBantamRun({ artifact, artifactPath, arm, round, fixture });
  if (artifact.kind === "bantam-codex-delegate" || artifact.kind === "bantam-claude-delegate") {
    return auditNativeRun({ artifact, artifactPath, arm, round, fixture });
  }
  return base({ arm, round, fixture, artifactPath, kind: artifact.kind ?? "unknown", logIntegrity: "fail", issues: [
    issue("artifact-kind-unsupported", `Unsupported artifact kind: ${artifact.kind ?? "missing"}`),
  ] });
}

function auditBantamRun({ artifact, artifactPath, arm, round, fixture }) {
  const calls = artifact.modelCalls ?? [];
  const turns = artifact.turns ?? [];
  const incomplete = calls.filter((call) => !call?.request?.body || !call?.request?.bodySha256 || !call?.response?.rawBody || !call?.response?.bodySha256);
  const hashMismatches = calls.filter((call) =>
    call?.request?.body && call?.request?.bodySha256 && sha256(call.request.body) !== call.request.bodySha256
    || call?.response?.rawBody && call?.response?.bodySha256 && sha256(call.response.rawBody) !== call.response.bodySha256);
  const failed = calls.filter((call) => call.status !== "ok");
  const redundantReads = turns.filter((turn) => /\[open_files\]\s+Not re-read:/i.test(String(turn.observation ?? "")));
  const actions = turns.map((turn) => turn.parsedAction?.a).filter(Boolean);
  const commands = turns
    .map((turn) => turn.parsedAction)
    .filter((action) => action?.a === "shell" && action.c)
    .map((action) => action.c);
  const repeatedCommands = duplicateBantamCommandCount(turns);
  const contextFlightRecorder = artifact.contextFlightRecorder?.schema === 2
    ? artifact.contextFlightRecorder
    : buildContextFlightRecorder({ turns, modelCalls: calls });
  const contextRisks = contextFlightRecorder.decisions?.flatMap((decision) => decision.risks ?? []) ?? [];
  const unavailablePrompts = contextRisks.filter((item) => item.code === "prompt-unavailable").length;
  const evidenceLoss = contextRisks.filter((item) => [
    "prior-decisive-evidence-missing",
    "observation-transform-dropped-evidence",
  ].includes(item.code)).length;
  const ungroundedEdits = contextRisks.filter((item) => [
    "edit-target-absent",
    "edit-target-partial",
  ].includes(item.code)).length;
  const failedEditRecoveryGaps = contextRisks.filter((item) => [
    "failed-edit-target-absent",
    "failed-edit-target-partial",
  ].includes(item.code)).length;
  const issues = [];
  if (incomplete.length) issues.push(issue("api-record-incomplete", `${incomplete.length} model call(s) lack request/response bytes or hashes.`));
  if (hashMismatches.length) issues.push(issue("api-record-hash", `${hashMismatches.length} model call(s) have request or response bytes that do not match their SHA-256.`));
  if (failed.length) issues.push(issue("api-call-failed", `${failed.length} model call(s) did not finish successfully.`));
  if (redundantReads.length) issues.push(issue("redundant-visible-read", `${redundantReads.length} turn(s) requested bytes already present in open_files.`));
  if (repeatedCommands) issues.push(issue("repeated-bantam-command", `${repeatedCommands} BANTAM shell command retry/retries repeated identical text without an intervening edit.`));
  if (unavailablePrompts) issues.push(issue("context-prompt-unavailable", `${unavailablePrompts} decision(s) could not be bound to exact prompt bytes.`));
  if (evidenceLoss) issues.push(issue("context-evidence-loss", `${evidenceLoss} decision(s) lost decisive failure evidence before the next choice.`));
  if (ungroundedEdits) issues.push(issue("edit-without-resident-context", `${ungroundedEdits} edit decision(s) lacked a visible target seam.`));
  if (failedEditRecoveryGaps) issues.push(issue("failed-edit-recovery-context-gap", `${failedEditRecoveryGaps} recovery turn(s) lacked complete failed-edit target context.`));
  return base({
    arm, round, fixture, artifactPath, kind: artifact.kind,
    logIntegrity: incomplete.length || hashMismatches.length ? "fail" : "pass",
    records: calls.length,
    actions,
    issues,
    observations: {
      agentTurns: turns.length,
      extraReasoningCalls: Math.max(0, calls.length - turns.length),
      redundantVisibleReads: redundantReads.length,
      commands: commands.length,
      repeatedCommands,
      completionAuditHints: artifact.metrics?.completionAuditHints ?? 0,
      promptCommonPrefixRatio: artifact.metrics?.promptChurn?.commonPrefixRatio ?? null,
      contextFlightRecorder: contextFlightRecorder.summary,
      finalDiff: artifact.finalDiff?.text ?? "",
    },
  });
}

function auditNativeRun({ artifact, artifactPath, arm, round, fixture }) {
  const claude = artifact.kind === "bantam-claude-delegate";
  const events = artifact.events ?? [];
  const issues = [];
  const transcript = auditTranscript(artifact.transcript, events.length);
  if (!transcript.pass) issues.push(issue(transcript.code, transcript.detail));
  if ((artifact.execution?.parseErrors ?? []).length) {
    issues.push(issue("native-stream-parse-errors", `${artifact.execution.parseErrors.length} JSONL record(s) could not be parsed.`));
  }
  const actions = [];
  const commands = [];
  let permissionDenials = 0;
  let absoluteEditPaths = 0;
  if (claude) {
    for (const event of events) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          actions.push(block.name);
          if (block.name === "Bash" && block.input?.command) commands.push(block.input.command);
          if (["Edit", "Write", "NotebookEdit"].includes(block.name) && path.isAbsolute(String(block.input?.file_path ?? ""))) absoluteEditPaths++;
        }
      }
      if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_result" && /requires approval|permission denied|not allowed/i.test(String(block.content ?? ""))) permissionDenials++;
        }
      }
    }
  } else {
    for (const event of events) {
      const item = event.item ?? {};
      if (event.type !== "item.completed") continue;
      if (item.type) actions.push(item.type);
      if (item.type === "command_execution" && item.command) commands.push(item.command);
    }
  }
  const repeatedCommands = duplicateCount(commands);
  const sandboxFailures = !claude && nativeSandboxEvidence(artifact);
  if (permissionDenials) issues.push(issue("verifier-permission-denied", `${permissionDenials} native tool call(s) were denied for approval.`));
  if (repeatedCommands) issues.push(issue("repeated-native-command", `${repeatedCommands} native command retry/retries repeated identical text.`));
  if (absoluteEditPaths) issues.push(issue("absolute-native-edit-path", `${absoluteEditPaths} Claude edit(s) used an absolute candidate path.`));
  if (sandboxFailures) issues.push(issue("native-sandbox-unavailable", "The native Codex filesystem sandbox failed on this host."));
  return base({
    arm, round, fixture, artifactPath, kind: artifact.kind,
    logIntegrity: transcript.pass ? "pass" : "fail",
    records: events.length,
    actions,
    issues,
    observations: {
      commands: commands.length,
      repeatedCommands,
      permissionDenials,
      absoluteEditPaths,
      sandboxFailures,
      finalMessage: String(artifact.finalMessage ?? "").slice(0, 500),
      finalDiff: artifact.finalDiff?.text ?? "",
    },
  });
}

function auditTranscript(transcript, eventCount) {
  if (!transcript?.streamPath) {
    return { pass: false, code: "raw-native-stream-missing", detail: "Parsed events exist without a retained raw JSONL stream." };
  }
  if (!fs.statSync(transcript.streamPath, { throwIfNoEntry: false })?.isFile()) {
    return { pass: false, code: "raw-native-stream-missing", detail: `Raw stream is missing: ${transcript.streamPath}` };
  }
  const bytes = fs.readFileSync(transcript.streamPath);
  if (transcript.sha256 && sha256(bytes) !== transcript.sha256) {
    return { pass: false, code: "raw-native-stream-hash", detail: "Raw stream SHA-256 does not match the artifact." };
  }
  if (Number.isInteger(transcript.eventCount) && transcript.eventCount !== eventCount) {
    return { pass: false, code: "raw-native-stream-count", detail: "Parsed event count does not match transcript metadata." };
  }
  // New artifacts bind stderr too because provider/tool failures often appear
  // only on that channel. Preserve compatibility with older stream-only runs.
  if (transcript.stderrSha256) {
    if (!fs.statSync(transcript.stderrPath, { throwIfNoEntry: false })?.isFile()) {
      return { pass: false, code: "raw-native-stderr-missing", detail: `Raw stderr is missing: ${transcript.stderrPath}` };
    }
    const stderr = fs.readFileSync(transcript.stderrPath);
    if (sha256(stderr) !== transcript.stderrSha256) {
      return { pass: false, code: "raw-native-stderr-hash", detail: "Raw stderr SHA-256 does not match the artifact." };
    }
    if (Number.isInteger(transcript.stderrBytes) && transcript.stderrBytes !== stderr.length) {
      return { pass: false, code: "raw-native-stderr-bytes", detail: "Raw stderr byte count does not match transcript metadata." };
    }
  }
  return { pass: true };
}

function deriveHypotheses(runs) {
  const hypotheses = [];
  const redundant = runs.filter((run) => run.issues.some((item) => item.code === "redundant-visible-read"));
  if (redundant.length) hypotheses.push(hypothesis(
    "avoid-redundant-visible-read",
    "When the exact current range is already in open_files, make the edit/probe choice salient before the next action instead of paying for a rejected reread.",
    redundant,
    ["candidate_rule(avoid_redundant_visible_read).", "requires_replication(avoid_redundant_visible_read)."],
  ));
  const denied = runs.filter((run) => run.issues.some((item) => item.code === "verifier-permission-denied"));
  if (denied.length) hypotheses.push(hypothesis(
    "preauthorize-authoritative-verifier",
    "A noninteractive native delegate must receive least-privilege authorization for the exact verifier named by the harness.",
    denied,
    ["candidate_rule(preauthorize_authoritative_verifier).", "safety_boundary(verifier_authorization, exact_command_only)."],
    "applied-to-subsequent-runs",
  ));
  const missing = runs.filter((run) => run.issues.some((item) => item.code === "raw-native-stream-missing"));
  if (missing.length) hypotheses.push(hypothesis(
    "retain-raw-native-stream",
    "Parsed native events are insufficient forensic evidence without the original hash-bound JSONL bytes.",
    missing,
    ["candidate_rule(retain_raw_native_stream).", "audit_requires(raw_stream_sha256)."],
    "applied-to-subsequent-runs",
  ));
  const repeatedBantam = runs.filter((run) => run.issues.some((item) => item.code === "repeated-bantam-command"));
  if (repeatedBantam.length) hypotheses.push(hypothesis(
    "reuse-green-verification-until-edit",
    "An exact passing verification command should remain an indexed fact until the workspace changes; do not spend another model turn recreating it.",
    repeatedBantam,
    ["candidate_rule(reuse_green_verification_until_edit).", "invalidated_by(reuse_green_verification_until_edit, workspace_change)."],
    "applied-to-subsequent-runs",
  ));
  const sandbox = runs.filter((run) => run.issues.some((item) => item.code === "native-sandbox-unavailable"));
  if (sandbox.length) hypotheses.push(hypothesis(
    "preflight-native-sandbox",
    "Preflight the native Codex sandbox and classify host sandbox failure as infrastructure; an explicitly consented delegate may bypass it only inside the disposable fixture candidate.",
    sandbox,
    ["candidate_rule(preflight_native_sandbox).", "infrastructure_failure(native_sandbox_error).", "requires_explicit_consent(native_sandbox_bypass)."],
    "applied-to-subsequent-runs",
  ));
  const evidenceLoss = runs.filter((run) => run.issues.some((item) => item.code === "context-evidence-loss"));
  if (evidenceLoss.length) hypotheses.push(hypothesis(
    "retain-decisive-failure-evidence",
    "A failure line used to choose the next action must survive observation transforms and prompt replay until superseded by newer evidence.",
    evidenceLoss,
    ["candidate_rule(retain_decisive_failure_evidence).", "requires_replication(retain_decisive_failure_evidence)."],
  ));
  const recoveryGaps = runs.filter((run) => run.issues.some((item) => item.code === "failed-edit-recovery-context-gap"));
  if (recoveryGaps.length) hypotheses.push(hypothesis(
    "pin-failed-edit-target-until-recovery",
    "After an edit anchor fails, keep that exact target resident through the next recovery decision, including its proposed replacement and current source seam.",
    recoveryGaps,
    ["candidate_rule(pin_failed_edit_target_until_recovery).", "requires_replication(pin_failed_edit_target_until_recovery)."],
  ));
  const capped = runs.filter((run) => /Math\.min\(concurrency,\s*(?:input|items|values)\.length\)/.test(addedDiff(run.observations.finalDiff)));
  const uncappedLocal = runs.filter((run) => run.kind === "bantam-run" && /length:\s*concurrency/.test(addedDiff(run.observations.finalDiff)));
  if (capped.length >= 2 && uncappedLocal.length) hypotheses.push({
    id: "bound-worker-spawn-by-available-work",
    statement: "Multiple teacher arms bounded worker creation by available work while a passing local artifact created empty excess runners; test this as an efficiency invariant on fresh tasks.",
    evidence: [...capped, ...uncappedLocal].map(reference),
    facts: [
      `teacher_consensus(bound_worker_spawn_by_available_work, ${capped.length}).`,
      `local_gap(excess_empty_workers, ${uncappedLocal.length}).`,
      "requires_replication(bound_worker_spawn_by_available_work).",
    ],
    status: "hypothesis-only",
  });
  return hypotheses;
}

function hypothesis(id, statement, runs, facts, status = "hypothesis-only") {
  return { id, statement, evidence: runs.map(reference), facts, status };
}

function reference(run) {
  return `${run.arm}/r${run.round}/${run.fixture}`;
}

function base(value) {
  return {
    arm: value.arm,
    round: value.round,
    fixture: value.fixture,
    artifactPath: value.artifactPath,
    kind: value.kind,
    logIntegrity: value.logIntegrity,
    records: value.records ?? 0,
    actions: value.actions ?? [],
    issues: value.issues ?? [],
    observations: value.observations ?? {},
  };
}

function issue(code, detail) {
  return { code, detail };
}

function duplicateCount(values) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) duplicates++;
    else seen.add(value);
  }
  return duplicates;
}

function duplicateBantamCommandCount(turns) {
  const seen = new Set();
  let duplicates = 0;
  for (const turn of turns) {
    const action = turn?.parsedAction ?? turn?.action;
    if (action?.a === "shell" && action.c) {
      if (seen.has(action.c)) duplicates++;
      else seen.add(action.c);
    }
    if (turnEditApplied(turn) || turn?.sourceEditedByShell) seen.clear();
  }
  return duplicates;
}

function nativeSandboxEvidence(artifact) {
  const evidence = `${artifact?.execution?.stderr ?? ""}\n${artifact?.finalMessage ?? ""}`;
  return /(?:bwrap|bubblewrap).*(?:RTM_NEWADDR|operation not permitted)|fs sandbox helper failed/i.test(evidence);
}

function addedDiff(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function relative(root, filePath) {
  return path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join("/");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
