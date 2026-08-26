import assert from "node:assert/strict";
import test from "node:test";

import { extractRequirements } from "../src/requirement-checklist.js";

// Preregistration: docs/superpowers/reports/2026-08-15-requirement-checklist-preregistration.md
// Conservative extraction of a task's OWN explicitly named requirements —
// numeric bounds, rejection demands, quoted literals. Never invents.

test("extracts numeric bounds with units and comparators", () => {
  const found = extractRequirements(
    "Encode a series of maximum 32-bit unsigned integers. A number is invalid when it has more than 11 digits.",
  );
  const text = found.join(" | ");
  assert.match(text, /32-bit/);
  assert.match(text, /more than 11 digits/);
});

test("extracts rejection-demand sentences", () => {
  const found = extractRequirements(
    "Great job! Now sum the values. The parser must throw an Error for non math questions. Keep the API stable.",
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /throw an Error for non math questions/);
});

test("extracts short quoted literals but not long prose quotes", () => {
  const found = extractRequirements(
    'Reject the board when "X won and O kept playing". The narrator said "a very long sentence that is definitely not an input literal because it just keeps going and going beyond any plausible token".',
  );
  assert.equal(found.filter((f) => f.includes("X won and O kept playing")).length, 1);
  assert.equal(found.some((f) => f.includes("keeps going")), false);
});

test("returns nothing for tasks without explicit requirement language", () => {
  assert.deepEqual(extractRequirements("Make the widget nicer and tidy up the styles."), []);
});

test("caps at eight items and deduplicates", () => {
  const spam = Array.from({ length: 20 }, (_, i) => `Input must reject value ${i} as invalid.`).join(" ");
  const found = extractRequirements(spam + " " + spam);
  assert.ok(found.length <= 8, `capped (got ${found.length})`);
  assert.equal(new Set(found).size, found.length, "deduplicated");
});

test("captures the five polyglot failing clauses from their real task texts", () => {
  const clauses = [
    ["Encode and decode numbers to and from a series of bytes using variable length quantity, treating each as a maximum 32-bit unsigned integer.", /32-bit/],
    ["Clean up user-entered phone numbers. If the phone number contains more than 11 digits it is invalid.", /more than 11 digits/],
    ["Determine the game state. An invalid board arises when \"X won and O kept playing\" or moves were made after the game ended.", /X won and O kept playing/],
    ["Parse and evaluate simple math word problems. The parser must reject non math questions with an error.", /non math questions/],
    ["Implement basic list operations. append must not mutate either input list; fold errors must propagate.", /must not mutate/],
  ];
  for (const [task, re] of clauses) {
    const found = extractRequirements(task).join(" | ");
    assert.match(found, re, `clause missing for: ${task.slice(0, 40)}`);
  }
});
