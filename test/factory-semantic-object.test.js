import test from "node:test";
import assert from "node:assert/strict";
import { compileSemanticObject, loadSemanticObject, planSemanticRecompile, validateSemanticObject } from "../src/factory/semantic-object.js";

const lanes = ["filesystem_write", "authority_gate", "rollback_or_recovery"];

function chunk(path, startLine, active, hash = "a".repeat(64)) {
  return {
    path,
    startLine,
    endLine: startLine + 9,
    sha256: hash,
    lanes: Object.fromEntries(lanes.map((lane) => [lane, active.includes(lane)])),
  };
}

function kit(rows, completedAt = "2026-08-01T00:00:00.000Z") {
  return {
    completedAt,
    sourceFingerprint: "semantic-object-fixture",
    fixture: { die: "matrix", rubric: { lanes: lanes.map((key) => ({ key })) } },
    summary: { elapsedMs: 10, promptTokens: 200, completionTokens: 6, lots: 1 },
    classified: rows,
    selected: rows.filter((row) => Object.values(row.lanes).some(Boolean)),
  };
}

test("semantic object stores and reloads an explainable fixpoint without rule execution", () => {
  const source = kit([
    chunk("src/a.js", 1, ["filesystem_write"]),
    chunk("src/a.js", 11, ["authority_gate"]),
  ]);
  const accepted = [{
    path: "src/a.js",
    startLine: 1,
    endLine: 10,
    lane: "filesystem_write",
    evidenceRef: "gauge:write",
  }];
  const { artifact, plant } = compileSemanticObject({ kit: source, accepted, compiledAt: "first" });
  assert.equal(validateSemanticObject(artifact), true);
  const loaded = loadSemanticObject(artifact);

  assert.equal(loaded.totalFacts(), plant.db.totalFacts());
  assert.equal(loaded.rules.length, 0, "loading a stored fixpoint must not reinstall computation");
  assert.equal(loaded.stats.loadOnly, true);
  assert.ok(loaded.has("corroborated_lane", plant.chunks[0].chunkId, "filesystem_write"));
  assert.match(loaded.explain("corroborated_lane", plant.chunks[0].chunkId, "filesystem_write").rule, /accepted_lane/);
});

test("semantic object identity depends on content rather than compile time", () => {
  const source = kit([chunk("src/a.js", 1, ["filesystem_write"])]);
  const first = compileSemanticObject({ kit: source, compiledAt: "first" }).artifact;
  const second = compileSemanticObject({ kit: kit(source.classified, "later"), compiledAt: "second" }).artifact;
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.kitRef, second.kitRef);
  assert.notEqual(first.compiledAt, second.compiledAt);
});

test("semantic object rejects tampering and plans unit-level recompilation", () => {
  const rows = [
    chunk("src/a.js", 1, ["filesystem_write"]),
    chunk("src/b.js", 1, ["authority_gate"]),
  ];
  const artifact = compileSemanticObject({ kit: kit(rows) }).artifact;
  const next = structuredClone(rows);
  next[0].sha256 = "b".repeat(64);
  next.push(chunk("src/c.js", 1, [], "c".repeat(64)));
  const plan = planSemanticRecompile(artifact, kit(next));
  assert.deepEqual({ reused: plan.reused, changed: plan.changed, added: plan.added, removed: plan.removed, modelRequired: plan.modelRequired }, {
    reused: 1,
    changed: 1,
    added: 1,
    removed: 0,
    modelRequired: 2,
  });

  const corrupt = structuredClone(artifact);
  corrupt.sourceUnits[0].sha256 = "d".repeat(64);
  assert.throws(() => validateSemanticObject(corrupt), /digest mismatch/);
});
