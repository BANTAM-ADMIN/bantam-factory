#!/usr/bin/env node
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { FactFabric } from "../src/factory/fact-fabric.js";
import { pullEntity } from "../src/factory/fact-context.js";

const entityCount = positiveInteger(process.argv[2] ?? 5_000, "entity count");
const queryCount = positiveInteger(process.argv[3] ?? 100_000, "query count");
const attributes = ["unit/status", "unit/lane", "unit/score", "unit/worker"];
const operations = [];
for (let index = 0; index < entityCount; index += 1) {
  operations.push(
    { op: "assert", e: `unit:${index}`, a: attributes[0], v: index % 7 === 0 ? "blocked" : "ready" },
    { op: "assert", e: `unit:${index}`, a: attributes[1], v: `lane:${index % 16}` },
    { op: "assert", e: `unit:${index}`, a: attributes[2], v: index % 101 },
    { op: "assert", e: `unit:${index}`, a: attributes[3], v: `worker:${index % 64}` },
  );
}

const fabric = new FactFabric();
const memoryBefore = process.memoryUsage().heapUsed;
const loadStart = performance.now();
fabric.transact(operations, { src: "benchmark:generator", kind: "synthetic-observation" });
const loadMs = performance.now() - loadStart;
const memoryAfter = process.memoryUsage().heapUsed;
const view = fabric.view();

const queryStart = performance.now();
const indexedDigest = crypto.createHash("sha256");
for (let index = 0; index < queryCount; index += 1) {
  const entity = `unit:${index % entityCount}`;
  const rows = view.match({ e: entity, a: "unit/status" });
  indexedDigest.update(`${entity}:${rows[0]?.v}\n`);
}
const queryMs = performance.now() - queryStart;

// A bounded scan oracle proves that throughput is not being bought with a
// different answer. Full scans are intentionally sampled: they are the slow
// control, not the production access path.
const oracleCount = Math.min(250, queryCount);
const indexedOracle = crypto.createHash("sha256");
const scanOracle = crypto.createHash("sha256");
const scanStart = performance.now();
for (let index = 0; index < oracleCount; index += 1) {
  const pattern = { e: `unit:${(index * 7919) % entityCount}`, a: "unit/status" };
  indexedOracle.update(JSON.stringify(view.match(pattern)));
  scanOracle.update(JSON.stringify(view.match(pattern, { strategy: "scan" })));
}
const scanMs = performance.now() - scanStart;

const pullSpec = { attributes: {
  "unit/status": { as: "status" },
  "unit/lane": { as: "lane" },
  "unit/worker": { as: "worker" },
} };
const pullCount = Math.min(queryCount, 25_000);
const pullStart = performance.now();
const pullDigest = crypto.createHash("sha256");
for (let index = 0; index < pullCount; index += 1) {
  pullDigest.update(pullEntity(view, `unit:${index % entityCount}`, pullSpec).packetId);
}
const pullMs = performance.now() - pullStart;
const indexedOracleHash = indexedOracle.digest("hex");
const scanOracleHash = scanOracle.digest("hex");
if (indexedOracleHash !== scanOracleHash) throw new Error("indexed results diverged from full-scan oracle");

console.log(JSON.stringify({
  schema: "bantam.factory.fact-fabric-benchmark.v1",
  parameters: { entityCount, factCount: operations.length, queryCount, oracleCount, pullCount },
  load: {
    milliseconds: round(loadMs),
    factsPerSecond: rate(operations.length, loadMs),
    approximateHeapDeltaBytes: memoryAfter - memoryBefore,
  },
  indexedEAQueries: {
    accessPath: view.explain({ e: "unit:0", a: "unit/status" }).index,
    milliseconds: round(queryMs),
    queriesPerSecond: rate(queryCount, queryMs),
    checksum: indexedDigest.digest("hex"),
  },
  differentialOracle: {
    millisecondsIncludingBothPaths: round(scanMs),
    indexedChecksum: indexedOracleHash,
    scanChecksum: scanOracleHash,
    equal: true,
  },
  pull: {
    attributesPerPacket: 3,
    milliseconds: round(pullMs),
    packetsPerSecond: rate(pullCount, pullMs),
    checksum: pullDigest.digest("hex"),
  },
}, null, 2));

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}
function round(value) { return Math.round(value * 100) / 100; }
function rate(count, milliseconds) { return Math.round(count / (milliseconds / 1_000)); }
