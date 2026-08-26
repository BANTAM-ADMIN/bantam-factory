import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Health Dashboard ───────────────────────────────────────────────
// Aggregates all diagnostic checks into a single report.
// Usage: node src/health-dashboard.js [--json]

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ── Check: Broken Imports ──
function checkBrokenImports() {
  const srcDir = join(__dirname);
  const broken = [];

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const rel = path.replace(srcDir + '/', '');

        // Check relative imports
        const relImports = [...content.matchAll(/from\s+['"]\.\/[^'"\s]+['"]/g)];
        for (const m of relImports) {
          const spec = m[0].match(/['"](.+)['"]/)[1];
          const base = dirname(path);
          const target = join(base, spec).replace(/\.js$/, '') + '.js';
          if (!existsSync(target)) {
            broken.push({ file: rel, import: spec, target: target.replace(srcDir + '/', '') });
          }
        }
      }
    }
  }

  scan(srcDir);
  return {
    name: 'Broken Imports',
    severity: broken.length > 0 ? 'P1' : 'OK',
    count: broken.length,
    details: broken.slice(0, 20),
    passed: broken.length === 0,
  };
}

// ── Check: Test Coverage ──
function checkTestCoverage() {
  const srcDir = join(__dirname);
  const testDir = join(__dirname, '..', 'test');

  const srcFiles = [];
  function listJs(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) listJs(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) srcFiles.push(e.name.replace('.js', ''));
    }
  }
  listJs(srcDir);

  const testFiles = readdirSync(testDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.js'))
    .map(e => e.name.replace('.test.js', ''));

  const covered = srcFiles.filter(f => testFiles.includes(f));
  const uncovered = srcFiles.filter(f => !testFiles.includes(f));
  const pct = srcFiles.length > 0 ? Math.round((covered.length / srcFiles.length) * 100) : 0;

  return {
    name: 'Test Coverage',
    severity: pct < 50 ? 'P1' : pct < 80 ? 'P2' : 'OK',
    count: uncovered.length,
    pct,
    covered: covered.length,
    total: srcFiles.length,
    topUncovered: uncovered.slice(0, 15),
    passed: pct >= 50,
  };
}

// ── Check: Large Files ──
function checkLargeFiles() {
  const srcDir = join(__dirname);
  const large = [];
  const threshold = 500;

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const lines = content.split('\n').length;
        if (lines > threshold) {
          large.push({ file: path.replace(srcDir + '/', ''), lines });
        }
      }
    }
  }
  scan(srcDir);
  large.sort((a, b) => b.lines - a.lines);

  return {
    name: 'Large Files',
    severity: large.length > 10 ? 'P2' : large.length > 5 ? 'P3' : 'OK',
    count: large.length,
    threshold,
    files: large,
    passed: large.length <= 4,
  };
}

// ── Check: Module Budget ──
function checkModuleBudget() {
  const srcDir = join(__dirname);
  const violations = [];
  const budgets = { lines: 500, exports: 20, deps: 15 };

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const lines = content.split('\n').length;
        const exports = (content.match(/export\s+(?:async\s+)?(?:function|class|const|let|var|\{)/g) || []).length;
        const deps = (content.match(/from\s+['"]/g) || []).length;
        const rel = path.replace(srcDir + '/', '');
        const issues = [];
        if (lines > budgets.lines) issues.push(`lines: ${lines}/${budgets.lines}`);
        if (exports > budgets.exports) issues.push(`exports: ${exports}/${budgets.exports}`);
        if (deps > budgets.deps) issues.push(`deps: ${deps}/${budgets.deps}`);
        if (issues.length > 0) violations.push({ file: rel, issues });
      }
    }
  }
  scan(srcDir);

  return {
    name: 'Module Budget',
    severity: violations.length > 20 ? 'P1' : violations.length > 10 ? 'P2' : 'OK',
    count: violations.length,
    budgets,
    violations: violations.slice(0, 30),
    passed: violations.length <= 10,
  };
}

// ── Check: Style Consistency ──
function checkStyleConsistency() {
  const srcDir = join(__dirname);
  const issues = [];

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const lines = content.split('\n');
        const rel = path.replace(srcDir + '/', '');

        // Check trailing whitespace
        const trailing = lines.filter(l => /\s+$/.test(l)).length;
        if (trailing > 0) issues.push({ file: rel, type: 'trailing-whitespace', count: trailing });

        // Check line length (>120)
        const long = lines.filter(l => l.length > 120).length;
        if (long > 0) issues.push({ file: rel, type: 'long-lines', count: long });

        // Check mixed quotes
        const single = (content.match(/'[^']*'/g) || []).length;
        const double = (content.match(/"[^"]*"/g) || []).length;
        if (single > 0 && double > 0) issues.push({ file: rel, type: 'mixed-quotes', single, double });
      }
    }
  }
  scan(srcDir);

  return {
    name: 'Style Consistency',
    severity: issues.length > 50 ? 'P2' : 'P3',
    count: issues.length,
    issues: issues.slice(0, 30),
    passed: issues.length <= 20,
  };
}

// ── Check: Self-Improvement Health ──
function checkImprovementHealth() {
  const canonical = join(__dirname, '..', '.bantam', 'self-improvements.json');
  const legacy = join(__dirname, '..', '.bantam-improvements.json');
  const improvements = loadJson(canonical) ?? loadJson(legacy);
  if (!improvements) return { name: 'Improvement History', severity: 'OK', count: 0, passed: true, note: 'No history file found' };

  const total = improvements.length;
  const passed = improvements.filter(i => i.passed).length;
  const failed = improvements.filter(i => !i.passed);
  const unique = new Set(improvements.map(i => i.id)).size;
  const areas = new Set(improvements.map(i => i.area)).size;

  return {
    name: 'Self-Improvement',
    severity: failed.length > 4 ? 'P1' : failed.length > 0 ? 'P2' : 'OK',
    count: total,
    passed,
    failed: failed.length,
    uniqueImprovements: unique,
    areasCovered: areas,
    recentFailures: failed.slice(-5).map(f => ({ id: f.id, area: f.area })),
    passed: failed.length <= 3,
  };
}

// ── Check: Dependency Graph ──
function checkDependencyGraph() {
  const srcDir = join(__dirname);
  const graph = {};
  const orphanModules = [];

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const rel = path.replace(srcDir + '/', '');
        const deps = [...content.matchAll(/from\s+['"]\.\/[^'"\s]+['"]/g)].map(m => m[0].match(/['"](.+)['"]/)[1]);
        graph[rel] = deps;
      }
    }
  }
  scan(srcDir);

  // Find modules nobody imports
  const allFiles = Object.keys(graph);
  for (const file of allFiles) {
    const baseName = file.replace('.js', '');
    const importedBy = allFiles.filter(k => {
      const deps = graph[k];
      return deps.some(d => d.endsWith(baseName) || d === baseName);
    });
    if (importedBy.length === 0 && !file.startsWith('logic/')) {
      orphanModules.push(file);
    }
  }

  return {
    name: 'Dependency Graph',
    severity: orphanModules.length > 10 ? 'P2' : 'OK',
    totalModules: allFiles.length,
    orphanCount: orphanModules.length,
    orphans: orphanModules.slice(0, 20),
    passed: orphanModules.length <= 10,
  };
}

// ── Check: Import Health ──
function checkImportHealth() {
  const srcDir = join(__dirname);
  const duplicates = [];

  function scan(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) scan(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const path = join(dir, e.name);
        const content = readFileSync(path, 'utf8');
        const rel = path.replace(srcDir + '/', '');

        // Check for duplicate imports from same module
        const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
        const seen = new Set();
        for (const imp of imports) {
          const base = imp.split('/').slice(-1)[0];
          if (seen.has(base)) duplicates.push({ file: rel, import: imp });
          seen.add(base);
        }
      }
    }
  }
  scan(srcDir);

  return {
    name: 'Import Health',
    severity: duplicates.length > 0 ? 'P2' : 'OK',
    count: duplicates.length,
    duplicates: duplicates.slice(0, 20),
    passed: duplicates.length === 0,
  };
}

// ── Main Dashboard ──
function runDashboard() {
  const checks = [
    checkBrokenImports(),
    checkTestCoverage(),
    checkLargeFiles(),
    checkModuleBudget(),
    checkStyleConsistency(),
    checkImprovementHealth(),
    checkDependencyGraph(),
    checkImportHealth(),
  ];

  const passed = checks.filter(r => r.passed).length;
  const failed = checks.filter(r => !r.passed).length;
  const p1 = checks.filter(r => r.severity === 'P1').length;

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalChecks: checks.length,
      passed,
      failed,
      p1Issues: p1,
      overall: p1 > 0 ? 'NEEDS ATTENTION' : failed > 0 ? 'MINOR ISSUES' : 'HEALTHY',
    },
    checks,
  };
}

function formatReport(report) {
  const { summary, checks } = report;
  let out = `\n📊 Health Dashboard — ${report.timestamp}\n`;
  out += `${'═'.repeat(60)}\n`;
  out += `Overall: ${summary.overall}  (${summary.passed}/${summary.totalChecks} checks passed)\n`;
  if (summary.p1Issues > 0) out += `⚠️  ${summary.p1Issues} P1 issue(s)\n`;
  out += `${'─'.repeat(60)}\n\n`;

  for (const c of checks) {
    const icon = c.passed ? '✅' : c.severity === 'P1' ? '🔴' : '🟡';
    out += `${icon} ${c.name} [${c.severity}]\n`;
    if (c.count !== undefined && c.count !== null) out += `   Count: ${c.count}\n`;
    if (c.pct !== undefined) out += `   Coverage: ${c.pct}% (${c.covered}/${c.total})\n`;
    if (c.passed !== undefined && c.failed !== undefined) out += `   Passed: ${c.passed}, Failed: ${c.failed}\n`;
    if (c.uniqueImprovements) out += `   Unique improvements: ${c.uniqueImprovements}, Areas: ${c.areasCovered}\n`;
    if (c.totalModules) out += `   Modules: ${c.totalModules}, Orphans: ${c.orphanCount}\n`;
    if (c.threshold) out += `   Threshold: ${c.threshold} lines\n`;
    if (c.topUncovered) out += `   Top uncovered: ${c.topUncovered.join(', ')}\n`;
    if (c.recentFailures && c.recentFailures.length > 0) {
      out += `   Recent failures: ${c.recentFailures.map(f => f.id).join(', ')}\n`;
    }
    if (c.files) {
      for (const f of c.files.slice(0, 5)) {
        out += `   ${f.file}: ${f.lines} lines\n`;
      }
    }
    if (c.details) {
      for (const d of c.details.slice(0, 5)) {
        out += `   ${d.file} → ${d.import}\n`;
      }
    }
    out += '\n';
  }

  return out;
}

// CLI entry point
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');

const report = runDashboard();
if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatReport(report));
}
