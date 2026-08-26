import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { proposalModules, auditIntegration, formatIntegrationAudit } from "../src/logic/integration-audit.js";

// Audited 2026-07-30: of the 29 proposal modules self-improve.js registers, only
// 3 are imported from src/ or bin/. 13 are imported only by tests and 13 by
// nothing at all -- 4,336 lines built, sometimes verified, never executed by a
// run. The build and score steps of governed self-improvement work; integration
// is the step that does not happen. This check exists so the next generated
// module is noticed rather than accumulated.
//
// See docs/superpowers/reports/2026-07-30-self-improvement-integration-audit.md

const REGISTRY = `
export const IMPROVEMENTS = [
  {
    files: ["wired-thing.js"],
    id: "wired-thing", area: "reliability",
    problem: "x", proposal: "y", effort: 1, impact: 2,
  },
  {
    files: ["tested-thing.js"],
    id: "tested-thing", area: "reasoning",
    problem: "x", proposal: "y", effort: 1, impact: 2,
  },
  {
    files: ["shelved-thing.js", "never-built.js"],
    id: "shelved-thing", area: "performance",
    problem: "x", proposal: "y", effort: 1, impact: 2,
  },
];
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-integration-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });

  fs.writeFileSync(path.join(root, "src", "self-improve.js"), REGISTRY);
  fs.writeFileSync(path.join(root, "src", "wired-thing.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "tested-thing.js"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "src", "shelved-thing.js"), "export const c = 3;\n");

  // A real production import edge.
  fs.writeFileSync(path.join(root, "src", "agent.js"), 'import { a } from "./wired-thing.js";\n');
  // A test-only import edge.
  fs.writeFileSync(path.join(root, "test", "tested.test.js"), 'import { b } from "../src/tested-thing.js";\n');
  // shelved-thing.js is named in the registry and imported by nothing.
  return root;
}

test("reads the proposal file list out of the registry", (t) => {
  const root = fixture(t);
  const mods = proposalModules(root);
  assert.deepEqual(mods.sort(), ["never-built.js", "shelved-thing.js", "tested-thing.js", "wired-thing.js"]);
});

test("separates production-wired from test-only from unreferenced", (t) => {
  const root = fixture(t);
  const audit = auditIntegration(root);

  assert.deepEqual(audit.wired.map((m) => m.file), ["wired-thing.js"]);
  assert.deepEqual(audit.testOnly.map((m) => m.file), ["tested-thing.js"]);
  assert.deepEqual(audit.unreferenced.map((m) => m.file), ["shelved-thing.js"]);
  // A registry entry whose file was never generated is not an integration
  // failure and must not be reported as one.
  assert.deepEqual(audit.missing, ["never-built.js"]);
});

// The registry lists its own filenames as string literals. An audit that greps
// bare filenames counts those as imports and reports zero orphans -- the exact
// error the first pass of this audit made by hand.
test("does not count the registry's own string literals as imports", (t) => {
  const root = fixture(t);
  const audit = auditIntegration(root);
  assert.equal(
    audit.wired.some((m) => m.file === "shelved-thing.js"), false,
    "self-improve.js names shelved-thing.js in a files: array; that is not an import",
  );
});

test("counts lines so the report can weigh what is shelved", (t) => {
  const root = fixture(t);
  const audit = auditIntegration(root);
  assert.equal(audit.unreferenced[0].lines, 1);
  assert.equal(audit.totals.unreferencedLines, 1);
});

test("formats a summary that names the shelved modules", (t) => {
  const root = fixture(t);
  const text = formatIntegrationAudit(auditIntegration(root));
  assert.match(text, /shelved-thing\.js/);
  assert.match(text, /1 wired/);
  assert.doesNotMatch(text, /never-built\.js/, "an ungenerated proposal is not an integration failure");
});

test("reports clean when every generated module is wired", (t) => {
  const root = fixture(t);
  // Wire the other two up.
  fs.appendFileSync(path.join(root, "src", "agent.js"),
    'import { b } from "./tested-thing.js";\nimport { c } from "./shelved-thing.js";\n');
  const audit = auditIntegration(root);
  assert.equal(audit.unreferenced.length, 0);
  assert.equal(audit.testOnly.length, 0);
  assert.match(formatIntegrationAudit(audit), /every generated proposal module is wired/i);
});
