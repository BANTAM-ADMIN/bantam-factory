#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderCodexExocortexCohort } from "../src/factory.js";
const input = resolve(process.argv[2] ?? ".bantam/factory-benchmarks/codex-repository-exocortex-cohort-v2.json");
const output = resolve(process.argv[3] ?? ".bantam/factory-reports/codex-repository-exocortex-cohort-v2.html");
const report = JSON.parse(await readFile(input, "utf8"));
await mkdir(dirname(output), { recursive: true }); await writeFile(output, renderCodexExocortexCohort(report));
console.log(JSON.stringify({ input, output, articles: report.arms.length, exact: report.arms.filter((row) => row.score.exact).length }, null, 2));
