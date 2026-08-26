import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseAction, ActionSchema } from '../src/actions.js';

describe('actions.js — parseAction', () => {
  it('parses a simple read_file action', () => {
    const json = JSON.stringify({ a: 'read_file', p: 'src/agent.js', limit: 50 });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'read_file');
    assert.strictEqual(result.action.p, 'src/agent.js');
    assert.strictEqual(result.action.limit, 50);
  });

  it('parses a shell action', () => {
    const json = JSON.stringify({ a: 'shell', c: 'echo hello' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'shell');
    assert.strictEqual(result.action.c, 'echo hello');
  });

  it('parses a done action with summary', () => {
    const json = JSON.stringify({ a: 'done', summary: 'all good' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'done');
    assert.strictEqual(result.action.summary, 'all good');
  });

  it('parses a write_file action', () => {
    const json = JSON.stringify({ a: 'write_file', p: 'out.txt', content: 'hello' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'write_file');
    assert.strictEqual(result.action.p, 'out.txt');
    assert.strictEqual(result.action.content, 'hello');
  });

  it('parses a bounded write_batch action', () => {
    const files = [
      { p: 'src/a.js', content: 'export const a = 1;\n' },
      { p: 'test/a.test.js', content: 'console.assert(true);\n' },
    ];
    const result = parseAction(JSON.stringify({ a: 'write_batch', files }));
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'write_batch');
    assert.deepStrictEqual(result.action.files, files);
  });

  it('parses a list_dir action', () => {
    const json = JSON.stringify({ a: 'list_dir', p: '.' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'list_dir');
    assert.strictEqual(result.action.p, '.');
  });

  it('parses a replace action with old/new', () => {
    const json = JSON.stringify({ a: 'replace', p: 'x.js', old: 'a', new: 'b' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'replace');
    assert.strictEqual(result.action.old, 'a');
    assert.strictEqual(result.action.new, 'b');
  });

  it('returns ok:false on invalid JSON', () => {
    const result = parseAction('{not valid}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'invalid_json');
  });

  it('returns ok:false on no JSON at all', () => {
    const result = parseAction('just text');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'no_json');
  });

  it('returns ok:false on missing action type', () => {
    const result = parseAction('{}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('returns ok:false on unknown action type', () => {
    const result = parseAction('{"a":"fly_to_mars"}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('returns ok:false on read_file with no path', () => {
    const result = parseAction('{"a":"read_file"}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('returns ok:false on shell with no command', () => {
    const result = parseAction('{"a":"shell"}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('extracts first JSON object from prose', () => {
    const result = parseAction('Sure! Here is the action: {"a":"done","summary":"ok"} and more text');
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'done');
    assert.strictEqual(result.action.summary, 'ok');
  });

  it('handles unterminated JSON', () => {
    const result = parseAction('{"a":"read_file","p":"src/agent.js');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'unterminated_json');
  });

  it('sets strictJson:true when input is clean JSON only', () => {
    const result = parseAction('{"a":"done","summary":"ok"}');
    assert.ok(result.ok);
    assert.strictEqual(result.strictJson, true);
  });

  it('sets strictJson:false when prose surrounds JSON', () => {
    const result = parseAction('go {"a":"done","summary":"ok"}');
    assert.ok(result.ok);
    assert.strictEqual(result.strictJson, false);
  });
});

describe('actions.js — ActionSchema', () => {
  it('validates a read_file action', () => {
    const result = ActionSchema.safeParse({ a: 'read_file', p: 'x.js' });
    assert.ok(result.success);
    assert.strictEqual(result.data.a, 'read_file');
  });

  it('rejects an action with wrong field type', () => {
    const result = ActionSchema.safeParse({ a: 'read_file', p: 100 });
    assert.ok(!result.success);
  });

  it('rejects a plain object', () => {
    const result = ActionSchema.safeParse({ a: 'read_file' });
    assert.ok(!result.success);
  });
});

describe('actions.js — search action', () => {
  it('parses a search with query only', () => {
    const json = JSON.stringify({ a: 'search', q: 'export default' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'search');
    assert.strictEqual(result.action.q, 'export default');
  });

  it('parses a search with query and path', () => {
    const json = JSON.stringify({ a: 'search', q: 'regex', p: 'src' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'search');
    assert.strictEqual(result.action.q, 'regex');
    assert.strictEqual(result.action.p, 'src');
  });

  it('parses a search with query, path, and limit', () => {
    const json = JSON.stringify({ a: 'search', q: 'TODO', p: 'src', limit: 20 });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'search');
    assert.strictEqual(result.action.q, 'TODO');
    assert.strictEqual(result.action.p, 'src');
    assert.strictEqual(result.action.limit, 20);
  });

  it('rejects a search with no query', () => {
    const result = parseAction('{"a":"search"}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('rejects a search with empty query string', () => {
    const result = parseAction('{"a":"search","q":""}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('rejects a search with non-string query', () => {
    const result = parseAction('{"a":"search","q":100}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('rejects a search with non-integer limit', () => {
    const result = parseAction('{"a":"search","q":"test","limit":"ten"}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('rejects a search with negative limit', () => {
    const result = parseAction('{"a":"search","q":"test","limit":-5}');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'validation');
  });

  it('validates search via ActionSchema', () => {
    const result = ActionSchema.safeParse({ a: 'search', q: 'regex', p: 'src', limit: 10 });
    assert.ok(result.success);
    assert.strictEqual(result.data.a, 'search');
    assert.strictEqual(result.data.q, 'regex');
    assert.strictEqual(result.data.p, 'src');
    assert.strictEqual(result.data.limit, 10);
  });

  it('rejects search via ActionSchema with missing query', () => {
    const result = ActionSchema.safeParse({ a: 'search', p: 'src' });
    assert.ok(!result.success);
  });

  it('accepts search with empty path string', () => {
    const result = parseAction('{"a":"search","q":"test","p":""}');
    assert.ok(result.ok);
    assert.strictEqual(result.action.a, 'search');
    assert.strictEqual(result.action.q, 'test');
  });

  it('parses search with regex special characters', () => {
    const json = JSON.stringify({ a: 'search', q: 'export\\s+(const|let|function)' });
    const result = parseAction(json);
    assert.ok(result.ok);
    assert.strictEqual(result.action.q, 'export\\s+(const|let|function)');
  });
});
