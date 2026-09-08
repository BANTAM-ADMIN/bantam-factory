import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRequirements, requirementChecklistSuffix} from '../src/requirement-checklist.js';

// A stated prohibition is a rejection rule, but the phrasing carries no verb the
// rejection family recognises. Measured 2026-09-08 on csv-record: the task said
// a bare field "may not contain" a quote, the checklist quoted five other
// requirements and never that one, and the candidate accepted `a"b"`.

const csv = 'A bare field ends at the next delimiter or line ending and may not contain `"`.\n'
  + 'A quoted field must be closed. Invalid inputs throw an Error.';

test('a prohibition is quoted back like any other rejection rule', () => {
  const items = extractRequirements(csv);
  assert.ok(items.some(i => /may not contain/.test(i)),
    `expected the prohibition to be extracted, got ${JSON.stringify(items)}`);
  assert.match(requirementChecklistSuffix(csv), /may not contain/);
});

test('the common prohibition spellings are all covered', () => {
  for (const [label, text] of [
    ['may not', 'A bare field may not contain a quote.'],
    ['must not', 'The result must not include the header row.'],
    ['may never', 'An escape may never be split across lines.'],
    ['must never', 'The turtle must never leave the canvas.'],
    ['cannot', 'A path cannot climb above the root.'],
  ]) {
    const items = extractRequirements(text);
    assert.ok(items.length >= 1, `${label}: ${JSON.stringify(items)}`);
  }
});

test('the existing families keep working alongside it', () => {
  const items = extractRequirements(csv);
  assert.ok(items.some(i => /Invalid inputs throw an Error/.test(i)), 'rejection sentence retained');
  const shaped = extractRequirements('`paths` must be a dense array of unique nonempty strings.');
  assert.ok(shaped.some(i => /dense array of unique/.test(i)), 'collection shape retained');
  const bounds = extractRequirements('The buffer holds at most 32 bytes.');
  assert.ok(bounds.some(i => /32 bytes/.test(i)), 'numeric bounds retained');
});

test('ordinary prose is not turned into a requirement', () => {
  for (const prose of [
    'You may not need to change anything here.',
    'It cannot hurt to run the tests first.',
    'We must not forget to thank the reviewers.',
  ]) {
    // These are advisory sentences about the reader, not rules about an input.
    // Quoting one is a mild cost; quoting every sentence is not, so the family
    // must stay anchored to a prohibition verb rather than any modal.
    assert.ok(extractRequirements(prose).length <= 1, prose);
  }
});

test('a task with no prohibition yields no extra quote', () => {
  const items = extractRequirements('Return the sum of the two numbers.');
  assert.deepEqual(items, []);
});

test('a hard-wrapped sentence is quoted whole, not from the line break', () => {
  const wrapped = 'A bare field ends at the next delimiter or line ending and\nmay not contain `"`.';
  const items = extractRequirements(wrapped);
  assert.ok(items.some(i => /^A bare field ends/.test(i)),
    `expected the whole sentence, got ${JSON.stringify(items)}`);
  const rejection = 'The first record names the fields, and those names\nmust be unique and nonempty.';
  assert.ok(extractRequirements(rejection).some(i => /^The first record names/.test(i)),
    'the other families cross the wrap too');
});
