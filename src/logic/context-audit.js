// The operator's standing rule, baked into the loop: THE CONTEXT IS ALWAYS THE
// PROBLEM. When a run starts to struggle, the productive move is almost never
// "try harder" — it is "re-read what you were handed": the file's actual
// bytes, the error's actual words. Two measured failure shapes drive the
// triggers:
//
// - Card 7 (maze): repeated near-identical `replace` anchors — "old text not
//   found" at 165 s — while the model kept editing from a remembered picture
//   of the file. Belief/workspace divergence, ground before retrying.
// - Cards 16/17 wall decomposition: one 45.8 s turn against a ~3 s median.
//   An outlier turn means grinding; grinding is a context signal.
//
// This station AUDITS THE CONTEXT, unlike its neighbors: stuck-test diagnosis
// reasons about the CODE, completion/state audits gate the FINISH. It fires
// rarely (caps below) and never blocks — it appends one re-grounding notice.
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

  note({ action = {}, observation = "", now = 0 } = {}) {
    const editNote = this._noteEdit(action, String(observation ?? ""));
    const wallNote = this._noteWall(now);
    // An edit-divergence audit outranks a wall audit on the same turn: it
    // names the exact file to re-read instead of a general re-grounding.
    return editNote ?? wallNote;
  }

  _noteEdit(action, observation) {
    const isEdit = action.a === "replace" || action.a === "patch" || action.a === "write_file";
    if (!isEdit || !action.p) return null;
    // A NO_CHANGE edit — writing the file to bytes it already holds — is the
    // PUREST divergence evidence: the model's picture says "this needs fixing"
    // and the workspace says "it already is". 7R (card 7 refight) ran seven
    // consecutive no-ops at turns 121-128 while this detector RESET on each,
    // reading them as landed edits.
    const failed = /^ERROR:/.test(observation) || /^NO_CHANGE\b/.test(observation);
    if (!failed) {
      this._editFails.delete(action.p);
      this._editFired.delete(action.p);
      return null;
    }
    const n = (this._editFails.get(action.p) ?? 0) + 1;
    this._editFails.set(action.p, n);
    if (n < this.editFailureThreshold || this._editFired.has(action.p)) return null;
    this._editFired.add(action.p);
    return `[context-audit] ${n} consecutive edits to ${action.p} have failed without landing (errors or NO_CHANGE no-ops — the file already holds what you keep writing). `
      + `Your picture of this file has diverged from its bytes. Before another edit: read_file the exact `
      + `region you are changing and work from the text that comes back — the file does not say what you `
      + `remember. Then re-read the last error literally, not your summary of it. When your mental model `
      + `and the workspace disagree, the workspace wins.`;
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
          + `median — grinding is a context signal, not a speed problem. Re-ground before continuing: re-read the `
          + `failing evidence (actual vs expected, literally), re-read the region you believe you are fixing, and `
          + `check they describe the same world. If they disagree, the workspace and the output win over your plan.`;
      }
    }
    walls.push(wall);
    if (walls.length > 40) walls.shift();
    return fired;
  }
}
