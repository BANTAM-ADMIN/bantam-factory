// Cross-file pattern detection: find repeated structures across modules
import fs from 'node:fs';
import path from 'node:path';

export class CrossFilePatterns {
  constructor() { this.patterns = []; this.files = []; }

  /** Recursively scan a directory for .js files and run all detectors. */
  scan(dir, ext = '.js') {
    this.files = this._collect(dir, ext);
    this.patterns = [];
    const contents = this.files.map(f => {
      const fullPath = path.join(dir, f);
      let text;
      try { text = fs.readFileSync(fullPath, 'utf8'); } catch { text = ''; }
      return { file: f, text, lines: text.split('\n') };
    });
    this.detectImports(contents);
    this.detectClassPatterns(contents);
    this.detectDuplicateLogic(contents);
    this.detectMissingExports(contents);
    this.detectInconsistentErrorHandling(contents);
    this.detectUnusedImports(contents);
    this.detectLongFunctions(contents);
    return this.patterns;
  }

  _collect(dir, ext, result = [], root = dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this._collect(full, ext, result, root);
      else if (entry.name.endsWith(ext)) result.push(path.relative(root, full));
    }
    return result.sort();
  }

  detectImports(files) {
    const importMap = new Map();
    for (const f of files) {
      const imports = f.lines.filter(l => l.startsWith('import ')).map(l => l.trim());
      for (const imp of imports) importMap.set(imp, (importMap.get(imp) || 0) + 1);
    }
    const repeated = [...importMap.entries()].filter(([_, c]) => c > 2);
    if (repeated.length) this.patterns.push({ type: 'repeated-imports', count: repeated.length, examples: repeated.map(([k]) => k) });
  }

  detectClassPatterns(files) {
    const classCount = files.filter(f => f.lines.some(l => l.includes('class ') || l.includes('export function'))).length;
    if (classCount > files.length * 0.7) this.patterns.push({ type: 'class-heavy', ratio: +(classCount / files.length).toFixed(2) });
  }

  /** Find near-duplicate function bodies (same logic copy-pasted). */
  detectDuplicateLogic(files) {
    const bodies = [];
    for (const f of files) {
      const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>/g;
      let m;
      const text = f.text;
      while ((m = fnRegex.exec(text)) !== null) {
        const name = m[1] || m[2];
        const start = m.index;
        // Grab ~20 lines after function declaration as "body fingerprint"
        const after = text.slice(start, start + 400);
        bodies.push({ file: f.file, name, fingerprint: after.trim().slice(0, 200) });
      }
    }
    const dupes = [];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        if (bodies[i].file === bodies[j].file) continue;
        const a = bodies[i].fingerprint, b = bodies[j].fingerprint;
        if (a.length < 30 || b.length < 30) continue;
        // Simple Jaccard-like overlap on 4-char ngrams
        const ngrams = (s) => new Set(s.match(/.{1,4}/g) || []);
        const sa = ngrams(a), sb = ngrams(b);
        const inter = [...sa].filter(x => sb.has(x)).length;
        const union = new Set([...sa, ...sb]).size;
        const sim = union > 0 ? inter / union : 0;
        if (sim > 0.7) dupes.push({ files: [bodies[i].file, bodies[j].file], functions: [bodies[i].name, bodies[j].name], similarity: +sim.toFixed(2) });
      }
    }
    if (dupes.length) this.patterns.push({ type: 'duplicate-logic', count: dupes.length, examples: dupes.slice(0, 5) });
  }

  /** Find files that define functions/classes but don't export them. */
  detectMissingExports(files) {
    const issues = [];
    for (const f of files) {
      const defs = f.lines.filter(l => /(?:^|\s)(const|let|var|function|class)\s+(\w+)/.test(l) && !l.startsWith('import'));
      const exports = f.lines.filter(l => l.startsWith('export'));
      const defCount = defs.length;
      const expCount = exports.length;
      if (defCount > 2 && expCount === 0) {
        issues.push({ file: f.file, defs: defCount, exports: 0 });
      }
    }
    if (issues.length) this.patterns.push({ type: 'missing-exports', count: issues.length, examples: issues.slice(0, 5) });
  }

  /** Detect inconsistent error handling: some functions try/catch, siblings don't. */
  detectInconsistentErrorHandling(files) {
    const byFile = new Map();
    for (const f of files) {
      const hasTry = f.lines.filter(l => l.includes('try {') || l.includes('try{')).length;
      const hasThrow = f.lines.filter(l => l.includes('throw ') || l.includes('throw\n')).length;
      const hasReturn = f.lines.filter(l => l.includes('return')).length;
      if (hasTry > 0 || hasThrow > 0) {
        byFile.set(f.file, { try: hasTry, throw: hasThrow, return: hasReturn });
      }
    }
    if (byFile.size > 5) {
      const vals = [...byFile.values()];
      const avgTry = vals.reduce((s, v) => s + v.try, 0) / vals.length;
      const inconsistent = vals.filter(v => Math.abs(v.try - avgTry) > avgTry * 0.5).length;
      if (inconsistent > 2) {
        this.patterns.push({ type: 'inconsistent-error-handling', count: inconsistent, avgTry: +avgTry.toFixed(1) });
      }
    }
  }

  /** Find imports that are declared but never used in the file body. */
  detectUnusedImports(files) {
    const unused = [];
    for (const f of files) {
      const importLines = f.lines.filter(l => l.startsWith('import '));
      const body = f.lines.filter(l => !l.startsWith('import ')).join('\n');
      for (const line of importLines) {
        // Extract imported names
        const named = line.match(/\{([^}]+)\}/);
        if (named) {
          for (const name of named[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()?.trim())) {
            const escaped = name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (name && !new RegExp(`\\b${escaped}\\b`).test(body)) {
              unused.push({ file: f.file, import: name });
            }
          }
        }
      }
    }
    if (unused.length) this.patterns.push({ type: 'unused-imports', count: unused.length, examples: unused.slice(0, 5) });
  }

  /** Detect functions longer than 40 lines (potential refactoring target). */
  detectLongFunctions(files) {
    const longFns = [];
    for (const f of files) {
      let depth = 0, startLine = 0, fnName = '';
      for (let i = 0; i < f.lines.length; i++) {
        const line = f.lines[i];
        const m = line.match(/(?:function|class)\s+(\w+)/);
        if (m && depth === 0) { fnName = m[1]; startLine = i; }
        depth += (line.match(/{/g) || []).length;
        depth -= (line.match(/}/g) || []).length;
        if (depth <= 0 && fnName && i - startLine > 40) {
          longFns.push({ file: f.file, function: fnName, lines: i - startLine + 1 });
          fnName = '';
        }
      }
    }
    if (longFns.length) this.patterns.push({ type: 'long-functions', count: longFns.length, examples: longFns.slice(0, 5) });
  }

  /** Return a summary of all detected patterns. */
  summary() {
    return {
      totalPatterns: this.patterns.length,
      byType: Object.fromEntries(this.patterns.map(p => [p.type, p.count ?? 1])),
      files: this.files.length,
    };
  }
}
