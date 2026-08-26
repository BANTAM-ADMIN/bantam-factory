// continuity-anchors: a structural index of a prose passage's factual claims — the
// text analog of the Datalog KB. It finds a noun described two different ways with
// the SAME attribute (two quantities, two materials, two colors) and surfaces the
// pair as a CANDIDATE continuity conflict. This is accurate situational context
// (principle 1), not the answer: it points the model at "crates: forty vs thirty —
// reconcile or confirm intentional" and lets the model decide.
//
// Why it exists: on continuity-repair a 27B reading the whole chapter UNDER-
// enumerates the planted inconsistencies — it fixes some, invents spurious ones,
// and misses one (measured: 0/5 pass, the crate-count pair missed every time). A
// precise checklist of same-attribute disagreements is the context it lacked.
//
// Precision over recall: matching within a recognized attribute class (not "any
// word before a noun") is what separates the real pairs (forty/thirty crates,
// brass/iron compass) from noise (port/river town). Pure/injectable.

import fs from "node:fs";
import path from "node:path";

// Attribute classes: a conflict is the same noun carrying ≥2 different values of ONE
// class. Quantities are open (number words + digits); the closed sets below are the
// common physical attributes continuity errors turn on.
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "dozen", "score",
]);
const MATERIALS = new Set([
  "brass", "iron", "gold", "golden", "silver", "copper", "bronze", "steel", "tin",
  "lead", "wood", "wooden", "stone", "glass", "leather", "clay", "pewter", "ivory",
]);
const COLORS = new Set([
  "red", "blue", "green", "black", "white", "grey", "gray", "brown", "yellow",
  "purple", "violet", "amber", "crimson", "scarlet", "azure", "pale", "dark",
]);
const STOP_NOUN = new Set([
  "the", "a", "an", "of", "and", "or", "that", "this", "with", "was", "were", "him",
  "her", "them", "they", "when", "where", "which", "would", "could", "should", "said",
  "from", "into", "over", "under", "there", "here", "thing", "things", "time", "way",
]);

function classOf(token) {
  if (NUMBER_WORDS.has(token) || /^\d+$/.test(token)) return "quantity";
  if (MATERIALS.has(token)) return "material";
  if (COLORS.has(token)) return "color";
  return null;
}

// Durations are a cross-noun conflict class the same-noun anchor logic can't see:
// "three days" and "a week" disagree but attach to different nouns (days vs week).
// So they're detected per-passage instead: a passage giving two DIFFERENT durations
// is a candidate continuity conflict (the waiting-time error on continuity-repair).
const DURATION_UNITS = "day|days|week|weeks|month|months|year|years|hour|hours|night|nights|minute|minutes|fortnight|fortnights";
const DURATION_RE = new RegExp(`\\b(a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|\\d+)\\s+(${DURATION_UNITS})\\b`, "gi");
const NUM_MAP = { a: 1, an: 1, the: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
const normalizeDuration = (count, unit) => {
  const c = count.toLowerCase();
  const n = /^\d+$/.test(c) ? Number(c) : (NUM_MAP[c] ?? c);
  return `${n} ${unit.toLowerCase().replace(/s$/, "")}`;
};

/** Passages (lines) giving ≥2 different durations — candidate continuity conflicts. */
export function durationConflicts(text = "") {
  const out = [];
  String(text).split("\n").forEach((line, idx) => {
    const found = new Map(); // normalized -> raw phrase
    for (const m of line.matchAll(DURATION_RE)) {
      const norm = normalizeDuration(m[1], m[2]);
      if (!found.has(norm)) found.set(norm, m[0]);
    }
    if (found.size >= 2) out.push({ line: idx + 1, phrases: [...found.values()], excerpt: line.trim().slice(0, 120) });
  });
  return out;
}

/** Does a text mention a duration expression at all? (used by the notes gate.) */
function mentionsDuration(text) {
  DURATION_RE.lastIndex = 0;
  return DURATION_RE.test(String(text));
}

const singular = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/**
 * @param {string} text
 * @returns {Array<{noun, attribute, mentions:[{modifier, line, excerpt}]}>}  nouns
 *   carrying ≥2 different values of one attribute class — candidates to reconcile,
 *   most-conflicting first.
 */
export function continuityAnchors(text = "") {
  const lines = String(text).split("\n");
  // noun -> class -> Map(modifier -> {line, excerpt})
  const index = new Map();
  const wordRe = /[A-Za-z]+|\d+/g;

  lines.forEach((line, idx) => {
    const toks = line.match(wordRe);
    if (!toks) return;
    for (let i = 1; i < toks.length; i += 1) {
      const cls = classOf(toks[i - 1].toLowerCase());
      if (!cls) continue;
      const nounRaw = toks[i].toLowerCase();
      if (STOP_NOUN.has(nounRaw) || nounRaw.length < 3) continue;
      const noun = singular(nounRaw);
      const mod = toks[i - 1].toLowerCase();
      if (!index.has(noun)) index.set(noun, new Map());
      const classes = index.get(noun);
      if (!classes.has(cls)) classes.set(cls, new Map());
      const mods = classes.get(cls);
      if (!mods.has(mod)) mods.set(mod, { line: idx + 1, excerpt: line.trim().slice(0, 120) });
    }
  });

  const anchors = [];
  for (const [noun, classes] of index) {
    for (const [attribute, mods] of classes) {
      if (mods.size < 2) continue; // one value → consistent, no candidate
      anchors.push({
        noun, attribute,
        mentions: [...mods.entries()].map(([modifier, at]) => ({ modifier, line: at.line, excerpt: at.excerpt })),
      });
    }
  }
  anchors.sort((a, b) => b.mentions.length - a.mentions.length);
  return anchors;
}

// Files that legitimately mention conflicting values while DESCRIBING the fix
// (repair notes, readmes) — never gate on these, or a correct notes file that says
// "changed iron to brass" would block forever.
const META_FILE_RE = /(^|[-_.])(notes?|readme|changelog|todo|license|contributing)([-_.]|$)/i;
const PROSE_EXT_RE = /\.(md|markdown|txt)$/i;

/** List narrative prose files in a workspace (top-level + one level down), excluding meta files. */
function narrativeProseFiles(workspace, fsImpl = fs) {
  const out = [];
  const scan = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) scan(full, depth - 1);
      else if (e.isFile() && PROSE_EXT_RE.test(e.name) && !META_FILE_RE.test(e.name)) out.push(full);
    }
  };
  scan(workspace, 1);
  return out;
}

/**
 * Done-gate objection: at a finish, re-check the narrative prose for same-attribute
 * conflicts still described two ways. Unlike the read-time advisory (which the 27B
 * ignores ~⅔ of the time), a gate flips the decision — and it catches BOTH the
 * missed conflict and the HALF-fixed one (compass left brass=1/iron=1), which the
 * A/B showed the advisory could not. Bounded so it can never trap; a genuinely
 * intentional difference survives the bound.
 * @returns {string|null} block message, or null if clean / bound reached
 */
export function continuityReconcileObjection(workspace, alreadyRejected = 0, { maxRejections = 2, fsImpl = fs } = {}) {
  if (alreadyRejected >= maxRejections) return null; // never trap forever
  const conflicts = [];
  for (const file of narrativeProseFiles(workspace, fsImpl)) {
    let text;
    try { text = fsImpl.readFileSync(file, "utf8"); } catch { continue; }
    for (const a of continuityAnchors(text)) {
      conflicts.push(`${path.basename(file)}: "${a.mentions.map((m) => `${m.modifier} ${a.noun}`).join('" vs "')}" (${a.attribute})`);
    }
    for (const dc of durationConflicts(text)) {
      conflicts.push(`${path.basename(file)}: ${dc.phrases.map((p) => `"${p}"`).join(" vs ")} — two different durations in one passage`);
    }
  }
  if (!conflicts.length) return null;
  return "[continuity] You called done, but the text still describes the same thing two conflicting ways:\n"
    + conflicts.map((c) => `  - ${c}`).join("\n")
    + "\n\nEach is either a continuity error to reconcile to ONE value, or an intentional difference. "
    + "Reconcile every real conflict in the prose (check for a SECOND mention you may have left — a half-fixed "
    + "conflict still fails), and if any difference is deliberate, keep it and say so in your notes. Then finish.";
}

const NOTES_NAME_RE = /^(notes?|changes?|changelog|repairs?|fixes?)\b/i;

/** Find the run's notes/changelog deliverable (a meta prose file), or null. */
function findNotesFile(workspace, fsImpl = fs) {
  const scan = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) { const r = scan(full, depth - 1); if (r) return r; }
      else if (e.isFile() && PROSE_EXT_RE.test(e.name) && NOTES_NAME_RE.test(e.name)) return full;
    }
    return null;
  };
  return scan(workspace, 1);
}

/** (modifier, singular-noun) pairs where the modifier is a recognized attribute value. */
function* attributePairs(text) {
  const toks = String(text).match(/[A-Za-z]+|\d+/g);
  if (!toks) return;
  for (let i = 1; i < toks.length; i += 1) {
    if (!classOf(toks[i - 1].toLowerCase())) continue;
    const nounRaw = toks[i].toLowerCase();
    if (STOP_NOUN.has(nounRaw) || nounRaw.length < 3 || /^\d+$/.test(nounRaw)) continue;
    yield [toks[i - 1].toLowerCase(), singular(nounRaw)];
  }
}

/**
 * Done-gate objection: the task produced a notes/changelog deliverable, but it
 * doesn't document a same-attribute repair the model actually made. Derived from the
 * model's OWN edits (the values it changed away from), not the grader's assertion —
 * it states the spec requirement ("one bullet per repair you made, naming what you
 * changed"). Catches the measured failure where the model reconciles a conflict in
 * the prose but writes notes that don't mention it (or confabulate a different fix).
 * Bounded so it can never trap. Only same-attribute (quantity/material/color)
 * reconciliations are checked — the ones the anchor machinery can name precisely.
 * @returns {string|null}
 */
export function notesDocumentationObjection(turns = [], workspace, alreadyRejected = 0, { maxRejections = 2, fsImpl = fs } = {}) {
  if (alreadyRejected >= maxRejections) return null;
  const notesPath = findNotesFile(workspace, fsImpl);
  if (!notesPath) return null; // no notes deliverable — nothing to enforce
  let notes = "";
  try { notes = fsImpl.readFileSync(notesPath, "utf8").toLowerCase(); } catch { return null; }

  // Reconciliations the model made: an attribute value it removed (edited away) in a
  // NON-notes prose file. The noun it attaches to is what got repaired.
  const reconciled = new Map(); // singular noun -> the removed modifier
  let editedDuration = null;    // a duration phrase the model changed (the waiting-time repair)
  for (const t of turns) {
    const a = t.parsedAction || {};
    if (!/^(replace|edit_lines|patch)$/.test(a.a || "")) continue;
    const edits = a.a === "patch" ? (a.edits || []) : [{ p: a.p, old: a.old }];
    for (const e of edits) {
      if (!e.p || !PROSE_EXT_RE.test(e.p) || META_FILE_RE.test(path.basename(e.p))) continue;
      const removed = String(e.old ?? "");
      for (const [mod, noun] of attributePairs(removed)) {
        if (!reconciled.has(noun)) reconciled.set(noun, mod);
      }
      // A duration the model edited away (only when the edit actually changed it).
      if (!editedDuration && mentionsDuration(removed) && !mentionsDuration(String(e.new ?? removed))) {
        editedDuration = (removed.match(DURATION_RE) || [])[0] || "a duration";
      }
    }
  }
  const undocumented = [];
  for (const [noun, mod] of reconciled) {
    if (!notes.includes(noun) && !notes.includes(mod)) undocumented.push(`the ${noun} (you changed "${mod} ${noun}")`);
  }
  // A duration repair must be documented too: notes should mention a duration or waiting.
  if (editedDuration && !mentionsDuration(notes) && !/\bwaiting\b|\bduration\b/.test(notes)) {
    undocumented.push(`the waiting-time / duration (you changed "${editedDuration}")`);
  }
  if (!undocumented.length) return null;
  return `[notes] You called done, but ${path.basename(notesPath)} does not document `
    + `${undocumented.join(", ")}. The task asks for one bullet per repair you made, naming what you changed — `
    + `add a bullet for each undocumented repair before finishing.`;
}

/** Render anchors as a gate-voiced context block for the model (empty string if none). */
export function renderContinuityAnchors(anchors) {
  if (!anchors.length) return "";
  const lines = anchors.map((a) => {
    const vals = a.mentions.map((m) => `"${m.modifier} ${a.noun}" (line ${m.line})`).join(" vs ");
    return `  - ${a.noun} [${a.attribute}]: ${vals} — reconcile to one, or confirm the difference is intentional.`;
  });
  return `[continuity] Same noun described with conflicting values — candidate continuity errors to verify:\n${lines.join("\n")}`;
}
