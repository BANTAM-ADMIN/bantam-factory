import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';
import {composeRulesBlock, promptVersion} from '../src/prompt-rules.js';

test('Codex defaults deliver the qualified compact prompt, file discovery and batch actions with explicit rollback', async t => {
  const keys = ['BANTAM_COMPACT_RULES', 'BANTAM_WORKSPACE_TREE', 'BANTAM_WRITE_BATCH', 'BANTAM_FIXTURE_DEFAULT_HINTS'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
  }});
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-codex-defaults-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'test/public.test.js'), 'const row=(id, priority=0)=>({id,priority}); // SOURCE_BODY_MUST_NOT_BE_PRELOADED');
  for (const [provider, setting, enabled] of [
    ['codex', undefined, true], ['codexBacked', undefined, true],
    ['local', undefined, false], ['codex', '0', false], ['local', '1', true],
  ]) {
    for (const key of keys) {
      if (setting === undefined) delete process.env[key]; else process.env[key] = setting;
    }
    let calls = 0;
    const result = await runAgent({workspace, task: 'Say hello.', maxTurns: 6,
      grounding: false, interactive: true, useGrammar: true,
      model: {[provider]: true, assistantPrefill: '', async complete(prompt, options) {
        calls++;
        assert.ok(prompt.includes(composeRulesBlock(process.env, {compact: enabled})), provider);
        if(calls===1)assert.equal(prompt.includes('test/public.test.js'), enabled, provider);
        if(calls===1)assert.doesNotMatch(prompt, /SOURCE_BODY_MUST_NOT_BE_PRELOADED/);
        else assert.equal(prompt.includes('Passing undefined or omitting that argument uses the default'), enabled, 'fixture hint delivery');
        if(calls===1)assert.equal(options.jsonSchema.properties.a.enum.includes('write_batch'), enabled, provider);
        return {content: JSON.stringify(calls===1?{a:'read_file',p:'test/public.test.js'}:{a: 'done', summary: 'Hello.'}), tokens: 1};
      }},
    });
    assert.equal(calls, 2);
    assert.equal(result.reachedDone, true, JSON.stringify({provider,setting,failure:result.modelFailure,turns:result.turns}));
    assert.equal(result.promptVersion, promptVersion(process.env, {compact: enabled}));
  }
});
