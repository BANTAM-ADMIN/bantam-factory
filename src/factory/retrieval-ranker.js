import { performance } from "node:perf_hooks";
import { rackOptions } from "./system-one.js";

export const TOOL_RETRIEVAL_RULE = Object.freeze({
  shortlistSize: 8, orders: 2, weight: 0.25, minLabelMass: 0.5, maxComparisonTokens: 14000,
});

const SYSTEM = "Compare the supplied tool candidates against the user request. Prefer the tool whose documented capabilities directly satisfy the request, including its constraints and required outputs. Similar topic words alone are insufficient. Reply with the bracketed handle of the most relevant candidate.";

/** Opt-in tool ranking. Scores are ranking utilities, not calibrated probabilities. */
export async function rerankToolCandidates({ reader, pool, state, questions, baseScores, seed = 0 }) {
  const start = performance.now();
  const ids = Object.keys(questions ?? {});
  if (!ids.length || ids.length !== Object.keys(baseScores ?? {}).length
      || ids.some(id => !Object.hasOwn(baseScores, id) || !Number.isFinite(baseScores[id]) || baseScores[id] < 0 || baseScores[id] > 1)) {
    throw new TypeError("baseScores must contain one finite score in [0, 1] for every candidate");
  }
  if (ids.some(id => typeof questions[id]?.instructions?.candidate !== "string" || !questions[id].instructions.candidate.trim())) {
    throw new TypeError("every candidate needs its full text in instructions.candidate");
  }
  const fields = [...ids].sort((a, b) => baseScores[b] - baseScores[a] || a.localeCompare(b)).slice(0, TOOL_RETRIEVAL_RULE.shortlistSize);
  const reads = [];
  let inputTokens = 0;
  const finish = (scores, fallback = null, comparisonScores = null) => ({
    method: "fast-shortlist-comparison-v1", scoreMeaning: "ranking_utility",
    baseScores: { ...baseScores }, comparisonScores, scores, ranking: [...ids].sort((a, b) => scores[b] - scores[a] || a.localeCompare(b)).map(id => ({ id, score: scores[id] })),
    shortlist: fields, reads, fallback, usage: { inputTokens }, elapsedMs: performance.now() - start,
  });
  const fallback = reason => finish({ ...baseScores }, reason);
  if (fields.length < 2) return fallback("only one candidate");
  const candidates = fields.map(id => questions[id].instructions.candidate);
  const joint = Object.fromEntries(fields.map(id => [id, 0]));
  for (let order = 0; order < TOOL_RETRIEVAL_RULE.orders; order++) {
    const rack = rackOptions(pool, candidates, { seed: seed + 101 + order * 7919 });
    const compiled = await reader.compileLabels({ lead: "q1: [", tail: "]", labels: rack.labels });
    const user = `USER REQUEST:\n${JSON.stringify(state)}\n\nCANDIDATE TOOLS:\n${rack.material}\n\nWhich candidate best satisfies the user request? q1: [HANDLE]`;
    if ((await reader.tokenize(user)).length > TOOL_RETRIEVAL_RULE.maxComparisonTokens) return fallback("shortlist exceeds context");
    const read = await reader.read({ system: SYSTEM, user, compiled, seed: seed + 101 + order });
    inputTokens += read.promptTokens ?? 0;
    reads.push({ labelMass: read.labelMass, missingLabels: read.missingLabels ?? [], promptTokens: read.promptTokens ?? 0 });
    if (!Number.isFinite(read.labelMass) || read.labelMass < TOOL_RETRIEVAL_RULE.minLabelMass || read.missingLabels?.length) {
      return fallback("comparison has insufficient label coverage");
    }
    const probabilities = rack.rows.map(row => read.probabilities[row.handle]);
    if (probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-6) {
      return fallback("comparison has invalid probabilities");
    }
    rack.rows.forEach((row, index) => { joint[fields[row.optionIndex]] += probabilities[index] / TOOL_RETRIEVAL_RULE.orders; });
  }
  const peak = Math.max(...Object.values(joint));
  const scores = Object.fromEntries(ids.map(id => [id,
    (1 - TOOL_RETRIEVAL_RULE.weight) * baseScores[id] + TOOL_RETRIEVAL_RULE.weight * (joint[id] ?? 0) / peak,
  ]));
  return finish(scores, null, joint);
}
