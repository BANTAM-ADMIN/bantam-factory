import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../src/agent.js';
import {composeRulesBlock, promptVersion} from '../src/prompt-rules.js';
import {COMPLETION_AUDIT_MARKER} from '../src/completion-audit.js';

test('Codex retains the assignment and completion audit without appending full-task reminders', async t => {
  const prior = process.env.BANTAM_GOAL_REANCHOR;
  t.after(() => {
    if (prior === undefined) delete process.env.BANTAM_GOAL_REANCHOR;
    else process.env.BANTAM_GOAL_REANCHOR = prior;
  });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-goal-context-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  const task = 'Explain these three modules and their interactions. Preserve every named constraint.';
  const resumeTurns = ['a.js', 'b.js', 'c.js'].map((p, i) => {
    fs.writeFileSync(path.join(workspace, p), `export const value = ${i};\n`);
    return {action: {a: 'read_file', p}, observation: `${p}: export const value = ${i};\n`
      + (i === 2 ? COMPLETION_AUDIT_MARKER : '')};
  });
  for (const promptTrajectory of ['rebuild', 'extension']) {
    for (const [provider, setting, repeated] of [
      ['codex', undefined, false], ['codexBacked', undefined, false],
      ['local', undefined, true], ['codex', '1', true], ['local', '0', false],
    ]) {
      if (setting === undefined) delete process.env.BANTAM_GOAL_REANCHOR;
      else process.env.BANTAM_GOAL_REANCHOR = setting;
      let seen = false;
      const result = await runAgent({workspace, task, promptTrajectory, resumeTurns: structuredClone(resumeTurns),
        maxTurns: 10, interactive: true, grounding: false,
        model: {[provider]: true, assistantPrefill: '', async complete(prompt) {
          seen = true;
          assert.ok(prompt.includes(`Task: ${task}`), 'the original assignment is always resident');
          assert.equal(prompt.includes('Reminder — your objective'), repeated, provider + '/' + promptTrajectory);
          assert.ok(prompt.includes('compare every explicit requirement in the original assignment'), 'the completion audit still reaches the worker');
          return {content: JSON.stringify({a: 'done', summary: 'The three modules independently export numeric constants.'}), tokens: 1};
        }},
      });
      assert.equal(seen, true);
      assert.equal(result.reachedDone, true);
    }
  }
});

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
        if(calls===1){
          assert.doesNotMatch(prompt, /SOURCE_BODY_MUST_NOT_BE_PRELOADED/);
          const example=JSON.parse(prompt.match(/^- (\{"a":"replace",[^\n]+?\})/m)[1]);
          assert.equal(Object.hasOwn(example,'line'),!enabled,'Codex unique-match example omits an unnecessary line anchor; local and rollback menus retain it');
          assert.equal(prompt.includes('omit "line" when "old" is unique'),enabled,'line disambiguation guidance');
        }
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
