import { splitShellWords } from './shell-lex.js';

// Scheduling only: an empty starter cannot run a test entrypoint that its
// author has not created yet. Source modules do not make that check runnable.
// Never defer completion checks or a verifier that existed and was removed.
export function pendingInitialVerifier({ command, provenance, readFile, exists, observedPaths = new Set() }) {
  if (provenance?.complete !== true) return null;
  let script = command;
  if (/^npm (?:test|run test)$/.test(String(command))) {
    // A changed script must not turn a runnable project check into a deferred
    // missing one. Only the unchanged starter command gets this scheduling aid.
    if (observedPaths.has('package.json')) return null;
    let pkg;
    try { pkg = JSON.parse(readFile('package.json')); } catch { return null; }
    // A lifecycle hook may generate the entrypoint. Let npm execute normally.
    if (pkg.scripts?.pretest || pkg.scripts?.posttest) return null;
    script = pkg.scripts?.test;
  }
  // Recognize one literal Node or Python file, without expansion, flags or shell control.
  // Unknown commands retain their normal scheduling.
  if (typeof script !== 'string' || /[\n\r$`;&|<>\\]/.test(script)) return null;
  const words = splitShellWords(script);
  if (words.length !== 2 || !['node', 'python', 'python3'].includes(words[0])) return null;
  const file = words[1].replace(/^\.\//, '');
  const extension = words[0] === 'node' ? /\.[cm]?js$/ : /\.py$/;
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || !extension.test(file)
      || file.split('/').some(part => part === '..')
      || observedPaths.has(file)
      || !Array.isArray(provenance.initialPaths) || provenance.initialPaths.includes(file)
      || !Array.isArray(provenance.excludedPaths)
      || provenance.excludedPaths.some(p => file === p || file.startsWith(p + '/'))) return null;
  try { return exists(file) ? null : file; } catch { return null; }
}
