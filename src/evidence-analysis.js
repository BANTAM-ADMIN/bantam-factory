import fs from "node:fs";
import path from "node:path";

const DEFAULT_COUNTERS = {
  invalid: 0,
  protocolViolations: 0,
  preGateFails: 0,
  shellCwdGuards: 0,
  workspaceAliasNormalizations: 0,
  shellReadGuards: 0,
  testPipeGuards: 0,
  testDigestHits: 0,
  repeatedFailureHints: 0,
  outcomeCycleEvents: 0,
  outcomeCycleHints: 0,
  capabilityHints: 0,
  duplicateActionRejections: 0,
  repeatEscapeMasks: 0,
  doneRejections: 0,
  ledgerRejections: 0,
  secretAuditRejections: 0,
  groundingRejects: 0,
  groundingStaleFiles: 0,
  groundingRefreshes: 0,
  groundingRefreshFailures: 0,
  groundingRefreshMs: 0,
  queries: 0,
  queryBudgetBlocks: 0,
  lessonHits: 0,
  progressNudges: 0,
  progressGateRejections: 0,
  progressGateTerminations: 0,
  artifactVerificationNudges: 0,
  artifactVerificationGateRejections: 0,
  artifactVerificationGateTerminations: 0,
  maxProgresslessTurns: 0,
  replaceFailures: 0,
  replaceOldNotFound: 0,
  replaceAmbiguous: 0,
  replaceLineStale: 0,
  replaceOther: 0,
  patchActions: 0,
  patchFailures: 0,
  patchOldNotFound: 0,
  patchAmbiguous: 0,
  patchOverlap: 0,
  patchOther: 0,
};

export function defaultEvidencePaths(root = process.cwd()) {
  return [
    { source: "fixtures", path: path.join(root, "fixtures", "ledger.jsonl") },
  ];
}

export function loadEvidenceRows(inputs = defaultEvidencePaths()) {
  const rows = [];
  const missing = [];
  for (const input of inputs) {
    if (!input?.path || !fs.existsSync(input.path)) {
      missing.push(input);
      continue;
    }
    rows.push(...parseJsonl(fs.readFileSync(input.path, "utf8"), input.source, input.path));
  }
  return { rows, missing };
}

export function parseJsonl(text, source = "unknown", filePath = null) {
  const rows = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push({ source, filePath, line: i + 1, raw: JSON.parse(line) });
    } catch (e) {
      throw new Error(`invalid JSONL at ${filePath ?? source}:${i + 1}: ${e.message}`);
    }
  }
  return rows;
}

export function analyzeEvidenceRows(inputRows, { currentSha = null, latestOnly = true } = {}) {
  const selected = latestOnly ? latestRowsBySubject(inputRows) : inputRows;
  const rows = selected.map((row) => normalizeRow(row.raw ?? row, row.source ?? inferSource(row.raw ?? row)));
  const totals = emptyTotals();
  const bySource = {};
  for (const row of rows) {
    addTotals(totals, row);
    bySource[row.source] ??= emptyTotals();
    addTotals(bySource[row.source], row);
  }

  const bottlenecks = rankBottlenecks(totals);
  const freshness = summarizeFreshness(selected, currentSha);
  return {
    schema: 1,
    kind: "bantam-evidence-analysis",
    latestOnly,
    rows: rows.length,
    freshness,
    totals,
    bySource,
    bottlenecks,
    recommendation: recommendationFor(bottlenecks, totals, freshness),
  };
}

export function formatEvidenceAnalysis(analysis) {
  const t = analysis.totals;
  const lines = [
    "=== Bantam evidence analysis ===",
    `runs analyzed: ${analysis.rows}${analysis.latestOnly ? " (latest per task)" : ""}`,
    `freshness: ${analysis.freshness.current} current, ${analysis.freshness.stale} stale, ${analysis.freshness.unknown} unknown-git`,
    `tasks: ${t.tasks}  passed: ${t.passed}  failed/unresolved: ${t.failed + t.unresolved}  cheated: ${t.cheated}  errored: ${t.errored}`,
    `turns: ${t.turns}  invalid: ${t.invalid}  protocol: ${t.protocolViolations}`,
    "",
    "Bottlenecks:",
  ];
  for (const b of analysis.bottlenecks) {
    lines.push(`- ${b.rank}. ${b.label}: score ${b.score} (${b.evidence})`);
    lines.push(`  next: ${b.next}`);
  }
  lines.push("");
  lines.push(`Recommendation: ${analysis.recommendation}`);
  return lines.join("\n");
}

function inferSource(row) {
  if (row?.kind === "external-batch") return "external-batch";
  if (row?.kind === "external-run") return "external";
  return "fixtures";
}

function normalizeRow(row, source) {
  const isBatch = row.kind === "external-batch" || Number.isInteger(row.total);
  const tasks = isBatch ? row.total ?? 0 : 1;
  const passed = isBatch ? row.resolved ?? row.pass ?? 0 : Number(Boolean(row.pass ?? row.resolved ?? row.status === "pass"));
  const cheated = numberish(row.cheated ?? (row.status === "cheated" || row.verification === "cheated"));
  const errored = numberish(row.errored ?? (row.status === "error" || row.status === "errored"));
  const failed = isBatch ? row.failed ?? 0 : Number(row.status === "fail" || row.verification === "fail");
  const unresolved = isBatch
    ? row.unresolved ?? Math.max(0, tasks - passed - failed - cheated - errored)
    : Number(!passed && !failed && !cheated && !errored);

  return {
    source,
    tasks,
    passed,
    failed,
    unresolved,
    cheated,
    errored,
    turns: row.turns ?? 0,
    durationMs: row.totalMs ?? row.durationMs ?? ((row.seconds ?? 0) * 1000),
    ...normalizeCounters(row),
  };
}

function latestRowsBySubject(inputRows) {
  const latest = new Map();
  for (let i = 0; i < inputRows.length; i++) {
    const row = inputRows[i];
    const raw = row.raw ?? row;
    const key = subjectKey(raw, row.source ?? inferSource(raw), row, i);
    const prior = latest.get(key);
    if (!prior || stampOf(raw, i) >= stampOf(prior.raw ?? prior, prior.__order ?? 0)) {
      latest.set(key, { ...row, __order: i });
    }
  }
  return [...latest.values()];
}

function subjectKey(row, source, carrier = {}, order = 0) {
  if (row.kind === "external-batch") {
    const id = row.name ?? row.manifest ?? row.stamp;
    return id ? `${source}:batch:${id}` : fallbackRowKey(source, carrier, order);
  }
  if (row.kind === "external-run") {
    const id = row.instance ?? row.repo ?? row.stamp;
    return id ? `${source}:instance:${id}` : fallbackRowKey(source, carrier, order);
  }
  const id = row.fixture ?? row.instance ?? row.runId ?? row.stamp;
  return id ? `${source}:fixture:${id}` : fallbackRowKey(source, carrier, order);
}

function fallbackRowKey(source, carrier, order) {
  return `${source}:row:${carrier.filePath ?? "memory"}:${carrier.line ?? order + 1}`;
}

function stampOf(row, order = 0) {
  return String(row.stamp ?? `~${String(order).padStart(9, "0")}`);
}

function summarizeFreshness(rows, currentSha) {
  const out = { currentSha: currentSha ?? null, current: 0, stale: 0, unknown: 0 };
  for (const row of rows) {
    const raw = row.raw ?? row;
    const sha = raw.harnessGitSha ?? null;
    if (!currentSha || !sha) out.unknown++;
    else if (sha === currentSha) out.current++;
    else out.stale++;
  }
  return out;
}

function normalizeCounters(row) {
  const replace = row.replaceFailures && typeof row.replaceFailures === "object"
    ? row.replaceFailures
    : {};
  const replaceTotal = typeof row.replaceFailures === "object"
    ? replace.total
    : row.replaceFailures;
  const patch = row.patchFailures && typeof row.patchFailures === "object"
    ? row.patchFailures
    : {};
  const patchTotal = typeof row.patchFailures === "object"
    ? patch.total
    : row.patchFailures;
  return {
    invalid: row.invalid ?? row.invalidOutputs ?? DEFAULT_COUNTERS.invalid,
    protocolViolations: row.protocolViolations ?? row.protocol ?? DEFAULT_COUNTERS.protocolViolations,
    preGateFails: row.preGateFails ?? row.diagnostics?.preGateFails ?? DEFAULT_COUNTERS.preGateFails,
    shellCwdGuards: row.shellCwdGuards ?? row.diagnostics?.shellCwdGuards ?? DEFAULT_COUNTERS.shellCwdGuards,
    workspaceAliasNormalizations: row.workspaceAliasNormalizations ?? row.diagnostics?.workspaceAliasNormalizations ?? DEFAULT_COUNTERS.workspaceAliasNormalizations,
    shellReadGuards: row.shellReadGuards ?? row.diagnostics?.shellReadGuards ?? DEFAULT_COUNTERS.shellReadGuards,
    testPipeGuards: row.testPipeGuards ?? row.diagnostics?.testPipeGuards ?? DEFAULT_COUNTERS.testPipeGuards,
    testDigestHits: row.testDigestHits ?? row.diagnostics?.testDigestHits ?? DEFAULT_COUNTERS.testDigestHits,
    repeatedFailureHints: row.repeatedFailureHints ?? row.diagnostics?.repeatedFailureHints ?? DEFAULT_COUNTERS.repeatedFailureHints,
    outcomeCycleEvents: row.outcomeCycleEvents ?? row.diagnostics?.outcomeCycleEvents ?? DEFAULT_COUNTERS.outcomeCycleEvents,
    outcomeCycleHints: row.outcomeCycleHints ?? row.diagnostics?.outcomeCycleHints ?? DEFAULT_COUNTERS.outcomeCycleHints,
    capabilityHints: row.capabilityHints ?? row.diagnostics?.capabilityHints ?? DEFAULT_COUNTERS.capabilityHints,
    duplicateActionRejections: row.duplicateActionRejections ?? row.diagnostics?.duplicateActionRejections ?? DEFAULT_COUNTERS.duplicateActionRejections,
    repeatEscapeMasks: row.repeatEscapeMasks ?? row.diagnostics?.repeatEscapeMasks ?? DEFAULT_COUNTERS.repeatEscapeMasks,
    doneRejections: row.doneRejections ?? row.diagnostics?.doneRejections ?? DEFAULT_COUNTERS.doneRejections,
    ledgerRejections: row.ledgerRejections ?? row.diagnostics?.ledgerRejections ?? DEFAULT_COUNTERS.ledgerRejections,
    secretAuditRejections: row.secretAuditRejections ?? row.diagnostics?.secretAuditRejections ?? DEFAULT_COUNTERS.secretAuditRejections,
    groundingRejects: row.groundingRejects ?? row.diagnostics?.groundingRejects ?? DEFAULT_COUNTERS.groundingRejects,
    groundingStaleFiles: row.groundingStaleFiles ?? row.diagnostics?.groundingStaleFiles ?? DEFAULT_COUNTERS.groundingStaleFiles,
    groundingRefreshes: row.groundingRefreshes ?? row.diagnostics?.groundingRefreshes ?? DEFAULT_COUNTERS.groundingRefreshes,
    groundingRefreshFailures: row.groundingRefreshFailures ?? row.diagnostics?.groundingRefreshFailures ?? DEFAULT_COUNTERS.groundingRefreshFailures,
    groundingRefreshMs: row.groundingRefreshMs ?? row.diagnostics?.groundingRefreshMs ?? DEFAULT_COUNTERS.groundingRefreshMs,
    queries: row.queries ?? row.diagnostics?.queries ?? DEFAULT_COUNTERS.queries,
    queryBudgetBlocks: row.queryBudgetBlocks ?? row.diagnostics?.queryBudgetBlocks ?? DEFAULT_COUNTERS.queryBudgetBlocks,
    lessonHits: row.lessonHits ?? row.diagnostics?.lessonHits ?? DEFAULT_COUNTERS.lessonHits,
    progressNudges: row.progressNudges ?? row.diagnostics?.progressNudges ?? DEFAULT_COUNTERS.progressNudges,
    progressGateRejections: row.progressGateRejections ?? row.diagnostics?.progressGateRejections ?? DEFAULT_COUNTERS.progressGateRejections,
    progressGateTerminations: row.progressGateTerminations ?? row.diagnostics?.progressGateTerminations ?? DEFAULT_COUNTERS.progressGateTerminations,
    artifactVerificationNudges: row.artifactVerificationNudges ?? row.diagnostics?.artifactVerificationNudges ?? DEFAULT_COUNTERS.artifactVerificationNudges,
    artifactVerificationGateRejections: row.artifactVerificationGateRejections ?? row.diagnostics?.artifactVerificationGateRejections ?? DEFAULT_COUNTERS.artifactVerificationGateRejections,
    artifactVerificationGateTerminations: row.artifactVerificationGateTerminations ?? row.diagnostics?.artifactVerificationGateTerminations ?? DEFAULT_COUNTERS.artifactVerificationGateTerminations,
    maxProgresslessTurns: row.maxProgresslessTurns ?? row.diagnostics?.maxProgresslessTurns ?? DEFAULT_COUNTERS.maxProgresslessTurns,
    replaceFailures: numberish(replaceTotal ?? row.diagnostics?.replaceFailures?.total),
    replaceOldNotFound: row.replaceOldNotFound ?? row.diagnostics?.replaceFailures?.oldNotFound ?? replace.oldNotFound ?? 0,
    replaceAmbiguous: row.replaceAmbiguous ?? row.diagnostics?.replaceFailures?.ambiguous ?? replace.ambiguous ?? 0,
    replaceLineStale: row.replaceLineStale ?? row.diagnostics?.replaceFailures?.lineStale ?? replace.lineStale ?? 0,
    replaceOther: row.replaceOther ?? row.diagnostics?.replaceFailures?.other ?? replace.other ?? 0,
    patchActions: row.patchActions ?? row.actions?.patch ?? row.diagnostics?.patchActions ?? DEFAULT_COUNTERS.patchActions,
    patchFailures: numberish(patchTotal ?? row.diagnostics?.patchFailures?.total),
    patchOldNotFound: row.patchOldNotFound ?? row.diagnostics?.patchFailures?.oldNotFound ?? patch.oldNotFound ?? 0,
    patchAmbiguous: row.patchAmbiguous ?? row.diagnostics?.patchFailures?.ambiguous ?? patch.ambiguous ?? 0,
    patchOverlap: row.patchOverlap ?? row.diagnostics?.patchFailures?.overlap ?? patch.overlap ?? 0,
    patchOther: row.patchOther ?? row.diagnostics?.patchFailures?.other ?? patch.other ?? 0,
  };
}

function emptyTotals() {
  return {
    tasks: 0,
    passed: 0,
    failed: 0,
    unresolved: 0,
    cheated: 0,
    errored: 0,
    turns: 0,
    durationMs: 0,
    ...DEFAULT_COUNTERS,
  };
}

function addTotals(totals, row) {
  for (const key of Object.keys(totals)) {
    if (key === "maxProgresslessTurns") {
      totals[key] = Math.max(totals[key], row[key] ?? 0);
    } else {
      totals[key] += row[key] ?? 0;
    }
  }
  return totals;
}

function rankBottlenecks(totals) {
  const candidates = [
    {
      id: "edit-grounding",
      label: "Edit grounding / grounded replace",
      score: weighted([
        [totals.replaceFailures, 5],
        [totals.patchFailures, 6],
        [totals.replaceOldNotFound, 3],
        [totals.replaceAmbiguous, 2],
        [totals.replaceLineStale, 2],
      ]),
      evidence: `${totals.replaceFailures} replace failures (${totals.replaceOldNotFound} old-not-found, ${totals.replaceAmbiguous} ambiguous, ${totals.replaceLineStale} stale-line); ${totals.patchActions} patch actions with ${totals.patchFailures} failures`,
      next: "Prioritize grounded/copy-constrained edits or stronger edit state.",
    },
    {
      id: "state-grammar",
      label: "State-aware grammar / premature action control",
      score: weighted([[totals.invalid, 4], [totals.protocolViolations, 3], [totals.doneRejections, 7]]),
      evidence: `${totals.invalid} invalid outputs, ${totals.protocolViolations} protocol salvages, ${totals.doneRejections} premature-done rejections`,
      next: "Shrink the legal action space per turn if grammar drift appears.",
    },
    {
      id: "completion-rigor",
      label: "Completion rigor / requirement coverage",
      score: weighted([[totals.ledgerRejections, 8], [totals.secretAuditRejections, 6], [totals.doneRejections, 3]]),
      evidence: `${totals.ledgerRejections} requirement-ledger rejections, ${totals.secretAuditRejections} secret-cleanup audit rejections, ${totals.doneRejections} premature-done rejections`,
      next: "A/B the requirement/secret cleanup gates and inspect misses where self-tests covered only part of the task.",
    },
    {
      id: "static-repair",
      label: "Static repair routing",
      score: weighted([[totals.preGateFails, 4]]),
      evidence: `${totals.preGateFails} pre-gate syntax failures`,
      next: "Route syntax/import failures into focused repair prompts before verifier cycles.",
    },
    {
      id: "shell-ergonomics",
      label: "Shell ergonomics / safer command vocabulary",
      score: weighted([[totals.shellCwdGuards, 3], [totals.workspaceAliasNormalizations, 1], [totals.shellReadGuards, 3], [totals.testPipeGuards, 2], [totals.capabilityHints, 2]]),
      evidence: `${totals.shellCwdGuards} cwd guards, ${totals.workspaceAliasNormalizations} workspace aliases normalized, ${totals.shellReadGuards} shell-read guards, ${totals.testPipeGuards} test-pipe guards, ${totals.capabilityHints} capability hints`,
      next: "Add better command guidance or explicit read/test actions where shell misuse clusters.",
    },
    {
      id: "verifier-signal",
      label: "Verifier signal and repeated-failure recovery",
      score: weighted([[totals.repeatedFailureHints, 5], [totals.outcomeCycleEvents, 2], [totals.outcomeCycleHints, 5], [totals.testDigestHits, 1]]),
      evidence: `${totals.repeatedFailureHints} repeated-failure hints, ${totals.outcomeCycleEvents} repeated outcomes, ${totals.outcomeCycleHints} outcome-cycle hints, ${totals.testDigestHits} test-output digests`,
      next: "Invest in failure taxonomy routing and targeted probes after stable verifier failures.",
    },
    {
      id: "progress-awareness",
      label: "Progress awareness / deliverable pressure",
      score: weighted([[totals.progressGateTerminations, 10], [totals.progressGateRejections, 8], [totals.duplicateActionRejections, 8], [totals.repeatEscapeMasks, 1], [totals.progressNudges, 6], [totals.queryBudgetBlocks, 6], [totals.artifactVerificationGateTerminations, 5], [totals.artifactVerificationGateRejections, 3], [totals.artifactVerificationNudges, 2], [totals.maxProgresslessTurns, 1]]),
      evidence: `${totals.progressNudges} progress nudges, ${totals.progressGateRejections} recon gate rejections, ${totals.queryBudgetBlocks} query-budget blocks, ${totals.duplicateActionRejections} duplicate-action replays, ${totals.repeatEscapeMasks} repeat-escape masks, ${totals.progressGateTerminations} gate terminations, ${totals.artifactVerificationNudges} artifact-check nudges, ${totals.artifactVerificationGateRejections} artifact-check gate rejections, ${totals.artifactVerificationGateTerminations} artifact-check gate terminations, max ${totals.maxProgresslessTurns} progressless turns`,
      next: "Tune recon-to-build intervention thresholds, bounds, and task-specific artifact checks where it clusters.",
    },
    {
      id: "environment",
      label: "Environment / infrastructure reliability",
      score: weighted([[totals.errored, 5], [totals.unresolved, 1]]),
      evidence: `${totals.errored} errored runs, ${totals.unresolved} unresolved runs`,
      next: "Harden workspace/env prep before interpreting model capability numbers.",
    },
    {
      id: "integrity",
      label: "Integrity / anti-cheat pressure",
      score: weighted([[totals.cheated, 6]]),
      evidence: `${totals.cheated} cheated runs`,
      next: "Expand scope guards before using these trajectories for skills or training.",
    },
  ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return candidates.map((b, i) => ({ rank: i + 1, ...b }));
}

function recommendationFor(bottlenecks, totals, freshness = { current: 0, stale: 0, unknown: 0 }) {
  if (!totals.tasks) return "Capture fixture evidence first; no ledger rows were found.";
  if (freshness.current === 0 && freshness.stale > 0) {
    return "Capture fresh eval evidence on the current harness before choosing the next structural investment.";
  }
  const top = bottlenecks[0];
  if (!top || top.score === 0) {
    return totals.failed + totals.unresolved + totals.errored > 0
      ? "Runs failed without current friction counters firing; inspect artifacts and add a new taxonomy bucket."
      : "No dominant loop friction detected; collect harder fixture evidence before heavy structural work.";
  }
  return `${top.label}: ${top.next}`;
}

function weighted(pairs) {
  return pairs.reduce((sum, [value, weight]) => sum + numberish(value) * weight, 0);
}

function numberish(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
