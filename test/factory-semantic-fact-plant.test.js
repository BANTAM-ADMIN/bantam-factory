import test from "node:test";
import assert from "node:assert/strict";
import { FactLog } from "../src/logic/fact-log.js";
import { buildSemanticFactPlant, promoteAcceptedSemanticFacts } from "../src/factory/semantic-fact-plant.js";

const lanes = [
  "filesystem_write",
  "process_execution",
  "persistent_state_mutation",
  "authority_gate",
  "release_or_promotion",
  "rollback_or_recovery",
];

function chunk(path, startLine, active) {
  return {
    path,
    startLine,
    endLine: startLine + 9,
    sha256: "a".repeat(64),
    lanes: Object.fromEntries(lanes.map((lane) => [lane, active.includes(lane)])),
  };
}

function kit(selected) {
  return {
    completedAt: "2026-08-01T00:00:00.000Z",
    sourceFingerprint: "source-fixture",
    fixture: { die: "matrix", rubric: { lanes: lanes.map((key) => ({ key })) } },
    selected: selected.filter((row) => Object.values(row.lanes).some(Boolean)),
    classified: selected,
  };
}

test("semantic fact plant keeps model observations separate from governed acceptance", () => {
  const selected = [
    chunk("src/write.js", 1, ["filesystem_write", "release_or_promotion"]),
    chunk("src/write.js", 11, ["authority_gate"]),
    chunk("src/recover.js", 1, ["rollback_or_recovery"]),
  ];
  const plant = buildSemanticFactPlant({
    kit: kit(selected),
    accepted: [{
      path: "src/write.js",
      startLine: 1,
      endLine: 10,
      lane: "filesystem_write",
      evidenceRef: "lexical:writeFileSync@1",
    }],
  });

  assert.equal(plant.summary.semanticObservations, 4);
  assert.equal(plant.summary.acceptedLanes, 1);
  assert.equal(plant.summary.corroboratedLanes, 1);
  assert.deepEqual(plant.db.query("file_observed_lane", "src/write.js", "?").map((row) => row[1]).sort(), [
    "authority_gate",
    "filesystem_write",
    "release_or_promotion",
  ]);
  assert.ok(plant.db.has("corroborated_lane", plant.chunks[0].chunkId, "filesystem_write"));
  assert.deepEqual(plant.candidateGaps.effectWithoutSameFileAuthorityObservation, []);
  assert.deepEqual(plant.candidateGaps.releaseWithoutSameFileRecoveryObservation, ["src/write.js"]);
  const proof = plant.db.explain("corroborated_lane", plant.chunks[0].chunkId, "filesystem_write");
  assert.match(proof.rule, /semantic_observation/);
});

test("accepted semantic facts require an issued chunk and rubric lane", () => {
  const source = kit([chunk("src/a.js", 1, ["filesystem_write"])]);
  assert.throws(() => buildSemanticFactPlant({
    kit: source,
    accepted: [{ path: "src/missing.js", startLine: 1, endLine: 10, lane: "filesystem_write", evidenceRef: "x" }],
  }), /does not address an issued chunk/);
  assert.throws(() => buildSemanticFactPlant({
    kit: source,
    accepted: [{ path: "src/a.js", startLine: 1, endLine: 10, lane: "invented", evidenceRef: "x" }],
  }), /lane is not in the rubric/);
});

test("explicit promotion writes only accepted facts to the durable FactLog", () => {
  const source = kit([chunk("src/a.js", 1, ["filesystem_write", "authority_gate"])]);
  const plant = buildSemanticFactPlant({
    kit: source,
    accepted: [{ path: "src/a.js", startLine: 1, endLine: 10, lane: "filesystem_write", evidenceRef: "gauge:a" }],
  });
  const log = new FactLog();
  const appended = promoteAcceptedSemanticFacts(log, plant);
  assert.equal(appended.length, 1);
  assert.equal(log.view().count("accepted_semantic_lane"), 1);
  assert.equal(log.view().count("semantic_observation"), 0);
  assert.equal(promoteAcceptedSemanticFacts(log, plant).length, 0);
});
