#!/usr/bin/env node
import { FactFabric } from "../../src/factory/fact-fabric.js";
import { FactOverlay, FactSourceRegistry, pullEntity } from "../../src/factory/fact-context.js";
import { FactDatalogBridge } from "../../src/factory/fact-datalog-bridge.js";

const world = new FactFabric();
world.transact([
  { op: "assert", e: "article:taurus-7", a: "article/station", v: "station:drill" },
  { op: "assert", e: "article:taurus-7", a: "article/status", v: "waiting" },
  { op: "assert", e: "article:taurus-7", a: "article/requirement", v: "pattern:three-holes" },
  { op: "assert", e: "pattern:three-holes", a: "pattern/hole", v: "A" },
  { op: "assert", e: "pattern:three-holes", a: "pattern/hole", v: "B" },
  { op: "assert", e: "pattern:three-holes", a: "pattern/hole", v: "C" },
  { op: "assert", e: "station:drill", a: "station/worker", v: "worker:chicken-12" },
  { op: "assert", e: "worker:chicken-12", a: "worker/healthy", v: true },
], { src: "supervisor:line-1", kind: "accepted-state" });
world.snapshot("shift-start");

const workforce = new FactFabric();
workforce.transact([
  { op: "assert", e: "worker:chicken-12", a: "qualification/operation", v: "drill-three-holes" },
], { src: "quality:qualification-ledger", kind: "reviewed-qualification" });

const sources = new FactSourceRegistry({ $world: world.view(), $workforce: workforce.view() });
const logic = new FactDatalogBridge({ sources });
logic.ingest({ source: "$world", relation: "assigned", pattern: { a: "station/worker" }, fields: ["e", "v"] });
logic.ingest({ source: "$world", relation: "healthy", pattern: { a: "worker/healthy" }, fields: ["e", "v"] });
logic.ingest({ source: "$workforce", relation: "qualified", pattern: { a: "qualification/operation" }, fields: ["e", "v"] });
logic.rule(`eligible(S,W) :- assigned(S,W), healthy(W,${logic.literal(true)}), qualified(W,${logic.literal("drill-three-holes")})`).run();
const eligible = logic.query("eligible", "?station", "?worker");

const proposal = new FactOverlay(world.view(), [
  { op: "retract", e: "article:taurus-7", a: "article/status", v: "waiting" },
  { op: "assert", e: "article:taurus-7", a: "article/status", v: "ready" },
], { name: "dispatch-if-qualified", src: "planner:dispatch" });

const stationPacketSpec = {
  attributes: {
    "article/station": { as: "station" },
    "article/status": { as: "status" },
    "article/requirement": {
      as: "workInstruction",
      ref: { attributes: { "pattern/hole": { as: "holes", many: true, limit: 3 } } },
    },
  },
};
const packet = pullEntity(proposal, "article:taurus-7", stationPacketSpec, {
  sourceName: "$world+$proposal",
  includeEvidence: true,
});

console.log(JSON.stringify({
  demonstration: "one bounded drill-station decision",
  acceptedWorld: {
    basis: world.basis,
    status: world.view().match({ e: "article:taurus-7", a: "article/status" }).map((row) => row.v),
    unchangedAfterProposal: world.view().has("article:taurus-7", "article/status", "waiting"),
  },
  derivedEligibility: eligible,
  eligibilityProof: logic.explain("eligible", ...eligible[0]),
  hypotheticalWorld: {
    overlayId: proposal.overlayId,
    status: proposal.match({ e: "article:taurus-7", a: "article/status" }).map((row) => row.v),
  },
  workerPacket: packet,
  audit: {
    statusAccessPath: world.view().explain({ e: "article:taurus-7", a: "article/status" }),
    statusHistory: world.history({ e: "article:taurus-7", a: "article/status" }),
    shiftStartStatus: world.viewAt("shift-start").match({ e: "article:taurus-7", a: "article/status" }).map((row) => row.v),
  },
}, null, 2));
