// Crash/timeout-safe run evidence.
//
// The artifact is written only after `runAgent` resolves. If the process is killed mid-turn,
// the run would otherwise lose its summary, trajectory, and metrics.
//
// So: accumulate the trajectory from the events the agent loop already emits, and flush a PARTIAL
// artifact on SIGTERM/SIGINT. A truncated run should still be able to tell us where it died.
//
// Two invariants worth stating, because both are easy to get wrong:
//   1. The flush must never overwrite a real, completed artifact (`complete()` disarms it).
//   2. The flush must never throw. It runs in a signal handler during teardown; an exception there
//      would replace a useful partial record with a stack trace.

import fs from "node:fs";
import path from "node:path";

import { snapshotWorkspace } from "./workspace-snapshot.js";

export class RunCheckpoint {
  constructor({ dest, meta = {}, autosaveEvery = 3, initialEvidence = null, workspaceDir = undefined } = {}) {
    this.dest = dest;
    this.meta = meta;
    this.autosaveEvery = autosaveEvery;   // turns between disk flushes; 0 disables
    // Where the model's files live, so a resume can rebuild them. meta.workspace
    // is the path the checkpoint already records; snapshot its bytes too.
    this.workspaceDir = workspaceDir ?? (typeof meta.workspace === "string" ? meta.workspace : null);
    this._workspaceSnapshot = null;   // refreshed on the autosave cadence, NOT in the signal handler
    // A resumed lane must append to its durable evidence, not replace it with
    // the fresh process's empty collector. Seed committed rows exactly once;
    // runAgent emits only events produced after resume.
    this._turns = evidenceRows(initialEvidence?.turns);
    this._pending = null;   // action seen, observation not yet
    this._events = evidenceRows(initialEvidence?.events); // compact control events that turns alone cannot reconstruct
    this._rejectedOutputs = evidenceRows(initialEvidence?.rejectedOutputs);
    this._modelCalls = evidenceRows(initialEvidence?.modelCalls);
    this._pendingReasoning = null;
    this._pendingProtocol = null;
    this._lastModelCallIndex = null;
    this._eventSeq = this._events.reduce(
      (next, event) => Math.max(next, Number.isInteger(event?.seq) ? event.seq + 1 : next),
      this._events.length,
    );
    this._done = false;
    // Create the destination directory NOW, not in flush(). flush() runs inside a signal handler,
    // and `mkdirSync(..., {recursive:true})` can block indefinitely on some paths (it hangs under
    // /proc on this kernel). A crash-safety mechanism that can wedge during teardown is worse than
    // none — so the handler is left with only writeFileSync + rename, both of which fail fast.
    if (dest) { try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* flush will fail fast */ } }
  }

  /** Feed it the agent's `onEvent` stream. Only `action`/`observation` matter. */
  note(event) {
    if (!event) return;
    if (event.type === "thinking") {
      this._pendingReasoning = event.text ?? null;
      return;
    }
    if (event.type === "protocol_violation") {
      this._pendingProtocol = {
        rawOutput: event.raw ?? null,
        repairedJson: event.repairedJson ?? null,
      };
      return;
    }
    if (event.type === "invalid") {
      this._rejectedOutputs.push({
        turn: this._turns.length,
        attempt: this._rejectedOutputs.filter((row) => row.turn === this._turns.length).length,
        rawOutput: event.raw ?? null,
        error: event.error ?? null,
        reasoning: this._pendingReasoning,
        ...(event.kind !== undefined ? { kind: event.kind } : {}),
        ...(event.target !== undefined ? { target: event.target } : {}),
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.stoppedLimit !== undefined ? { stoppedLimit: Boolean(event.stoppedLimit) } : {}),
      });
      return;
    }
    if (event.type === "model_call" || event.type === "model_request" || event.type === "model_response") {
      this._noteModelCall(event);
      return;
    }
    if (event.type === "action") {
      this._flushPending();
      this._pending = {
        i: this._turns.length,
        parsedAction: event.action ?? null,
        rawOutput: event.rawOutput ?? this._pendingProtocol?.rawOutput ?? null,
        reasoning: event.reasoning ?? this._pendingReasoning,
        protocolViolation: Boolean(event.protocolViolation ?? this._pendingProtocol),
        observation: null,
        // Present only when BANTAM_SAVE_PROMPTS=1: keeps a killed run
        // rewindable with `bantam replay`.
        ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
        ...(Number.isInteger(event.modelCallIndex ?? this._lastModelCallIndex)
          ? { modelCallIndex: event.modelCallIndex ?? this._lastModelCallIndex }
          : {}),
        ...(event.modelRequest !== undefined ? { modelRequest: serializableCopy(event.modelRequest) } : {}),
      };
      this._pendingReasoning = null;
      this._pendingProtocol = null;
      return;
    }
    // A harness annotation appended to an ALREADY-SEALED observation. The
    // observation event flushes the turn at once; the agent then mutates its own
    // turns[] on the NEXT iteration (deliverable notices, guidance folds,
    // decision snapshots). The checkpoint held a COPY, so every audit of a
    // checkpoint read an observation the model never saw. Found 2026-08-22
    // chasing a notice that was in 23 of 36 prompts and zero checkpoint turns.
    if (event.type === "observation_annotated") {
      const i = Number.isInteger(event.turn) ? event.turn : this._turns.length - 1;
      const target = this._turns[i];
      if (target) {
        target.observation = String(event.observation ?? target.observation ?? "");
        if (Object.hasOwn(event, "contextUpdates")) target.contextUpdates = serializableCopy(event.contextUpdates);
        if (Object.hasOwn(event, "verificationWorkflow")) target.verificationWorkflow = serializableCopy(event.verificationWorkflow);
      }
      return;
    }
    if (event.type === "query" && this._pending) {
      this._pending.queryExecuted = true;
      this._pending.queryTool = event.tool ?? null;
      if (event.preview !== undefined) this._pending.preview = serializableCopy(event.preview);
      this._recordEvent(event);
      return;
    }
    if (event.type === "observation" && this._pending) {
      this._pending.observation = String(event.observation ?? "");
      this._pending.rawObservation = event.rawObservation ?? null;
      // Copy controller-owned execution facts from the sealed turn. Do not
      // reconstruct them from clipped observations, or erase explicit null /
      // false: that would turn an unverified new film into a legacy prose proof.
      for (const key of [
        "verificationEvidence", "verificationReceipts", "shellExecution", "probeEvidence", "editOutcome", "contractStateAudit", "contractAssertion", "cliVerification",
        "contextBasis", "contextUpdates", "verificationWorkflow", "doneAccepted", "controllerStop",
        "editApplied", "scopedVerify", "sourceEditedByShell", "shellChangedPaths",
        "shellScopeRollback", "stateAudit", "toolOutcome", "preview", "queryExecuted", "queryTool",
      ]) {
        if (Object.hasOwn(event, key)) this._pending[key] = serializableCopy(event[key]);
      }
      if (event.environmentVerification !== undefined) {
        this._pending.environmentVerification = serializableCopy(event.environmentVerification);
      }
      if (event.workspaceCoherence !== undefined) {
        this._pending.workspaceCoherence = serializableCopy(event.workspaceCoherence);
      }
      if (event.disposition !== undefined) this._pending.disposition = event.disposition;
      if (event.workspace !== undefined) this._pending.workspace = serializableCopy(event.workspace);
      this._flushPending();
      // Autosave. arm() catches SIGTERM/SIGINT/SIGHUP — but not SIGKILL, not the
      // OOM killer, not a power cut. v24 was killed with `kill -9` and left NO
      // artifact at all, so the one run whose context most needed reading was the
      // one that could not be rewound. A trajectory that only survives a POLITE
      // death is not a trajectory you can rely on.
      if (this.autosaveEvery > 0 && this._turns.length % this.autosaveEvery === 0) {
        // Walk the workspace HERE, in the normal loop, not in flush(): flush() also
        // runs from the signal handler where an fs walk could wedge teardown. The
        // signal flush just writes whatever snapshot this last captured (≤ autosave
        // turns stale — a cheap price for a handler that can't hang).
        this.refreshWorkspaceSnapshot();
        this.flush("autosave");
      }
      return;
    }
    this._recordEvent(event);
  }

  _noteModelCall(event) {
    const incoming = serializableCopy(event.record ?? event.call ?? null);
    if (incoming && Number.isInteger(incoming.index)) {
      const existing = this._modelCalls.findIndex((row) => row?.index === incoming.index);
      if (existing === -1) this._modelCalls.push(incoming);
      else this._modelCalls[existing] = incoming;
      this._lastModelCallIndex = incoming.index;
      return;
    }

    if (event.type === "model_request") {
      const index = Number.isInteger(event.index) ? event.index : this._modelCalls.length;
      this._modelCalls.push({
        schema: 1,
        index,
        status: "pending",
        request: serializableCopy(event.request),
        attempts: [],
        response: null,
        error: null,
      });
      this._lastModelCallIndex = index;
      return;
    }

    if (event.type === "model_response") {
      const index = Number.isInteger(event.index) ? event.index : this._lastModelCallIndex;
      const call = this._modelCalls.find((row) => row?.index === index);
      if (call) {
        call.status = event.error ? "error" : "ok";
        call.response = serializableCopy(event.response);
        call.error = serializableCopy(event.error);
      }
    }
  }

  _recordEvent(event) {
    // Streaming/activity output is presentation, not control state, and can be
    // enormous. Preserve every other event so a killed run retains gates,
    // injections, verifier signals, and recovery decisions.
    if (event.type === "activity" || event.type === "shell_output") return;
    const copy = serializableCopy(event);
    if (!copy) return;
    this._events.push({ seq: this._eventSeq++, turn: this._turns.length, ...copy });
  }

  _flushPending() {
    if (this._pending) { this._turns.push(this._pending); this._pending = null; }
  }

  /** The trajectory so far, including an in-flight turn whose observation never arrived. */
  turns() {
    const out = this._turns.slice();
    if (this._pending) out.push({ ...this._pending });
    return out;
  }

  events() { return this._events.map((event) => serializableCopy(event)); }
  modelCalls() { return this._modelCalls.map((call) => serializableCopy(call)); }
  rejectedOutputs() { return this._rejectedOutputs.map((row) => serializableCopy(row)); }

  /** The normal path wrote the real artifact — never clobber it. */
  complete() { this._done = true; }

  /**
   * Capture the workspace's small text files so a resume can rebuild them. Called
   * on the autosave cadence (safe loop context), never from the signal handler.
   * Non-throwing: a walk failure keeps the previous snapshot rather than nulling it.
   */
  refreshWorkspaceSnapshot() {
    if (!this.workspaceDir) return;
    try {
      const snap = snapshotWorkspace(this.workspaceDir);
      if (snap && Array.isArray(snap.files)) this._workspaceSnapshot = snap;
    } catch { /* keep the last good snapshot */ }
  }

  /**
   * Write a partial artifact. Safe to call from a signal handler: atomic (tmp + rename), never
   * throws, and a no-op once the run completed normally.
   */
  flush(truncatedBy = "signal") {
    if (this._done || !this.dest) return false;
    const tmp = `${this.dest}.${process.pid}.tmp`;
    try {
      const body = {
        ...this.meta,
        schema: 3,
        kind: this.meta.kind ?? "bantam-run-checkpoint",
        partial: true,
        truncatedBy,
        turns: this.turns(),
        turnCount: this.turns().length,
        rejectedOutputs: this._rejectedOutputs,
        modelCalls: this.modelCalls(),
        events: this.events(),
        // Present from schema 3: the workspace bytes, so --resume-run can rebuild
        // the files instead of only replaying the dialogue against an empty cursor.
        ...(this._workspaceSnapshot ? { workspaceSnapshot: this._workspaceSnapshot } : {}),
      };
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
      fs.renameSync(tmp, this.dest);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      return false;
    }
  }

  /**
   * Flush on the signals harbor/docker actually send. Returns a disposer so a long-lived process
   * (the REPL) doesn't accumulate handlers.
   */
  arm(signals = ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const onSignal = (sig) => () => {
      const saved = this.flush(sig.toLowerCase());
      // Say where the work went. Ctrl-C used to kill the process SILENTLY: the
      // checkpoint landed (partial: true, in a directory the user has never
      // heard of) while the --save-run path they named stayed empty, and nothing
      // mentioned that --resume-run exists. A rescue nobody is told about might
      // as well not exist. writeSync, not console.error — the process is exiting
      // and buffered output would be lost with it.
      try {
        const n = this.turns().length;
        fs.writeSync(2, saved
          ? `\ninterrupted (${sig}) at turn ${n} — progress saved to ${this.dest}\n`
            + `resume with: bantam run --resume-run ${this.dest}\n`
          : `\ninterrupted (${sig}) at turn ${n} — the checkpoint could not be written\n`);
      } catch { /* a farewell must never block the exit */ }
      process.exit(sig === "SIGINT" ? 130 : 143);
    };
    const handlers = signals.map((s) => [s, onSignal(s)]);
    for (const [s, h] of handlers) process.on(s, h);
    return () => { for (const [s, h] of handlers) process.off(s, h); };
  }
}

/** Forward exact ModelClient request records into a crash checkpoint. */
export function attachModelRequestCheckpoint(model, checkpoint) {
  if (!model || !checkpoint) return () => {};
  const previous = typeof model.onRequestRecord === "function" ? model.onRequestRecord : null;
  const forward = ({ phase, record }) => {
    try { previous?.({ phase, record }); } catch { /* an evidence observer cannot break inference */ }
    checkpoint.note({ type: "model_call", phase, record });
  };
  model.onRequestRecord = forward;
  return () => {
    if (model.onRequestRecord === forward) model.onRequestRecord = previous;
  };
}

function serializableCopy(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function evidenceRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => serializableCopy(row)).filter((row) => row !== null);
}
