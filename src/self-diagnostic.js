// Self-Diagnostic Mode: "What am I bad at right now?"
//
// Scans the codebase, tests, improvement log, and failure patterns to produce
// a health report with actionable weakness categories, severity scores,
// and prioritized recommendations. Designed to be run before any improvement
// cycle so the agent knows exactly where to focus.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { simple } from "acorn-walk";

// ---------------------------------------------------------------------------
// 1.  DIAGNOSTIC CHECKS — individual health assessments
// ---------------------------------------------------------------------------

/**
 * Each check returns { id, category, severity (1-5), detail, recommendation }.
 * severity 1 = minor, 5 = critical.
 */

export function checkTestCoverage(workspace) {
  const srcDir = path.join(workspace, "src");
  const testDir = path.join(workspace, "test");

  if (!isDirectory(srcDir)) {
    return {
      id: "test-coverage",
      category: "reliability",
      severity: 5,
      detail: "Source directory is missing or is not a directory",
      recommendation: `Verify the workspace path and restore ${srcDir}.`,
      untested: [],
    };
  }

  const srcFiles = listFiles(srcDir, /\.js$/);
  const testFiles = listFiles(testDir, /\.js$/);
  const srcSet = new Set(srcFiles.map(normalizeRelativePath));

  // Determine which source files are tested from parsed module imports. Regex
  // scanning used to count import-looking comments and miss multiline imports.
  const tested = new Set();
  for (const tf of testFiles) {
    const testFile = path.join(testDir, tf);
    const content = fs.readFileSync(testFile, "utf8");
    for (const specifier of relativeModuleImports(content)) {
      const absolute = path.resolve(path.dirname(testFile), specifier);
      const relative = normalizeRelativePath(path.relative(srcDir, absolute));
      for (const candidate of moduleCandidates(relative)) {
        if (srcSet.has(candidate)) tested.add(candidate);
      }
    }
  }

  const untested = srcFiles.filter(f => !tested.has(normalizeRelativePath(f)));
  const coverage = srcFiles.length > 0 ? ((srcFiles.length - untested.length) / srcFiles.length * 100) : 100;
  const shown = untested.slice(0, 4);

  let severity;
  if (coverage >= 80) severity = 1;
  else if (coverage >= 60) severity = 2;
  else if (coverage >= 40) severity = 3;
  else if (coverage >= 20) severity = 4;
  else severity = 5;

  return {
    id: "test-coverage",
    category: "reliability",
    severity,
    detail: `${coverage.toFixed(0)}% module import coverage (${srcFiles.length - untested.length}/${srcFiles.length} source modules imported by tests)`,
    recommendation: untested.length > 0
      ? `Add direct tests for: ${shown.join(", ")}${untested.length > shown.length ? ` and ${untested.length - shown.length} more` : ""}`
      : "Coverage is healthy.",
    untested,
  };
}

export function checkModuleSizes(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  const oversized = [];
  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    const lines = content.split("\n").length;
    if (lines > 300) {
      oversized.push({ file: f, lines });
    }
  }

  oversized.sort((a, b) => b.lines - a.lines);

  let severity;
  if (oversized.length === 0) severity = 1;
  else if (oversized.length <= 2) severity = 2;
  else if (oversized.length <= 4) severity = 3;
  else if (oversized.length <= 6) severity = 4;
  else severity = 5;

  return {
    id: "module-sizes",
    category: "maintainability",
    severity,
    detail: `${oversized.length} files exceed 300 lines`,
    recommendation: oversized.length > 0
      ? `Consider splitting: ${oversized.slice(0, 3).map(o => `${o.file}(${o.lines}L)`).join(", ")}`
      : "Module sizes are within budget.",
    oversized,
  };
}

export function checkImportHealth(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  const issues = [];
  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    try {
      parseModule(content);
    } catch (error) {
      issues.push({
        file: f,
        issue: `module parse failed${error.loc?.line ? ` at line ${error.loc.line}` : ""}`,
      });
      continue;
    }
    // Only match import/export statements, not `from` in comments/strings
    const imports = content.match(/^(?:import|export)\s+.*?from\s+["'][^"']+"']/gm) || [];
    const unique = new Set(imports);

    // Duplicate imports
    if (imports.length > unique.size) {
      issues.push({ file: f, issue: `duplicate imports (${imports.length} total, ${unique.size} unique)` });
    }

    // Wildcard imports (import * as)
    const wildcards = content.match(/^import\s+\*\s+as\s+\w+/gm) || [];
    if (wildcards.length > 2) {
      issues.push({ file: f, issue: `excessive wildcard imports (${wildcards.length})` });
    }
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 2) severity = 2;
  else if (issues.length <= 4) severity = 3;
  else if (issues.length <= 6) severity = 4;
  else severity = 5;

  return {
    id: "import-health",
    category: "code-quality",
    severity,
    detail: `${issues.length} import issue(s) found across ${srcFiles.length} files`,
    recommendation: issues.length > 0
      ? `Fix imports in: ${issues.slice(0, 3).map(i => `${i.file}: ${i.issue}`).join(", ")}`
      : "Import health is good.",
    issues,
  };
}

export function checkErrorHandling(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  const issues = [];
  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    let ast;
    try {
      ast = parseModule(content);
    } catch {
      continue;
    }
    simple(ast, {
      CatchClause(node) {
        // Empty statements (`catch { ;;; }`) are no more meaningful than an
        // empty block. Treat them as empty while still accepting any real
        // statement as explicit handling.
        if (node.body.body.some((statement) => statement.type !== "EmptyStatement")) return;
        const bodyText = content.slice(node.body.start + 1, node.body.end - 1);
        // A documented empty catch is an explicit best-effort boundary. Only
        // surface truly silent catches; the syntax scanner handles malformed
        // code separately.
        if (/\/[/*]/.test(bodyText)) return;
        issues.push({
          file: f,
          line: lineNumberAt(content, node.start),
          issue: "undocumented empty catch block",
        });
      },
    });
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 2) severity = 2;
  else if (issues.length <= 4) severity = 3;
  else if (issues.length <= 6) severity = 4;
  else severity = 5;

  return {
    id: "error-handling",
    category: "reliability",
    severity,
    detail: `${issues.length} error handling gaps found`,
    recommendation: issues.length > 0
      ? `Address: ${issues.slice(0, 3).map(i => `${i.file}${i.line ? `:${i.line}` : ""}: ${i.issue}`).join(", ")}`
      : "Error handling looks solid.",
    issues,
  };
}

export function checkExportConsistency(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  const issues = [];
  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    let ast;
    try {
      ast = parseModule(content);
    } catch {
      continue;
    }
    let esmExports = 0;
    let commonJsExports = 0;
    simple(ast, {
      ExportNamedDeclaration() { esmExports++; },
      ExportDefaultDeclaration() { esmExports++; },
      ExportAllDeclaration() { esmExports++; },
      AssignmentExpression(node) {
        if (isCommonJsExportTarget(node.left)) commonJsExports++;
      },
    });
    if (esmExports > 0 && commonJsExports > 0) {
      issues.push({ file: f, issue: "mixed ESM and CommonJS exports" });
    }
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 2) severity = 2;
  else severity = 3;

  return {
    id: "export-consistency",
    category: "code-quality",
    severity,
    detail: `${issues.length} export consistency issues`,
    recommendation: issues.length > 0
      ? `Review: ${issues.slice(0, 3).map(i => `${i.file}: ${i.issue}`).join(", ")}`
      : "Export patterns are consistent.",
    issues,
  };
}

export function checkTestQuality(workspace) {
  const testDir = path.join(workspace, "test");
  const testFiles = listFiles(testDir, /\.js$/);

  const issues = [];
  for (const f of testFiles) {
    const content = fs.readFileSync(path.join(testDir, f), "utf8");

    // Check comments, not test data strings such as a search query for "TODO".
    const comments = [];
    let ast;
    try {
      ast = parseModule(content, comments);
    } catch (error) {
      issues.push({
        file: f,
        issue: `test module parse failed${error.loc?.line ? ` at line ${error.loc.line}` : ""}`,
      });
    }
    if (ast) {
      const quality = analyzeTestModule(ast);
      if (quality.assertionless > 0) {
        issues.push({
          file: f,
          issue: `${quality.assertionless} test(s) contain no direct assertion or assertion helper`,
        });
      }
      if (quality.skipped > 0) {
        issues.push({ file: f, issue: `${quality.skipped} test(s) marked .skip` });
      }
    }
    const todos = comments.reduce(
      (count, comment) => count + (((comment.value ?? "").match(/TODO|FIXME/gi) || []).length),
      0,
    );
    if (todos > 0) {
      issues.push({ file: f, issue: `${todos} TODO/FIXME markers in test` });
    }
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 2) severity = 2;
  else if (issues.length <= 4) severity = 3;
  else severity = 4;

  return {
    id: "test-quality",
    category: "reliability",
    severity,
    detail: `${issues.length} test quality issues across ${testFiles.length} test files`,
    recommendation: issues.length > 0
      ? `Improve: ${issues.slice(0, 3).map(i => `${i.file}: ${i.issue}`).join(", ")}`
      : "Test quality is good.",
    issues,
  };
}

export function checkImprovementVelocity(workspace) {
  const canonicalPath = path.join(workspace, ".bantam", "self-improvements.json");
  const legacyPath = path.join(workspace, ".bantam-improvements.json");
  const logPath = fs.existsSync(canonicalPath) ? canonicalPath : legacyPath;

  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf8"));
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    // No log yet
  }

  if (entries.length === 0) {
    return {
      id: "improvement-velocity",
      category: "growth",
      severity: 3,
      detail: "No improvement history yet — baseline not established",
      recommendation: "Run at least one self-improvement cycle to establish a baseline.",
    };
  }

  const total = entries.length;
  const passed = entries.filter(entryPassed).length;
  const rate = total > 0 ? (passed / total * 100) : 100;

  // Check for repeated failures on same improvement
  const byId = new Map();
  for (const e of entries) {
    const id = typeof e?.id === "string" && e.id.length > 0 ? e.id : "unknown";
    const summary = byId.get(id) ?? { total: 0, failed: 0 };
    summary.total++;
    if (!entryPassed(e)) summary.failed++;
    byId.set(id, summary);
  }
  const stuck = [...byId].filter(([, v]) => v.failed >= 2);

  let severity;
  if (rate >= 80 && stuck.length === 0) severity = 1;
  else if (rate >= 60 && stuck.length <= 1) severity = 2;
  else if (rate >= 40) severity = 3;
  else if (rate >= 20) severity = 4;
  else severity = 5;

  return {
    id: "improvement-velocity",
    category: "growth",
    severity,
    detail: `${passed}/${total} improvements passed (${rate.toFixed(0)}%), ${stuck.length} stuck areas`,
    recommendation: stuck.length > 0
      ? `Focus on stuck areas: ${stuck.map(([id]) => id).join(", ")}`
      : rate < 80
        ? "Improvement success rate could be higher. Review failed cycles."
        : "Improvement velocity is healthy.",
    stuck,
  };
}

export function checkDependencyPatterns(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  // Build dependency graph
  const deps = new Map();
  const issues = [];
  const knownFiles = new Set(srcFiles.map(normalizeRelativePath));

  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    const normalizedFile = normalizeRelativePath(f);
    const resolved = new Set();
    for (const specifier of relativeModuleImports(content)) {
      const relative = normalizeRelativePath(
        path.posix.join(path.posix.dirname(normalizedFile), specifier),
      );
      const target = moduleCandidates(relative).find(candidate => knownFiles.has(candidate));
      if (target) resolved.add(target);
    }
    deps.set(normalizedFile, resolved);
  }

  const seen = new Set();
  for (const [source, sourceDeps] of deps) {
    for (const target of sourceDeps) {
      if (!deps.get(target)?.has(source)) continue;
      const pair = [source, target].sort();
      const key = pair.join("\0");
      if (!seen.has(key)) {
        seen.add(key);
        issues.push({ file: pair[0], issue: `direct circular dependency with ${pair[1]}` });
      }
    }
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 2) severity = 2;
  else severity = 3;

  return {
    id: "dependency-patterns",
    category: "architecture",
    severity,
    detail: `${issues.length} dependency pattern issues`,
    recommendation: issues.length > 0
      ? `Review: ${issues.slice(0, 3).map(i => `${i.file}: ${i.issue}`).join(", ")}`
      : "Dependency patterns are clean.",
    issues,
  };
}

export function checkDocumentation(workspace) {
  const srcDir = path.join(workspace, "src");
  const srcFiles = listFiles(srcDir, /\.js$/);

  const issues = [];
  const skipped = [];
  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(srcDir, f), "utf8");
    const comments = [];
    let ast;

    try {
      ast = parseModule(content, comments);
    } catch (error) {
      skipped.push({
        file: f,
        reason: `module parse failed${error.loc?.line ? ` at line ${error.loc.line}` : ""}`,
      });
      // Syntax health is scored by checkImportHealth. Do not invent secondary
      // documentation conclusions from source that could not be parsed.
      continue;
    }

    // Inspect syntax nodes rather than source text. Embedded builders and
    // examples often contain `export function ...` strings that are not
    // declarations in this module.
    const undocumented = exportedDocumentationTargets(ast)
      .filter(({ starts }) => (
        !starts.some(start => hasImmediatelyPrecedingJSDoc(content, comments, start))
      ));
    if (undocumented.length > 0) {
      const noun = undocumented.length === 1 ? "item" : "items";
      issues.push({
        file: f,
        issue: `${undocumented.length} exported API ${noun} without JSDoc`,
      });
    }

    // A shebang is launcher metadata, not the module description. Permit
    // whitespace after it, but require the first substantive token to be a
    // non-empty line or block comment.
    if (!hasModuleDescription(content, comments)) {
      issues.push({ file: f, issue: "no module description comment at top" });
    }
  }

  let severity;
  if (issues.length === 0) severity = 1;
  else if (issues.length <= 3) severity = 2;
  else if (issues.length <= 6) severity = 3;
  else severity = 4;

  return {
    id: "documentation",
    category: "maintainability",
    severity,
    detail: `${issues.length} documentation gaps${skipped.length > 0 ? ` (${skipped.length} malformed file(s) skipped)` : ""}`,
    recommendation: issues.length > 0
      ? `Document: ${issues.slice(0, 3).map(i => `${i.file}: ${i.issue}`).join(", ")}`
      : skipped.length > 0
        ? "Fix syntax errors reported by import health, then rescan documentation."
      : "Documentation is adequate.",
    issues,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// 2.  DIAGNOSTIC RUNNER — execute all checks and produce a report
// ---------------------------------------------------------------------------

const ALL_CHECKS = [
  checkTestCoverage,
  checkModuleSizes,
  checkImportHealth,
  checkErrorHandling,
  checkExportConsistency,
  checkTestQuality,
  checkImprovementVelocity,
  checkDependencyPatterns,
  checkDocumentation,
];

/**
 * Run all diagnostic checks and return a structured health report.
 *
 * @param {string} workspace - workspace root directory
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false] - include full detail in output
 * @param {string[]} [opts.categories] - filter to specific categories only
 * @returns {{ overall: number, categories: object, checks: Array, summary: string }}
 */
export function runDiagnostics(workspace, opts = {}) {
  const results = [];

  for (const check of ALL_CHECKS) {
    try {
      const result = check(workspace);
      // Filter by category if requested
      if (opts.categories && !opts.categories.includes(result.category)) {
        continue;
      }
      results.push(result);
    } catch (err) {
      results.push({
        id: check.name.replace("check", "").replace(/([A-Z])/g, "-$1").slice(1),
        category: "diagnostic",
        severity: 3,
        detail: `Check failed: ${err.message}`,
        recommendation: "Investigate the diagnostic check error.",
      });
    }
  }

  // Calculate overall health score (0-100, higher is better)
  const maxSeverity = results.length > 0 ? Math.max(...results.map(r => r.severity)) : 1;
  const avgSeverity = results.length > 0
    ? results.reduce((sum, r) => sum + r.severity, 0) / results.length
    : 1;
  const overall = Math.max(0, Math.min(100, Math.round(100 - (avgSeverity - 1) * 20)));

  // Group by category
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  // Find the worst areas
  const worst = results
    .filter(r => r.severity >= 3)
    .sort((a, b) => b.severity - a.severity);

  const summary = maxSeverity >= 4
    ? `Health: ${overall}/100 — ${worst.length} significant issues found. Focus on: ${worst.slice(0, 3).map(w => w.id).join(", ")}`
    : overall >= 80
    ? `Health: ${overall}/100 — codebase is in good shape. ${results.length - worst.length} minor issues.`
    : overall >= 60
      ? `Health: ${overall}/100 — ${worst.length} area(s) need attention.`
      : `Health: ${overall}/100 — ${worst.length} significant issues found. Focus on: ${worst.slice(0, 3).map(w => w.id).join(", ")}`;

  return {
    overall,
    categories: byCategory,
    checks: results,
    summary,
  };
}

/**
 * Generate a prioritized action plan from diagnostic results.
 * Returns items sorted by severity * impact.
 */
export function generateActionPlan(report) {
  const actions = [];

  for (const check of report.checks) {
    if (check.severity < 2) continue; // Skip minor issues

    actions.push({
      id: check.id,
      category: check.category,
      priority: check.severity,
      action: check.recommendation,
      detail: check.detail,
    });
  }

  // Sort by priority (severity), highest first
  actions.sort((a, b) => b.priority - a.priority);
  return actions;
}

/**
 * Format the diagnostic report as a readable string.
 */
export function formatReport(report, verbose = false) {
  const lines = [];
  lines.push("═══ Self-Diagnostic Report ═══");
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  // Overall score bar
  const barLen = 20;
  const filled = Math.round((report.overall / 100) * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  lines.push(`Score: [${bar}] ${report.overall}/100`);
  lines.push("");

  // Category breakdown
  for (const [category, checks] of Object.entries(report.categories)) {
    const worst = Math.max(...checks.map(c => c.severity));
    const icon = worst >= 4 ? "🔴" : worst >= 3 ? "🟡" : worst >= 2 ? "🟢" : "⚪";
    lines.push(`${icon} ${category.toUpperCase()}:`);

    for (const check of checks) {
      const sevIcon = check.severity >= 4 ? "  ❌" : check.severity >= 3 ? "  ⚠️" : check.severity >= 2 ? "  ℹ️" : "  ✓";
      lines.push(`${sevIcon} ${check.id}: ${check.detail}`);
      if (verbose && check.recommendation) {
        lines.push(`     → ${check.recommendation}`);
      }
    }
    lines.push("");
  }

  // Action plan
  const plan = generateActionPlan(report);
  if (plan.length > 0) {
    lines.push("── Prioritized Actions ──");
    for (let i = 0; i < Math.min(plan.length, 5); i++) {
      lines.push(`${i + 1}. [P${plan[i].priority}] ${plan[i].action}`);
    }
    if (plan.length > 4) {
      lines.push(`   ... and ${plan.length - 5} more`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 3.  CLI ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Run diagnostics from the command line.
 * Usage: node src/self-diagnostic.js [--verbose] [--categories reliability,maintainability]
 */
export function cliMain(workspace, args = process.argv.slice(2)) {
  const opts = {};

  if (args.includes("--verbose")) opts.verbose = true;
  if (args.includes("--categories")) {
    const idx = args.indexOf("--categories");
    if (idx + 1 < args.length) {
      opts.categories = args[idx + 1].split(",").map(s => s.trim());
    }
  }

  const report = runDiagnostics(workspace, opts);
  console.log(formatReport(report, opts.verbose));

  // Also output JSON to stderr for machine consumption
  if (args.includes("--json")) {
    console.error(JSON.stringify(report, null, 2));
  }

  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listFiles(dir, filter) {
  let entries;
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = listFiles(full, filter);
      results.push(...sub.map(f => path.join(path.relative(dir, full), f)));
    } else if (filter.test(entry.name)) {
      results.push(entry.name);
    }
  }
  return results;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function parseModule(content, onComment = undefined) {
  const commentOption = Array.isArray(onComment)
    ? onComment
    : onComment
      ? (_block, text) => onComment(text)
      : undefined;
  return parse(content, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    ...(commentOption ? { onComment: commentOption } : {}),
  });
}

function exportedDocumentationTargets(ast) {
  const locals = localDeclarations(ast);
  const imports = importedBindings(ast);
  const targets = new Map();

  const addTarget = (key, starts) => {
    const target = targets.get(key) ?? { starts: new Set() };
    for (const start of starts) target.starts.add(start);
    targets.set(key, target);
  };

  for (const statement of ast.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      for (const binding of declarationBindings(statement.declaration)) {
        const local = locals.get(binding.name);
        addTarget(
          local?.key ?? `declaration:${statement.declaration.start}:${binding.name}`,
          [statement.start, statement.declaration.start, ...(local?.starts ?? [])],
        );
      }
      continue;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.source === null) {
      for (const specifier of statement.specifiers) {
        const name = specifier.local?.name;
        const local = name ? locals.get(name) : null;
        if (local) addTarget(local.key, [...local.starts, statement.start]);
      }
      continue;
    }
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration.type === "Identifier") {
      const local = locals.get(declaration.name);
      if (local) addTarget(local.key, [...local.starts, statement.start, declaration.start]);
      else if (!imports.has(declaration.name)) {
        addTarget(`default:${statement.start}`, [statement.start, declaration.start]);
      }
    } else {
      const name = declaration.id?.name;
      const local = name ? locals.get(name) : null;
      addTarget(
        local?.key ?? `default:${statement.start}`,
        [statement.start, declaration.start, ...(local?.starts ?? [])],
      );
    }
  }
  return [...targets.values()].map(target => ({ starts: [...target.starts] }));
}

function importedBindings(ast) {
  const names = new Set();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) names.add(specifier.local.name);
  }
  return names;
}

function localDeclarations(ast) {
  const locals = new Map();
  for (const statement of ast.body) {
    let declaration = statement;
    if (statement.type === "ExportNamedDeclaration") declaration = statement.declaration;
    if (statement.type === "ExportDefaultDeclaration") declaration = statement.declaration;
    for (const binding of declarationBindings(declaration)) {
      const local = locals.get(binding.name) ?? {
        key: `local:${binding.name}`,
        starts: [],
      };
      local.starts.push(declaration.start);
      locals.set(binding.name, local);
    }
  }
  return locals;
}

function declarationBindings(node) {
  if ((node?.type === "FunctionDeclaration" || node?.type === "ClassDeclaration") && node.id) {
    return [{ name: node.id.name }];
  }
  if (node?.type !== "VariableDeclaration") return [];
  return node.declarations.flatMap(declaration => bindingNames(declaration.id));
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [{ name: pattern.name }];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap(property => (
      property.type === "RestElement" ? bindingNames(property.argument) : bindingNames(property.value)
    ));
  }
  return [];
}

function hasImmediatelyPrecedingJSDoc(content, comments, declarationStart) {
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index];
    if (comment.end > declarationStart) continue;
    if (!/^\s*$/.test(content.slice(comment.end, declarationStart))) return false;
    return isMeaningfulJSDoc(comment);
  }
  return false;
}

function isMeaningfulJSDoc(comment) {
  if (comment.type !== "Block" || !comment.value.startsWith("*")) return false;
  const description = comment.value.slice(1).replace(/^\s*\*/gm, "").trim();
  return /[\p{L}\p{N}]/u.test(description);
}

function hasModuleDescription(content, comments) {
  let offset = content.charCodeAt(0) === 0xFEFF ? 1 : 0;
  if (content.startsWith("#!", offset)) {
    const newline = content.indexOf("\n", offset);
    offset = newline === -1 ? content.length : newline + 1;
  }
  for (const comment of comments) {
    if (comment.start < offset) continue;
    const between = content.slice(offset, comment.start);
    if (!/^\s*$/.test(between)) return false;
    if (isDescriptiveHeaderComment(comment.value)) return true;
    offset = comment.end;
  }
  return false;
}

function isDescriptiveHeaderComment(value) {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\*?\s*/, "").trim())
    .filter(line => line.length > 0 && /[\p{L}\p{N}]/u.test(line));
  if (lines.length === 0) return false;
  const directive = /^(?:eslint(?:\b|-)|istanbul\b|c8\b|prettier\b|biome\b|jshint\b|jslint\b|global(?:s)?\b|exported\b|@ts-(?:check|nocheck)\b|@flow\b)/i;
  const license = /(?:spdx-license-identifier|copyright\b|all rights reserved|licensed under|software license|permission is hereby granted|the above copyright|software is provided|without warranty|redistribution and use|apache license|mit license|gnu (?:general|lesser|affero) public license)/i;
  return lines.some(line => !directive.test(line) && !license.test(line));
}

function analyzeTestModule(ast) {
  const bindings = nodeTestBindings(ast);
  const assertionRoots = assertionBindings(ast);
  const helpers = assertionHelpers(ast, assertionRoots);
  let assertionless = 0;
  let skipped = 0;
  let tests = 0;

  simple(ast, {
    CallExpression(node) {
      const testCall = classifyNodeTestCall(node.callee, bindings);
      if (!testCall) return;
      if (testCall.modifier === "skip") skipped++;
      if (testCall.role !== "test" || testCall.modifier === "skip"
        || testCall.modifier === "todo") {
        return;
      }
      const callback = [...node.arguments].reverse().find(isFunctionNode);
      if (!callback) return;
      tests++;
      if (!containsAssertion(callback.body, assertionRoots, helpers)) assertionless++;
    },
  });

  return { tests, assertionless, skipped };
}

function nodeTestBindings(ast) {
  const tests = new Set();
  const suites = new Set();
  const namespaces = new Set();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "node:test") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        tests.add(specifier.local.name);
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(specifier.local.name);
      } else if (specifier.type === "ImportSpecifier") {
        const imported = specifier.imported.name ?? specifier.imported.value;
        if (imported === "it" || imported === "test") tests.add(specifier.local.name);
        if (imported === "describe" || imported === "suite") suites.add(specifier.local.name);
      }
    }
  }
  return { tests, suites, namespaces };
}

function assertionBindings(ast) {
  const roots = new Set();
  const modules = new Set(["assert", "assert/strict", "node:assert", "node:assert/strict"]);
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || !modules.has(statement.source.value)) continue;
    for (const specifier of statement.specifiers) roots.add(specifier.local.name);
  }
  return roots;
}

function assertionHelpers(ast, assertionRoots) {
  const functions = new Map();
  simple(ast, {
    FunctionDeclaration(node) {
      if (node.id) functions.set(node.id.name, node);
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && isFunctionNode(node.init)) {
        functions.set(node.id.name, node.init);
      }
    },
  });

  const helpers = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, fn] of functions) {
      if (helpers.has(name)) continue;
      if (containsAssertion(fn.body, assertionRoots, helpers)) {
        helpers.add(name);
        changed = true;
      }
    }
  }
  return helpers;
}

function containsAssertion(node, assertionRoots, helpers) {
  let found = false;
  simple(node, {
    CallExpression(call) {
      if (found) return;
      const memberPath = staticMemberPath(call.callee);
      if (memberPath && assertionRoots.has(memberPath[0])) {
        found = true;
      } else if (memberPath?.length === 2
        && memberPath[0] === "console" && memberPath[1] === "assert") {
        found = true;
      } else if (call.callee.type === "Identifier" && helpers.has(call.callee.name)) {
        found = true;
      }
    },
  });
  return found;
}

function classifyNodeTestCall(callee, bindings) {
  const memberPath = staticMemberPath(callee);
  if (!memberPath) return null;
  let role;
  let modifier = null;
  if (bindings.tests.has(memberPath[0])) {
    role = "test";
    modifier = memberPath[1] ?? null;
  } else if (bindings.suites.has(memberPath[0])) {
    role = "suite";
    modifier = memberPath[1] ?? null;
  } else if (bindings.namespaces.has(memberPath[0])) {
    const method = memberPath[1];
    if (method === "it" || method === "test") role = "test";
    else if (method === "describe" || method === "suite") role = "suite";
    else return null;
    modifier = memberPath[2] ?? null;
  } else {
    return null;
  }
  if (memberPath.length > (bindings.namespaces.has(memberPath[0]) ? 3 : 2)) return null;
  return { role, modifier };
}

function staticMemberPath(node) {
  if (node?.type === "ChainExpression") return staticMemberPath(node.expression);
  if (node?.type === "Identifier") return [node.name];
  if (node?.type !== "MemberExpression") return null;
  const objectPath = staticMemberPath(node.object);
  if (!objectPath) return null;
  const property = node.computed ? node.property?.value : node.property?.name;
  if (typeof property !== "string") return null;
  return [...objectPath, property];
}

function isFunctionNode(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function relativeModuleImports(content) {
  let ast;
  try {
    ast = parseModule(content);
  } catch {
    return [];
  }
  const imports = [];
  simple(ast, {
    ImportDeclaration(node) {
      if (typeof node.source?.value === "string" && node.source.value.startsWith(".")) {
        imports.push(node.source.value);
      }
    },
    ExportNamedDeclaration(node) {
      if (typeof node.source?.value === "string" && node.source.value.startsWith(".")) {
        imports.push(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      if (typeof node.source?.value === "string" && node.source.value.startsWith(".")) {
        imports.push(node.source.value);
      }
    },
    ImportExpression(node) {
      if (typeof node.source?.value === "string" && node.source.value.startsWith(".")) {
        imports.push(node.source.value);
      }
    },
  });
  return imports;
}

function moduleCandidates(relative) {
  const normalized = normalizeRelativePath(relative).replace(/^\.\//, "");
  if (path.posix.extname(normalized)) return [normalized];
  return [`${normalized}.js`, `${normalized}/index.js`];
}

function normalizeRelativePath(value) {
  return String(value).split(path.sep).join("/");
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

function isCommonJsExportTarget(node) {
  if (node?.type !== "MemberExpression") return false;
  if (node.object?.type === "Identifier" && node.object.name === "exports") return true;
  if (node.object?.type === "Identifier"
    && node.object.name === "module"
    && memberPropertyName(node) === "exports") {
    return true;
  }
  // Also recognize writes below the export object, such as
  // `module.exports.name = value` and `exports["name"] = value`.
  return isCommonJsExportTarget(node.object);
}

function memberPropertyName(node) {
  if (!node?.computed && node?.property?.type === "Identifier") return node.property.name;
  if (node?.computed && node?.property?.type === "Literal") return node.property.value;
  return undefined;
}

function entryPassed(entry) {
  return typeof entry?.passed === "boolean" ? entry.passed : Boolean(entry?.success);
}

// Run CLI only when this exact file is the process entry point. Importing the
// diagnostics library must never execute a scan or write command output.
const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  cliMain(process.cwd());
}
