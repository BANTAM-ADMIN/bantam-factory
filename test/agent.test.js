import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test the agent module's core decision logic
import { editMadeNoChange, editPaths, editSucceeded, isEditAction, turnEditApplied } from '../src/edit-actions.js';
import { runAgent, shouldSeedRepositoryBrief } from '../src/agent.js';
import { ADVISORY_EXCLUDED_ACTIONS } from '../src/task-intent.js';

describe('edit-actions.js — isEditAction', () => {
  it('identifies a replace action', () => {
    const mockMockFn = () => ({});
    assert.ok(isEditAction({ a: 'replace', p: 'x.js', old: 'a', new: 'b' }));
  });

  it('identifies a write_file action', () => {
    assert.ok(isEditAction({ a: 'write_file', p: 'x.js', content: 'hello' }));
  });

  it('rejects a read_file action', () => {
    assert.ok(!isEditAction({ a: 'read_file', p: 'x.js' }));
  });

  it('rejects a shell action', () => {
    assert.ok(!isEditAction({ a: 'shell', c: 'echo hi' }));
  });

  it('rejects a done action', () => {
    assert.ok(!isEditAction({ a: 'done', summary: 'ok' }));
  });
});

describe('edit-actions.js — editPaths', () => {
  it('returns empty for non-edit action', () => {
    const paths = editPaths({ a: 'read_file', p: 'x.js' });
    assert.deepStrictEqual(paths, []);
  });

  it('returns path for replace action', () => {
    const paths = editPaths({ a: 'replace', p: 'x.js', old: 'a', new: 'b' });
    assert.deepStrictEqual(paths, ['x.js']);
  });

  it('returns path for write_file action', () => {
    const paths = editPaths({ a: 'write_file', p: 'x.js', content: 'hi' });
    assert.deepStrictEqual(paths, ['x.js']);
  });
});

describe('edit-actions.js — editSucceeded', () => {
  it('returns false when no action', () => {
    assert.ok(!editSucceeded(null));
  });

  it('returns true for a replace action', () => {
    assert.ok(editSucceeded({ a: 'replace', p: 'x.js', old: 'a', new: 'b' }));
  });

  it('returns true for a write_file action', () => {
    assert.ok(editSucceeded({ a: 'write_file', p: 'x.js', content: 'hi' }));
  });
});

describe('edit-actions.js — editMadeNoChange', () => {
  it('returns false for a normal replace', () => {
    assert.ok(!editMadeNoChange({ a: 'replace', p: 'x.js', old: 'a', new: 'b' }, 'replaced x.js'));
  });

  it('returns true when observation says NO_CHANGE', () => {
    assert.ok(editMadeNoChange({ a: 'replace', p: 'x.js', old: 'a', new: 'b' }, 'NO_CHANGE: no match'));
  });
});

describe('edit-actions.js — turnEditApplied', () => {
  it('returns false for no action', () => {
    assert.ok(!turnEditApplied(null));
  });

  it('returns true for a replace turn with editApplied flag', () => {
    assert.ok(turnEditApplied({ action: { a: 'replace', p: 'x.js', old: 'a', new: 'b' }, editApplied: true }));
  });

  it('returns true for a write_file turn with observation', () => {
    assert.ok(turnEditApplied({ action: { a: 'write_file', p: 'x.js', content: 'hi' }, observation: 'wrote x.js' }));
  });

  it('returns false for a read_file turn', () => {
    assert.ok(!turnEditApplied({ action: { a: 'read_file', p: 'x.js' }, observation: 'contents...' }));
  });
});

describe('terminal model failures', () => {
  it('returns structured non-retryable timeout evidence instead of an unexplained empty run', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-model-timeout-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const lifecycle = [];
    const runToken = Symbol('run');
    const model = {
      assistantPrefill: '',
      profileName: 'codex',
      beginAgentRun() {
        lifecycle.push('begin');
        return runToken;
      },
      endAgentRun(token) {
        lifecycle.push(token === runToken ? 'end' : 'wrong-token');
      },
      async complete() {
        const error = new Error('Codex turn was inactive for 100ms');
        error.code = 'model_timeout';
        error.provider = 'codex';
        error.timeoutKind = 'idle';
        error.retryable = false;
        throw error;
      },
    };

    const result = await runAgent({
      task: 'Read package.json.',
      workspace,
      model,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: false,
      shellSandbox: 'host',
    });

    assert.equal(result.reachedDone, false);
    assert.equal(result.metrics.modelErrors, 1);
    assert.deepEqual(result.modelFailure, {
      message: 'Codex turn was inactive for 100ms',
      code: 'model_timeout',
      provider: 'codex',
      timeoutKind: 'idle',
      retryable: false,
    });
    assert.deepEqual(lifecycle, ['begin', 'end']);
  });
});

describe('automatic repository-map context', () => {
  it('recognizes architecture and feature analysis without routing ordinary implementation work', () => {
    assert.equal(shouldSeedRepositoryBrief(
      'Lets do a little cycle of self improvement. What would be the next big feature we could add to BANTAM? Take a look at your code.',
    ), true);
    assert.equal(shouldSeedRepositoryBrief('Explain this codebase architecture and startup flow.'), true);
    assert.equal(shouldSeedRepositoryBrief('Recommend the highest-impact capability for this project.'), true);

    assert.equal(shouldSeedRepositoryBrief('Fix the parser bug.'), false);
    assert.equal(shouldSeedRepositoryBrief('Build semantic code search.'), false);
    assert.equal(shouldSeedRepositoryBrief('Take a look at the codebase and then refactor the parser.'), false);

    assert.equal(shouldSeedRepositoryBrief(
      'Session so far (context only):\n- you asked: "What next major feature should we add?"\n\nNew request: Fix the parser bug.',
    ), false);
    assert.equal(shouldSeedRepositoryBrief(
      'Session so far (context only):\n- you asked: "Can you fix the parser?"\n\nNew request: Explain this codebase architecture.',
    ), true);
  });

  it('seeds one live brief before the first turn and retains it without duplicate map work', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-context-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'entry.js'), 'export const entry = true;\n');

    const mapCalls = [];
    const map = {
      name: 'map',
      description: 'fixture repository map',
      verbs: ['brief', 'arch'],
      answer(query) {
        mapCalls.push(query);
        return 'FIXTURE LIVE BRIEF: entry.js exports entry';
      },
    };
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'src/entry.js' }),
      JSON.stringify({ a: 'respond', text: 'The next feature should extend the entry flow.' }),
    ]);

    const result = await runAgent({
      task: 'Lets do a little cycle of self improvement. What would be the next big feature we could add to BANTAM? Take a look at your code.',
      workspace,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [map],
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.deepEqual(mapCalls, ['brief']);
    assert.equal(model.prompts.length, 2);
    for (const prompt of model.prompts) {
      assert.match(prompt, /Live repository map \(automatic brief, refreshed from the current tree\)/);
      assert.equal(prompt.match(/FIXTURE LIVE BRIEF/g)?.length, 1);
    }
    assert.match(model.prompts[0], /already supplied in the repository context/);
    assert.match(model.prompts[0], /do not propose a listed tool \(including `concept` meaning search\) as missing/i);
    assert.match(model.prompts[0], /Do not invent percentages or benchmark claims/i);
  });

  it('does not call or inject the map for an ordinary fix request', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-negative-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'parser.js'), 'export const parse = () => null;\n');

    let mapCalls = 0;
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'respond', text: 'Ready to fix the parser.' }),
    ]);
    await runAgent({
      task: 'Fix the parser bug.',
      workspace,
      model,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'fixture repository map',
        verbs: ['brief'],
        answer() {
          mapCalls += 1;
          return 'SHOULD NOT APPEAR';
        },
      }],
      shellSandbox: 'host',
    });

    assert.equal(mapCalls, 0);
    assert.doesNotMatch(model.prompts[0], /SHOULD NOT APPEAR|automatic brief/);
  });

  it('degrades cleanly when an injected map throws before the first turn', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-throws-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'entry.js'), 'export const entry = true;\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'respond', text: 'I can still answer without the optional map.' }),
    ]);

    const result = await runAgent({
      task: 'What major feature should we add to this codebase?',
      workspace,
      model,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'throwing fixture',
        verbs: ['brief'],
        answer() { throw new Error('fixture map outage'); },
      }],
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.doesNotMatch(model.prompts[0], /fixture map outage|Live repository map/);
  });

  it('lets an explicit map query supersede the automatic brief', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-explicit-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'entry.js'), 'export const entry = true;\n');
    const mapCalls = [];
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'query', q: 'map arch' }),
      JSON.stringify({ a: 'respond', text: 'Architecture understood.' }),
    ]);

    await runAgent({
      task: 'Explain this codebase architecture.',
      workspace,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'explicit-query fixture',
        verbs: ['brief', 'arch'],
        answer(query) {
          mapCalls.push(query);
          return query === 'arch' ? 'EXPLICIT ARCHITECTURE' : 'AUTOMATIC BRIEF';
        },
      }],
      shellSandbox: 'host',
    });

    assert.deepEqual(mapCalls, ['brief', 'arch', 'arch']);
    assert.match(model.prompts[0], /automatic brief[\s\S]*AUTOMATIC BRIEF/i);
    assert.match(model.prompts[1], /query from turn 1[\s\S]*EXPLICIT ARCHITECTURE/i);
    assert.doesNotMatch(model.prompts[1], /AUTOMATIC BRIEF/);
  });

  it('refreshes the automatic brief after a successful workspace edit', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-edit-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'entry.js'), 'export const entry = 1;\n');
    let mapCalls = 0;
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'replace', p: 'entry.js', old: 'entry = 1', new: 'entry = 2' }),
      JSON.stringify({ a: 'respond', text: 'The repository context refreshed.' }),
    ]);

    await runAgent({
      task: 'What major feature should we add to this codebase?',
      workspace,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'generation fixture',
        verbs: ['brief'],
        answer() {
          mapCalls += 1;
          return `BRIEF GENERATION ${mapCalls}`;
        },
      }],
      shellSandbox: 'host',
    });

    assert.equal(mapCalls, 2);
    assert.match(model.prompts[0], /BRIEF GENERATION 1/);
    assert.match(model.prompts[1], /BRIEF GENERATION 2/);
  });

  it('invalidates a broken-tree brief when the regression guard restores prior bytes', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-rollback-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'test'));
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(
      path.join(workspace, 'src', 'value.js'),
      'export function value() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(workspace, 'test', 'value.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { value } from '../src/value.js';",
        "test('value stays one', () => assert.equal(value(), 1));",
        "",
      ].join('\n'),
    );
    const model = scriptedPromptModel([
      JSON.stringify({
        a: 'replace',
        p: 'src/value.js',
        old: 'return 1;',
        new: 'return 1; /* passing baseline */',
      }),
      JSON.stringify({ a: 'shell', c: 'node --test test/value.test.js' }),
      JSON.stringify({ a: 'replace', p: 'src/value.js', old: 'return 1', new: 'return 2' }),
      JSON.stringify({ a: 'shell', c: 'node --test test/value.test.js' }),
      JSON.stringify({ a: 'respond', text: 'The failed experiment was rolled back.' }),
    ]);

    await runAgent({
      task: 'What major feature should we add to this codebase?',
      workspace,
      model,
      maxTurns: 5,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'rollback fixture',
        verbs: ['brief'],
        answer() {
          const source = fs.readFileSync(path.join(workspace, 'src', 'value.js'), 'utf8');
          return source.includes('return 2') ? 'BROKEN TREE BRIEF' : 'RESTORED TREE BRIEF';
        },
      }],
      shellSandbox: 'host',
    });

    assert.equal(
      fs.readFileSync(path.join(workspace, 'src', 'value.js'), 'utf8'),
      'export function value() { return 1; /* passing baseline */ }\n',
    );
    assert.match(model.prompts[3], /BROKEN TREE BRIEF/);
    assert.match(model.prompts[4], /RESTORED TREE BRIEF/);
  });

  it('crosses discovery, registry, and first-prompt injection with the configured implementation', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-full-seam-'));
    const implementation = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-impl-'));
    t.after(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(implementation, { recursive: true, force: true });
    });
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(workspace, `module-${i}.js`), `export const module${i} = ${i};\n`);
    }
    fs.writeFileSync(
      path.join(implementation, 'extract_js.cjs'),
      "process.stdout.write(JSON.stringify({ files: [] }));\n",
    );
    fs.writeFileSync(
      path.join(implementation, 'query.py'),
      "import sys\nprint('FULL-SEAM-MAP:' + sys.argv[1])\n",
    );
    const prior = {
      dir: process.env.BANTAM_REPOMAP_DIR,
      min: process.env.BANTAM_MAP_MIN_FILES,
      off: process.env.BANTAM_NO_MAP,
    };
    process.env.BANTAM_REPOMAP_DIR = implementation;
    process.env.BANTAM_MAP_MIN_FILES = '1';
    delete process.env.BANTAM_NO_MAP;
    t.after(() => {
      if (prior.dir === undefined) delete process.env.BANTAM_REPOMAP_DIR;
      else process.env.BANTAM_REPOMAP_DIR = prior.dir;
      if (prior.min === undefined) delete process.env.BANTAM_MAP_MIN_FILES;
      else process.env.BANTAM_MAP_MIN_FILES = prior.min;
      if (prior.off === undefined) delete process.env.BANTAM_NO_MAP;
      else process.env.BANTAM_NO_MAP = prior.off;
    });
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'respond', text: 'The map arrived automatically.' }),
    ]);

    await runAgent({
      task: 'What major feature should we add to this codebase?',
      workspace,
      model,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: true,
      shellSandbox: 'host',
    });

    assert.match(model.prompts[0], /Live repository map \(automatic brief/);
    assert.match(model.prompts[0], /FULL-SEAM-MAP:brief/);
  });

  it('uses a tighter investigation budget once whole-repository discovery is already seeded', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-map-budget-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(workspace, `module-${i}.js`), `export const module${i} = ${i};\n`);
    }
    const outputs = Array.from(
      { length: 7 },
      (_, i) => JSON.stringify({ a: 'read_file', p: `module-${i}.js` }),
    );
    outputs.push(JSON.stringify({ a: 'respond', text: 'Six focused checks were enough.' }));
    const model = scriptedPromptModel(outputs);

    const result = await runAgent({
      task: 'What major feature should we add to this codebase?',
      workspace,
      model,
      maxTurns: 8,
      interactive: true,
      useGrammar: false,
      grounding: true,
      extraTools: [{
        name: 'map',
        description: 'budget fixture',
        verbs: ['brief'],
        answer() { return 'SEEDED WHOLE-REPOSITORY BRIEF'; },
      }],
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.equal(result.turns.length, 8);
    assert.match(result.turns[6].observation, /^\[investigation budget reached\]/);
    assert.equal(result.turns[7].action.a, 'respond');
  });
});

describe('caller action policy', () => {
  it('rejects a disabled raw action before execution and accepts a safe retry', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-policy-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'write_file', p: 'forbidden.txt', content: 'nope' }),
      JSON.stringify({ a: 'respond', text: 'Safe advisory response.' }),
    ]);

    const result = await runAgent({
      task: 'What should we improve?',
      workspace,
      model,
      maxTurns: 1,
      maxInvalidPerTurn: 2,
      interactive: true,
      useGrammar: false,
      excludeActions: ['write_file', 'shell', 'done'],
      verificationPolicy: 'after_edit',
      grounding: false,
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.equal(result.metrics.invalid, 1);
    assert.equal(result.metrics.modelRequests, 2);
    assert.equal(result.metrics.auxiliaryModelRequests, 1);
    assert.equal(result.metrics.modelRequestsPerTurn, 2);
    assert.equal(fs.existsSync(path.join(workspace, 'forbidden.txt')), false);
    assert.equal(result.rejectedOutputs[0].kind, 'caller_policy');
  });

  it('keeps dynamically enabled patch behind the complete advisory caller policy', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-dynamic-policy-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'source.js'), 'export const value = 1;\n');
    const model = scriptedPromptModel([
      JSON.stringify({
        a: 'patch',
        edits: [{ p: 'source.js', old: 'value = 1', new: 'value = 2' }],
      }),
      JSON.stringify({ a: 'respond', text: 'Patch was unavailable in this read-only lane.' }),
    ]);

    const result = await runAgent({
      task: 'What change would you recommend in this advisory scout?',
      workspace,
      model,
      maxTurns: 1,
      maxInvalidPerTurn: 2,
      interactive: true,
      useGrammar: true,
      patchAction: 'on',
      excludeActions: ADVISORY_EXCLUDED_ACTIONS,
      verificationPolicy: 'after_edit',
      grounding: false,
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.equal(result.metrics.invalid, 1);
    assert.equal(result.rejectedOutputs[0].kind, 'caller_policy');
    assert.equal(fs.readFileSync(path.join(workspace, 'source.js'), 'utf8'), 'export const value = 1;\n');
  });

  it('masks reconnaissance after a caller-owned investigation budget', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-scout-budget-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'one.js'), 'export const one = 1;\n');
    fs.writeFileSync(path.join(workspace, 'two.js'), 'export const two = 2;\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'one.js' }),
      JSON.stringify({ a: 'read_file', p: 'two.js' }),
      JSON.stringify({ a: 'respond', text: 'Two reads were enough.' }),
    ]);
    const events = [];

    const result = await runAgent({
      task: 'Inspect the two files and report.',
      workspace,
      model,
      maxTurns: 5,
      investigationActionLimit: 2,
      excludeActions: ['replace', 'write_file', 'shell', 'done'],
      verificationPolicy: 'after_edit',
      grounding: false,
      shellSandbox: 'host',
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.responded, true);
    assert.equal(result.turns.length, 3);
    assert.ok(events.some((event) => event.type === 'wrap_up_mask'));
  });

  it('accepts an unattended advisory response even when quoted context is implementation-shaped', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-advisory-intent-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'source.js'), 'export const value = 1;\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'source.js' }),
      JSON.stringify({
        a: 'respond',
        text: 'The implementation should preserve the exported value contract.',
      }),
    ]);
    const events = [];

    const result = await runAgent({
      task: 'Read-only specialist pass. Original operator task: Implement the feature.',
      workspace,
      model,
      maxTurns: 3,
      advisoryMode: true,
      excludeActions: ADVISORY_EXCLUDED_ACTIONS,
      verificationPolicy: 'after_edit',
      grounding: false,
      shellSandbox: 'host',
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.responded, true);
    assert.equal(result.turns.length, 2);
    assert.equal(result.metrics.emptyDoneRejections ?? 0, 0);
    assert.equal(events.some((event) => event.type === 'done_rejected'), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'source.js'), 'utf8'), 'export const value = 1;\n');
  });
});

describe('external workspace coherence', () => {
  it('invalidates cached reads and reanchors the next turn after an external edit', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-external-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, 'src'));
    const sourcePath = path.join(workspace, 'src', 'value.js');
    fs.writeFileSync(sourcePath, 'export const value = "old";\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'src/value.js' }),
      JSON.stringify({ a: 'read_file', p: 'src/value.js' }),
      JSON.stringify({ a: 'respond', text: 'I used the externally updated value.' }),
    ]);
    const events = [];
    let observations = 0;

    const result = await runAgent({
      task: 'Inspect the value and explain its current state.',
      workspace,
      model,
      maxTurns: 3,
      interactive: true,
      useGrammar: false,
      grounding: false,
      openFilesView: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
      onEvent(event) {
        events.push(event);
        if (event.type === 'observation' && ++observations === 1) {
          // Same byte length proves this is fingerprint coherence, not a size check.
          fs.writeFileSync(sourcePath, 'export const value = "new";\n');
        }
      },
    });

    assert.equal(result.responded, true);
    assert.match(result.turns[1].observation, /value = "new"/);
    assert.doesNotMatch(result.turns[1].observation, /^\[(?:repetition|ledger)\]/);
    assert.match(model.prompts[1], /EXTERNAL WORKSPACE CHANGE/);
    assert.match(model.prompts[1], /src\/value\.js/);
    assert.equal(result.metrics.externalWorkspaceMutationEvents, 1);
    assert.equal(result.metrics.externalWorkspaceMutationPaths, 1);
    assert.equal(result.metrics.externalWorkspaceMutationBlockedActions, 0);
    assert.ok(events.some((event) =>
      event.type === 'external_workspace_change'
      && event.phase === 'turn_start'
      && event.paths.includes('src/value.js')));
  });

  it('blocks a stale write selected while an external edit lands', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-external-write-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const sourcePath = path.join(workspace, 'value.js');
    fs.writeFileSync(sourcePath, 'export const value = "old";\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'value.js' }),
      JSON.stringify({ a: 'write_file', p: 'value.js', content: 'export const value = "stale";\n' }),
      JSON.stringify({ a: 'respond', text: 'The external edit was preserved.' }),
    ]);
    const events = [];
    let actionEvents = 0;

    const result = await runAgent({
      task: 'Inspect and update the value safely.',
      workspace,
      model,
      maxTurns: 3,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
      onEvent(event) {
        events.push(event);
        if (event.type === 'action' && ++actionEvents === 2) {
          fs.writeFileSync(sourcePath, 'export const value = "human";\n');
        }
      },
    });

    assert.equal(result.responded, true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'export const value = "human";\n');
    assert.match(result.turns[1].observation, /^\[external-workspace-change\]/);
    assert.equal(result.turns[1].editApplied, false);
    assert.equal(result.metrics.externalWorkspaceMutationEvents, 1);
    assert.equal(result.metrics.externalWorkspaceMutationPaths, 1);
    assert.equal(result.metrics.externalWorkspaceMutationBlockedActions, 1);
    assert.ok(events.some((event) =>
      event.type === 'external_workspace_action_blocked'
      && event.paths.includes('value.js')));
    assert.match(model.prompts[2], /EXTERNAL WORKSPACE CHANGE/);
  });

  it('detects an edit made between checkpointed agent invocations', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-external-resume-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const sourcePath = path.join(workspace, 'value.js');
    fs.writeFileSync(sourcePath, 'export const value = "old";\n');
    const initialModel = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'value.js' }),
    ]);
    const initial = await runAgent({
      task: 'Inspect the current value.',
      workspace,
      model: initialModel,
      maxTurns: 1,
      interactive: true,
      useGrammar: false,
      grounding: false,
      openFilesView: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    });
    assert.ok(initial.turns[0].workspaceCoherence?.fingerprints?.['value.js']);

    fs.writeFileSync(sourcePath, 'export const value = "new";\n');
    const resumedModel = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'value.js' }),
      JSON.stringify({ a: 'respond', text: 'Resume used the current bytes.' }),
    ]);
    const resumed = await runAgent({
      task: 'Inspect the current value.',
      workspace,
      model: resumedModel,
      resumeTurns: initial.turns,
      maxTurns: 3,
      interactive: true,
      useGrammar: false,
      grounding: false,
      openFilesView: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    });

    assert.equal(resumed.responded, true);
    assert.match(resumedModel.prompts[0], /EXTERNAL WORKSPACE CHANGE/);
    assert.match(resumed.turns[1].observation, /value = "new"/);
    assert.doesNotMatch(resumed.turns[1].observation, /^\[(?:repetition|ledger)\]/);
    assert.equal(resumed.metrics.externalWorkspaceMutationEvents, 1);
  });
});

describe('prompt-resident source recovery', () => {
  it('re-executes a historical read after its bytes leave the live panel', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-context-residency-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const names = 'abcdefghijklm'.split('');
    for (const name of names) {
      fs.writeFileSync(path.join(workspace, `${name}.js`), `export const ${name} = '${name}';\n`);
    }
    const model = scriptedPromptModel([
      ...[...names, 'a'].map((name) => JSON.stringify({ a: 'read_file', p: `${name}.js` })),
      JSON.stringify({ a: 'respond', text: 'Recovered the evicted bytes.' }),
    ]);

    const result = await runAgent({
      task: 'Inspect these files and report what a.js currently contains.',
      workspace,
      model,
      maxTurns: 15,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    assert.match(result.turns[13].observation, /export const a = 'a'/);
    assert.doesNotMatch(result.turns[13].observation, /^\[(?:repetition|ledger|open_files)\]/);
    assert.match(model.prompts[13], /Read history/);
    assert.doesNotMatch(model.prompts[13], /# a\.js \(current/,
      'the repeated read must be tested after a.js has actually left the live panel');
  });

  it('keeps one six-file inspect batch resident in authored priority order', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-inspect-residency-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const names = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
    for (const name of names) fs.writeFileSync(path.join(workspace, `${name}.js`), `export const ${name} = 1;\n`);
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'inspect', ops: names.map((name) => ({ a: 'read_file', p: `${name}.js` })) }),
      JSON.stringify({ a: 'respond', text: 'All requested files remained visible.' }),
    ]);

    const result = await runAgent({
      task: 'Inspect all six files and report.',
      workspace,
      model,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    });

    assert.equal(result.responded, true);
    for (const name of names) assert.match(model.prompts[1], new RegExp(`# ${name}\\.js \\(current`));
  });

  it('output-limit recovery preserves a requested single-file deliverable', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-output-limit-format-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const prompts = [];
    const model = { nPredict: 8192, assistantPrefill: '', actTemperature: null,
      async complete(prompt) {
        prompts.push(String(prompt));
        return prompts.length === 1
          ? { content: '{"a":"write_file","p":"game.html","content":"unfinished', tokens: 8192, stoppedLimit: true }
          : { content: JSON.stringify({ a: 'write_file', p: 'game.html', content: '<main>Game</main>' }), tokens: 20, stoppedEos: true };
      } };
    await runAgent({ task: 'Build a game in one self-contained HTML file.', workspace, model, maxTurns: 1,
      useGrammar: false, grounding: false, shellSandbox: 'host', verificationPolicy: 'after_edit' });
    assert.match(prompts[1], /output-limit/);
    assert.match(prompts[1], /keep the program in that file/);
    assert.match(prompts[1], /modules only when the task permits/);
    assert.doesNotMatch(prompts[1], /split substantial code into multiple files/);
  });

  it('automatic game preview requests the interaction evidence required by done', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-auto-preview-context-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const calls = [];
    const preview = { name: 'preview', description: 'fixture preview', verbs: ['preview'],
      answer(query) { calls.push(query); this.lastResult = { status: 'pass', mode: 'interact', entry: 'index.html' }; return 'PREVIEW STATUS: pass'; } };
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'write_file', p: 'index.html', content: '<main>Playable game</main>' }),
      JSON.stringify({ a: 'done', summary: 'Built the game.' }),
      JSON.stringify({ a: 'done', summary: 'Built and previewed the game.' }),
    ]);
    const result = await runAgent({ task: 'Make a playable HTML game.', workspace, model, maxTurns: 3,
      useGrammar: false, grounding: true, extraTools: [preview], shellSandbox: 'host',
      verificationPolicy: 'after_edit' });
    assert.deepEqual(calls, ['interact']); // Registry consumes the leading tool verb.
    assert.match(model.prompts[2], /preview interact/);
    assert.doesNotMatch(model.prompts[2], /then run "preview" to confirm/);
    assert.equal(result.turns[1].doneAccepted, false);
  });

  it('delivers the enforced wall deadline in the literal model prompt', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-wall-context-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const model = scriptedPromptModel([JSON.stringify({ a: 'respond', text: 'Ready.' })]);
    await runAgent({ task: 'Say ready.', workspace, model, maxTurns: 60,
      interactive: true, useGrammar: false, grounding: false, wallDeadlineMs: 600000,
      shellSandbox: 'host' });
    assert.match(model.prompts[0], /\[budget\] wall clock:.*of 10m/);
    assert.match(model.prompts[0], /killed on TIME/);
  });

  it('reanchors the exact task near the action boundary by default', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-goal-reanchor-default-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'value.js'), 'export const value = 1;\n');
    const exactClause = 'The accepted language requires exactly one @ and a nonempty domain.';
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'read_file', p: 'value.js', start: 1, limit: 1 }),
      JSON.stringify({ a: 'search', q: 'value', p: 'value.js' }),
      JSON.stringify({ a: 'list_dir', p: '.' }),
      JSON.stringify({ a: 'respond', text: 'Done.' }),
    ]);

    await runAgent({
      task: exactClause,
      workspace,
      model,
      maxTurns: 4,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    });

    const prompt = model.prompts[3];
    const reminderAt = prompt.lastIndexOf('Reminder — your objective');
    assert.ok(reminderAt > prompt.indexOf(`Task: ${exactClause}`), 'expected a fresh second copy of the task');
    assert.ok(prompt.length - reminderAt < 10_000, 'the reanchor must remain in the volatile prompt tail');
    assert.match(prompt.slice(reminderAt), /exactly one @ and a nonempty domain/);
  });

  it('pins the executor-reported failed patch path and retains its proposal', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-edit-recovery-path-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'page.js'), 'export const page = 1;\n');
    fs.writeFileSync(path.join(workspace, 'coordinates.js'), 'export const coordinates = 1;\n');
    const proposedPage = 'export const page = 2;\n';
    const model = scriptedPromptModel([
      JSON.stringify({
        a: 'patch',
        edits: [
          { p: 'page.js', old: 'export const page = 0;\n', new: proposedPage },
          { p: 'coordinates.js', old: 'export const coordinates = 1;\n', new: 'export const coordinates = 2;\n' },
        ],
      }),
      JSON.stringify({ a: 'write_file', p: 'page.js', content: proposedPage }),
      JSON.stringify({ a: 'respond', text: 'Recovered the failed path.' }),
    ]);
    const events = [];

    const result = await runAgent({
      task: 'Update page.js safely.',
      workspace,
      model,
      maxTurns: 3,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
      onEvent: (event) => events.push(event),
    });

    assert.match(result.turns[0].observation, /patch edit 1 \(page\.js\)/);
    assert.match(model.prompts[1], /EDIT RECOVERY ACTIVE: an exact-match edit to page\.js failed/);
    assert.match(model.prompts[1], /# page\.js \(current/);
    assert.match(model.prompts[1], /export const page = 2/,
      'the rejected semantic proposal must survive prompt slimming');
    assert.doesNotMatch(model.prompts[1], /EDIT RECOVERY ACTIVE:[^\n]*coordinates\.js/);
    assert.ok(events.some((event) => event.type === 'edit_recovery_started' && event.path === 'page.js'));
  });
});

describe('execution-state shadow authority', () => {
  it('cannot change model prompts or accepted actions', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-execution-shadow-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'value.js'), 'export const value = 1;\n');
    const outputs = [
      JSON.stringify({ a: 'read_file', p: 'value.js' }),
      JSON.stringify({ a: 'respond', text: 'The value is 1.' }),
    ];
    const shadowModel = scriptedPromptModel([...outputs]);
    const controlModel = scriptedPromptModel([...outputs]);
    const shadowEvents = [];
    const common = {
      task: 'Read value.js and report its value.',
      workspace,
      maxTurns: 2,
      interactive: true,
      useGrammar: false,
      grounding: false,
      verificationPolicy: 'after_edit',
      shellSandbox: 'host',
    };

    const shadow = await runAgent({
      ...common,
      model: shadowModel,
      executionStateShadow: true,
      onEvent: (event) => shadowEvents.push(event),
    });
    const control = await runAgent({
      ...common,
      model: controlModel,
      executionStateShadow: false,
    });

    assert.deepStrictEqual(shadowModel.prompts, controlModel.prompts);
    assert.deepStrictEqual(shadow.turns.map((turn) => turn.action), control.turns.map((turn) => turn.action));
    assert.ok(shadowEvents.some((event) => event.type === 'execution_state_shadow'));
    assert.ok(shadowEvents.some((event) => event.type === 'execution_state_shadow_action'));
    assert.deepStrictEqual(shadow.metrics.executionStateShadowTransitions, {
      'investigate->read_file': 1,
      'implement->respond': 1,
    });
    assert.equal(control.metrics.executionStateShadow, false);
  });
});

describe('autonomous implementation responses', () => {
  it('rejects a respond action so a model that identifies a bug must repair it', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-agent-respond-repair-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
    fs.writeFileSync(path.join(workspace, 'target.js'), 'export const value = "initial";\n');
    // This intentionally thin public test stays green for either implementation,
    // just like the range-parser fixture that prompted the guard.
    fs.writeFileSync(path.join(workspace, 'target.test.js'), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "./target.js";',
      'test("value is a string", () => assert.equal(typeof value, "string"));',
    ].join('\n'));
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'write_file', p: 'target.js', content: 'export const value = "buggy";\n' }),
      JSON.stringify({ a: 'shell', c: 'npm test' }),
      JSON.stringify({ a: 'respond', text: 'There is a bug in this implementation; I need to fix it.' }),
      JSON.stringify({ a: 'write_file', p: 'target.js', content: 'export const value = "fixed";\n' }),
      JSON.stringify({ a: 'shell', c: 'npm test' }),
      JSON.stringify({ a: 'done', summary: 'Implemented and verified the fix.' }),
    ]);

    const result = await runAgent({
      task: 'Fix target.js so the implementation is correct.',
      workspace,
      model,
      maxTurns: 8,
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: 'host',
      verificationScript: 'npm test',
    });

    assert.equal(result.reachedDone, true);
    assert.equal(result.responded, false);
    assert.equal(result.metrics.implementationRespondRejections, 1);
    assert.equal(result.turns.length, 6);
    assert.match(result.turns[2].observation, /^\[implementation-response\]/);
    assert.equal(fs.readFileSync(path.join(workspace, 'target.js'), 'utf8'), 'export const value = "fixed";\n');
  });
});

describe('compound verifier scope recognition', () => {
  it('credits an exact baseline verifier segment without asking for a redundant rerun', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-compound-verify-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
    fs.writeFileSync(path.join(workspace, 'target.js'), 'export const value = "old";\n');
    fs.writeFileSync(path.join(workspace, 'target.test.js'), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "./target.js";',
      'test("target is fixed", () => assert.equal(value, "fixed"));',
    ].join('\n'));
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'write_file', p: 'target.js', content: 'export const value = "fixed";\n' }),
      JSON.stringify({ a: 'shell', c: 'npm test' }),
      JSON.stringify({
        a: 'shell',
        c: 'node -e "console.log(\'focused probe passed\')"\nnpm test',
      }),
      JSON.stringify({ a: 'done', summary: 'Implemented and verified the fix.' }),
    ]);

    const result = await runAgent({
      task: 'Fix target.js and verify the result.',
      workspace,
      model,
      maxTurns: 4,
      completionAudit: false,
      stateAudit: 'off',
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: 'host',
      verificationScript: 'npm test',
    });

    assert.equal(result.reachedDone, true);
    assert.equal(result.metrics.embeddedBaselineRecognitions, 1);
    assert.equal(result.metrics.scopeMismatchNotices, 0);
    assert.match(result.turns[2].observation, /exact baseline verifier/i);
    assert.match(result.turns[2].observation, /do not rerun it solely/i);
    assert.doesNotMatch(result.turns[2].observation, /different test command/i);
  });

  it('retains the conservative mismatch behavior when explicitly rolled back', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-compound-verify-off-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
    fs.writeFileSync(path.join(workspace, 'target.js'), 'export const value = "fixed";\n');
    fs.writeFileSync(path.join(workspace, 'target.test.js'), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "./target.js";',
      'test("target is fixed", () => assert.equal(value, "fixed"));',
    ].join('\n'));
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'shell', c: 'npm test' }),
      JSON.stringify({
        a: 'shell',
        c: 'node -e "console.log(\'focused probe passed\')"\nnpm test',
      }),
    ]);

    const result = await runAgent({
      task: 'Verify target.js.',
      workspace,
      model,
      maxTurns: 2,
      embeddedBaselineScope: false,
      completionAudit: false,
      stateAudit: 'off',
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: 'host',
      verificationScript: 'npm test',
    });

    assert.equal(result.metrics.embeddedBaselineRecognitions, 0);
    assert.equal(result.metrics.scopeMismatchNotices, 1);
    assert.match(result.turns[1].observation, /different test command/i);
  });
});

describe('successful inline shell replay slimming', () => {
  it('keeps exact run evidence while removing the duplicated command from the next prompt', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-shell-replay-slim-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}');
    const filler = '// replay-only-contract-probe-filler\n'.repeat(40);
    const command = [
      "node --input-type=module <<'EOF'",
      filler,
      "console.log('focused probe passed');",
      'EOF',
    ].join('\n');
    const model = scriptedPromptModel([
      JSON.stringify({ a: 'shell', c: command }),
      JSON.stringify({ a: 'done', summary: 'Focused probe passed.' }),
    ]);

    const result = await runAgent({
      task: 'Run the focused verification probe and report its observed result.',
      workspace,
      model,
      maxTurns: 2,
      successfulShellReplaySlim: true,
      completionAudit: false,
      stateAudit: 'off',
      interactive: false,
      useGrammar: false,
      grounding: false,
      shellSandbox: 'host',
    });

    assert.equal(result.metrics.successfulShellReplaySlims, 1);
    assert.equal(result.metrics.successfulShellReplayOmittedChars, command.length);
    assert.equal(result.turns[0].action.c, command);
    assert.match(result.turns[0].observation, /replay-only-contract-probe-filler/);
    assert.equal(model.prompts.length, 2);
    assert.doesNotMatch(model.prompts[1], /replay-only-contract-probe-filler/);
    assert.match(model.prompts[1], /successful inline shell probe omitted/);
    assert.match(model.prompts[1], /focused probe passed/);
  });
});

function scriptedPromptModel(outputs) {
  return {
    assistantPrefill: '',
    actTemperature: null,
    prompts: [],
    requestCursor() {
      return this.prompts.length;
    },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return {
        content: outputs.shift(),
        tokens: 1,
        stoppedEos: true,
        stoppedLimit: false,
        timings: {},
      };
    },
  };
}
