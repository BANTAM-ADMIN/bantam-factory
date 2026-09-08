// Extract a task's OWN explicitly named requirements for the completion audit.
//
// Polyglot-js forensics (2026-08-15): five hidden-contract failures were
// behaviors the task text explicitly named ("maximum 32-bit integer", "more
// than 11 digits", "non math question" ...). The generic completion-audit hint
// fired in those runs and was bypassed — correct advice with nothing
// task-specific to make it load. This module quotes the task back at the
// model instead: instruction that carries detection's payload.
//
// Deliberately conservative: three pattern families, verbatim quotes, capped,
// deduplicated, nothing invented. Tasks without requirement language yield []
// and the audit hint stays exactly as it was. Preregistration:
// docs/superpowers/reports/2026-08-15-requirement-checklist-preregistration.md

const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 140;
const MAX_LITERAL_WORDS = 8;

// 1. numeric bounds: a number attached to a unit or comparator phrase.
const BOUND_RE = /(?:(?:more|fewer|less|greater)\s+than\s+|at\s+(?:most|least)\s+|maximum\s+|minimum\s+|up\s+to\s+|exactly\s+)?\b\d+(?:[\s-]*(?:bit|bits|digit|digits|byte|bytes|char|chars|characters|words?|items?|entries|elements)\b)/gi;
const BOUND_PREFIX_RE = /(?:more|fewer|less|greater)\s+than\s+\d+|at\s+(?:most|least)\s+\d+|maximum(?:\s+of)?\s+\d+[\w-]*|minimum(?:\s+of)?\s+\d+[\w-]*|up\s+to\s+\d+|exactly\s+\d+/gi;
const UNIT_BOUND_RE = /\b\d+[\s-]*(?:bit|digit|byte|char|character|word|item|element)s?\b(?:\s+(?:unsigned\s+)?integers?)?/gi;

// 2. rejection demands: sentences that require error behavior.
const REJECT_SENTENCE_RE = /[^.!?\n]*\b(?:must\s+(?:not\s+)?(?:throw|reject|error|mutate|modify)|throws?\s+(?:an?\s+)?(?:Error|TypeError|RangeError|exception)|is\s+invalid|are\s+invalid|invalid\s+when|reject(?:s|ed)?\s+\w|errors?\s+must)\b[^.!?\n]*[.!?]?/gi;

// 3. prohibitions: a stated rule about what an input may not be, contain or do.
// These are rejection rules, but the phrasing carries none of the verbs the
// rejection family looks for. Measured 2026-09-08 on csv-record: the task said
// a bare field "may not contain" a quote, that clause produced no quote, and
// the candidate accepted the very input it forbids. Anchored to a prohibition
// verb rather than any modal, so ordinary advisory prose stays out.
const PROHIBITION_RE=/[^.!?\n]*\b(?:may|must|can|shall)\s*(?:not|never)\b[^.!?\n]*[.!?]?/gi;

// 4. conditional restrictions, overrides and stated alternatives: what the
// code must DO, as opposed to what makes its input invalid. Every family above
// this one describes rejection, so an assignment's behavioural rules produced
// no quote at all. Measured 2026-09-08 on turtle-canvas: the checklist quoted
// four validation rules, the candidate failed three behavioural ones, and none
// of the three was quoted although all three are stated plainly. Anchored on
// the words that mark a restriction or an override, which is where a plausible
// implementation diverges from the assignment: across the 21 published work
// orders this adds 0.67 quotes per card and every one of them is load-bearing.
const CONDITIONAL_RE = /[^.!?\n]*\b(?:only\s+(?:when|while|if)|instead\s+of|rather\s+than|except\s+that|is\s+already\s+\w+|already\s+(?:active|marked|exceeds)|or\s+\w+\s+when)\b[^.!?\n]*[.!?]?/gi;

// A flowed markdown table matches almost any prose pattern and is never a
// requirement sentence. Neither is a statement of what the starter already
// provides: that is context, not a rule the candidate has to satisfy.
const NOT_A_REQUIREMENT_RE = /\||already exports/;

// 5. collection shape demands: a named input's element preconditions. Their
// violations are rejection cases that visible tests routinely never touch.
// Measured 2026-09-08 on glob-select: a candidate implemented six of the seven
// constraints in one such sentence, dropped "unique", ticked the requirement
// off in its own done reasoning, and shipped with green tests throughout.
// Gated on a shape word so ordinary "must be" prose stays out.
const COLLECTION_SHAPE_RE = /[^.!?\n]*\bmust\s+be\s+(?:an?\s+)?[^.!?\n]*?\b(?:dense|unique|distinct|nonempty|non-empty|non-null|non-array)\b[^.!?\n]*[.!?]?/gi;

// 6. short quoted literals: task-named inputs/outputs, not prose quotations.
// Double quotes only: single quotes double as apostrophes in prose, and the
// pair ("it's ... don't") captures garbage fragments (measured 2026-08-15:
// say's checklist quoted ["s fine to stop at"]).
const QUOTED_RE = /["“”]([^"“”\n]{2,80})["“”]/g;

function clip(s) {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > MAX_ITEM_CHARS ? `${t.slice(0, MAX_ITEM_CHARS)}…` : t;
}

export function extractRequirements(task) {
  // Assignments are hard-wrapped prose, so a requirement sentence routinely
  // spans a line break. Every family stops at a newline, which quoted those
  // sentences from the wrap onwards and dropped the subject the rule applies
  // to ("may not contain" without saying what may not contain it). Match
  // against a single-line view; sentence punctuation still bounds each quote.
  const source = String(task ?? "").replace(/[^\S\n]*\n[^\S\n]*/g, " ");
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const item = clip(s);
    const key = item.toLowerCase();
    if (!item || seen.has(key) || out.length >= MAX_ITEMS) return;
    if (NOT_A_REQUIREMENT_RE.test(item)) return;
    seen.add(key);
    out.push(item);
  };

  // rejection-demand sentences first: they carry the most contract per char.
  for (const m of source.matchAll(REJECT_SENTENCE_RE)) push(m[0]);

  // prohibitions: a forbidden input is a rejection case whichever way the
  // sentence is phrased.
  for (const m of source.matchAll(PROHIBITION_RE)) push(m[0]);

  // collection shape demands: the precondition sentence names several element
  // constraints at once, and dropping one of them still leaves tests green.
  for (const m of source.matchAll(COLLECTION_SHAPE_RE)) push(m[0]);

  // conditional restrictions and overrides: the behavioural rules a candidate
  // can implement plausibly and wrongly without any test going red.
  for (const m of source.matchAll(CONDITIONAL_RE)) push(m[0]);

  // numeric bounds — prefer comparator phrases, then unit-attached numbers.
  for (const m of source.matchAll(BOUND_PREFIX_RE)) {
    // include a trailing unit if it directly follows ("more than 11 digits")
    const tail = source.slice(m.index + m[0].length).match(/^\s*[\w-]+/);
    push(m[0] + (tail && /digit|bit|byte|char|word|item|element/i.test(tail[0]) ? tail[0] : ""));
  }
  for (const m of source.matchAll(UNIT_BOUND_RE)) push(m[0]);

  // quoted literals, bounded by word count so prose quotes stay out.
  for (const m of source.matchAll(QUOTED_RE)) {
    if (m[1].trim().split(/\s+/).length <= MAX_LITERAL_WORDS) push(`"${m[1].trim()}"`);
  }

  return out;
}

export function requirementChecklistEnabled(
  value = process.env.BANTAM_REQUIREMENT_CHECKLIST,
) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

// Its own controller annotation, like every sibling audit message, rather than
// prose appended to one. Measured 2026-09-08 across four ansi-wrap attempts and
// every other card: appended inline, the checklist landed 2,139 characters into
// a 7,669-character completion-audit block, and the prompt clipper keeps a
// block's first 700 characters. The countermeasure was computed on every run of
// every card and read by the model on none of them. A block of its own is
// short enough to survive whole.
export const REQUIREMENT_CHECKLIST_MARKER = "[requirement-checklist]";

/** Audit-hint annotation quoting the task's own named requirements, or "". */
export function requirementChecklistSuffix(task) {
  const items = extractRequirements(task);
  if (!items.length) return "";
  return `\n\n${REQUIREMENT_CHECKLIST_MARKER} This task explicitly names: ${items.map((x) => `[${x}]`).join(" · ")}. Trace each named bound, literal, and rejection through the current code — the visible tests may cover none of them.`;
}
