"use strict";

// Small evaluator-side ontology for spatial language. Exact strings are a poor
// contract for visual regions: "central sky", "upper-middle", and
// "open center-right" can describe the same usable area. This normalizer keeps
// grading explicit by converting phrases into axes/qualities, then matching a
// declared semantic policy.

const TERMS = Object.freeze({
  horizontal: Object.freeze({
    left: [/\bleft(?:ward)?\b/i],
    center: [/\bcent(?:er|re|ral)(?:ed)?\b/i, /\bmid(?:dle)?\b/i],
    right: [/\bright(?:ward)?\b/i],
  }),
  vertical: Object.freeze({
    upper: [/\bupper\b/i, /\btop\b/i, /\babove\b/i],
    middle: [/\bmid(?:dle)?\b/i, /\bcent(?:er|re|ral)\b/i],
    lower: [/\blower\b/i, /\bbottom\b/i, /\bbelow\b/i],
  }),
  quality: Object.freeze({
    open: [/\bopen\b/i, /\bclear\b/i, /\bempty\b/i, /\bunobstructed\b/i, /\bnegative[\s-]+space\b/i],
  }),
  surface: Object.freeze({
    sky: [/\bsky\b/i],
    space: [/\bspace\b/i, /\barea\b/i, /\bregion\b/i],
  }),
});

function analyzeRegion(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return {
    text,
    horizontal: concepts(text, TERMS.horizontal),
    vertical: concepts(text, TERMS.vertical),
    quality: concepts(text, TERMS.quality),
    surface: concepts(text, TERMS.surface),
  };
}

function matchesRegion(value, policy) {
  const region = analyzeRegion(value);
  const clauses = Array.isArray(policy?.anyOf) ? policy.anyOf : [policy ?? {}];
  return clauses.some((clause) => matchesClause(region, clause));
}

function matchesClause(region, clause = {}) {
  return categoryMatches(region.horizontal, clause.horizontal)
    && categoryMatches(region.vertical, clause.vertical)
    && categoryMatches(region.quality, clause.quality)
    && categoryMatches(region.surface, clause.surface)
    && categoryExcludes(region.horizontal, clause.notHorizontal)
    && categoryExcludes(region.vertical, clause.notVertical)
    && categoryExcludes(region.quality, clause.notQuality)
    && categoryExcludes(region.surface, clause.notSurface);
}

function concepts(text, vocabulary) {
  return Object.keys(vocabulary).filter((concept) =>
    vocabulary[concept].some((pattern) => pattern.test(text)));
}

function categoryMatches(actual, required) {
  if (!Array.isArray(required) || required.length === 0) return true;
  return required.some((concept) => actual.includes(concept));
}

function categoryExcludes(actual, forbidden) {
  if (!Array.isArray(forbidden) || forbidden.length === 0) return true;
  return !forbidden.some((concept) => actual.includes(concept));
}

module.exports = {
  analyzeRegion,
  matchesRegion,
};
