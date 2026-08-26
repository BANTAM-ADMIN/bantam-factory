import crypto from "node:crypto";

import { parseAction } from "./actions.js";
import { addModelUsage, emptyModelUsage } from "./model-usage.js";
import { prepareReplay, withSampleSeed } from "./replay.js";

const MAX_SAMPLES = 8;
const MAX_TERMS = 16;
const MAX_TERM_LENGTH = 80;
const EDIT_VERBS = new Set(["write_file", "replace", "edit_lines", "patch"]);
const SCORABLE_VERBS = new Set([...EDIT_VERBS, "done"]);
const OLD_ANCHORED_EDIT_VERBS = new Set(["replace", "patch"]);

export function normalizeReplayExperimentSpec(raw, {
  allowLegacyUnanchoredOldVerbs = false,
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("replay experiment spec must be an object");
  }
  const name = boundedString(raw.name, "name", 120);
  const artifact = boundedString(raw.artifact, "artifact", 1000);
  const remedy = boundedString(raw.remedy, "remedy", 4000);
  const turn = integerInRange(raw.turn, "turn", 0, 100000);
  const samples = integerInRange(raw.samples ?? 3, "samples", 1, MAX_SAMPLES);
  const expectation = normalizeActionExpectation(raw.expectation, {
    allowLegacyUnanchoredOldVerbs,
  });
  return {
    schema: 1,
    name,
    description: typeof raw.description === "string" ? raw.description.slice(0, 1000) : "",
    artifact,
    turn,
    samples,
    remedy,
    expectation,
  };
}

export function normalizeActionExpectation(raw, {
  allowLegacyUnanchoredOldVerbs = false,
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expectation must be an object");
  }
  if (
    raw.requireOldInPrompt !== undefined
    && typeof raw.requireOldInPrompt !== "boolean"
  ) {
    throw new Error("expectation.requireOldInPrompt must be a boolean");
  }
  const requireOldInPrompt = raw.requireOldInPrompt === true;
  const verbs = stringList(
    raw.verbs ?? [...(requireOldInPrompt ? OLD_ANCHORED_EDIT_VERBS : EDIT_VERBS)],
    "expectation.verbs",
    {
      max: SCORABLE_VERBS.size,
      allowed: SCORABLE_VERBS,
    },
  );
  const unanchored = requireOldInPrompt
    ? verbs.filter((verb) => !OLD_ANCHORED_EDIT_VERBS.has(verb))
    : [];
  if (unanchored.length && !allowLegacyUnanchoredOldVerbs) {
    throw new Error(
      `expectation.requireOldInPrompt cannot be satisfied by verb(s) without an old-text anchor: ${unanchored.join(", ")}`,
    );
  }
  const paths = stringList(raw.paths ?? [], "expectation.paths", { max: 16 })
    .map(normalizeRelativePath);
  if (verbs.some((verb) => EDIT_VERBS.has(verb)) && paths.length === 0) {
    throw new Error("expectation.paths must contain at least one path for edit verbs");
  }
  const contentAny = stringList(raw.contentAny ?? [], "expectation.contentAny", {
    max: MAX_TERMS,
    maxLength: MAX_TERM_LENGTH,
  });
  const contentAll = stringList(raw.contentAll ?? [], "expectation.contentAll", {
    max: MAX_TERMS,
    maxLength: MAX_TERM_LENGTH,
  });
  const forbidAny = stringList(raw.forbidAny ?? [], "expectation.forbidAny", {
    max: MAX_TERMS,
    maxLength: MAX_TERM_LENGTH,
  });
  if (contentAny.length === 0 && contentAll.length === 0) {
    throw new Error("expectation requires contentAny or contentAll");
  }
  return {
    verbs,
    paths,
    contentAny,
    contentAll,
    forbidAny,
    ...(requireOldInPrompt ? { requireOldInPrompt: true } : {}),
  };
}

export function scoreReplayOutput(rawOutput, expectation, { prompt = "" } = {}) {
  const parsed = parseAction(rawOutput);
  if (!parsed.ok) {
    return { pass: false, action: null, reasons: [`unparseable action: ${parsed.error}`] };
  }
  const action = parsed.action;
  const reasons = [];
  if (!expectation.verbs.includes(action.a)) {
    reasons.push(`verb ${action.a} is not allowed`);
  }
  const allowedPaths = new Set(expectation.paths);
  const editingAction = EDIT_VERBS.has(action.a);
  const segments = editingAction
    ? actionEditSegments(action)
      .filter((segment) => {
        try {
          return allowedPaths.has(normalizeRelativePath(segment.path));
        } catch {
          return false;
        }
      })
    : [];
  if (editingAction && segments.length === 0) {
    reasons.push(`action does not edit an expected path (${expectation.paths.join(", ")})`);
  }
  if (
    expectation.requireOldInPrompt
    && !segments.some((segment) =>
      typeof segment.old === "string"
      && segment.old !== segment.content
      && recordedPromptContains(prompt, segment.old))
  ) {
    reasons.push("action has no changed old text found in the recorded prompt");
  }
  const content = (editingAction
    ? segments.map((segment) => segment.content).join("\n")
    : action.a === "done"
      ? String(action.summary ?? "")
      : "").toLowerCase();
  if (
    expectation.contentAny.length
    && !expectation.contentAny.some((term) => content.includes(term.toLowerCase()))
  ) {
    reasons.push(`edited content contains none of: ${expectation.contentAny.join(", ")}`);
  }
  const missingAll = expectation.contentAll
    .filter((term) => !content.includes(term.toLowerCase()));
  if (missingAll.length) reasons.push(`edited content is missing: ${missingAll.join(", ")}`);
  const forbidden = expectation.forbidAny
    .filter((term) => content.includes(term.toLowerCase()));
  if (forbidden.length) reasons.push(`edited content contains forbidden terms: ${forbidden.join(", ")}`);
  return { pass: reasons.length === 0, action, reasons };
}

export async function runReplayExperiment({
  spec,
  artifact,
  ask,
  artifactPath = spec.artifact,
  artifactSha256 = null,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
} = {}) {
  const normalized = normalizeReplayExperimentSpec(spec);
  if (!artifact || typeof artifact !== "object") throw new Error("replay artifact is required");
  if (typeof ask !== "function") throw new Error("replay ask function is required");
  const startedAt = now();
  const pairs = [];
  for (let sample = 0; sample < normalized.samples; sample++) {
    const baselineReplay = withSampleSeed(
      prepareReplay(artifact, normalized.turn),
      sample,
    );
    const candidateReplay = withSampleSeed(
      prepareReplay(artifact, normalized.turn, { inject: normalized.remedy }),
      sample,
    );
    const order = sample % 2 === 0
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
    const replays = { baseline: baselineReplay, candidate: candidateReplay };
    const results = {};
    for (const arm of order) {
      results[arm] = await runArm({
        ask,
        replay: replays[arm],
        arm,
        sample,
        expectation: normalized.expectation,
        clock,
      });
    }
    pairs.push({
      sample,
      seed: requestSeed(baselineReplay),
      order,
      baseline: results.baseline,
      candidate: results.candidate,
    });
  }

  const baselinePasses = pairs.filter((pair) => pair.baseline.score.pass).length;
  const candidatePasses = pairs.filter((pair) => pair.candidate.score.pass).length;
  const errors = pairs.flatMap((pair) => [pair.baseline, pair.candidate])
    .filter((arm) => arm.error).length;
  const pairing = pairs.every((pair) => Number.isFinite(pair.seed))
    ? "seed-paired"
    : normalized.samples === 1
      ? "single-order-unseeded"
      : "counterbalanced-unseeded";
  const efficiency = replayEfficiency(pairs);
  return {
    schema: 1,
    kind: "bantam-replay-experiment",
    name: normalized.name,
    description: normalized.description,
    status: errors ? "complete_with_errors" : "complete",
    startedAt,
    completedAt: now(),
    spec: normalized,
    specSha256: sha256Json(normalized),
    artifact: {
      path: artifactPath,
      sha256: artifactSha256,
      runId: artifact.runId ?? null,
      turn: normalized.turn,
      model: artifact.model?.metadata ?? artifact.modelId ?? null,
    },
    integrity: {
      armReceipts: "sha256-v1",
    },
    pairs,
    totals: {
      samples: normalized.samples,
      baselinePasses,
      candidatePasses,
      lift: candidatePasses - baselinePasses,
      errors,
      pairing,
      orderBalance: replayOrderBalance(normalized.samples),
      efficiency,
      verdict: replayExperimentVerdict({
        samples: normalized.samples,
        baselinePasses,
        candidatePasses,
        errors,
        paired: pairing === "seed-paired",
      }),
    },
  };
}

export function replayExperimentVerdict({
  samples,
  baselinePasses,
  candidatePasses,
  errors = 0,
  paired = true,
}) {
  if (errors) return "inconclusive";
  if (candidatePasses < baselinePasses) return "regression";
  if (candidatePasses === baselinePasses) return "no-lift";
  if (baselinePasses === 0 && candidatePasses === samples) {
    return paired ? "supported" : "supported-unpaired";
  }
  return "partial-lift";
}

export function formatReplayExperimentSummary(evidence) {
  const t = evidence.totals;
  const lines = [
    `# ${evidence.name}`,
    "",
    `Status: ${evidence.status}`,
    `Sampling: ${t.pairing}`,
    ...(t.orderBalance ? [`Call-order balance: ${t.orderBalance}`] : []),
    `Semantic expectation: baseline ${t.baselinePasses}/${t.samples} · candidate ${t.candidatePasses}/${t.samples}`,
    `Lift: ${signed(t.lift)} matching actions · verdict: ${t.verdict}`,
    ...(t.efficiency ? [
      `Provider usage: baseline ${usageLabel(t.efficiency.baseline.usage)} · candidate ${usageLabel(t.efficiency.candidate.usage)}`,
      `Request time: baseline ${t.efficiency.baseline.durationMs} ms · candidate ${t.efficiency.candidate.durationMs} ms · usage reported for ${t.efficiency.providerReportedCalls}/${t.samples * 2} calls`,
      ...(evidence.integrity?.armReceipts === "sha256-v1"
        ? [`Call receipts: ${t.samples * 2}/${t.samples * 2} SHA-256 bound`]
        : []),
    ] : []),
    "",
    "| Sample | Seed | Call order | Baseline | Candidate |",
    "| ---: | ---: | --- | --- | --- |",
  ];
  for (const pair of evidence.pairs) {
    lines.push(
      `| ${pair.sample + 1} | ${pair.seed ?? "unseeded"} | ${pair.order?.join(" → ") ?? "legacy baseline → candidate"} | ${armLabel(pair.baseline)} | ${armLabel(pair.candidate)} |`,
    );
  }
  lines.push(
    "",
    t.verdict === "supported"
      ? "The remedy changed every paired draw from a non-matching action to an action satisfying the preregistered semantic expectation."
      : t.verdict === "supported-unpaired"
        ? `The remedy matched in every candidate call and no baseline call, but the recorded transport exposes no seed; this is ${unseededEvidenceLabel(t.pairing)} evidence, not a paired-draw claim.`
      : "This evidence does not establish a clean all-sample semantic lift.",
  );
  return lines.join("\n");
}

function replayOrderBalance(samples) {
  if (samples === 1) return "not-applicable";
  return samples % 2 === 0 ? "exact" : "best-possible";
}

function unseededEvidenceLabel(pairing) {
  if (pairing === "counterbalanced-unseeded") return "counterbalanced unseeded";
  if (pairing === "single-order-unseeded") return "single-order unseeded";
  return "legacy alternating unseeded";
}

async function runArm({ ask, replay, arm, sample, expectation, clock }) {
  const started = finiteClock(clock);
  try {
    const value = await ask(replay, { arm, sample });
    const rawOutput = String(value?.content ?? value ?? "");
    return sealReplayArm({
      fidelity: replay.fidelity,
      requestBodySha256: replay.request?.bodySha256 ?? null,
      rawOutput,
      score: scoreReplayOutput(rawOutput, expectation, { prompt: replay.prompt }),
      durationMs: elapsedMs(started, clock),
      usage: normalizeReplayUsage(value?.usage),
      error: null,
    }, { arm, sample });
  } catch (error) {
    return sealReplayArm({
      fidelity: replay.fidelity,
      requestBodySha256: replay.request?.bodySha256 ?? null,
      rawOutput: "",
      score: { pass: false, action: null, reasons: ["model request failed"] },
      durationMs: elapsedMs(started, clock),
      usage: null,
      error: error instanceof Error ? error.message : String(error),
    }, { arm, sample });
  }
}

function sealReplayArm(value, { arm, sample }) {
  return {
    ...value,
    receiptSha256: replayArmReceiptSha256(value, { arm, sample }),
  };
}

function replayArmReceiptSha256(value, { arm, sample }) {
  return sha256Json({
    schema: 1,
    sample,
    arm,
    fidelity: value.fidelity ?? null,
    requestBodySha256: value.requestBodySha256 ?? null,
    rawOutputSha256: sha256(value.rawOutput ?? ""),
    durationMs: value.durationMs,
    usage: value.usage ?? null,
    error: value.error ?? null,
  });
}

function replayEfficiency(pairs) {
  const result = {
    baseline: { durationMs: 0, usage: emptyModelUsage() },
    candidate: { durationMs: 0, usage: emptyModelUsage() },
    providerReportedCalls: 0,
    unreportedCalls: 0,
  };
  for (const pair of pairs) {
    for (const armName of ["baseline", "candidate"]) {
      const arm = pair[armName];
      result[armName].durationMs += Math.max(0, Number(arm?.durationMs) || 0);
      if (arm?.usage) {
        result[armName].usage = addModelUsage(result[armName].usage, arm.usage);
        result.providerReportedCalls++;
      } else {
        result.unreportedCalls++;
      }
    }
  }
  return result;
}

function normalizeReplayUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = emptyModelUsage();
  for (const field of Object.keys(usage)) {
    const number = Number(value[field] ?? 0);
    usage[field] = Number.isFinite(number) && number >= 0 ? number : 0;
  }
  return {
    provider: typeof value.provider === "string" ? value.provider : null,
    model: typeof value.model === "string" ? value.model : null,
    ...usage,
  };
}

function finiteClock(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : 0;
}

function elapsedMs(started, clock) {
  return Math.max(0, Math.round(finiteClock(clock) - started));
}

function usageLabel(usage) {
  return `${usage.requests} calls, ${usage.inputTokens} in/${usage.outputTokens} out/${usage.reasoningTokens} reasoning`;
}

function actionEditSegments(action) {
  if (action.a === "write_file") return [{ path: action.p, content: action.content, old: null }];
  if (action.a === "replace" || action.a === "edit_lines") {
    return [{
      path: action.p,
      content: action.new,
      old: action.a === "replace" ? action.old : null,
    }];
  }
  if (action.a === "patch") {
    return action.edits.map((edit) => ({
      path: edit.p,
      content: edit.new,
      old: edit.old,
    }));
  }
  return [];
}

function recordedPromptContains(prompt, old) {
  const source = String(prompt ?? "");
  if (source.includes(old)) return true;
  // Saved <open_files> are line-numbered. Removing only their numeric prefixes
  // reconstructs multiline source closely enough to verify exact edit anchors.
  return source.replace(/^\d+\t/gm, "").includes(old);
}

function requestSeed(replay) {
  try {
    const body = replay.request ? JSON.parse(replay.request.body) : replay.body;
    return Number.isFinite(body?.seed) ? body.seed : null;
  } catch {
    return null;
  }
}

function armLabel(arm) {
  if (arm.error) return "error";
  if (arm.score.pass) return "match";
  return arm.score.action ? `miss (${arm.score.action.a})` : "no action";
}

function boundedString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return value;
}

function integerInRange(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stringList(value, name, {
  max,
  maxLength = 1000,
  allowed = null,
} = {}) {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${name} must be an array with at most ${max} entries`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.length > maxLength) {
      throw new Error(`${name} entries must be non-empty strings up to ${maxLength} characters`);
    }
    if (allowed && !allowed.has(item)) throw new Error(`${name} contains unsupported value: ${item}`);
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function normalizeRelativePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`expectation path must be workspace-relative: ${value}`);
  }
  return normalized;
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}
