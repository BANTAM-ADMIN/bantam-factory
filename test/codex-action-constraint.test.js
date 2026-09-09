import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelClient } from '../src/model.js';
import { actionJsonSchema } from '../src/grammar.js';

test('schema opt-out affects only Codex actions; data schemas and other providers remain constrained', t => {
  const old = process.env.BANTAM_CODEX_ACTION_SCHEMA;
  process.env.BANTAM_CODEX_ACTION_SCHEMA = 'off';
  t.after(() => { if (old === undefined) delete process.env.BANTAM_CODEX_ACTION_SCHEMA; else process.env.BANTAM_CODEX_ACTION_SCHEMA = old; });
  const model = new ModelClient({ codex: true }); t.after(() => model.close());
  const schema = actionJsonSchema({ features: ['write_batch'] });
  const request = model.buildRequest('choose an action', { grammar: 'action grammar', jsonSchema: schema });
  const body = JSON.parse(request.body);
  assert.equal(body.constrainOutput, false);
  assert.deepEqual(body.outputSchema, schema, 'the action validation contract remains recorded');
  assert.ok(request.jsonSchemaSha256);
  const data = { type: 'object', properties: { json: { type: 'string' } }, required: ['json'], additionalProperties: false };
  assert.equal(JSON.parse(model.buildRequest('a declarative spec', { jsonSchema: data }).body).constrainOutput, undefined);
  const local = new ModelClient({}); t.after(() => local.close());
  assert.equal(JSON.parse(local.buildRequest('local action', { grammar: 'original grammar', jsonSchema: schema }).body).grammar, 'original grammar');
});
