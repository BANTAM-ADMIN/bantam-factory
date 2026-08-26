import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGrounding } from "../src/logic/grounding.js";
import { conceptTool } from "../src/logic/concept-search.js";
import { codeTool } from "../src/logic/tools.js";

// A vendored or fixture copy of the project is the worst kind of decoy for
// concept retrieval: it carries the same identifiers, comments and structure as
// the real source, so it scores at least as well, and it is never the file to
// edit.
//
// Measured across the stored runs: 55.4% of ranked KB hits sat inside a frozen
// copy, and 10 of 14 queries returned one as their #1 result. In
// 2026-08-16T17-22-16 the model asked where editScopeRefusal lived, was handed
// gauntlet/fixtures/retry-consolidation-haystack/repo/src/platform/agent.js at
// score 77.3, spent seven actions reading it, and then issued a replace against
// the real src/agent.js at the FIXTURE's line number — one of the twelve "old
// text not found" failures in the corpus.
//
// The sibling-symbol gate already learned to exclude this exact fixture
// (isFrozenCopyPath). Search ranking had not.

const BODY = [
  "// Refuse an edit that falls outside the configured editable scope.",
  "export function editScopeRefusal(action, guard) {",
  "  if (!guard || guard.allows(action.p)) return null;",
  "  return `refused: ${action.p} is outside the editable scope`;",
  "}",
].join("\n");

function repoWithFrozenTwin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-frozen-"));
  const live = path.join(dir, "src");
  const frozen = path.join(dir, "gauntlet/fixtures/haystack/repo/src/platform");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(frozen, { recursive: true });
  // A frozen copy is near-identical to its original by definition — that is
  // what makes it a decoy rather than a bad match. The deeper path gives it a
  // slightly richer path signal, which is enough to put it first unpenalised.
  fs.writeFileSync(path.join(live, "scope.js"), `${BODY}\n`);
  fs.writeFileSync(path.join(frozen, "scope.js"), `${BODY}\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ranking(dir, question) {
  const tool = conceptTool(buildGrounding(dir));
  const text = String(tool.answer(question) ?? "");
  return text.split("\n")
    .map((line) => /^\s*\d+\.\s+(\S+?):/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

test("the live source outranks its frozen copy", (t) => {
  const dir = repoWithFrozenTwin(t);
  const ranked = ranking(dir, "where is the editable scope refusal for immutable files implemented");
  assert.ok(ranked.length, "the query must return something");
  assert.match(ranked[0], /^src\/scope\.js$/, `the real implementation must rank first, got ${ranked[0]}`);
});

test("the frozen copy is down-ranked, not hidden", (t) => {
  // De-indexing would blind defines/reaches and scoped verification, so the
  // fixture must still be reachable — just not first.
  const dir = repoWithFrozenTwin(t);
  const ranked = ranking(dir, "where is the editable scope refusal for immutable files implemented");
  assert.ok(
    ranked.some((f) => f.includes("gauntlet/fixtures/")),
    "the fixture must remain searchable",
  );
});

// Scores, not positions: with the two files byte-identical, which one lands at
// #1 turns on lexical details not worth pinning. What the contract actually says
// is that naming the fixture lifts the penalty.
function scoreRatio(dir, question) {
  const tool = conceptTool(buildGrounding(dir));
  const rows = String(tool.answer(question) ?? "").split("\n")
    .map((line) => /^\s*\d+\.\s+(\S+?):.*score ([\d.]+)/.exec(line))
    .filter(Boolean);
  const live = rows.find((m) => !m[1].includes("fixtures"));
  const frozen = rows.find((m) => m[1].includes("fixtures"));
  assert.ok(live && frozen, `both files must be ranked for ${question}`);
  return Number(frozen[2]) / Number(live[2]);
}

test("naming the fixture lifts the penalty", (t) => {
  const dir = repoWithFrozenTwin(t);
  const penalised = scoreRatio(dir, "where is the editable scope refusal for immutable files implemented");
  const lifted = scoreRatio(dir, "editable scope refusal in the fixtures copy");
  assert.ok(penalised < 0.3, `an unasked-for frozen copy must be well below the live file, got ${penalised.toFixed(2)}`);
  assert.ok(lifted > 0.45, `naming fixtures must restore its standing, got ${lifted.toFixed(2)}`);
});

// `defines` and `uses` answer with jump targets, not a ranked list, so the
// concept-search penalty does not reach them. A symbol defined in both the real
// source and a frozen copy hands the model two targets that look equally good.
// vendor/, not gauntlet/fixtures/: the index walks src/ first, so a fixture
// under a directory sorting BEFORE src happens to come out live-first already.
// Under vendor/, third_party/ or test/fixtures/ — all sorting after src/ — the
// copy is named first, which is the ordering a real repo actually hits.
function repoWithTwinDefinition(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-defines-"));
  const live = path.join(dir, "src");
  const frozen = path.join(dir, "vendor/haystack/src");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(frozen, { recursive: true });
  fs.writeFileSync(path.join(live, "scope.js"), `${BODY}\n`);
  fs.writeFileSync(path.join(frozen, "scope.js"), `${BODY}\n`);
  // A caller in each, so `uses` has a site on both sides.
  const caller = 'import { editScopeRefusal } from "./scope.js";\nexport const run = (a, g) => editScopeRefusal(a, g);\n';
  fs.writeFileSync(path.join(live, "caller.js"), caller);
  fs.writeFileSync(path.join(frozen, "caller.js"), caller);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defines names the live definition before its frozen copy", (t) => {
  const dir = repoWithTwinDefinition(t);
  const out = String(codeTool(buildGrounding(dir)).answer("defines editScopeRefusal"));
  const live = out.indexOf("src/scope.js");
  const copy = out.indexOf("vendor/");
  assert.ok(live >= 0 && copy >= 0, `both definitions must still be listed: ${out}`);
  assert.ok(live < copy, `the live definition must be the first jump target: ${out}`);
});

test("uses lists live call sites before frozen ones", (t) => {
  const dir = repoWithTwinDefinition(t);
  const out = String(codeTool(buildGrounding(dir)).answer("uses editScopeRefusal"));
  // The "(defined at …)" preamble also names both files; only the site list
  // after it is the ordering under test.
  const sites = out.slice(out.lastIndexOf("):") + 2);
  const live = sites.indexOf("src/caller.js");
  const copy = sites.indexOf("vendor/");
  assert.ok(live >= 0, `the real call site must be listed: ${sites}`);
  if (copy >= 0) assert.ok(live < copy, `a fixture call site is not a site a fix must reach: ${sites}`);
});
