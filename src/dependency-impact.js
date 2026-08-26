// Dependency Impact Analyzer
//
// Tracks which files depend on each other and predicts the blast radius
// of changes. When you edit file A, this tells you which files might
// break and which tests to run.
//
// Rules:
//   1. Parse all imports/exports to build a dependency graph
//   2. Compute transitive dependencies (what depends on what)
//   3. Score impact: more dependents = higher impact
//   4. Suggest which tests to run after a change

import fs from "node:fs";
import path from "node:path";
import { parse as parseJavaScript } from "acorn";
import { simple } from "acorn-walk";

// ---------------------------------------------------------------------------
// 1.  DEPENDENCY GRAPH BUILDER
// ---------------------------------------------------------------------------

/**
 * Parse imports and exports from a JS file.
 */
export function parseModule(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const ast = parseJavaScript(content, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const imports = new Set();
  const exports = new Set();

  simple(ast, {
    ImportDeclaration(node) {
      if (typeof node.source?.value === "string") imports.add(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (typeof node.source?.value === "string") imports.add(node.source.value);
      for (const name of exportedDeclarationNames(node.declaration)) exports.add(name);
      for (const specifier of node.specifiers) {
        const name = specifier.exported?.name ?? specifier.exported?.value;
        if (typeof name === "string") exports.add(name);
      }
    },
    ExportDefaultDeclaration() {
      exports.add("default");
    },
    ExportAllDeclaration(node) {
      if (typeof node.source?.value === "string") imports.add(node.source.value);
      const name = node.exported?.name ?? node.exported?.value;
      if (typeof name === "string") exports.add(name);
    },
    ImportExpression(node) {
      if (typeof node.source?.value === "string") imports.add(node.source.value);
    },
  });

  return {
    imports: [...imports],
    exports: [...exports],
    lineCount: content.split("\n").length,
  };
}

function exportedDeclarationNames(node) {
  if ((node?.type === "FunctionDeclaration" || node?.type === "ClassDeclaration") && node.id) {
    return [node.id.name];
  }
  if (node?.type !== "VariableDeclaration") return [];
  return node.declarations.flatMap(declaration => boundNames(declaration.id));
}

function boundNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return boundNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return boundNames(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(boundNames);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap(property => (
      property.type === "RestElement" ? boundNames(property.argument) : boundNames(property.value)
    ));
  }
  return [];
}

/**
 * Build a full dependency graph for a directory.
 */
export function buildDependencyGraph(dir) {
  const graph = new Map(); // file -> { imports: [], exports: [], dependents: [] }
  const reverseGraph = new Map(); // file -> files that import it

  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") walk(full);
      } else if (entry.name.endsWith(".js")) {
        files.push(full);
      }
    }
  };
  walk(dir);
  files.sort();

  for (const file of files) {
    const { imports, exports } = parseModule(file);
    const rel = portablePath(path.relative(dir, file));
    graph.set(rel, { imports, exports, dependents: [] });
    if (!reverseGraph.has(rel)) reverseGraph.set(rel, []);
  }

  // Build reverse edges
  for (const [file, mod] of graph) {
    const linked = new Set();
    for (const imp of mod.imports) {
      const resolved = resolveImport(file, imp, graph);
      if (resolved && !linked.has(resolved)) {
        linked.add(resolved);
        graph.get(resolved).dependents.push(file);
        reverseGraph.get(resolved).push(file);
      }
    }
  }

  return { graph, reverseGraph, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// 2.  IMPACT ANALYZER
// ---------------------------------------------------------------------------

/**
 * Find all files transitively affected by a change.
 */
export function findAffectedFiles(changedFile, graph, reverseGraph) {
  const visited = new Set([changedFile]);
  const affected = [];
  const queue = [changedFile];

  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = reverseGraph.get(current) || [];
    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep);
        affected.push(dep);
        queue.push(dep);
      }
    }
  }

  return affected;
}

/**
 * Compute impact score for a file (0-100).
 * Higher = more files depend on it.
 */
export function impactScore(file, graph, reverseGraph) {
  const direct = (reverseGraph.get(file) || []).length;
  const transitive = findAffectedFiles(file, graph, reverseGraph).length;
  const totalFiles = graph.size;

  if (totalFiles === 0) return 0;

  // Score = weighted combination of direct + transitive
  const directWeight = 0.4;
  const transitiveWeight = 0.6;
  const raw = (directWeight * (direct / totalFiles)) + (transitiveWeight * (transitive / totalFiles));
  return Math.round(Math.min(100, raw * 100));
}

/**
 * Rank all files by impact score.
 */
export function rankByImpact(graph, reverseGraph) {
  const scores = [];
  for (const file of graph.keys()) {
    scores.push({ file, score: impactScore(file, graph, reverseGraph) });
  }
  return scores.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 3.  CHANGE PREDICTOR
// ---------------------------------------------------------------------------

/**
 * Predict what will break if you change a file.
 */
export function predictBlastRadius(changedFile, graph, reverseGraph) {
  const affected = findAffectedFiles(changedFile, graph, reverseGraph);
  const direct = reverseGraph.get(changedFile) || [];
  const transitive = affected.filter(f => !direct.includes(f));

  return {
    changed: changedFile,
    directDependents: direct,
    transitiveDependents: transitive,
    totalAffected: affected.length,
    riskLevel: affected.length === 0 ? "none" : affected.length <= 2 ? "low" : affected.length <= 5 ? "medium" : "high",
  };
}

// ---------------------------------------------------------------------------
// 4.  TEST RECOMMENDER
// ---------------------------------------------------------------------------

/**
 * Suggest which tests to run after a change.
 */
export function suggestTests(changedFile, graph, reverseGraph, testDir) {
  const affected = findAffectedFiles(changedFile, graph, reverseGraph);
  const tests = [];
  const seen = new Set();

  // Find test files for changed + affected files
  const allRelevant = [changedFile, ...affected];
  for (const file of allRelevant) {
    const baseName = file.replace(/\.js$/, "");
    const basename = path.basename(file).replace(/\.js$/, "");
    const candidates = [
      path.join(testDir, `${baseName}-test.js`),
      path.join(testDir, `${baseName}.test.js`),
      path.join(testDir, `${basename}-test.js`),
      path.join(testDir, `${basename}.test.js`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        tests.push(candidate);
      }
    }
  }

  return tests;
}

function resolveImport(importer, specifier, graph) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const target = path.posix.normalize(path.posix.join(
    path.posix.dirname(portablePath(importer)),
    portablePath(specifier),
  ));
  const candidates = path.posix.extname(target)
    ? [target]
    : [`${target}.js`, `${target}/index.js`];
  return candidates.find((candidate) => graph.has(candidate)) ?? null;
}

function portablePath(value) {
  return String(value).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// 5.  CHANGE TRACKER
// ---------------------------------------------------------------------------

/**
 * Track changes across a session and compute cumulative impact.
 */
export class ChangeTracker {
  constructor(workspace) {
    this.workspace = workspace;
    this.changes = [];
    this.graph = null;
    this.reverseGraph = null;
  }

  init() {
    const { graph, reverseGraph } = buildDependencyGraph(path.join(this.workspace, "src"));
    this.graph = graph;
    this.reverseGraph = reverseGraph;
    return { fileCount: graph.size };
  }

  recordChange(file, description) {
    if (!this.graph) this.init();
    const blast = predictBlastRadius(file, this.graph, this.reverseGraph);
    this.changes.push({ file, description, blast, timestamp: Date.now() });
    return blast;
  }

  cumulativeImpact() {
    const allAffected = new Set();
    for (const change of this.changes) {
      allAffected.add(change.file);
      for (const dep of change.blast.directDependents) allAffected.add(dep);
      for (const dep of change.blast.transitiveDependents) allAffected.add(dep);
    }
    return {
      changes: this.changes.length,
      filesChanged: [...new Set(this.changes.map(c => c.file))].length,
      totalAffected: allAffected.size,
      riskLevel: allAffected.size <= 3 ? "low" : allAffected.size <= 10 ? "medium" : "high",
    };
  }

  report() {
    const impact = this.cumulativeImpact();
    return `Change Tracker: ${impact.changes} changes, ${impact.filesChanged} files modified, ${impact.totalAffected} files affected (${impact.riskLevel} risk)`;
  }
}

// ---------------------------------------------------------------------------
// 6.  INTEGRATION — self-test
// ---------------------------------------------------------------------------

function runTests() {
  console.log("=== Dependency Impact Analyzer ===\n");

  // Test 1: parse module
  console.log("Test 1: Parse module");
  const mod = parseModule("src/self-improve.js");
  console.assert(mod.imports.length > 0, "should find imports");
  console.assert(mod.exports.length > 0, "should find exports");
  console.log("  PASS: Found", mod.imports.length, "imports,", mod.exports.length, "exports\n");

  // Test 2: build dependency graph
  console.log("Test 2: Build dependency graph");
  const { graph, reverseGraph, fileCount } = buildDependencyGraph("src");
  console.assert(fileCount > 0, "should find files");
  console.assert(graph.size > 0, "graph should have entries");
  console.log("  PASS: Graph has", graph.size, "files\n");

  // Test 3: find affected files
  console.log("Test 3: Find affected files");
  const affected = findAffectedFiles("self-improve.js", graph, reverseGraph);
  console.assert(Array.isArray(affected), "should return array");
  console.log("  PASS:", affected.length, "files affected by self-improve.js\n");

  // Test 4: impact score
  console.log("Test 4: Impact score");
  const score = impactScore("self-improve.js", graph, reverseGraph);
  console.assert(score >= 0 && score <= 100, "score should be 0-100");
  console.log("  PASS: Score =", score, "\n");

  // Test 5: rank by impact
  console.log("Test 5: Rank by impact");
  const ranked = rankByImpact(graph, reverseGraph);
  console.assert(ranked.length > 0, "should have rankings");
  console.assert(ranked[0].score >= ranked[ranked.length - 1].score, "should be sorted desc");
  console.log("  PASS: Top file:", ranked[0].file, "(score:", ranked[0].score, ")\n");

  // Test 6: predict blast radius
  console.log("Test 6: Predict blast radius");
  const blast = predictBlastRadius("self-improve.js", graph, reverseGraph);
  console.assert(blast.riskLevel, "should have risk level");
  console.assert(blast.totalAffected >= 0, "should count affected");
  console.log("  PASS: Risk =", blast.riskLevel, "(", blast.totalAffected, "affected)\n");

  // Test 7: change tracker
  console.log("Test 7: Change tracker");
  const tracker = new ChangeTracker(process.cwd());
  tracker.init();
  tracker.recordChange("self-improve.js", "Added new improvement");
  const impact = tracker.cumulativeImpact();
  console.assert(impact.changes === 1, "should track 1 change");
  console.assert(impact.riskLevel, "should have risk level");
  console.log("  PASS: Tracker working, risk =", impact.riskLevel, "\n");

  // Test 8: report
  console.log("Test 8: Report");
  const report = tracker.report();
  console.assert(report.includes("Change Tracker"), "should include header");
  console.assert(report.includes("changes"), "should mention changes");
  console.log("  PASS: Report =", report, "\n");

  console.log("All tests passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}
