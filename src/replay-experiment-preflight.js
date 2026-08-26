import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { normalizeReplayExperimentSpec } from "./replay-experiment.js";
import {
  prepareReplay,
  replayRuntimeOptions,
  withSampleSeed,
} from "./replay.js";

const MAX_REPLAY_CALLS = 16;
const MAX_STUDY_FILES = 2_000;
const MAX_STUDY_BYTES = 20 * 1024 * 1024;

/**
 * Resolve and reconstruct a replay A/B without creating a model client,
 * probing an endpoint, writing evidence, or sending a request.
 */
export function buildReplayExperimentPreflight({
  specPath,
  endpoint,
  maxCalls,
  studyRoots,
  requireNewDesign = false,
} = {}) {
  if (!specPath) throw new Error("a replay experiment spec file is required");
  if (typeof requireNewDesign !== "boolean") {
    throw new Error("requireNewDesign must be a boolean");
  }
  const callCap = normalizeReplayCallBudget(maxCalls);
  const resolvedSpecPath = path.resolve(specPath);
  const specBytes = fs.readFileSync(resolvedSpecPath);
  const spec = normalizeReplayExperimentSpec(JSON.parse(specBytes));
  const artifactPath = path.resolve(path.dirname(resolvedSpecPath), spec.artifact);
  const artifactBytes = fs.readFileSync(artifactPath);
  const artifact = JSON.parse(artifactBytes);
  const artifactSha256 = sha256(artifactBytes);
  const designSha256 = replayDesignSha256({ artifactSha256, spec });
  const priorStudies = findPriorReplayStudies({
    roots: normalizeStudyRoots(studyRoots),
    artifactSha256,
    turn: spec.turn,
    designSha256,
  });
  const runtimeOptions = replayRuntimeOptions(artifact, {
    transportOverride: Boolean(endpoint),
  });
  const schedule = [];
  let baselineBytes = 0;
  let candidateBytes = 0;
  let baselinePromptChars = 0;
  let candidatePromptChars = 0;

  for (let sample = 0; sample < spec.samples; sample++) {
    const baseline = withSampleSeed(
      prepareReplay(artifact, spec.turn),
      sample,
    );
    const candidate = withSampleSeed(
      prepareReplay(artifact, spec.turn, { inject: spec.remedy }),
      sample,
    );
    const order = sample % 2 === 0
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
    baselineBytes += requestBytes(baseline);
    candidateBytes += requestBytes(candidate);
    baselinePromptChars += baseline.prompt.length;
    candidatePromptChars += candidate.prompt.length;
    schedule.push({
      sample,
      seed: requestSeed(baseline),
      order,
      baseline: replayCallView(baseline),
      candidate: replayCallView(candidate),
    });
  }

  const modelRequests = spec.samples * 2;
  const failures = [];
  if (callCap !== null && modelRequests > callCap) {
    failures.push(`${modelRequests} model requests exceeds --max-calls ${callCap}`);
  }
  if (requireNewDesign && priorStudies.exactDesign.length) {
    failures.push(
      `exact replay design already has ${priorStudies.exactDesign.length} prior stud${priorStudies.exactDesign.length === 1 ? "y" : "ies"}`,
    );
  }
  const turn = artifact?.turns?.[spec.turn];
  const sourceCall = findSourceCall(artifact, turn?.modelCallIndex);
  const seeds = schedule.map((row) => row.seed);
  const pairing = seeds.every(Number.isFinite)
    ? "seed-paired"
    : spec.samples === 1
      ? "single-order-unseeded"
      : "counterbalanced-unseeded";
  return {
    schema: 1,
    kind: "bantam-replay-experiment-preflight",
    status: failures.length ? "blocked" : "ready",
    failures,
    spec: {
      path: resolvedSpecPath,
      sha256: sha256(specBytes),
      name: spec.name,
      turn: spec.turn,
      samples: spec.samples,
      remedyChars: spec.remedy.length,
      expectation: spec.expectation,
      designSha256,
    },
    source: {
      path: artifactPath,
      sha256: artifactSha256,
      runId: artifact.runId ?? null,
      turns: Array.isArray(artifact.turns) ? artifact.turns.length : 0,
      modelCallIndex: turn?.modelCallIndex ?? null,
      recordedCallUsage: recordedUsage(sourceCall),
      recordedPromptTelemetry: sourceCall?.promptTelemetry ?? null,
      recordedCallUsageBoundary: "source-call telemetry; not a replay cost projection",
    },
    runtime: runtimeView({
      artifact,
      endpoint,
      runtimeOptions,
      sourceCall,
    }),
    sampling: {
      pairing,
      orderBalance: replayOrderBalance(spec.samples),
      seeds,
      seedBoundary: pairing === "seed-paired"
        ? "baseline and candidate share each derived seed"
        : "recorded transport exposes no numeric seed; call position is rotated when multiple samples exist",
    },
    budget: {
      modelRequests,
      maxCalls: callCap,
      serializedRequestBytes: {
        baseline: baselineBytes,
        candidate: candidateBytes,
        total: baselineBytes + candidateBytes,
      },
      promptChars: {
        baseline: baselinePromptChars,
        candidate: candidatePromptChars,
        total: baselinePromptChars + candidatePromptChars,
      },
      boundary: "Request count and serialized bytes are exact; provider tokens, latency, cache behavior, and cost are not projected.",
    },
    priorStudies: {
      ...priorStudies,
      requireNewDesign,
      boundary: "Exact design identity binds source artifact SHA-256, turn, samples, remedy, and normalized semantic expectation. Same-turn alternate designs are reported but not blocked. Presence means a structurally complete corpus record exists, not that its result passes the current audit.",
    },
    schedule,
  };
}

export function formatReplayExperimentPreflight(report) {
  const lines = [
    `Replay preflight: ${report.status}`,
    `${report.spec.name} · turn ${report.spec.turn} · ${report.spec.samples} sample(s) · ${report.budget.modelRequests} model requests`,
    `Runtime: ${report.runtime.kind} · ${report.runtime.model ?? "unknown model"} · ${report.runtime.reasoningEffort ?? "default effort"}`,
    `Sampling: ${report.sampling.pairing} · order ${report.sampling.orderBalance} · seeds ${report.sampling.seeds.map((seed) => seed ?? "unseeded").join(", ")}`,
    `Serialized requests: ${report.budget.serializedRequestBytes.baseline} baseline bytes + ${report.budget.serializedRequestBytes.candidate} candidate bytes`,
    `Source call usage: ${usageLabel(report.source.recordedCallUsage)} (${report.source.recordedCallUsageBoundary})`,
    `Prior studies: ${report.priorStudies.exactTurn.length} same-turn · ${report.priorStudies.exactDesign.length} exact-design`,
    `Budget boundary: ${report.budget.boundary}`,
  ];
  for (const failure of report.failures) lines.push(`BLOCK: ${failure}`);
  return lines.join("\n");
}

function findPriorReplayStudies({
  roots,
  artifactSha256,
  turn,
  designSha256,
}) {
  const files = discoverStudyJsonFiles(roots);
  const studies = [];
  let ignoredInvalid = 0;
  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_STUDY_BYTES) {
      ignoredInvalid++;
      continue;
    }
    let bytes;
    let evidence;
    try {
      bytes = fs.readFileSync(file);
      evidence = JSON.parse(bytes);
    } catch {
      ignoredInvalid++;
      continue;
    }
    if (evidence?.kind !== "bantam-replay-experiment") continue;
    let evidenceSpec;
    try {
      evidenceSpec = normalizeReplayExperimentSpec(evidence.spec, {
        allowLegacyUnanchoredOldVerbs: true,
      });
    } catch {
      ignoredInvalid++;
      continue;
    }
    if (
      evidence?.schema !== 1
      || !["complete", "complete_with_errors"].includes(evidence.status)
      || !Array.isArray(evidence.pairs)
      || evidence.pairs.length !== evidenceSpec.samples
      || evidence?.totals?.samples !== evidenceSpec.samples
      || !/^[a-f0-9]{64}$/i.test(String(evidence?.artifact?.sha256 ?? ""))
    ) {
      ignoredInvalid++;
      continue;
    }
    const sourceArtifactSha256 = String(evidence.artifact.sha256).toLowerCase();
    const evidenceDesignSha256 = replayDesignSha256({
      artifactSha256: sourceArtifactSha256,
      spec: evidenceSpec,
    });
    studies.push({
      path: path.resolve(file),
      sha256: sha256(bytes),
      name: evidence.name ?? evidenceSpec.name,
      status: evidence.status,
      verdict: evidence?.totals?.verdict ?? "unknown",
      sourceArtifactSha256,
      turn: evidenceSpec.turn,
      samples: evidenceSpec.samples,
      designSha256: evidenceDesignSha256,
    });
  }
  const exactTurn = studies.filter((study) =>
    study.sourceArtifactSha256 === artifactSha256.toLowerCase()
    && study.turn === turn);
  return {
    roots,
    scannedJsonFiles: files.length,
    studyArtifacts: studies.length,
    ignoredInvalid,
    exactTurn,
    exactDesign: exactTurn.filter((study) => study.designSha256 === designSha256),
  };
}

function replayDesignSha256({ artifactSha256, spec }) {
  return sha256(JSON.stringify({
    schema: 1,
    sourceArtifactSha256: artifactSha256.toLowerCase(),
    turn: spec.turn,
    samples: spec.samples,
    remedy: spec.remedy,
    expectation: spec.expectation,
  }));
}

function normalizeStudyRoots(value) {
  const raw = value === undefined
    ? [path.resolve(".bantam", "replay-experiments")]
    : Array.isArray(value)
      ? value
      : [value];
  if (raw.length > 8 || raw.some((root) => typeof root !== "string" || !root.trim())) {
    throw new Error("studyRoots must contain at most 8 non-empty paths");
  }
  return raw.map((root) => path.resolve(root));
}

function discoverStudyJsonFiles(roots) {
  const files = [];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (current.endsWith(".json")) files.push(current);
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) stack.push(path.join(current, entry.name));
      }
    }
    if (files.length > MAX_STUDY_FILES) {
      throw new Error(`replay preflight exceeded its ${MAX_STUDY_FILES}-study-file bound`);
    }
  }
  return files.sort();
}

export function normalizeReplayCallBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") {
    throw new Error(`--max-calls must be an integer from 1 to ${MAX_REPLAY_CALLS}`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_REPLAY_CALLS) {
    throw new Error(`--max-calls must be an integer from 1 to ${MAX_REPLAY_CALLS}`);
  }
  return number;
}

function replayCallView(replay) {
  return {
    fidelity: replay.fidelity,
    requestExact: replay.requestExact,
    requestBodySha256: replay.request?.bodySha256 ?? null,
    serializedRequestBytes: requestBytes(replay),
    promptChars: replay.prompt.length,
  };
}

function runtimeView({ artifact, endpoint, runtimeOptions, sourceCall }) {
  const recordedUrl = sourceCall?.request?.url ?? null;
  const metadata = artifact?.model?.metadata ?? {};
  if (endpoint) {
    return {
      kind: "endpoint-override",
      model: metadata.model ?? artifact?.modelId ?? null,
      reasoningEffort: metadata.reasoningEffort ?? null,
      endpoint,
      endpointSource: "operator override",
      recordedRequestUrl: recordedUrl,
    };
  }
  if (runtimeOptions.codex) {
    return {
      kind: "codex-recorded",
      model: runtimeOptions.model ?? null,
      reasoningEffort: runtimeOptions.codexEffort ?? null,
      endpoint: recordedUrl,
      endpointSource: "recorded request",
      recordedRequestUrl: recordedUrl,
    };
  }
  const artifactEndpoint = artifact.endpoint ?? null;
  return {
    kind: artifactEndpoint ? "http-recorded" : "http-probe-required",
    model: metadata.model ?? artifact?.modelId ?? null,
    reasoningEffort: metadata.reasoningEffort ?? null,
    endpoint: artifactEndpoint,
    endpointSource: artifactEndpoint ? "source artifact" : "runtime probe required on execution",
    recordedRequestUrl: recordedUrl,
  };
}

function findSourceCall(artifact, modelCallIndex) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  return calls.find((call) => call?.index === modelCallIndex)
    ?? (calls[modelCallIndex]?.index === undefined ? calls[modelCallIndex] : null);
}

function recordedUsage(call) {
  const value = call?.response?.normalized?.usage
    ?? call?.response?.usage
    ?? call?.usage
    ?? null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function requestBytes(replay) {
  return Buffer.byteLength(replay.request?.body ?? replay.prompt ?? "", "utf8");
}

function requestSeed(replay) {
  try {
    const body = replay.request ? JSON.parse(replay.request.body) : replay.body;
    return Number.isFinite(body?.seed) ? body.seed : null;
  } catch {
    return null;
  }
}

function replayOrderBalance(samples) {
  if (samples === 1) return "not-applicable";
  return samples % 2 === 0 ? "exact" : "best-possible";
}

function usageLabel(usage) {
  if (!usage) return "unreported";
  return `${Number(usage.inputTokens ?? 0)} input / ${Number(usage.outputTokens ?? 0)} output / ${Number(usage.reasoningTokens ?? 0)} reasoning`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
