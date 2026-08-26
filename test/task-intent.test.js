import assert from "node:assert/strict";
import test from "node:test";

import { ALL_ACTION_VERBS } from "../src/action-protocol.js";
import { actionJsonSchema } from "../src/grammar.js";
import {
  ADVISORY_EXCLUDED_ACTIONS,
  classifyTaskIntent,
} from "../src/task-intent.js";

test("classifies the reported trio suggestion prompt as advisory", () => {
  assert.equal(classifyTaskIntent(
    "Take a look at our BANTAMBUILD bantam directory here, this is your code for this agent. Give me your suggestions for the highest-value thing we could add at this point.",
  ), "advisory");
});

test("mutation requests override incidental advisory language", () => {
  assert.equal(classifyTaskIntent("Take a look at the code and then fix the parser."), "implementation");
  assert.equal(classifyTaskIntent("Inspect the code, then implement the fix."), "implementation");
  assert.equal(classifyTaskIntent("Could you implement the highest-value suggestion?"), "implementation");
  assert.equal(classifyTaskIntent("Do not overwrite my changes."), "implementation");
  assert.equal(classifyTaskIntent(
    "Read brief.md, create index.html as requested, render/inspect if useful, and run node check.mjs before finishing.",
  ), "implementation");
});

test("inspection and risk-identification requests are advisory", () => {
  assert.equal(classifyTaskIntent(
    "Inspect the new Team-mode implementation and identify the single highest-risk integration issue, with concrete evidence. Do not change files.",
  ), "advisory");
  assert.equal(classifyTaskIntent("Audit the transport for lifecycle risks."), "advisory");
});

test("ambiguous terse tasks remain implementation mode", () => {
  assert.equal(classifyTaskIntent("repair it"), "implementation");
  assert.equal(classifyTaskIntent("parser.js"), "implementation");
});

test("advisory exclusions are valid against the base live action schema", () => {
  const baseVerbs = [
    "read_file", "list_dir", "search", "inspect", "replace", "write_file",
    "shell", "done", "respond", "query",
  ];
  const schema = actionJsonSchema({
    excludeVerbs: ADVISORY_EXCLUDED_ACTIONS.filter((verb) => baseVerbs.includes(verb)),
  });
  assert.deepEqual(schema.properties.a.enum.sort(), [
    "inspect",
    "list_dir",
    "query",
    "read_file",
    "respond",
    "search",
  ]);
  for (const verb of ["edit_lines", "patch", "delete_file", "move_file"]) {
    assert.ok(ADVISORY_EXCLUDED_ACTIONS.includes(verb));
  }
  assert.deepEqual(
    [...ADVISORY_EXCLUDED_ACTIONS].sort(),
    ALL_ACTION_VERBS
      .filter((verb) => !["read_file", "list_dir", "search", "inspect", "respond", "query"].includes(verb))
      .sort(),
  );
});
