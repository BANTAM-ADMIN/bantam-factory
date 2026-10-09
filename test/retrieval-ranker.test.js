import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rerankToolCandidates, TOOL_RETRIEVAL_RULE } from "../src/factory/retrieval-ranker.js";

const pool = Array.from({ length: 16 }, (_, i) => ({ handle: `H${String.fromCharCode(65 + i)}`, tokenId: i }));
const questions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`candidate${i}`, { instructions: { candidate: `Tool ${i} full description` } }]));
const baseScores = Object.fromEntries(Object.keys(questions).map((id, i) => [id, 0.9 - i * 0.05]));
function fixture({ labelMass = 1, missingLabels = [], tokens = 20, corrupt = false } = {}) {
  const seen = [];
  const reader = {
    compileLabels: async ({ labels }) => ({ labels }),
    tokenize: async () => Array(tokens).fill(1),
    read: async ({ user, compiled, seed }) => {
      seen.push({ user, seed });
      const favorite = compiled.labels.find(label => user.includes(`[${label}] Tool 2 full description`));
      const probabilities = Object.fromEntries(compiled.labels.map(label => [label, label === favorite ? 0.93 : 0.01]));
      if (corrupt) probabilities[favorite] = NaN;
      return { probabilities, labelMass, missingLabels, promptTokens: 25 };
    },
  };
  return { reader, seen };
}

describe("tool retrieval shortlist comparison", () => {
  it("maps shuffled handles back to candidate IDs and keeps every candidate", async () => {
    const { reader, seen } = fixture();
    const result = await rerankToolCandidates({ reader, pool, state: { query: "Tool 2" }, questions, baseScores, seed: 23 });
    assert.equal(result.ranking[0].id, "candidate2");
    assert.deepEqual(Object.keys(result.scores), Object.keys(baseScores));
    assert.equal(result.scores.candidate9, 0.75 * baseScores.candidate9, "tail candidates remain in the ranking");
    assert.equal(result.fallback, null);
    assert.deepEqual(result.baseScores, baseScores);
    const peak = Math.max(...Object.values(result.comparisonScores));
    for (const id of Object.keys(baseScores)) {
      assert.equal(result.scores[id], 0.75 * baseScores[id] + 0.25 * (result.comparisonScores[id] ?? 0) / peak);
    }
    assert.equal(result.scoreMeaning, "ranking_utility");
    assert.equal(result.usage.inputTokens, 50);
    assert.deepEqual(seen.map(r => r.seed), [124, 125]);
    assert.notEqual(seen[0].user, seen[1].user, "two different candidate orders");
    const again = await rerankToolCandidates({ reader: fixture().reader, pool, state: { query: "Tool 2" }, questions, baseScores, seed: 23 });
    assert.deepEqual(again.scores, result.scores);
    assert.equal(baseScores.candidate2, 0.8, "input scores are not mutated");
  });

  it("keeps the original scores when a comparison cannot support its labels", async () => {
    for (const options of [{ labelMass: 0.2 }, { missingLabels: ["HA"] }, { corrupt: true }, { tokens: TOOL_RETRIEVAL_RULE.maxComparisonTokens + 1 }]) {
      const { reader } = fixture(options);
      const result = await rerankToolCandidates({ reader, pool, state: "query", questions, baseScores });
      assert.deepEqual(result.scores, baseScores);
      assert.ok(result.fallback);
      assert.equal(result.comparisonScores, null);
    }
  });

  it("discards a good first comparison if the second has insufficient coverage", async () => {
    const { reader } = fixture();
    const read = reader.read;
    let count = 0;
    reader.read = async args => ({ ...await read(args), labelMass: ++count === 1 ? 1 : 0.1 });
    const result = await rerankToolCandidates({ reader, pool, state: "query", questions, baseScores });
    assert.deepEqual(result.scores, baseScores);
    assert.equal(result.reads.length, 2);
  });

  it("rejects missing or invalid base scores and empty candidate text", async () => {
    for (const scores of [{}, { ...baseScores, candidate0: Infinity }, { ...baseScores, candidate0: -1 }]) {
      await assert.rejects(rerankToolCandidates({ reader: fixture().reader, pool, state: "query", questions, baseScores: scores }), /baseScores/);
    }
    await assert.rejects(rerankToolCandidates({ reader: fixture().reader, pool, state: "query", questions: { ...questions, candidate0: { instructions: { candidate: "" } } }, baseScores }), /full text/);
  });

  it("returns one candidate without comparing or inferring its relevance", async () => {
    const result = await rerankToolCandidates({ reader: {}, pool: [], state: "query", questions: { only: { instructions: { candidate: "tool" } } }, baseScores: { only: 0.2 } });
    assert.equal(result.scores.only, 0.2);
    assert.equal(result.fallback, "only one candidate");
  });
});
