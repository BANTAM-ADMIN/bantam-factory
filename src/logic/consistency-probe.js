// consistency-probe.js — knowledge-stability probe (2026-08-18 logit study).
//
// Single-pass token confidence is fluency, not knowledge: the fine-tune's
// known-false GGUF prior decoded at mean 0.994 — HIGHER than a correct
// answer — and the only entropy anywhere was the sentence opener. What
// separates knowledge from confabulation is stability under resampling:
// k redecodes at sampling temperature agree 6/6 on true particulars and
// shatter (5 distinct values in 6 samples) on guessed ones.
//
// The probe is the middle rung of the escalation ladder:
//   claim-class match (free) -> stability probe (seconds, local, no quota)
//   -> :research (paid frontier errand, governed).
import { factAtoms } from "./claim-diff.js";

export const PROBE_DEFAULTS = { k: 5, temperature: 0.8, topP: 0.95, nPredict: 120 };

/** k short redecodes of one question at sampling temperature, distinct seeds. */
export async function sampleAnswers({
  endpoint,
  question,
  k = PROBE_DEFAULTS.k,
  temperature = PROBE_DEFAULTS.temperature,
  fetchImpl = fetch,
} = {}) {
  const prompt = `<|im_start|>user\n${question}\nState the answer as a direct declarative sentence.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  const out = [];
  for (let i = 0; i < k; i++) {
    const res = await fetchImpl(`${endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, n_predict: PROBE_DEFAULTS.nPredict, temperature,
        top_p: PROBE_DEFAULTS.topP, seed: 1000 + i, cache_prompt: i > 0,
      }),
    });
    const d = await res.json();
    if (typeof d?.content === "string" && d.content.trim()) out.push(d.content.trim());
  }
  return out;
}

/**
 * Group each sample's fact atoms by (cls, anchor); an atom the model KNOWS
 * holds one value across samples, a guess scatters. Atoms absent from most
 * samples stay unjudged — absence is phrasing, not instability.
 */
export function stabilityReport(samples) {
  const groups = new Map();
  for (const s of samples) {
    const seen = new Set(); // one vote per sample per (cls, anchor)
    for (const a of factAtoms(s)) {
      const key = `${a.cls}\u001f${a.anchor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a.value);
    }
  }
  const atoms = [];
  for (const [key, values] of groups) {
    const [cls, anchor] = key.split("\u001f");
    if (values.length < Math.ceil(samples.length / 2)) continue;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [topValue, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const agreement = topCount / values.length;
    const verdict = counts.size >= 3 || agreement < 0.5 ? "SCATTERED"
      : agreement >= 0.8 ? "STABLE" : "MIXED";
    atoms.push({ cls, anchor, verdict, agreement, topValue, votes: values.length, values: [...counts.keys()] });
  }
  return {
    k: samples.length,
    atoms,
    scattered: atoms.filter((a) => a.verdict === "SCATTERED"),
    recommendResearch: atoms.some((a) => a.verdict !== "STABLE"),
  };
}

export function renderStabilityReport(r) {
  if (!r.k) return "🎲 stability probe: no samples came back — check the model endpoint.";
  if (!r.atoms.length) return `🎲 stability probe (k=${r.k}): no comparable fact atoms across samples — probe is inconclusive for this answer.`;
  const lines = r.atoms.map((a) => {
    const spread = a.verdict === "STABLE" ? `"${a.topValue}"` : `{${a.values.join(", ")}}`;
    return `  ${a.cls}·${a.anchor}: ${a.verdict} ${Math.round(a.agreement * a.votes)}/${a.votes} ${spread}`;
  });
  const tail = r.scattered.length
    ? `  ⚠ scattered atoms are GUESSES wearing fluent prose — single-pass confidence measured 0.99 on known-wrong answers. \`:research\` verifies against sources.`
    : r.recommendResearch ? `  mixed agreement — worth a source check before load-bearing use.` : `  stable under resampling.`;
  return [`🎲 stability probe (k=${r.k}):`, ...lines, tail].join("\n");
}
