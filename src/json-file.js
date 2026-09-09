// Large evidence records must not be assembled into a single V8 string.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {types} from 'node:util';
import {parseChunked} from '@discoveryjs/json-ext';

/** Parse and hash the same bytes, including when a record exceeds 512 MiB. */
export async function readJsonFile(filePath, {withHash = false, highWaterMark = 1024 * 1024} = {}) {
  const hash = withHash ? crypto.createHash('sha256') : null;
  const stream = fs.createReadStream(filePath, {highWaterMark});
  async function* chunks() {
    for await (const bytes of stream) { hash?.update(bytes); yield bytes; }
  }
  try {
    let value, roots = 0;
    await parseChunked(chunks(), {mode: 'json', onRootValue(parsed) { value = parsed; roots++; }});
    // Require a closed root: an EOF immediately after a completed nested value
    // must not turn an interrupted checkpoint into a seemingly valid record.
    if (roots !== 1) throw new SyntaxError('Incomplete JSON document');
    return withHash ? {value, sha256: hash.digest('hex')} : value;
  } finally {
    stream.destroy();
  }
}

/** JSON.stringify/parse semantics without a whole-document intermediate string.
 * Capture getters and toJSON exactly once before validating or publishing.
 * Strings are immutable, so the snapshot can retain them without copying.
 */
export function snapshotJsonValue(input) {
  const ancestors = new Set();
  function copy(value, key) {
    if (value !== null && (typeof value === 'object' || typeof value === 'bigint')
      && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (types.isNumberObject(value)) value = Number(value);
    else if (types.isStringObject(value)) value = String(value);
    else if (types.isBooleanObject(value)) value = Boolean.prototype.valueOf.call(value);
    else if (types.isBigIntObject(value)) value = BigInt.prototype.valueOf.call(value);
    if (typeof value === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return undefined;
    if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length = value.length, result = new Array(length);
        for (let i = 0; i < length; i++) result[i] = copy(value[i], String(i)) ?? null;
        return result;
      }
      const result = {};
      for (const name of Object.keys(value)) {
        const child = copy(value[name], name);
        if (child !== undefined) Object.defineProperty(result, name,
          {value: child, enumerable: true, writable: true, configurable: true});
      }
      return result;
    } finally { ancestors.delete(value); }
  }
  return copy(input, '');
}
