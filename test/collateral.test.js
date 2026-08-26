import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collateralRefusal, lostSymbols, symbolsIn } from "../src/collateral.js";
import { Executor } from "../src/executor.js";

function tempDirectory(t, prefix = "bantam-collateral-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

describe("collateral symbol detection", () => {
  it("recognizes supported declarations and command branches in source order", () => {
    const source = [
      "function plain() {}",
      "async function* stream() {}",
      "class Widget {}",
      "const viaFunction = function inner() {};",
      "let viaClass = class {};",
      "var parenthesized = async (value) => value;",
      "const single = value => value;",
      "async def python_worker():",
      "    pass",
      'if (cmd === "build-now") {}',
      "switch (cmd) { case 'deploy:v2': break; }",
    ].join("\n");

    assert.deepEqual([...symbolsIn(source)], [
      "plain",
      "stream",
      "Widget",
      "viaFunction",
      "inner",
      "viaClass",
      "parenthesized",
      "single",
      "python_worker",
      "build-now",
      "deploy:v2",
    ]);
  });

  it("ignores declaration-shaped text in comments, strings, templates, regexes, and Python docstrings", () => {
    const source = [
      "// function lineComment() {}",
      "/* class BlockComment {} */",
      "# def python_comment():",
      "value = 1# function tight_python_comment():",
      'const quoted = "function quotedOnly() {}";',
      "const templated = `class TemplateOnly {}`;",
      String.raw`const expression = /function regexOnly\(\)/;`,
      String.raw`if (ready) /function statementRegexOnly\(\)/.test(input);`,
      "'''",
      "def triple_single_only():",
      "'''",
      '"""def triple_double_only(): pass"""',
      'const branchText = "cmd === \\"fake-command\\"; case \\"fake-case\\":";',
      "function realDeclaration() {}",
    ].join("\n");

    assert.deepEqual([...symbolsIn(source)], ["realDeclaration"]);
  });

  it("recognizes declarations in template interpolations but not template prose", () => {
    const source = [
      "const message = `function proseOnly() {} ${function interpolated() { return 1; }}`;",
      "function outside() {}",
    ].join("\n");

    assert.deepEqual([...symbolsIn(source)], ["interpolated", "outside"]);
  });

  it("deduplicates names while retaining the first textual occurrence", () => {
    const source = [
      "class First {}",
      "function second() {}",
      "function First() {}",
      "const second = () => {};",
    ].join("\n");

    assert.deepEqual([...symbolsIn(source)], ["First", "second"]);
  });

  it("returns fresh sets and does not retain caller mutation", () => {
    const first = symbolsIn("function stable() {}");
    first.clear();

    const second = symbolsIn("function stable() {}");
    assert.deepEqual([...second], ["stable"]);
    assert.notStrictEqual(first, second);
  });

  it("coerces nullish and primitive specimens without throwing", () => {
    assert.deepEqual([...symbolsIn(null)], []);
    assert.deepEqual([...symbolsIn(undefined)], []);
    assert.deepEqual([...symbolsIn(42)], []);
  });
});

describe("collateral loss and refusal decisions", () => {
  it("does not accept comments or strings as preservation of real code", () => {
    const removed = [
      "function kept() {}",
      "class LostClass {}",
      'if (cmd === "ship") {}',
    ].join("\n");
    const replacement = [
      "function kept() {}",
      '// class LostClass {}',
      'const note = "cmd === \\"ship\\"";',
    ].join("\n");

    assert.deepEqual(lostSymbols(removed, replacement), ["LostClass", "ship"]);
  });

  it("returns no refusal when all named code remains", () => {
    const removed = "function alpha() {}\nclass Beta {}";
    const replacement = "class Beta {}\nfunction alpha() { return true; }";

    assert.equal(collateralRefusal({
      path: "src/example.js",
      removed,
      replacement,
    }), "");
  });

  it("reports deterministic names, a valid line range, and removed line count", () => {
    const input = Object.freeze({
      path: "src/example.js",
      start: 8,
      end: 10,
      removed: "class Earlier {}\nfunction Later() {}\n",
      replacement: "",
    });

    const first = collateralRefusal(input);
    const second = collateralRefusal(input);

    assert.equal(first, second);
    assert.match(first, /DELETE 2 named thing\(s\)/);
    assert.match(first, /`Earlier`, `Later`/);
    assert.match(first, /src\/example\.js:8-10 \(3 lines\)/);
    assert.deepEqual(input, {
      path: "src/example.js",
      start: 8,
      end: 10,
      removed: "class Earlier {}\nfunction Later() {}\n",
      replacement: "",
    });
  });

  it("handles malformed calls and does not print invalid ranges", () => {
    assert.equal(collateralRefusal(), "");
    assert.equal(collateralRefusal(null), "");

    const unknown = collateralRefusal({
      path: null,
      start: 0,
      end: -1,
      removed: "function missing() {}",
      replacement: "",
    });
    assert.match(unknown, /You targeted \(unknown path\);/);
    assert.doesNotMatch(unknown, /:0--1/);
  });

  it("exempts document extensions case-insensitively", () => {
    for (const documentPath of [
      "README.md",
      "guide.MDX",
      "notes.rst",
      "design.ADOC",
      "report.txt",
    ]) {
      assert.equal(collateralRefusal({
        path: documentPath,
        removed: "the function is synchronous\nclass is a category",
        replacement: "",
      }), "");
    }
  });

  it("uses a resolved classification path without exposing it in diagnostics", () => {
    const refusal = collateralRefusal({
      path: "docs/alias.md",
      classificationPath: "/private/workspace/src/actual.js",
      removed: "function guarded() {}",
      replacement: "",
    });
    assert.match(refusal, /docs\/alias\.md/);
    assert.doesNotMatch(refusal, /\/private\/workspace/);

    assert.equal(collateralRefusal({
      path: "src/alias.js",
      classificationPath: "/private/workspace/docs/actual.md",
      removed: "function proseExample() {}",
      replacement: "",
    }), "");
  });
});

describe("Executor collateral integration", () => {
  it("refuses a named deletion without mutation, then accepts the identical confirmation", (t) => {
    const workspace = tempDirectory(t);
    const target = path.join(workspace, "module.js");
    const before = "function doomed() {}\nconst retained = 1;\n";
    fs.writeFileSync(target, before);
    const executor = new Executor(workspace);
    const action = {
      p: "module.js",
      old: "function doomed() {}\n",
      new: "",
    };

    const refusal = executor.replace(action);
    assert.match(refusal, /would DELETE 1 named thing/);
    assert.equal(fs.readFileSync(target, "utf8"), before);

    assert.match(executor.replace(action), /replaced 1 occurrence/);
    assert.equal(fs.readFileSync(target, "utf8"), "const retained = 1;\n");
  });

  it("binds confirmation to the exact deletion and clears it after a different edit", (t) => {
    const workspace = tempDirectory(t);
    const target = path.join(workspace, "module.js");
    fs.writeFileSync(target, [
      "function alpha() {}",
      "function beta() {}",
      "const value = 1;",
      "",
    ].join("\n"));
    const executor = new Executor(workspace);

    assert.match(executor.replace({
      p: "module.js", old: "function alpha() {}\n", new: "",
    }), /`alpha`/);
    assert.match(executor.replace({
      p: "module.js", old: "const value = 1;", new: "const value = 2;",
    }), /replaced 1 occurrence/);
    assert.match(executor.replace({
      p: "module.js", old: "function alpha() {}\n", new: "",
    }), /`alpha`/);
    assert.match(executor.replace({
      p: "module.js", old: "function beta() {}\n", new: "",
    }), /`beta`/);

    assert.match(executor.replace({
      p: "module.js", old: "function beta() {}\n", new: "",
    }), /replaced 1 occurrence/);
    assert.match(fs.readFileSync(target, "utf8"), /function alpha/);
    assert.doesNotMatch(fs.readFileSync(target, "utf8"), /function beta/);
  });

  it("keeps a multi-file patch atomic across a collateral refusal", (t) => {
    const workspace = tempDirectory(t);
    const first = path.join(workspace, "first.js");
    const second = path.join(workspace, "second.js");
    const firstBefore = "function doomed() {}\nconst first = 1;\n";
    const secondBefore = "const second = 1;\n";
    fs.writeFileSync(first, firstBefore);
    fs.writeFileSync(second, secondBefore);
    const executor = new Executor(workspace);
    const action = {
      edits: [
        { p: "first.js", old: "function doomed() {}\n", new: "" },
        { p: "second.js", old: "const second = 1;", new: "const second = 2;" },
      ],
    };

    assert.match(executor.patch(action), /would DELETE 1 named thing/);
    assert.equal(fs.readFileSync(first, "utf8"), firstBefore);
    assert.equal(fs.readFileSync(second, "utf8"), secondBefore);

    assert.match(executor.patch(action), /patched 2 edits across 2 files/);
    assert.equal(fs.readFileSync(first, "utf8"), "const first = 1;\n");
    assert.equal(fs.readFileSync(second, "utf8"), "const second = 2;\n");
  });

  it("classifies an in-workspace document alias by its resolved source target", (t) => {
    const workspace = tempDirectory(t);
    const target = path.join(workspace, "actual.js");
    const alias = path.join(workspace, "alias.md");
    const before = "function protectedByTargetType() {}\nconst retained = true;\n";
    fs.writeFileSync(target, before);
    fs.symlinkSync("actual.js", alias);
    const executor = new Executor(workspace);

    const result = executor.replace({
      p: "alias.md",
      old: "function protectedByTargetType() {}\n",
      new: "",
    });

    assert.match(result, /would DELETE 1 named thing/);
    assert.match(result, /alias\.md/);
    assert.equal(fs.readFileSync(target, "utf8"), before);
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  });

  it("does not carry a confirmation across a symlink retarget", (t) => {
    const workspace = tempDirectory(t);
    const firstTarget = path.join(workspace, "first.js");
    const secondTarget = path.join(workspace, "second.js");
    const alias = path.join(workspace, "alias.md");
    const before = "function sameText() {}\nconst retained = true;\n";
    fs.writeFileSync(firstTarget, before);
    fs.writeFileSync(secondTarget, before);
    fs.symlinkSync("first.js", alias);
    const executor = new Executor(workspace);
    const action = {
      p: "alias.md",
      old: "function sameText() {}\n",
      new: "",
    };

    assert.match(executor.replace(action), /would DELETE 1 named thing/);
    fs.unlinkSync(alias);
    fs.symlinkSync("second.js", alias);

    assert.match(executor.replace(action), /would DELETE 1 named thing/);
    assert.equal(fs.readFileSync(firstTarget, "utf8"), before);
    assert.equal(fs.readFileSync(secondTarget, "utf8"), before);

    assert.match(executor.replace(action), /replaced 1 occurrence/);
    assert.equal(fs.readFileSync(firstTarget, "utf8"), before);
    assert.equal(fs.readFileSync(secondTarget, "utf8"), "const retained = true;\n");
  });

  it("rejects traversal and escaping symlinks before any collateral mutation", async (t) => {
    const workspace = tempDirectory(t, "bantam-collateral-workspace-");
    const outside = tempDirectory(t, "bantam-collateral-outside-");
    const outsideTarget = path.join(outside, "outside.js");
    const before = "function outsideFunction() {}\n";
    fs.writeFileSync(outsideTarget, before);
    fs.symlinkSync(outsideTarget, path.join(workspace, "escape.js"));
    const executor = new Executor(workspace);

    const traversal = await executor.execute({
      a: "replace",
      p: path.relative(workspace, outsideTarget),
      old: before,
      new: "",
    });
    assert.match(traversal.observation, /path escapes workspace/);

    const symlink = await executor.execute({
      a: "replace",
      p: "escape.js",
      old: before,
      new: "",
    });
    assert.match(symlink.observation, /path escapes workspace/);
    assert.equal(fs.readFileSync(outsideTarget, "utf8"), before);
  });
});
