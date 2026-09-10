import assert from "node:assert/strict";
import test from "node:test";

import { collateralRefusal } from "../src/collateral.js";
import { validateSourceTransition } from "../src/source-validation.js";

// Invariant (2026-08-16): a refusal always names where the problem is.
//
// Measured on the ticket-B rerun: the model sent the SAME edit_lines at
// src/agent.js:1513 four times, each refused with "valid JavaScript would
// become invalid", and burned 16 progressless turns. Its own reasoning shows
// why — "I need to find the exact line number", "the parser error about
// `export` appearing at the top level suggests…". The refusal reported where
// the GRAMMAR gave up (line 7, top level) which is nowhere near where the
// model went wrong (an unclosed brace inside its insertion). A location the
// model cannot act on is not a location.

const BEFORE = [
  "export function a() {",
  "  return 1;",
  "}",
  "",
  "export function b() {",
  "  return 2;",
  "}",
  "",
].join("\n");

// An inserted block that opens a brace it never closes: the parser survives to
// the next top-level `export` and blames that instead.
const AFTER_UNBALANCED = [
  "export function a() {",
  "  return 1;",
  "  if (misconfigured) {",
  "    return fail();",
  "}",
  "",
  "export function b() {",
  "  return 2;",
  "}",
  "",
].join("\n");

test("a syntax refusal names the parse position as file:line:column", () => {
  const result = validateSourceTransition({ path: "src/agent.js", before: BEFORE, after: AFTER_UNBALANCED });
  assert.equal(result.ok, false);
  assert.match(result.message, /src\/agent\.js:\d+:\d+/);
});

test("a syntax refusal names the edited span, not only the parser's stop", () => {
  const { message } = validateSourceTransition({ path: "src/agent.js", before: BEFORE, after: AFTER_UNBALANCED });
  assert.match(message, /changed src\/agent\.js lines 3-4/,
    "the model must be told which lines its own edit touched");
});

test("a syntax refusal says when the parser stopped outside the edit", () => {
  const { message } = validateSourceTransition({ path: "src/agent.js", before: BEFORE, after: AFTER_UNBALANCED });
  assert.match(message, /OUTSIDE that region/,
    "otherwise the model hunts for a defect at the wrong end of the file");
});

test("a syntax refusal names the delimiter imbalance it can see", () => {
  const { message } = validateSourceTransition({ path: "src/agent.js", before: BEFORE, after: AFTER_UNBALANCED });
  assert.match(message, /1 unclosed `\{`/);
});

test("delimiter counting ignores braces inside strings and comments", () => {
  const before = "export const x = 1;\n";
  const after = 'export const x = 1;\nconst brace = "{";\n// }\n';
  const result = validateSourceTransition({ path: "src/x.js", before, after });
  assert.equal(result.ok, true, "a balanced edit whose braces live in strings must not be refused");
});

test("a new file that cannot parse still names a position", () => {
  const { ok, message } = validateSourceTransition({ path: "src/new.js", before: null, after: "function ( {" });
  assert.equal(ok, false);
  assert.match(message, /src\/new\.js:\d+:\d+/);
});

test("a syntax refusal shows the staged result around the edit", () => {
  // Naming "1 unclosed `{`" is not the same as showing it. The model authored
  // its replacement blind and never sees how that text meets the lines around
  // it — which is exactly where the stray delimiter is legible. The ticket-B
  // rerun got the name, tried once more, and stopped.
  const { message } = validateSourceTransition({ path: "src/agent.js", before: BEFORE, after: AFTER_UNBALANCED });
  assert.match(message, /staged result around your edit/);
  assert.match(message, /> 3\t {2}if \(misconfigured\) \{/, "changed lines are marked");
  assert.match(message, /^ {2}1\texport function a\(\) \{$/m, "context above the edit is shown unmarked");
  assert.match(message, /^ {2}5\t\}$/m, "and the line below it, where the imbalance becomes visible");
});

test("a refused replacement shows the original closing boundary it would remove", () => {
  // Recorded long-project failure: the requested range began one line too
  // early and swallowed a check callback's `});`. The staged view alone
  // showed the new await in that now-unclosed, non-async callback.
  const before = [
    "async function main() {",
    "  await withGame(async () => {",
    "    check('prior case', () => {",
    "      assert.ok(true);",
    "    });",
    "    // next case",
    "    await nextCase();",
    "  });",
    "}",
  ].join("\n");
  const after = before.replace("    });\n    // next case", "    const result = await inspect();\n    // next case");
  const result = validateSourceTransition({ path: "test/cases.js", before, after });
  assert.equal(result.ok, false);
  assert.match(result.message, /Original source replaced by this proposal/);
  assert.match(result.message, /^- 5\t    \}\);$/m);
  assert.ok(result.message.indexOf("- 5\t") < result.message.indexOf("The staged result"),
    "the lost boundary must survive before a long staged excerpt is clipped");
  assert.match(result.message, /No files were changed/);
});

test("original-source diagnostics bound long replacements and omit pure insertions", () => {
  const before = Array.from({ length: 100 }, (_, i) => `const item${i} = ${JSON.stringify('x'.repeat(400))};`).join("\n");
  const result = validateSourceTransition({ path: "items.js", before, after: "function broken( {" });
  assert.equal(result.ok, false);
  const original = result.message.split("Original source replaced by this proposal")[1]?.split("The staged result")[0];
  assert.ok(original, "the removed source has a bounded view");
  assert.match(original, /^- 1\tconst item0/m);
  assert.match(original, /^- 100\tconst item99/m);
  assert.match(original, /94 original lines omitted/);
  assert.ok(original.length < 1500, `original excerpt was ${original.length} chars`);

  const inserted = validateSourceTransition({ path: "insert.js", before: "work();\n", after: "if (ready) {\nwork();\n" });
  assert.equal(inserted.ok, false);
  assert.doesNotMatch(inserted.message, /Original source replaced/);
  const created = validateSourceTransition({ path: "new.js", before: null, after: "function broken( {" });
  assert.equal(created.ok, false);
  assert.doesNotMatch(created.message, /Original source replaced/);
});

test("a long insertion shows head and tail, not the whole file", () => {
  const long = [
    "export function a() {",
    "  return 1;",
    ...Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`),
    "  if (x) {",
    "}",
    "",
    "export function b() {",
    "  return 2;",
    "}",
    "",
  ].join("\n");
  const { message } = validateSourceTransition({ path: "src/x.js", before: BEFORE, after: long });
  assert.match(message, /lines omitted …/);
  const shown = message.split("\n").filter((row) => /^[ >] \d+\t/.test(row));
  assert.ok(shown.length <= 24, `excerpt must stay bounded, got ${shown.length} lines`);
});

test("a collateral refusal names each doomed symbol's absolute line", () => {
  const removed = "function resolveGate(x) {\n  return x;\n}\n\nfunction gateName() {\n  return 't';\n}";
  const message = collateralRefusal({
    path: "src/gate.js",
    start: 1510,
    end: 1516,
    removed,
    replacement: "function resolveGate(x) {\n  return x;\n}",
  });
  // gateName sits on line 5 of the replaced region, so 1510 + 5 - 1.
  assert.match(message, /`gateName` \(src\/gate\.js:1514\)/);
});

test("a collateral refusal without a start line still locates the symbol", () => {
  const removed = "function resolveGate(x) {\n  return x;\n}\n\nfunction gateName() {\n  return 't';\n}";
  const message = collateralRefusal({
    path: "src/gate.js",
    removed,
    replacement: "function resolveGate(x) {\n  return x;\n}",
  });
  assert.match(message, /`gateName` \(line 5 of the replaced region\)/);
});

// tb6 (2026-08-16, .bantam/runs/2026-08-16T17-22-16-517Z.json) turn 28: the
// model inserted an `if` statement at line 696, among the properties of an
// object literal. acorn reported "Unexpected token" at 704:12 — thirty lines
// from anything readable as the cause — and it re-sent the identical edit. The
// staged excerpt showed the surrounding properties, but only to a reader who
// already suspected the shape. Naming the container states it outright.

const OBJECT_BEFORE = [
  "export function build(ground) {",
  "  const stats = {",
  "    enabled: Boolean(ground),",
  "    files: 0,",
  "    buildMs: 0,",
  "  };",
  "  return stats;",
  "}",
  "",
].join("\n");

test("a statement dropped into an object literal is told so", () => {
  const after = [
    "export function build(ground) {",
    "  const stats = {",
    "    enabled: Boolean(ground),",
    "  if (prefixes.length > 0) {",
    "    return { impossible: true };",
    "  }",
    "    files: 0,",
    "    buildMs: 0,",
    "  };",
    "  return stats;",
    "}",
    "",
  ].join("\n");
  const { ok, message } = validateSourceTransition({ path: "src/agent.js", before: OBJECT_BEFORE, after });
  assert.equal(ok, false);
  assert.match(message, /inside an object literal that opens at line 2/);
  assert.match(message, /a statement cannot appear there/);
});

test("an ordinary statement insertion inside a block gets no container note", () => {
  // A block is where statements belong; "you are inside a block" is noise.
  const after = [
    "export function build(ground) {",
    "  const stats = {",
    "    enabled: Boolean(ground),",
    "    files: 0,",
    "    buildMs: 0,",
    "  };",
    "  if (!stats) {",          // valid, but leave it unbalanced so the gate fires
    "  return stats;",
    "}",
    "",
  ].join("\n");
  const { ok, message } = validateSourceTransition({ path: "src/agent.js", before: OBJECT_BEFORE, after });
  assert.equal(ok, false, "precondition: this edit is genuinely broken");
  assert.doesNotMatch(message, /a statement cannot appear there/,
    "a block is where statements belong — naming it would be noise");
});

test("method and callback bodies do not inherit an outer expression's statement prohibition", () => {
  // A real local run's method edit left an extra closing brace. The gate
  // correctly refused it, but named the containing class as if the edit had
  // inserted a statement between methods. Bodies inside object/array/call
  // expressions have the same boundary: statements belong in the body.
  for (const [head, tail] of [
    ["export class Agent {\n  update() {", "  }\n}"],
    ["const agent = {\n  update() {", "  }\n};"],
    ["consume(() => {", "});"],
    ["const callbacks = [() => {", "}];"],
    ["class Agent {\n  static {", "  }\n}"],
  ]) {
    const before = `${head}\n    work();\n${tail}\n`;
    const after = before.replace("    work();", "    if (ready) {\n      work();");
    const result = validateSourceTransition({ path: "agent.js", before, after });
    assert.equal(result.ok, false, head);
    assert.match(result.message, /failed to parse:/, head);
    assert.match(result.message, /staged result around your edit/, head);
    assert.doesNotMatch(result.message, /a statement cannot appear there/, head);
  }
});

test("inner object properties and direct class members still identify an invalid statement location", () => {
  const before = "class Agent {\n  update() {\n    const values = {\n      count: 1,\n    };\n  }\n}\n";
  const after = before.replace("      count: 1,", "      if (ready) work();\n      count: 1,");
  const nested = validateSourceTransition({ path: "agent.js", before, after });
  assert.equal(nested.ok, false);
  assert.match(nested.message, /inside an object literal that opens at line 3/);
  const directBefore = "class Agent {\n  update() {}\n}\n";
  const direct = validateSourceTransition({ path: "agent.js", before: directBefore,
    after: directBefore.replace("  update() {}", "  if (ready) work();\n  update() {}") });
  assert.equal(direct.ok, false);
  assert.match(direct.message, /inside a class body that opens at line 1/);
});

test("the container note is skipped when the pre-edit file does not parse", () => {
  const broken = "export function a( {\n";
  const { ok, message } = validateSourceTransition({ path: "src/x.js", before: broken, after: "export function a( {\nif (x) {\n" });
  // An already-broken baseline passes the gate by design; if it ever refuses,
  // it must not invent a container from an unparseable tree.
  if (ok) return;
  assert.doesNotMatch(message, /a statement cannot appear there/);
});
