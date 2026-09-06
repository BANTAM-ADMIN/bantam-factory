import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ASSERTION_SPEC_SCHEMA, ASSERTION_SPEC_GRAMMAR, parseAssertionSpec, buildAssertionProbe } from "../src/contract-assertion-spec.js";
import { lintGrammar } from "../src/grammar-lint.js";
import { runProbe } from "../src/probe.js";

const sources = ["api.mjs", "package.json"];
const base = { module: "api.mjs", export: "f", fixtures: [], args: [], expect: { kind: "equals", value: null } };
const item = (kind, name, more = {}) => ({ kind, path: name, text: "", mode: 420, target: "", ...more });
const parse = spec => parseAssertionSpec(JSON.stringify(spec), { sourcePaths: sources });

test("one-case schema/grammar is closed and valid, and the module must be audited", () => {
  assert.equal(lintGrammar(ASSERTION_SPEC_GRAMMAR).ok, true);
  assert.equal(ASSERTION_SPEC_SCHEMA.additionalProperties, false);
  assert.deepEqual(parse(base), base);
  const spec = { ...base, fixtures: [item("directory", "root"), item("file", "root/a\t\nb.txt", { text: "exact\0bytes", mode: 0o640 }),
    item("symlink", "root/link", { target: "root/a\t\nb.txt" })], args: [{ $fixture: "root" }, { nested: [{ $fixture: "missing" }] }] };
  assert.deepEqual(parse(spec), spec);
  assert.deepEqual(parseAssertionSpec(JSON.stringify(base), { sourcePaths: [{ path: "api.mjs" }] }), base);
  assert.equal(parseAssertionSpec(JSON.stringify(base), { sourcePaths: [] }), null);
});

test("validation rejects undeclared modules, free code fields, missing fields and ambiguous references", () => {
  for (const spec of [
    { ...base, module: "other.mjs" }, { ...base, module: "package.json" }, { ...base, export: "f();process.exit()" },
    { ...base, code: "console.log('pass')" }, { ...base, fixtures: undefined },
    { ...base, args: [{ $fixture: "root", extra: "ambiguous" }] },
    { ...base, args: [{ $fixture: "../outside" }] }, { ...base, expect: { kind: "throws", value: "any message" } },
    { ...base, expect: { kind: "equals", value: null, extra: true } },
    { ...base, args: new Array(65).fill(null) }, { ...base, fixtures: new Array(9).fill(item("directory", "root")) },
  ]) assert.equal(parse(spec), null, JSON.stringify(spec).slice(0,120));
  assert.equal(parseAssertionSpec(JSON.stringify(base).replace('"args":[]', '"args":[],"args":[]'), { sourcePaths: sources }), null);
  assert.equal(parseAssertionSpec(JSON.stringify({ ...base, args: [{ a: 1 }] }).replace('"a":1', '"a":1,"\\u0061":2'), { sourcePaths: sources }), null);
  assert.equal(parseAssertionSpec(JSON.stringify(base) + " garbage", { sourcePaths: sources }), null);
  assert.equal(parseAssertionSpec("{}".repeat(7000), { sourcePaths: sources }), null);
  assert.equal(parseAssertionSpec(JSON.stringify({ ...base, args: [1] }).replace('[1]', '[1e999]'), { sourcePaths: sources }), null);
  let deep = null; for(let i=0;i<10;i++)deep=[deep];
  assert.equal(parse({ ...base, args: [deep] }), null);
});

test("fixture validation prevents escape, duplicate destinations and symlink-parent writes", () => {
  for (const name of ["", ".", "..", "../x", "/x", "a/../x", "a/./b", "a//b", "a/", "a\\b", "a:b", "a\0b"]) {
    assert.equal(parse({ ...base, fixtures: [item("file", name)] }), null, name);
    assert.equal(parse({ ...base, fixtures: [item("symlink", "link", { target: name })] }), null, name);
  }
  for (const fixtures of [
    [item("file", "a"), item("file", "a")],
    [item("symlink", "a", { target: "other" }), item("file", "a/nested")],
    [item("file", "a/nested"), item("symlink", "a", { target: "other" })],
    [item("file", "a"), item("directory", "a/nested")],
    [item("directory", "a", { text: "unused" })], [item("directory", "a", { mode: 0 })],
    [item("file", "a", { target: "unused" })], [item("file", "a", { mode: 512 })],
    [item("file", "a", { text: "a".repeat(8192) }), item("file", "b", { text: "b" })],
  ]) assert.equal(parse({ ...base, fixtures }), null);
});

// Only these fixed test-owned synthetic modules execute on the host. Real
// workspace candidates use runProbe's offline Docker/read-only subject boundary.
function experiment(t, code, spec = base) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-assertion-spec-test-"));
  fs.mkdirSync(path.join(root, "subject"));
  fs.writeFileSync(path.join(root, "subject", "api.mjs"), code);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const action = buildAssertionProbe(spec, { inputs: ["api.mjs"] });
  const run = phase => spawnSync("sh", ["-c", action[phase]], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 262144 });
  assert.equal(run("setup").status, 0);
  return { root, action, run };
}

test("fixed generated parent witnesses fixtures then compares the actual API result", t => {
  const spec = { ...base, fixtures: [item("directory", "root"), item("file", "root/data", { text: "hi '$() ` `\n", mode: 0o640 }),
    item("symlink", "links/link", { target: "root/data" })], args: [{ $fixture: "root/data" }, { deep: [{ $fixture: "links/link" }] }],
    expect: { kind: "equals", value: { text: "hi '$() ` `\n", symlink: true } } };
  const { run, root, action } = experiment(t,
    "import fs from 'node:fs'; export function f(file,args){ return {text:fs.readFileSync(file,'utf8'),symlink:fs.lstatSync(args.deep[0]).isSymbolicLink()}; }", spec);
  assert.deepEqual(Object.keys(action), ["a", "question", "inputs", "setup", "witness", "check"]);
  assert.equal(fs.readlinkSync(path.join(root, "case/links/link")), "../root/data");
  assert.equal(run("witness").status, 0);
  const checked = run("check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).apiOutcome, "returned");
  assert.deepEqual(fs.readdirSync(root).sort(), ["case", "subject"]);
});

test("expected API errors are assertions, while import/setup errors cannot count as throws", t => {
  const spec = { ...base, expect: { kind: "throws", value: null } };
  const yes = experiment(t, "export function f(){throw Error('API error');}", spec);
  assert.equal(yes.run("witness").status, 0);
  assert.equal(yes.run("check").status, 0);
  const no = experiment(t, "export function f(){return null;}", spec);
  assert.equal(no.run("check").status, 1);
  for (const value of ["'bad'", "null"]) {
    const nonError = experiment(t, `export function f(){throw ${value};}`, spec);
    assert.equal(nonError.run("witness").status, 0);
    const checked = nonError.run("check");
    assert.equal(checked.status, 1, value);
    assert.match(checked.stderr, /threw-non-error/);
  }
  const importError = experiment(t, "throw Error('import error'); export function f(){throw Error('API error');}", spec);
  assert.equal(importError.run("witness").status, 125);
  assert.equal(importError.run("check").status, 125);
  const notCallable = experiment(t, "export const f = 3;", spec);
  assert.equal(notCallable.run("witness").status, 125);
});

test("stdout claims and process.exit cannot forge a completed API outcome", t => {
  for (const code of [
    "export function f(){console.log('ALL ASSERTIONS PASSED');process.exit(0);}",
    "console.log(JSON.stringify({schema:'bantam.assertion-outcome.v1',kind:'returned',value:null}));process.exit(0);",
    "export function f(){console.log(JSON.stringify({schema:'bantam.assertion-outcome.v1',kind:'returned',value:null}));return 4;}",
  ]) {
    const { run } = experiment(t, code);
    assert.notEqual(run("check").status, 0);
  }
  const noisy = experiment(t, "export function f(){console.log('not a receipt');return null;}");
  assert.equal(noisy.run("check").status, 0, "ordinary API logging is not parsed as outcome evidence");
});

test("undefined, non-JSON and lossy results remain unsupported rather than becoming null", t => {
  for (const expression of ["undefined", "NaN", "Infinity", "-0", "1n", "new Date()", "[undefined]", "new Array(2)",
    "({get value(){return 1}})", "(()=>{const a=[];a.length=2;a[0]=1;a.extra=2;return a})()", "(()=>{const a={};a.a=a;return a})()"] ) {
    const { run } = experiment(t, `export function f(){return ${expression};}`);
    assert.equal(run("check").status, 125, expression);
  }
  const mismatched = experiment(t, "export function f(){return {wrong:true};}");
  assert.equal(mismatched.run("check").status, 1);
});

test("largest supported fixture text is data and still fits existing probe command bounds", () => {
  const spec = { ...base, fixtures: [item("file", "data", { text: "'".repeat(8192) })] };
  assert.ok(parse(spec));
  const action = buildAssertionProbe(spec, { inputs: ["api.mjs"] });
  for (const phase of ["setup", "witness", "check"]) assert.ok(action[phase].length <= 24000);
  assert.throws(() => buildAssertionProbe(base, { inputs: [] }), /invalid/);
  assert.throws(() => buildAssertionProbe(base, { inputs: ["api.mjs", "api.mjs"] }), /invalid/);
});

test("existing probe Docker runner preserves read-only subject and typed assertion failure", {
  skip: process.env.BANTAM_PROBE_DOCKER_TEST !== "1",
}, async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-declarative-probe-docker-"));
  fs.writeFileSync(path.join(workspace, "api.mjs"), "export function f(x){if(x===null)throw Error('null');return x;}");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const [spec, expected] of [
    [{ ...base, args: [null], expect: { kind: "throws", value: null } }, "assertion_passed"],
    [{ ...base, args: [7], expect: { kind: "equals", value: 8 } }, "assertion_failed"],
  ]) {
    const result = await runProbe(workspace, buildAssertionProbe(spec, { inputs: ["api.mjs"] }));
    assert.equal(result.probeEvidence.projection.status, expected, result.observation);
    assert.equal(result.probeEvidence.sourceDigest, result.probeEvidence.sourceAfterDigest);
    assert.equal(result.verificationEvidence, null);
  }
});
