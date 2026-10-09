import { ActionSchema, parseAction, extractFirstJsonObject } from './actions.js';

// Free diffusion decoding is unreliable at escaping an entire source file as
// one JSON string. Keep the action header strict JSON and its literal payload
// in a closed fence; validation and the executor still own all authority.
export const DIFFUSION_FILE_ACTION_RULE = `For write_file, use this exact format instead of a JSON content string:
{"a":"write_file","p":"filename"}
\`\`\`\`html
literal file contents here, with ordinary quotes and newlines
\`\`\`\`
The header must contain only a and p. Use four backticks for the outer fence so ordinary three-backtick fences can appear inside the file. Close the matching fence on its own line and emit nothing afterward.
Keep each file write under 120 lines; build a small working version first, then extend it with bounded replace actions. Other actions remain single JSON objects.`;

export function diffusionGemmaActionSystem(system) {
  // Remove the conflicting JSON-string example rather than asking the model
  // to follow two different write_file encodings in the same instructions.
  const lineEdits = String(system).includes('- {"a":"edit_lines"');
  const editing = lineEdits ? `\nFor edits, prefer edit_lines with the numbered lines from read_file or open_files. Use the same literal block format:
{"a":"edit_lines","p":"filename","start":12,"end":18}
\`\`\`\`text
literal replacement for lines 12 through 18
\`\`\`\`
Do not include new in this header; the block supplies it. Read the current file to establish accurate line numbers before editing.` : '';
  return `${DIFFUSION_FILE_ACTION_RULE}${editing}\nFor browser checks, emit {"a":"query","q":"preview filename.html interact"}. Preview is a query tool.\n\n${String(system)
    .replace('as a single JSON object. You never write prose outside an action.', 'as one action. File writes use a JSON header followed by a fenced literal payload; other actions use one JSON object.')
    .replace('Actions (emit exactly one, as compact JSON):', 'Actions (emit exactly one; write_file uses the file-block format above):')
    .replace(/^- \{"a":"write_file"[^\n]*$/gm, '- write_file: {"a":"write_file","p":"path/to/file"} followed by a closed code fence containing the literal file contents.')
    .replace(/^- \{"a":"edit_lines"[^\n]*$/gm, '- edit_lines: {"a":"edit_lines","p":"path/to/file","start":12,"end":18} followed by a closed code fence containing literal replacement lines.')}`;
}

export function parseDiffusionGemmaAction(raw) {
  const text = String(raw ?? '').trim();
  const start = /^(\{[^\n]*\})\r?\n(`{3,})[^\r\n]*\r?\n/.exec(text);
  if (!start) {
    const parsed = parseAction(raw);
    if (parsed.ok || parsed.kind !== 'validation') return parsed;
    // DiffusionGemma often names the advertised read-only preview tool as its
    // action. Route that one unambiguous shorthand through the normal query
    // dispatcher; it retains tool availability and browser/network policy.
    let alias;
    try { alias = JSON.parse(text); } catch { return parsed; }
    const argument = typeof alias.p === 'string' && !Object.hasOwn(alias, 'q') ? alias.p
      : typeof alias.q === 'string' && !Object.hasOwn(alias, 'p') ? alias.q : null;
    if (alias.a !== 'preview' || argument === null || Object.keys(alias).some(key => !['a', 'p', 'q'].includes(key))) return parsed;
    const checked = ActionSchema.safeParse({ a: 'query', q: `preview ${argument}`.trimEnd() });
    return checked.success ? { ok: true, action: checked.data, strictJson: true, repairedJson: false, alias: 'preview' } : parsed;
  }
  let header;
  try { header = JSON.parse(start[1]); } catch { return parseAction(raw); }
  const lineEdit = header.a === 'edit_lines';
  const keys = lineEdit ? ['a', 'p', 'start', 'end'] : ['a', 'p'];
  if ((!lineEdit && header.a !== 'write_file') || Object.keys(header).some(k => !keys.includes(k))) {
    return { ok: false, kind: 'validation', error: 'File blocks require a write_file or edit_lines header without a JSON payload field.' };
  }
  const end = new RegExp(`\\r?\\n${start[2]}[ \\t]*$`).exec(text.slice(start[0].length));
  if (!end) return { ok: false, kind: 'unterminated_json', error: 'File block is incomplete or has trailing text; close the fence and emit nothing afterward.', partialAction: { action: header.a, path: header.p } };
  const content = text.slice(start[0].length, start[0].length + end.index);
  const checked = ActionSchema.safeParse({ ...header, [lineEdit ? 'new' : 'content']: content });
  if (!checked.success) return { ok: false, kind: 'validation', error: `action failed validation: ${checked.error.issues[0].message}` };
  return { ok: true, action: checked.data, strictJson: false, repairedJson: false, fileBlock: true };
}

// Return only a complete, validated action. This runs on the visible final
// channel while streaming, so a thought's code fence cannot stop generation.
// The transport canonicalizes the action just as structured-output adapters
// do; source bytes survive JSON encoding unchanged.
export function completedDiffusionGemmaAction(value) {
  const visible = diffusionGemmaFinalText(value).trimStart();
  if (!visible.startsWith('{')) return null;
  const json = extractFirstJsonObject(visible);
  if (json) {
    const parsed = parseDiffusionGemmaAction(json);
    if (parsed.ok) return JSON.stringify(parsed.action);
  }
  const start = /^(\{[^\n]*\})\r?\n(`{3,})[^\r\n]*\r?\n/.exec(visible);
  if (!start) return null;
  const end = new RegExp(`\\r?\\n${start[2]}[ \\t]*(?=\\r?\\n|$)`).exec(visible.slice(start[0].length));
  if (!end) return null;
  const parsed = parseDiffusionGemmaAction(visible.slice(0, start[0].length + end.index + end[0].length));
  return parsed.ok ? JSON.stringify(parsed.action) : null;
}

// A generated source field has no action header: the CPU has already selected
// the tool and path. Stop on its matching closing fence, outside thought text.
export function completedDiffusionGemmaValue(value) {
  const visible = diffusionGemmaFinalText(value).trimStart();
  const start = /^(`{3,})[^\r\n]*\r?\n/.exec(visible);
  if (!start) return null;
  const end = new RegExp(`\\r?\\n${start[1]}[ \\t]*(?=\\r?\\n|$)`).exec(visible.slice(start[0].length));
  return end ? visible.slice(0, start[0].length + end.index + end[0].length) : null;
}

// Preserve channel delimiters at the server, then expose only final text.
// Removing special tokens before parsing would concatenate thought and answer.
export function diffusionGemmaFinalText(value) {
  let text = String(value ?? '').replace(/^<\|turn>model\n/, '');
  const open = '<|channel>thought\n';
  if (open.startsWith(text) && text) return '';
  if ('<channel|>'.startsWith(text) && text) return '';
  if (text.startsWith(open)) {
    const end = text.indexOf('<channel|>', open.length);
    if (end < 0) return ''; // Also hide incomplete thoughts while streaming.
    text = text.slice(end + '<channel|>'.length);
  }
  // A template with an already-closed empty thought can generate one more
  // closer before the final answer. It is metadata, never an agent action.
  text = text.replace(/^(?:<channel\|>)+/, '');
  return text.replace(/(?:<turn\|>|<eos>)\s*$/, '');
}
