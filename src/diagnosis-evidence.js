import { editPaths, turnEditApplied } from './edit-actions.js';
import { diagnosedImplementationPath, parseTestFailures } from './logic/test-focus.js';

/**
 * A repeated failure after a relevant edit is not proof that a proposed FIX
 * landed, or that its diagnosis was false. Caller supplies a failure parsed
 * from the current actual failed execution, never from diagnostic prose.
 */
export function priorDiagnosisFollowup(turns, failure) {
  if (!failure?.name || !Array.isArray(turns)) return null;
  const tag = `[diagnosis of "${failure.name}"]`;
  const followupTag = `[diagnosis-followup "${failure.name}"]`;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const observation = String(turn?.observation ?? '');
    const start = observation.indexOf(tag);
    if (start < 0) continue;
    const later = turns.slice(i + 1);
    if (later.some(entry => String(entry?.observation ?? '').includes(followupTag))) return null;
    const prior = priorFailures(turn).filter(entry => entry.name === failure.name);
    if (prior.length !== 1 || signature(prior[0]) !== signature(failure)) return null;
    // Empty/omitted assertion details do not establish a repeated failure.
    if (!failure.message && failure.expected == null && failure.actual == null && !failure.diff?.length) return null;
    const remainder = observation.slice(start + tag.length).trimStart();
    const nextTag = remainder.search(/\n\s*\[[^\]\n]+\]/);
    const diagnosis = nextTag < 0 ? remainder : remainder.slice(0, nextTag);
    const changed = [...new Set(later.flatMap(appliedPaths))];
    const file = diagnosedImplementationPath(diagnosis, changed);
    if (!file) return null;
    return `${followupTag} A subsequent edit to ${file} did not resolve this reported failure. `
      + 'This does not prove the suggested change was applied or that the diagnosis was false. '
      + 'Inspect the actual diff and expand the test helpers/wrappers from the real entry path before choosing the next change.';
  }
  return null;
}

function priorFailures(turn) {
  const typed = Object.hasOwn(turn ?? {}, 'verificationEvidence');
  const evidence = turn?.verificationEvidence;
  if (typed && evidence?.status !== 'fail') return [];
  if (!typed && (turn?.action ?? turn?.parsedAction)?.a !== 'shell') return [];
  if (typed && Array.isArray(evidence.failingTests) && evidence.failingTests.length === 0) return [];
  // Receipts omit bulky rawOutput. A stored raw observation can still supply
  // actual assertion details, but no controller annotation may supply them.
  let output = String(evidence?.rawOutput ?? turn?.rawObservation ?? turn?.observation ?? '');
  const annotation = output.search(/(?:^|\n)\s*\[(?:diagnosis|fix-tests|focused-test|test-focus|pinned-test)[^\]\n]*\]/);
  if (annotation >= 0) output = output.slice(0, annotation);
  const failures = parseTestFailures(output);
  return typed && Array.isArray(evidence.failingTests)
    ? failures.filter(failure => evidence.failingTests.includes(failure.name)) : failures;
}

function appliedPaths(turn) {
  const action = turn?.action ?? turn?.parsedAction;
  if (action?.a === 'shell') return Array.isArray(turn.shellChangedPaths) ? turn.shellChangedPaths : [];
  if (!turnEditApplied(turn)) return [];
  // Legacy edits without a receipt need an explicit successful executor line.
  if (typeof turn?.editApplied !== 'boolean' && !/^(?:wrote|replaced|patched|deleted|moved|edited)\b/i.test(String(turn?.observation ?? ''))) return [];
  return editPaths(action);
}

function signature(failure) {
  return JSON.stringify([failure?.name ?? null, failure?.file ?? null,
    failure?.message ?? null, failure?.expected ?? null, failure?.actual ?? null,
    Array.isArray(failure?.diff) ? failure.diff : []]);
}
