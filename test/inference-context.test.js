import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferenceContext, isTextualInference } from '../src/factory/inference-context.js';

const question = {
  type: 'choice',
  instructions: 'Classify the relationship.\nPremise: A bird is on the roof.\nHypothesis: An animal is on the roof.',
  criteria: { A: 'entailment', B: 'neutral', C: 'contradiction' },
};

describe('textual inference context scope', () => {
  it('recognizes semantics independently of option keys and order', () => {
    const before = JSON.stringify(question);
    assert.match(inferenceContext(question), /Missing information is not a contradiction/);
    assert.equal(inferenceContext({ ...question, criteria: { no: ' Contradiction ', unknown: 'NEUTRAL', yes: 'entailment' } }), inferenceContext(question));
    assert.equal(JSON.stringify(question), before);
  });

  it('does not apply to other three-way classifications or malformed inference tasks', () => {
    for (const candidate of [
      null,
      { ...question, type: 'noul' },
      { ...question, instructions: 'Determine whether to use entailment, neutral or contradiction.' },
      { ...question, instructions: 'Premise: text without a hypothesis' },
      { ...question, instructions: 'Premise: \nHypothesis: something' },
      { ...question, criteria: { A: 'entailment', B: 'neutral', C: 'neutral' } },
      { ...question, criteria: { A: 'favor', B: 'neutral', C: 'against' } },
      { ...question, criteria: { A: 'entailment', B: 'neutral' } },
      { ...question, criteria: { A: 'entailment', B: 'neutral', C: 'contradiction', D: 'unknown' } },
      { ...question, criteria: { A: { meaning: 'entailment' }, B: 'neutral', C: 'contradiction' } },
    ]) {
      assert.equal(inferenceContext(candidate), null);
      assert.equal(isTextualInference(candidate), false);
    }
  });
});

it('forces reasoning for a confident inference question while preserving unrelated decisions', async () => {
  const { decideJevAdaptive } = await import('../src/factory/system-one.js');
  const pool = ['HA', 'HB', 'HC', 'HD'].map((handle, tokenId) => ({ handle, tokenId }));
  let thoughts = 0;
  const reader = {
    compileLabels: async ({ labels }) => ({ labels }),
    read: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map((l, i) => [l, i === 0 ? .999 : .0005])), promptTokens: 10 }),
    think: async () => { thoughts++; return { prefixIds: [1], promptTokens: 10, thoughtTokens: 10, truncated: false }; },
    readAfter: async ({ compiled }) => ({ probabilities: Object.fromEntries(compiled.labels.map((l, i) => [l, i === 2 ? .999 : .0005])), promptTokens: 10 }),
  };
  const questions = { inference: question, other: { ...question, instructions: 'Pick a color.', criteria: { A: 'red', B: 'green', C: 'blue' } } };
  const base = { reader, pool, state: {}, questions, seed: 123, gate: .95, thinkBlend: .75 };
  const original = await decideJevAdaptive(base);
  assert.equal(thoughts, 0);
  const fixed = await decideJevAdaptive({ ...base, inferenceThink: true });
  assert.equal(thoughts, 1);
  assert.notEqual(fixed.answers.inference.choice, original.answers.inference.choice);
  assert.deepEqual(fixed.answers.other, original.answers.other);
  assert.deepEqual(Object.keys(fixed.answers.inference.probabilities), ['A', 'B', 'C']);
  assert.ok(fixed.evidence.inference.some(step => step.step === 'inferencecheck'));
  assert.ok(fixed.evidence.inference.some(step => step.step === 'think'));
  assert.ok(!fixed.evidence.other.some(step => step.step === 'inferencecheck'));
});
