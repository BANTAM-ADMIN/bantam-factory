// Recognize three-way textual inference from its labels and premise/hypothesis.
// Optional context clarifies semantics without supplying a particular answer.
export function isTextualInference(question) {
  if (question?.type !== 'choice' || typeof question.instructions !== 'string') return false;
  const labels = Object.values(question.criteria ?? {});
  if (labels.length !== 3 || labels.some(label => typeof label !== 'string')) return false;
  const names = labels.map(label => label.trim().toLowerCase());
  if (new Set(names).size !== 3 || !['entailment', 'neutral', 'contradiction'].every(label => names.includes(label))) return false;
  return /(?:^|\n)Premise:[ \t]*\S/.test(question.instructions) && /(?:^|\n)Hypothesis:[ \t]*\S/.test(question.instructions);
}

export function inferenceContext(question) {
  if (!isTextualInference(question)) return null;
  return 'TEXTUAL INFERENCE CONTEXT:\nEvaluate the entire hypothesis against the supplied premise. Entailment means the premise supports the hypothesis; contradiction means the premise supports its negation; neutral means neither is established. Missing information is not a contradiction. A list of examples or named participants is not necessarily exhaustive. Track who each relation refers to, its direction, negation, and any stated requirements. Ordinary word meanings are allowed, but do not invent unstated facts or use outside knowledge to fill gaps. Distinguish what is explicitly required or ruled out from what is merely plausible. Select the option with the corresponding meaning.';
}
