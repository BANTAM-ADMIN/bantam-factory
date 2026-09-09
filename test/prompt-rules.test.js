import assert from "node:assert/strict";
import test from "node:test";
import { activeCandidateRules, composeRulesBlock, promptVersion, BASE_RULES, CANDIDATE_RULES } from "../src/prompt-rules.js";

test('compact wording keeps each obligation and explicitly selected candidate attributable', () => {
  const baseline = { BANTAM_RULES: 'fable.visual-composition' };
  const compact = { ...baseline, BANTAM_COMPACT_RULES: '1' };
  const full = composeRulesBlock(baseline), short = composeRulesBlock(compact);
  assert.equal(short.split('\n').length, full.split('\n').length);
  assert.ok(short.length < full.length * 0.6);
  assert.match(short, /passing checks after the latest edit/);
  assert.match(short, /exit code, stdout and stderr/);
  assert.match(short, /Report only observed success/);
  assert.ok(short.includes(CANDIDATE_RULES.find(r => r.id === 'fable.visual-composition').text));
  assert.notEqual(promptVersion(baseline), promptVersion(compact));
  assert.equal(promptVersion(baseline), promptVersion({ ...compact, BANTAM_COMPACT_RULES: '0' }));
  assert.doesNotMatch(composeRulesBlock({ ...compact, BANTAM_RULES_OFF: 'fable.report-shape' }), /Finish with the observed outcome/);
});

test("visual composition rule is opt-in and changes the measured prompt version", () => {
  const baseline = { BANTAM_RULES: "", BANTAM_RULES_OFF: "" };
  const treatment = { BANTAM_RULES: "fable.visual-composition", BANTAM_RULES_OFF: "" };

  assert.ok(!activeCandidateRules(baseline).some((rule) => rule.id === "fable.visual-composition"));
  assert.ok(activeCandidateRules(treatment).some((rule) => rule.id === "fable.visual-composition"));
  assert.match(composeRulesBlock(treatment), /visual composition as a requirement/i);
  assert.notEqual(promptVersion(baseline), promptVersion(treatment));
});

test("verification guidance uses measured status and executable expected-error assertions", () => {
  const rule = BASE_RULES.find(r => r.id === "behavior-is-more-than-stdout").text;
  assert.match(rule, /shell receipt already records exit code, stdout and stderr/);
  assert.match(rule, /test that asserts the child process's exit code, stdout and stderr/);
  assert.match(rule, /test's own exit reports whether those assertions passed/);
  for (const {text} of [...BASE_RULES, ...CANDIDATE_RULES]) {
    assert.doesNotMatch(text, /cmd;\s*echo\s+["']?exit=\$\?/);
  }
});
