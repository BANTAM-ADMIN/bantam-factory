// think-truncation.js — did the reasoning phase finish, or was it severed?
//
// A think call that returns EXACTLY its token budget did not conclude; it ran
// out of room mid-sentence. The action phase then acts on a fragment, and the
// cheapest action available from an incomplete plan is to rewrite the whole file
// again — which is why this shows up as thrash rather than as an error.
//
// MEASURED on write-compressor (2026-08-22, local qwen3, budget 4096):
//   9 of 19 think calls returned exactly 4096 tokens
//   every sampled one ended mid-sentence ("Initially all counts are 0. So")
//   SIX of the nine full rewrites of encode.py were the next action after one
//
// It was invisible: the artifact's stoppedLimit/stoppedEos flags were unset on
// every call, so nothing distinguished "thought it through" from "was cut off".
// Exact-budget output is the signal that survives when the flags do not.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function outputTokens(call) {
  return num(call?.response?.normalized?.usage?.outputTokens);
}

function isActionShaped(call) {
  const content = call?.response?.normalized?.content ?? "";
  const head = String(content).trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes('"a"');
}

/**
 * Find calls that spent their whole budget. `budget` defaults to the value
 * BANTAM_THINK_N_PREDICT defaults to; pass the run's real budget when known.
 */
export function analyzeThinkTruncation(artifact, { budget = 4096 } = {}) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  if (!calls.length) return null;

  const thinks = [];
  const severed = [];
  calls.forEach((call, index) => {
    if (isActionShaped(call)) return;
    const tokens = outputTokens(call);
    thinks.push(tokens);
    if (tokens >= budget) {
      const content = call?.response?.normalized?.content ?? "";
      const tail = String(content).trimEnd();
      severed.push({
        call: index,
        tokens,
        // A finished thought lands on terminal punctuation. Mid-sentence is the
        // tell that the budget, not the model, ended it.
        endsMidSentence: !/[.!?}"'\])]$/.test(tail.slice(-1)),
        tail: tail.slice(-120),
      });
    }
  });
  if (!thinks.length) return null;

  const thinkTokens = thinks.reduce((a, b) => a + b, 0);
  return {
    budget,
    thinkCalls: thinks.length,
    thinkTokens,
    severed,
    severedCount: severed.length,
    severedShare: thinks.length ? severed.length / thinks.length : 0,
    midSentence: severed.filter((s) => s.endsMidSentence).length,
  };
}

/** What the run did immediately after each severed thought. */
export function actionsAfterSevered(artifact, analysis) {
  const turns = Array.isArray(artifact?.turns) ? artifact.turns : [];
  if (!analysis?.severed?.length) return [];
  return analysis.severed.map((s) => {
    const turn = turns.find((t) => Number.isInteger(t?.modelCallIndex)
      && (t.modelCallIndex === s.call || t.modelCallIndex === s.call + 1));
    return { call: s.call, turn: turn?.i ?? null, action: turn?.parsedAction?.a ?? null, path: turn?.parsedAction?.p ?? null };
  });
}

/** Human report. Silent when every thought finished on its own. */
export function formatThinkTruncation(analysis, artifact) {
  if (!analysis || !analysis.severedCount) return [];
  const a = analysis;
  const out = [];
  out.push(
    `reasoning severed: ${a.severedCount} of ${a.thinkCalls} think calls spent their entire`
    + ` ${a.budget}-token budget (${Math.round(100 * a.severedShare)}%)`
    + `${a.midSentence ? ` — ${a.midSentence} ended mid-sentence` : ""}`,
  );
  const after = actionsAfterSevered(artifact, a);
  const rewrites = after.filter((x) => x.action === "write_file");
  if (rewrites.length) {
    out.push(
      `  the next action was a FULL REWRITE ${rewrites.length} time(s)`
      + ` — acting on a fragment licenses starting over:`
      + ` ${rewrites.slice(0, 6).map((r) => `t${r.turn} ${r.path ?? ""}`.trim()).join(", ")}`,
    );
  }
  out.push("  a bigger budget buys the same fragment later; the fix is telling the action phase it was cut.");
  return out;
}
