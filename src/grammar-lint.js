// Static lint of generated GBNF text.
//
// llama.cpp's failure mode for an invalid grammar is to silently ignore it and
// free-generate (src/grammar.js:41-46, the invisible force-edit bug): every
// mask still "fired" in the logs while constraining nothing. A grammar defect
// therefore has no runtime symptom at the point of failure — so every grammar
// is linted at generation time, where a defect can still throw.
//
// Two defect classes are caught here, both invisible at runtime:
//   1. a dangling rule reference (a ref with no `::=` definition), and
//   2. a MASK-ESCAPE — a verb the caller asked to exclude that is still
//      reachable from `root` through some sub-rule (the documented inspect-op
//      escape at grammar.js:42-49). A masked verb whose literal the grammar can
//      still emit is a mask that fired but never constrained.

// Decode a GBNF string-literal body (the chars between the quotes) to its value.
function decodeLiteral(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const c = raw[i + 1];
      out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
      i += 1;
    } else {
      out += raw[i];
    }
  }
  return out;
}

// Scan grammar text into per-rule reference/literal sets. A rule header is a
// `name` immediately followed by `::=`; every token after it belongs to that
// rule's body until the next header. String-literal and character-class
// contents are never references (an identifier inside them is literal text).
function scanRules(text) {
  const src = String(text ?? "");
  const isWordStart = (c) => /[A-Za-z]/.test(c);
  const isWord = (c) => /[A-Za-z0-9-]/.test(c);
  const rules = new Map();          // name -> { refs:Set, literals:Set }
  const references = [];            // flat list (with duplicates) for dangling check
  let current = null;
  let i = 0;
  const n = src.length;
  const ruleOf = (name) => {
    if (!rules.has(name)) rules.set(name, { refs: new Set(), literals: new Set() });
    return rules.get(name);
  };
  while (i < n) {
    const c = src[i];
    if (c === '"') {                     // literal — honor backslash escapes
      const start = i + 1;
      i += 1;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      if (current) current.literals.add(decodeLiteral(src.slice(start, i)));
      i += 1;
      continue;
    }
    if (c === "[") {                     // character class — honor escapes
      i += 1;
      while (i < n && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "#") {                     // comment to end of line
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      while (j < n && isWord(src[j])) j += 1;
      const name = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k += 1;
      if (src.startsWith("::=", k)) {
        current = ruleOf(name);          // a rule header — its body follows
      } else {
        references.push(name);
        if (current) current.refs.add(name);
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { rules, references };
}

// Rules reachable from `root`, following references through DEFINED rules only.
function reachableRules(rules) {
  const reached = new Set();
  if (!rules.has("root")) return reached;
  const queue = ["root"];
  reached.add("root");
  while (queue.length) {
    const rule = rules.get(queue.shift());
    if (!rule) continue;
    for (const ref of rule.refs) {
      if (rules.has(ref) && !reached.has(ref)) {
        reached.add(ref);
        queue.push(ref);
      }
    }
  }
  return reached;
}

/** The set of decoded string literals reachable from `root`. */
export function reachableLiterals(text) {
  const { rules } = scanRules(text);
  const literals = new Set();
  for (const name of reachableRules(rules)) {
    for (const lit of rules.get(name).literals) literals.add(lit);
  }
  return literals;
}

/**
 * Lint generated GBNF text.
 * @param {string} text
 * @param {{excludeVerbs?: string[]|Set<string>}} [opts] - verbs the grammar was
 *   built to mask out; each must be UNREACHABLE from root or it escaped the mask.
 */
export function lintGrammar(text, opts = {}) {
  const { rules, references } = scanRules(text);
  const defined = new Set(rules.keys());
  const errors = [];

  if (!defined.has("root")) errors.push("no root rule defined");
  for (const name of [...new Set(references)].filter((r) => !defined.has(r))) {
    errors.push(`dangling rule reference: ${name}`);
  }

  const excludeVerbs = opts.excludeVerbs instanceof Set
    ? [...opts.excludeVerbs]
    : Array.isArray(opts.excludeVerbs) ? opts.excludeVerbs : [];
  if (excludeVerbs.length) {
    const literals = new Set();
    for (const name of reachableRules(rules)) {
      for (const lit of rules.get(name).literals) literals.add(lit);
    }
    // A verb `v` is rendered as the literal `"v"` (gbnfLiteral wraps it in
    // escaped quotes); its reachable, decoded form is therefore `"v"`.
    for (const verb of excludeVerbs) {
      if (literals.has(`"${verb}"`)) {
        errors.push(`masked verb still reachable from root: ${verb}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, defined: [...defined] };
}
