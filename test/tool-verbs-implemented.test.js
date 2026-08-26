import assert from "node:assert/strict";
import test from "node:test";

import { codeTool } from "../src/logic/tools.js";

// The `symbols` answer advertised `flow <file>` for entrypoints; `flow` was
// never implemented, so a model following the harness's own hint got
// `unknown query "flow"` (measured 2026-08-15 — that run read a 4,718-line CLI
// 54 times hunting what one query would have answered). The D14 ratchet catches
// unwired MODULES; nothing caught an unwired VERB. This is that ratchet.

const EMPTY_GROUND = {
  workspace: process.cwd(),
  stats: { files: 1 },
  staleFiles: new Set(),
  db: { has: () => false, query: () => [] },
};

test("every verb the code tool advertises is implemented", () => {
  const tool = codeTool(EMPTY_GROUND);
  const unimplemented = [];
  for (const verb of tool.verbs) {
    const answer = String(tool.answer(`${verb} probe-argument`));
    if (/^unknown query/i.test(answer)) unimplemented.push(verb);
  }
  assert.deepEqual(unimplemented, [], `advertised but unimplemented: ${unimplemented.join(", ")}`);
});

test("every verb named in the description is in the verb list", () => {
  const tool = codeTool(EMPTY_GROUND);
  const named = [...String(tool.description).matchAll(/`([a-z]+)(?: <|`)/g)].map((m) => m[1]);
  const missing = [...new Set(named)].filter((verb) => !tool.verbs.includes(verb));
  assert.deepEqual(missing, [], `described but not in verbs: ${missing.join(", ")}`);
});

test("a verb suggested inside an answer is implemented", () => {
  // The specific shape that broke: an answer telling the model to run another query.
  const tool = codeTool({ ...EMPTY_GROUND, db: { has: () => true, query: (r, a) => (r === "defines" ? [["f.js", "x"]] : []) } });
  const answer = String(tool.answer("symbols f.js"));
  for (const m of answer.matchAll(/ask `([a-z]+) /g)) {
    assert.ok(tool.verbs.includes(m[1]), `answer suggests \`${m[1]}\` which is not an implemented verb`);
  }
});
