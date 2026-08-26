import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { blastRadiusNote, dependentsOf } from "../src/logic/blast-radius.js";
import { buildDependencyGraph, findAffectedFiles } from "../src/dependency-impact.js";

// Measured across 34 Codex runs and 383 turns: not one of BANTAM's sixteen defect
// gates ever fired. Codex does not make the mistakes they were built from. What it
// can still do is edit a module without knowing what depends on it -- the expert
// failure mode is confidence, not ignorance.
//
// So this is CONTEXT, not a gate. It refuses nothing; it states a fact at the
// moment the fact becomes relevant.

describe("naming the dependents of an edited file", () => {
  it("lists the files that import it", () => {
    const note = blastRadiusNote("src/a.js", ["src/b.js", "src/c.js"]);
    assert.match(note, /2 file\(s\) import src\/a\.js/);
    assert.match(note, /src\/b\.js, src\/c\.js/);
  });

  // Noise in a prompt is not free: it is re-sent every turn for the rest of the
  // run, so a leaf edit must say nothing rather than "0 files affected".
  it("says nothing when nothing imports it", () => {
    assert.equal(blastRadiusNote("src/leaf.js", []), "");
    assert.equal(blastRadiusNote("src/leaf.js", undefined), "");
  });

  it("never counts the edited file as its own dependent", () => {
    assert.equal(blastRadiusNote("src/a.js", ["src/a.js"]), "");
  });

  it("caps the list so a hub file cannot flood the prompt", () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.js`);
    const note = blastRadiusNote("src/hub.js", many);
    assert.match(note, /20 file\(s\)/, "the true count is still reported");
    assert.match(note, /\+14 more/);
    assert.ok(note.length < 300, `note stayed short, was ${note.length} chars`);
  });

  it("deduplicates and orders deterministically", () => {
    const a = blastRadiusNote("src/a.js", ["src/c.js", "src/b.js", "src/c.js"]);
    const b = blastRadiusNote("src/a.js", ["src/b.js", "src/c.js"]);
    assert.equal(a, b, "the same dependents must render identically regardless of order");
  });
});

describe("resolving dependents from the graph", () => {
  it("finds real dependents in this repository", () => {
    const indexed = buildDependencyGraph("src");
    const deps = dependentsOf("prompt.js", indexed, findAffectedFiles);
    assert.ok(deps.includes("agent.js"),
      `agent.js imports prompt.js; got ${deps.slice(0, 5).join(", ")}`);
  });

  it("returns nothing for a file outside the graph", () => {
    const indexed = buildDependencyGraph("src");
    assert.deepEqual(dependentsOf("not/a/file.js", indexed, findAffectedFiles), []);
  });

  // An impact graph is an optimisation; failing to compute one must never take
  // down the edit that triggered it.
  it("survives a broken graph rather than throwing", () => {
    assert.deepEqual(dependentsOf("a.js", null, findAffectedFiles), []);
    const exploding = () => { throw new Error("graph is corrupt"); };
    const indexed = { graph: new Map([["a.js", {}]]), reverseGraph: new Map() };
    assert.deepEqual(dependentsOf("a.js", indexed, exploding), []);
  });
});

// Measured on a live Codex run: every note emitted said "1 file(s) import
// src/clients/x.js: test/public.test.js". That the test suite imports the file
// under edit is not news, and a note costs prompt tokens on every remaining turn.
// The note exists to name dependents the model has NOT looked at.
describe("excluding the obvious dependent", () => {
  it("says nothing when only tests import the file", () => {
    assert.equal(blastRadiusNote("src/a.js", ["test/public.test.js"]), "");
    assert.equal(blastRadiusNote("src/a.js", ["src/a.spec.js"]), "");
    assert.equal(blastRadiusNote("src/a.js", ["__tests__/a.js"]), "");
  });

  it("still reports production dependents beside a test", () => {
    const note = blastRadiusNote("src/a.js", ["test/a.test.js", "src/b.js"]);
    assert.match(note, /1 file\(s\) import src\/a\.js: src\/b\.js/);
    assert.ok(!note.includes("test/a.test.js"), "the test dependent is not worth naming");
  });
});
