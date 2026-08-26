#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSemanticObject } from "../src/factory/semantic-object.js";

const argv = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};
const artifactPath = resolve(option("artifact", ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v1.json"));
const relation = option("relation");
if (!relation) throw new TypeError("--relation is required");
const pattern = JSON.parse(option("pattern", "[]"));
if (!Array.isArray(pattern) || pattern.some((term) => typeof term !== "string")) {
  throw new TypeError("--pattern must be a JSON array of string terms");
}
const iterations = Number(option("iterations", "1"));
if (!Number.isInteger(iterations) || iterations < 1) throw new TypeError("--iterations must be a positive integer");

const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const db = loadSemanticObject(artifact);
let rows = [];
let checksum = 0;
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  rows = db.query(relation, ...pattern);
  checksum += rows.length;
}
const elapsedMs = performance.now() - started;
const exact = pattern.length > 0 && pattern.every((term) => !term.startsWith("?"));
const proof = argv.includes("--explain") && exact && rows.length
  ? db.explain(relation, ...rows[0].slice(0, pattern.length))
  : null;
console.log(JSON.stringify({
  artifactId: artifact.artifactId,
  relation,
  pattern,
  rows: iterations === 1 ? rows : rows.slice(0, 20),
  rowCount: rows.length,
  iterations,
  elapsedMs,
  queriesPerSecond: iterations / (elapsedMs / 1000),
  checksum,
  proof,
}, null, 2));
