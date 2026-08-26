import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Executor } from "../src/executor.js";
import {
  isJavaScriptPath,
  parseJavaScript,
  validateSourceTransition,
} from "../src/source-validation.js";

const temporary = [];

function workspace(prefix = "bantam-source-validation-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

afterEach(() => {
  while (temporary.length) {
    fs.rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

describe("JavaScript source parsing", () => {
  it("recognizes supported extensions case-insensitively", () => {
    for (const file of ["a.js", "a.MJS", "a.cJs"]) {
      assert.equal(isJavaScriptPath(file), true);
    }
    for (const file of ["a.ts", "README.md", null, undefined]) {
      assert.equal(isJavaScriptPath(file), false);
    }
  });

  it("enforces fixed mjs/cjs modes and reports syntax locations", () => {
    assert.deepEqual(
      parseJavaScript("export const value = 1;", "module.mjs"),
      { ok: true, sourceType: "module" },
    );
    assert.equal(parseJavaScript("export const value = 1;", "module.cjs").ok, false);
    const broken = parseJavaScript("const value = ;", "module.js");
    assert.equal(broken.ok, false);
    assert.equal(broken.error.loc.line, 1);
  });

  it("uses the nearest package boundary for ordinary js files", () => {
    const root = workspace();
    const moduleDir = path.join(root, "module");
    const scriptDir = path.join(root, "script");
    fs.mkdirSync(moduleDir);
    fs.mkdirSync(scriptDir);
    fs.writeFileSync(path.join(moduleDir, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(scriptDir, "package.json"), '{"type":"commonjs"}');

    assert.equal(parseJavaScript(
      "export const value = 1;",
      "file.js",
      { runtimePath: path.join(moduleDir, "file.js") },
    ).sourceType, "module");
    assert.equal(parseJavaScript(
      "export const value = 1;",
      "file.js",
      { runtimePath: path.join(scriptDir, "file.js") },
    ).ok, false);
  });
});

describe("transactional source transitions", () => {
  it("rejects new invalid JavaScript and valid-to-invalid transitions", () => {
    const created = validateSourceTransition({
      path: "new.js",
      before: null,
      after: "export const value = ;",
    });
    assert.equal(created.ok, false);
    assert.equal(created.applicable, true);
    assert.match(created.message, /new JavaScript files must parse/);

    const changed = validateSourceTransition({
      path: "existing.js",
      before: "export const value = 1;",
      after: "export const value = ;",
    });
    assert.equal(changed.ok, false);
    assert.match(changed.message, /existing\.js:1:/);
    assert.match(changed.message, /valid JavaScript would become invalid/);
  });

  it("allows incremental repair of an already-invalid baseline", () => {
    assert.deepEqual(validateSourceTransition({
      path: "repair.js",
      before: "export const value = ;",
      after: "export const value = another + ;",
    }), {
      ok: true,
      applicable: true,
      baselineInvalid: true,
    });
  });

  it("classifies an alias by the resolved runtime target while keeping diagnostics lexical", () => {
    const root = workspace();
    const actualSource = path.join(root, "actual.js");
    const actualDocument = path.join(root, "actual.md");
    fs.writeFileSync(actualSource, "export const value = 1;\n");
    fs.writeFileSync(actualDocument, "function is prose\n");

    const guarded = validateSourceTransition({
      path: "alias.md",
      runtimePath: actualSource,
      before: "export const value = 1;",
      after: "export const value = ;",
    });
    assert.equal(guarded.ok, false);
    assert.equal(guarded.applicable, true);
    assert.match(guarded.message, /alias\.md/);
    assert.doesNotMatch(guarded.message, new RegExp(actualSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.deepEqual(validateSourceTransition({
      path: "alias.js",
      runtimePath: actualDocument,
      before: "function is prose",
      after: "function remains prose",
    }), {
      ok: true,
      applicable: false,
    });
  });

  it("handles an absent specimen as a non-applicable transition", () => {
    assert.deepEqual(validateSourceTransition(), { ok: true, applicable: false });
  });

  it("prevents an in-workspace document alias from corrupting JavaScript", () => {
    const root = workspace();
    const target = path.join(root, "actual.js");
    const alias = path.join(root, "alias.md");
    const before = [
      "export function calculate() {",
      "  return true;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(target, before);
    fs.symlinkSync("actual.js", alias);
    const executor = new Executor(root);

    const observation = executor.replace({
      p: "alias.md",
      old: "return true;",
      new: "return (;",
    });

    assert.match(observation, /valid JavaScript would become invalid/);
    assert.match(observation, /alias\.md/);
    assert.equal(fs.readFileSync(target, "utf8"), before);
  });
});
