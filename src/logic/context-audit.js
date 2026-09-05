// Repeated anchor misses and no-op edits justify checking current file bytes.
// They do not prove a cause. A guard's confirmation request, invalid syntax or
// a slow tool call must not be narrated as evidence of stale context.
// This bounded advisory never blocks execution.
import { editPaths, isEditAction } from "../edit-actions.js";

const REGROUND_REASONS = new Set(["anchor_missing", "ambiguous", "unchanged"]);
const REASON_LABELS = {
  anchor_missing: "the requested anchor or line was not found",
  ambiguous: "the requested target was not unique or overlapped another edit",
  unchanged: "the requested bytes were already present",
};

// Older callers and archived observations have no typed executor metadata.
// Recognize only specific evidence; generic ERROR text supplies no cause.
function legacyEditOutcome(action, observation) {
  let reason = "other";
  if (/^NO_CHANGE\b/.test(observation)) reason = "unchanged";
  else if (/^ERROR:.*(?:"old" text not found|(?:start )?line \d+ is (?:out of range|past the end))/.test(observation)) reason = "anchor_missing";
  else if (/^ERROR:.*"old" text appears more than once/.test(observation)) reason = "ambiguous";
  else if (/^(?:wrote|replaced|patched|deleted|moved)\b/.test(observation)) reason = "applied";
  return { applied: reason === "applied", reason, paths: editPaths(action) };
}
export class ContextAuditSentinel {
  constructor({ editFailureThreshold = 2, wallFactor = 3, wallFloorMs = 20000, maxWallAudits = 2 } = {}) {
    this.editFailureThreshold = editFailureThreshold;
    this.wallFactor = wallFactor;
    this.wallFloorMs = wallFloorMs;
    this.maxWallAudits = maxWallAudits;
    this._editFails = new Map();   // file -> consecutive failed-edit count
    this._editFired = new Set();   // files already audited this divergence episode
    this._lastNoteAt = null;
    this._turnWalls = [];
    this._wallAudits = 0;
  }

  note({ action = {}, observation = "", editOutcome = null, now = 0 } = {}) {
    const editNote = this._noteEdit(action, editOutcome ?? legacyEditOutcome(action, String(observation ?? "")));
    const wallNote = this._noteWall(now);
    // An edit-divergence audit outranks a wall audit on the same turn: it
    // names the exact file to re-read instead of a general re-grounding.
    return editNote ?? wallNote;
  }

  _noteEdit(action, outcome) {
    if (!isEditAction(action)) return null;
    const paths = [...new Set((Array.isArray(outcome.paths) ? outcome.paths : editPaths(action))
      .filter((p) => typeof p === "string" && p))];
    let note = null;
    for (const p of paths) {
      if (outcome.applied || !REGROUND_REASONS.has(outcome.reason)) {
        this._editFails.delete(p);
        this._editFired.delete(p);
        continue;
      }
      const n = (this._editFails.get(p) ?? 0) + 1;
      this._editFails.set(p, n);
      if (n < this.editFailureThreshold || this._editFired.has(p) || note) continue;
      this._editFired.add(p);
      note = `[context-audit] ${n} consecutive edits to ${p} did not apply; the latest result says ${REASON_LABELS[outcome.reason]}. `
        + `Before another edit: read_file the exact region and check the requested change against its current bytes. `
        + `Use a unique, non-overlapping target; if the requested bytes are already present, verify the behavior or choose a different change. `
        + `These results alone do not establish that the context is stale.`;
    }
    return note;
  }

  _noteWall(now) {
    if (!Number.isFinite(now) || now <= 0) return null;
    const last = this._lastNoteAt;
    this._lastNoteAt = now;
    if (last == null) return null;
    const wall = now - last;
    const walls = this._turnWalls;
    // Median of PRIOR turns only, and only once there is a baseline to trust.
    let fired = null;
    if (walls.length >= 4 && this._wallAudits < this.maxWallAudits) {
      const sorted = [...walls].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const limit = Math.max(this.wallFloorMs, this.wallFactor * median);
      if (wall >= limit) {
        this._wallAudits += 1;
        fired = `[context-audit] That turn took ${Math.round(wall / 1000)}s against a ${Math.max(1, Math.round(median / 1000))}s `
          + `median. A long turn alone does not establish a context problem. Check whether the time was expected for `
          + `this command or model request. If a repair is stalled, re-read the current file region and the actual failing evidence before retrying.`;
      }
    }
    walls.push(wall);
    if (walls.length > 40) walls.shift();
    return fired;
  }
}
