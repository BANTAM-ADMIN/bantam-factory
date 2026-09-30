// Digest station: before a large family of candidates is judged against one
// short text (a review against ~60 aspect/sentiment pairs, a query against 32
// passages), read the text once and list what it says, asks for or
// expresses, each point backed by an exact quote. The harness keeps only the
// points whose quote really is in the text, and every candidate is then judged
// with the digest in view.
//
// Judged alone, candidates are matched on surface cues: on ACOS the model
// said yes to 1,036 pairs where 70 were right, 86% of them naming an entity no
// opinion in the review is about (the sentiment matched, the subject did not).

export const DIGEST_SYSTEM = "You prepare a digest of a text so that many candidate statements can be checked against it. List each distinct thing the text says, asks for or expresses, one per line, as: \"exact quote\" | what it is about | sentiment (positive, negative, neutral or none). Copy each quote exactly from the text. List nothing the text does not say. If it says nothing specific, write NONE.";

const squash = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();

/** Parse digest lines and keep those whose quote appears in the source text. */
export function verifiedPoints(digest, source) {
  const haystack = squash(source);
  const points = [];
  for (const line of String(digest).split("\n")) {
    const m = /^\s*[-*\d.)\s]*"([^"]{2,})"\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]+?)\s*)?$/.exec(line);
    if (!m) continue;
    if (!haystack.includes(squash(m[1]))) continue;
    points.push({ quote: m[1].trim(), about: m[2].trim(), sentiment: (m[3] ?? "").trim().toLowerCase() });
  }
  return points;
}

/** The note every candidate's read sees, or null when no point survived. */
export function digestNote(points) {
  if (!points.length) return null;
  const lines = points.map(({ quote, about, sentiment }) => `- "${quote}" | about: ${about}${sentiment && sentiment !== "none" ? ` | ${sentiment}` : ""}`);
  return `DIGEST (what the text says; every quote checked against the text):\n${lines.join("\n")}`;
}

/** Does this row call for a digest: one short text and a family of candidates? */
export function wantsDigest(stateText, questions, { minFamily = 10, maxChars = 2000 } = {}) {
  if (stateText.length > maxChars) return false;
  const sizes = new Map();
  for (const q of Object.values(questions)) {
    const key = q.type === "noul" ? `noul:${JSON.stringify(q.criteria ?? null)}` : `choice:${JSON.stringify(Object.values(q.criteria ?? {}).map(String).sort())}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...sizes.values()) >= minFamily;
}
