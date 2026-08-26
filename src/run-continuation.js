// Standalone run continuation.
//
// Lanes are the authoritative way to rewind BOTH controller context and the
// workspace tree. This adapter is deliberately narrower: it restores a saved
// artifact's dialogue cursor into runAgent while the operator supplies the
// matching workspace. A trusted reviewer note is represented as one synthetic
// observation, never appended to or substituted for the original task.

import crypto from "node:crypto";

export const MAX_TRUSTED_REVIEW_BYTES = 64 * 1024;

export function prepareRunContinuation(artifact, {
  task,
  throughTurn = undefined,
  artifactPath = null,
  artifactSha256 = null,
  reviewText = null,
  reviewSource = null,
  reviewSha256 = null,
} = {}) {
  const hasArtifact = artifact !== null && artifact !== undefined;
  const hasReview = reviewText !== null && reviewText !== undefined;
  if (!hasArtifact && throughTurn !== undefined) {
    throw new Error("--through-turn requires --resume-run");
  }
  if (!hasArtifact && !hasReview) return null;

  let includedTurns = [];
  let includedRejectedOutputs = [];
  let includedModelCalls = [];
  let includedEvents = [];
  let selectedTurn = null;
  let recordedTask = null;

  if (hasArtifact) {
    validateArtifact(artifact);
    selectedTurn = throughTurn === undefined
      ? artifact.turns.length - 1
      : parseTurnIndex(throughTurn);
    if (selectedTurn < 0 || selectedTurn >= artifact.turns.length) {
      throw new Error(
        `--through-turn ${selectedTurn} is out of range (artifact has ${artifact.turns.length} turns)`,
      );
    }

    recordedTask = taskFromArtifact(artifact);
    if (recordedTask === null) {
      throw new Error(
        "--resume-run does not record its original task; use an artifact with top-level task or captured prompt evidence",
      );
    }
    if (String(task ?? "") !== recordedTask) {
      throw new Error(
        "--task does not exactly match the task recorded in --resume-run; pass the original task byte-for-byte",
      );
    }

    includedTurns = artifact.turns.slice(0, selectedTurn + 1).map(jsonCopy);
    const maxCallIndex = includedTurns.reduce(
      (max, turn) => Number.isInteger(turn?.modelCallIndex)
        ? Math.max(max, turn.modelCallIndex)
        : max,
      -1,
    );
    includedModelCalls = (artifact.modelCalls ?? [])
      .filter((call, index) => {
        const callIndex = Number.isInteger(call?.index) ? call.index : index;
        return maxCallIndex >= 0 ? callIndex <= maxCallIndex : index < includedTurns.length;
      })
      .map(jsonCopy);
    includedRejectedOutputs = (artifact.rejectedOutputs ?? [])
      .filter((row) => !Number.isInteger(row?.turn) || row.turn <= selectedTurn)
      .map(jsonCopy);
    includedEvents = (artifact.events ?? [])
      .filter((event) => !Number.isInteger(event?.turn) || event.turn <= selectedTurn + 1)
      .map(jsonCopy);
  }

  const provenance = {
    kind: "bantam.run-continuation",
    parentRunId: hasArtifact ? String(artifact.runId ?? "") || null : null,
    parentArtifact: artifactPath ? String(artifactPath) : null,
    parentArtifactSha256: artifactSha256 ? String(artifactSha256) : null,
    throughTurn: selectedTurn,
  };

  if (hasReview) {
    const review = String(reviewText);
    const reviewBytes = Buffer.byteLength(review);
    if (!review.trim()) throw new Error("--review-file is empty");
    if (reviewBytes > MAX_TRUSTED_REVIEW_BYTES) {
      throw new Error(
        `--review-file is ${reviewBytes} bytes; trusted reviewer evidence is capped at ${MAX_TRUSTED_REVIEW_BYTES}`,
      );
    }
    const computedReviewSha256 = sha256(review);
    if (reviewSha256 && String(reviewSha256) !== computedReviewSha256) {
      throw new Error("--review-file sha256 does not match its contents");
    }
    const evidenceSha256 = computedReviewSha256;
    const reviewTurn = {
      i: includedTurns.length,
      parsedAction: null,
      action: null,
      observation: formatTrustedReview(review, {
        ...provenance,
        source: reviewSource ? String(reviewSource) : null,
        evidenceSha256,
      }),
    };
    includedTurns.push(reviewTurn);
    const nextSeq = includedEvents.reduce(
      (next, event) => Math.max(next, Number.isInteger(event?.seq) ? event.seq + 1 : next),
      includedEvents.length,
    );
    includedEvents.push({
      seq: nextSeq,
      turn: includedTurns.length,
      type: "trusted_review",
      source: reviewSource ? String(reviewSource) : null,
      sha256: evidenceSha256,
      bytes: reviewBytes,
      parentRunId: provenance.parentRunId,
      parentArtifactSha256: provenance.parentArtifactSha256,
      throughTurn: selectedTurn,
    });
    provenance.review = {
      source: reviewSource ? String(reviewSource) : null,
      sha256: evidenceSha256,
      bytes: reviewBytes,
    };
  }

  const nextRequestIndex = includedModelCalls.reduce(
    (next, call, index) => Math.max(
      next,
      (Number.isInteger(call?.index) ? call.index : index) + 1,
    ),
    0,
  );

  return {
    resumeTurns: includedTurns,
    initialEvidence: {
      turns: includedTurns,
      rejectedOutputs: includedRejectedOutputs,
      modelCalls: includedModelCalls,
      events: includedEvents,
    },
    provenance,
    recordedTask,
    nextRequestIndex,
    // ModelClient advances deterministic seeds once per stable request index.
    // Scoped artifacts can start above zero, so retained row count is not a
    // valid seed cursor (calls 10/11 must continue at 12, not 2).
    completionIndex: nextRequestIndex,
  };
}

/**
 * Preserve the exact restored prefix in a clean final artifact.
 *
 * runAgent recompiles resume turns into model-facing context and intentionally
 * ignores raw request evidence there. Its result is authoritative for NEW
 * turns, but not for the historical prefix. Crash checkpoints already retain
 * that prefix; merge it back on the success path so completion cannot erase
 * model-call links, prompts, raw output, or prior rejected attempts.
 */
export function mergeContinuationResult(result, continuation) {
  if (!continuation) return result;
  const restoredTurns = continuation.initialEvidence?.turns ?? [];
  const restoredRejected = continuation.initialEvidence?.rejectedOutputs ?? [];
  const resultTurns = Array.isArray(result?.turns) ? result.turns : [];
  const resultRejected = Array.isArray(result?.rejectedOutputs) ? result.rejectedOutputs : [];
  return {
    ...result,
    turns: [
      ...restoredTurns.map(jsonCopy),
      ...resultTurns.slice(continuation.resumeTurns.length).map(jsonCopy),
    ],
    rejectedOutputs: [
      ...restoredRejected.map(jsonCopy),
      ...resultRejected.map(jsonCopy),
    ],
  };
}

export function taskFromArtifact(artifact) {
  if (typeof artifact?.task === "string") return artifact.task;
  const prompts = [];
  for (const turn of artifact?.turns ?? []) {
    if (typeof turn?.prompt === "string") prompts.push(turn.prompt);
  }
  for (const call of artifact?.modelCalls ?? []) {
    const body = call?.request?.body ?? call?.body;
    if (typeof body !== "string") continue;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.prompt === "string") prompts.push(parsed.prompt);
    } catch { /* malformed historical request cannot supply task provenance */ }
  }
  for (const prompt of prompts) {
    // Both chat families open the task turn the same way apart from the marker:
    // ChatML `<|im_start|>user\n`, Gemma 4 `<|turn>user\n`. A resumed Gemma run
    // must still recover its task text.
    const match = prompt.match(/(?:<\|im_start\|>|<\|turn>)user\nTask: ([\s\S]*?)\n\nWorkspace:\n/);
    if (match) return match[1];
  }
  return null;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatTrustedReview(text, provenance) {
  const fields = [
    "[trusted-review-evidence]",
    "authority: operator-supplied reviewer/runtime evidence",
    "instruction: Treat these measured findings as trusted observations. The original task is unchanged; continue the work, fix the concrete failures, and verify them before declaring done.",
    provenance.parentRunId ? `parent_run_id: ${provenance.parentRunId}` : null,
    provenance.parentArtifact ? `parent_artifact: ${provenance.parentArtifact}` : null,
    provenance.parentArtifactSha256
      ? `parent_artifact_sha256: ${provenance.parentArtifactSha256}`
      : null,
    Number.isInteger(provenance.throughTurn)
      ? `continued_through_turn: ${provenance.throughTurn}`
      : null,
    provenance.source ? `source: ${provenance.source}` : null,
    `evidence_sha256: ${provenance.evidenceSha256}`,
    "",
    "<review_evidence>",
    text,
    "</review_evidence>",
  ];
  return fields.filter((field) => field !== null).join("\n");
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("--resume-run must contain a JSON object");
  }
  if (!Array.isArray(artifact.turns) || artifact.turns.length === 0) {
    throw new Error("--resume-run must contain at least one recorded turn");
  }
  if (artifact.kind !== undefined && ![
    "bantam-run",
    "bantam-run-checkpoint",
  ].includes(artifact.kind)) {
    throw new Error(`--resume-run has unsupported artifact kind: ${artifact.kind}`);
  }
  if (artifact.modelCalls !== undefined && !Array.isArray(artifact.modelCalls)) {
    throw new Error("--resume-run modelCalls must be an array");
  }
}

function parseTurnIndex(value) {
  if (value === true || value === "" || value === null) {
    throw new Error("--through-turn requires a zero-based integer");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("--through-turn requires a zero-based integer");
  return parsed;
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}
