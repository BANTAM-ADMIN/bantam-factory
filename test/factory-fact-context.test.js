import test from "node:test";
import assert from "node:assert/strict";
import { FactFabric, FactOverlay, FactSourceRegistry, pullEntity, pullMany, variable } from "../src/factory.js";

function factoryWorld() {
  const fabric = new FactFabric();
  fabric.transact([
    { op: "assert", e: "job:taurus-7", a: "job/station", v: "station:drill" },
    { op: "assert", e: "job:taurus-7", a: "job/status", v: "waiting" },
    { op: "assert", e: "job:taurus-7", a: "job/requirement", v: "requirement:hole-pattern" },
    { op: "assert", e: "requirement:hole-pattern", a: "requirement/hole", v: "A" },
    { op: "assert", e: "requirement:hole-pattern", a: "requirement/hole", v: "B" },
    { op: "assert", e: "requirement:hole-pattern", a: "requirement/hole", v: "C" },
    { op: "assert", e: "station:drill", a: "station/worker", v: "worker:chicken-12" },
    { op: "assert", e: "worker:chicken-12", a: "worker/capability", v: "drill-pattern-v1" },
    { op: "assert", e: "worker:chicken-12", a: "worker/healthy", v: true },
  ], { src: "supervisor:line-1", kind: "accepted-factory-state" });
  return fabric;
}

test("a proposal overlay changes local answers without mutating the accepted world", () => {
  const fabric = factoryWorld();
  const world = fabric.view();
  const proposal = new FactOverlay(world, [
    { op: "retract", e: "job:taurus-7", a: "job/status", v: "waiting" },
    { op: "assert", e: "job:taurus-7", a: "job/status", v: "ready" },
  ], { name: "ready-if-worker-healthy", src: "planner:what-if" });

  assert.equal(world.has("job:taurus-7", "job/status", "waiting"), true);
  assert.equal(world.has("job:taurus-7", "job/status", "ready"), false);
  assert.equal(proposal.has("job:taurus-7", "job/status", "waiting"), false);
  assert.equal(proposal.has("job:taurus-7", "job/status", "ready"), true);
  assert.equal(fabric.basis, 1, "constructing and reading an overlay cannot write to the fabric");
  assert.equal(typeof proposal.transact, "undefined", "proposal views intentionally have no promotion method");
  assert.match(proposal.overlayId, /^fact-overlay:sha256:/);
});

test("named sources join typed facts and reject missing sources", () => {
  const fabric = factoryWorld();
  const qualifications = new FactFabric();
  qualifications.transact([
    { op: "assert", e: "worker:chicken-12", a: "qualification/name", v: "drill-pattern-v1" },
    { op: "assert", e: "worker:chicken-99", a: "qualification/name", v: "paint-v2" },
  ], { src: "training:ledger", kind: "reviewed-qualification" });
  const registry = new FactSourceRegistry({ $world: fabric.view(), $workforce: qualifications.view() });
  const worker = variable("worker");
  const capability = variable("capability");
  const clauses = [
    { source: "$world", pattern: { e: "station:drill", a: "station/worker", v: worker } },
    { source: "$world", pattern: { e: worker, a: "worker/capability", v: capability } },
    { source: "$workforce", pattern: { e: worker, a: "qualification/name", v: capability } },
  ];

  assert.deepEqual(registry.join(clauses), [{ worker: "worker:chicken-12", capability: "drill-pattern-v1" }]);
  assert.deepEqual(registry.join([...clauses].reverse()), [{ worker: "worker:chicken-12", capability: "drill-pattern-v1" }]);
  assert.throws(() => registry.match("$missing", {}), /unknown fact source/);
  assert.throws(() => registry.register("$world", fabric.view()), /already registered/);
});

test("Pull compiles a minimal deterministic, nested, evidence-bearing station packet", () => {
  const fabric = factoryWorld();
  const specification = {
    attributes: {
      "job/station": { as: "station" },
      "job/status": { as: "status", default: "unknown" },
      "job/requirement": {
        as: "requirement",
        ref: { attributes: { "requirement/hole": { as: "holes", many: true, limit: 3 } } },
      },
    },
  };
  const first = pullEntity(fabric.view(), "job:taurus-7", specification, { sourceName: "$world", includeEvidence: true });
  const second = pullEntity(fabric.view(), "job:taurus-7", specification, { sourceName: "$world", includeEvidence: true });

  assert.equal(first.packetId, second.packetId);
  assert.deepEqual(first.data.requirement, {
    $entity: "requirement:hole-pattern",
    holes: ["A", "B", "C"],
    $evidence: { holes: first.data.requirement.$evidence.holes },
  });
  assert.equal(first.data.$evidence.station[0].src, "supervisor:line-1");
  assert.deepEqual(Object.keys(first.data).sort(), ["$entity", "$evidence", "requirement", "station", "status"]);
  assert.equal(Object.isFrozen(first.data.requirement.holes), true);
  assert.deepEqual(pullMany(fabric.view(), ["job:taurus-7"], specification)[0].data.requirement.holes, ["A", "B", "C"]);
});

test("Pull detects entity cycles, enforces cardinality, limits arrays, and applies defaults", () => {
  const fabric = new FactFabric();
  fabric.transact([
    { op: "assert", e: "node:a", a: "node/next", v: "node:b" },
    { op: "assert", e: "node:b", a: "node/next", v: "node:a" },
    { op: "assert", e: "node:a", a: "node/tag", v: "one" },
    { op: "assert", e: "node:a", a: "node/tag", v: "two" },
  ], { src: "graph:loader", kind: "observation" });
  const recursive = () => ({ attributes: {} });
  const a = recursive();
  const b = recursive();
  a.attributes["node/next"] = { as: "next", ref: b };
  b.attributes["node/next"] = { as: "next", ref: a };
  assert.throws(() => pullEntity(fabric.view(), "node:a", a), /specification contains a cycle/);

  const finite = { attributes: {
    "node/next": { as: "next", ref: { attributes: { "node/next": { as: "next", ref: { attributes: { "node/tag": { as: "tags", many: true } } } } } } },
    "node/missing": { as: "missing", default: "none" },
  } };
  const packet = pullEntity(fabric.view(), "node:a", finite);
  assert.equal(packet.data.missing, "none");
  assert.deepEqual(packet.data.next.next, { $ref: "node:a", $cycle: true });
  assert.throws(() => pullEntity(fabric.view(), "node:a", { attributes: { "node/tag": true } }), /ambiguous/);
  assert.deepEqual(pullEntity(fabric.view(), "node:a", { attributes: { "node/tag": { many: true, limit: 1 } } }).data["node/tag"], ["one"]);
});

test("Pull specifications fail review on expansion, alias collisions, and malformed defaults", () => {
  const view = factoryWorld().view();
  assert.throws(() => pullEntity(view, "job:taurus-7", { attributes: {}, wildcard: true }), /unsupported Pull specification field/);
  assert.throws(() => pullEntity(view, "job:taurus-7", { attributes: {
    "job/status": { as: "same" },
    "job/station": { as: "same" },
  } }), /duplicate Pull alias/);
  assert.throws(() => pullEntity(view, "job:taurus-7", { attributes: {
    "job/status": { as: "$entity" },
  } }), /reserved/);
  assert.throws(() => pullEntity(view, "job:taurus-7", { attributes: {
    "job/status": { invented: true },
  } }), /unsupported Pull instruction field/);
  assert.throws(() => pullEntity(view, "job:taurus-7", { attributes: {
    "job/missing": { many: true, default: "not-an-array" },
  } }), /must be an array/);
});

test("multi-source joins reject unknown projected datom fields", () => {
  const registry = new FactSourceRegistry({ $world: factoryWorld().view() });
  assert.throws(() => registry.join([
    { source: "$world", pattern: { imaginary: variable("x") } },
  ]), /unsupported join datom field/);
});
