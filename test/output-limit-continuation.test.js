import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canResumeWriteFile, resumableWriteFilePrefix } from '../src/output-limit-continuation.js';
import { runAgent } from '../src/agent.js';

describe('output-limit continuation', () => {
  it('recognizes only an open write_file content string', () => {
    const prefix = '{"a":"write_file","p":"plan.md","content":"First line\\nSecond';
    assert.equal(resumableWriteFilePrefix(prefix), prefix);
    assert.equal(resumableWriteFilePrefix(prefix + "\\"), prefix + "\\");
    assert.equal(resumableWriteFilePrefix(prefix + '"'), null);
    assert.equal(resumableWriteFilePrefix('{"a":"shell","c":"echo hi'), null);
    assert.equal(canResumeWriteFile({}), true);
    assert.equal(canResumeWriteFile({ codex: true }), false);
    assert.equal(canResumeWriteFile({ chatTransportReady: true }), false);
  });

  it('continues a capped document action without regenerating its prefix', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-continue-write-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const prefix = '{"a":"write_file","p":"plan.md","content":"# Plan\\n\\nFirst section.\\n\\nSecond';
    const prompts = [];
    const grammars = [];
    const model = {
      nPredict: 8192, assistantPrefill: '', actTemperature: null,
      async complete(prompt, opts) {
        prompts.push(String(prompt));
        grammars.push(opts.grammar);
        if (prompts.length === 2) assert.equal(fs.existsSync(path.join(workspace, "plan.md")), false);
        return prompts.length === 1
          ? { content: prefix, tokens: 8192, stoppedLimit: true }
          : { content: ' section.\\n\\nEnd.\\n"}', tokens: 12, stoppedEos: true };
      },
    };
    const result = await runAgent({ task: 'Write plan.md as a detailed plan.', workspace, model,
      maxTurns: 1, useGrammar: true, grounding: false, shellSandbox: 'host',
      verificationPolicy: 'after_edit' });
    assert.equal(prompts.length, 2);
    assert.ok(grammars[0]);
    assert.equal(grammars[1], undefined);
    assert.ok(prompts[1].endsWith(prefix));
    assert.equal(fs.readFileSync(path.join(workspace, 'plan.md'), 'utf8'),
      '# Plan\n\nFirst section.\n\nSecond section.\n\nEnd.\n');
    assert.equal(result.rejectedOutputs[0].kind, 'output_limit');
  });
});
