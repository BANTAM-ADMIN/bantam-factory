// A checked filename in the worker's root progress record is a concrete claim
// we can check without a model. This is feedback only, never completion proof.
export function progressRecordFeedback(recordPath, text, pathExists) {
  if (!/^(?:\.\/)?(?:PROGRESS|TODO)\.md$/i.test(recordPath ?? '')
      || typeof text !== 'string' || text.length > 65536) return null;
  const missing = [], seen = new Set();
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^ {0,3}[-*+]\s+\[[xX]\]\s+`?([\w./-]+\.[a-zA-Z]{1,8})(?:`|\s|$)/);
    const candidate = match?.[1];
    if (!candidate || candidate.length > 140 || candidate.startsWith('/')
        || candidate.split('/').some(p => p === '..' || p === '') || seen.has(candidate)) continue;
    if (seen.size >= 64) break;
    seen.add(candidate);
    // Unknown/unreadable/out-of-scope is not evidence that a file is missing.
    if (pathExists(candidate) !== false) continue;
    missing.push(candidate);
    if (missing.length === 3) break;
  }
  if (!missing.length) return null;
  return {recordPath, missing,
    text: `[progress-record] ${recordPath} checks off missing workspace files: ${missing.map(p => JSON.stringify(p)).join(', ')}. Reconcile these entries with the current files; record unimplemented work as remaining. A progress checkbox supplies no verification credit.`};
}
