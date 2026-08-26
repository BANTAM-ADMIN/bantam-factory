// Research triggers: which claims deserve a library trip.
//
// The librarian study (2026-08-19, 15 loops) measured two distinct signals:
//  - FELT gaps: the model flags its own uncertainty, and those flags land on
//    real errors (the EPUB case). Detectable from phrasing.
//  - UNFELT risk: the model's worst errors carried NO flag — a confident
//    "bitmask, not an enum" reproduced across four independent runs. Those
//    errors cluster in CLASSES of externally-defined fact: enum/constant
//    tables, version-introduced particulars, spec-numeric rules, vendor
//    product figures. Class membership, not confidence, is the trigger.
//
// Neither signal auto-spends: they produce an OFFER line; the user invokes
// :research (or has standing consent). Cap before cleverness.

const UNCERTAINTY_RES = [
  /I(?:'|’)?m not (?:certain|sure)/i,
  /not (?:100%|fully|entirely) (?:certain|sure)/i,
  /I(?:'|’)?d want to (?:confirm|double-?check|verify)/i,
  /worth (?:verifying|double-?checking|confirming)/i,
  /(?:from|by) memory[,;]? (?:so|and) /i,
  /treat .{0,40}as a rule of thumb/i,
  /may (?:be|have) (?:changed|moved|outdated)/i,
  /\[K\]/,
];

const CLAIM_CLASS_RES = [
  // enum/constant tables: "14 = Q4_K_S", "0x27 =", "TYPE_X = 5"
  { cls: "constant-table", re: /\b(?:0x[0-9a-f]+|\d{1,4})\s*(?:=|→|->|:)\s*[A-Z][A-Za-z0-9_]{2,}|[A-Z][A-Z0-9_]{3,}\s*=\s*\d{1,4}\b/ },
  // version-introduced particulars: "introduced in Python 3.11", "since EPUB 3.2", "added in v2.4"
  { cls: "version-particular", re: /\b(?:introduced|added|since|as of|new in|removed in|deprecated (?:in|since))\s+(?:in\s+)?[A-Za-z.\s]{0,16}\d+(?:\.\d+)+/i },
  // spec-numeric rules: "first 1040 bytes", "RFC 9110", "port 8085", "2^31"
  { cls: "spec-numeric", re: /\bRFC\s?\d{3,5}\b|\bfirst\s+\d{2,6}\s+bytes\b|\b\d+\s*(?:\^|\*\*)\s*\d+\b/i },
  // vendor product figures: "16,384 CUDA cores", "384-bit bus", "450 W"
  { cls: "vendor-figure", re: /\b\d{1,3}(?:,\d{3})+\s+[A-Za-z]|\b\d{2,4}[- ]?bit\s+(?:bus|interface)|\b\d{2,4}\s?W\b/ },
];

export function uncertaintyFlags(text) {
  const t = String(text ?? "");
  const hits = [];
  for (const re of UNCERTAINTY_RES) {
    const m = t.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export function claimClassMatches(text) {
  const t = String(text ?? "");
  const found = new Map();
  for (const { cls, re } of CLAIM_CLASS_RES) {
    const m = t.match(re);
    if (m) found.set(cls, m[0].trim());
  }
  return [...found.entries()].map(([cls, sample]) => ({ cls, sample }));
}

/**
 * The one-line offer after an answer, or null when nothing warrants it.
 * Class matches alone suffice (the unfelt-risk lesson); flags strengthen it.
 */
export function researchOffer(text) {
  const flags = uncertaintyFlags(text);
  const classes = claimClassMatches(text);
  if (!flags.length && !classes.length) return null;
  const parts = [];
  if (classes.length) parts.push(`${classes.length} claim${classes.length > 1 ? "s" : ""} in research-prone classes (${classes.map((c) => c.cls).join(", ")})`);
  if (flags.length) parts.push(`${flags.length} flagged unverified`);
  return `🔎 ${parts.join(" · ")} — \`:probe\` tests stability locally (free, seconds); \`:research\` verifies against sources (bounded web agent; nothing else leaves this machine).`;
}

/**
 * Elicited gap list — the winning proactive trigger from the preregistered
 * gap-list A/B (2026-08-18): asked "what would you look up?", the model
 * localized BOTH of its real errors (git 2.29, the dotted rope key) while
 * the mechanical probe caught neither. Elicited introspection is a different
 * instrument from spontaneous hedging, and it works.
 */
export async function elicitGaps({ endpoint, question, fetchImpl = fetch } = {}) {
  const ask = `You will later answer this question: ${question}
Do NOT answer it now. List up to 2 specific factual gaps you would want an authoritative source for before answering, each on its own line beginning with GAP- then a colon. If you need no sources, reply NO-GAPS.`;
  const prompt = `<|im_start|>user\n${ask}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  const res = await fetchImpl(`${endpoint}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, n_predict: 400, temperature: 0, cache_prompt: false }),
  });
  const d = await res.json();
  const text = String(d?.content ?? "");
  return text.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("GAP-") && !l.includes("beginning with"));
}
