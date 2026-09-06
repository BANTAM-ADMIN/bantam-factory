import crypto from "node:crypto";
import path from "node:path";

import { canonicalJson } from "../journal.js";
import { snapshotTree } from "../scope-guard.js";
import { wasControllerStopped } from "../controller-stop.js";
import { compatibilityFactoryLine, gaugeRef } from "./compatibility-line.js";
import { FactoryStore } from "./store.js";

const MATERIAL_EVENTS = new Set([
  "turn_start",
  "action",
  "observation",
  "invalid",
  "invalid_action",
  "protocol_violation",
  "pregate_fail",
  "done_rejected",
  "scoped_verify",
  "auto_verify",
  "verification",
  "verification_skipped",
  "probe",
  "numeric_contract_witness",
  "verification_recovery_mask",
  "contract_state_audit_start",
  "contract_state_audit",
  "contract_audit_recovery",
  "contract_assertion_start",
  "contract_assertion",
  "edit_preservation_review",
  "integrity",
  "external_workspace_change",
  "infrastructure_blocked",
  "interrupted",
  "model_error",
  "give_up",
]);

export class FactoryRunTelemetry {
  constructor({ root, jobId, runId = jobId, workspace, task, verificationCommand = null, executionMode = "bantam-run", time } = {}) {
    const started = process.hrtime.bigint();
    this.overheadNs = 0n;
    this.workspace = path.resolve(requireText(workspace, "factory telemetry workspace"));
    this.store = new FactoryStore(root);
    this.line = compatibilityFactoryLine();
    this.initialProductRevision = workspaceRevision(this.workspace);
    this.currentTurn = null;
    this.pendingTelemetry = [];
    this.flushScheduled = false;
    this.notedEvents = 0;
    this.deferredWrites = 0;
    this.error = null;
    this.finished = false;
    this.attempts = { intake: "intake-1", agent: "agent-1", verification: "verification-1" };
    this.writer = this.store.create({
      jobId,
      routeRef: this.line.route.ref,
      initialProductRevision: this.initialProductRevision,
      time,
    });
    this.jobId = this.writer.events[0].jobId;
    this.append("job.metadata", {
      runId,
      workspace: this.workspace,
      taskDigest: sha256Ref(String(task ?? "")),
      executionMode,
      verificationCommand: verificationCommand === null ? null : String(verificationCommand),
    });
    this.append("route.validated", { routeRef: this.line.route.ref });
    const routeEvidence = this.store.putEvidence(this.line.route);
    this.append("station.started", {
      stationAttempt: this.attempts.intake,
      stationRef: this.line.stations.intake.ref,
      inputProductRevision: this.initialProductRevision,
    });
    this.append("station.completed", {
      stationAttempt: this.attempts.intake,
      inputProductRevision: this.initialProductRevision,
      outputProductRevision: this.initialProductRevision,
      artifactRefs: [routeEvidence],
    });
    this.append("gauge.result", {
      stationAttempt: this.attempts.intake,
      gaugeRef: gaugeRef(this.line.stations.intake),
      status: "pass",
      evidenceRefs: [routeEvidence],
    });
    this.append("station.released", {
      stationAttempt: this.attempts.intake,
      productRevision: this.initialProductRevision,
    });
    this.append("station.started", {
      stationAttempt: this.attempts.agent,
      stationRef: this.line.stations.agent.ref,
      inputProductRevision: this.initialProductRevision,
    });
    this.overheadNs += process.hrtime.bigint() - started;
  }

  note(sourceEvent) {
    if (this.finished || this.error || !sourceEvent || !MATERIAL_EVENTS.has(sourceEvent.type)) return false;
    const started = process.hrtime.bigint();
    try {
      if (sourceEvent.type === "turn_start" && Number.isInteger(sourceEvent.turn)) {
        this.currentTurn = sourceEvent.turn;
      }
      this.notedEvents += 1;
      this.pendingTelemetry.push({
        sourceEvent: telemetryCopy(sourceEvent),
        sourceType: sourceEvent.type,
        turn: Number.isInteger(sourceEvent.turn) ? sourceEvent.turn : this.currentTurn,
      });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flushTelemetry());
      }
      return true;
    } catch (error) {
      this.error = error;
      return false;
    } finally {
      this.overheadNs += process.hrtime.bigint() - started;
    }
  }

  finish(result) {
    if (this.finished) throw new Error(`factory telemetry already finished: ${this.jobId}`);
    this.flushTelemetry();
    this.finished = true;
    if (this.error) return this.report(false);
    const started = process.hrtime.bigint();
    try {
      const finalRevision = workspaceRevision(this.workspace);
      const resultRef = this.store.putEvidence(factoryResultEvidence(result));
      this.append("station.completed", {
        stationAttempt: this.attempts.agent,
        inputProductRevision: this.initialProductRevision,
        outputProductRevision: finalRevision,
        artifactRefs: [resultRef],
      });
      const agentStatus = agentGaugeStatus(result);
      this.append("gauge.result", {
        stationAttempt: this.attempts.agent,
        gaugeRef: gaugeRef(this.line.stations.agent),
        status: agentStatus,
        evidenceRefs: [resultRef],
      });
      if (agentStatus !== "pass") {
        this.append("andon.raised", {
          code: agentStatus === "infrastructure" ? "agent-infrastructure" : "agent-incomplete",
          createdAtStation: this.attempts.agent,
          detectedAtStation: this.attempts.agent,
          affectedProductRevision: finalRevision,
          evidenceRefs: [resultRef],
        });
        if (finalRevision !== this.initialProductRevision) {
          this.append("output.contained", {
            stationAttempt: this.attempts.agent,
            productRevision: finalRevision,
            reason: "The compatibility agent station did not reach a releasable terminal disposition.",
          });
        }
        this.append("job.blocked", {
          code: agentStatus === "infrastructure" ? "agent-infrastructure" : "agent-incomplete",
          reason: "The existing BANTAM agent loop did not complete successfully.",
        });
        return this.finishReport(started, true, finalRevision);
      }

      this.append("station.released", {
        stationAttempt: this.attempts.agent,
        productRevision: finalRevision,
      });
      this.append("station.started", {
        stationAttempt: this.attempts.verification,
        stationRef: this.line.stations.verification.ref,
        inputProductRevision: finalRevision,
      });
      this.append("station.completed", {
        stationAttempt: this.attempts.verification,
        inputProductRevision: finalRevision,
        outputProductRevision: finalRevision,
        artifactRefs: [resultRef],
      });
      const verificationStatus = gaugeStatus(result?.verification);
      this.append("gauge.result", {
        stationAttempt: this.attempts.verification,
        gaugeRef: gaugeRef(this.line.stations.verification),
        status: verificationStatus,
        evidenceRefs: [resultRef],
      });
      if (verificationStatus === "pass") {
        this.append("station.released", {
          stationAttempt: this.attempts.verification,
          productRevision: finalRevision,
        });
        this.append("job.released", { productRevision: finalRevision, evidenceRefs: [resultRef] });
      } else if (verificationStatus === "blocked" && !result?.verification) {
        this.append("job.completed", {
          productRevision: finalRevision,
          outcome: result?.responded ? "answered" : "completed-unverified",
          evidenceRefs: [resultRef],
        });
      } else {
        this.append("andon.raised", {
          code: verificationStatus === "fail" ? "final-verification-failed" : "verification-infrastructure",
          createdAtStation: null,
          detectedAtStation: this.attempts.verification,
          affectedProductRevision: finalRevision,
          evidenceRefs: [resultRef],
        });
        this.append("job.blocked", {
          code: verificationStatus === "fail" ? "final-verification-failed" : "verification-infrastructure",
          reason: "The existing final verification did not release the product.",
        });
      }
      return this.finishReport(started, true, finalRevision);
    } catch (error) {
      this.error = error;
      return this.finishReport(started, false);
    }
  }

  abort(error) {
    if (this.finished) return this.report(!this.error);
    return this.finish({
      reachedDone: false,
      interrupted: true,
      blocked: { kind: "factory-observed-exception", message: error instanceof Error ? error.message : String(error) },
      modelFailure: null,
      verification: null,
    });
  }

  append(type, payload) {
    return this.writer.append(type, payload);
  }

  flushTelemetry() {
    this.flushScheduled = false;
    if (this.error || this.pendingTelemetry.length === 0) return;
    const started = process.hrtime.bigint();
    try {
      // Telemetry observation owes order and integrity, not per-event crash
      // durability: the note path is fsync-free, and the strict terminal
      // appends at finish() fsync the journal file, landing every buffered
      // line durably with them. A crash before finish loses only a
      // detectable, repairable telemetry tail — never product evidence.
      while (this.pendingTelemetry.length) {
        const pending = this.pendingTelemetry.shift();
        const reference = this.store.putEvidence(pending.sourceEvent, { durability: "deferred" });
        this.writer.append("station.telemetry", {
          stationAttempt: this.attempts.agent,
          sourceType: pending.sourceType,
          turn: pending.turn,
          artifactRef: reference,
        }, { durability: "deferred" });
        this.deferredWrites += 2;
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.overheadNs += process.hrtime.bigint() - started;
    }
  }

  report(ok, finalProductRevision = null) {
    return Object.freeze({
      ok,
      jobId: this.jobId,
      root: this.store.root,
      eventCount: this.writer.events.length,
      initialProductRevision: this.initialProductRevision,
      finalProductRevision,
      overheadMs: Number(this.overheadNs) / 1_000_000,
      telemetry: Object.freeze({
        noteDurability: "deferred",
        notedEvents: this.notedEvents,
        deferredWrites: this.deferredWrites,
      }),
      error: this.error?.message ?? null,
    });
  }

  finishReport(started, ok, finalProductRevision = null) {
    this.overheadNs += process.hrtime.bigint() - started;
    return this.report(ok, finalProductRevision);
  }
}

export function workspaceRevision(workspace) {
  const entries = [...snapshotTree(path.resolve(workspace))]
    .sort(([left], [right]) => left.localeCompare(right));
  return `tree:${crypto.createHash("sha256").update(canonicalJson(entries)).digest("hex")}`;
}

function agentGaugeStatus(result) {
  if (wasControllerStopped(result)) return "fail";
  if (result?.modelFailure || result?.blocked?.kind === "infrastructure" || result?.blocked?.type === "infrastructure") {
    return "infrastructure";
  }
  if (result?.interrupted) return "blocked";
  return result?.reachedDone ? "pass" : "fail";
}

function gaugeStatus(verification) {
  if (!verification) return "blocked";
  if (verification.status === "pass") return "pass";
  if (verification.status === "fail") return "fail";
  return verification.status === "blocked" ? "blocked" : "infrastructure";
}

function factoryResultEvidence(result) {
  return {
    reachedDone: Boolean(result?.reachedDone),
    responded: Boolean(result?.responded),
    interrupted: Boolean(result?.interrupted),
    blocked: result?.blocked ?? null,
    modelFailure: result?.modelFailure ?? null,
    controllerStop: result?.controllerStop ?? null,
    verification: result?.verification ?? null,
    integrity: result?.integrity ?? null,
    summary: result?.summary ?? null,
    metrics: result?.metrics ?? null,
  };
}

function telemetryCopy(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return { type: String(value?.type ?? "unavailable"), unavailable: true }; }
}

function sha256Ref(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
