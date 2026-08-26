import test from "node:test";
import assert from "node:assert/strict";
import { FactFabric, canonicalEncode } from "../src/factory.js";

function commit(fabric, operations, src = "station:test", kind = "observation") {
  return fabric.transact(operations, { src, kind });
}

test("Fact Fabric commits an immutable, provenance-bearing transaction atomically", () => {
  const fabric = new FactFabric();
  const mutable = { confidence: 0.9, reasons: ["syntax", "call-site"] };
  const transaction = commit(fabric, [
    { op: "assert", e: "unit:a", a: "semantic/lane", v: "filesystem_write" },
    { op: "assert", e: "unit:a", a: "semantic/evidence", v: mutable },
  ], "worker:diffusion-gemma", "model-observation");

  mutable.confidence = 0;
  mutable.reasons.push("caller mutation");
  assert.equal(fabric.basis, 1);
  assert.equal(fabric.operationCount, 2);
  assert.equal(transaction.operationCount, 2);
  assert.match(transaction.txId, /^fact-tx:sha256:[a-f0-9]{64}$/);
  assert.deepEqual(fabric.view().match({ e: "unit:a", a: "semantic/evidence" })[0].v, {
    confidence: 0.9,
    reasons: ["syntax", "call-site"],
  });
  assert.equal(Object.isFrozen(transaction), true);
  assert.equal(Object.isFrozen(transaction.datoms[1].v.reasons), true);

  assert.throws(() => commit(fabric, [
    { op: "assert", e: "unit:b", a: "good", v: true },
    { op: "assert", e: "unit:c", a: "bad", v: Number.NaN },
  ]), /finite number/);
  assert.equal(fabric.basis, 1, "a failed transaction must not consume a basis");
  assert.equal(fabric.view().match({ e: "unit:b" }).length, 0, "a failed transaction must retain no prefix");
});

test("assert, retract, and reassert preserve history while resolving current state", () => {
  const fabric = new FactFabric();
  const tuple = { e: "worker:qwen", a: "worker/healthy", v: true };
  commit(fabric, [{ op: "assert", ...tuple }], "probe:health");
  commit(fabric, [{ op: "assert", ...tuple }], "probe:health");
  assert.equal(fabric.view().match(tuple).length, 1, "duplicate assertions are one current tuple");
  commit(fabric, [{ op: "retract", ...tuple }], "supervisor:health");
  assert.equal(fabric.view().has(tuple.e, tuple.a, tuple.v), false);
  commit(fabric, [{ op: "assert", ...tuple }], "probe:recovery");

  assert.equal(fabric.view().has(tuple.e, tuple.a, tuple.v), true);
  assert.deepEqual(fabric.provenance(tuple.e, tuple.a, tuple.v).map(({ tx, op, src }) => ({ tx, op, src })), [
    { tx: 1, op: "assert", src: "probe:health" },
    { tx: 2, op: "assert", src: "probe:health" },
    { tx: 3, op: "retract", src: "supervisor:health" },
    { tx: 4, op: "assert", src: "probe:recovery" },
  ]);
  assert.deepEqual(fabric.history().map(({ tx, ordinal }) => [tx, ordinal]), [[1, 0], [2, 0], [3, 0], [4, 0]],
    "raw history must remain in append order for timeline replay");
});

test("as-of views and named snapshots reproduce immutable prior worlds", () => {
  const fabric = new FactFabric();
  commit(fabric, [{ op: "assert", e: "car:1", a: "build/stage", v: "frame" }]);
  const frame = fabric.snapshot("frame-installed");
  commit(fabric, [
    { op: "retract", e: "car:1", a: "build/stage", v: "frame" },
    { op: "assert", e: "car:1", a: "build/stage", v: "paint" },
  ]);

  assert.equal(frame.basis, 1);
  assert.deepEqual(fabric.asOf(0).match(), []);
  assert.equal(fabric.asOf(1).has("car:1", "build/stage", "frame"), true);
  assert.equal(fabric.viewAt("frame-installed").has("car:1", "build/stage", "frame"), true);
  assert.equal(fabric.view().has("car:1", "build/stage", "frame"), false);
  assert.equal(fabric.view().has("car:1", "build/stage", "paint"), true);
  assert.throws(() => fabric.snapshot("frame-installed"), /already exists/);
  assert.throws(() => fabric.viewAt("missing"), /unknown snapshot/);
});

test("typed canonical identity ignores object key order and distinguishes types", () => {
  assert.equal(canonicalEncode({ b: 2, a: [true, null] }), canonicalEncode({ a: [true, null], b: 2 }));
  assert.notEqual(canonicalEncode("1"), canonicalEncode(1));
  assert.notEqual(canonicalEncode(0), canonicalEncode(-0));

  const fabric = new FactFabric();
  commit(fabric, [{ op: "assert", e: "decision:1", a: "decision/vector", v: { yes: 2, no: 1 } }]);
  assert.equal(fabric.view().match({ a: "decision/vector", v: { no: 1, yes: 2 } }).length, 1);
});

test("unsupported values and malformed operations fail closed", () => {
  const invalidValues = [undefined, Infinity, -Infinity, Number.NaN, 1n, Symbol("x"), () => true, new Date(), /x/];
  for (const value of invalidValues) {
    const fabric = new FactFabric();
    assert.throws(() => commit(fabric, [{ op: "assert", e: "e", a: "a", v: value }]));
    assert.equal(fabric.basis, 0);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalEncode(cyclic), /cycle/);
  assert.throws(() => canonicalEncode(new Array(2)), /sparse hole/);
  assert.throws(() => commit(new FactFabric(), [{ op: "guess", e: "e", a: "a", v: true }]), /assert or retract/);
});

test("index planner chooses bounded access paths without changing answers", () => {
  const fabric = new FactFabric();
  commit(fabric, [
    { op: "assert", e: "unit:1", a: "lane", v: "write" },
    { op: "assert", e: "unit:1", a: "confidence", v: 0.9 },
    { op: "assert", e: "unit:2", a: "lane", v: "authority" },
  ]);
  assert.equal(fabric.view().explain({ e: "unit:1", a: "lane", v: "write" }).index, "EAV");
  assert.equal(fabric.view().explain({ e: "unit:1", a: "lane" }).index, "EA");
  assert.equal(fabric.view().explain({ a: "lane", v: "write" }).index, "AV");
  assert.equal(fabric.view().explain({ a: "lane" }).index, "A");
  assert.equal(fabric.view().explain({ e: "unit:1" }).index, "E");
  assert.equal(fabric.view().explain({ v: "write" }).index, "V");
  assert.equal(fabric.view().explain({}).index, "SCAN");
});

test("randomized indexed current, temporal, and history reads equal reference scans", () => {
  const fabric = new FactFabric();
  const random = mulberry32(0xB4A74);
  const entities = Array.from({ length: 12 }, (_, index) => `entity:${index}`);
  const attributes = ["status", "lane", "score", "payload"];
  const values = [true, false, null, "ready", "blocked", 3, { rank: 2, tags: ["a", "b"] }];

  for (let tx = 0; tx < 80; tx += 1) {
    const operations = Array.from({ length: 1 + Math.floor(random() * 5) }, () => ({
      op: random() < 0.72 ? "assert" : "retract",
      e: pick(entities, random),
      a: pick(attributes, random),
      v: structuredClone(pick(values, random)),
    }));
    commit(fabric, operations, `worker:${tx % 4}`, tx % 3 === 0 ? "measurement" : "observation");
  }

  const patterns = [{}];
  for (let index = 0; index < 180; index += 1) {
    const e = pick(entities, random);
    const a = pick(attributes, random);
    const v = structuredClone(pick(values, random));
    patterns.push(...[{ e }, { a }, { v }, { e, a }, { a, v }, { e, a, v }]);
  }
  for (const basis of [0, 1, 17, 39, fabric.basis]) {
    for (const pattern of patterns) {
      assert.deepEqual(fabric.asOf(basis).match(pattern), fabric.asOf(basis).match(pattern, { strategy: "scan" }));
    }
  }
  for (const pattern of patterns) {
    assert.deepEqual(fabric.history(pattern), fabric.history(pattern, { strategy: "scan" }));
  }
});

function pick(values, random) { return values[Math.floor(random() * values.length)]; }

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
