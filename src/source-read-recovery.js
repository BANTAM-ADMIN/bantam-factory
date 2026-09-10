import {RequiredReadHistory} from './required-read-history.js';
import {clipReadObservation} from './read-observation.js';

// A stalled investigation still needs the current bytes for its next edit.
// Only recover a bounded read of the supplied spec or an authored file. An
// already-visible range remains subject to the ordinary repetition gate.
export function missingSourceRead(action, {workspace, paths, prompt, maxLines, maxChars}) {
  if (action?.a !== 'read_file' || !paths.has(action.p) || typeof prompt !== 'string') return false;
  const start = action.start ?? 1, limit = action.limit ?? maxLines;
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(limit) || limit < 1 || limit > maxLines) return false;
  if (action.start === undefined && action.limit === undefined) return false;
  const history = new RequiredReadHistory({workspace, paths:[action.p]});
  const file = history.files.get(action.p);
  if (!file || start > file.lines.length) return false;
  const end = Math.min(file.lines.length, start + limit - 1);
  const body = file.lines.slice(start - 1, end).map((line, i) => `${start+i}\t${line}`).join('\n');
  const view = clipReadObservation(`${action.p} (${file.lines.length} lines, showing ${start}-${end}):\n${body}\n`, maxChars);
  const deliveredEnd = view.match(/^.+ \(\d+ lines, showing \d+-(\d+)\):\n/)?.[1];
  if (!deliveredEnd) return false; // No complete line fits: normal tool guidance applies.
  history.notePrompt(prompt);
  return !history.ledger.covers(action.p, start, Number(deliveredEnd));
}
