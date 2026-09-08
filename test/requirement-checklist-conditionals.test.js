import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRequirements} from '../src/requirement-checklist.js';

// The checklist covered what makes input invalid and nothing about what the
// code must do. Measured 2026-09-08 on turtle-canvas: it quoted four
// validation rules, the candidate failed three behavioural ones, and not one
// of the three was quoted. All three are stated plainly in the assignment:
// a negative move goes backward, a move off the canvas stops at the boundary
// cell, and marking a marked cell overwrites it.

const turtle = [
  "Commands are:",
  "- `{op:'move', n}` where `n` is a safe integer, moving `n` cells forward, or",
  "  backward when negative.",
  "A move that would leave the canvas is clipped: the turtle advances only while",
  "inside, stops at the boundary cell, and the rest of the move is discarded.",
  "Marking a cell that is already marked overwrites it with the current character",
  "and does not count again.",
].join('\n');

test('a conditional restriction is quoted', () => {
  const items = extractRequirements(turtle);
  assert.ok(items.some(i => /only while inside/.test(i)),
    `expected the clipping rule, got ${JSON.stringify(items)}`);
});

test('an override of an existing value is quoted', () => {
  assert.ok(extractRequirements(turtle).some(i => /already marked overwrites/.test(i)));
});

test('a stated alternative behaviour is quoted', () => {
  assert.ok(extractRequirements(turtle).some(i => /backward when negative/.test(i)));
});

test('the same family covers the other assignments it was measured against', () => {
  for (const [label, text, expected] of [
    ['only when', 'The tenth frame takes two rolls, plus a third only when the first two are a strike.', /only when/],
    ['or N when', '`total` is the last non-null cumulative, or 0 when no frame scored.', /or 0 when/],
    ['except that', 'Display width counts one per code point, except that a fullwidth glyph counts two.', /except that/],
    ['already active', 'A code already active is not introduced twice.', /already active/],
    ['rather than', 'A cycle must be reported rather than exhausting the stack.', /rather than/],
    ['instead of', 'Report a miss instead of throwing.', /instead of/],
  ]) {
    assert.ok(extractRequirements(text).some(i => expected.test(i)), `${label}: ${JSON.stringify(extractRequirements(text))}`);
  }
});

// A flowed markdown table matches almost any prose pattern and is never a
// requirement sentence; nor is a statement about what the starter already
// provides, which is context rather than a rule the candidate must satisfy.
test('a table row is not mistaken for a requirement', () => {
  const table = 'Categories, from strongest to weakest:\n\n| rank | category |\n|---:|---|\n| 8 | straight-flush only when suited |\n';
  assert.deepEqual(extractRequirements(table).filter(i => i.includes('|')), []);
});

test('a description of the provided starter is not a requirement', () => {
  const text = '`path-scope.js` already exports a working `normalizeSegments(input)`.';
  assert.deepEqual(extractRequirements(text).filter(i => /already exports/.test(i)), []);
});

test('the families that already worked keep working', () => {
  const items = extractRequirements('A bare field may not contain `"`. Invalid inputs throw an Error.');
  assert.ok(items.some(i => /may not contain/.test(i)), 'prohibition retained');
  assert.ok(items.some(i => /throw an Error/.test(i)), 'rejection retained');
  assert.ok(extractRequirements('`paths` must be a dense array of unique strings.')
    .some(i => /dense array of unique/.test(i)), 'collection shape retained');
});

test('ordinary prose still yields nothing', () => {
  assert.deepEqual(extractRequirements('Return the sum of the two numbers.'), []);
});
