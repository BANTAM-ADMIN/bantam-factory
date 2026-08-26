#!/usr/bin/env node
// Replay every recorded hidden-PASS implementation against a fixture's CURRENT
// public suite, to find assertions that reject correct work.
//
//   node examples/experiments/golden-replay-report.mjs <fixture-dir> [alt-public-test.js]
//
// The optional second argument swaps in a different public suite, which is how
// the instrument itself is calibrated: point it at a suite known to contain an
// invented requirement and it must report one.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractGoldenSpecimens,
  summarizeGoldenReplay,
  formatGoldenReplay,
} from "../../src/logic/golden-replay.js";

const fixture = process.argv[2];
const altSuite = process.argv[3];
if (!fixture) {
  console.error("usage: golden-replay-report.mjs <fixture-dir> [alt-public-test.js]");
  process.exit(2);
}

const runsDir = path.join(fixture, "runs");
const records = fs.existsSync(runsDir)
  ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort().map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf8")); } catch { return null; }
    }).filter(Boolean)
  : [];

const { specimens, rejected } = extractGoldenSpecimens(records);
console.log(`[golden-replay] ${records.length} recorded run(s); `
  + `${specimens.length} replayable known-good, `
  + `${rejected.failedContract} did not pass the hidden grader, `
  + `${rejected.unusableDiff} had no usable diff.`);

const results = [];
for (const specimen of specimens) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-golden-"));
  try {
    fs.cpSync(path.join(fixture, "repo"), ws, { recursive: true });
    const patch = path.join(ws, ".specimen.diff");
    fs.writeFileSync(patch, specimen.diff);
    let applied = true;
    try {
      execFileSync("git", ["apply", "--unsafe-paths", "--directory=.", patch], { cwd: ws, stdio: "pipe" });
    } catch {
      applied = false;
    }
    fs.rmSync(patch, { force: true });
    if (altSuite) fs.copyFileSync(altSuite, path.join(ws, "test", "public.test.js"));

    let failures = [];
    let publicFail = 0;
    if (applied) {
      let out = "";
      try {
        out = execFileSync("node", ["--test"], { cwd: ws, encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }
      failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
      publicFail = failures.length;
    }
    results.push({ runId: specimen.runId, applied, publicFail, failures });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

const summary = summarizeGoldenReplay(results);
console.log(formatGoldenReplay(summary));
process.exit(summary.verdict === "invented-requirement" ? 1 : 0);
