// Explicit-only collaborative BANTAM sessions.
//
// Team mode runs a parallel, read-only specialist phase in isolated workspaces,
// then gives bounded findings to one Terra primary. Only the Terra lane may
// write, and the live workspace remains untouched until an explicit verified
// transactional apply through the underlying TrioSession machinery.

import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { classifyTaskIntent } from "./task-intent.js";
import {
  applyTrioArm,
  TrioSession,
} from "./trio-session.js";

const TEAM_KIND = "bantam-team-session";
// Contract and adversarial ledgers routinely contain 15-30 independent
// obligations. The old 2k-character cap silently kept only the first few,
// defeating the purpose of exhaustive scouting. This still bounds three
// reports to a small fraction of the Codex context window.
const FINDING_LIMIT = 8_000;

export class TeamSession {
  constructor({
    workspace,
    stateRoot = null,
    runtimeRoot = null,
    id = null,
    includeLocal = true,
    verificationScript = null,
    maxTurns = 30,
    scoutMaxTurns = 5,
    primaryAdvisoryInvestigationLimit = 2,
    thinkMode = "auto",
    preGate = true,
    modelFactory,
    runAgentImpl,
    preflightVerifier,
    onEvent = () => {},
  } = {}) {
    this.workspace = path.resolve(workspace ?? ".");
    this.includeLocal = Boolean(includeLocal);
    this.scoutMaxTurns = positiveInt(scoutMaxTurns, "team scoutMaxTurns");
    this.primaryAdvisoryInvestigationLimit = positiveInt(
      primaryAdvisoryInvestigationLimit,
      "team primaryAdvisoryInvestigationLimit",
    );
    this.arms = teamArms(this.includeLocal);
    this.engine = new TrioSession({
      workspace: this.workspace,
      stateRoot: stateRoot ?? path.join(this.workspace, ".bantam", "teams"),
      runtimeRoot,
      id,
      arms: this.arms,
      effort: "medium",
      verificationScript,
      maxTurns,
      thinkMode,
      preGate,
      modelFactory,
      runAgentImpl,
      preflightVerifier,
      onEvent,
    });
    this.directory = this.engine.directory;
    this.teamPath = path.join(this.directory, "team.json");
    this.team = null;
  }

  async start() {
    const engine = await this.engine.start();
    const now = new Date().toISOString();
    this.team = {
      schema: 1,
      kind: TEAM_KIND,
      id: engine.id,
      status: "ready",
      startedAt: now,
      updatedAt: now,
      sourceWorkspace: this.workspace,
      engineManifest: "manifest.json",
      includeLocal: this.includeLocal,
      primary: "terra",
      scoutMaxTurns: this.scoutMaxTurns,
      primaryAdvisoryInvestigationLimit: this.primaryAdvisoryInvestigationLimit,
      specialists: this.arms.map((arm) => ({
        name: arm.name,
        role: arm.role,
        effort: arm.effort ?? null,
      })),
      taskCount: 0,
      tasks: [],
    };
    this.persist();
    return this.view();
  }

  async runTask(task, { signal = null } = {}) {
    this.requireReady();
    const request = requiredString(task, "team task");
    const intent = classifyTaskIntent(request);
    const taskNumber = this.team.taskCount + 1;
    const record = {
      task: taskNumber,
      request,
      intent,
      status: "scouting",
      startedAt: new Date().toISOString(),
      completedAt: null,
      scoutTurn: null,
      primaryTurn: null,
      findings: [],
      comparison: null,
    };
    this.team.taskCount = taskNumber;
    this.team.status = "active";
    this.team.tasks.push(record);
    this.persist();

    // Terra is the accountable primary, not a second copy of the planning
    // scout. Giving it a disposable scout turn duplicated repository reads and
    // then threw that native/BANTAM history away at the phase boundary. Keep
    // the independent roles genuinely complementary: Local maps the checkout,
    // Luna audits the written contract, Sol attacks it, and Terra integrates.
    const scoutArms = this.arms.filter((arm) => arm.name !== "terra");
    const scoutCheckpoints = Object.fromEntries(
      scoutArms.map((arm) => [arm.name, this.engine.checkpointArm(arm.name)]),
    );
    const scoutNames = scoutArms.map((arm) => arm.name);
    const scoutTasks = Object.fromEntries(
      scoutArms.map((arm) => [arm.name, specialistPrompt(arm.name, request)]),
    );
    const scout = await this.engine.runTurn(request, {
      signal,
      arms: scoutNames,
      armTasks: scoutTasks,
      intent: "advisory",
      maxTurns: this.scoutMaxTurns,
      investigationActionLimit: 2,
    });
    record.scoutTurn = scout.turn;
    record.findings = scout.rows.map((row) => ({
      arm: row.arm,
      role: roleFor(row.arm),
      status: row.status,
      pass: row.pass,
      summary: boundedFinding(row.summary || row.error || row.status),
      artifactPath: row.artifactPath ?? null,
      turns: row.turns ?? 0,
      requests: row.requests ?? 0,
      inputTokens: row.inputTokens ?? 0,
      cacheHitTokens: row.cacheHitTokens ?? 0,
      cacheMissTokens: row.cacheMissTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      reasoningTokens: row.reasoningTokens ?? 0,
      costUsd: row.costUsd ?? 0,
      durationMs: row.durationMs ?? 0,
    }));
    record.status = "integrating";
    this.persist();

    if (signal?.aborted) {
      restoreScoutLanes(this.engine, scoutCheckpoints);
      record.status = "interrupted";
      record.completedAt = new Date().toISOString();
      record.comparison = buildTeamComparison(record, null);
      this.team.status = "ready";
      this.persist();
      writeTextAtomic(path.join(this.directory, "team-summary.md"), formatTeamSummary(this.team));
      writeTeamReport(path.join(this.directory, "team-report", "index.html"), this.team);
      return {
        task: taskNumber,
        findings: record.findings,
        primary: null,
        comparison: record.comparison,
        directory: this.directory,
      };
    }

    const unsafeScouts = scout.rows.filter((row) => (
      row.diff?.status !== "captured" || row.diff.fileCount !== 0
    ));
    // Scouts are disposable observations, never candidate ancestors. Restore
    // every lane (including Terra) before deciding whether integration may run.
    // This also removes scout-only lane history from the primary's prompt.
    restoreScoutLanes(this.engine, scoutCheckpoints);
    if (unsafeScouts.length) {
      record.status = "scout-policy-violation";
      record.completedAt = new Date().toISOString();
      record.unsafeScouts = unsafeScouts.map((row) => ({
        arm: row.arm,
        status: row.status,
        files: row.diff?.files ?? [],
      }));
      record.comparison = buildTeamComparison(record, null);
      this.team.status = "ready";
      this.persist();
      writeTextAtomic(path.join(this.directory, "team-summary.md"), formatTeamSummary(this.team));
      writeTeamReport(path.join(this.directory, "team-report", "index.html"), this.team);
      return {
        task: taskNumber,
        findings: record.findings,
        primary: null,
        comparison: record.comparison,
        directory: this.directory,
      };
    }

    const primary = await this.engine.runTurn(request, {
      signal,
      arms: ["terra"],
      armTasks: {
        terra: primaryPrompt(request, intent, record.findings),
      },
      intent,
      investigationActionLimit: intent === "advisory"
        ? this.primaryAdvisoryInvestigationLimit
        : null,
    });
    const primaryRow = primary.rows[0];
    if (intent === "advisory" && primaryRow && inadequateAdvisorySummary(primaryRow.summary)) {
      primaryRow.originalSummary = primaryRow.summary;
      primaryRow.summary = advisoryFallback(request, record.findings);
      primaryRow.synthesisFallback = true;
      if (primaryRow.status === "response") primaryRow.status = "response-fallback";
    }
    record.primaryTurn = primary.turn;
    record.completedAt = new Date().toISOString();
    record.status = primaryRow?.status ?? "error";
    record.comparison = buildTeamComparison(record, primaryRow);
    if (intent === "implementation"
        && primaryRow
        && !["error", "interrupted", "model-error"].includes(primaryRow.status)) {
      this.engine.synchronizeArmsFrom("terra", {
        targets: this.arms.map((arm) => arm.name).filter((name) => name !== "terra"),
      });
      record.synchronizedFromPrimary = true;
    }
    this.team.status = "ready";
    this.persist();
    writeTextAtomic(path.join(this.directory, "team-summary.md"), formatTeamSummary(this.team));
    writeTeamReport(path.join(this.directory, "team-report", "index.html"), this.team);
    return {
      task: taskNumber,
      findings: record.findings,
      primary: primaryRow,
      comparison: record.comparison,
      directory: this.directory,
    };
  }

  view() {
    if (!this.team) return null;
    return JSON.parse(JSON.stringify(this.team));
  }

  persist() {
    this.team.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.teamPath, this.team);
  }

  requireReady() {
    if (!this.team || this.team.status !== "ready") {
      throw new Error("team session is not ready");
    }
  }

  close() {
    this.engine.close();
  }
}

export async function applyTeamPrimary({
  sessionDir,
  workspace = null,
  verificationScript = null,
  timeoutMs = 120_000,
  runVerifier,
} = {}) {
  const directory = path.resolve(requiredString(sessionDir, "team session"));
  const team = loadTeamManifest(directory);
  if (!team.tasks.length) throw new Error("team apply requires a completed task");
  const latest = team.tasks.at(-1);
  if (!latest.completedAt || !latest.primaryTurn) {
    throw new Error("team apply requires a completed Terra primary");
  }
  if (latest.intent !== "implementation") {
    throw new Error("team apply requires an implementation task");
  }
  if (latest.comparison?.pass !== true) {
    throw new Error("team apply requires a verified passing Terra primary");
  }
  return applyTrioArm({
    sessionDir: directory,
    arm: "terra",
    workspace,
    verificationScript,
    timeoutMs,
    runVerifier,
  });
}

export function loadTeamManifest(sessionDir) {
  const directory = path.resolve(requiredString(sessionDir, "team session"));
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(directory, "team.json"), "utf8"));
  } catch (error) {
    throw new Error(`cannot read team manifest: ${error.message}`);
  }
  if (!value || value.schema !== 1 || value.kind !== TEAM_KIND || typeof value.id !== "string") {
    throw new Error("invalid team manifest");
  }
  return value;
}

export function formatTeamComparison(comparison) {
  if (!comparison) throw new TypeError("team comparison is required");
  const lines = [
    `Team task ${comparison.task} (${comparison.intent})`,
    "",
    "Member          Role                  Status       Turns  Requests  Input      Cache hit  Cache miss  Output     Reasoning  Time",
  ];
  for (const row of comparison.rows) {
    lines.push([
      String(row.member).padEnd(15),
      String(row.role).padEnd(21),
      String(row.status).padEnd(12),
      String(row.turns ?? 0).padStart(5),
      String(row.requests ?? 0).padStart(8),
      formatNumber(row.inputTokens).padStart(10),
      formatNumber(row.cacheHitTokens).padStart(10),
      formatNumber(row.cacheMissTokens).padStart(10),
      formatNumber(row.outputTokens).padStart(10),
      formatNumber(row.reasoningTokens).padStart(10),
      formatDuration(row.durationMs).padStart(7),
    ].join("  "));
  }
  lines.push(
    "",
    `Parallel scout wall time: ${formatDuration(comparison.scoutWallMs)}`,
    `Terra integration time: ${formatDuration(comparison.primaryDurationMs)}`,
    `Total team wall time: ${formatDuration(comparison.wallMs)}`,
    `Total model requests: ${formatNumber(comparison.totalRequests)}`,
    `Total input/output/reasoning: ${formatNumber(comparison.totalInputTokens)} / ${formatNumber(comparison.totalOutputTokens)} / ${formatNumber(comparison.totalReasoningTokens)}`,
    `Total cache hit/miss: ${formatNumber(comparison.totalCacheHitTokens)} / ${formatNumber(comparison.totalCacheMissTokens)}`,
  );
  return lines.join("\n");
}

function teamArms(includeLocal) {
  const arms = [];
  if (includeLocal) {
    arms.push({
      name: "local",
      role: "repository scout",
      description: "Optional local read-only repository scout",
    });
  }
  arms.push(
    {
      name: "luna",
      role: "contract scout",
      effort: "medium",
      description: "Luna medium read-only test and contract scout",
    },
    {
      name: "sol",
      role: "adversarial reviewer",
      effort: "high",
      description: "Sol high read-only adversarial reviewer",
    },
    {
      name: "terra",
      role: "accountable primary",
      effort: "medium",
      description: "Terra medium sole answer synthesizer and integration writer",
    },
  );
  return arms;
}

function specialistPrompt(name, task) {
  const instruction = {
    local: [
      "Act as the read-only repository scout.",
      "Locate the relevant code, architecture, and dependencies.",
      "Return a compact evidence report with concrete paths and risks.",
    ],
    luna: [
      "Act as the read-only contract auditor. Do not produce a general implementation plan.",
      "Extract EVERY independently testable requirement from the operator task, including required object fields, validation-before-side-effect rules, identity/order/error semantics, and negative cases.",
      "Inspect the implementation, not merely the file list. Return a compact numbered REQUIREMENT LEDGER. For each item give: SATISFIED, GAP, or UNKNOWN; the obligation; concrete repository evidence; and one terse proof. Explicitly say whether any required field may be absent.",
      "Keep the complete ledger under 8,000 characters so later requirements are never crowded out by prose.",
    ],
    sol: [
      "Act as the read-only adversarial reviewer. Do not repeat the ordinary implementation plan.",
      "Attack likely solutions at boundary conditions, failure ordering, concurrency/lifecycle seams, unsafe assumptions, and integration hazards.",
      "Return only a risk-ranked ADVERSARIAL CHECKS list with concrete counterexamples or probes.",
      "Keep the complete list under 8,000 characters and prioritize observed code gaps over hypothetical rewrites.",
    ],
    terra: [
      "Act as the read-only primary planner.",
      "Develop the smallest complete implementation approach and identify the files and verification sequence.",
      "Return a concise integration plan grounded in repository evidence.",
    ],
  }[name];
  return [
    ...instruction,
    "Budget: use at most two inspection/query actions, then respond with the best grounded finding available.",
    "Do not edit files or run mutating shell commands. Finish with a respond action.",
    "",
    "Operator task:",
    task,
  ].join("\n");
}

function primaryPrompt(task, intent, findings) {
  const evidence = findings.map((finding) => [
    `### ${finding.arm} — ${finding.role} (${finding.status})`,
    finding.summary || "(no usable finding)",
  ].join("\n")).join("\n\n");
  return [
    "You are the Terra primary for an explicit BANTAM Team task.",
    intent === "implementation"
      ? "You are the sole writer. Implement the operator's task completely in this isolated candidate workspace and verify it."
      : "Answer the operator's question directly and completely. This is advisory: do not modify the workspace.",
    intent === "advisory"
      ? "Your response is the only Team answer the operator will see. It must be self-contained and must state the requested finding, reasoning, and concrete evidence—not merely say that no edit is needed or that another finding already exists."
      : "Produce one coherent implementation; use specialist findings as review input, not as separate candidate changes.",
    intent === "implementation"
      ? "Before editing, build a requirement ledger from the ORIGINAL operator task. Before declaring done, audit the final code against every ledger item—not merely the public verifier. In particular, test required-field presence, validation-before-side-effect behavior, ordering/identity/error contracts, and negative cases when the task mentions them. A green supplied test suite is necessary but not sufficient."
      : "Reconcile disagreements between findings against the original request and repository evidence.",
    intent === "implementation"
      ? "Minimize the change set: inspect current code, preserve every already-compliant file and behavior, and edit only demonstrated gaps. A requirement appearing in a ledger does not by itself justify rewriting its implementation."
      : "Prefer the smallest evidence-grounded answer that fully resolves the request.",
    "The specialist findings below are advisory and may be wrong. Validate important claims against the workspace before relying on them.",
    "Do not mention the internal team protocol unless it materially helps the operator.",
    "",
    "Operator task:",
    task,
    "",
    "Parallel specialist findings:",
    evidence || "(no specialist findings were available)",
  ].join("\n");
}

function restoreScoutLanes(engine, checkpoints) {
  const failures = [];
  for (const checkpoint of Object.values(checkpoints)) {
    try {
      engine.restoreArm(checkpoint);
    } catch (error) {
      failures.push(new Error(`${checkpoint.arm}: ${error.message}`, { cause: error }));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "failed to restore one or more Team scout lanes");
  }
}

function inadequateAdvisorySummary(summary) {
  const text = String(summary ?? "").trim();
  if (!text) return true;
  return /\b(?:finding|analysis|recommendation|proposal)(?:s)?\s+(?:has|have)\s+been\s+(?:provided|given|included)\b/i.test(text)
    || /^(?:the requested work|this request)\s+(?:was|is)\s+(?:an? )?(?:advisory|read-only)/i.test(text)
      && text.length < 500;
}

function advisoryFallback(task, findings) {
  const usable = findings.filter((finding) => String(finding.summary ?? "").trim());
  return [
    "Team findings (the Terra synthesis was content-free, so BANTAM preserved the grounded specialist evidence):",
    "",
    ...usable.map((finding) => [
      `### ${finding.arm} — ${finding.role}`,
      finding.summary,
      "",
    ].join("\n")),
    `Original request: ${task}`,
  ].join("\n").trim();
}

function buildTeamComparison(record, primary) {
  const rows = [
    ...record.findings.map((finding) => ({
      member: `${finding.arm}-scout`,
      role: finding.role,
      status: finding.status,
      turns: finding.turns,
      requests: finding.requests,
      inputTokens: finding.inputTokens,
      cacheHitTokens: finding.cacheHitTokens,
      cacheMissTokens: finding.cacheMissTokens,
      outputTokens: finding.outputTokens,
      reasoningTokens: finding.reasoningTokens,
      costUsd: finding.costUsd,
      durationMs: finding.durationMs,
      artifactPath: finding.artifactPath,
    })),
  ];
  if (primary) {
    rows.push({
      member: "terra-primary",
      role: record.intent === "implementation" ? "integration writer" : "answer synthesizer",
      status: primary?.status ?? "error",
      turns: primary?.turns ?? 0,
      requests: primary?.requests ?? 0,
      inputTokens: primary?.inputTokens ?? 0,
      cacheHitTokens: primary?.cacheHitTokens ?? 0,
      cacheMissTokens: primary?.cacheMissTokens ?? 0,
      outputTokens: primary?.outputTokens ?? 0,
      reasoningTokens: primary?.reasoningTokens ?? 0,
      costUsd: primary?.costUsd ?? 0,
      durationMs: primary?.durationMs ?? 0,
      artifactPath: primary?.artifactPath ?? null,
    });
  }
  const scoutWallMs = Math.max(0, ...record.findings.map((row) => row.durationMs));
  const primaryDurationMs = primary?.durationMs ?? 0;
  return {
    schema: 1,
    kind: "bantam-team-comparison",
    task: record.task,
    intent: record.intent,
    status: primary?.status ?? record.status ?? "interrupted",
    pass: Boolean(primary?.pass),
    scoutWallMs,
    primaryDurationMs,
    wallMs: scoutWallMs + primaryDurationMs,
    totalRequests: sum(rows, "requests"),
    totalInputTokens: sum(rows, "inputTokens"),
    totalCacheHitTokens: sum(rows, "cacheHitTokens"),
    totalCacheMissTokens: sum(rows, "cacheMissTokens"),
    totalOutputTokens: sum(rows, "outputTokens"),
    totalReasoningTokens: sum(rows, "reasoningTokens"),
    totalCostUsd: sum(rows, "costUsd"),
    rows,
  };
}

function formatTeamSummary(team) {
  const lines = [
    `# BANTAM Team ${team.id}`,
    "",
    `Source workspace: \`${team.sourceWorkspace}\``,
    `Primary: ${team.primary}`,
    `Local scout: ${team.includeLocal ? "included" : "unavailable/skipped"}`,
    "",
  ];
  for (const task of team.tasks) {
    lines.push(`## Task ${task.task}`, "", task.request, "");
    if (task.comparison) {
      lines.push("```text", formatTeamComparison(task.comparison), "```", "");
      for (const finding of task.findings) {
        lines.push(`### ${finding.arm} — ${finding.role}`, "", finding.summary, "");
      }
    } else {
      lines.push("_In progress._", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeTeamReport(filePath, team) {
  const tasks = team.tasks.filter((task) => task.comparison);
  const sections = tasks.map((task) => {
    const cards = task.comparison.rows.map((row) => `<article><h3>${escapeHtml(row.member)}</h3><p>${escapeHtml(row.role)}</p><strong>${escapeHtml(row.status)}</strong><dl><dt>Turns</dt><dd>${row.turns}</dd><dt>Requests</dt><dd>${row.requests}</dd><dt>Input</dt><dd>${formatNumber(row.inputTokens)}</dd><dt>Cache hit</dt><dd>${formatNumber(row.cacheHitTokens)}</dd><dt>Cache miss</dt><dd>${formatNumber(row.cacheMissTokens)}</dd><dt>Output</dt><dd>${formatNumber(row.outputTokens)}</dd><dt>Time</dt><dd>${formatDuration(row.durationMs)}</dd></dl>${row.artifactPath ? `<a href="../${escapeHtml(row.artifactPath)}">Run artifact</a>` : ""}</article>`).join("");
    return `<section><h2>Task ${task.task}</h2><p>${escapeHtml(task.request)}</p><div class="cards">${cards}</div><p>Total team wall time ${formatDuration(task.comparison.wallMs)} · ${formatNumber(task.comparison.totalRequests)} model requests · ${formatNumber(task.comparison.totalInputTokens)} input tokens.</p></section>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BANTAM Team ${escapeHtml(team.id)}</title><style>:root{color-scheme:dark;--bg:#08100f;--panel:#12201e;--ink:#f5f7ed;--muted:#9db0aa;--line:#b6d8c32b;--accent:#a7ef72}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif}.shell{width:min(1180px,calc(100% - 32px));margin:auto}header{padding:68px 0 30px}h1{font-size:clamp(42px,7vw,78px);line-height:.95;letter-spacing:-.05em;margin:10px 0}p{color:var(--muted)}section{margin:20px 0 40px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.cards article{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:16px;padding:18px}dl{display:grid;grid-template-columns:1fr 1fr}dt{color:var(--muted)}dd{text-align:right;margin:0}a{color:var(--accent)}</style></head><body><header><div class="shell"><small>EXPLICIT COLLABORATIVE SESSION</small><h1>Parallel scouts.<br>One accountable writer.</h1><p>Local when available maps the repository, Luna audits the contract, and Sol attacks edge cases in isolated copies. Terra receives their bounded evidence and alone integrates. The live workspace remains untouched until explicit verified apply.</p></div></header><main class="shell">${sections}</main></body></html>`;
  writeTextAtomic(filePath, html);
}

function boundedFinding(value) {
  return String(value ?? "").replace(/\u0000/g, "").slice(0, FINDING_LIMIT);
}

function roleFor(name) {
  return {
    local: "repository scout",
    luna: "contract scout",
    sol: "adversarial reviewer",
    terra: "primary planner",
  }[name] ?? "specialist";
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Math.max(0, Number(row[key]) || 0), 0);
}

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return number;
}

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0) / 1_000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
    : `${seconds.toFixed(1)}s`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}
