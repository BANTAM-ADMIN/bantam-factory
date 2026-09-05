import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTestProvenance } from "../src/test-provenance.js";
import { formatFailingTestFocus, testProvenanceGuidance } from "../src/logic/test-focus.js";
import { buildTeacherPrompt } from "../src/teacher-assist.js";

const supplied = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('supplied', () => { assert.equal(1, 1); });\n";
const authored = "test('EOF after a closing quote', () => {\n  const p = createCsvParser();\n  p.write('\"a\"');\n  assert.throws(() => p.end(), SyntaxError);\n});\n";
function fixture(t, original = supplied) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-owned-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "test"));
  const file = path.join(root, "test/csv.test.js");
  fs.writeFileSync(file, original);
  return { root, file, classify: createTestProvenance(root) };
}

test("the observed appended EOF assertion is explicitly self-authored despite its supplied filename", (t) => {
  const { root, file, classify } = fixture(t);
  const current = supplied + authored;
  fs.writeFileSync(file, current);
  assert.equal(classify({ file, line: 7 }), "self-authored");
  assert.equal(classify({ file, line: 3 }), "baseline-context-changed");
  const output = `not ok 1 - EOF after a closing quote\n  location: '${file}:4:1'\n  error: 'Missing expected exception (SyntaxError).'\n# pass 1\n# fail 1`;
  const focus = formatFailingTestFocus(output, () => current, { testProvenance: classify });
  assert.match(focus, /Test provenance: self-authored/);
  assert.match(focus, /preserving supplied tests does not prohibit task-justified correction/);
  assert.match(focus, /specific task-supported defect/);
  fs.writeFileSync(file, current.replace("assert.throws(() => p.end(), SyntaxError)", "assert.deepEqual(p.end(), [['a']])"));
  assert.equal(classify({ file: path.relative(root, file), line: 7 }), "self-authored");
});

test("renaming or modifying a supplied test does not make it self-authored", (t) => {
  const { file, classify } = fixture(t);
  for (const source of [supplied.replace("'supplied'", "'new name'"), supplied.replace("assert.equal(1, 1)", "assert.equal(1, 2)")]) {
    fs.writeFileSync(file, source);
    assert.equal(classify({ file, line: 3 }), "added-or-modified");
  }
});

test("appended AST blocks are recognized after harmless surrounding comment changes", (t) => {
  const { file, classify } = fixture(t);
  fs.writeFileSync(file, "// context changed\n" + supplied + authored);
  assert.equal(classify({ file, line: 5 }), "self-authored");
  fs.writeFileSync(file, "// context changed\n" + supplied.replace("'supplied'", "'renamed'") + authored);
  assert.equal(classify({ file, line: 5 }), "added-or-modified", "all supplied blocks must remain preserved for this fallback");
});

test("duplicate anchors, mixed same-line calls, and unparseable source stay conservative", (t) => {
  const { file, classify } = fixture(t);
  fs.writeFileSync(file, "// shifted\n" + supplied + supplied.split("\n")[2] + "\n" + authored);
  assert.equal(classify({ file, line: 6 }), "added-or-modified");
  fs.writeFileSync(file, supplied + "test('a',()=>{}); test('b',()=>{});\n");
  assert.equal(classify({ file, line: 4 }), "added-or-modified");
  fs.writeFileSync(file, supplied + authored + "const bad = ;\n");
  assert.equal(classify({ file, line: 4 }), "added-or-modified");
});

test("node:test aliases and callback-contained assertions retain AST locations", (t) => {
  const original = "import {test as scenario} from 'node:test';\nscenario('old', () => {});\n";
  const { file, classify } = fixture(t, original);
  fs.writeFileSync(file, original + "scenario('new', () => {\n  const literal = '}); fake test text';\n  assert.equal(literal, 'other');\n});\n");
  assert.equal(classify({ file, line: 5 }), "self-authored");
});

test("protected status wins for appended, changed, and removed protected tests", (t) => {
  const { root, file } = fixture(t);
  const classify = createTestProvenance(root, { protectedPath: (rel) => rel === "test/csv.test.js" });
  fs.writeFileSync(file, supplied + authored);
  assert.equal(classify({ file, line: 4 }), "protected");
  fs.writeFileSync(file, authored);
  assert.equal(classify({ file, line: 1 }), "protected");
  fs.unlinkSync(file);
  assert.equal(classify({ file, line: 1 }), "protected");
});

test("untracked supplied files are unknown, while genuinely new test files are generated", (t) => {
  const { root } = fixture(t);
  const other = path.join(root, "helper.js");
  fs.writeFileSync(other, "export const value = 1;\n");
  const classify = createTestProvenance(root);
  assert.equal(classify({ file: other, line: 1 }), "unknown");
  const added = path.join(root, "test/new.test.js");
  fs.writeFileSync(added, authored);
  assert.equal(classify({ file: added, line: 1 }), "generated");
});

test("focus and teacher ownership wording permits only task-justified corrections", () => {
  const wording = testProvenanceGuidance("self-authored");
  assert.match(wording, /This test was added during this run/);
  assert.match(wording, /do not remove coverage or weaken an assertion merely to make it pass/);
  const prompt = buildTeacherPrompt({ testName: "EOF", testSource: authored, implSource: "parser", diff: "missing exception", task: "EOF is legal after a closing quote", testProvenance: "self-authored" });
  assert.match(prompt, /preserving supplied tests does not prohibit task-justified correction/);
  assert.doesNotMatch(testProvenanceGuidance("protected"), /This test was added/);
});
