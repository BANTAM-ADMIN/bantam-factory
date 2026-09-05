import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseFailingTest, formatFailingTestFocus } from "../src/logic/test-focus.js";
import { askTeacher, buildTeacherPrompt } from "../src/teacher-assist.js";

const failureOutput = `not ok 1 - preserves a numeric-looking string
  ---
  location: '/workspace/test/csv.test.js:1:1'
  + '01'
  - 1
  ...
1..1
# pass 0
# fail 1`;
const testSource = 'test("preserves a numeric-looking string", () => { assert.equal(parse("01"), 1); });';
const task = "Parse CSV fields as strings, preserving leading zeroes.";
const specimen = {
  testName: "preserves a numeric-looking string", testSource,
  implSource: 'src/csv.js: export function parse(field) { return field; }',
  diff: "expected 1; got '01'", task,
};

test("unknown and generated test failures are labeled without declaring their expectations correct", () => {
  const unknown = formatFailingTestFocus(failureOutput, () => testSource);
  assert.match(unknown, /Test provenance: unknown/);
  assert.match(unknown, /test is evidence, not a guaranteed oracle/);
  assert.doesNotMatch(unknown, /Your implementation produced the wrong value|test that must pass|test is correct/);
  let record;
  const generated = formatFailingTestFocus(failureOutput, () => testSource, {
    testProvenance: (failure) => { record = failure; return "generated"; },
  });
  assert.equal(record.file, "/workspace/test/csv.test.js");
  assert.equal(record.line, 1);
  assert.match(generated, /Test provenance: generated/);
  assert.match(generated, /specific task-supported defect/);
});

test("protected tests preserve their authority and failed classifiers remain unknown", () => {
  const protectedFocus = formatFailingTestFocus(failureOutput, () => testSource, { testProvenance: () => "protected" });
  assert.match(protectedFocus, /protected invariant: keep the test unchanged/);
  assert.match(protectedFocus, /report the conflict instead of weakening the test/);
  const unknown = formatFailingTestFocus(failureOutput, () => testSource, { testProvenance: () => { throw new Error("unavailable"); } });
  assert.match(unknown, /Test provenance: unknown/);
});

test("diagnosis receives the task and test provenance while retaining FIX/CAUSE/TRACE", async () => {
  const answer = "FIX: test/csv.test.js assertion: expect the string '01' to preserve leading zeroes.\nCAUSE: The assertion coerces a string despite the task requiring preservation.\nTRACE: parse('01') -> returns '01' -> assertion expects numeric 1";
  for (const testProvenance of ["unknown", "baseline", "generated", "self-authored", "added-or-modified", "protected"]) {
    let prompt;
    const model = { complete: async (text) => { prompt = text; return { content: answer }; } };
    const diagnosis = await diagnoseFailingTest({ ...specimen, testProvenance, model, buildRawPrompt: (text) => text });
    assert.equal(diagnosis, answer);
    assert.ok(prompt.includes(task));
    assert.ok(prompt.includes(`Test provenance: ${testProvenance}`));
    assert.match(prompt, /FIX:.*\nCAUSE:.*\nTRACE:/);
    assert.doesNotMatch(prompt, /the test is correct and must pass unchanged|Do not propose changing the test/);
    if (testProvenance === "protected") assert.match(prompt, /keep the test unchanged/);
    else assert.match(prompt, /specific task-supported defect/);
    if (testProvenance === "self-authored") assert.match(prompt, /This test was added during this run; preserving supplied tests does not prohibit task-justified correction of it/);
  }
});

test("teacher and fallback receive the same task-grounded test authority", async () => {
  const protectedPrompt = buildTeacherPrompt({ ...specimen, testProvenance: "protected" });
  assert.match(protectedPrompt, /protected invariant: keep the test unchanged/);
  const prompts = [];
  const cause = await askTeacher({
    ...specimen, testProvenance: "generated",
    invoke: async (prompt) => { prompts.push(prompt); return null; },
    fallback: async (prompt) => { prompts.push(prompt); return "The generated assertion expects a number, contradicting the task requirement to preserve the original string."; },
  });
  assert.match(cause, /generated assertion/);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.ok(prompts[0].includes(task));
  assert.match(prompts[0], /Test provenance: generated/);
  assert.match(prompts[0], /if a cause is not established, identify the missing evidence/);
});
