// Per-run ledger of which line ranges of which files the model has already
// read. The repetition guard only catches byte-identical read actions; the
// observed evasion (self-hosting v3, 2026-07-13) wobbles start/limit a few
// lines and re-requests territory it has already seen — 10 of 30 turns burned
// re-reading bin/bantam.js subranges. The ledger makes the already-read map
// visible in the prompt every turn, and lets the loop treat an inside-ledger
// re-read as the stall it is. Ranges invalidate per file on edit.

const MAX_RENDER_FILES = 6;

export class ReadLedger {
  constructor() {
    this.files = new Map(); // path -> sorted, merged [start, end] line ranges
    this.totals = new Map(); // path -> total line count, as stated by a read observation
  }

  note(path, start, end, total) {
    if (Number.isInteger(total) && total > 0) this.totals.set(path, total);
    if (!path || !Number.isInteger(start) || !Number.isInteger(end) || end < start) return;
    const ranges = this.files.get(path) ?? [];
    ranges.push([start, end]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of ranges) {
      const last = merged.at(-1);
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    this.files.set(path, merged);
  }

  invalidate(path) {
    this.files.delete(path);
    this.totals.delete(path);
  }

  clear() {
    this.files.clear();
    this.totals.clear();
  }

  /**
   * Has this whole file already been read, with no edit since?
   *
   * A whole-file read was previously exempt from ledger coverage ("extent
   * unknown without reading") — so a model could re-read an entire unchanged
   * file forever. Measured 2026-08-15 (ticket A parity runs): eight identical
   * whole-file reads of src/gate-policy.js in one 30-turn run. The extent is
   * not unknown after the first read: the observation header states it, and
   * every edit invalidates the entry.
   */
  fullyRead(path) {
    const total = this.totals.get(path);
    return Number.isInteger(total) && total > 0 && this.covers(path, 1, total);
  }

  /**
   * Would re-running this read return anything the ledger does not already hold?
   *
   * Requests are written in REQUEST space ("lines 1-200") and answered in SHOWN
   * space ("showing 1-150"), and the two rarely agree: a window past the end of
   * the file is the norm, and the stated total counts a trailing newline the
   * reader never shows. Comparing them directly made an already-satisfied read
   * look uncovered — tb12 (2026-08-16) skipped 12 of 32 in-batch exact repeats.
   *
   * The honest question is not "is [start,end] covered" but "has this file
   * already been read at least as far as this request can reach".
   */
  satisfies(path, start, end) {
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) return false;
    if (this.covers(path, start, end)) return true;
    const ranges = this.files.get(path);
    if (!ranges || !ranges.length) return false;
    // Beyond the recorded ranges, a request is satisfied ONLY if the file has
    // already been read to its end — otherwise the extra lines are genuinely
    // new and must be fetched. The stated total counts a trailing newline the
    // reader never shows, hence total - 1.
    const total = this.totals.get(path);
    if (!Number.isInteger(total) || total <= 0) return false;
    const furthest = ranges.reduce((max, [, e]) => Math.max(max, e), 0);
    if (furthest < total - 1) return false;
    return this.covers(path, start, furthest);
  }

  covers(path, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return false;
    const ranges = this.files.get(path);
    if (!ranges) return false;
    // Union coverage, not single-range containment: [start,end] is covered when
    // EVERY line in it lies in some recorded range. A wobbled re-read can span a
    // seam that no single recorded range contains; single-range `some()` missed
    // those. `note` keeps ranges sorted, so a left-to-right sweep that never finds
    // a gap ahead of the cursor proves the whole span is seen.
    let cursor = start;
    for (const [s, e] of ranges) {
      if (s > cursor) return false;   // an uncovered gap begins before the needed line
      if (e >= cursor) {
        if (e >= end) return true;    // covered through the end of the query
        cursor = e + 1;               // covered up to e; still need the remainder
      }
    }
    return false;
  }

  render() {
    if (this.files.size === 0) return "";
    const entries = [...this.files.entries()].slice(0, MAX_RENDER_FILES);
    const parts = entries.map(([path, ranges]) => {
      const spans = ranges.map(([s, e]) => `L${s}–${e}`).join(", ");
      return `${path}: ${spans}`;
    });
    const overflow = this.files.size > MAX_RENDER_FILES ? ` (+${this.files.size - MAX_RENDER_FILES} more files)` : "";
    return `Read history (contents unchanged on disk since): ${parts.join(" · ")}${overflow}. `
      + `This records prior coverage; it does not guarantee those bytes are still resident in this prompt. `
      + `If needed bytes are absent from <open_files>, reread the exact file or range; if present, act on them.`;
  }
}
