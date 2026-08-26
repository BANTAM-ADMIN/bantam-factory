#!/usr/bin/env node
// Compare recorded Codex runs without spending a Codex call.
//
//   node examples/experiments/codex-efficiency-report.mjs <artifact.json> [more.json ...]
//   node examples/experiments/codex-efficiency-report.mjs gauntlet/fixtures/<f>/runs
//
// A directory argument reports its two most recent runs, which is the common case
// while iterating on prompt assembly: change something, run once, compare.

import fs from "node:fs";
import path from "node:path";

import { codexEfficiency, formatCodexEfficiency } from "../../src/logic/codex-efficiency.js";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: codex-efficiency-report.mjs <artifact.json|runs-dir> [...]");
  process.exit(2);
}

const files = [];
for (const arg of args) {
  if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
    const entries = fs.readdirSync(arg).filter((f) => f.endsWith(".json")).sort();
    files.push(...entries.slice(-2).map((f) => path.join(arg, f)));
  } else {
    files.push(arg);
  }
}

for (const file of files) {
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[codex-efficiency] cannot read ${file}: ${error.message}`);
    continue;
  }
  console.log(formatCodexEfficiency(codexEfficiency(artifact), path.basename(file)));
  console.log();
}
