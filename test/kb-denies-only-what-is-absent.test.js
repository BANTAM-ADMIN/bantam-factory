import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGrounding } from "../src/logic/grounding.js";
import { codeTool } from "../src/logic/tools.js";

// The KB indexes DECLARATIONS — function, class, const, let. A symbol that
// threads through the codebase as an object property has no declaration record,
// and `defines` answered that with "is not defined anywhere in the code KB":
// a flat denial of something the model can see in its own search results.
//
// Measured over the 33 identifiers searched 3+ times inside a single run (500 of
// the corpus's 1,543 search ops): `defines` denied 20 of them, and 8 of those
// occur in the source. `reachedDone` is denied. `editableMatchesNothing` — set
// at src/fixture-runner.js:330, read as `guard.editableMatchesNothing` — was
// searched 82 times.
//
// This matters more since the repeated-search steer shipped: it tells a model
// that has searched one identifier three times to run `defines`/`uses`. Routing
// it from a search that finds the symbol into a denial that it exists would
// make the harness lie to it at exactly the moment it asked for help.
//
// The distinction the answer has to carry is declaration-vs-occurrence, and the
// absent case has to stay sharply available: a model searching a name it
// invented needs to hear that the string is nowhere, which is the strongest
// answer the KB can give and is worth more than the denial it replaces.

function repoWithAPropertySymbol(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-props-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/runner.js"), [
    "export function buildGuard(spec) {",
    "  return {",
    "    editable: spec.editable,",
    "    editableMatchesNothing: !spec.editable.length,",
    "  };",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "src/agent.js"), [
    "import { buildGuard } from './runner.js';",
    "export function redirect(spec) {",
    "  const guard = buildGuard(spec);",
    "  if (guard.editableMatchesNothing) return 'the scope is broken';",
    "  return null;",
    "}",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return codeTool(buildGrounding(dir));
}

test("a property-style symbol is not reported as undefined", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("defines editableMatchesNothing"));
  assert.doesNotMatch(
    answer,
    /is not defined anywhere/,
    `the symbol is set in src/runner.js and read in src/agent.js; got: ${answer}`,
  );
});

test("having no declaration record names where the symbol does occur", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("defines editableMatchesNothing"));
  assert.match(answer, /src\/runner\.js:4/, `should name the site that sets it; got: ${answer}`);
  assert.match(answer, /src\/agent\.js:4/, `should name the site that reads it; got: ${answer}`);
});

test("a symbol that occurs nowhere is still answered outright", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("defines impossibleScopeDiagnosis"));
  assert.match(
    answer,
    /nowhere|no occurrence|does not appear/i,
    `an invented name should be denied plainly; got: ${answer}`,
  );
});

test("uses does not call a property symbol undefined beside its own site list", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("uses editableMatchesNothing"));
  assert.doesNotMatch(
    answer,
    /not defined in this workspace/,
    `it is defined — as a property; got: ${answer}`,
  );
  assert.match(answer, /src\/agent\.js:4/, `the read site is a use; got: ${answer}`);
});

// The absent answer is the strongest thing the KB says, so its scope has to be
// visible. The fact index walks a fixed extension list (.js/.ts/.py and kin), so
// in a repo written outside that list it holds zero files — and "does not appear
// anywhere" would be the same overclaim in a new costume.
//
// This one PASSED before the change: an empty-KB guard already answered that
// case by naming its own scope. The pin is here because the denial wording it
// sits beside just moved, and the next edit to it should not quietly take the
// guard's honesty with it.
test("a workspace the KB indexes nothing in says so instead of denying the symbol", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-golang-"));
  fs.mkdirSync(path.join(dir, "internal"), { recursive: true });
  fs.writeFileSync(path.join(dir, "internal/guard.go"), [
    "package internal",
    "",
    "func EditableMatchesNothing(spec Spec) bool {",
    "\treturn len(spec.Editable) == 0",
    "}",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answer = String(codeTool(buildGrounding(dir)).answer("defines EditableMatchesNothing"));
  assert.doesNotMatch(answer, /is not defined anywhere|does not appear/, `got: ${answer}`);
  assert.match(
    answer,
    /no analyzed source files|empty/i,
    `the KB indexed nothing here and must say so; got: ${answer}`,
  );
});

// And where it DOES index files, the absent answer says how many it searched.
test("the absent answer counts the files it searched", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("defines impossibleScopeDiagnosis"));
  assert.match(answer, /any of the [1-9]\d* file/, `got: ${answer}`);
});

// `symbols <file>` collapsed two different worlds into one sentence. A file the
// KB indexed and found no declarations in genuinely has none. A file the index
// never read — a template, a .cfg, a source in a language outside the extension
// list — has whatever it has, and the KB knows nothing about it. Both got
// "no definitions found in X", which reads as a fact about the file.
//
// Same shape as the `defines` denial above and it matters on the same repos:
// django is indexed for .py and carries thousands of .html templates and .txt
// fixtures beside it.
test("symbols separates a file with none from a file it never read", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-symbols-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/app.js"), "export function boot() { return 1; }\n");
  fs.writeFileSync(path.join(dir, "src/empty.js"), "// nothing is declared here\n");
  fs.writeFileSync(path.join(dir, "src/page.html"), "<div>{{ value }}</div>\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = codeTool(buildGrounding(dir));

  const unread = String(tool.answer("symbols src/page.html"));
  assert.match(
    unread,
    /does not index|not indexed|never read/i,
    `the KB never read this file and must say so; got: ${unread}`,
  );

  const indexed = String(tool.answer("symbols src/empty.js"));
  assert.match(indexed, /no definitions/i, `this one really has none; got: ${indexed}`);
  assert.doesNotMatch(indexed, /does not index|not indexed/i, `got: ${indexed}`);
});

// Naming six occurrences is true but leaves the model to read all six to find
// the one that matters. For a property, exactly one kind of site is the
// definition — the line that SETS it — and the others consume it. A model
// changing behaviour needs the setter; editing a read site is the failure this
// answer should not invite.
test("the no-declaration answer marks which site sets the property", (t) => {
  const answer = String(repoWithAPropertySymbol(t).answer("defines editableMatchesNothing"));
  const setter = answer.match(/src\/runner\.js:4[^,.]*/)?.[0] ?? "";
  assert.match(setter, /set/i, `the setting line should be marked as such; got: ${answer}`);
  assert.doesNotMatch(
    answer.match(/src\/agent\.js:4[^,.]*/)?.[0] ?? "",
    /set/i,
    `the reading line is not where it is set; got: ${answer}`,
  );
});

// A comment naming the symbol is not a site where anything happens to it. Three
// of the eight slots in this repo's own answer for `editableMatchesNothing` were
// prose about it — including the comment explaining this very branch. With the
// list capped at eight, noise displaces the sites that matter.
test("occurrence sites skip lines that only talk about the symbol", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-comments-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/notes.js"), [
    "// editableMatchesNothing is set by the runner and read by the guard.",
    "/* editableMatchesNothing again, in a block comment. */",
    "export const unrelated = 1;",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "src/real.js"), [
    "export const guard = { editableMatchesNothing: true };",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answer = String(codeTool(buildGrounding(dir)).answer("defines editableMatchesNothing"));
  assert.match(answer, /src\/real\.js:1/, `the real site belongs; got: ${answer}`);
  assert.doesNotMatch(answer, /src\/notes\.js/, `comments are not sites; got: ${answer}`);
});

test("an arrow parameter is not a place the symbol is set", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-arrow-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/x.js"), [
    "export const check = (editableMatchesNothing) => Boolean(editableMatchesNothing);",
    "export const apply = editableMatchesNothing => !editableMatchesNothing;",
  ].join("\n"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answer = String(codeTool(buildGrounding(dir)).answer("defines editableMatchesNothing"));
  assert.doesNotMatch(answer, /set here/, `no line here sets it; got: ${answer}`);
});

// `uses` sorts production call sites ahead of spec files; `defines` sorted only
// frozen copies last. tb29 turn 38 searched `blocked` three times and was handed
// five test files before src/agent.js:1126 — the definition it was working on.
// A model asking where something is defined wants the source, and the delivered
// answer is capped, so test hits at the front push the real one off the end.
test("defines puts live source ahead of test files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-order-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  // Written tests-first so a stable sort cannot pass by accident.
  fs.writeFileSync(path.join(dir, "test/a.test.js"), "const blockedThing = 1;\nexport default blockedThing;\n");
  fs.writeFileSync(path.join(dir, "test/b.test.js"), "const blockedThing = 2;\nexport default blockedThing;\n");
  fs.writeFileSync(path.join(dir, "src/impl.js"), "export const blockedThing = 3;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answer = String(codeTool(buildGrounding(dir)).answer("defines blockedThing"));
  const src = answer.indexOf("src/impl.js");
  const firstTest = answer.indexOf("test/");
  assert.ok(src !== -1 && firstTest !== -1, `both should appear; got: ${answer}`);
  assert.ok(src < firstTest, `source belongs first; got: ${answer}`);
});

// A generic identifier is declared everywhere. On this repo `defines result`
// returns 7,730 characters across 90+ files, and the repeated-search steer
// pastes the answer into an observation unasked. 1% of the KB's 9,541 symbols
// answer longer than 900 characters. A list that long is not an answer — the
// count plus the nearest few is.
test("defines caps a very common symbol and says how many it held back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-common-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    fs.writeFileSync(path.join(dir, `src/m${i}.js`), `export const commonThing = ${i};\n`);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answer = String(codeTool(buildGrounding(dir)).answer("defines commonThing"));
  assert.match(answer, /\+\d+ more/, `should say what it withheld; got: ${answer.slice(0, 200)}`);
  assert.ok(answer.length < 900, `got ${answer.length} chars`);
  assert.match(answer, /30/, `the total belongs in the answer; got: ${answer.slice(0, 200)}`);
});

// Generated and scratch output is not live source a fix has to reach, and it
// carries the same identifiers as the code that produced it. This repo keeps 28
// js files under tmp/benchmark-logs/, gitignored but present in the run
// workspace, and `defines result` ranked tmp/benchmark-logs/task9_hermes/
// pipeline.js FIRST of 199 sites. With the list now capped at twelve, that is
// not just noise — it displaces the real definitions.
test("generated output ranks below live source", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-generated-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp/logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  // Written generated-first so a stable sort cannot pass by accident.
  fs.writeFileSync(path.join(dir, "dist/bundle.js"), "export const pipelineResult = 1;\n");
  fs.writeFileSync(path.join(dir, "tmp/logs/run.js"), "export const pipelineResult = 2;\n");
  fs.writeFileSync(path.join(dir, "src/pipeline.js"), "export const pipelineResult = 3;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answer = String(codeTool(buildGrounding(dir)).answer("defines pipelineResult"));
  const src = answer.indexOf("src/pipeline.js");
  const generated = Math.min(
    ...["tmp/logs/run.js", "dist/bundle.js"].map((p) => answer.indexOf(p)).filter((i) => i !== -1),
  );
  assert.ok(src !== -1, `the real definition must appear; got: ${answer}`);
  assert.ok(src < generated, `live source belongs first; got: ${answer}`);
});
