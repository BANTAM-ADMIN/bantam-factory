// The enforcement half of enumerate-the-contract: an enumerated symbol list
// with untested items bounces done ONCE, naming the tokens verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSymbolEnumerations, contractCoverageObjection } from "../src/logic/contract-coverage.js";

const CONTRACT_TASK = "Implement select(); the header comment is the full contract.";

function ws(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cgate-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body);
  }
  return d;
}

test("extractor finds the rowquery operator run and ignores prose", () => {
  const found = extractSymbolEnumerations("// where clauses:\n//   >= <= != > < =\n// compare rules follow");
  assert.deepEqual(found, [[">=", "<=", "!=", ">", "<", "="]]);
  assert.deepEqual(extractSymbolEnumerations("just words, no symbol runs; a < b sometimes"), []);
});

test("untested listed tokens bounce done, named verbatim; full coverage passes", (t) => {
  const d = ws({
    "src/query.js": "// contract:\n//   >= <= != > < =\nexport const q = 1;\n",
    "test/q.test.js": 'test("a", () => { check(">="); check("<"); check("="); check(">"); });\n',
  });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const msg = contractCoverageObjection({ task: CONTRACT_TASK, workspace: d, count: 0 });
  assert.match(msg, /`!=`/); assert.match(msg, /`<=`/); assert.doesNotMatch(msg, /`>=`/);
  fs.appendFileSync(path.join(d, "test/q.test.js"), 'check("!="); check("<=");\n');
  assert.equal(contractCoverageObjection({ task: CONTRACT_TASK, workspace: d, count: 0 }), null);
});

test("one bounce only; non-contract tasks and enumeration-free contracts are silent", (t) => {
  const d = ws({
    "src/query.js": "// contract:\n//   >= <= != > < =\n",
    "test/q.test.js": 'check("=");\n',
  });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.equal(contractCoverageObjection({ task: CONTRACT_TASK, workspace: d, count: 1 }), null, "second done passes");
  assert.equal(contractCoverageObjection({ task: "Build a maze generator.", workspace: d, count: 0 }), null, "not contract-flagged");
  const d2 = ws({ "src/a.js": "// plain header\n", "test/a.test.js": "x" });
  t.after(() => fs.rmSync(d2, { recursive: true, force: true }));
  assert.equal(contractCoverageObjection({ task: CONTRACT_TASK, workspace: d2, count: 0 }), null, "no enumeration found");
});

test("wired: done bounces through the real dispatcher until the tokens are tested", async (t) => {
  const { runAgent } = await import("../src/agent.js");
  const d = ws({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/" } }),
    "src/query.js": "// ops:\n//   >= <= != > < =\nexport const ok = 1;\n",
    "test/q.test.js": 'import test from "node:test"; import assert from "node:assert/strict";\ntest("ops = > < >= work", () => { assert.ok([">=", "=", ">", "<"].every(Boolean)); });\n',
  });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const outputs = [
    JSON.stringify({ a: "shell", c: "npm test" }),
    JSON.stringify({ a: "done", summary: "Contract implemented; suite green." }),
    JSON.stringify({ a: "replace", p: "test/q.test.js", old: 'every(Boolean)); });', new: 'every(Boolean)); });\ntest("ops != <= work", () => { assert.ok(["!=", "<="].every(Boolean)); });' }),
    JSON.stringify({ a: "shell", c: "npm test" }),
    JSON.stringify({ a: "done", summary: "All enumerated operators now tested; suite green." }),
  ];
  const model = {
    assistantPrefill: "", actTemperature: null, prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete() { return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} }; },
  };
  const result = await runAgent({
    task: CONTRACT_TASK, workspace: d, model, maxTurns: 8,
    interactive: false, useGrammar: false, grounding: false, shellSandbox: "host",
  });
  assert.equal(result.reachedDone, true);
  const obs = result.turns.map((x) => String(x.observation ?? ""));
  assert.ok(obs.some((o) => o.includes("`!=`") && o.includes("`<=`")), "the bounce names the untested tokens");
});
