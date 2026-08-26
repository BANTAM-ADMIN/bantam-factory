#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderCognitiveActuationFoundry } from "../src/factory.js";
const input = resolve(process.argv[2] ?? ".bantam/factory-benchmarks/cognitive-actuation-foundry-v1.json");
const output = resolve(process.argv[3] ?? ".bantam/factory-reports/cognitive-actuation-foundry-v1.html");
const report = JSON.parse(await readFile(input, "utf8")); await mkdir(dirname(output), { recursive: true }); await writeFile(output, renderCognitiveActuationFoundry(report));
console.log(JSON.stringify({ input, output, articles: report.articles.map((row) => ({ id: row.id, status: row.result.status })) }, null, 2));
