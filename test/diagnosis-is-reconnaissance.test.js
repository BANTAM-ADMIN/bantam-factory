// The TILDE iOS replay localized a real bug to exact line ranges — then the
// 14-recon-streak wrap-up masked it at turn 15 of a 60-turn budget, and its
// forced respond asked permission to keep reading. The streak guard exists
// for answer-shaped asks that spiral; a bug report is an implicit fix request
// and diagnosis IS reconnaissance. Change-shaped requests get double the
// allowance; the budget stays the ceiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isChangeShapedRequest } from "../src/agent.js";

test("bug reports read as change-shaped even with no imperative verb", () => {
  for (const ask of [
    "When I try to delete a book while on IOS on my phone in tildebooks, I click the delete button for the book and don't see a confirmation popup and can't delete the book",
    "every time I export, the theme CSS fails to apply",
    "the sliders stopped working after the last change",
    "Fix the paragraph indent on the first line",
    "please add a divide function to calc.js",
  ]) {
    assert.equal(isChangeShapedRequest(ask), true, ask.slice(0, 60));
  }
});

test("answer-shaped asks keep the ordinary allowance", () => {
  for (const ask of [
    "take a look at this codebase and tell me what you think of the architecture",
    "how does the export pipeline decide which CSS to bundle?",
    "what are the agentic loops and prompting strategies here?",
  ]) {
    assert.equal(isChangeShapedRequest(ask), false, ask.slice(0, 60));
  }
});

test("only the CURRENT request votes — threaded history cannot flip the shape", () => {
  const threaded = "Recent asks:\n- fix the delete button\nNew request: how does the dialog get mounted?";
  assert.equal(isChangeShapedRequest(threaded), false);
  const threadedFix = "Recent asks:\n- how does mounting work?\nNew request: fix the delete confirmation on iOS";
  assert.equal(isChangeShapedRequest(threadedFix), true);
});
