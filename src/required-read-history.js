import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReadLedger } from './read-ledger.js';

// Delivery history for supplied specifications, separate from source residency,
// progress credit and verification. Legacy executor headers are not receipts:
// recover only complete numbered lines in a recorded outgoing prompt that
// exactly match the current file. New checkpoints retain compact hash-bound
// ranges even when full prompt recording is disabled.
export class RequiredReadHistory {
  constructor({ workspace, paths = [], turns = [] }) {
    this.workspace = fs.realpathSync(workspace);
    this.files = new Map();
    this.ledger = new ReadLedger();
    for (const name of [...paths].slice(0, 8)) this.refresh(name);
    const restored = new Set();
    for (const turn of turns ?? []) {
      const history = turn.requiredReadHistory;
      if (history?.schema !== 1 || !Array.isArray(history.files)) continue;
      for (const entry of history.files.slice(0, 8)) {
        const file = this.files.get(entry?.path);
        if (!file || entry.sha256 !== file.sha256 || entry.total !== file.lines.length) continue;
        for (const range of (Array.isArray(entry.ranges) ? entry.ranges : []).slice(0, 256)) {
          if (!Array.isArray(range) || range.length !== 2) continue;
          const [start, end] = range;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > entry.total) continue;
          this.ledger.note(entry.path, start, end, entry.total);
          restored.add(entry.path);
        }
      }
    }
    for (const turn of turns ?? []) {
      if (typeof turn.prompt === 'string') this.notePrompt(turn.prompt, restored);
    }
  }

  refresh(name) {
    const previous = this.files.get(name);
    const forget = () => { this.ledger.invalidate(name); this.files.delete(name); };
    if (typeof name !== 'string' || name.includes('\n') || path.isAbsolute(name)) return;
    try {
      const file = fs.realpathSync(path.resolve(this.workspace, name));
      if (!file.startsWith(this.workspace + path.sep)) return forget();
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return forget();
      const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
      if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) return forget();
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (previous?.sha256 === sha256) return;
      this.ledger.invalidate(name);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      this.files.set(name, {
        lines: text.split('\n'), sha256,
        pattern: new RegExp(`^${escaped} \\((\\d+) lines, showing (\\d+)-(\\d+)\\):\\n((?:\\d+\\t[^\\n]*\\n)+)`, 'gm'),
      });
    } catch { forget(); /* Absent, unsafe or unreadable specs supply no history. */ }
  }

  invalidate(name) { if (this.files.has(name)) this.refresh(name); }

  notePrompt(prompt, skip = new Set()) {
    if (typeof prompt !== 'string') return false;
    let changed = false;
    for (const [name, file] of this.files) {
      if (skip.has(name) || this.ledger.fullyRead(name)) continue;
      for (const match of prompt.matchAll(file.pattern)) {
        if (Number(match[1]) !== file.lines.length) continue;
        let expected = Number(match[2]);
        for (const row of match[4].slice(0, -1).split('\n')) {
          const tab = row.indexOf('\t'), n = Number(row.slice(0, tab));
          if (n !== expected++ || n > Number(match[3])) break;
          // Exact bytes exclude truncated half-lines and stale source, even
          // when the old header claimed the complete requested range.
          if (row.slice(tab + 1) !== file.lines[n - 1] || this.ledger.covers(name, n, n)) continue;
          this.ledger.note(name, n, n, file.lines.length); changed = true;
        }
      }
    }
    return changed;
  }

  snapshot() {
    return { schema: 1, files: [...this.files].flatMap(([name, file]) => {
      const ranges = this.ledger.files.get(name);
      return ranges?.length ? [{ path: name, sha256: file.sha256, total: file.lines.length,
        ranges: ranges.slice(0, 256).map(range => [...range]) }] : [];
    }) };
  }

  render() {
    for (const name of [...this.files.keys()]) this.refresh(name);
    const rows = this.snapshot().files.map(entry => {
      const ranges = this.ledger.fullyRead(entry.path) ? `all ${entry.total} lines`
        : entry.ranges.slice(0, 5).map(([a, b]) => `${a}-${b}`).join(', ') + (entry.ranges.length > 5 ? ', …' : '');
      return `${entry.path.slice(0, 100)}: ${ranges} delivered previously`;
    });
    if (!rows.length) return '';
    return `[required-read-history]\n${rows.join('; ').slice(0, 950)}.\nThese are recorded deliveries matching the current file, not a claim of understanding, current context residency or correct implementation. Completed prerequisite reading does not need to restart after a resume. Reload the exact contract needed for the next milestone, then implement and verify it.`;
  }
}
