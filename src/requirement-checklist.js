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

// 3. collection shape demands: a named input's element preconditions. Their
// violations are rejection cases that visible tests routinely never touch.
// Measured 2026-09-08 on glob-select: a candidate implemented six of the seven
// constraints in one such sentence, dropped "unique", ticked the requirement
// off in its own done reasoning, and shipped with green tests throughout.
// Gated on a shape word so ordinary "must be" prose stays out.
const COLLECTION_SHAPE_RE = /[^.!?\n]*\bmust\s+be\s+(?:an?\s+)?[^.!?\n]*?\b(?:dense|unique|distinct|nonempty|non-empty|non-null|non-array)\b[^.!?\n]*[.!?]?/gi;

// 4. short quoted literals: task-named inputs/outputs, not prose quotations.
// Double quotes only: single quotes double as apostrophes in prose, and the
// pair ("it's ... don't") captures garbage fragments (measured 2026-08-15:
// say's checklist quoted ["s fine to stop at"]).
const QUOTED_RE = /["“”]([^"“”\n]{2,80})["“”]/g;

function clip(s) {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > MAX_ITEM_CHARS ? `${t.slice(0, MAX_ITEM_CHARS)}…` : t;
}

export function extractRequirements(task) {
  const source = String(task ?? "");
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const item = clip(s);
    const key = item.toLowerCase();
    if (!item || seen.has(key) || out.length >= MAX_ITEMS) return;
    seen.add(key);
    out.push(item);
  };

  // rejection-demand sentences first: they carry the most contract per char.
  for (const m of source.matchAll(REJECT_SENTENCE_RE)) push(m[0]);

  // collection shape demands: the precondition sentence names several element
  // constraints at once, and dropping one of them still leaves tests green.
  for (const m of source.matchAll(COLLECTION_SHAPE_RE)) push(m[0]);

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

/** Audit-hint suffix quoting the task's own named requirements, or "". */
export function requirementChecklistSuffix(task) {
  const items = extractRequirements(task);
  if (!items.length) return "";
  return ` This task explicitly names: ${items.map((x) => `[${x}]`).join(" · ")}. Trace each named bound, literal, and rejection through the current code — the visible tests may cover none of them.`;
}
