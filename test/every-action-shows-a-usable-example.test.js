import assert from "node:assert/strict";
import test from "node:test";

import { actionPromptMenu } from "../src/action-protocol.js";

// The action menu is the model's only statement of what it can do. `query` was
// the one entry whose example was a placeholder — {"a":"query","q":"..."} — with
// its verbs listed in a separate `code:` block, leaving the reader to connect
// the two. It is also the least-used action in the corpus by a wide margin: 34
// of 42 stored runs issued none at all, while 332 of 1,466 search ops were the
// third-or-later regex for the same identifier, which `defines`/`uses` answer
// outright.
//
// This does not prove the placeholder caused the disuse. It does mean the menu
// asked the model to infer a call shape it showed for every other verb.

// A placeholder is fine where the field is free-form — {"a":"write_file",...,
// "content":"..."} and {"a":"respond","text":"..."} have no meaningful short
// example, and the field name says everything. `q` on a query is not free-form:
// it takes one verb from a fixed vocabulary, and "..." hid which.

test("the query example names a real verb", () => {
  const menu = actionPromptMenu({ features: [] });
  const line = menu.split("\n").find((l) => /^- \{"a":"query"/.test(l));
  assert.ok(line, "the menu must offer query");
  const verb = /"q":"(\w+)/.exec(line)?.[1];
  assert.ok(["defines", "uses", "symbols", "deps", "affects", "tests", "flow", "files", "exists", "entrypoints", "broken", "concept", "map"].includes(verb),
    `the example's q must start with a real code-tool verb, got ${verb}`);
});
