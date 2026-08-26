// Card 20 (ledgerd, 2026-08-25): sol's lane opened with a respond claiming
// "I can't inspect or modify the workspace in this session" and closed one
// turn later with done("Blocked: ...") on an untouched tree — THROUGH the
// empty_done gate, because BUILD_TASK_RE requires build/implement/fix/... and
// the task said "Make npm test pass by finishing two pieces of surgery".
// Two seats: the classifier must read make-pass/finishing as build work, and
// the implementation-response steer must rebut the no-access belief by name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDoneObjection } from "../src/done-guard.js";
import { implementationResponseObservation } from "../src/agent.js";

const TASK20 = "ledgerd is a small five-module ledger (store, validate, fmt, api, index) whose test suite currently fails. Make npm test pass by finishing two pieces of surgery, changing whichever modules the work genuinely requires:";

test("'make npm test pass by finishing...' is a build task", () => {
  const objection = emptyDoneObjection([], 0, { task: TASK20 });
  assert.ok(objection, "an untouched tree must draw the empty_done objection");
  assert.match(objection, /not written a single byte/);
});

test("a genuinely read-only ask still ends quietly with no edits", () => {
  assert.equal(emptyDoneObjection([], 0, { task: "Summarize the architecture of this repository and name its main modules." }), null);
});

test("a no-access respond gets the belief rebutted, not just instructions", () => {
  const obs = implementationResponseObservation("I can’t inspect or modify the workspace in this session. Please provide the five source modules.");
  assert.match(obs, /^\[implementation-response\]/);
  assert.match(obs, /You DO have workspace access/);
  assert.match(obs, /inspect, write_file, replace, shell/);
});

test("a plain plan-shaped respond keeps the base steer only", () => {
  const obs = implementationResponseObservation("I'll implement the exec mode. Let me first understand the dispatcher.");
  assert.match(obs, /^\[implementation-response\]/);
  assert.doesNotMatch(obs, /You DO have workspace access/);
});
