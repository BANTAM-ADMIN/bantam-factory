import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  checkDependencyPatterns,
  checkDocumentation,
  checkErrorHandling,
  checkExportConsistency,
  checkImportHealth,
  checkImprovementVelocity,
  checkTestCoverage,
  checkTestQuality,
  runDiagnostics,
} from "../src/self-diagnostic.js";

const temporary = new Set();

function workspace(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  return root;
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

afterEach(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
  temporary.clear();
});

describe("self-diagnostic signal accuracy", () => {
  it("uses parsed imports for module coverage and reports the exact remainder", () => {
    const root = workspace("bantam-diagnostic-coverage-");
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      write(root, `src/${name}.js`, `export const ${name} = "${name}";\n`);
    }
    write(root, "test/a.test.js", [
      "/* from \"../src/b.js\" is documentation, not an import */",
      "import {",
      "  a,",
      "} from \"../src/a.js\";",
      "void a;",
      "",
    ].join("\n"));

    const result = checkTestCoverage(root);

    assert.deepEqual(result.untested, ["b.js", "c.js", "d.js", "e.js", "f.js"]);
    assert.match(result.detail, /module import coverage/);
    assert.match(result.recommendation, /and 1 more$/);
  });

  it("resolves source imports from nested test directories", () => {
    const root = workspace("bantam-diagnostic-nested-coverage-");
    write(root, "src/nested/tool.js", "export const tool = true;\n");
    write(root, "test/deep/tool.test.js", [
      "import { tool } from '../../src/nested/tool.js';",
      "void tool;",
      "",
    ].join("\n"));

    const result = checkTestCoverage(root);

    assert.deepEqual(result.untested, []);
  });

  it("flags only undocumented empty catches", () => {
    const root = workspace("bantam-diagnostic-catches-");
    write(root, "src/handled.js", [
      "export function handled() {",
      "  try { throw new Error('x'); }",
      "  catch (error) {",
      "    const message = error.message;",
      "    return message;",
      "  }",
      "}",
      "",
    ].join("\n"));
    write(root, "src/documented.js", [
      "export function documented() {",
      "  try { return true; } catch { /* optional fallback */ }",
      "  return false;",
      "}",
      "",
    ].join("\n"));
    write(root, "src/silent.js", [
      "export function silent() {",
      "  try { return true; } catch {}",
      "  return false;",
      "}",
      "",
    ].join("\n"));
    write(root, "src/semicolon.js", [
      "export function semicolonOnly() {",
      "  try { return true; } catch { ;;; }",
      "  return false;",
      "}",
      "",
    ].join("\n"));

    const result = checkErrorHandling(root);

    assert.deepEqual(result.issues.map(({ file, line, issue }) => ({ file, line, issue })), [
      { file: "semicolon.js", line: 2, issue: "undocumented empty catch block" },
      { file: "silent.js", line: 2, issue: "undocumented empty catch block" },
    ]);
  });

  it("ignores import-looking comments and reports one real direct cycle", () => {
    const root = workspace("bantam-diagnostic-deps-");
    write(root, "src/comment-only.js", [
      "// Example: import x from './comment-only.js'",
      "export const value = 1;",
      "",
    ].join("\n"));
    write(root, "src/a.js", "import './nested/b.js';\nexport const a = 1;\n");
    write(root, "src/nested/b.js", "import '../a.js';\nexport const b = 1;\n");

    const result = checkDependencyPatterns(root);

    assert.deepEqual(result.issues, [{
      file: "a.js",
      issue: "direct circular dependency with nested/b.js",
    }]);
  });

  it("accepts named/default and async ESM exports but flags CommonJS mixing", () => {
    const root = workspace("bantam-diagnostic-exports-");
    write(root, "src/esm.js", [
      "export const named = true;",
      "export default named;",
      "",
    ].join("\n"));
    write(root, "src/async.js", "export async function work() { return true; }\n");
    write(root, "src/hybrid.js", [
      "export const named = true;",
      "module.exports = { named };",
      "",
    ].join("\n"));
    write(root, "src/hybrid-computed.js", [
      "export const named = true;",
      "exports['named'] = named;",
      "",
    ].join("\n"));
    write(root, "src/hybrid-nested.js", [
      "export const named = true;",
      "module.exports.named = named;",
      "",
    ].join("\n"));

    const result = checkExportConsistency(root);

    assert.deepEqual(result.issues, [
      { file: "hybrid-computed.js", issue: "mixed ESM and CommonJS exports" },
      { file: "hybrid-nested.js", issue: "mixed ESM and CommonJS exports" },
      { file: "hybrid.js", issue: "mixed ESM and CommonJS exports" },
    ]);
  });

  it("counts TODO markers in comments but not test data strings", () => {
    const root = workspace("bantam-diagnostic-test-quality-");
    write(root, "test/data.test.js", [
      "const query = 'TODO';",
      "void query;",
      "",
    ].join("\n"));
    write(root, "test/comment.test.js", [
      "// TODO: add the boundary assertion",
      "const value = true;",
      "void value;",
      "",
    ].join("\n"));

    const result = checkTestQuality(root);

    assert.deepEqual(result.issues, [{
      file: "comment.test.js",
      issue: "1 TODO/FIXME markers in test",
    }]);
  });

  it("finds assertionless arrow-function tests instead of averaging by file", () => {
    const root = workspace("bantam-diagnostic-test-assertions-");
    write(root, "test/assertions.test.js", [
      "import assert from 'node:assert/strict';",
      "import { it } from 'node:test';",
      "it('verified', () => { assert.equal(1, 1); });",
      "it('unverified', () => { const value = 1; void value; });",
      "",
    ].join("\n"));

    const result = checkTestQuality(root);

    assert.deepEqual(result.issues, [{
      file: "assertions.test.js",
      issue: "1 test(s) contain no direct assertion or assertion helper",
    }]);
  });

  it("recognizes assertion aliases and local assertion helpers", () => {
    const root = workspace("bantam-diagnostic-test-helpers-");
    write(root, "test/helpers.test.js", [
      "import { strict as verify } from 'node:assert';",
      "import { it as scenario } from 'node:test';",
      "function expectValue(actual) { verify.equal(actual, 1); }",
      "scenario('uses a helper', () => { expectValue(1); });",
      "",
    ].join("\n"));

    const result = checkTestQuality(root);

    assert.deepEqual(result.issues, []);
  });

  it("does not count skip-looking strings as skipped tests", () => {
    const root = workspace("bantam-diagnostic-test-skip-string-");
    write(root, "test/data.test.js", [
      "const example = `it.skip('example', () => {})`;",
      "void example;",
      "",
    ].join("\n"));

    const result = checkTestQuality(root);

    assert.deepEqual(result.issues, []);
  });

  it("surfaces malformed source and test modules instead of silently skipping them", () => {
    const root = workspace("bantam-diagnostic-parse-failures-");
    write(root, "src/broken.js", "export const = ;\n");
    write(root, "test/broken.test.js", "import { from ;\n");

    const imports = checkImportHealth(root);
    const tests = checkTestQuality(root);

    assert.deepEqual(imports.issues, [{
      file: "broken.js",
      issue: "module parse failed at line 1",
    }]);
    assert.ok(tests.issues.some(({ issue }) => issue === "test module parse failed at line 1"));
  });

  it("derives documentation gaps from declarations rather than embedded source text", () => {
    const root = workspace("bantam-diagnostic-documentation-templates-");
    write(root, "src/templates.js", [
      "// Builder templates used by the self-improvement runner.",
      "/** Source text for a generated fixture module. */",
      "const source = `export function generated() {}\\nexport const generatedValue = true;`;",
      "/* export class ExampleOnly {} */",
      "export { source };",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, []);
  });

  it("requires JSDoc immediately before each direct exported API item", () => {
    const root = workspace("bantam-diagnostic-documentation-association-");
    write(root, "src/api.js", [
      "// Public API for the fixture.",
      "/** Return the first value. */",
      "export function first() { return 1; }",
      "export class Second {}",
      "/** This detached comment documents an internal detail. */",
      "const internal = true;",
      "export const third = internal;",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, [{
      file: "api.js",
      issue: "2 exported API items without JSDoc",
    }]);
  });

  it("reports multi-binding variable exports as API items rather than declarations", () => {
    const root = workspace("bantam-diagnostic-documentation-bindings-");
    write(root, "src/values.js", [
      "// Public values for the fixture.",
      "export const first = 1, second = 2;",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, [{
      file: "values.js",
      issue: "2 exported API items without JSDoc",
    }]);
  });

  it("accepts a module description after a shebang and documents async exports", () => {
    const root = workspace("bantam-diagnostic-documentation-shebang-");
    write(root, "src/runner.js", [
      "#!/usr/bin/env node",
      "",
      "// Development runner entry point.",
      "/** Run the development command. */",
      "export async function run() { return true; }",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, []);
  });

  it("does not demand local JSDoc for re-exports", () => {
    const root = workspace("bantam-diagnostic-documentation-reexports-");
    write(root, "src/index.js", [
      "// Public re-export surface.",
      "export { value } from './value.js';",
      "export * from './other.js';",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, []);
  });

  it("resolves source-less exports to their local declarations", () => {
    const root = workspace("bantam-diagnostic-documentation-local-exports-");
    write(root, "src/index.js", [
      "// Locally owned public API.",
      "const undocumented = 1;",
      "/** Documented where it is declared. */",
      "const locallyDocumented = 2;",
      "const exportDocumented = 3;",
      "/** Documented at its public export site. */",
      "export { exportDocumented };",
      "export { undocumented, locallyDocumented };",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, [{
      file: "index.js",
      issue: "1 exported API item without JSDoc",
    }]);
  });

  it("checks default value exports and accepts JSDoc immediately before a default identifier", () => {
    const root = workspace("bantam-diagnostic-documentation-defaults-");
    write(root, "src/value.js", [
      "// Public default configuration.",
      "export default { enabled: true };",
      "",
    ].join("\n"));
    write(root, "src/identifier.js", [
      "// Public named configuration.",
      "const config = { enabled: true };",
      "export default /** Public configuration value. */ config;",
      "",
    ].join("\n"));
    write(root, "src/global.js", [
      "// Public ambient configuration.",
      "export default globalConfiguration;",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, [
      { file: "global.js", issue: "1 exported API item without JSDoc" },
      { file: "value.js", issue: "1 exported API item without JSDoc" },
    ]);
  });

  it("rejects empty or punctuation-only JSDoc and pragma-only module headers", () => {
    const root = workspace("bantam-diagnostic-documentation-empty-");
    write(root, "src/empty-doc.js", [
      "// Public API fixture.",
      "/** */",
      "export function emptyDoc() {}",
      "",
    ].join("\n"));
    write(root, "src/pragma.js", [
      "/* global window */",
      "export * from './value.js';",
      "",
    ].join("\n"));
    write(root, "src/punctuation-doc.js", [
      "// Public API fixture.",
      "/** ! */",
      "export function punctuationDoc() {}",
      "",
    ].join("\n"));
    write(root, "src/licensed-description.js", [
      "/*",
      " * Copyright 2026 Example",
      " * Public licensed API for the fixture.",
      " */",
      "/** Public value. */",
      "export const licensed = true;",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, [
      { file: "empty-doc.js", issue: "1 exported API item without JSDoc" },
      { file: "pragma.js", issue: "no module description comment at top" },
      { file: "punctuation-doc.js", issue: "1 exported API item without JSDoc" },
    ]);
  });

  it("retains documentation across legal var redeclarations", () => {
    const root = workspace("bantam-diagnostic-documentation-var-redeclare-");
    write(root, "src/callback.js", [
      "// Callback API fixture.",
      "/** Invoke the public callback. */",
      "var callback = () => true;",
      "var callback;",
      "export { callback };",
      "",
    ].join("\n"));

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, []);
  });

  it("tracks malformed documentation scans without double-scoring them as gaps", () => {
    const root = workspace("bantam-diagnostic-documentation-malformed-");
    write(root, "src/broken.js", "export const broken = ;\n");

    const result = checkDocumentation(root);

    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.skipped, [{
      file: "broken.js",
      reason: "module parse failed at line 1",
    }]);
    assert.equal(result.severity, 1);
  });

  it("treats canonical passed=false as authoritative over legacy success=true", () => {
    const root = workspace("bantam-diagnostic-history-");
    write(root, ".bantam/self-improvements.json", JSON.stringify([
      { id: "candidate", passed: false, success: true },
      { id: "candidate", passed: false, success: true },
    ]));

    const result = checkImprovementVelocity(root);

    assert.match(result.detail, /^0\/2 improvements passed/);
    assert.deepEqual(result.stuck, [["candidate", { total: 2, failed: 2 }]]);
  });

  it("groups prototype-named improvement ids without polluting global objects", () => {
    const root = workspace("bantam-diagnostic-history-prototype-");
    write(root, ".bantam/self-improvements.json", JSON.stringify([
      { id: "__proto__", passed: false },
      { id: "__proto__", passed: false },
      { id: "constructor", passed: false },
      { id: "constructor", passed: false },
    ]));

    const result = checkImprovementVelocity(root);

    assert.deepEqual(result.stuck, [
      ["__proto__", { total: 2, failed: 2 }],
      ["constructor", { total: 2, failed: 2 }],
    ]);
    assert.equal(Object.hasOwn(Object.prototype, "total"), false);
    assert.equal(Object.hasOwn(Object.prototype, "failed"), false);
  });

  it("treats a non-array improvement log as malformed history", () => {
    const root = workspace("bantam-diagnostic-malformed-history-");
    write(root, ".bantam/self-improvements.json", JSON.stringify({ passed: true }));

    const result = checkImprovementVelocity(root);

    assert.equal(result.severity, 3);
    assert.match(result.detail, /No improvement history/);
  });

  it("reports an absent source directory as an invalid diagnostic target", () => {
    const root = workspace("bantam-diagnostic-missing-src-");
    fs.rmSync(path.join(root, "src"), { recursive: true });

    const coverage = checkTestCoverage(root);
    const report = runDiagnostics(root);

    assert.equal(coverage.severity, 5);
    assert.match(coverage.detail, /Source directory is missing/);
    assert.match(report.summary, /significant issues/);
  });
});
