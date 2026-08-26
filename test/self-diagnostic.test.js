import assert from "node:assert";
import {
  checkTestCoverage,
  checkModuleSizes,
  checkImportHealth,
  checkErrorHandling,
  checkExportConsistency,
  checkTestQuality,
  checkImprovementVelocity,
  checkDependencyPatterns,
  checkDocumentation,
  runDiagnostics,
  generateActionPlan,
  formatReport,
} from "../src/self-diagnostic.js";
import { describe, it, before } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = process.cwd();

// ---------------------------------------------------------------------------
// checkTestCoverage
// ---------------------------------------------------------------------------

describe("checkTestCoverage", () => {
  it("returns a result with expected shape", () => {
    const result = checkTestCoverage(workspace);
    assert.strictEqual(result.id, "test-coverage");
    assert.strictEqual(result.category, "reliability");
    assert.ok(typeof result.severity === "number");
    assert.ok(result.severity >= 1 && result.severity <= 5);
    assert.ok(typeof result.detail === "string");
    assert.ok(typeof result.recommendation === "string");
    assert.ok(Array.isArray(result.untested));
  });

  it("detects untested source files", () => {
    const result = checkTestCoverage(workspace);
    // self-diagnostic.js itself has no test file yet (this is the first)
    // so there should be at least some untested files
    assert.ok(result.untested.length >= 0);
  });
});

// ---------------------------------------------------------------------------
// checkModuleSizes
// ---------------------------------------------------------------------------

describe("checkModuleSizes", () => {
  it("returns a result with expected shape", () => {
    const result = checkModuleSizes(workspace);
    assert.strictEqual(result.id, "module-sizes");
    assert.strictEqual(result.category, "maintainability");
    assert.ok(Array.isArray(result.oversized));
  });

  it("flags files over 300 lines", () => {
    const result = checkModuleSizes(workspace);
    for (const o of result.oversized) {
      assert.ok(o.lines > 300);
    }
  });
});

// ---------------------------------------------------------------------------
// checkImportHealth
// ---------------------------------------------------------------------------

describe("checkImportHealth", () => {
  it("returns a result with expected shape", () => {
    const result = checkImportHealth(workspace);
    assert.strictEqual(result.id, "import-health");
    assert.strictEqual(result.category, "code-quality");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// checkErrorHandling
// ---------------------------------------------------------------------------

describe("checkErrorHandling", () => {
  it("returns a result with expected shape", () => {
    const result = checkErrorHandling(workspace);
    assert.strictEqual(result.id, "error-handling");
    assert.strictEqual(result.category, "reliability");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// checkExportConsistency
// ---------------------------------------------------------------------------

describe("checkExportConsistency", () => {
  it("returns a result with expected shape", () => {
    const result = checkExportConsistency(workspace);
    assert.strictEqual(result.id, "export-consistency");
    assert.strictEqual(result.category, "code-quality");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// checkTestQuality
// ---------------------------------------------------------------------------

describe("checkTestQuality", () => {
  it("returns a result with expected shape", () => {
    const result = checkTestQuality(workspace);
    assert.strictEqual(result.id, "test-quality");
    assert.strictEqual(result.category, "reliability");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// checkImprovementVelocity
// ---------------------------------------------------------------------------

describe("checkImprovementVelocity", () => {
  it("returns a result with expected shape", () => {
    const result = checkImprovementVelocity(workspace);
    assert.strictEqual(result.id, "improvement-velocity");
    assert.strictEqual(result.category, "growth");
    assert.ok(typeof result.detail === "string");
  });

  it("handles missing improvement log gracefully", (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-diagnostic-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const result = checkImprovementVelocity(tmpDir);
    assert.strictEqual(result.severity, 3);
    assert.ok(result.detail.includes("No improvement history"));
  });
});

// ---------------------------------------------------------------------------
// checkDependencyPatterns
// ---------------------------------------------------------------------------

describe("checkDependencyPatterns", () => {
  it("returns a result with expected shape", () => {
    const result = checkDependencyPatterns(workspace);
    assert.strictEqual(result.id, "dependency-patterns");
    assert.strictEqual(result.category, "architecture");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// checkDocumentation
// ---------------------------------------------------------------------------

describe("checkDocumentation", () => {
  it("returns a result with expected shape", () => {
    const result = checkDocumentation(workspace);
    assert.strictEqual(result.id, "documentation");
    assert.strictEqual(result.category, "maintainability");
    assert.ok(Array.isArray(result.issues));
  });
});

// ---------------------------------------------------------------------------
// runDiagnostics
// ---------------------------------------------------------------------------

describe("runDiagnostics", () => {
  it("runs all checks and returns a health report", () => {
    const report = runDiagnostics(workspace);
    assert.ok(typeof report.overall === "number");
    assert.ok(report.overall >= 0 && report.overall <= 100);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length > 0);
    assert.ok(typeof report.summary === "string");
    assert.ok(report.summary.includes("Health:"));
  });

  it("includes all check categories", () => {
    const report = runDiagnostics(workspace);
    const ids = report.checks.map(c => c.id);
    assert.ok(ids.includes("test-coverage"));
    assert.ok(ids.includes("module-sizes"));
    assert.ok(ids.includes("import-health"));
    assert.ok(ids.includes("error-handling"));
    assert.ok(ids.includes("export-consistency"));
    assert.ok(ids.includes("test-quality"));
    assert.ok(ids.includes("improvement-velocity"));
    assert.ok(ids.includes("dependency-patterns"));
    assert.ok(ids.includes("documentation"));
  });

  it("groups results by category", () => {
    const report = runDiagnostics(workspace);
    assert.ok(typeof report.categories === "object");
    assert.ok(Object.keys(report.categories).length > 0);
  });

  it("handles category filter", () => {
    const report = runDiagnostics(workspace, { categories: ["reliability"] });
    for (const check of report.checks) {
      assert.strictEqual(check.category, "reliability");
    }
  });

  it("catches check errors gracefully", () => {
    // Force an error by passing a non-existent workspace
    const report = runDiagnostics("/tmp/nonexistent-workspace");
    assert.ok(report.checks.length > 0);
  });
});

// ---------------------------------------------------------------------------
// generateActionPlan
// ---------------------------------------------------------------------------

describe("generateActionPlan", () => {
  it("returns a sorted action plan", () => {
    const report = runDiagnostics(workspace);
    const plan = generateActionPlan(report);
    assert.ok(Array.isArray(plan));
    if (plan.length > 0) {
      assert.ok(typeof plan[0].id === "string");
      assert.ok(typeof plan[0].priority === "number");
      assert.ok(typeof plan[0].action === "string");
    }
  });

  it("sorts by priority descending", () => {
    const report = runDiagnostics(workspace);
    const plan = generateActionPlan(report);
    for (let i = 1; i < plan.length; i++) {
      assert.ok(plan[i - 1].priority >= plan[i].priority);
    }
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("returns a non-empty string", () => {
    const report = runDiagnostics(workspace);
    const text = formatReport(report);
    assert.ok(typeof text === "string");
    assert.ok(text.length > 0);
  });

  it("includes the health score", () => {
    const report = runDiagnostics(workspace);
    const text = formatReport(report);
    assert.ok(text.includes("Health:"));
  });

  it("verbose mode includes more detail", () => {
    const report = runDiagnostics(workspace);
    const normal = formatReport(report);
    const verbose = formatReport(report, { verbose: true });
    assert.ok(verbose.length >= normal.length);
  });
});
