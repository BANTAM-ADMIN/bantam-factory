#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderCodexMutationCohort } from "../src/factory.js";
const input = resolve(process.argv[2] ?? ".bantam/factory-benchmarks/codex-exocortex-mutation-cohort-v8.json");
const output = resolve(process.argv[3] ?? ".bantam/factory-reports/codex-exocortex-mutation-cohort-v8.html");
const report = JSON.parse(await readFile(input, "utf8"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, renderCodexMutationCohort(report));
console.log(JSON.stringify({ input, output, articles: report.arms.length, released: report.arms.filter((row) => row.audit.disposition === "released").length }, null, 2));
