import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ChangeTracker,
  buildDependencyGraph,
  findAffectedFiles,
  impactScore,
  parseModule,
  predictBlastRadius,
  rankByImpact,
  suggestTests,
} from "../src/dependency-impact.js";

const temporary = new Set();

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-dependency-impact-"));
  temporary.add(directory);
  return directory;
}

function write(root, relative, source = "") {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
  return destination;
}

function graphFixture() {
  const workspace = fixture();
  const source = path.join(workspace, "src");
  write(source, "core.js", "export const core = true;\n");
  write(source, "bootstrap.js", "globalThis.ready = true;\n");
  write(source, "service.js", [
    'import { core } from "./core.js";',
    'import "./bootstrap.js";',
    'import "external-package";',
    "export function service() { return core; }",
    "",
  ].join("\n"));
  write(source, "nested/index.js", [
    'import { service } from "../service.js";',
    "export const nested = service();",
    "",
  ].join("\n"));
  write(source, "app.js", [
    'import { nested } from "./nested";',
    "console.log(nested);",
    "",
  ].join("\n"));
  write(source, "ignored.txt", 'import "./core.js";\n');
  fs.mkdirSync(path.join(source, "node_modules", "ignored"), { recursive: true });
  write(source, "node_modules/ignored/index.js", 'import "../../core.js";\n');
  return { workspace, source };
}

afterEach(() => {
  for (const directory of temporary) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporary.clear();
});

describe("dependency impact analysis", () => {
  it("parses static, re-exported, and dynamic module references with named exports", () => {
    const root = fixture();
    const file = write(root, "module.js", [
      'import { core } from "./core.js";',
      'export { helper } from "./helper.js";',
      'const lazy = import("./lazy.js");',
      "export const value = core;",
      "export function run() { return lazy; }",
      "export class Widget {}",
      "",
    ].join("\n"));

    assert.deepEqual(parseModule(file), {
      imports: ["./core.js", "./helper.js", "./lazy.js"],
      exports: ["helper", "value", "run", "Widget"],
      lineCount: 7,
    });
  });

  it("parses module syntax without treating comments or strings as dependency edges", () => {
    const root = fixture();
    const file = write(root, "syntax.js", [
      "// import './comment-only.js';",
      "const example = `export const fake = true; import('./string-only.js')`;",
      "import {",
      "  real,",
      "} from './real.js';",
      "export const { first, nested: [second] } = real;",
      "export { real as renamed };",
      "export default function active() { return example; }",
      "",
    ].join("\n"));

    assert.deepEqual(parseModule(file), {
      imports: ["./real.js"],
      exports: ["first", "second", "renamed", "default"],
      lineCount: 9,
    });
  });

  it("builds direct reverse edges for sibling, parent, extensionless, and index imports", () => {
    const { source } = graphFixture();
    const { graph, reverseGraph, fileCount } = buildDependencyGraph(source);

    assert.equal(fileCount, 5);
    assert.deepEqual([...graph.keys()].sort(), [
      "app.js",
      "bootstrap.js",
      "core.js",
      "nested/index.js",
      "service.js",
    ]);
    assert.deepEqual(reverseGraph.get("core.js"), ["service.js"]);
    assert.deepEqual(reverseGraph.get("bootstrap.js"), ["service.js"]);
    assert.deepEqual(reverseGraph.get("service.js"), ["nested/index.js"]);
    assert.deepEqual(reverseGraph.get("nested/index.js"), ["app.js"]);
    assert.deepEqual(graph.get("core.js").dependents, ["service.js"]);
  });

  it("walks transitive dependents once and excludes the changed file from cycles", () => {
    const reverse = new Map([
      ["a.js", ["b.js"]],
      ["b.js", ["c.js"]],
      ["c.js", ["a.js"]],
    ]);

    assert.deepEqual(
      findAffectedFiles("a.js", new Map(), reverse),
      ["b.js", "c.js"],
    );
    assert.deepEqual(findAffectedFiles("missing.js", new Map(), reverse), []);
  });

  it("scores and ranks impact from direct and transitive reach", () => {
    const graph = new Map([
      ["core.js", {}],
      ["service.js", {}],
      ["app.js", {}],
      ["leaf.js", {}],
    ]);
    const reverse = new Map([
      ["core.js", ["service.js"]],
      ["service.js", ["app.js"]],
      ["app.js", []],
      ["leaf.js", []],
    ]);

    assert.equal(impactScore("core.js", graph, reverse), 40);
    assert.equal(impactScore("service.js", graph, reverse), 25);
    assert.equal(impactScore("leaf.js", graph, reverse), 0);
    assert.deepEqual(rankByImpact(graph, reverse).map(({ file }) => file), [
      "core.js",
      "service.js",
      "app.js",
      "leaf.js",
    ]);
    assert.equal(impactScore("anything.js", new Map(), new Map()), 0);
  });

  it("separates direct and transitive blast radius and assigns risk boundaries", () => {
    const reverse = new Map([
      ["core.js", ["one.js", "two.js"]],
      ["one.js", ["three.js"]],
      ["two.js", []],
      ["three.js", []],
    ]);
    const blast = predictBlastRadius("core.js", new Map(), reverse);

    assert.deepEqual(blast, {
      changed: "core.js",
      directDependents: ["one.js", "two.js"],
      transitiveDependents: ["three.js"],
      totalAffected: 3,
      riskLevel: "medium",
    });
    assert.equal(predictBlastRadius("leaf.js", new Map(), reverse).riskLevel, "none");
  });

  it("suggests both established test filename conventions without duplicates", () => {
    const root = fixture();
    const testDir = path.join(root, "test");
    write(testDir, "core.test.js");
    write(testDir, "service-test.js");
    write(testDir, "nested/index.test.js");
    const reverse = new Map([
      ["core.js", ["service.js", "nested/index.js"]],
      ["service.js", []],
      ["nested/index.js", []],
    ]);

    assert.deepEqual(
      suggestTests("core.js", new Map(), reverse, testDir).sort(),
      [
        path.join(testDir, "core.test.js"),
        path.join(testDir, "nested", "index.test.js"),
        path.join(testDir, "service-test.js"),
      ].sort(),
    );
  });

  it("tracks repeated changes and reports their unique cumulative impact", () => {
    const { workspace } = graphFixture();
    const tracker = new ChangeTracker(workspace);

    assert.deepEqual(tracker.init(), { fileCount: 5 });
    assert.equal(tracker.recordChange("core.js", "first edit").totalAffected, 3);
    assert.equal(tracker.recordChange("core.js", "follow-up").totalAffected, 3);
    assert.deepEqual(tracker.cumulativeImpact(), {
      changes: 2,
      filesChanged: 1,
      totalAffected: 4,
      riskLevel: "medium",
    });
    assert.equal(
      tracker.report(),
      "Change Tracker: 2 changes, 1 files modified, 4 files affected (medium risk)",
    );
  });

  it("runs its direct self-check exactly once", () => {
    const modulePath = path.resolve("src/dependency-impact.js");
    const output = execFileSync(process.execPath, [modulePath], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    assert.equal((output.match(/Dependency Impact Analyzer/g) ?? []).length, 1);
    assert.match(output, /All tests passed\./);
  });
});
