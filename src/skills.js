// Self-building skills — the harness gets better with use.
//
// After a run passes its hidden verification, Bantam asks the model to distill
// what it just did into a small, reusable SKILL (title, trigger keywords, a
// generalized step-by-step approach). Skills are stored in a library. On a new
// task, the most relevant skills are retrieved and injected into the prompt as
// "proven approaches from past verified wins."
//
// Every skill is born from a run that ACTUALLY PASSED a hidden verifier, so the
// library is a growing store of verified know-how — not plausible-looking advice.
// The distillation itself is grammar-constrained, so a skill is always well-formed.

import fs from "node:fs";
import path from "node:path";

// GBNF constraining the model's distillation to one well-formed skill object.
export const SKILL_GRAMMAR = String.raw`
root    ::= ws "{" ws "\"title\"" ws ":" ws string ws "," ws "\"triggers\"" ws ":" ws strarray ws "," ws "\"approach\"" ws ":" ws string ws "," ws "\"language\"" ws ":" ws string ws "}" ws
strarray ::= "[" ws ( string ( ws "," ws string )* )? ws "]"
string  ::= "\"" schar* "\""
schar   ::= [^"\\\x7F\x00-\x1F] | "\\" escape
escape  ::= ["\\/bfnrt] | "u" hex hex hex hex
hex     ::= [0-9a-fA-F]
ws      ::= [ \t\n]*
`;

const STOPWORDS = new Set(("the a an and or of to in on for with that this it is are be as at by from into your you " +
  "so that fails failing fix find make sure only not test tests suite file files src source code function").split(" "));

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function loadLibrary(libPath) {
  try {
    const raw = fs.readFileSync(libPath, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// First-run bootstrap: the library file is runtime state (git-ignored), so a
// fresh clone starts empty. If the library does not exist yet, seed it from the
// committed lessons file so default skills retrieval works with zero setup.
// Only fires when the library file is absent — an existing library, however
// customized or emptied, is never touched.
export function ensureSeededLibrary(libPath, seedPath) {
  if (!libPath || fs.existsSync(libPath)) return { seeded: false };
  let saved = 0;
  for (const skill of loadLibrary(seedPath)) {
    if (saveSkill(libPath, skill).saved) saved++;
  }
  return { seeded: saved > 0, count: saved };
}

// Token set of a skill's title + triggers, for similarity checks.
function skillTokens(s) {
  return new Set([...(s.triggers || []).flatMap(tokenize), ...tokenize(s.title)]);
}

// A new skill is a duplicate if its title+trigger vocabulary overlaps an existing
// skill's by >= threshold (Jaccard). Keeps the library from filling with near-clones.
export function isDuplicate(library, skill, threshold = 0.6) {
  const a = skillTokens(skill);
  if (!a.size) return false;
  for (const s of library) {
    const b = skillTokens(s);
    if (!b.size) continue;
    const inter = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    if (union && inter / union >= threshold) return true;
  }
  return false;
}

// Strip chat control tokens from skill text before it is persisted — a skill is
// injected verbatim into future prompts, so it must not be able to smuggle a fake
// turn / system directive through its title or approach.
const SKILL_CONTROL_RE = /<\|im_(?:start|end)\|>|<\/?think>/gi;
function sanitize(s) {
  return String(s ?? "").replace(SKILL_CONTROL_RE, (m) => m.replace(/[<|>/]/g, ""));
}
function sanitizeSkill(skill) {
  return {
    ...skill,
    title: sanitize(skill.title).slice(0, 120),
    approach: sanitize(skill.approach).slice(0, 600),
    triggers: (skill.triggers || []).map((t) => sanitize(t)),
  };
}

// Append a skill unless a near-duplicate already exists. Returns {saved, reason}.
export function saveSkill(libPath, skill) {
  const clean = sanitizeSkill(skill);
  const existing = loadLibrary(libPath);
  if (isDuplicate(existing, clean)) return { saved: false, reason: "duplicate" };
  fs.mkdirSync(path.dirname(libPath), { recursive: true });
  fs.appendFileSync(libPath, JSON.stringify(clean) + "\n");
  return { saved: true };
}

// Rank skills by keyword overlap of their triggers+title against the task text.
// Triggers weigh double. The same-language boost is a TIE-BREAK ONLY — it never
// pulls in a skill that has no keyword overlap (that was letting irrelevant
// same-language skills leak into every run's prompt).
export function retrieveSkills(task, env, library, { k = 2, language = null } = {}) {
  const want = new Set(tokenize(`${task} ${env}`));
  const scored = library.map((s) => {
    let score = 0;
    for (const t of s.triggers || []) for (const w of tokenize(t)) if (want.has(w)) score += 2;
    for (const w of tokenize(s.title)) if (want.has(w)) score += 1;
    if (score > 0 && language && s.language === language) score += 0.5;
    return { skill: s, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.skill);
}

export function formatSkills(skills) {
  if (!skills.length) return "";
  const lines = skills.map((s, i) =>
    `${i + 1}. ${s.title}\n   Approach: ${s.approach}`);
  return `Proven approaches from past verified runs (use if relevant; adapt to THIS repo, verify before done):\n${lines.join("\n")}`;
}

// Ask the model to distill a reusable skill from a run that just passed.
// Returns a validated skill object, or null if distillation failed.
export async function distillSkill({ model, task, turns, summary, language, buildRawPrompt, nPredict = 1024, signal = null }) {
  const trajectory = (turns || [])
    .filter((t) => t.action && t.action.a !== "done")
    .map((t) => `${t.action.a}(${compactArgs(t.action)})`)
    .join(" -> ");

  const instruction = `You just SOLVED and VERIFIED this coding task on a local repo:
TASK: ${task}
WHAT YOU DID: ${trajectory}
OUTCOME: ${summary || "tests pass"}

Distill this into a REUSABLE skill for SIMILAR future tasks. Generalize — do NOT include this repo's specific file names or values. Output one JSON object:
- "title": a short imperative name for the fix pattern
- "triggers": 3-6 lowercase keyword strings that signal this kind of task (symptoms, concepts)
- "approach": 2-4 sentences of the general step-by-step method that worked
- "language": "${language || "any"}"`;

  const prompt = buildRawPrompt(instruction);
  let out;
  try {
    out = await model.complete(prompt, { grammar: SKILL_GRAMMAR, nPredict, signal });
  } catch { return null; }

  const obj = extractJson(out.content);
  if (!obj || !obj.title || !Array.isArray(obj.triggers) || !obj.approach) return null;
  return {
    id: slug(obj.title),
    title: String(obj.title).slice(0, 120),
    triggers: obj.triggers.slice(0, 8).map((t) => String(t).toLowerCase().slice(0, 40)),
    approach: String(obj.approach).slice(0, 600),
    language: obj.language || language || "any",
    verified: true,
  };
}

// Promote a plan that actually PASSED into a reusable skill — the proven workflow
// becomes recallable for similar tasks. Deterministic (no model call): the plan is
// already the verified approach. Triggers come from the task + goal vocabulary.
export function promotePlanToSkill(plan, task, language) {
  if (!plan || !plan.steps || !plan.steps.length) return null;
  const triggers = [...new Set(tokenize(`${task} ${plan.goal}`))].slice(0, 6);
  return {
    id: slug(plan.goal),
    title: String(plan.goal).slice(0, 120),
    triggers,
    approach: plan.steps.map((s, i) => `${i + 1}. ${s}`).join(" ").slice(0, 600),
    language: language || "any",
    kind: "workflow",
    verified: true,
  };
}

function compactArgs(a) {
  return Object.entries(a).filter(([k]) => k !== "a")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 24) : v}`).join(",");
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
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
