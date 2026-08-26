// Normalize native delegate artifacts and BANTAM experiment manifests into one
// accounting table. Token values remain provider-reported; no attempt is made
// to pretend local llama.cpp caching and Codex caching are billing-equivalent.
//
// ABSENT IS NOT ZERO. Every field here used to default to `?? 0`, and the awards
// at the bottom are computed with `minimum()`. So an artifact with no usage block
// and no execution block rendered as 0 turns / 0 tokens / 0.0s and swept Fastest,
// Lowest input, Lowest cache miss and Lowest output in a single table -- beating a
// run that had honestly recorded 50,000 input tokens and 90 seconds. A row that
// measured nothing does not read as missing; it reads as perfect.
//
// So: unmeasured is null, null never competes for an award, and null renders as
// "n/a". A recorded 0 is a real measurement and still competes.

import fs from "node:fs";
import path from "node:path";

import { strictBest } from "./logic/strict-best.js";

/** A provider-reported number, or null when it was never recorded. Never 0-by-default. */
function metric(...candidates) {
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function compareExecutionEvidence(sources) {
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new TypeError("execution comparison requires at least two evidence sources");
  }
  const rows = [];
  for (const source of sources) {
    const file = resolveEvidenceFile(source);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.kind === "bantam-codex-delegate" || value.kind === "bantam-claude-delegate") {
      rows.push(delegateRow(value, file));
    } else if (value.kind === "bantam-experiment") {
      for (const [arm, totals] of Object.entries(value.totals?.arms ?? {})) {
        rows.push(experimentRow(value, arm, totals, file));
      }
    } else if (value.kind === "bantam-run") {
      rows.push(runRow(value, file));
    } else {
      throw new Error(`unsupported execution evidence kind in ${file}: ${value.kind ?? "missing"}`);
    }
  }
  const awards = {
    fastest: award(rows, "durationMs"),
    lowestInput: award(rows, "inputTokens"),
    lowestCacheMiss: award(rows.filter((row) => row.cacheMissComparable), "cacheMissTokens"),
    lowestOutput: award(rows, "outputTokens"),
  };

  return {
    schema: 1,
    kind: "bantam-execution-comparison",
    generatedAt: new Date().toISOString(),
    rows,
    allPassed: rows.every((row) => row.pass),
    fastest: awards.fastest.label,
    lowestInput: awards.lowestInput.label,
    lowestCacheMiss: awards.lowestCacheMiss.label,
    lowestOutput: awards.lowestOutput.label,
    // How each award was decided: won outright, drawn, or contested by too few
    // rows to mean anything. Without this a null is indistinguishable from a tie.
    awards,
  };
}

export function formatExecutionComparison(comparison) {
  const lines = [
    "Execution comparison",
    "",
    "Mode                    Pass  Turns  Requests       Input     Cache hit    Cache miss      Output   Reasoning       Time",
  ];
  for (const row of comparison.rows) {
    lines.push([
      row.label.padEnd(23),
      (row.pass ? "yes" : "no").padStart(4),
      formatNumber(row.turns).padStart(6),
      formatNumber(row.requests).padStart(8),
      formatNumber(row.inputTokens).padStart(11),
      formatNumber(row.cacheHitTokens).padStart(13),
      (row.cacheMissComparable ? formatNumber(row.cacheMissTokens) : "n/a").padStart(13),
      formatNumber(row.outputTokens).padStart(11),
      formatNumber(row.reasoningTokens).padStart(11),
      formatDuration(row.durationMs).padStart(10),
    ].join("  "));
  }
  const total = comparison.rows.length;
  const stateAward = (name, a) => {
    if (!a || !a.measured) return `${name}: n/a (no source measured it)`;
    if (a.tied) return `${name}: tie — ${a.tiedLabels.join(", ")}`;
    const short = a.measured < total ? `  (only ${a.measured} source measured it, of ${total})` : "";
    return `${name}: ${a.label}${short}`;
  };
  const a = comparison.awards ?? {};
  lines.push(
    "",
    stateAward("Fastest", a.fastest),
    stateAward("Lowest reported input", a.lowestInput),
    stateAward("Lowest comparable Codex cache miss", a.lowestCacheMiss),
    stateAward("Lowest output", a.lowestOutput),
    "",
    "Note: local llama.cpp cache counters and Codex cached-input counters are different contracts.",
    "An award decided by one source is not a comparison; n/a means unmeasured, never zero.",
  );
  return lines.join("\n");
}

function delegateRow(value, source) {
  const claude = value.kind === "bantam-claude-delegate";
  return {
    label: claude
      ? `native-claude-${shortModel(value.model)}-${value.effort}`
      : `native-${shortModel(value.model)}-${value.effort}`,
    mode: "native-delegate",
    model: value.model,
    effort: value.effort,
    pass: Boolean(value.result?.pass),
    strict: null,
    turns: metric(value.usage?.turns),
    requests: metric(value.usage?.turns),
    inputTokens: metric(value.usage?.inputTokens),
    cacheHitTokens: metric(value.usage?.cachedInputTokens),
    cacheMissTokens: metric(value.usage?.cacheMissTokens),
    cacheMissComparable: !claude,
    outputTokens: metric(value.usage?.outputTokens),
    reasoningTokens: metric(value.usage?.reasoningOutputTokens),
    durationMs: metric(value.execution?.durationMs),
    source,
  };
}

function experimentRow(value, arm, totals, source) {
  const model = arm === "sol" ? "gpt-5.6-sol" : arm === "terra" ? "gpt-5.6-terra" : arm;
  return {
    label: arm === "local" ? "bantam-local" : `bantam-${arm}`,
    mode: arm === "local" ? "bantam-local" : "bantam-constrained",
    model,
    effort: findEffort(value, arm),
    pass: Number(totals.passed ?? 0) === Number(totals.tasks ?? 0) && Number(totals.tasks ?? 0) > 0,
    strict: Number(totals.strict ?? 0),
    turns: metric(totals.turns),
    requests: metric(totals.requests),
    inputTokens: metric(totals.inputTok),
    cacheHitTokens: metric(totals.cacheHitTok),
    cacheMissTokens: metric(totals.cacheMissTok),
    cacheMissComparable: arm !== "local",
    outputTokens: metric(totals.outputTok),
    reasoningTokens: metric(totals.reasoningTok),
    durationMs: metric(totals.taskMs, totals.wallMs),
    source,
  };
}

function runRow(value, source) {
  const calls = value.modelCalls ?? [];
  const callUsage = calls.reduce((sum, call) => {
    const row = call.response?.usage ?? call.transport?.usage ?? {};
    sum.input += number(row.input_tokens ?? row.inputTokens);
    sum.cache += number(row.cached_input_tokens ?? row.cachedInputTokens);
    sum.output += number(row.output_tokens ?? row.outputTokens);
    sum.reasoning += number(row.reasoning_output_tokens ?? row.reasoningOutputTokens);
    return sum;
  }, { input: 0, cache: 0, output: 0, reasoning: 0 });
  // Current bantam-run artifacts persist the authoritative aggregate under
  // metrics.usage. Raw request records intentionally preserve transport bytes,
  // so their response objects do not always expose usage at the shallow legacy
  // paths above. Treating that as zero made real BANTAM runs look free.
  const aggregate = value.metrics?.usage ?? {};
  const runtime = value.model?.metadata?.runtime ?? "unknown";
  const inputTokens = metric(aggregate.inputTokens, calls.length ? callUsage.input : null);
  const cacheHitTokens = metric(aggregate.cacheHitTokens, calls.length ? callUsage.cache : null);
  const outputTokens = metric(aggregate.outputTokens, calls.length ? callUsage.output : null, value.metrics?.genTok);
  const reasoningTokens = metric(aggregate.reasoningTokens, calls.length ? callUsage.reasoning : null);
  return {
    label: runtime === "local" ? "bantam-local" : `bantam-${shortModel(value.modelId)}`,
    mode: runtime === "local" ? "bantam-local" : "bantam-constrained",
    model: value.modelId,
    effort: value.model?.metadata?.reasoningEffort ?? null,
    pass: Boolean(value.result?.pass),
    strict: value.result?.contract?.pass ?? null,
    turns: metric(value.metrics?.turns),
    requests: metric(aggregate.requests, value.metrics?.modelRequests, calls.length || null),
    inputTokens,
    cacheHitTokens,
    cacheMissTokens: metric(
      aggregate.cacheMissTokens,
      inputTokens !== null && cacheHitTokens !== null ? Math.max(0, inputTokens - cacheHitTokens) : null,
    ),
    cacheMissComparable: runtime === "codex",
    outputTokens,
    reasoningTokens,
    durationMs: metric(value.metrics?.totalMs),
    source,
  };
}

function resolveEvidenceFile(source) {
  const resolved = path.resolve(String(source));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return resolved;
  for (const name of ["artifact.json", "manifest.json"]) {
    const candidate = path.join(resolved, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`evidence directory has no artifact.json or manifest.json: ${resolved}`);
}

function findEffort(manifest, arm) {
  const definition = manifest.spec?.arms?.find?.((entry) => entry.name === arm);
  return definition?.model?.effort ?? null;
}

/**
 * The row with the lowest measured value for `key`.
 *
 * Delegates the three rules -- unmeasured never competes, a tie is not a win, one
 * contender is not a comparison -- to the shared primitive, so this file and
 * compare-plan.js cannot drift apart on them again.
 */
function award(rows, key) {
  const result = strictBest(rows, (row) => row[key], { direction: "min" });
  return {
    label: result.winner?.label ?? result.uncontested?.label ?? null,
    tied: result.tied.length > 0,
    tiedLabels: result.tied.map((row) => row.label),
    measured: result.measured,
    uncontested: Boolean(result.uncontested),
  };
}

function shortModel(model) {
  const text = String(model ?? "unknown");
  if (text.includes("sol")) return "sol";
  if (text.includes("terra")) return "terra";
  if (/qwen.*27b/i.test(text)) return "qwen27b";
  if (/opus/i.test(text)) return "opus";
  if (/sonnet/i.test(text)) return "sonnet";
  if (/fable/i.test(text)) return "fable";
  return text.replace(/^gpt-/, "");
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// An unmeasured value must never print as a number. Rendering a missing duration
// as "0.0s" made the row that recorded nothing look like the fastest run in the
// table.
function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString("en-US") : "n/a";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  const seconds = Math.max(0, Number(ms)) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
