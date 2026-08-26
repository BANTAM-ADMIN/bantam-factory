// The process engineer: an observe-only pass that looks for stations worth
// MERGING.
//
// Every other mechanism on this branch pushes one way — decompose further, gauge
// more finely, contain earlier. That is a ratchet, and a ratchet with no pawl in
// the other direction ends at a route with one operation per token. Decomposition
// is not free: each station costs a dispatch, a prompt prefix, and a gauge, and
// those are paid on every article whether or not the split bought anything.
//
// The measured case that motivated this, from the branch's own retained evidence:
//
//   decomposed route   8/8 correct   11,490 ms   (4 stations x 8 articles)
//   monolith           6/8 correct    1,291 ms
//   monolith + retry the 2 that failed
//                      8/8 expected   1,613 ms
//
// Decomposition bought the last two articles at 7.1x the wall time of simply
// retrying. And the monolith's two failures were malformed emissions, not wrong
// judgments — its per-row accuracy was 1.000. A retry is the correct fixture for
// a malformed emission; four stations are not.
//
// So the rule this module encodes is narrower than "decompose":
//
//   Bound the step. Do not multiply the steps.
//   Split when the split buys something a retry cannot: a judgment the worker
//   gets wrong, or a locus you need. Otherwise merge and pay once.
//
// AUTHORITY: none. This proposes; it cannot edit a route, a blueprint, or a
// traveler. Its output is a change order for a human or a controller to accept,
// and every proposal carries the experiment required to confirm it, because a
// predicted saving is a hypothesis and this module cannot run the model.

import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";

const KIND = "bantam.factory-process-change-order";

export function analyzeFactoryProcess(events, { articleCount = 1 } = {}) {
  const stations = collectStations(events);
  const proposals = [];
  for (let index = 0; index < stations.length - 1; index += 1) {
    const upstream = stations[index];
    const downstream = stations[index + 1];
    const proposal = considerMerge(upstream, downstream, { articleCount });
    if (proposal) proposals.push(proposal);
  }
  proposals.sort((left, right) => right.predicted.savedMsPerArticle - left.predicted.savedMsPerArticle);
  const order = {
    schema: 1,
    kind: KIND,
    authority: "observe-only",
    stations: stations.map((station) => ({
      id: station.id,
      attempts: station.attempts,
      releases: station.releases,
      gaugeFailures: station.gaugeFailures,
      meanOperationMs: round(station.meanOperationMs),
    })),
    proposals,
    summary: {
      stations: stations.length,
      merges: proposals.length,
      blocked: proposals.filter((proposal) => proposal.blockedBy.length > 0).length,
      totalPredictedSavedMsPerArticle: round(proposals
        .filter((proposal) => proposal.blockedBy.length === 0)
        .reduce((total, proposal) => total + proposal.predicted.savedMsPerArticle, 0)),
    },
  };
  return deepFreeze({ ...order, ref: `change-order:sha256:${sha256(canonicalJson(order))}` });
}

function collectStations(events) {
  const byAttempt = new Map();
  const order = [];
  for (const event of events ?? []) {
    const attempt = event.payload?.stationAttempt;
    if (!attempt) continue;
    if (!byAttempt.has(attempt)) {
      byAttempt.set(attempt, {
        id: attempt.replace(/-\d+$/, ""),
        attempts: 0, releases: 0, gaugeFailures: 0,
        operationMs: [], workerKind: null,
      });
      order.push(byAttempt.get(attempt));
    }
    const station = byAttempt.get(attempt);
    if (event.type === "station.started") station.attempts += 1;
    if (event.type === "station.released") station.releases += 1;
    if (event.type === "gauge.result" && event.payload.status !== "pass") station.gaugeFailures += 1;
    if (event.type === "station.performance" && Number.isFinite(event.payload?.operationMs)) {
      station.operationMs.push(event.payload.operationMs);
    }
  }
  for (const station of order) {
    station.meanOperationMs = station.operationMs.length
      ? station.operationMs.reduce((total, value) => total + value, 0) / station.operationMs.length
      : 0;
  }
  return order;
}

function considerMerge(upstream, downstream, { articleCount }) {
  const blockedBy = [];

  // The gauge between two stations is the only reason the boundary is load
  // bearing. If it has ever caught something, merging removes a detection point
  // and the defect it caught becomes an escape.
  if (upstream.gaugeFailures > 0) {
    blockedBy.push(`the gauge at ${upstream.id} has failed ${upstream.gaugeFailures} time(s); merging removes that detection point`);
  }
  // A station that has been retried is doing rework the merge would inherit.
  if (upstream.attempts > upstream.releases) {
    blockedBy.push(`${upstream.id} has ${upstream.attempts - upstream.releases} unreleased attempt(s); merge only a stable operation`);
  }

  // What a merge saves is one dispatch's fixed cost, paid on every article. This
  // is deliberately conservative: it counts only the boundary, never the model
  // time, because this module cannot know whether one larger call is faster than
  // two smaller ones. That is what the confirming experiment is for.
  const boundaryMs = Math.min(upstream.meanOperationMs, downstream.meanOperationMs);
  const savedMsPerArticle = round(boundaryMs);

  return {
    id: `merge:${upstream.id}+${downstream.id}`,
    upstream: upstream.id,
    downstream: downstream.id,
    rationale: blockedBy.length
      ? "the boundary is carrying quality signal and should be left alone"
      : "neither gauge has ever fired and neither station has been reworked; the boundary is pure overhead on every article",
    predicted: {
      savedMsPerArticle,
      savedMsOverObserved: round(savedMsPerArticle * articleCount),
      fewerDispatchesPerArticle: 1,
      // Merging costs the localization the boundary provided. If the merged
      // operation ever fails, the two obligations become one suspect.
      lostLocusResolutionOperations: 1,
    },
    blockedBy,
    // A predicted saving is a hypothesis. This is the experiment that would
    // settle it, and the module states it rather than implying the saving is a
    // result.
    confirmingExperiment: {
      design: "run the merged station and the two-station route on the same material, order-balanced",
      accept: "merge if the merged yield is statistically indistinguishable AND wall time or tokens fall",
      reject: "keep the split if yield drops, or if the lost locus resolution matters for this task family",
      minimumArticlesPerArm: 20,
    },
  };
}

export function formatProcessChangeOrder(order) {
  const lines = [`FACTORY PROCESS CHANGE ORDER  ${order.ref}`, `authority: ${order.authority}`, ""];
  for (const station of order.stations) {
    lines.push(`  ${station.id.padEnd(24)} attempts ${station.attempts}  released ${station.releases}  gauge-fails ${station.gaugeFailures}  ${station.meanOperationMs} ms`);
  }
  lines.push("");
  if (!order.proposals.length) lines.push("  no adjacent station pairs to consider");
  for (const proposal of order.proposals) {
    const state = proposal.blockedBy.length ? "HOLD " : "MERGE";
    lines.push(`  ${state} ${proposal.id}`);
    lines.push(`        ${proposal.rationale}`);
    if (proposal.blockedBy.length) for (const reason of proposal.blockedBy) lines.push(`        blocked: ${reason}`);
    else lines.push(`        saves ~${proposal.predicted.savedMsPerArticle} ms/article, costs ${proposal.predicted.lostLocusResolutionOperations} operation of locus resolution`);
  }
  lines.push("");
  lines.push(`  ${order.summary.merges - order.summary.blocked} merge(s) proposed, ${order.summary.blocked} held, ~${order.summary.totalPredictedSavedMsPerArticle} ms/article predicted`);
  lines.push("  a predicted saving is a hypothesis; each proposal names the experiment that would settle it");
  return lines.join("\n");
}

function round(value) {
  return Number(Number(value ?? 0).toFixed(3));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
