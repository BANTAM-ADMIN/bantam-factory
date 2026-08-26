import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { scanWeaknesses } from "../src/self-improve.js";

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

function candidate(root, id) {
  return scanWeaknesses(root).find((entry) => entry.id === id);
}

afterEach(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
  temporary.clear();
});

describe("self-improvement weakness signal accuracy", () => {
  it("does not call repetition within one file cross-file duplication", () => {
    const root = workspace("bantam-improve-dedupe-single-");
    const repeated = [
      "const firstValueWithEnoughCharactersToQualify = source.firstValue;",
      "const secondValueWithEnoughCharactersToQualify = source.secondValue;",
      "return firstValueWithEnoughCharactersToQualify + secondValueWithEnoughCharactersToQualify;",
    ].join("\n");
    write(root, "src/repeated.js", [
      "export function one(source) {",
      repeated,
      "}",
      "export function two(source) {",
      repeated,
      "}",
      "export function three(source) {",
      repeated,
      "}",
      "",
    ].join("\n"));

    assert.equal(candidate(root, "dedupe-patterns"), undefined);
  });

  it("reports the same substantial pattern found in three distinct files", () => {
    const root = workspace("bantam-improve-dedupe-cross-file-");
    const repeated = [
      "const firstValueWithEnoughCharactersToQualify = source.firstValue;",
      "const secondValueWithEnoughCharactersToQualify = source.secondValue;",
      "return firstValueWithEnoughCharactersToQualify + secondValueWithEnoughCharactersToQualify;",
    ].join("\n");
    for (const name of ["one", "two", "three"]) {
      write(root, `src/${name}.js`, [
        `export function ${name}(source) {`,
        repeated,
        "}",
        "",
      ].join("\n"));
    }

    const dedupe = candidate(root, "dedupe-patterns");
    assert.match(dedupe.problem, /3 distinct files/);
    assert.deepEqual(dedupe.targets, ["one.js", "three.js", "two.js"]);
    assert.deepEqual(dedupe.patternEvidence[0].files, ["one.js", "three.js", "two.js"]);
  });

  it("does not count shared section-comment scaffolding as duplicated logic", () => {
    const root = workspace("bantam-improve-dedupe-comments-");
    for (const name of ["one", "two", "three"]) {
      write(root, `src/${name}.js`, [
        "// ---------------------------------------------------------------------------",
        "// TESTS",
        "// ---------------------------------------------------------------------------",
        `export const ${name} = true;`,
        "",
      ].join("\n"));
    }

    assert.equal(candidate(root, "dedupe-patterns"), undefined);
  });

  it("does not mistake ordinary filesystem calls for missing error handling", () => {
    const root = workspace("bantam-improve-errors-");
    write(root, "src/files.js", [
      "import fs from 'node:fs';",
      "export function readMany(paths) {",
      "  return paths.map((entry) => fs.readFileSync(entry, 'utf8'));",
      "}",
      "",
    ].join("\n"));

    assert.equal(candidate(root, "error-handling"), undefined);

    write(root, "src/silent.js", [
      "export function silentlyIgnore() {",
      "  try { throw new Error('failure'); } catch {}",
      "}",
      "",
    ].join("\n"));
    const errorHandling = candidate(root, "error-handling");
    assert.match(errorHandling.problem, /1 undocumented empty catch/);
    assert.deepEqual(errorHandling.targets, ["silent.js"]);
  });

  it("bases coverage proposals on parsed imports instead of comments", () => {
    const root = workspace("bantam-improve-coverage-");
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      write(root, `src/${name}.js`, `export const ${name} = ${JSON.stringify(name)};\n`);
    }
    write(root, "test/a.test.js", [
      "/* import '../src/b.js'; is an example, not coverage */",
      "import {",
      "  a,",
      "} from '../src/a.js';",
      "void a;",
      "",
    ].join("\n"));

    const coverage = candidate(root, "test-coverage");
    assert.match(coverage.problem, /^5 source files/);
    assert.match(coverage.proposal, /b\.js/);
    assert.deepEqual(coverage.targets, ["b.js"]);
  });

  it("does not throw when source or test paths are absent or non-directories", () => {
    const missing = path.join(os.tmpdir(), `bantam-improve-missing-${process.pid}-${Date.now()}`);
    assert.deepEqual(scanWeaknesses(missing), []);

    const root = workspace("bantam-improve-malformed-dirs-");
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src"), "not a directory");
    assert.deepEqual(scanWeaknesses(root), []);
  });
});
