import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { CrossFilePatterns } from "../src/cross-file-patterns.js";

const temporary = new Set();

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cross-file-patterns-"));
  temporary.add(directory);
  return directory;
}

function write(root, relative, source) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function sourceFile(file, text) {
  return { file, text, lines: text.split("\n") };
}

function pattern(scanner, type) {
  return scanner.patterns.find((item) => item.type === type);
}

afterEach(() => {
  for (const directory of temporary) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporary.clear();
});

describe("cross-file pattern detection", () => {
  it("recursively scans only the selected extension and resets prior results", () => {
    const root = fixture();
    write(root, "a.js", "export const a = 1;\n");
    write(root, "nested/b.js", "export const b = 2;\n");
    write(root, "nested/c.mjs", "export const c = 3;\n");
    write(root, "ignored.txt", "export const ignored = true;\n");
    const scanner = new CrossFilePatterns();

    scanner.scan(root);
    assert.deepEqual([...scanner.files].sort(), ["a.js", path.join("nested", "b.js")]);

    scanner.scan(root, ".mjs");
    assert.deepEqual(scanner.files, [path.join("nested", "c.mjs")]);
    assert.equal(scanner.summary().files, 1);
  });

  it("reports imports repeated across three files and a class-heavy ratio", () => {
    const root = fixture();
    for (const name of ["a", "b", "c"]) {
      write(root, `${name}.js`, [
        'import { shared } from "./shared.js";',
        `export function ${name}() { return shared; }`,
        "",
      ].join("\n"));
    }
    const scanner = new CrossFilePatterns();
    scanner.scan(root);

    assert.deepEqual(pattern(scanner, "repeated-imports"), {
      type: "repeated-imports",
      count: 1,
      examples: ['import { shared } from "./shared.js";'],
    });
    assert.deepEqual(pattern(scanner, "class-heavy"), {
      type: "class-heavy",
      ratio: 1,
    });
    assert.equal(scanner.summary().byType["repeated-imports"], 1);
    assert.equal(scanner.summary().byType["class-heavy"], 1);
  });

  it("detects copied function logic only across distinct files", () => {
    const body = [
      "function calculate(input) {",
      "  const normalized = String(input).trim().toLowerCase();",
      "  const pieces = normalized.split(/\\s+/);",
      "  return pieces.filter(Boolean).join('-');",
      "}",
      "",
    ].join("\n");
    const scanner = new CrossFilePatterns();

    scanner.detectDuplicateLogic([
      sourceFile("one.js", `${body}\n${body}`),
      sourceFile("two.js", body),
    ]);

    const duplicate = pattern(scanner, "duplicate-logic");
    assert.equal(duplicate.count, 2);
    assert.deepEqual(duplicate.examples[0].files, ["one.js", "two.js"]);
    assert.equal(duplicate.examples[0].similarity, 1);
  });

  it("finds modules with several private definitions and no exports", () => {
    const scanner = new CrossFilePatterns();
    const text = [
      "const first = 1;",
      "function second() {}",
      "class Third {}",
      "",
    ].join("\n");

    scanner.detectMissingExports([sourceFile("private.js", text)]);

    assert.deepEqual(pattern(scanner, "missing-exports"), {
      type: "missing-exports",
      count: 1,
      examples: [{ file: "private.js", defs: 3, exports: 0 }],
    });
  });

  it("checks imported local bindings outside all import declarations", () => {
    const scanner = new CrossFilePatterns();
    const text = [
      'import { remote as used } from "./first.js";',
      'import { unused, alsoUnused as localUnused } from "./second.js";',
      "console.log(used);",
      "",
    ].join("\n");

    scanner.detectUnusedImports([sourceFile("consumer.js", text)]);

    assert.deepEqual(pattern(scanner, "unused-imports"), {
      type: "unused-imports",
      count: 2,
      examples: [
        { file: "consumer.js", import: "unused" },
        { file: "consumer.js", import: "localUnused" },
      ],
    });
  });

  it("reports functions over forty lines with their measured span", () => {
    const scanner = new CrossFilePatterns();
    const lines = [
      "function oversized() {",
      ...Array.from({ length: 41 }, (_, index) => `  value += ${index};`),
      "}",
    ];

    scanner.detectLongFunctions([sourceFile("large.js", lines.join("\n"))]);

    assert.deepEqual(pattern(scanner, "long-functions"), {
      type: "long-functions",
      count: 1,
      examples: [{ file: "large.js", function: "oversized", lines: 43 }],
    });
  });

  it("summarizes inconsistent try/catch density across a module family", () => {
    const scanner = new CrossFilePatterns();
    const files = Array.from({ length: 6 }, (_, index) => {
      const tries = index === 0 ? Array.from({ length: 6 }, () => "try { work(); } catch {}") : [];
      return sourceFile(`file-${index}.js`, [...tries, "throw new Error('x');"].join("\n"));
    });

    scanner.detectInconsistentErrorHandling(files);

    assert.deepEqual(pattern(scanner, "inconsistent-error-handling"), {
      type: "inconsistent-error-handling",
      count: 6,
      avgTry: 1,
    });
  });
});
