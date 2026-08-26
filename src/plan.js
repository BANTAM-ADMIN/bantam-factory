// Workflows — plan first, then execute the plan.
//
// For a multi-step task, Bantam can author a short plan up front (a goal + ordered
// steps), then keep that plan pinned in context while it works, and mark steps
// done as it goes. This is the self-authored-workflow capability: the model
// structures its own approach instead of flailing turn-to-turn. The plan is
// grammar-constrained (self-contained GBNF here, no change to the action grammar)
// and advisory — the hidden verifier still has the final word.

// GBNF constraining the planning call to one well-formed plan object.
export const PLAN_GRAMMAR = String.raw`
root    ::= ws "{" ws "\"goal\"" ws ":" ws string ws "," ws "\"steps\"" ws ":" ws strarray ws "}" ws
strarray ::= "[" ws string ( ws "," ws string )* ws "]"
string  ::= "\"" schar* "\""
schar   ::= [^"\\\x7F\x00-\x1F] | "\\" escape
escape  ::= ["\\/bfnrt] | "u" hex hex hex hex
hex     ::= [0-9a-fA-F]
ws      ::= [ \t\n]*
`;

// Ask the model to author a plan for the task. Returns { goal, steps } or null.
export async function makePlan({ model, task, env, buildRawPrompt, nPredict = 1024, signal = null }) {
  const instruction = `You are about to work on this coding task in a local repo.

TASK: ${task}

WORKSPACE:
${env}

Author a SHORT plan: a one-line goal and 3-6 concrete ordered steps. Investigate
before editing; end with running the tests/verification before finishing. Keep each
step to one imperative line. Output one JSON object: {"goal": "...", "steps": ["...", ...]}.`;

  let out;
  try {
    out = await model.complete(buildRawPrompt(instruction), { grammar: PLAN_GRAMMAR, nPredict, signal });
  } catch { return null; }

  const obj = extractJson(out.content);
  if (!obj || !obj.goal || !Array.isArray(obj.steps) || !obj.steps.length) return null;
  return {
    goal: String(obj.goal).slice(0, 200),
    steps: obj.steps.slice(0, 8).map((s) => String(s).slice(0, 200)),
  };
}

// Signals that recent turns are failing — a cue to reflect and re-plan. The failed-count alternative
// requires a NON-ZERO count: `cargo test` prints "0 failed" on SUCCESS, and a bare \bfailed\b read
// every green cargo turn as stuck (spurious re-plans in --plan mode on Rust).
const STUCK_RE = /(^|\n)\s*(ERROR|Traceback|FAIL|AssertionError|not ok\b)|not found|exit [1-9]|\b[1-9]\d*\s+failed\b|(?<!\b0\s)\btests? failed\b|\[pre-gate\]/i;

// Read-only recon actions can legitimately error (a missing path, no matches)
// without meaning the plan has stalled — don't let benign exploration look "stuck".
const RECON_ACTIONS = new Set(["read_file", "list_dir", "search", "inspect"]);

// Stuck = the last `lookback` NON-recon turns all show failure.
export function isStuck(turns, lookback = 2) {
  if (turns.length < lookback) return false;
  return turns.slice(-lookback).every((t) => {
    if (RECON_ACTIONS.has(t.action && t.action.a)) return false;
    return STUCK_RE.test(String(t.observation || ""));
  });
}

// Reflect on a stalled trajectory and produce a revised plan. Returns {goal,steps} or null.
export async function rePlan({ model, task, currentPlan, turns, buildRawPrompt, nPredict = 1024, signal = null }) {
  const recent = turns.slice(-5).map((t) => {
    const a = t.action || {};
    const args = Object.entries(a).filter(([k]) => k !== "a").map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(",");
    const obs = String(t.observation || "").split("\n").find((l) => l.trim()) || "";
    return `${a.a}(${args}) -> ${obs.slice(0, 80)}`;
  }).join("\n");

  const instruction = `You are working on this task but your current plan is NOT getting you there — recent steps keep failing.

TASK: ${task}

CURRENT PLAN (goal: ${currentPlan.goal}):
${currentPlan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

RECENT ACTIONS AND RESULTS:
${recent}

Reflect on what is going wrong and produce a REVISED plan (one-line goal + 3-6 concrete steps) that gets unstuck. Output one JSON object: {"goal": "...", "steps": ["...", ...]}.`;

  let out;
  try {
    out = await model.complete(buildRawPrompt(instruction), { grammar: PLAN_GRAMMAR, nPredict, signal });
  } catch { return null; }
  const obj = extractJson(out.content);
  if (!obj || !obj.goal || !Array.isArray(obj.steps) || !obj.steps.length) return null;
  return {
    goal: String(obj.goal).slice(0, 200),
    steps: obj.steps.slice(0, 8).map((s) => String(s).slice(0, 200)),
  };
}

// Render the plan for the prompt, marking completed steps. The model often numbers its own steps
// ("1. Inspect …"); strip a leading enumerator so formatPlan's own numbering isn't doubled
// ("[ ] 1. 1. Inspect …") in the plan the model re-reads every turn.
export function formatPlan(plan, doneCount = 0) {
  if (!plan) return "";
  const lines = plan.steps.map((s, i) =>
    `${i < doneCount ? "[x]" : "[ ]"} ${i + 1}. ${String(s).replace(/^\s*\d+[.)]\s*/, "")}`);
  return `Your plan (goal: ${plan.goal}):\n${lines.join("\n")}\nFollow it, adapt as you learn, and verify before you finish.`;
}

function extractJson(text) {
  const start = String(text).indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
