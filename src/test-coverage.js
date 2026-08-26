import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve('src');
const TEST_DIR = path.resolve('test');

/**
 * Return { covered, uncovered, total } for a given src/test directory pair.
 * A source file is "covered" when a test file exists with a matching base name
 * (e.g. src/foo.js → test/foo.test.js or test/foo.js).
 */
function scanCoverage(srcDir = SRC_DIR, testDir = TEST_DIR) {
  const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js') && !f.includes('logic/'));
  const testFiles = new Set(fs.readdirSync(testDir).filter(f => f.endsWith('.js')));

  const covered = [];
  const uncovered = [];

  for (const src of srcFiles) {
    const base = path.basename(src, '.js');
    const testMatch = testFiles.has(`${base}.test.js`) || testFiles.has(`${base}.js`);
    if (testMatch) {
      covered.push(src);
    } else {
      uncovered.push(src);
    }
  }

  return {
    covered,
    uncovered,
    total: srcFiles.length,
    ratio: covered.length / srcFiles.length,
  };
}

/**
 * Return a human-readable report string.
 */
function report(coverage) {
  const lines = [
    `Test Coverage: ${Math.round(coverage.ratio * 100)}% (${coverage.covered.length}/${coverage.total})`,
  ];
  if (coverage.uncovered.length) {
    lines.push(`\nUncovered source files (${coverage.uncovered.length}):`);
    for (const f of coverage.uncovered) {
      lines.push(`  - ${f}`);
    }
  }
  return lines.join('\n');
}

/**
 * Return an array of improvement suggestions for uncovered files.
 */
function suggestions(coverage) {
  return coverage.uncovered.map(f => ({
    file: f,
    suggestion: `Create test/${path.basename(f, '.js')}.test.js`,
    priority: 'medium',
  }));
}

export { scanCoverage, report, suggestions };
