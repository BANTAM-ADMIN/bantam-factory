// Claim-check gauge. When the material is a claim and the evidence it is to be
// judged against, list the claim's specific details (numbers and capitalised
// names) that appear nowhere in the evidence. A claim that checks out link by
// link can still carry one planted detail ("released in 1999" when the
// evidence says 1987), and the model's fast read passes it confidently.
//
// On the Decision Index HoVer rows, an unsourced detail was present in 21 of 26
// unsupported claims versus 4 of 32 supported ones on the test sample (10 of 14
// versus 1 of 13 on dev), and in 8 of the 12 unsupported claims we called
// supported. The finding is evidence for the model, never a verdict.

// Capitalised words that start sentences or are generic, not details.
const COMMON = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "its", "he", "she", "they", "his", "her", "their", "in", "on", "at", "of", "for", "and", "or", "but", "with", "by", "from", "as", "is", "was", "are", "were", "be", "to", "which", "who", "whose", "what", "when", "where", "after", "before", "during", "one", "both", "also", "there"]);

function evidenceText(evidence) {
  if (typeof evidence === "string") return evidence;
  if (Array.isArray(evidence)) return evidence.map((item) => (typeof item === "string" ? item : [item?.title, item?.text, item?.content].filter(Boolean).join(" "))).join("\n");
  return "";
}

/** The claim and its evidence text, when the material has that shape. */
export function findClaim(state) {
  if (!state || typeof state !== "object" || typeof state.claim !== "string") return null;
  const evidence = evidenceText(state.evidence ?? state.evidences ?? state.context);
  return evidence ? { claim: state.claim, evidence } : null;
}

const norm = (word) => word.toLowerCase().replace(/[’']s$/, "").replace(/[.,;:!?)"(]+$/g, "").replace(/^[("]+/, "");

/** Numbers and capitalised words in the claim that the evidence never mentions. */
export function unsourcedDetails(claim, evidence) {
  const haystack = ` ${evidence.toLowerCase().replace(/[’']s\b/g, "")} `;
  const found = [];
  for (const raw of claim.split(/\s+/)) {
    const word = norm(raw);
    if (!word || COMMON.has(word)) continue;
    const isNumber = /\d/.test(word);
    const isName = /^[A-Z]/.test(raw.replace(/^[("]+/, ""));
    if (!isNumber && !isName) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (!pattern.test(haystack) && !found.includes(word)) found.push(word);
  }
  return found;
}

/** The note the reads see, or null when every detail is sourced. */
export function claimCheckNote(state) {
  const found = findClaim(state);
  if (!found) return null;
  const details = unsourcedDetails(found.claim, found.evidence);
  return details.length ? `CLAIM CHECK (exact): these details in the claim appear nowhere in the evidence: ${details.join(", ")}. A claim is supported only if every detail is.` : null;
}
