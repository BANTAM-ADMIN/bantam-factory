import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createEditPreservationWitness, formatEditPreservationWitness, formatEditPreservationReview } from "../src/edit-preservation.js";

const before = "export function processItems(items) {\n  normalize(items);\n  validate(items);\n  return items;\n}\n";
const added = "\nfunction runCommand(args) {\n  return processItems(args);\n}\n";
const witness = (oldSource, newSource, options = {}) => createEditPreservationWitness({
  path: "worker.mjs", before: oldSource, after: newSource, ...options,
});

test("identifies executable statements lost while appending a separate feature", () => {
  const after = before.replace("  normalize(items);\n  validate(items);\n", "") + added;
  const receipt = witness(before, after);
  assert.equal(receipt.additiveReplacementRisk, true);
  assert.equal(receipt.removedStatementCount, 2);
  assert.equal(receipt.removedFromRetainedFunctions, 2);
  assert.equal(receipt.addedTopLevelFunctionCount, 1);
  assert.deepEqual(receipt.removed.map((row) => row.before.excerpt), ["normalize(items);", "validate(items);"]);
  assert.deepEqual(receipt.removed.map((row) => row.before.startLine), [2, 3]);
  assert.equal(receipt.removed[0].afterFunction.name, "processItems");
  assert.equal(receipt.removed[0].afterAnchor.startLine, 2);
  assert.equal(receipt.removed[0].afterAnchor.excerpt, "return items;");
  assert.equal(receipt.addedFunctions[0].name, "runCommand");
  assert.equal(receipt.scope, "source-structure-only");
  assert.equal(receipt.candidateVerified, false);
});

test("unchanged bodies and genuinely additive replacements stay silent", () => {
  assert.equal(witness(before, before), null);
  assert.equal(witness(before, before + added), null);
  assert.equal(witness(before, before.replace("validate(items);", "validate(items);\n  audit(items);") + added), null);
});

test("AST matching ignores whitespace, comments, quote spelling and numeric spelling", () => {
  assert.equal(witness("function f(){ emit('a', 1, 1n); return 1; }",
    'function f () { /* retained */ emit("a", 0x1, 0x1n)\n return 1\n }' + added), null);
  assert.equal(witness(before, before.replaceAll("  ", "\t").replaceAll(";", "; /* note */") + added), null);
});

test("moving or extracting unchanged statements is not an AST absence claim", () => {
  assert.equal(witness(before, before.replace("  normalize(items);\n  validate(items);", "  validate(items);\n  normalize(items);") + added), null);
  const extracted = before.replace("  normalize(items);\n  validate(items);", "  prepare(items);")
    + "\nfunction prepare(items) { normalize(items); validate(items); }\n";
  assert.equal(witness(before, extracted), null, "structural presence is not semantic equivalence");
});

test("a surviving duplicate does not hide removal of a second execution", () => {
  const receipt = witness("function f(){ emit(); emit(); }", "function f(){ emit(); }" + added);
  assert.equal(receipt.removedStatementCount, 1);
  assert.equal(receipt.additiveReplacementRisk, true);
  const crossOwner = witness("function f(){ emit(); } function g(){ emit(); }", "function f(){} function g(){ emit(); }" + added);
  assert.equal(crossOwner.removed[0].beforeFunction.name, "f");
});

test("ordinary refactors expose changed statements without assuming a bug or mandatory restoration", () => {
  const receipt = witness(before, before.replace("normalize(items);", "prepare(items);"));
  assert.equal(receipt.additiveReplacementRisk, false);
  assert.equal(receipt.removedStatementCount, 1);
  const text = formatEditPreservationWitness(receipt);
  assert.match(text, /Intentional removals\/refactors remain allowed/);
  assert.match(text, /NOT proof of a bug, preservation, or correctness/);
  assert.doesNotMatch(text, /must restore|refused|verification passed/i);
});

test("nested expression statements are reported without a wall of containing function code", () => {
  const oldSource = "function f(items){ for(const item of items){ record(item); validate(item); } return items; }";
  const receipt = witness(oldSource, oldSource.replace(" validate(item);", "") + added);
  assert.deepEqual(receipt.removed.map((row) => row.before.excerpt), ["validate(item);"]);
});

test("arrow function owners, CommonJS and resolved JS aliases are supported", () => {
  const oldSource = "const processItems = (items) => { validate(items); return items; };";
  const receipt = witness(oldSource, oldSource.replace("validate(items); ", "") + added);
  assert.equal(receipt.removed[0].afterFunction.name, "processItems");
  assert.ok(witness("module.exports = 1;", "module.exports = 2;", { path: "worker.cjs" }));
  assert.ok(witness(before, before.replace("normalize(items);", "") + added, { path: "alias.txt", runtimePath: "/trusted/worker.js" }));
});

test("ambiguous duplicate function owners do not enable an additive review policy", () => {
  const oldSource = "function f(){ emit(); } function f(){ keep(); }";
  const receipt = witness(oldSource, oldSource.replace("emit();", "") + added, { path: "worker.cjs" });
  assert.equal(receipt.additiveReplacementRisk, false);
  assert.equal(receipt.removed[0].afterFunction, null);
});

test("receipts bind exact source bytes and phase and contain serializable current locations", () => {
  const after = before.replace("  normalize(items);\n", "") + added;
  const receipt = witness(before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  assert.deepEqual(receipt, witness(before, after));
  assert.equal(receipt.before.sha256, createHash("sha256").update(before).digest("hex"));
  assert.equal(receipt.after.sha256, createHash("sha256").update(after).digest("hex"));
  const { id, ...body } = receipt;
  assert.equal(id, `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`);
  assert.notEqual(id, witness(before, after + "\n").id);
  assert.notEqual(id, witness(before, after, { phase: "applied" }).id);
  assert.match(formatEditPreservationWitness(receipt), /STAGED AFTER worker.mjs:2/);
  assert.match(formatEditPreservationWitness(witness(before, after, { phase: "applied" })), /CURRENT AFTER worker.mjs:2/);
});

test("precommit review allows exact-transition confirmation without certifying correctness", () => {
  const receipt = witness(before, before.replace("  normalize(items);\n", "") + added);
  const text = formatEditPreservationReview(receipt);
  assert.match(text, /No files were changed by this refused transaction/);
  assert.match(text, /reissue the identical edit/);
  assert.match(text, /not a correctness claim/);
  assert.ok(text.includes(receipt.id));
  assert.equal(formatEditPreservationReview(witness(before, before.replace("normalize(items);", "prepare(items);"))), "");
  assert.equal(formatEditPreservationReview(null), "");
});

test("bounded evidence reports omissions and skips unsupported or incomplete source", () => {
  const oldSource = "function f(){\n" + Array.from({ length: 30 }, (_, i) => `  execute${i}();\n`).join("") + "}\n";
  const receipt = witness(oldSource, "function f(){}\n" + added);
  assert.equal(receipt.removedStatementCount, 30);
  assert.equal(receipt.removed.length, 6);
  assert.equal(receipt.omittedRemovedStatements, 24);
  assert.ok(formatEditPreservationWitness(receipt).length < 2800);
  for (const [oldValue, newValue, options] of [
    [null, before, {}], [before, "function broken(", {}], ["function broken(", before, {}],
    [before, before + added, { path: "worker.py" }],
    [before, before + added, { runtimePath: "/trusted/worker.txt" }],
    [" ".repeat(256 * 1024 + 1), before, {}], [before, before + added, { phase: "invented" }],
  ]) assert.equal(witness(oldValue, newValue, options), null);
  assert.equal(formatEditPreservationWitness(null), "");
});

test("long paths and source excerpts cannot inflate model-facing review beyond its fixed budget", () => {
  const oldSource = "function f(){\n" + Array.from({ length: 12 }, (_, i) => `emit${i}('${"x".repeat(250)}');\n`).join("") + "return 1;\n}";
  const receipt = witness(oldSource, "function f(){ return 1; }" + added, { path: `${"a".repeat(236)}.mjs` });
  assert.ok(formatEditPreservationWitness(receipt).length <= 2800);
  assert.ok(formatEditPreservationReview(receipt).length <= 3400);
  assert.match(formatEditPreservationWitness(receipt), /more removed statements omitted/);
});

for (const method of ["order", "filter", "validate"]) {
  test(`retained call-chain contraction reports the actual ${method} operation without an added function`, () => {
    const oldSource = `export function build(xs){ return {items: xs.${method}(option).map(convert)}; }`;
    const newSource = "export function build(xs){ return {items: xs.map(convert)}; }";
    const receipt = witness(oldSource, newSource);
    assert.equal(receipt.additiveReplacementRisk, false);
    assert.equal(receipt.chainRemovalRisk, true);
    assert.equal(receipt.reviewRequired, true);
    assert.equal(receipt.removedOperationCount, 1);
    const row = receipt.removedOperations[0];
    assert.equal(row.method, method);
    assert.equal(row.removedArrayCopy, false);
    assert.equal(row.beforeFunction.name, "build");
    assert.equal(row.afterFunction.name, "build");
    assert.equal(row.operation.excerpt, `xs.${method}(option)`);
    assert.equal(row.operation.sourceSha256, createHash("sha256").update(row.operation.excerpt).digest("hex"));
    assert.match(row.after.excerpt, /xs\.map\(convert\)/);
    const rendered = formatEditPreservationReview(receipt);
    assert.ok(rendered.slice(0, 600).includes(`${method}()`));
    assert.match(rendered, /No files were changed|reissue the identical edit/);
    assert.match(rendered, /NOT proof of a bug/);
    assert.equal(receipt.candidateVerified, false);
  });
}

test("call-chain contraction can remove the exact simple spread-copy receiver with the intermediate call", () => {
  const oldSource = "function build(xs){ return {items: [...xs].order().map(x => ({name:x}))}; }";
  const newSource = "function build(xs){ return {items: xs.map(x => ({name:x}))}; }";
  const receipt = witness(oldSource, newSource);
  assert.equal(receipt.chainRemovalRisk, true);
  assert.equal(receipt.removedOperations[0].removedArrayCopy, true);
  assert.equal(receipt.removedOperations[0].operation.excerpt, "[...xs].order()");
  assert.match(formatEditPreservationWitness(receipt).slice(0, 600), /array-copy wrapper/);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  const { id, ...body } = receipt;
  assert.equal(id, `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`);
  assert.notEqual(id, witness(oldSource, newSource + "\n").id);
});

test("contraction matches a nested receiver while preserving every downstream operation", () => {
  const receipt = witness("function build(xs){ const result = xs.validate().filter(keep).map(convert); return result; }",
    "function build(xs){ const result = xs.filter(keep).map(convert); return result; }");
  assert.equal(receipt.chainRemovalRisk, true);
  assert.equal(receipt.removedOperations[0].method, "validate");
});

test("other changed expressions, callbacks, receivers and replacement operations are not contraction evidence", () => {
  const oldSource = "function build(xs){ return xs.filter(keep).map(convert); }";
  for (const newSource of [
    "function build(xs){ return false; }",
    "function build(xs){ return xs.map(different); }",
    "function build(xs){ return other.map(convert); }",
    "function build(xs){ return xs.select(keep).map(convert); }",
    "function build(xs){ return xs.map(convert, extra); }",
    "function renamed(xs){ return xs.map(convert); }",
  ]) {
    const receipt = witness(oldSource, newSource);
    assert.equal(receipt.chainRemovalRisk, false, newSource);
    assert.equal(receipt.reviewRequired, receipt.additiveReplacementRisk);
  }
  assert.equal(witness(oldSource, oldSource.replaceAll(" ", "  ")), null);
});

test("a moved call, a retained duplicate return, or ambiguous owners cannot impersonate a contraction", () => {
  const examples = [
    ["function f(xs){ return xs.order().map(convert); }", "function f(xs){ xs.order(); return xs.map(convert); }"],
    ["function f(xs){ return [...xs].order().map(convert); }", "function f(xs){ xs.order(); return xs.map(convert); }"],
    ["function f(xs){ return xs.order().map(convert); return xs.map(convert); }", "function f(xs){ return xs.map(convert); }"],
    ["function f(xs){ return xs.order().map(convert); } function f(xs){ return 1; }",
      "function f(xs){ return xs.map(convert); } function f(xs){ return 1; }"],
    ["function f(xs){ return xs.order().map(convert); return xs.order().map(convert); }",
      "function f(xs){ return xs.map(convert); }"],
  ];
  for (const [oldSource, newSource] of examples) {
    assert.equal(witness(oldSource, newSource, { path: "worker.cjs" }).chainRemovalRisk, false);
  }
});

test("contraction analysis is bounded and does not traverse a changed callback as the outer function", () => {
  const oldSource = "function f(xs){ return xs.map(x => x.order().map(convert)); }";
  assert.equal(witness(oldSource, oldSource.replace("x.order().map", "x.map")).chainRemovalRisk, false);
  assert.equal(witness(oldSource, "function incomplete("), null);
  const large = `function f(xs){ return xs.order().map(() => '${"x".repeat(17000)}'); }`;
  assert.equal(witness(large, large.replace("xs.order().map", "xs.map")).chainRemovalRisk, false);
  const many = "function f(xs){\n" + Array.from({ length: 70 }, (_, i) => `const x${i}=xs.op${i}().map(convert);`).join("\n") + "\n}";
  const contracted = many.replace(/\.op\d+\(\)/g, "");
  assert.equal(witness(many, contracted).chainRemovalRisk, false, "bounded-out analysis is not a certificate");
  const small = witness(many.split("\n").slice(0, 9).join("\n") + "\n}", contracted.split("\n").slice(0, 9).join("\n") + "\n}");
  assert.equal(small.removedOperationCount, 8);
  assert.equal(small.removedOperations.length, 6);
  assert.equal(small.omittedRemovedOperations, 2);
  assert.ok(formatEditPreservationWitness(small).length <= 2800);
  assert.ok(formatEditPreservationReview(small).length <= 3400);
});
