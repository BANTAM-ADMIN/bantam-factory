import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRequirements, requirementChecklistSuffix} from '../src/requirement-checklist.js';

// A named input's element preconditions are rejection cases, and the visible
// tests routinely cover none of them. Measured 2026-09-08 on the glob-select
// work order: a candidate implemented six of the seven constraints in one such
// sentence, dropped "unique", ticked the requirement off in its own done
// reasoning, and shipped with green tests throughout.

const globSelect = '`paths` must be a dense array of unique nonempty strings. Each path is relative\n'
  + 'and POSIX-style. `patterns` must be a dense array of nonempty strings.\n'
  + 'Invalid inputs throw an Error.';

test('a collection shape demand is quoted back with its element constraints', () => {
  const items = extractRequirements(globSelect);
  const shape = items.find(i => /dense array of unique nonempty strings/.test(i));
  assert.ok(shape, `expected the uniqueness precondition to be extracted, got ${JSON.stringify(items)}`);
  assert.match(requirementChecklistSuffix(globSelect), /unique/);
});

test('the existing rejection and literal families still fire alongside it', () => {
  const items = extractRequirements(globSelect);
  assert.ok(items.some(i => /Invalid inputs throw an Error/.test(i)), 'rejection sentence retained');
  const numeric = extractRequirements('The buffer holds at most 32 bytes and rejects more than 11 digits.');
  assert.ok(numeric.some(i => /32 bytes/.test(i)) && numeric.some(i => /11 digits/.test(i)), 'bounds retained');
});

test('other shape vocabularies used by the existing kits are covered', () => {
  for (const [label, task] of [
    ['non-null object', 'Options must be a non-null, non-array object with all these required fields.'],
    ['unique id', '`rules` must be a dense array of non-null objects, each with a unique nonempty string `id`.'],
    ['distinct', 'The entries must be a distinct list of identifiers.'],
  ]) {
    assert.ok(extractRequirements(task).some(i => /must be a/i.test(i)), label);
  }
});

test('ordinary prose does not become a requirement', () => {
  for (const prose of [
    'This must be the fastest approach we have tried.',
    'The result should be a good starting point for review.',
    'Reviewers must be available before the release.',
  ]) {
    const items = extractRequirements(prose);
    assert.deepEqual(items.filter(i => /must be/i.test(i)), [], prose);
  }
});

test('an empty or requirement-free task still yields no checklist', () => {
  assert.deepEqual(extractRequirements(''), []);
  assert.equal(requirementChecklistSuffix('Refactor the helper for readability.'), '');
});
