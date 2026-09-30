import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkToolCalls, decideJevAdaptive, formatToolCallNotes } from "../src/factory.js";

const state = {
  tools: [{
    name: "find_events",
    parameters: { type: "dict", required: ["city", "date"], properties: { city: { type: "string" }, date: { type: "string" }, kind: { type: "string" } } },
  }],
  question: "Find me a theater event in San Francisco on 1st October 2023.",
};
const call = (name, args) => JSON.stringify({ name, arguments: args });

describe("factory tool-call gauge", () => {
  it("rules out calls to missing tools and malformed calls; reports schema and grounding facts", () => {
    const check = checkToolCalls(state, {
      type: "choice",
      criteria: {
        A: call("find_events", { city: "San Francisco, CA", date: "2023-10-01" }),
        B: call("search_web", { query: "events" }),
        C: "{not json",
        D: call("find_events", { city: "Boston" }),
        E: call("find_events", { city: "San Francisco", date: "October 1", venue: "x" }),
        F: "I'm sorry, I can't do that.",
      },
    });
    assert.deepEqual([...check.ruledOut].sort(), ["B", "C"]);
    const notes = check.notes.join("\n");
    assert.match(notes, /the call find_events\(\{"city":"San Francisco, CA","date":"2023-10-01"\}\) is valid/, "a normalized value that still shares words is not flagged");
    assert.match(notes, /the call search_web\(.*\) uses search_web, which is not one of the available tools/);
    assert.match(notes, /the call find_events\(\{"city":"Boston"\}\) leaves out required date; uses city="Boston", sharing no words/);
    assert.match(notes, /passes venue, which find_events does not take/);
    assert.doesNotMatch(notes, /sorry/, "plain-text answers are left to the model");
    assert.match(formatToolCallNotes(["x"]), /^TOOL-CALL CHECK .*\n- x$/);
  });

  it("does not apply without tool definitions or call options", () => {
    assert.equal(checkToolCalls({ question: "hi" }, { type: "choice", criteria: { A: call("f", {}) } }), null);
    assert.equal(checkToolCalls(state, { type: "choice", criteria: { A: "yes", B: "no" } }), null);
  });

  it("adaptive: the reads see the findings and a ruled-out call cannot win", async () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
    const seen = [];
    // The model favours the call to the missing tool, before and after thinking.
    const favourB = (compiled, user) => {
      const favoured = compiled.labels.find(({ label }) => new RegExp(`\\[${label}\\] B:`).test(user)).label;
      return { probabilities: Object.fromEntries(compiled.labels.map(({ label }) => [label, label === favoured ? 0.97 : 0.01])), promptTokens: 1 };
    };
    const reader = {
      compileLabels: async ({ labels }) => ({ labels: labels.map((label, i) => ({ label, tokenId: i })) }),
      read: async ({ user, compiled }) => { seen.push(user); return favourB(compiled, user); },
      think: async ({ user }) => { seen.push(user); return { prefixIds: [user], thoughtTokens: 200, truncated: false, promptTokens: 1 }; },
      readAfter: async ({ prefixIds, compiled }) => favourB(compiled, prefixIds[0]),
    };
    const { answers, evidence } = await decideJevAdaptive({
      reader, pool, state, toolGauge: true,
      questions: { q: { type: "choice", criteria: { A: call("find_events", { city: "San Francisco", date: "2023-10-01" }), B: call("search_web", { query: "x" }), C: "Which city?" } } },
    });
    assert.notEqual(answers.q.choice, "B");
    assert.equal(answers.q.probabilities.B, 0);
    assert.ok(seen.every((user) => user.includes("TOOL-CALL CHECK")), "every read sees the findings");
    assert.deepEqual(evidence.q.find((step) => step.step === "toolcheck").ruledOut, ["B"]);
  });
});
