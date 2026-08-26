// Bridge the live agent loop to one durable lane.
//
// LaneStore owns immutable workspace/controller checkpoints. RunCheckpoint
// owns the exact request/action/observation evidence already emitted by the
// agent. This adapter joins them at the only safe boundary: after an action has
// produced its observation. A crash can lose an in-flight proposal, but never
// a committed turn.

import { LaneStore } from "./lane-store.js";

const STATE_KIND = "bantam.run-cursor";
const DELTA_KIND = "bantam.run-cursor-delta";
const EVIDENCE_FIELDS = ["turns", "rejectedOutputs", "modelCalls", "events"];

export class LaneRunBridge {
  constructor({ stateHome, laneId, runId, stamp, task, model = null } = {}) {
    if (!stateHome) throw new Error("lane run requires a state home");
    if (!laneId) throw new Error("lane run requires a lane id");
    if (!runId) throw new Error("lane run requires a run id");
    this.store = new LaneStore(stateHome);
    this.laneId = String(laneId);
    this.runId = String(runId);
    this.stamp = String(stamp ?? "");
    this.task = String(task ?? "");
    const status = this.store.status(this.laneId);
    this.writer = this.store.acquireLane(this.laneId, {
      expectedEventId: status.eventId,
      metadata: { source: "runAgent", runId: this.runId },
    });
    this.closed = false;
    try {
      const snapshot = this.store.inspect(this.laneId);
      const prior = snapshot.controllerState;
      if (prior?.kind === STATE_KIND && prior.task !== this.task) {
        throw new Error(
          `lane ${this.laneId} belongs to a different task; fork or create a lane before running it`,
        );
      }
      const resumable = prior?.kind === STATE_KIND
        && (prior.status === "running" || prior.status === "interrupted");
      this.resumeTurns = resumable && Array.isArray(prior.turns) ? prior.turns : [];
      this.resumeEvidence = resumable ? {
        turns: Array.isArray(prior.turns) ? prior.turns : [],
        rejectedOutputs: Array.isArray(prior.rejectedOutputs) ? prior.rejectedOutputs : [],
        modelCalls: Array.isArray(prior.modelCalls) ? prior.modelCalls : [],
        events: Array.isArray(prior.events) ? prior.events : [],
      } : null;
      this.controllerStateRef = snapshot.controllerStateRef;
      this.evidenceOffsets = evidenceCounts(this.resumeEvidence);
      this.resetEvidence = !resumable;
      this.resumedFromEventId = resumable ? snapshot.eventId : null;
      this.workspace = snapshot.workspacePath;
      if (resumable && Number.isInteger(prior.modelCompletionIndex) && model) {
        model.completionIndex = prior.modelCompletionIndex;
      }
      if (resumable && model) {
        const nextRequestIndex = this.resumeEvidence.modelCalls.reduce(
          (next, call) => Math.max(next, Number.isInteger(call?.index) ? call.index + 1 : next),
          this.resumeEvidence.modelCalls.length,
        );
        if (!Number.isInteger(model.requestCount) || model.requestCount < nextRequestIndex) {
          model.requestCount = nextRequestIndex;
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Commit one completed action/observation pair and its exact request record. */
  note(event, checkpoint, { model = null } = {}) {
    this.assertOpen();
    if (event?.type !== "observation") return null;
    const state = this.cursorState(checkpoint, {
      status: "running",
      model,
    });
    const lane = this.writer.checkpoint(state, {
      source: "runAgent",
      phase: "turn.committed",
      runId: this.runId,
      turn: state.cursor.turnCount,
      resumedFromEventId: this.resumedFromEventId,
    });
    this.acceptCheckpoint(lane, state);
    return lane;
  }

  /** Store the final artifact by hash and advance the lane to a completed cursor. */
  finish({ checkpoint, artifact, result, model = null } = {}) {
    this.assertOpen();
    const artifactRef = artifact ? this.store.blobs.putJson(artifact) : null;
    const state = this.cursorState(checkpoint, {
      status: "completed",
      model,
      artifactRef,
      result: summarizeResult(result),
    });
    const lane = this.writer.checkpoint(state, {
      source: "runAgent",
      phase: "run.completed",
      runId: this.runId,
      turn: state.cursor.turnCount,
      artifactRef,
      resumedFromEventId: this.resumedFromEventId,
    });
    this.acceptCheckpoint(lane, state);
    this.close();
    return { lane, artifactRef };
  }

  /** Preserve the last known committed cursor when the controller throws. */
  abort({ checkpoint, error, model = null, artifact = null, result = null } = {}) {
    if (this.closed) return null;
    try {
      const artifactRef = artifact ? this.store.blobs.putJson(artifact) : null;
      const state = this.cursorState(checkpoint, {
        status: "interrupted",
        model,
        artifactRef,
        result: summarizeResult(result),
        error: error instanceof Error ? error.message : String(error ?? "unknown error"),
      });
      const lane = this.writer.checkpoint(state, {
        source: "runAgent",
        phase: "run.interrupted",
        runId: this.runId,
        turn: state.cursor.turnCount,
        artifactRef,
      });
      this.acceptCheckpoint(lane, state);
      return { lane, artifactRef };
    } finally {
      this.close();
    }
  }

  cursorState(checkpoint, overrides = {}) {
    const evidence = {
      turns: Array.isArray(overrides.turns) ? overrides.turns : (checkpoint?.turns?.() ?? []),
      rejectedOutputs: checkpoint?.rejectedOutputs?.() ?? [],
      modelCalls: checkpoint?.modelCalls?.() ?? [],
      events: checkpoint?.events?.() ?? [],
    };
    const counts = evidenceCounts(evidence);
    const delta = {};
    for (const field of EVIDENCE_FIELDS) {
      const offset = this.evidenceOffsets[field];
      if (counts[field] < offset) {
        throw new Error(`lane run evidence moved backwards: ${field} ${counts[field]} < ${offset}`);
      }
      delta[field] = evidence[field].slice(offset);
    }
    return {
      schema: 2,
      kind: DELTA_KIND,
      previousControllerStateRef: this.controllerStateRef,
      reset: this.resetEvidence,
      cursor: {
        schema: 1,
        kind: STATE_KIND,
        runId: this.runId,
        stamp: this.stamp,
        task: this.task,
        status: overrides.status ?? "running",
        turnCount: counts.turns,
        modelCompletionIndex: Number.isInteger(overrides.model?.completionIndex)
          ? overrides.model.completionIndex
          : null,
        resumedFromEventId: this.resumedFromEventId,
        ...(overrides.artifactRef ? { artifactRef: overrides.artifactRef } : {}),
        ...(overrides.result ? { result: overrides.result } : {}),
        ...(overrides.error ? { error: overrides.error } : {}),
      },
      counts,
      evidence: delta,
    };
  }

  acceptCheckpoint(lane, state) {
    this.controllerStateRef = lane.controllerStateRef;
    this.evidenceOffsets = { ...state.counts };
    this.resetEvidence = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.writer?.close();
  }

  assertOpen() {
    if (this.closed) throw new Error(`lane run is closed: ${this.laneId}`);
  }
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return null;
  return jsonCopy({
    reachedDone: Boolean(result.reachedDone),
    interrupted: Boolean(result.interrupted),
    blocked: result.blocked ?? null,
    summary: result.summary ?? null,
    verification: result.verification ?? null,
  });
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function evidenceCounts(evidence) {
  const counts = {};
  for (const field of EVIDENCE_FIELDS) {
    counts[field] = Array.isArray(evidence?.[field]) ? evidence[field].length : 0;
  }
  return counts;
}
