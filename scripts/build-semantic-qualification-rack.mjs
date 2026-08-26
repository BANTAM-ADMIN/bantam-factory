#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { defineSemanticReviewedRack } from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const kitPath = resolve(option("kit", ".bantam/factory-benchmarks/diffusiongemma-codex-mutation-matrix-v15.json"));
const reviewPath = resolve(option("review", "examples/factory/semantic-reviewed-rack-v1.json"));
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/semantic-qualification-source-rack-v1.json"));
const rackSize = Number(option("units", "56"));
if (!Number.isInteger(rackSize) || rackSize < 56) throw new Error("semantic qualification source rack requires at least 56 units");

const kit = JSON.parse(await readFile(kitPath, "utf8"));
const reviewed = defineSemanticReviewedRack(JSON.parse(await readFile(reviewPath, "utf8")));
if (!Array.isArray(kit.classified) || kit.summary?.dieFailures || kit.summary?.classifiedChunks !== kit.classified.length) throw new Error("source semantic kit must be complete");
const byIdentity = new Map(kit.classified.map((unit) => [identity(unit), unit]));
const coupons = reviewed.units.map((unit) => {
  const exact = byIdentity.get(identity(unit));
  if (!exact) throw new Error(`review coupon is stale or absent from source kit: ${unit.path}:${unit.startLine}-${unit.endLine}`);
  return exact;
});
const couponIds = new Set(coupons.map(identity));
const filler = kit.classified.filter((unit) => !couponIds.has(identity(unit))).sort(compareUnits).slice(0, rackSize - coupons.length);
if (coupons.length + filler.length !== rackSize) throw new Error(`source kit cannot supply ${rackSize} qualification units`);
const selected = [...coupons, ...filler].sort(compareUnits).map((unit, index) => ({
  chunkId: `QUAL-${String(index + 1).padStart(4, "0")}`,
  path: unit.path,
  startLine: unit.startLine,
  endLine: unit.endLine,
  text: unit.text,
  sha256: unit.sha256,
}));
const body = {
  schema: "bantam.factory.semantic-qualification-source-rack.v1",
  purpose: "Fixed byte-identical source rack for repeatability and independently reviewed semantic sensor qualification.",
  sourceKitRef: `semantic-kit-source:${kit.sourceFingerprint}`,
  reviewedRackRef: reviewed.ref,
  reviewedUnits: coupons.length,
  selected,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(body, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, units: selected.length, reviewedUnits: coupons.length, reviewedRackRef: reviewed.ref, pairwiseDecisionsAcrossThreeArticles: selected.length * 6 * 3 }, null, 2));

function identity(unit) { return `${unit.path}\0${unit.startLine}\0${unit.endLine}\0${unit.sha256}`; }
function compareUnits(a, b) { return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine || a.sha256.localeCompare(b.sha256); }
