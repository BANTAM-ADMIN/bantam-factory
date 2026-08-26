import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  normalizeReplayExperimentSpec,
  replayExperimentVerdict,
  scoreReplayOutput,
} from "./replay-experiment.js";
import { prepareReplay, withSampleSeed } from "./replay.js";

const USAGE_FIELDS = [
  "requests",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheHitTokens",
  "cacheMissTokens",
  "reasoningTokens",
  "costUsd",
  "codexRequests",
];

export function resolveReplayEvidenceFile(input) {
  const resolved = path.resolve(String(input ?? ""));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return resolved;
  }
  if (!stat.isDirectory()) return resolved;
  const evidenceFile = path.join(resolved, "evidence.json");
  try {
    if (fs.statSync(evidenceFile).isFile()) return evidenceFile;
  } catch { /* use the precise directory error below */ }
  throw new Error(`replay evidence directory has no evidence.json: ${resolved}`);
}

export function auditReplayExperimentEvidence(evidence, { artifactBytes = null } = {}) {
  const failures = [];
  const warnings = [];
  if (evidence?.schema !== 1 || evidence?.kind !== "bantam-replay-experiment") {
    failures.push("unsupported replay evidence schema or kind");
  }

  let spec = null;
  try {
    spec = normalizeReplayExperimentSpec(evidence?.spec, {
      allowLegacyUnanchoredOldVerbs: true,
    });
    const legacyUnanchored = evidence?.spec?.expectation?.requireOldInPrompt === true
      ? (evidence.spec.expectation.verbs ?? [])
        .filter((verb) => verb === "write_file" || verb === "edit_lines")
      : [];
    if (legacyUnanchored.length) {
      warnings.push(
        `legacy expectation allowed old-anchor-ineligible verb(s): ${legacyUnanchored.join(", ")}; those actions cannot score as applicable`,
      );
    }
  } catch (error) {
    failures.push(`invalid normalized spec: ${error.message}`);
  }
  if (spec && evidence.specSha256 !== sha256Json(spec)) {
    failures.push("spec SHA-256 does not match normalized spec");
  }
  let sourceArtifact = null;
  if (artifactBytes === null) {
    warnings.push("source artifact bytes were not supplied");
  } else {
    if (evidence?.artifact?.sha256 !== sha256(artifactBytes)) {
      failures.push("source artifact SHA-256 does not match evidence");
    }
    try {
      sourceArtifact = JSON.parse(String(artifactBytes));
    } catch (error) {
      failures.push(`source artifact is not valid JSON: ${error.message}`);
    }
  }
  let replayPrompt = "";
  if (spec?.expectation?.requireOldInPrompt && sourceArtifact) {
    try {
      replayPrompt = prepareReplay(sourceArtifact, spec.turn).prompt;
    } catch (error) {
      failures.push(`cannot reconstruct recorded prompt for applicability: ${error.message}`);
    }
  }

  const pairs = Array.isArray(evidence?.pairs) ? evidence.pairs : [];
  const receiptAlgorithm = evidence?.integrity?.armReceipts;
  if (evidence?.integrity !== undefined && receiptAlgorithm !== "sha256-v1") {
    failures.push("unsupported replay arm receipt declaration");
  }
  if (spec && pairs.length !== spec.samples) {
    failures.push(`pair count ${pairs.length} does not match samples ${spec.samples}`);
  }
  let baselinePasses = 0;
  let candidatePasses = 0;
  let errors = 0;
  const seenSamples = new Set();
  const hasEfficiency = evidence?.totals?.efficiency !== undefined
    || pairs.some((pair) => ["baseline", "candidate"].some((arm) =>
      pair?.[arm]?.durationMs !== undefined || pair?.[arm]?.usage !== undefined));
  const efficiency = {
    baseline: { durationMs: 0, usage: emptyUsage() },
    candidate: { durationMs: 0, usage: emptyUsage() },
    providerReportedCalls: 0,
    unreportedCalls: 0,
  };
  const hasAnyRecordedOrder = pairs.some((pair) => pair?.order !== undefined);
  const hasCompleteRecordedOrder = pairs.every((pair, index) => {
    const expectedOrder = index % 2 === 0
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
    return JSON.stringify(pair?.order) === JSON.stringify(expectedOrder);
  });
  if (hasAnyRecordedOrder && !hasCompleteRecordedOrder) {
    failures.push("recorded replay call order is incomplete or not counterbalanced");
  }
  for (const [index, pair] of pairs.entries()) {
    let expectedReplays = null;
    if (receiptAlgorithm === "sha256-v1" && spec && sourceArtifact) {
      try {
        expectedReplays = {
          baseline: withSampleSeed(
            prepareReplay(sourceArtifact, spec.turn),
            index,
          ),
          candidate: withSampleSeed(
            prepareReplay(sourceArtifact, spec.turn, { inject: spec.remedy }),
            index,
          ),
        };
      } catch (error) {
        failures.push(`pair ${index + 1} request provenance cannot be reconstructed: ${error.message}`);
      }
    }
    if (!Number.isInteger(pair?.sample) || pair.sample !== index || seenSamples.has(pair.sample)) {
      failures.push(`pair ${index + 1} has an invalid or duplicate sample index`);
    }
    seenSamples.add(pair?.sample);
    for (const armName of ["baseline", "candidate"]) {
      const arm = pair?.[armName];
      if (!arm || typeof arm !== "object") {
        failures.push(`pair ${index + 1} is missing ${armName}`);
        continue;
      }
      if (receiptAlgorithm === "sha256-v1") {
        const expectedReceipt = replayArmReceiptSha256(arm, {
          arm: armName,
          sample: index,
        });
        if (arm.receiptSha256 !== expectedReceipt) {
          failures.push(`pair ${index + 1} ${armName} receipt SHA-256 does not match bound call evidence`);
        }
      } else if (arm.receiptSha256 !== undefined) {
        failures.push(`pair ${index + 1} ${armName} has a receipt without a supported integrity declaration`);
      }
      const expectedReplay = expectedReplays?.[armName];
      if (expectedReplay) {
        const expectedRequestHash = expectedReplay.request?.bodySha256 ?? null;
        if (arm.requestBodySha256 !== expectedRequestHash) {
          failures.push(
            `pair ${index + 1} ${armName} request body SHA-256 does not match reconstructed replay`,
          );
        }
        if (arm.fidelity !== expectedReplay.fidelity) {
          failures.push(
            `pair ${index + 1} ${armName} fidelity ${JSON.stringify(arm.fidelity)} does not match reconstructed replay ${JSON.stringify(expectedReplay.fidelity)}`,
          );
        }
      }
      if (arm.error) errors++;
      if (hasEfficiency) {
        if (!Number.isFinite(arm.durationMs) || arm.durationMs < 0) {
          failures.push(`pair ${index + 1} ${armName} has invalid request duration`);
        } else {
          efficiency[armName].durationMs += arm.durationMs;
        }
        if (arm.usage === null) {
          efficiency.unreportedCalls++;
        } else if (!arm.usage || typeof arm.usage !== "object" || Array.isArray(arm.usage)) {
          failures.push(`pair ${index + 1} ${armName} has invalid provider usage`);
          efficiency.unreportedCalls++;
        } else {
          efficiency.providerReportedCalls++;
          for (const field of USAGE_FIELDS) {
            const value = arm.usage[field];
            if (!Number.isFinite(value) || value < 0) {
              failures.push(`pair ${index + 1} ${armName} usage.${field} is invalid`);
              continue;
            }
            efficiency[armName].usage[field] += value;
          }
        }
      }
      if (!spec) continue;
      const rescored = scoreReplayOutput(arm.rawOutput, spec.expectation, {
        prompt: replayPrompt,
      });
      if (Boolean(arm.score?.pass) !== rescored.pass) {
        failures.push(`pair ${index + 1} ${armName} pass score does not match raw output`);
      }
      if (JSON.stringify(arm.score?.action ?? null) !== JSON.stringify(rescored.action)) {
        failures.push(`pair ${index + 1} ${armName} parsed action does not match raw output`);
      }
      if (rescored.pass) {
        if (armName === "baseline") baselinePasses++;
        else candidatePasses++;
      }
    }
  }

  const pairing = pairs.every((pair) => Number.isFinite(pair?.seed))
    ? "seed-paired"
    : hasCompleteRecordedOrder
      ? pairs.length === 1
        ? "single-order-unseeded"
        : "counterbalanced-unseeded"
      : "alternating-unseeded";
  const totals = evidence?.totals ?? {};
  const expected = {
    samples: spec?.samples ?? pairs.length,
    baselinePasses,
    candidatePasses,
    lift: candidatePasses - baselinePasses,
    errors,
    pairing,
    ...(hasCompleteRecordedOrder
      ? {
          orderBalance: pairs.length === 1
            ? "not-applicable"
            : pairs.length % 2 === 0
              ? "exact"
              : "best-possible",
        }
      : {}),
    ...(hasEfficiency ? { efficiency } : {}),
    verdict: replayExperimentVerdict({
      samples: spec?.samples ?? pairs.length,
      baselinePasses,
      candidatePasses,
      errors,
      paired: pairing === "seed-paired",
    }),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(totals[field]) !== JSON.stringify(value)) {
      failures.push(`totals.${field} is ${JSON.stringify(totals[field])}; expected ${JSON.stringify(value)}`);
    }
  }
  if (errors === 0 && evidence?.status !== "complete") {
    failures.push(`status is ${JSON.stringify(evidence?.status)}; expected "complete"`);
  }
  if (errors > 0 && evidence?.status !== "complete_with_errors") {
    failures.push(`status is ${JSON.stringify(evidence?.status)}; expected "complete_with_errors"`);
  }

  return {
    schema: 1,
    kind: "bantam-replay-experiment-audit",
    status: failures.length ? "fail" : warnings.length ? "pass_with_warnings" : "pass",
    failures,
    warnings,
    recomputed: expected,
  };
}

export function formatReplayExperimentAudit(report) {
  const lines = [
    `Replay evidence audit: ${report.status}`,
    `Recomputed: baseline ${report.recomputed.baselinePasses}/${report.recomputed.samples} · candidate ${report.recomputed.candidatePasses}/${report.recomputed.samples} · ${report.recomputed.verdict}`,
  ];
  for (const failure of report.failures) lines.push(`FAIL: ${failure}`);
  for (const warning of report.warnings) lines.push(`WARN: ${warning}`);
  return lines.join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
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

function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
}
