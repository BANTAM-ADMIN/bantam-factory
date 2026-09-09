import { isRunnerConfigPath } from './scope-guard.js';

// Operator-declared OUTPUT directories, never inferred from worker prose or
// from a report-looking filename. Inputs/fixtures must not be declared here.
export function verificationOutputDirectories(value = '') {
  const entries = typeof value === 'string' ? (value.trim() ? value.split(',') : []) : value;
  if (!Array.isArray(entries) || entries.length > 32) throw new TypeError('verification output directories must be a list of at most 32 relative directories');
  return [...new Set(entries.map(entry => {
    if (typeof entry !== 'string') throw new TypeError('verification output directory must be a string');
    const directory = entry.trim().replace(/\/$/, '');
    if (!directory || directory.startsWith('/') || /[\\\x00-\x1f:*?]/.test(directory)
        || directory.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new TypeError(`invalid verification output directory: ${JSON.stringify(entry)}`);
    }
    return directory;
  }))];
}

export function isDeclaredVerificationOutput(relative, directories) {
  if (!directories.some(directory => relative.startsWith(directory + '/'))) return false;
  // Even inside an output directory, executable checks and runner/package
  // configuration remain verification inputs. Only report/media formats qualify.
  if (isRunnerConfigPath(relative)
      || /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|[^/]+\.config\.json)$/i.test(relative)) return false;
  return /\.(?:json|jsonl|ndjson|png|jpe?g|webp|gif|txt|log|xml|csv|tsv|html?|svg|lcov|info)$/i.test(relative);
}
