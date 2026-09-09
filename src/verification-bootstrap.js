import { splitShellWords } from './shell-lex.js';

// Scheduling only: an empty starter cannot run a test entrypoint that its
// author has not created yet. Never defer completion checks, an existing
// verifier, or checks after implementation work has begun.
export function pendingInitialVerifier({ command, provenance, readFile, exists, implementationStarted = false }) {
  if (implementationStarted || provenance?.complete !== true) return null;
  let script = command;
  if (/^npm (?:test|run test)$/.test(String(command))) {
    let pkg;
    try { pkg = JSON.parse(readFile('package.json')); } catch { return null; }
    // A lifecycle hook may generate the entrypoint. Let npm execute normally.
    if (pkg.scripts?.pretest || pkg.scripts?.posttest) return null;
    script = pkg.scripts?.test;
  }
  // Recognize one literal Node file, without expansion, flags or shell control.
  // Unknown commands retain their normal scheduling.
  if (typeof script !== 'string' || /[\n\r$`;&|<>\\]/.test(script)) return null;
  const words = splitShellWords(script);
  if (words.length !== 2 || words[0] !== 'node') return null;
  const file = words[1].replace(/^\.\//, '');
  if (!/^[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?js)$/.test(file)
      || file.split('/').some(part => part === '..')
      || !Array.isArray(provenance.initialPaths) || provenance.initialPaths.includes(file)
      || !Array.isArray(provenance.excludedPaths)
      || provenance.excludedPaths.some(p => file === p || file.startsWith(p + '/'))) return null;
  try { return exists(file) ? null : file; } catch { return null; }
}
