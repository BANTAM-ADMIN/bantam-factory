import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt } from "../src/prompt.js";
import { budgetTurns, compactHistory } from "../src/history-budget.js";

const observation = JSON.stringify({
  evidence_id: "ev_delivery",
  padding: "x".repeat(30000),
  rows: [{ properties: { channel: "notes:export" } }],
  provenance: "y".repeat(30000),
  coverage: { exhausted: true },
});
const evidenceTurn = {
  i: 0,
  action: { a: "rea_tool", tool: "inspect_analysis_view", args: "{}" },
  observation,
};

test("REA evidence reaches initial and frozen model prompts as complete JSON", () => {
  assert.equal(compactHistory([evidenceTurn])[0].observation, observation);
  for (const extensionTrajectory of [false, true]) {
    const renderCache = new Map();
    const options = { task: "Analyze evidence", env: "", extensionTrajectory, renderCache };
    const next = { i: 1, action: { a: "respond", text: "Finished" }, observation: "" };
    for (const turns of [[evidenceTurn], [evidenceTurn, next], [evidenceTurn, next]]) {
      const prompt = buildPrompt({ ...options, turns });
      assert.ok(prompt.includes(observation), "all rows, properties and provenance must reach the model");
    }
  }
});

test("discovered schemas reach prompts in full", () => {
 const turn={...evidenceTurn,action:{a:"rea_tools",name:"inspect_analysis_view"}};
 assert.equal(compactHistory([turn])[0].observation,observation);
 assert.ok(buildPrompt({task:"Discover",env:"",turns:[turn]}).includes(observation));
});

test("history charges full REA response size and evicts complete older turns", () => {
  const next = { i: 1, action: { a: "respond", text: "Finished" }, observation: "" };
  assert.deepEqual(budgetTurns([evidenceTurn, next], { charBudget: 5000 }).map(t => t.i), [1]);
  const newest = budgetTurns([evidenceTurn], { charBudget: 5000 });
  assert.equal(newest.length, 1);
  assert.equal(newest[0].observation, observation, "the newest response must survive whole");
});
