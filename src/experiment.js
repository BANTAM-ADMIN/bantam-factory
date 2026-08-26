import crypto from "node:crypto";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-file.js";
import { EXPERIMENT_BINDING_KIND } from "./pinned-experiment-binding.js";
import {
  enabledOptInGateChanges,
  gateRejectionCounts,
  optInEnabled,
} from "./logic/gate-rejection-counts.js";

const TOP_LEVEL_KEYS = new Set([
  "schema", "name", "description", "fixtures", "rounds", "seeds", "passAtK", "arms",
  "thinkMode", "preGate", "planMode", "stopOnFailure",
]);
const ARM_KEYS = new Set(["name", "description", "env", "model", "skills"]);
const MODEL_KEYS = new Set([
  "endpoint", "profile", "temperature", "actTemperature", "topP", "topK",
  "runtime", "name", "effort", "timeoutMs", "verifyTimeoutMs", "permissionMode", "bypassSandbox",
]);
const THINK_MODES = new Set(["off", "auto", "always"]);
const MODEL_RUNTIMES = new Set(["local", "codex", "api", "native-codex", "native-claude"]);
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_PERMISSION_MODES = new Set(["acceptedits", "auto"]);
const PROMOTION_BINDING_KEYS = new Set([
  "schema",
  "kind",
  "source",
  "channel",
  "laneId",
  "candidateVersionRef",
  "workspaceCommit",
  "workspaceTree",
]);

export function normalizeExperimentSpec(raw) {
  requireObject(raw, "experiment spec");
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "experiment spec");
  const schema = raw.schema ?? 1;
  if (schema !== 1) throw new Error(`unsupported experiment schema: ${schema}`);

  const name = requiredString(raw.name, "experiment name");
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
    throw new Error("experiment fixtures must be a non-empty array");
  }
  const fixtures = uniqueStrings(raw.fixtures, "fixture");
  const rounds = boundedInt(raw.rounds ?? 1, "experiment rounds", 1, 50);
  const seeds = normalizeSeeds(raw.seeds, rounds);
  const passAtK = normalizePassAtK(raw.passAtK, rounds);
  if (!Array.isArray(raw.arms) || raw.arms.length < 1 || raw.arms.length > 8) {
    throw new Error("experiment arms must contain between 1 and 8 entries");
  }
  const arms = raw.arms.map(normalizeArm);
  if (new Set(arms.map((arm) => arm.name)).size !== arms.length) {
    throw new Error("experiment arm names must be unique");
  }

  const thinkMode = raw.thinkMode ?? "auto";
  if (!THINK_MODES.has(thinkMode)) throw new Error(`invalid experiment thinkMode: ${thinkMode}`);
  return {
    schema,
    name,
    description: optionalString(raw.description, "experiment description"),
    fixtures,
    rounds,
    seeds,
    passAtK,
    arms,
    thinkMode,
    preGate: optionalBoolean(raw.preGate, true, "experiment preGate"),
    planMode: optionalBoolean(raw.planMode, false, "experiment planMode"),
    stopOnFailure: optionalBoolean(raw.stopOnFailure, false, "experiment stopOnFailure"),
  };
}

export function buildExperimentSchedule(spec) {
  const normalized = normalizeExperimentSpec(spec);
  const schedule = [];
  let sequence = 0;
  for (let round = 1; round <= normalized.rounds; round++) {
    const offset = (round - 1) % normalized.arms.length;
    const ordered = normalized.arms.slice(offset).concat(normalized.arms.slice(0, offset));
    for (const arm of ordered) {
      schedule.push({
        sequence: sequence++,
        round,
        arm: arm.name,
        seed: normalized.seeds[round - 1] ?? null,
        status: "pending",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        priorDurationMs: 0,
        modelId: null,
        effectiveModel: null,
        inFlight: null,
        interruptedRuns: [],
        runs: [],
        error: null,
      });
    }
  }
  return schedule;
}

export function createExperimentManifest({
  spec,
  id,
  startedAt = new Date().toISOString(),
  harnessGit = null,
  promotionBinding = null,
}) {
  const normalized = normalizeExperimentSpec(spec);
  const experimentId = id || `${filesystemStamp(startedAt)}-${slugify(normalized.name)}`;
  const manifest = {
    schema: 1,
    kind: "bantam-experiment",
    id: experimentId,
    name: normalized.name,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    specSha256: hashJson(normalized),
    spec: normalized,
    harnessGit,
    ...(promotionBinding === null ? {} : {
      promotion: normalizeExperimentPromotionBinding(promotionBinding),
    }),
    resumeHistory: [],
    schedule: buildExperimentSchedule(normalized),
    totals: null,
  };
  manifest.totals = summarizeExperiment(manifest);
  return manifest;
}

export function normalizeExperimentPromotionBinding(raw) {
  requireObject(raw, "experiment promotion binding");
  rejectUnknownKeys(raw, PROMOTION_BINDING_KEYS, "experiment promotion binding");
  for (const key of PROMOTION_BINDING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`experiment promotion binding is missing field: ${key}`);
    }
  }
  if (raw.schema !== 1 || raw.kind !== EXPERIMENT_BINDING_KIND) {
    throw new Error("unsupported experiment promotion binding");
  }
  if (raw.source !== "verified-channel-launch") {
    throw new Error("experiment promotion binding source is not verified");
  }
  const channel = requiredIdentifier(raw.channel, "promotion channel");
  const laneId = requiredIdentifier(raw.laneId, "promotion lane");
  const candidateVersionRef = requiredString(raw.candidateVersionRef, "candidate version ref");
  if (!/^sha256:[a-f0-9]{64}$/.test(candidateVersionRef)) {
    throw new Error(`invalid candidate version ref: ${candidateVersionRef}`);
  }
  const workspaceCommit = requiredString(raw.workspaceCommit, "promotion workspace commit");
  const workspaceTree = requiredString(raw.workspaceTree, "promotion workspace tree");
  if (!/^[a-f0-9]{40,64}$/.test(workspaceCommit)) {
    throw new Error(`invalid promotion workspace commit: ${workspaceCommit}`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(workspaceTree)) {
    throw new Error(`invalid promotion workspace tree: ${workspaceTree}`);
  }
  return {
    schema: 1,
    kind: EXPERIMENT_BINDING_KIND,
    source: "verified-channel-launch",
    channel,
    laneId,
    candidateVersionRef,
    workspaceCommit,
    workspaceTree,
  };
}

export function summarizeExperiment(manifest) {
  const armNames = manifest.spec.arms.map((arm) => arm.name);
  const passAtK = manifest.spec.passAtK ?? [1];
  const arms = Object.fromEntries(armNames.map((name) => [name, emptyArmTotals()]));
  for (const entry of manifest.schedule ?? []) {
    const totals = arms[entry.arm];
    if (!totals) continue;
    if (entry.status === "complete") totals.sweepsCompleted++;
    if (entry.status === "failed") totals.sweepsFailed++;
    if (Number.isFinite(entry.durationMs)) totals.wallMs += entry.durationMs;
    if (Number.isFinite(entry.priorDurationMs)) totals.wallMs += entry.priorDurationMs;
    for (const row of entry.runs ?? []) addRow(totals, row);
  }
  for (const totals of Object.values(arms)) finalizeArmTotals(totals, passAtK);

  const reference = armNames[0];
  const comparisons = armNames.slice(1).map((name) => compareArms(reference, arms[reference], name, arms[name]));
  const orderBalance = experimentOrderBalance(manifest.spec, manifest.schedule);
  return {
    expectedTasksPerArm: manifest.spec.rounds * manifest.spec.fixtures.length,
    balancedOrder: orderBalance.status === "exact",
    orderBalance,
    arms,
    reference,
    comparisons,
  };
}

export function experimentOrderBalance(spec, schedule) {
  const armNames = spec?.arms?.map((arm) => arm.name) ?? [];
  const rounds = Number(spec?.rounds ?? 0);
  if (armNames.length === 0 || rounds < 1) {
    return { status: "invalid", maxPositionImbalance: null, reason: "missing arms or rounds" };
  }
  const armSet = new Set(armNames);
  const counts = Object.fromEntries(armNames.map((arm) => [arm, Array(armNames.length).fill(0)]));
  for (let round = 1; round <= rounds; round++) {
    const entries = (schedule ?? [])
      .filter((entry) => entry.round === round)
      .sort((left, right) => left.sequence - right.sequence);
    if (
      entries.length !== armNames.length
      || new Set(entries.map((entry) => entry.arm)).size !== armNames.length
      || entries.some((entry) => !armSet.has(entry.arm))
    ) {
      return {
        status: "invalid",
        maxPositionImbalance: null,
        reason: `round ${round} does not contain every arm exactly once`,
      };
    }
    entries.forEach((entry, position) => {
      counts[entry.arm][position]++;
    });
  }
  const maxPositionImbalance = Math.max(...Object.values(counts).map((positions) =>
    Math.max(...positions) - Math.min(...positions)));
  const exact = maxPositionImbalance === 0;
  const theoreticalMinimum = rounds % armNames.length === 0 ? 0 : 1;
  return {
    status: exact
      ? "exact"
      : maxPositionImbalance === theoreticalMinimum ? "best-possible" : "imbalanced",
    maxPositionImbalance,
    reason: exact
      ? "every arm appears equally often in every within-round position"
      : maxPositionImbalance === theoreticalMinimum
        ? "rotation reaches the minimum possible imbalance for this round count"
        : "within-round positions are more uneven than necessary",
    positions: counts,
  };
}

export function checkpointExperiment(filePath, manifest, now = new Date().toISOString()) {
  manifest.updatedAt = now;
  manifest.totals = summarizeExperiment(manifest);
  return writeJsonAtomic(filePath, manifest);
}

export function formatExperimentSummary(manifest) {
  const totals = summarizeExperiment(manifest);
  const lines = [
    `# ${manifest.name}`,
    "",
    `Status: ${manifest.status}`,
    `Experiment: \`${manifest.id}\``,
    `Spec SHA-256: \`${manifest.specSha256}\``,
    `Order counterbalancing: ${formatOrderBalance(totals.orderBalance)}`,
    "",
    "| Arm | Sweeps | Tasks | Passed | Strict | Turns | Requests | Native threads | Reused calls | Rebases | Terminal rebases | Post-rebase calls | Delivered prompt | Delivery saved | Delta calls | Input tok | Output tok | Cache hit | Cache miss | Reasoning tok | Prompt chars | Prefix reuse | Added suffix | Replaced suffix | Cost USD | Invalid | Protocol | Duplicates | Shell duplicates | No-op edits | Outcome repeats | Outcome hints | Completion audits | State audits | Masks | Progress rejects | Progress stops | Patch exposed | Patches | Patch failures | File ops exposed | Deletes | Moves | File-op failures | Gen tok | Think tok | Action tok | Task time | Wall time |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of manifest.spec.arms) {
    const t = totals.arms[arm.name];
    lines.push(`| ${arm.name} | ${t.sweepsCompleted} | ${t.tasks} | ${t.passed} | ${t.strict} | ${t.turns} | ${t.requests} | ${t.codexUniqueThreads} | ${t.codexReusedCalls} | ${t.codexRebasedCalls} | ${t.codexTerminalRebasedCalls} | ${t.codexPostRebaseCalls} | ${t.codexDeliveredPromptChars} | ${percent(t.codexPromptSavedRatio)} | ${t.codexPromptDeltaCalls} | ${t.inputTok} | ${t.outputTok} | ${t.cacheHitTok} | ${t.cacheMissTok} | ${t.reasoningTok} | ${t.promptChars} | ${percent(t.promptCommonPrefixRatio)} | ${t.promptAddedSuffixChars} | ${t.promptReplacedSuffixChars} | ${t.costUsd.toFixed(6)} | ${t.invalid} | ${t.protocolViolations} | ${t.duplicateActionRejections} | ${t.duplicateShellRejections} | ${t.noOpEdits} | ${t.outcomeCycleEvents} | ${t.outcomeCycleHints} | ${t.completionAuditHints} | ${t.stateAuditHints} | ${t.repeatEscapeMasks} | ${t.progressGateRejections} | ${t.progressGateTerminations} | ${t.patchAvailableRuns} | ${t.patchActions} | ${t.patchFailures} | ${t.fileOperationAvailableRuns} | ${t.deleteFileActions} | ${t.moveFileActions} | ${t.fileOperationFailures} | ${t.genTok} | ${t.thinkTok} | ${t.actionTok} | ${seconds(t.taskMs)} | ${seconds(t.wallMs)} |`);
  }
  lines.push(
    "",
    "Escalation decisions: "
      + manifest.spec.arms.map((arm) => {
        const actions = totals.arms[arm.name].escalationActions ?? {};
        const rendered = Object.entries(actions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([action, count]) => `${action} ${count}`)
          .join(", ");
        return `${arm.name} ${rendered || "none"}`;
      }).join(" · "),
    "",
    "Codex prompt integrity: "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.codexPromptIntegrityExactCalls}/${t.codexPromptIntegrityAuditedCalls} exact, ${t.codexPromptIntegrityFailures} failures`;
      }).join(" · "),
    "",
    "Complete run integrity: "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        const applicable = t.tasks - t.runArtifactIntegrityNotApplicable;
        return `${arm.name} ${t.runArtifactIntegrityPasses}/${applicable} applicable pass, ${t.runArtifactIntegrityNotApplicable} n/a, ${t.runArtifactIntegrityFailures} failures, ${t.runArtifactIntegrityWarnings} warnings`;
      }).join(" · "),
    ...(manifest.spec.arms.some((arm) => arm.model?.runtime?.startsWith("native-"))
      ? [
          "",
          "Native accounting: provider cache contracts are not billing-equivalent; Claude does not report separate reasoning tokens, so its additive reasoning field is an unmeasured zero placeholder.",
        ]
      : []),
    "",
    "External workspace coherence: "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.externalWorkspaceMutationEvents} events / ${t.externalWorkspaceMutationPaths} paths / ${t.externalWorkspaceMutationBlockedActions} stale actions blocked`;
      }).join(" · "),
    "",
    "Evaluator scope transactions (direct refusals / shell rollbacks / restored files): "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.immutableEditRejections} / ${t.shellScopeRollbacks} / ${t.shellScopeViolationFiles}`;
      }).join(" · "),
    "",
    "Visual completion audit interventions (hints / alt revisions): "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.visualCompletionAuditHints} / ${t.visualCompletionAuditRevisions}`;
      }).join(" · "),
    "",
    "Lexical contract audit interventions: "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.lexicalContractAuditHints}`;
      }).join(" · "),
    "",
    "Visual alt coverage interventions (hints / alt revisions): "
      + manifest.spec.arms.map((arm) => {
        const t = totals.arms[arm.name];
        return `${arm.name} ${t.visualAltCoverageHints} / ${t.visualAltCoverageRevisions}`;
      }).join(" · "),
  );
  const referenceArm = manifest.spec.arms.find((arm) => arm.name === totals.reference);
  const attribution = manifest.spec.arms
    .filter((arm) => arm.name !== totals.reference)
    .flatMap((arm) => enabledOptInGateChanges(referenceArm, arm)
      .map((change) => ({
        arm: arm.name,
        ...change,
        rejections: totals.arms[arm.name].gateRejections[change.gate] ?? 0,
      })));
  const reportedGates = [...new Set([
    ...manifest.spec.arms.flatMap((arm) => Object.keys(totals.arms[arm.name].gateRejections)),
    ...attribution.map((row) => row.gate),
  ])].sort();
  if (reportedGates.length) {
    lines.push(
      "",
      "## Gate interventions",
      "",
      "| Arm | Gate | Rejections |",
      "| --- | --- | ---: |",
    );
    for (const arm of manifest.spec.arms) {
      for (const gate of reportedGates) {
        lines.push(`| ${arm.name} | ${gate} | ${totals.arms[arm.name].gateRejections[gate] ?? 0} |`);
      }
    }
  }
  const inactive = attribution.filter((row) => row.rejections === 0);
  for (const arm of manifest.spec.arms.filter((item) => item.name !== totals.reference)) {
    if (
      !optInEnabled(referenceArm?.env?.BANTAM_VISUAL_COMPLETION_AUDIT)
      && optInEnabled(arm?.env?.BANTAM_VISUAL_COMPLETION_AUDIT)
      && totals.arms[arm.name].visualCompletionAuditRevisions === 0
    ) {
      inactive.push({
        arm: arm.name,
        env: "BANTAM_VISUAL_COMPLETION_AUDIT",
        gate: "visual_completion_audit",
        rejections: 0,
      });
    }
    if (
      !optInEnabled(referenceArm?.env?.BANTAM_LEXICAL_CONTRACT_AUDIT)
      && optInEnabled(arm?.env?.BANTAM_LEXICAL_CONTRACT_AUDIT)
      && totals.arms[arm.name].lexicalContractAuditHints === 0
    ) {
      inactive.push({
        arm: arm.name,
        env: "BANTAM_LEXICAL_CONTRACT_AUDIT",
        gate: "lexical_contract_audit",
        rejections: 0,
      });
    }
    if (
      !optInEnabled(referenceArm?.env?.BANTAM_VISUAL_ALT_COVERAGE)
      && optInEnabled(arm?.env?.BANTAM_VISUAL_ALT_COVERAGE)
      && totals.arms[arm.name].visualAltCoverageRevisions === 0
    ) {
      inactive.push({
        arm: arm.name,
        env: "BANTAM_VISUAL_ALT_COVERAGE",
        gate: "visual_alt_coverage",
        rejections: 0,
      });
    }
  }
  if (inactive.length) {
    lines.push(
      "",
      "## Attribution warnings",
      "",
      ...inactive.map((row) => (
        `- \`${row.arm}\` enabled \`${row.env}\`, but \`${row.gate}\` recorded 0 causal interventions. `
        + "Observed quality and efficiency deltas are non-attributable to that mechanism."
      )),
    );
  }
  const usageSources = [...new Set(manifest.spec.arms.flatMap(
    (arm) => Object.keys(totals.arms[arm.name].usageBySource ?? {}),
  ))].sort();
  if (usageSources.length) {
    lines.push(
      "",
      "## Usage by source",
      "",
      "| Arm | Source | Requests | Input tok | Output tok | Cache hit | Cache miss | Reasoning tok |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const arm of manifest.spec.arms) {
      for (const source of usageSources) {
        const usage = totals.arms[arm.name].usageBySource?.[source];
        if (!usage?.requests) continue;
        lines.push(`| ${arm.name} | ${source} | ${usage.requests} | ${usage.inputTokens} | ${usage.outputTokens} | ${usage.cacheHitTokens} | ${usage.cacheMissTokens} | ${usage.reasoningTokens} |`);
      }
    }
  }
  const toolStatuses = [...new Set(manifest.spec.arms.flatMap(
    (arm) => Object.keys(totals.arms[arm.name].toolOutcomeCounts ?? {}),
  ))].sort();
  if (toolStatuses.length) {
    lines.push(
      "",
      "## Tool outcomes",
      "",
      `| Arm | ${toolStatuses.join(" | ")} |`,
      `| --- | ${toolStatuses.map(() => "---:").join(" | ")} |`,
    );
    for (const arm of manifest.spec.arms) {
      const counts = totals.arms[arm.name].toolOutcomeCounts ?? {};
      lines.push(`| ${arm.name} | ${toolStatuses.map((status) => counts[status] ?? 0).join(" | ")} |`);
    }
  }
  const failedRuns = (manifest.schedule ?? []).flatMap((entry) => (entry.runs ?? [])
    .filter((row) => row.status !== "pass")
    .map((row) => ({ entry, row })));
  if (failedRuns.length) {
    lines.push(
      "",
      "## Failure evidence",
      "",
      "| Arm | Round | Fixture | Status | Contract | Artifact |",
      "| --- | ---: | --- | --- | --- | --- |",
    );
    for (const { entry, row } of failedRuns) {
      const contract = row.contractStatus
        ? `${row.contractStatus} (${row.contractPassed ?? 0}/${row.contractTests ?? 0} passed)`
        : "n/a";
      const artifact = row.artifactPath ? `[open](${row.artifactPath})` : "unavailable";
      lines.push(`| ${entry.arm} | ${entry.round} | ${row.name ?? "unknown"} | ${row.status ?? "unknown"} | ${contract} | ${artifact} |`);
    }
  }
  const archivedCount = manifest.spec.arms.reduce(
    (sum, arm) => sum + (totals.arms[arm.name].archivedAttachments ?? 0),
    0,
  );
  if (archivedCount) {
    const attachmentRows = manifest.schedule.flatMap((entry) => (entry.runs ?? [])
      .filter((row) => row.attachmentIndexPath)
      .map((row) => ({ arm: entry.arm, row })));
    lines.push(
      "",
      "## Archived generated evidence",
      "",
      "| Arm | Fixture | Files | Bytes | Evidence |",
      "| --- | --- | ---: | ---: | --- |",
    );
    for (const { arm, row } of attachmentRows) {
      const base = path.posix.dirname(String(row.artifactPath));
      const index = path.posix.join(base, String(row.attachmentIndexPath));
      const contacts = (row.archivedAttachmentFiles ?? [])
        .filter((file) => file.endsWith(".html"))
        .map((file, i) => `[contact sheet ${i + 1}](${path.posix.join(base, file)})`);
      lines.push(`| ${arm} | ${row.name} | ${row.archivedAttachments} | ${row.archivedAttachmentBytes} | [index](${index})${contacts.length ? ` · ${contacts.join(" · ")}` : ""} |`);
    }
  }
  const passAtK = manifest.spec.passAtK ?? [1];
  lines.push(
    "",
    "## Reliability",
    "",
    "Wilson 95% intervals describe observed binary runs; they do not account for fixture-selection bias.",
    "",
    `| Arm | Runs | Pass rate | Wilson 95% | ${passAtK.map((k) => `pass@${k}`).join(" | ")} |`,
    `| --- | ---: | ---: | ---: | ${passAtK.map(() => "---:").join(" | ")} |`,
  );
  for (const arm of manifest.spec.arms) {
    const totalsForArm = totals.arms[arm.name];
    lines.push(`| ${arm.name} | ${totalsForArm.tasks} | ${percent(totalsForArm.passRate)} | ${formatInterval(totalsForArm.passRate95)} | ${totalsForArm.passAtK.map(formatPassAtK).join(" | ")} |`);
  }
  for (const arm of manifest.spec.arms) {
    const totalsForArm = totals.arms[arm.name];
    lines.push(
      "",
      `### ${arm.name}`,
      "",
      `| Fixture | Runs | Passed | Turns | Requests | Input tok | Output tok | Cache hit | Reasoning tok | Duplicates | Masks | Progress rejects | Progress stops | Outcome repeats | Outcome hints | Completion audits | State audits | Gen tok | Think tok | Action tok | Task time | Pass rate | Wilson 95% | ${passAtK.map((k) => `pass@${k}`).join(" | ")} |`,
      `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ${passAtK.map(() => "---:").join(" | ")} |`,
    );
    for (const [fixture, fixtureTotals] of Object.entries(totalsForArm.fixtures)) {
      lines.push(`| ${fixture} | ${fixtureTotals.attempts} | ${fixtureTotals.passed} | ${fixtureTotals.turns} | ${fixtureTotals.requests} | ${fixtureTotals.inputTok} | ${fixtureTotals.outputTok} | ${fixtureTotals.cacheHitTok} | ${fixtureTotals.reasoningTok} | ${fixtureTotals.duplicateActionRejections} | ${fixtureTotals.repeatEscapeMasks} | ${fixtureTotals.progressGateRejections} | ${fixtureTotals.progressGateTerminations} | ${fixtureTotals.outcomeCycleEvents} | ${fixtureTotals.outcomeCycleHints} | ${fixtureTotals.completionAuditHints} | ${fixtureTotals.stateAuditHints} | ${fixtureTotals.genTok} | ${fixtureTotals.thinkTok} | ${fixtureTotals.actionTok} | ${seconds(fixtureTotals.taskMs)} | ${percent(fixtureTotals.passRate)} | ${formatInterval(fixtureTotals.passRate95)} | ${passAtK.map((k) => percent(fixtureTotals.passAtK[k])).join(" | ")} |`);
    }
  }
  if (totals.comparisons.length) {
    lines.push("", `Reference arm: \`${totals.reference}\``, "");
    for (const comparison of totals.comparisons) {
      lines.push(`- \`${comparison.arm}\` minus \`${comparison.reference}\`: pass ${signed(comparison.delta.passed)}, pass rate ${signedPercent(comparison.delta.passRate)}, strict ${signed(comparison.delta.strict)}, turns ${signed(comparison.delta.turns)}, requests ${signed(comparison.delta.requests)}, input tokens ${signed(comparison.delta.inputTok)}, output tokens ${signed(comparison.delta.outputTok)}, cache hits ${signed(comparison.delta.cacheHitTok)}, reasoning tokens ${signed(comparison.delta.reasoningTok)}, generated tokens ${signed(comparison.delta.genTok)} (think ${signed(comparison.delta.thinkTok)}, action ${signed(comparison.delta.actionTok)}), duplicate action replays ${signed(comparison.delta.duplicateActionRejections)}, shell duplicate replays ${signed(comparison.delta.duplicateShellRejections)}, immutable edit refusals ${signed(comparison.delta.immutableEditRejections)}, shell scope rollbacks ${signed(comparison.delta.shellScopeRollbacks)}, restored scope files ${signed(comparison.delta.shellScopeViolationFiles)}, no-op edits ${signed(comparison.delta.noOpEdits)}, outcome repeats ${signed(comparison.delta.outcomeCycleEvents)}, outcome hints ${signed(comparison.delta.outcomeCycleHints)}, completion audits ${signed(comparison.delta.completionAuditHints)}, lexical audits ${signed(comparison.delta.lexicalContractAuditHints)}, visual audits ${signed(comparison.delta.visualCompletionAuditHints)}, visual audit alt revisions ${signed(comparison.delta.visualCompletionAuditRevisions)}, visual coverage hints ${signed(comparison.delta.visualAltCoverageHints)}, visual coverage alt revisions ${signed(comparison.delta.visualAltCoverageRevisions)}, state audits ${signed(comparison.delta.stateAuditHints)}, external change events ${signed(comparison.delta.externalWorkspaceMutationEvents)}, external paths ${signed(comparison.delta.externalWorkspaceMutationPaths)}, stale actions blocked ${signed(comparison.delta.externalWorkspaceMutationBlockedActions)}, progress rejects ${signed(comparison.delta.progressGateRejections)}, progress stops ${signed(comparison.delta.progressGateTerminations)}, patch exposure ${signed(comparison.delta.patchAvailableRuns)}, patches ${signed(comparison.delta.patchActions)}, patch failures ${signed(comparison.delta.patchFailures)}, file-op exposure ${signed(comparison.delta.fileOperationAvailableRuns)}, deletes ${signed(comparison.delta.deleteFileActions)}, moves ${signed(comparison.delta.moveFileActions)}, file-op failures ${signed(comparison.delta.fileOperationFailures)}, task time ${signedSeconds(comparison.delta.taskMs)}, wall time ${signedSeconds(comparison.delta.wallMs)}.`);
      lines.push(`- Pass@k deltas: ${Object.values(comparison.passAtK).map((item) => `pass@${item.k} ${signedPercent(item.delta)}`).join(", ")}.`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function saveExperimentSummary(filePath, manifest) {
  return writeTextAtomic(filePath, formatExperimentSummary(manifest));
}

export function slugify(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "experiment";
}

export function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function estimatePassAtK(total, correct, k) {
  if (!Number.isInteger(total) || !Number.isInteger(correct) || !Number.isInteger(k)) return null;
  if (total < 0 || correct < 0 || correct > total || k < 1 || k > total) return null;
  if (correct === 0) return 0;
  if (total - correct < k) return 1;
  let allIncorrect = 1;
  for (let i = 0; i < k; i++) allIncorrect *= (total - correct - i) / (total - i);
  return 1 - allIncorrect;
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) {
    return { low: null, high: null };
  }
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function normalizeArm(raw, index) {
  requireObject(raw, `arm ${index + 1}`);
  rejectUnknownKeys(raw, ARM_KEYS, `arm ${index + 1}`);
  const name = requiredString(raw.name, `arm ${index + 1} name`);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`invalid arm name: ${name}; use lowercase letters, digits, _ or -`);
  }
  return {
    name,
    description: optionalString(raw.description, `${name} description`),
    env: normalizeEnv(raw.env, name),
    model: normalizeModel(raw.model, name),
    skills: normalizeArmSkills(raw.skills, name),
  };
}

// Per-arm skills-library exposure. `true` uses the checkout's default library;
// `{library: "path"}` pins an explicit file — the reproducible choice for
// experiments, since the default library grows as runs distill new skills.
// Retrieval-only semantics are enforced by the runner, not here: distillation
// during an experiment would mutate the library mid-run and leak lessons
// across arms and rounds.
function normalizeArmSkills(raw, armName) {
  if (raw === undefined || raw === false || raw === null) return null;
  if (raw === true) return { library: null };
  requireObject(raw, `${armName} skills`);
  rejectUnknownKeys(raw, new Set(["library"]), `${armName} skills`);
  return { library: requiredString(raw.library, `${armName} skills library`) };
}

function normalizeSeeds(raw, rounds) {
  // `normalizeExperimentSpec()` emits [] for an intentionally unseeded
  // experiment. Accept that canonical value when a normalized spec is passed
  // back through schedule/manifest construction.
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw) || raw.length !== rounds) {
    throw new Error(`experiment seeds must contain one seed per round (${rounds})`);
  }
  const seeds = raw.map((value, index) => boundedInt(value, `experiment seed ${index + 1}`, 0, 0xFFFFFFFE));
  if (new Set(seeds).size !== seeds.length) throw new Error("experiment seeds must be unique");
  return seeds;
}

function normalizePassAtK(raw, rounds) {
  if (raw === undefined) return [1];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("experiment passAtK must be a non-empty array");
  const values = raw.map((value, index) => boundedInt(value, `experiment passAtK ${index + 1}`, 1, rounds));
  if (new Set(values).size !== values.length) throw new Error("experiment passAtK entries must be unique");
  return values.sort((a, b) => a - b);
}

function normalizeEnv(raw, armName) {
  if (raw === undefined) return {};
  requireObject(raw, `${armName} env`);
  const out = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (!/^BANTAM_[A-Z0-9_]+$/.test(key)) throw new Error(`invalid experiment env key: ${key}`);
    if (value === null) out[key] = null;
    else if (["string", "number", "boolean"].includes(typeof value)) out[key] = String(value);
    else throw new Error(`experiment env ${key} must be a string, number, boolean, or null`);
  }
  return out;
}

function normalizeModel(raw, armName) {
  if (raw === undefined) return {};
  requireObject(raw, `${armName} model`);
  rejectUnknownKeys(raw, MODEL_KEYS, `${armName} model`);
  const out = {};
  for (const key of ["endpoint", "profile", "name"]) {
    if (raw[key] !== undefined) out[key] = requiredString(raw[key], `${armName} model ${key}`);
  }
  if (raw.runtime !== undefined) {
    const runtime = requiredString(raw.runtime, `${armName} model runtime`).toLowerCase();
    if (!MODEL_RUNTIMES.has(runtime)) throw new Error(`invalid ${armName} model runtime: ${runtime}`);
    out.runtime = runtime;
  }
  if (raw.effort !== undefined) {
    const effort = requiredString(raw.effort, `${armName} model effort`).toLowerCase();
    const validEfforts = out.runtime === "native-claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
    if (!validEfforts.has(effort)) throw new Error(`invalid ${armName} model effort: ${effort}`);
    out.effort = effort;
  }
  if (["codex", "native-codex", "native-claude"].includes(out.runtime) && !out.name) {
    throw new Error(`${armName} ${out.runtime} model requires model.name`);
  }
  if (out.effort && !["codex", "native-codex", "native-claude"].includes(out.runtime)) {
    throw new Error(`${armName} model effort is only valid for Codex or native Claude runtimes`);
  }
  if (raw.permissionMode !== undefined) {
    if (out.runtime !== "native-claude") {
      throw new Error(`${armName} model permissionMode is only valid for native-claude`);
    }
    const compact = requiredString(raw.permissionMode, `${armName} model permissionMode`)
      .replace(/[-_\s]/g, "")
      .toLowerCase();
    if (!CLAUDE_PERMISSION_MODES.has(compact)) {
      throw new Error(`invalid ${armName} model permissionMode: ${raw.permissionMode}`);
    }
    out.permissionMode = compact === "acceptedits" ? "acceptEdits" : "auto";
  }
  if (raw.bypassSandbox !== undefined) {
    if (out.runtime !== "native-codex") {
      throw new Error(`${armName} model bypassSandbox is only valid for native-codex`);
    }
    out.bypassSandbox = optionalBoolean(raw.bypassSandbox, false, `${armName} model bypassSandbox`);
  }
  for (const key of ["temperature", "topP"]) {
    if (raw[key] === undefined) continue;
    const value = finiteNumber(raw[key], `${armName} model ${key}`);
    if (value < 0 || (key === "topP" && (value <= 0 || value > 1))) {
      throw new Error(`invalid ${armName} model ${key}: ${value}`);
    }
    out[key] = value;
  }
  if (raw.actTemperature !== undefined) {
    if (raw.actTemperature === null) out.actTemperature = null;
    else {
      const value = finiteNumber(raw.actTemperature, `${armName} model actTemperature`);
      if (value < 0) throw new Error(`invalid ${armName} model actTemperature: ${value}`);
      out.actTemperature = value;
    }
  }
  if (raw.topK !== undefined) out.topK = boundedInt(raw.topK, `${armName} model topK`, 0, 100000);
  if (raw.timeoutMs !== undefined) out.timeoutMs = boundedInt(raw.timeoutMs, `${armName} model timeoutMs`, 100, 3_600_000);
  if (raw.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = boundedInt(raw.verifyTimeoutMs, `${armName} model verifyTimeoutMs`, 100, 3_600_000);
  return out;
}

function emptyArmTotals() {
  return {
    sweepsCompleted: 0,
    sweepsFailed: 0,
    tasks: 0,
    passed: 0,
    strict: 0,
    failed: 0,
    unresolved: 0,
    cheated: 0,
    errored: 0,
    turns: 0,
    thinkPhases: 0,
    genTok: 0,
    thinkTok: 0,
    actionTok: 0,
    requests: 0,
    inputTok: 0,
    outputTok: 0,
    cacheHitTok: 0,
    cacheMissTok: 0,
    reasoningTok: 0,
    usageBySource: {},
    toolOutcomeCounts: {},
    escalationActions: {},
    archivedAttachments: 0,
    archivedAttachmentBytes: 0,
    codexThreadCalls: 0,
    codexUniqueThreads: 0,
    codexReusedCalls: 0,
    codexRebasedCalls: 0,
    codexTerminalRebasedCalls: 0,
    codexPostRebaseCalls: 0,
    codexCanonicalPromptChars: 0,
    codexDeliveredPromptChars: 0,
    codexPromptSavedChars: 0,
    codexPromptSavedRatio: null,
    codexPromptDeltaCalls: 0,
    codexPromptFallbackCalls: 0,
    codexPromptRebaseCalls: 0,
    codexPromptMinDeltaSavedRatio: null,
    codexPromptLowSavingsDeltaCalls: 0,
    codexPromptIntegrityAuditedCalls: 0,
    codexPromptIntegrityExactCalls: 0,
    codexPromptIntegrityFailures: 0,
    runArtifactIntegrityPasses: 0,
    runArtifactIntegrityNotApplicable: 0,
    runArtifactIntegrityFailures: 0,
    runArtifactIntegrityWarnings: 0,
    costUsd: 0,
    promptCalls: 0,
    promptChars: 0,
    promptComparableChars: 0,
    promptCommonPrefixChars: 0,
    promptCommonPrefixRatio: null,
    promptAddedSuffixChars: 0,
    promptReplacedSuffixChars: 0,
    promptFirstChangedSections: {},
    invalid: 0,
    protocolViolations: 0,
    duplicateActionRejections: 0,
    duplicateShellRejections: 0,
    immutableEditRejections: 0,
    shellScopeRollbacks: 0,
    shellScopeViolationFiles: 0,
    noOpEdits: 0,
    outcomeCycleEvents: 0,
    outcomeCycleHints: 0,
    completionAuditHints: 0,
    lexicalContractAuditHints: 0,
    visualCompletionAuditHints: 0,
    visualCompletionAuditRevisions: 0,
    visualAltCoverageHints: 0,
    visualAltCoverageRevisions: 0,
    stateAuditHints: 0,
    externalWorkspaceMutationEvents: 0,
    externalWorkspaceMutationPaths: 0,
    externalWorkspaceMutationBlockedActions: 0,
    gateRejections: {},
    repeatEscapeMasks: 0,
    progressGateRejections: 0,
    progressGateTerminations: 0,
    patchActions: 0,
    patchFailures: 0,
    patchAvailableRuns: 0,
    deleteFileActions: 0,
    moveFileActions: 0,
    fileOperationFailures: 0,
    fileOperationAvailableRuns: 0,
    scopeViolations: 0,
    taskMs: 0,
    wallMs: 0,
    passRate: null,
    passRate95: { low: null, high: null },
    passAtK: [],
    fixtures: {},
  };
}

function addRow(totals, row) {
  totals.tasks++;
  if (row.status === "pass") totals.passed++;
  else if (row.status === "fail") totals.failed++;
  else if (row.status === "cheated") totals.cheated++;
  else if (row.status === "error") totals.errored++;
  else totals.unresolved++;
  if (row.status === "pass" && (row.invalid ?? 0) === 0 && (row.protocolViolations ?? 0) === 0) totals.strict++;
  totals.turns += row.turns ?? 0;
  totals.thinkPhases += row.thinkPhases ?? 0;
  totals.genTok += row.genTok ?? 0;
  totals.thinkTok += row.thinkTok ?? 0;
  totals.actionTok += row.actionTok ?? 0;
  totals.requests += row.requests ?? 0;
  totals.inputTok += row.inputTok ?? 0;
  totals.outputTok += row.outputTok ?? 0;
  totals.cacheHitTok += row.cacheHitTok ?? 0;
  totals.cacheMissTok += row.cacheMissTok ?? 0;
  totals.reasoningTok += row.reasoningTok ?? 0;
  mergeUsageBySource(totals.usageBySource, row.usageBySource);
  mergeCounts(totals.toolOutcomeCounts, row.toolOutcomeCounts);
  if (row.escalation?.action) mergeCounts(totals.escalationActions, { [row.escalation.action]: 1 });
  totals.archivedAttachments += row.archivedAttachments ?? 0;
  totals.archivedAttachmentBytes += row.archivedAttachmentBytes ?? 0;
  totals.codexThreadCalls += row.codexThreadCalls ?? 0;
  totals.codexUniqueThreads += row.codexUniqueThreads ?? 0;
  totals.codexReusedCalls += row.codexReusedCalls ?? 0;
  totals.codexRebasedCalls += row.codexRebasedCalls ?? 0;
  totals.codexTerminalRebasedCalls += row.codexTerminalRebasedCalls ?? 0;
  totals.codexPostRebaseCalls += row.codexPostRebaseCalls ?? 0;
  totals.codexCanonicalPromptChars += row.codexCanonicalPromptChars ?? 0;
  totals.codexDeliveredPromptChars += row.codexDeliveredPromptChars ?? 0;
  totals.codexPromptSavedChars += row.codexPromptSavedChars ?? 0;
  totals.codexPromptSavedRatio = totals.codexCanonicalPromptChars > 0
    ? totals.codexPromptSavedChars / totals.codexCanonicalPromptChars
    : null;
  totals.codexPromptDeltaCalls += row.codexPromptDeltaCalls ?? 0;
  totals.codexPromptFallbackCalls += row.codexPromptFallbackCalls ?? 0;
  totals.codexPromptRebaseCalls += row.codexPromptRebaseCalls ?? 0;
  if (Number.isFinite(row.codexPromptMinDeltaSavedRatio)) {
    totals.codexPromptMinDeltaSavedRatio = totals.codexPromptMinDeltaSavedRatio === null
      ? row.codexPromptMinDeltaSavedRatio
      : Math.min(totals.codexPromptMinDeltaSavedRatio, row.codexPromptMinDeltaSavedRatio);
  }
  totals.codexPromptLowSavingsDeltaCalls += row.codexPromptLowSavingsDeltaCalls ?? 0;
  totals.codexPromptIntegrityAuditedCalls += row.codexPromptIntegrityAuditedCalls ?? 0;
  totals.codexPromptIntegrityExactCalls += row.codexPromptIntegrityExactCalls ?? 0;
  totals.codexPromptIntegrityFailures += row.codexPromptIntegrityFailures ?? 0;
  totals.runArtifactIntegrityPasses += row.runArtifactIntegrityStatus === "pass" ? 1 : 0;
  totals.runArtifactIntegrityNotApplicable += row.runArtifactIntegrityStatus === "not-applicable" ? 1 : 0;
  totals.runArtifactIntegrityFailures += row.runArtifactIntegrityFailures ?? 0;
  totals.runArtifactIntegrityWarnings += row.runArtifactIntegrityWarnings ?? 0;
  totals.costUsd += row.costUsd ?? 0;
  totals.promptCalls += row.promptCalls ?? 0;
  totals.promptChars += row.promptChars ?? 0;
  totals.promptComparableChars += row.promptComparableChars ?? 0;
  totals.promptCommonPrefixChars += row.promptCommonPrefixChars ?? 0;
  totals.promptCommonPrefixRatio = totals.promptComparableChars
    ? totals.promptCommonPrefixChars / totals.promptComparableChars
    : null;
  totals.promptAddedSuffixChars += row.promptAddedSuffixChars ?? 0;
  totals.promptReplacedSuffixChars += row.promptReplacedSuffixChars ?? 0;
  mergeCounts(totals.promptFirstChangedSections, row.promptFirstChangedSections);
  totals.invalid += row.invalid ?? 0;
  totals.protocolViolations += row.protocolViolations ?? 0;
  totals.duplicateActionRejections += row.duplicateActionRejections ?? 0;
  totals.duplicateShellRejections += row.duplicateShellRejections ?? 0;
  totals.immutableEditRejections += row.immutableEditRejections ?? 0;
  totals.shellScopeRollbacks += row.shellScopeRollbacks ?? 0;
  totals.shellScopeViolationFiles += row.shellScopeViolationFiles ?? 0;
  totals.noOpEdits += row.noOpEdits ?? 0;
  totals.outcomeCycleEvents += row.outcomeCycleEvents ?? 0;
  totals.outcomeCycleHints += row.outcomeCycleHints ?? 0;
  totals.completionAuditHints += row.completionAuditHints ?? 0;
  totals.lexicalContractAuditHints += row.lexicalContractAuditHints ?? 0;
  totals.visualCompletionAuditHints += row.visualCompletionAuditHints ?? 0;
  totals.visualCompletionAuditRevisions += row.visualCompletionAuditRevisions ?? 0;
  totals.visualAltCoverageHints += row.visualAltCoverageHints ?? 0;
  totals.visualAltCoverageRevisions += row.visualAltCoverageRevisions ?? 0;
  totals.stateAuditHints += row.stateAuditHints ?? 0;
  totals.externalWorkspaceMutationEvents += row.externalWorkspaceMutationEvents ?? 0;
  totals.externalWorkspaceMutationPaths += row.externalWorkspaceMutationPaths ?? 0;
  totals.externalWorkspaceMutationBlockedActions += row.externalWorkspaceMutationBlockedActions ?? 0;
  mergeCounts(totals.gateRejections, row.gateRejections ?? gateRejectionCounts(row));
  totals.repeatEscapeMasks += row.repeatEscapeMasks ?? 0;
  totals.progressGateRejections += row.progressGateRejections ?? 0;
  totals.progressGateTerminations += row.progressGateTerminations ?? 0;
  totals.patchActions += row.patchActions ?? 0;
  totals.patchFailures += row.patchFailures ?? 0;
  totals.patchAvailableRuns += row.patchActionAvailable ? 1 : 0;
  totals.deleteFileActions += row.deleteFileActions ?? 0;
  totals.moveFileActions += row.moveFileActions ?? 0;
  totals.fileOperationFailures += row.fileOperationFailures ?? 0;
  totals.fileOperationAvailableRuns += row.fileOperationAvailable ? 1 : 0;
  totals.scopeViolations += row.scopeViolations ?? 0;
  totals.taskMs += row.durationMs ?? 0;
  const fixture = String(row.name ?? "unknown");
  const fixtureTotals = totals.fixtures[fixture] ??= {
    attempts: 0,
    passed: 0,
    turns: 0,
    duplicateActionRejections: 0,
    repeatEscapeMasks: 0,
    progressGateRejections: 0,
    progressGateTerminations: 0,
    outcomeCycleEvents: 0,
    outcomeCycleHints: 0,
    completionAuditHints: 0,
    lexicalContractAuditHints: 0,
    visualCompletionAuditHints: 0,
    visualCompletionAuditRevisions: 0,
    visualAltCoverageHints: 0,
    visualAltCoverageRevisions: 0,
    stateAuditHints: 0,
    externalWorkspaceMutationEvents: 0,
    externalWorkspaceMutationPaths: 0,
    externalWorkspaceMutationBlockedActions: 0,
    genTok: 0,
    thinkTok: 0,
    actionTok: 0,
    requests: 0,
    inputTok: 0,
    outputTok: 0,
    cacheHitTok: 0,
    cacheMissTok: 0,
    reasoningTok: 0,
    costUsd: 0,
    promptCalls: 0,
    promptChars: 0,
    promptComparableChars: 0,
    promptCommonPrefixChars: 0,
    promptCommonPrefixRatio: null,
    promptAddedSuffixChars: 0,
    promptReplacedSuffixChars: 0,
    promptFirstChangedSections: {},
    taskMs: 0,
  };
  fixtureTotals.attempts++;
  fixtureTotals.turns += row.turns ?? 0;
  fixtureTotals.duplicateActionRejections += row.duplicateActionRejections ?? 0;
  fixtureTotals.repeatEscapeMasks += row.repeatEscapeMasks ?? 0;
  fixtureTotals.progressGateRejections += row.progressGateRejections ?? 0;
  fixtureTotals.progressGateTerminations += row.progressGateTerminations ?? 0;
  fixtureTotals.outcomeCycleEvents += row.outcomeCycleEvents ?? 0;
  fixtureTotals.outcomeCycleHints += row.outcomeCycleHints ?? 0;
  fixtureTotals.completionAuditHints += row.completionAuditHints ?? 0;
  fixtureTotals.lexicalContractAuditHints += row.lexicalContractAuditHints ?? 0;
  fixtureTotals.visualCompletionAuditHints += row.visualCompletionAuditHints ?? 0;
  fixtureTotals.visualCompletionAuditRevisions += row.visualCompletionAuditRevisions ?? 0;
  fixtureTotals.visualAltCoverageHints += row.visualAltCoverageHints ?? 0;
  fixtureTotals.visualAltCoverageRevisions += row.visualAltCoverageRevisions ?? 0;
  fixtureTotals.stateAuditHints += row.stateAuditHints ?? 0;
  fixtureTotals.externalWorkspaceMutationEvents += row.externalWorkspaceMutationEvents ?? 0;
  fixtureTotals.externalWorkspaceMutationPaths += row.externalWorkspaceMutationPaths ?? 0;
  fixtureTotals.externalWorkspaceMutationBlockedActions += row.externalWorkspaceMutationBlockedActions ?? 0;
  fixtureTotals.genTok += row.genTok ?? 0;
  fixtureTotals.thinkTok += row.thinkTok ?? 0;
  fixtureTotals.actionTok += row.actionTok ?? 0;
  fixtureTotals.requests += row.requests ?? 0;
  fixtureTotals.inputTok += row.inputTok ?? 0;
  fixtureTotals.outputTok += row.outputTok ?? 0;
  fixtureTotals.cacheHitTok += row.cacheHitTok ?? 0;
  fixtureTotals.cacheMissTok += row.cacheMissTok ?? 0;
  fixtureTotals.reasoningTok += row.reasoningTok ?? 0;
  fixtureTotals.costUsd += row.costUsd ?? 0;
  fixtureTotals.promptCalls += row.promptCalls ?? 0;
  fixtureTotals.promptChars += row.promptChars ?? 0;
  fixtureTotals.promptComparableChars += row.promptComparableChars ?? 0;
  fixtureTotals.promptCommonPrefixChars += row.promptCommonPrefixChars ?? 0;
  fixtureTotals.promptCommonPrefixRatio = fixtureTotals.promptComparableChars
    ? fixtureTotals.promptCommonPrefixChars / fixtureTotals.promptComparableChars
    : null;
  fixtureTotals.promptAddedSuffixChars += row.promptAddedSuffixChars ?? 0;
  fixtureTotals.promptReplacedSuffixChars += row.promptReplacedSuffixChars ?? 0;
  mergeCounts(fixtureTotals.promptFirstChangedSections, row.promptFirstChangedSections);
  fixtureTotals.taskMs += row.durationMs ?? 0;
  if (row.status === "pass") fixtureTotals.passed++;
}

function finalizeArmTotals(totals, passAtK) {
  totals.passRate = totals.tasks > 0 ? totals.passed / totals.tasks : null;
  totals.passRate95 = wilsonInterval(totals.passed, totals.tasks);
  const fixtures = Object.fromEntries(Object.entries(totals.fixtures).sort(([a], [b]) => a.localeCompare(b)));
  totals.fixtures = fixtures;
  for (const fixtureTotals of Object.values(fixtures)) {
    fixtureTotals.passRate = fixtureTotals.passed / fixtureTotals.attempts;
    fixtureTotals.passRate95 = wilsonInterval(fixtureTotals.passed, fixtureTotals.attempts);
    fixtureTotals.passAtK = Object.fromEntries(passAtK.map((k) => [k, estimatePassAtK(fixtureTotals.attempts, fixtureTotals.passed, k)]));
  }
  totals.passAtK = passAtK.map((k) => {
    const eligible = Object.entries(fixtures)
      .filter(([, fixtureTotals]) => fixtureTotals.passAtK[k] !== null);
    const estimates = eligible.map(([, fixtureTotals]) => fixtureTotals.passAtK[k]);
    return {
      k,
      estimate: estimates.length ? estimates.reduce((sum, value) => sum + value, 0) / estimates.length : null,
      eligibleFixtures: estimates.length,
      eligibleFixtureNames: eligible.map(([name]) => name),
      totalFixtures: Object.keys(fixtures).length,
    };
  });
}

function compareArms(reference, base, arm, candidate) {
  return {
    reference,
    arm,
    delta: {
      tasks: candidate.tasks - base.tasks,
      passed: candidate.passed - base.passed,
      passRate: numericDelta(candidate.passRate, base.passRate),
      strict: candidate.strict - base.strict,
      turns: candidate.turns - base.turns,
      thinkPhases: candidate.thinkPhases - base.thinkPhases,
      genTok: candidate.genTok - base.genTok,
      thinkTok: candidate.thinkTok - base.thinkTok,
      actionTok: candidate.actionTok - base.actionTok,
      requests: candidate.requests - base.requests,
      inputTok: candidate.inputTok - base.inputTok,
      outputTok: candidate.outputTok - base.outputTok,
      cacheHitTok: candidate.cacheHitTok - base.cacheHitTok,
      cacheMissTok: candidate.cacheMissTok - base.cacheMissTok,
      reasoningTok: candidate.reasoningTok - base.reasoningTok,
      codexThreadCalls: candidate.codexThreadCalls - base.codexThreadCalls,
      codexUniqueThreads: candidate.codexUniqueThreads - base.codexUniqueThreads,
      codexReusedCalls: candidate.codexReusedCalls - base.codexReusedCalls,
      codexRebasedCalls: candidate.codexRebasedCalls - base.codexRebasedCalls,
      codexTerminalRebasedCalls:
        candidate.codexTerminalRebasedCalls - base.codexTerminalRebasedCalls,
      codexPostRebaseCalls: candidate.codexPostRebaseCalls - base.codexPostRebaseCalls,
      codexDeliveredPromptChars: candidate.codexDeliveredPromptChars - base.codexDeliveredPromptChars,
      codexPromptSavedRatio: numericDelta(candidate.codexPromptSavedRatio, base.codexPromptSavedRatio),
      codexPromptDeltaCalls: candidate.codexPromptDeltaCalls - base.codexPromptDeltaCalls,
      codexPromptMinDeltaSavedRatio: numericDelta(
        candidate.codexPromptMinDeltaSavedRatio,
        base.codexPromptMinDeltaSavedRatio,
      ),
      codexPromptLowSavingsDeltaCalls: (
        candidate.codexPromptLowSavingsDeltaCalls - base.codexPromptLowSavingsDeltaCalls
      ),
      costUsd: candidate.costUsd - base.costUsd,
      promptChars: candidate.promptChars - base.promptChars,
      promptCommonPrefixRatio: numericDelta(candidate.promptCommonPrefixRatio, base.promptCommonPrefixRatio),
      promptAddedSuffixChars: candidate.promptAddedSuffixChars - base.promptAddedSuffixChars,
      promptReplacedSuffixChars: candidate.promptReplacedSuffixChars - base.promptReplacedSuffixChars,
      invalid: candidate.invalid - base.invalid,
      protocolViolations: candidate.protocolViolations - base.protocolViolations,
      duplicateActionRejections: candidate.duplicateActionRejections - base.duplicateActionRejections,
      duplicateShellRejections: candidate.duplicateShellRejections - base.duplicateShellRejections,
      immutableEditRejections: candidate.immutableEditRejections - base.immutableEditRejections,
      shellScopeRollbacks: candidate.shellScopeRollbacks - base.shellScopeRollbacks,
      shellScopeViolationFiles: candidate.shellScopeViolationFiles - base.shellScopeViolationFiles,
      noOpEdits: candidate.noOpEdits - base.noOpEdits,
      outcomeCycleEvents: candidate.outcomeCycleEvents - base.outcomeCycleEvents,
      outcomeCycleHints: candidate.outcomeCycleHints - base.outcomeCycleHints,
      completionAuditHints: candidate.completionAuditHints - base.completionAuditHints,
      lexicalContractAuditHints:
        candidate.lexicalContractAuditHints - base.lexicalContractAuditHints,
      visualCompletionAuditHints:
        candidate.visualCompletionAuditHints - base.visualCompletionAuditHints,
      visualCompletionAuditRevisions:
        candidate.visualCompletionAuditRevisions - base.visualCompletionAuditRevisions,
      visualAltCoverageHints:
        candidate.visualAltCoverageHints - base.visualAltCoverageHints,
      visualAltCoverageRevisions:
        candidate.visualAltCoverageRevisions - base.visualAltCoverageRevisions,
      stateAuditHints: candidate.stateAuditHints - base.stateAuditHints,
      externalWorkspaceMutationEvents:
        candidate.externalWorkspaceMutationEvents - base.externalWorkspaceMutationEvents,
      externalWorkspaceMutationPaths:
        candidate.externalWorkspaceMutationPaths - base.externalWorkspaceMutationPaths,
      externalWorkspaceMutationBlockedActions:
        candidate.externalWorkspaceMutationBlockedActions - base.externalWorkspaceMutationBlockedActions,
      repeatEscapeMasks: candidate.repeatEscapeMasks - base.repeatEscapeMasks,
      progressGateRejections: candidate.progressGateRejections - base.progressGateRejections,
      progressGateTerminations: candidate.progressGateTerminations - base.progressGateTerminations,
      patchActions: candidate.patchActions - base.patchActions,
      patchFailures: candidate.patchFailures - base.patchFailures,
      patchAvailableRuns: candidate.patchAvailableRuns - base.patchAvailableRuns,
      deleteFileActions: candidate.deleteFileActions - base.deleteFileActions,
      moveFileActions: candidate.moveFileActions - base.moveFileActions,
      fileOperationFailures: candidate.fileOperationFailures - base.fileOperationFailures,
      fileOperationAvailableRuns: candidate.fileOperationAvailableRuns - base.fileOperationAvailableRuns,
      taskMs: candidate.taskMs - base.taskMs,
      wallMs: candidate.wallMs - base.wallMs,
    },
    passAtK: Object.fromEntries(candidate.passAtK.map((item) => {
      const referenceItem = base.passAtK.find((candidateItem) => candidateItem.k === item.k);
      const sameFixtures = referenceItem
        && JSON.stringify(item.eligibleFixtureNames) === JSON.stringify(referenceItem.eligibleFixtureNames);
      return [item.k, {
        k: item.k,
        reference: referenceItem?.estimate ?? null,
        candidate: item.estimate,
        delta: sameFixtures ? numericDelta(item.estimate, referenceItem.estimate) : null,
      }];
    })),
  };
}

function numericDelta(candidate, reference) {
  return Number.isFinite(candidate) && Number.isFinite(reference) ? candidate - reference : null;
}

function mergeCounts(target, source) {
  if (!target || !source || typeof source !== "object" || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isFinite(Number(value))) continue;
    target[key] = (target[key] ?? 0) + Number(value);
  }
  return target;
}

function mergeUsageBySource(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  const fields = [
    "requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens",
    "cacheMissTokens", "reasoningTokens", "costUsd", "codexRequests",
  ];
  for (const [name, usage] of Object.entries(source)) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    target[name] ??= Object.fromEntries(fields.map((field) => [field, 0]));
    for (const field of fields) target[name][field] += Number(usage[field] ?? 0);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function uniqueStrings(values, label) {
  const out = values.map((value, index) => requiredString(value, `${label} ${index + 1}`));
  if (new Set(out).size !== out.length) throw new Error(`${label} entries must be unique`);
  return out;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredIdentifier(value, label) {
  const identifier = requiredString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) {
    throw new Error(`${label} must be an identifier`);
  }
  return identifier;
}

function optionalString(value, label) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function boundedInt(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function filesystemStamp(iso) {
  return String(iso).replace(/[:.]/g, "-");
}

function formatOrderBalance(balance) {
  if (balance?.status === "exact") return "exact";
  if (balance?.status === "best-possible") {
    return `best possible (max position imbalance ${balance.maxPositionImbalance})`;
  }
  if (balance?.status === "imbalanced") {
    return `imbalanced (max position imbalance ${balance.maxPositionImbalance})`;
  }
  return `invalid${balance?.reason ? ` (${balance.reason})` : ""}`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(3)} s`;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function signedSeconds(ms) {
  const value = (ms / 1000).toFixed(3);
  return `${ms > 0 ? "+" : ""}${value} s`;
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return "n/a";
  const formatted = (value * 100).toFixed(1);
  return `${value > 0 ? "+" : ""}${formatted} pp`;
}

function formatInterval(interval) {
  return interval && Number.isFinite(interval.low) && Number.isFinite(interval.high)
    ? `${percent(interval.low)}-${percent(interval.high)}`
    : "n/a";
}

function formatPassAtK(item) {
  return `${percent(item.estimate)} (${item.eligibleFixtures}/${item.totalFixtures})`;
}
