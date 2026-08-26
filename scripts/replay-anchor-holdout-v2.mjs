#!/usr/bin/env node

// Offline acceptance replay for anchor-audit v2 (DESIGN-ANCHOR-AUDIT-V2.md).
// Reconstructs every retained v1 holdout registry deterministically (same
// makeRecords as scripts/diffusiongemma-anchor-holdout.mjs), re-audits under
// the v2 floor + case mode, and re-locates every recorded anchor. Zero model
// calls. Registered expectations:
//   1. the 5 case-only unmatched runs re-locate to the correct record;
//   2. the 3 wrong-record escapes are unchanged (folding admits none);
//   3. zero runs become ambiguous or move to a different located record;
//   4. floor honesty: how many v1-dispatched registries the v2 floor demotes.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { auditAnchorRegistry, createVerbatimAnchorLocator } from "../src/factory.js";

const input = resolve(process.argv[2] ?? ".bantam/factory-benchmarks/diffusiongemma-anchor-holdout-v1.json");
const output = resolve(process.argv[3] ?? ".bantam/factory-benchmarks/anchor-holdout-v2-replay.json");
const holdout = JSON.parse(readFileSync(input, "utf8"));

const targetText = "Release evidence targets a superseded revision rather than the current article.";
const neighborText = [
  "Release evidence targets the current approved revision rather than a superseded article.",
  "Archived evidence targets a superseded revision rather than the current release article.",
  "Release evidence targets a superseded calibration certificate rather than the current instrument.",
  "Release authorization references a superseded revision but the evidence targets the current article.",
  "Release evidence mentions a superseded revision while still targeting the current article.",
  "Customer evidence targets a superseded revision rather than the current release article.",
  "Release evidence targets a superseded requirement rather than the current revision.",
  "Release evidence rejects a superseded revision and targets the current article.",
  "Release evidence targets the previous article rather than its current revision.",
  "Inspection evidence targets a superseded revision rather than the current article.",
  "Release evidence targets a superseded revision rather than the current instrument.",
  "Release evidence targets a pending revision rather than the current article.",
  "Release evidence targets a superseded revision and the current article simultaneously.",
  "Release evidence targets a superseded revision rather than the archived article.",
  "Draft evidence targets a superseded revision rather than the current article.",
  "Release evidence targets the superseded article rather than the current revision.",
];

// Byte-identical to the holdout script's construction; the replay is invalid
// if this drifts, so the target-record check below asserts reconstruction.
function makeRecords(neighbors, trial) {
  const targetPosition = [3, 17, 31, 47][trial % 4];
  const special = [targetText, ...neighborText.slice(0, neighbors)];
  const records = Array.from({ length: 64 }, (_, index) => ({
    point: `H${String(trial + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    text: `Routine observation ${trial + 1}-${index + 1}: thermal readings are nominal, calibration is current, and no release evidence exception exists.`,
    target: false,
  }));
  const positions = [targetPosition];
  for (let cursor = 0; positions.length < special.length; cursor += 1) {
    const candidate = (targetPosition + 7 + cursor * 11) % records.length;
    if (!positions.includes(candidate)) positions.push(candidate);
  }
  for (let index = 0; index < special.length; index += 1) records[positions[index]] = { ...records[positions[index]], text: special[index], target: index === 0 };
  const by = (trial * 13 + neighbors * 3) % records.length;
  return [...records.slice(by), ...records.slice(0, by)];
}

const rows = [];
const tally = { runs: 0, reconstructionMismatches: 0, unchanged: 0, recovered: 0, regressed: 0, newlyAmbiguous: 0, floorDemotedRegistries: 0, v2RegistryRejected: 0, caseModes: { insensitive: 0, sensitive: 0 } };

for (const run of holdout.runs) {
  const records = makeRecords(run.neighbors, run.trial - 1);
  const expectedTarget = records.find((row) => row.target)?.point ?? null;
  if (expectedTarget !== run.target) {
    tally.reconstructionMismatches += 1;
    rows.push({ trial: run.trial, neighbors: run.neighbors, verdict: "reconstruction-mismatch", expectedTarget, recordedTarget: run.target });
    continue;
  }
  tally.runs += 1;
  const audit = auditAnchorRegistry(records);
  tally.caseModes[audit.caseMode] += 1;
  const v1Dispatched = run.outcome !== "registry-rejected";
  if (!audit.separable) {
    tally.v2RegistryRejected += 1;
    if (v1Dispatched) tally.floorDemotedRegistries += 1;
    rows.push({ trial: run.trial, neighbors: run.neighbors, v1: run.outcome, verdict: "v2-registry-rejected", subFloorOnly: audit.subFloorOnly });
    continue;
  }
  if (!v1Dispatched) {
    rows.push({ trial: run.trial, neighbors: run.neighbors, v1: run.outcome, verdict: "v1-rejected-v2-dispatchable" });
    continue;
  }
  const anchor = run.anchor ?? run.location?.anchor ?? null;
  if (typeof anchor !== "string" || !anchor.length) {
    rows.push({ trial: run.trial, neighbors: run.neighbors, v1: run.outcome, verdict: "no-anchor-recorded" });
    tally.unchanged += 1;
    continue;
  }
  const locator = createVerbatimAnchorLocator(records);
  const located = locator.locate(anchor);
  const v2Outcome = located.disposition === "located"
    ? (located.id === run.target ? "correct-location" : "wrong-location-escape")
    : located.disposition;
  let verdict;
  if (v2Outcome === run.outcome) { verdict = "unchanged"; tally.unchanged += 1; }
  else if (run.outcome === "unmatched" && v2Outcome === "correct-location") { verdict = "recovered"; tally.recovered += 1; }
  else if (v2Outcome === "ambiguous") { verdict = "newly-ambiguous"; tally.newlyAmbiguous += 1; }
  else { verdict = "regressed"; tally.regressed += 1; }
  rows.push({ trial: run.trial, neighbors: run.neighbors, v1: run.outcome, v2: v2Outcome, caseMode: audit.caseMode, verdict, anchor });
}

const report = {
  schema: "bantam.factory.anchor-holdout-v2-replay.v1",
  input,
  generatedBy: "scripts/replay-anchor-holdout-v2.mjs",
  spec: "docs/BANTAMFACTORY/DESIGN-ANCHOR-AUDIT-V2.md",
  floor: { minWords: 2, minChars: 8, maxWords: 8 },
  tally,
  rows,
};
writeFileSync(output, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(tally, null, 1));
console.log(`retained: ${output}`);

const failures = [];
if (tally.reconstructionMismatches) failures.push(`reconstruction mismatches: ${tally.reconstructionMismatches}`);
if (tally.recovered !== 5) failures.push(`expected 5 recoveries, saw ${tally.recovered}`);
if (tally.regressed) failures.push(`regressions: ${tally.regressed}`);
if (tally.newlyAmbiguous) failures.push(`newly ambiguous: ${tally.newlyAmbiguous}`);
if (failures.length) { console.error(`ACCEPTANCE FAILED: ${failures.join("; ")}`); process.exit(1); }
console.log("ACCEPTANCE PASSED");
