import test from "node:test";
import assert from "node:assert/strict";

import { systemPrompt } from "../src/prompt.js";
import { CANDIDATE_RULES } from "../src/prompt-rules.js";

test("the system head carries the template's own effort instruction when asked", () => {
  const p = systemPrompt({ reasoningEffort: "xhigh" });
  assert.match(p, /^Reasoning effort is set to xhigh\. Please think carefully/);
  assert.match(p, /validate key assumptions, consider plausible alternatives/);
  assert.match(systemPrompt({ reasoningEffort: "low" }), /^Reasoning effort is set to low/);
});

test("no effort -> no line; unknown effort -> no line (nothing invented)", () => {
  assert.match(systemPrompt({}), /^You are Bantam/);
  assert.match(systemPrompt({ reasoningEffort: "turbo" }), /^You are Bantam/);
});

test("invert-the-decoder is registered and says the two things that matter", () => {
  const r = CANDIDATE_RULES.find((x) => x.id === "invert-the-decoder");
  assert.ok(r, "rule must be registered so BANTAM_RULES can enable it");
  // the error it exists to prevent
  assert.match(r.text, /do NOT build the encoder by choosing the next output byte at each decode step/);
  // the method
  assert.match(r.text, /EXACT big integers/);
  assert.match(r.text, /only at the END pick any point inside the final interval/);
  // the two small traps that also sank the run
  assert.match(r.text, /%s.*end in a 0 byte/);
  assert.match(r.text, /smallest possible input \(one literal, one token\)/);
});
