import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname);
const TEST_DIR = resolve(__dirname, '..', 'test');

/**
 * Recursively list .js files in a directory.
 */
function listJs(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJs(full).map(f => resolve(dir, full) + '/' + f));
    } else if (/\.js$/.test(entry.name)) {
      result.push(entry.name);
    }
  }
  return result;
}

/**
 * Extract exported symbols from file content.
 * Matches: export const/function/class, module.exports = { ... }, exports.X =
 */
function extractSymbols(content) {
  const symbols = [];
  // ES module exports
  for (const m of content.matchAll(/export\s+(?:const|function|class|let|var)\s+(\w+)/g)) {
    symbols.push(m[1]);
  }
  // CommonJS exports
  for (const m of content.matchAll(/(?:module\.)?exports\.(\w+)\s*=/g)) {
    symbols.push(m[1]);
  }
  // Named exports in module.exports = { a, b, c }
  const objMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (objMatch) {
    for (const m of objMatch[1].matchAll(/(\w+)/g)) {
      symbols.push(m[1]);
    }
  }
  return [...new Set(symbols)];
}

/**
 * Extract import dependencies from file content.
 */
function extractDeps(content) {
  const deps = [];
  // ES imports
  for (const m of content.matchAll(/from\s+["'](.+?)["']/g)) {
    deps.push(m[1]);
  }
  // require() calls
  for (const m of content.matchAll(/require\(["'](.+?)["']\)/g)) {
    deps.push(m[1]);
  }
  return [...new Set(deps)];
}

/**
 * Build a full codebase index.
 * Returns { files, symbols, deps, stats }.
 */
function buildIndex(srcDir = SRC_DIR) {
  const files = listJs(srcDir);
  const symbols = {};
  const deps = {};
  const lineCounts = {};

  for (const f of files) {
    const full = join(srcDir, f);
    try {
      const content = readFileSync(full, 'utf8');
      const lines = content.split('\n');
      symbols[f] = extractSymbols(content);
      deps[f] = extractDeps(content);
      lineCounts[f] = lines.length;
    } catch {
      /* skip unreadable files */
    }
  }

  const totalLines = Object.values(lineCounts).reduce((s, n) => s + n, 0);
  const totalSymbols = Object.values(symbols).reduce((s, arr) => s + arr.length, 0);

  return {
    files,
    symbols,
    deps,
    lineCounts,
    stats: {
      fileCount: files.length,
      totalLines,
      totalSymbols,
      avgLines: files.length ? Math.round(totalLines / files.length) : 0,
      ts: Date.now(),
    },
  };
}

/**
 * Find which files define a given symbol.
 */
function findSymbol(index, symbolName) {
  const results = [];
  for (const [file, syms] of Object.entries(index.symbols)) {
    if (syms.includes(symbolName)) {
      results.push({ file, symbol: symbolName });
    }
  }
  return results;
}

/**
 * Find which files depend on a given module path.
 */
function findDependents(index, modulePath) {
  const results = [];
  for (const [file, fileDeps] of Object.entries(index.deps)) {
    for (const dep of fileDeps) {
      if (dep.includes(modulePath) || dep.endsWith(modulePath)) {
        results.push({ file, dependency: dep });
      }
    }
  }
  return results;
}

/**
 * Find files with no dependents (leaf modules).
 */
function findLeaves(index) {
  const depSet = new Set();
  for (const deps of Object.values(index.deps)) {
    for (const d of deps) {
      // Normalize: strip relative prefixes
      const base = d.replace(/^\.\.?\//, '').replace(/\.js$/, '');
      depSet.add(base);
    }
  }
  return index.files.filter(f => {
    const base = f.replace(/\.js$/, '');
    return !depSet.has(base);
  });
}

/**
 * Return a summary report string.
 */
function report(index) {
  const lines = [
    `Codebase Index: ${index.stats.fileCount} files, ${index.stats.totalLines} lines, ${index.stats.totalSymbols} symbols`,
    `Average file size: ${index.stats.avgLines} lines`,
  ];
  return lines.join('\n');
}

export {
  buildIndex,
  findSymbol,
  findDependents,
  findLeaves,
  report,
  listJs,
  extractSymbols,
  extractDeps,
};
