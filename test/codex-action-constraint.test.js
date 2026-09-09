import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelClient } from '../src/model.js';
import { actionJsonSchema } from '../src/grammar.js';

test('default sampling affects only Codex actions; explicit schema opt-in restores constraints', t => {
  const old = process.env.BANTAM_CODEX_ACTION_SCHEMA;
  delete process.env.BANTAM_CODEX_ACTION_SCHEMA;
  t.after(() => { if (old === undefined) delete process.env.BANTAM_CODEX_ACTION_SCHEMA; else process.env.BANTAM_CODEX_ACTION_SCHEMA = old; });
  const model = new ModelClient({ codex: true }); t.after(() => model.close());
  const schema = actionJsonSchema({ features: ['write_batch'] });
  const request = model.buildRequest('choose an action', { grammar: 'action grammar', jsonSchema: schema });
  const body = JSON.parse(request.body);
  assert.equal(body.constrainOutput, false);
  assert.deepEqual(body.outputSchema, schema, 'the action validation contract remains recorded');
  assert.ok(request.jsonSchemaSha256);
  process.env.BANTAM_CODEX_ACTION_SCHEMA = 'on';
  assert.equal(JSON.parse(model.buildRequest('choose an action', {jsonSchema: schema}).body).constrainOutput, undefined);
  process.env.BANTAM_CODEX_ACTION_SCHEMA = 'off';
  assert.equal(JSON.parse(model.buildRequest('choose an action', {jsonSchema: schema}).body).constrainOutput, false);
  const data = { type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false };
  assert.equal(JSON.parse(model.buildRequest('a declarative spec', { jsonSchema: data }).body).constrainOutput, undefined);
  const local = new ModelClient({}); t.after(() => local.close());
  assert.equal(JSON.parse(local.buildRequest('local action', { grammar: 'original grammar', jsonSchema: schema }).body).grammar, 'original grammar');
});

test('bridge action opt-out preserves normalized acknowledgements and session reuse', async t => {
  const old = process.env.BANTAM_CODEX_ACTION_SCHEMA, fetch = globalThis.fetch;
  process.env.BANTAM_CODEX_ACTION_SCHEMA = 'off';
  t.after(() => { globalThis.fetch = fetch; if (old === undefined) delete process.env.BANTAM_CODEX_ACTION_SCHEMA; else process.env.BANTAM_CODEX_ACTION_SCHEMA = old; });
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'DELETE') return new Response('{}');
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:'{"a":"read_file","limit":10,"p":"main.js"}'}}],usage:{prompt_tokens:100,completion_tokens:20}}));
  };
  const model = new ModelClient({ apiUrl: 'http://bridge/v1', apiDialect: 'chat' });
  model.enableChatSessions(); t.after(() => model.close());
  const first = '<|im_start|>system\nUse actions.<|im_end|>\n<|im_start|>user\nInspect.<|im_end|>\n<|im_start|>assistant\n';
  const schema = actionJsonSchema();
  const result = await model.complete(first, { grammar:'action grammar', jsonSchema:schema });
  assert.equal(result.content, '{"a":"read_file","p":"main.js","limit":10}');
  await model.complete(first + result.content + '<|im_end|>\n<|im_start|>user\nFile contents.<|im_end|>\n<|im_start|>assistant\n', { grammar:'action grammar', jsonSchema:schema });
  assert.ok(bodies.every(body => !body.response_format));
  assert.equal(bodies[0].session_id, bodies[1].session_id);
  assert.equal(bodies[1].messages.length, 1);
});
