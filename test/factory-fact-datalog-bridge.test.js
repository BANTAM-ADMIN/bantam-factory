import test from "node:test";
import assert from "node:assert/strict";
import { FactDatalogBridge, FactFabric, FactOverlay, FactSourceRegistry } from "../src/factory.js";

test("Fact/Datalog bridge derives across sources and retains exact datom proof leaves", () => {
  const world = new FactFabric();
  world.transact([
    { op: "assert", e: "station:drill", a: "station/worker", v: "worker:12" },
    { op: "assert", e: "worker:12", a: "worker/healthy", v: true },
    { op: "assert", e: "worker:string-true", a: "worker/healthy", v: "true" },
  ], { src: "supervisor:line", kind: "accepted-state" });
  const workforce = new FactFabric();
  workforce.transact([
    { op: "assert", e: "worker:12", a: "qualification/operation", v: "drill-v1" },
  ], { src: "quality:ledger", kind: "reviewed-qualification" });

  const sources = new FactSourceRegistry({ $world: world.view(), $workforce: workforce.view() });
  const bridge = new FactDatalogBridge({ sources });
  bridge.ingest({ source: "$world", relation: "assigned", pattern: { a: "station/worker" }, fields: ["e", "v"] });
  bridge.ingest({ source: "$world", relation: "health", pattern: { a: "worker/healthy" }, fields: ["e", "v"] });
  bridge.ingest({ source: "$workforce", relation: "qualified", pattern: { a: "qualification/operation" }, fields: ["e", "v"] });
  const healthy = bridge.literal(true);
  const operation = bridge.literal("drill-v1");
  bridge.rule(`eligible(S,W) :- assigned(S,W), health(W,${healthy}), qualified(W,${operation})`).run();

  assert.deepEqual(bridge.query("eligible", "?station", "?worker"), [["station:drill", "worker:12"]]);
  assert.equal(bridge.has("eligible", "station:drill", "worker:12"), true);
  const proof = bridge.explain("eligible", "station:drill", "worker:12");
  assert.match(proof.rule, /assigned.*health.*qualified/);
  assert.deepEqual(proof.parents.map((parent) => parent.datoms[0].src), [
    "supervisor:line",
    "supervisor:line",
    "quality:ledger",
  ]);
  assert.deepEqual(proof.parents.map((parent) => parent.evidence[0].source), ["$world", "$world", "$workforce"]);
  assert.equal(proof.parents[1].datoms[0].v, true);
  assert.notEqual(bridge.literal(true), bridge.literal("true"), "typed terms must not collapse");
});

test("Fact/Datalog bridge can reason over a proposal without mutating world basis", () => {
  const world = new FactFabric();
  world.transact([
    { op: "assert", e: "article:7", a: "article/status", v: "waiting" },
  ], { src: "line:state", kind: "accepted-state" });
  const proposal = new FactOverlay(world.view(), [
    { op: "retract", e: "article:7", a: "article/status", v: "waiting" },
    { op: "assert", e: "article:7", a: "article/status", v: "ready" },
  ], { src: "planner:what-if" });
  const sources = new FactSourceRegistry({ $proposal: proposal });
  const bridge = new FactDatalogBridge({ sources });
  bridge.ingest({ source: "$proposal", relation: "status", pattern: { a: "article/status" }, fields: ["e", "v"] });
  bridge.rule(`dispatchable(A) :- status(A,${bridge.literal("ready")})`).run();

  assert.deepEqual(bridge.query("dispatchable", "?article"), [["article:7"]]);
  assert.equal(world.view().has("article:7", "article/status", "waiting"), true);
  assert.equal(world.basis, 1);
  assert.equal(bridge.explain("dispatchable", "article:7").parents[0].datoms[0].kind, "hypothesis");
});

test("Fact/Datalog bridge rejects executable projections and mutation after evaluation", () => {
  const world = new FactFabric();
  world.transact([{ op: "assert", e: "e", a: "a", v: 1 }], { src: "s", kind: "k" });
  const bridge = new FactDatalogBridge({ sources: new FactSourceRegistry({ $world: world.view() }) });
  assert.throws(() => bridge.ingest({ source: "$world", relation: "bad-name!" }), /relation/);
  assert.throws(() => bridge.ingest({ source: "$world", relation: "facts", fields: ["constructor"] }), /unsupported/);
  bridge.ingest({ source: "$world", relation: "facts" });
  bridge.run();
  assert.throws(() => bridge.ingest({ source: "$world", relation: "more" }), /after Datalog evaluation/);
  assert.throws(() => bridge.rule("x(X) :- facts(X,A,V)"), /after Datalog evaluation/);
});
