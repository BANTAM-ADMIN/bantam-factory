import { clipText, OBS_MAX } from './clip.js';

// A source read is a delivery receipt. Head/tail clipping cannot preserve that
// receipt: it leaves a header claiming hundreds of lines whose middle is gone.
// Keep consecutive COMPLETE lines and give the next read an exact address.
export function clipReadObservation(value, max = OBS_MAX) {
  const text = String(value ?? '');
  const cap = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : OBS_MAX;
  if (cap === 0) return '';
  if (text.length <= cap) return text;
  const ops = [...text.matchAll(/^# \d+ \{[^\n]+\}\n/gm)];
  if (ops[0]?.index === 0) {
    const parts = ops.map((op, i) => text.slice(op.index, ops[i + 1]?.index ?? text.length).trimEnd());
    // Leave a visible receipt for every op, including those that did not fit.
    const labels = ops.map(op => {
      try { const action = JSON.parse(op[0].slice(op[0].indexOf('{'))); return `${op[0].match(/^# (\d+)/)[1]} ${action.a} ${action.p ?? action.q ?? ''}`; }
      catch { return op[0].trim(); }
    });
    const note = clipText(`[clipped ops: ${labels.map(label => '#' + label).join(', ')} — re-request smaller reads; only shown ranges were delivered]`, Math.min(240, Math.floor(cap / 3)));
    let remaining = cap - note.length - 1;
    const kept = parts.map((part, i) => {
      const budget = Math.max(0, Math.floor((remaining - (parts.length - i - 1) * 2) / (parts.length - i)));
      const header = ops[i][0];
      const out = header.length < budget
        ? header + clipReadObservation(part.slice(header.length), budget - header.length)
        : clipText(header.trim(), budget);
      remaining -= out.length + 2;
      return out;
    });
    return `${kept.join('\n\n')}\n${note}`.slice(0, cap);
  }
  // Source pointers name already delivered ranges; the prompt renderer owns
  // their dependency repair. They are not raw contiguous read windows.
  if (/^\[source range [^\n]+ unchanged from turn \d+; omitted\]$/m.test(text)) return clipText(text, cap);
  const match = /^([^\n]+) \((\d+) lines, showing (\d+)-(\d+)\):\n/.exec(text);
  if (!match) return clipText(text, cap);
  const [, file, totalText, startText, requestedEndText] = match;
  const total = Number(totalText), start = Number(startText), requestedEnd = Number(requestedEndText);
  // Legacy/replay views can carry a working note that the caller does not
  // classify as a controller annotation. Preserve a bounded suffix instead
  // of silently deleting it to make room for more source.
  const suffixAt = text.search(/^\[[^\n]*\]/m);
  const suffix = suffixAt < 0 ? '' : '\n' + clipText(text.slice(suffixAt), Math.min(1000, Math.floor(cap / 3)));
  const bodyCap = Math.max(0, cap - suffix.length);
  const lines = text.slice(match[0].length).split('\n');
  const header = end => `${file} (${total} lines, showing ${start}-${end}):\n`;
  const footer = end => end === total ? `\n— end of file (${total} lines); nothing beyond line ${total}.` : `\n... (read window ends here; next unread line ${end + 1}. Use read_file on this path with "start":${end + 1}. ${total - end} lines remain.)`;
  let end = start - 1, size = 0;
  const kept = [];
  for (let i = 0; i < lines.length - 1 && end < requestedEnd; i++) {
    const numbered = /^(\d+)\t/.exec(lines[i]);
    if (!numbered || Number(numbered[1]) !== end + 1) break;
    // An old recorded read may already have a clipped half-line. Do not
    // manufacture a complete-line receipt from the clipper's newline.
    if (/^(?:\.\.\.|…) .*clipped/.test(lines[i + 1])) break;
    const nextSize = size + (kept.length ? 1 : 0) + lines[i].length;
    if (header(end + 1).length + nextSize + footer(end + 1).length > bodyCap) break;
    kept.push(lines[i]); size = nextSize; end++;
  }
  if (!kept.length) {
    // A single very long line cannot be line-paged. Never mark its preview as
    // delivered; give a bounded explanation rather than a false EOF/range.
    return clipText(`${file}: line ${start} does not fit this read window; no complete lines delivered. Use search for the exact text, or a bounded character slice with a shell tool.\nPartial line preview:\n${lines[0] ?? ''}`, bodyCap) + suffix;
  }
  return header(end) + kept.join('\n') + footer(end) + suffix;
}
