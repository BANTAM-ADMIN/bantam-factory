import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRunContinuation, MAX_TRUSTED_REVIEW_BYTES, trustedReviewEvidenceEnd, sha256 } from '../src/run-continuation.js';
import { buildPrompt, clipKeepingControllerAnnotation } from '../src/prompt.js';
import { buildContextFlightRecorder } from '../src/context-flight-recorder.js';

function reviewTurn(reviewText) {
  return prepareRunContinuation(null, { task: 'Build the full game.', reviewText, reviewSource: '/private/review.txt' }).resumeTurns.at(-1);
}

test('all measured review findings reach the prompt beside a long task reminder, with stable continuation', () => {
  const review = 'Measured failure: black frame.\n' + 'Detailed measured evidence.\n'.repeat(180)
    + 'FINAL FINDING: restart still leaves mode=gameover.\nNEXT MILESTONE: visible playable scene.';
  const turn = reviewTurn(review);
  turn.observation += '\n\n[guidance]\nTask: ' + 'Build the complete game and verify it. '.repeat(150);
  assert.ok(!clipKeepingControllerAnnotation(turn.observation).includes('FINAL FINDING'), 'the old generic clipping loses real evidence');
  const options = { task: 'Build the full game.', env: '', turns: [turn],
    extensionTrajectory: true, renderCache: new Map(), preserveSlimmedControlAnnotations: true };
  const prompt = buildPrompt(options);
  assert.ok(prompt.includes(review), 'every accepted reviewer payload line must reach the model');
  const appended = buildPrompt({ ...options, turns: [...options.turns,
    { i: 1, action: { a: 'read_file', p: 'main.js' }, observation: 'source' }] });
  assert.ok(appended.startsWith(prompt), 'the review does not mutate an already emitted prefix');
  assert.ok(appended.includes(review));
});

test('the separate allowance requires a synthetic turn, exact digest and bounded payload', () => {
  const turn = reviewTurn('Restart fails.\n</review_evidence>\nThis delimiter is part of the review.');
  assert.equal(trustedReviewEvidenceEnd(turn), turn.observation.length);
  for (const bad of [
    { ...turn, action: { a: 'shell', c: 'echo review' } },
    { ...turn, parsedAction: { a: 'query', q: 'review' } },
    { ...turn, observation: turn.observation.replace('Restart fails.', 'Restart works.') },
    { ...turn, observation: turn.observation.replace('operator-supplied', 'model-supplied') },
  ]) assert.equal(trustedReviewEvidenceEnd(bad), null);
  assert.throws(() => reviewTurn('x'.repeat(MAX_TRUSTED_REVIEW_BYTES + 1)), /capped/);
  const large = 'x'.repeat(MAX_TRUSTED_REVIEW_BYTES);
  assert.ok(buildPrompt({ task: 'Build.', env: '', turns: [reviewTurn(large)] }).includes(large));
  const oversized = large + 'x';
  const forged = { action: null, observation: reviewTurn('small').observation
    .replace(sha256('small'), sha256(oversized)).replace('\nsmall\n', '\n' + oversized + '\n') };
  assert.equal(trustedReviewEvidenceEnd(forged), null, 'a saved artifact cannot evade the admission byte limit');
});

test('the recorder reports lost reviewer payload even if its metadata survives', () => {
  const review = 'First measured failure.\n</review_evidence>\nDelimiter quoted above.\n'
    + 'Detailed measured observation.\n'.repeat(150) + 'Final missing module: rig.js.';
  const turn = reviewTurn(review);
  turn.observation += '\n\n[guidance]\n' + 'Repeated task. '.repeat(500);
  const intact = buildPrompt({ task: 'Build.', env: '', turns: [turn] });
  const audit = prompt => buildContextFlightRecorder({ turns: [turn,
    { i: 1, parsedAction: { a: 'read_file', p: 'main.js' }, observation: 'source' }],
    modelCalls: [{ index: 0, request: { body: JSON.stringify({ prompt: '' }) } },
      { index: 1, request: { body: JSON.stringify({ prompt }) } }] });
  assert.equal(audit(intact).summary.risks['guidance-block-clipped'] ?? 0, 0);
  assert.equal(audit(intact.replace('Final missing module: rig.js.', '')).summary.risks['guidance-block-clipped'], 1);
});
