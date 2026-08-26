import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrompt } from "../src/prompt.js";

// Measured on a recorded gpt-5.6-terra run (adapter-migration, 10 turns):
// consecutive prompts shared only 75-86% of their prefix, and one turn shared
// just 33%. The cause is not new content -- it is BANTAM REWRITING ITS OWN
// HISTORY. When an edit supersedes an earlier read, every prior observation of
// that path is replaced in place with a pointer, which invalidates the provider
// prefix cache from that point to the end of the prompt.
//
// 63,082 characters of already-cached prefix were discarded that way in a single
// run -- about 15,771 tokens, roughly 29% of all cache misses. The rewrite saves
// a few hundred characters of prompt length and pays for it with thousands of
// full-price tokens.
//
// The existing behaviour is deliberate and correct FOR SMALL MODELS: prompt.js
// notes that a stale dump beside a clipped live panel "gives a small model two
// competing source truths". A frontier model handed an explicit staleness note
// does not have that problem, so the trade flips.

const TASK = "Implement the thing.";
const ENV = "node 20";
const FILE_BODY = "1\texport function alpha() {\n2\t  return 1;\n3\t}\n";

function turnsWithSupersededRead() {
  return [
    { i: 0, action: { a: "read_file", p: "src/a.js" }, observation: FILE_BODY },
    {
      i: 1,
      action: { a: "write_file", p: "src/a.js", content: "export function alpha() { return 2; }" },
      observation: "wrote src/a.js",
      editApplied: true,
    },
  ];
}

const build = (overrides = {}) => buildPrompt({
  task: TASK,
  env: ENV,
  turns: turnsWithSupersededRead(),
  openPaths: ["src/a.js"],
  readPaths: ["src/a.js"],
  openFilesText: "# src/a.js (current)\n1\texport function alpha() { return 2; }\n",
  ...overrides,
});

describe("immutable history preserves the provider prefix cache", () => {
  // Documents the existing behaviour, so the change below is a deliberate flip
  // rather than an accident.
  it("by default rewrites a superseded read in place", () => {
    const prompt = build();
    assert.ok(
      !prompt.includes(FILE_BODY),
      "default behaviour replaces the superseded snapshot body",
    );
    // One wording covers both the merely-redundant and the edited-and-stale case;
    // having two meant every edit rewrote the earlier pointers. See
    // test/prompt-sticky-slim.test.js.
    assert.match(prompt, /earlier snapshot omitted; read_file for current contents/);
  });

  it("keeps the original observation bytes when immutableHistory is on", () => {
    const prompt = build({ immutableHistory: true });
    assert.ok(
      prompt.includes(FILE_BODY),
      "the observation emitted at turn 1 must still be present verbatim",
    );
  });

  // The correctness half. Dropping the rewrite must not drop the WARNING, or the
  // model is left with a stale snapshot and no signal that it is stale.
  it("still tells the model which snapshots are stale", () => {
    const prompt = build({ immutableHistory: true });
    assert.match(prompt, /stale/i, "a staleness notice must survive");
    assert.match(prompt, /src\/a\.js/, "the notice must name the superseded path");
  });

  // The whole point: the notice goes AFTER history so the prefix stays stable.
  it("places the staleness notice after the history it refers to", () => {
    const prompt = build({ immutableHistory: true });
    const bodyAt = prompt.indexOf(FILE_BODY);
    const noticeAt = prompt.search(/stale/i);
    assert.ok(bodyAt >= 0 && noticeAt > bodyAt,
      "the notice must follow the observation, never replace it");
  });

  // The property that actually saves tokens, asserted directly: adding a turn
  // must only APPEND. Everything the model already paid for stays byte-identical.
  it("extends the previous prompt as a pure prefix when a turn is added", () => {
    const base = turnsWithSupersededRead();
    const common = {
      task: TASK,
      env: ENV,
      openPaths: ["src/a.js"],
      readPaths: ["src/a.js"],
      openFilesText: "",
      immutableHistory: true,
    };
    const before = buildPrompt({ ...common, turns: base.slice(0, 1) });
    const after = buildPrompt({ ...common, turns: base });

    // The open assistant prefill closes the previous prompt; compare the stable
    // portion up to where the next turn is appended.
    const historyEnd = before.lastIndexOf("<|im_start|>assistant");
    assert.ok(historyEnd > 0, "expected an assistant prefill in the built prompt");
    const stable = before.slice(0, historyEnd);
    assert.ok(after.startsWith(stable),
      "adding a turn rewrote earlier prompt bytes instead of appending to them");
  });
});

// The dominant invalidator, found only after the first fix measured WORSE.
// Observations were made immutable while replayed EDIT ACTIONS were still being
// slimmed to `[superseded — current file shown in <open_files>]`. That kept the
// large bodies (paying the size cost) while still rewriting the prefix (keeping
// the cache cost) -- strictly worse than either choice alone. Measured: input
// 297k -> 354k and misses 53.9k -> 72.2k on the same fixture and model.
describe("replayed edit actions are history too", () => {
  const editTurns = [
    {
      i: 0,
      action: { a: "write_file", p: "src/a.js", content: "export const alpha = 1;\n" },
      observation: "wrote src/a.js",
      editApplied: true,
    },
    { i: 1, action: { a: "read_file", p: "src/a.js" }, observation: "1\texport const alpha = 1;\n" },
  ];
  const common = {
    task: "t", env: "e", turns: editTurns,
    openPaths: ["src/a.js"], readPaths: ["src/a.js"], openFilesText: "# src/a.js\n",
  };

  it("by default slims a replayed edit body to a pointer", () => {
    const prompt = buildPrompt(common);
    assert.match(prompt, /superseded — current file shown/);
    assert.ok(!prompt.includes("export const alpha = 1;\\n\"}"),
      "default behaviour removes the replayed edit body");
  });

  it("replays the edit verbatim under immutableHistory", () => {
    const prompt = buildPrompt({ ...common, immutableHistory: true });
    assert.ok(!/superseded — current file shown/.test(prompt),
      "no placeholder may be written into replayed actions");
    assert.match(prompt, /export const alpha = 1;/,
      "the original edit body must survive in history");
  });
});
