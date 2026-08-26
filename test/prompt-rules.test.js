import assert from "node:assert/strict";
import test from "node:test";
import { activeCandidateRules, composeRulesBlock, promptVersion } from "../src/prompt-rules.js";

test("visual composition rule is opt-in and changes the measured prompt version", () => {
  const baseline = { BANTAM_RULES: "", BANTAM_RULES_OFF: "" };
  const treatment = { BANTAM_RULES: "fable.visual-composition", BANTAM_RULES_OFF: "" };

  assert.ok(!activeCandidateRules(baseline).some((rule) => rule.id === "fable.visual-composition"));
  assert.ok(activeCandidateRules(treatment).some((rule) => rule.id === "fable.visual-composition"));
  assert.match(composeRulesBlock(treatment), /visual composition as a requirement/i);
  assert.notEqual(promptVersion(baseline), promptVersion(treatment));
});
