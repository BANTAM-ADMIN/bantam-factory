// Report-shape gate (candidate, off by default — BANTAM_REPORT_GUARD=1 to enable).
//
// The done summary is the only thing most users read, and small models spend it
// on two diseases: the trailing promise ("I'll also update the docs") — which by
// the harness's own rules means the run was NOT done — and the hedged success
// ("should work now"), a claim the model did not observe. Both are named
// precisely and bounced exactly once; like every gate, this one is bounded and
// can never trap a run.
//
// Distilled from the Fable 5 reporting rules (FABLESKILLS kit): lead with the
// observed outcome, close with evidence, never promise future work in a summary.

const PROMISE_RE = /\b(?:I(?:'|’)?ll\s|I will\s|next step(?:s)? (?:is|are|would)|I can (?:also|then)\b|let me know\b|feel free to\b|remaining work\b|still need(?:s)? to\b|TODO:)/i;
const HEDGE_RE = /\b(?:should (?:now )?(?:work|pass|be (?:fixed|working|correct))|ought to (?:now )?work|likely (?:works|fixed|passes)|probably (?:works|fixed|passes)|I (?:think|believe) (?:it|this) (?:works|passes|is fixed))\b/i;

/**
 * Objection to a done summary whose shape undermines the verified-done contract.
 * Mirrors the done-guard objection signature: returns a steering message or null.
 * @param {string|undefined} summary  The summary on the accepted done action.
 * @param {number} alreadyRejected    Prior report_shape rejections this run.
 */
export function reportShapeObjection(summary, alreadyRejected = 0, { maxRejections = 1 } = {}) {
  if (alreadyRejected >= maxRejections) return null;
  const text = String(summary ?? "").trim();
  if (!text) return null;

  const promise = text.match(PROMISE_RE);
  const hedge = text.match(HEDGE_RE);
  if (!promise && !hedge) return null;

  // Quote a short window from the summary itself so the model sees exactly
  // which sentence to delete, not just the trigger token.
  const m = promise ?? hedge;
  const quote = text.slice(m.index, m.index + 60).split("\n")[0].trim();
  const disease = promise
    ? `a promise of future work ("${quote}…")`
    : `an unverified-success hedge ("${quote}")`;
  const cure = promise
    ? `If that step matters, DO it now and re-verify before finishing; if it genuinely needs the user, name the single decision in one short clause instead of promising work.`
    : `Run the command that proves the claim and report what it actually printed — or state plainly that the change is unverified.`;
  return `Your summary contains ${disease}. The summary is the product: lead with the outcome you OBSERVED (e.g. the exact test summary line), then what changed, then the evidence. ${cure} Then emit "done" again with a summary of what IS, not what you will do or what should work.`;
}
