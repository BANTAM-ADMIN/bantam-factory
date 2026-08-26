// Harness-side claim diffing — the poisoned-shelf countermeasure.
//
// The falsifier (2026-08-19) proved the model's self-reported memory is
// malleable under source pressure: handed a planted lie, it adopted it AND
// declared "matches my recollection; no conflict" — though its cold answer,
// on file, said the opposite. Conflict detection therefore cannot route
// through the model. The harness holds the cold answer; this module diffs
// fact atoms between the two texts and surfaces disagreements mechanically.
//
// Scope: the same externally-defined fact classes that trigger research
// (version particulars, constant assignments, spec numerics) — the classes
// where both delusion and poisoning live. Prose disagreements are out of
// scope; atoms with a shared anchor and a different value are the signal.

const ATOM_RES = [
  // "introduced in Python 3.11", "added in EPUB 3.2", "since v2.4"
  { cls: "version", re: /\b(?:added|introduced|new|since|as of|available)(?:\s+in)?\s+((?:[A-Z][A-Za-z+.#-]{1,14}\s?)+?)\s?v?(\d+(?:\.\d+)+)/g,
    anchor: (m) => m[1].trim().toLowerCase(), value: (m) => m[2] },
  // "Python 3.11 introduced TaskGroup" — the verb lands AFTER the version in
  // natural declaratives (live probe, 2026-08-18); verb-first alone is blind.
  { cls: "version", re: /\b((?:[A-Z][A-Za-z+.#-]{1,14}\s)+?)v?(\d+(?:\.\d+)+)\s+(?:introduced|added|shipped|gained|brought)\b/g,
    anchor: (m) => m[1].trim().toLowerCase(), value: (m) => m[2] },
  // "the numeric value of GGML_TYPE_Q5_K … is 14" — same-sentence copula.
  { cls: "constant", re: /\b([A-Z][A-Za-z0-9_]{3,})[^.!?\n]{0,60}?\bis\s+(\d{1,5})\b/g,
    anchor: (m) => m[1].toLowerCase(), value: (m) => m[2] },
  // "NAME = 14" / "14 = NAME" / "NAME: 14"
  { cls: "constant", re: /\b([A-Z][A-Za-z0-9_]{3,})\s*(?:=|:)\s*(\d{1,5})\b/g,
    anchor: (m) => m[1].toLowerCase(), value: (m) => m[2] },
  { cls: "constant", re: /\b(\d{1,5})\s*(?:=|:|→|->)\s*([A-Z][A-Za-z0-9_]{3,})\b/g,
    anchor: (m) => m[2].toLowerCase(), value: (m) => m[1] },
  // "first 1040 bytes"
  { cls: "spec-numeric", re: /\bfirst\s+(\d{2,6})\s+bytes\b/gi,
    anchor: () => "first-bytes", value: (m) => m[1] },
  // "autovacuum_freeze_max_age (default 200,000,000)" / "= 1.6 billion" —
  // the librarian-study q11 shelf carried structure but no numbers; the model
  // filled one from memory (1.6B, the FAILSAFE age) while its cold answer had
  // the true default (200M). Lowercase config keys with comma/word-formatted
  // values were invisible to every class above — found 2026-08-19.
  { cls: "config-default", re: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6})\s*(?:\(\s*)?(?:defaults?(?:\s+to)?\s*:?\s*|=\s*|:\s+)([0-9][\d,]*(?:\.\d+)?)\s*(billion|million|thousand)?\b/g,
    anchor: (m) => m[1],
    value: (m) => {
      const mult = { billion: 1e9, million: 1e6, thousand: 1e3 }[m[3]] ?? 1;
      const n = Number(m[2].replace(/,/g, "")) * mult;
      return Number.isFinite(n) ? String(n) : m[2];
    } },
];

export function factAtoms(text) {
  // Answers arrive as markdown: "**Python 3.11**", "`GGML_TYPE_Q5_K` = 13".
  // Emphasis and code ticks defeated the anchors in the first live validation
  // (2026-08-19) — strip formatting before extraction, never require it.
  const t = String(text ?? "").replace(/[*`]/g, "");
  const atoms = [];
  for (const { cls, re, anchor, value } of ATOM_RES) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      atoms.push({ cls, anchor: anchor(m), value: value(m), raw: m[0].trim() });
    }
  }
  return atoms;
}

/**
 * Conflicts between two texts: same (cls, anchor), different value.
 * Returned with both raw forms so the surfaced warning quotes evidence.
 */
export function diffClaims(coldText, shelvedText) {
  const cold = factAtoms(coldText);
  const shelved = factAtoms(shelvedText);
  const conflicts = [];
  const seen = new Set();
  for (const a of cold) {
    for (const b of shelved) {
      if (a.cls !== b.cls || a.anchor !== b.anchor || a.value === b.value) continue;
      const key = `${a.cls}:${a.anchor}:${a.value}:${b.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ cls: a.cls, anchor: a.anchor, coldValue: a.value, shelvedValue: b.value, coldRaw: a.raw, shelvedRaw: b.raw });
    }
  }
  return conflicts;
}

/** Render harness warnings for the user — the memory that cannot be back-written. */
export function renderClaimDiff(conflicts) {
  if (!conflicts.length) return null;
  const lines = conflicts.slice(0, 6).map((c) =>
    `⚠ claim-diff (${c.cls} · ${c.anchor}): your previous answer said "${c.coldRaw}" — this one says "${c.shelvedRaw}". The harness holds both; verify against the source before trusting either.`);
  return lines.join("\n");
}
