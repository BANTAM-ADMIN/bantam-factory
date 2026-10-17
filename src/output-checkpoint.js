import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeTextAtomic, writeJsonAtomic } from './atomic-file.js';
import { normalizeWorkspaceAction } from './workspace-alias.js';

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const IDENTIFIER = /^[a-f0-9]{32}\/[a-f0-9]{32}$/;

// Decode only unambiguous JSON values already received. This is DATA recovery,
// never an action parser or permission to execute an unfinished tool call.
export function partialOutputData(raw) {
  const text = String(raw ?? '').trimStart().replace(/^<think>[\s\S]*?<\/think>\s*/, '').replace(/^```json[ \t]*\r?\n/, '');
  if (!text.startsWith('{')) return null;
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const decode = fragment => JSON.parse(fragment.replace(/[\u0000-\u001f]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')));
  const string = () => {
    const start = i++;
    let end = i;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '"') return { value: decode(text.slice(start, i)), complete: true };
      if (ch === '\\') {
        const escapeStart = i - 1, escape = text[i++];
        if (escape === undefined) { end = escapeStart; break; }
        if (escape === 'u') {
          const hex = text.slice(i, i + 4);
          if (hex.length < 4 && /^[a-f0-9]*$/i.test(hex)) { end = escapeStart; break; }
          if (!/^[a-f0-9]{4}$/i.test(hex)) throw Error('invalid escape');
          i += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) throw Error('invalid escape');
      }
      end = i;
    }
    let value = decode(text.slice(start, end) + '"');
    // A split UTF-16 pair cannot be stored as UTF-8 without changing it. The
    // exact original is retained separately as JSON, including that fragment.
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    return { value, complete: false };
  };
  const node = depth => {
    if (depth > 32) throw Error('too deeply nested');
    space();
    if (text[i] === '"') return string();
    const opener = text[i];
    if (opener === '{' || opener === '[') {
      i++; space();
      const value = opener === '{' ? Object.create(null) : [];
      const closer = opener === '{' ? '}' : ']';
      if (text[i] === closer) { i++; return { value, complete: true }; }
      while (i < text.length) {
        let key;
        if (opener === '{') {
          if (text[i] !== '"') throw Error('invalid key');
          const name = string();
          if (!name.complete) return { value, complete: false };
          key = name.value;
          if (Object.hasOwn(value, key)) throw Error('duplicate key');
          space();
          if (i === text.length) return { value, complete: false };
          if (text[i++] !== ':') throw Error('missing colon');
          space();
        }
        if (i === text.length) return { value, complete: false };
        const child = node(depth + 1);
        if (opener === '{') {
          if (child.complete || !['a', 'p', 'checkpoint'].includes(key)) value[key] = child.value;
        } else value.push(child.value);
        if (!child.complete) return { value, complete: false };
        space();
        if (text[i] === closer) { i++; return { value, complete: true }; }
        if (i === text.length) return { value, complete: false };
        if (text[i++] !== ',') throw Error('invalid separator');
        space();
      }
      return { value, complete: false };
    }
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) throw Error('incomplete scalar');
    i += match[0].length;
    return { value: JSON.parse(match[0]), complete: i < text.length };
  };
  try { return node(0).value; } catch { return null; }
}

export function createOutputCheckpointStore(executor) {
  const run = crypto.randomBytes(16).toString('hex');
  const entries = new Map();
  const base = id => `.bantam/output-checkpoints/${id}`;
  const targetState = target => {
    try { return { exists: true, sha256: digest(executor.safeReadText(executor.resolveExisting(target))) }; }
    catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  };
  const write = (relative, content, json = false) => {
    const lexical = executor.resolve(relative);
    executor.assertWritablePolicy(lexical, relative);
    const full = executor.resolveWriteTarget(relative);
    return json ? writeJsonAtomic(full, content) : writeTextAtomic(full, content);
  };
  const load = id => {
    if (!IDENTIFIER.test(String(id))) throw Error('Invalid output checkpoint identifier');
    let entry = entries.get(id);
    if (!entry) {
      const record = JSON.parse(executor.safeReadText(executor.resolveExisting(`${base(id)}/checkpoint.json`)));
      if (record.id !== id || record.version !== 1) throw Error('Invalid output checkpoint record');
      entry = record;
    }
    if (!entry.target || entry.verb !== 'write_file' || !entry.payloadSha256 || !entry.baseline) throw Error('This checkpoint has no recoverable file prefix');
    const prefix = executor.safeReadText(executor.resolveExisting(`${base(id)}/content.txt`));
    if (digest(prefix) !== entry.payloadSha256) throw Error('Output checkpoint content changed; read the draft before editing');
    return { ...entry, prefix };
  };
  const current = entry => {
    const actual = targetState(entry.target);
    if (JSON.stringify(actual) !== JSON.stringify(entry.baseline)) throw Error('The target changed since the output checkpoint; read the current file before editing');
  };
  return {
    restore(id) {
      const entry = load(id);
      current(entry);
      const { prefix, ...receipt } = entry;
      entries.set(id, receipt);
      return receipt;
    },
    begin({ turn, attempt }) {
      return { id: `${run}/${crypto.randomBytes(16).toString('hex')}`, turn, attempt, lastAt: 0, lastChars: 0 };
    },
    save(slot, raw, { force = false, stoppedLimit = false, partialAction = null } = {}) {
      raw = String(raw ?? '');
      if (!force && (raw.length < 256 || (Date.now() - slot.lastAt < 1000 && raw.length - slot.lastChars < 8192))) return null;
      const recovered = partialAction ?? partialOutputData(raw);
      let prefix = null, target = null, baseline = slot.baseline ?? null, recoveryError = null;
      try {
        if (recovered?.a === 'write_file' && typeof recovered.p === 'string' && typeof recovered.content === 'string') {
          target = normalizeWorkspaceAction({ a: 'write_file', p: recovered.p, content: '' }).p;
          prefix = recovered.content;
          if (recovered.checkpoint) {
            const parent = load(recovered.checkpoint);
            if (target !== parent.target) throw Error('Output checkpoint cannot be redirected to another file');
            current(parent); prefix = parent.prefix + prefix; baseline = parent.baseline;
          } else if (!baseline) baseline = targetState(target);
        }
      } catch (error) {
        // Losing recovery metadata must never lose the received text.
        recoveryError = error.message; prefix = null; baseline = null;
      }
      const entry = { version: 1, id: slot.id, turn: slot.turn, attempt: slot.attempt,
        rawPath: `${base(slot.id)}/raw.json`, draftPath: prefix === null ? null : `${base(slot.id)}/content.txt`,
        verb: recovered?.a ?? null, target, baseline, stoppedLimit,
        recoveryError, chars: raw.length, prefixChars: prefix?.length ?? 0, payloadSha256: prefix === null ? null : digest(prefix) };
      // JSON preserves even a torn escape or unpaired surrogate byte-for-byte
      // as a JS string; no malformed action is ever applied to a user file.
      write(entry.rawPath, { raw }, true);
      if (prefix !== null) write(entry.draftPath, prefix);
      write(`${base(slot.id)}/checkpoint.json`, entry, true);
      entries.set(slot.id, entry); Object.assign(slot, { baseline, lastAt: Date.now(), lastChars: raw.length });
      return entry;
    },
    assemble(action, pending = null) {
      if (!action.checkpoint) {
        if (pending?.draftPath && action.a === 'write_file' && action.p === pending.target) {
          const entry = load(pending.id);
          current(entry);
          if (!action.content.startsWith(entry.prefix)) throw Error('This write would discard the saved output. Continue with the issued checkpoint identifier and only the missing suffix.');
        }
        return action;
      }
      if (action.a !== 'write_file') throw Error('Only file writes can assemble an output checkpoint');
      if (pending?.target === action.p && action.checkpoint !== pending.id) throw Error('Use the latest output checkpoint identifier; an older prefix would discard saved progress');
      const entry = load(action.checkpoint);
      if (action.p !== entry.target) throw Error('Output checkpoint cannot be redirected to another file');
      current(entry);
      const { checkpoint, ...assembled } = action;
      return { ...assembled, content: entry.prefix + action.content };
    },
    guidance(entry) {
      if (!entry) return '';
      const header = `[output-checkpoint] Output is saved at ${entry.rawPath}. It is draft data, not an executed action.`;
      if (!entry.draftPath) return `${header}\nRead the saved output if needed and finish the task using smaller valid actions. Never execute an incomplete command or claim the truncated action ran.`;
      const prefix = load(entry.id).prefix;
      return `${header}\nThe ${entry.prefixChars}-character file prefix for ${JSON.stringify(entry.target)} is saved at ${entry.draftPath}. The destination has not been changed by this checkpoint.\nContinue and FINISH this file next. Emit ${JSON.stringify({ a: 'write_file', p: entry.target, checkpoint: entry.id, content: 'ONLY THE MISSING SUFFIX' })}. The CPU prepends the saved prefix; do NOT repeat or regenerate it. Include any needed closing code, text and delimiters in the suffix. The assembled file still passes the normal edit and verification gates. You may read the saved draft in numbered pages for more context. If necessary, finish a coherent smaller version, then extend it with bounded edits.\nExact saved ending (continue immediately after this text):\n<saved-ending>\n${prefix.slice(-1600)}\n</saved-ending>`;
    },
    receipts() { return [...entries.values()]; },
  };
}
