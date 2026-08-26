#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { compileCacheAffineShiftPrompt, compileRepositoryShiftPacket, parseCodexCohortRun, repositoryAssessmentGauge, RepositoryGovernanceCell, scoreRepositoryAssessment } from "../src/factory.js";
import { spawnExternalAgent } from "../src/logic/external-agent.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const outputPath = resolve(option("output", ".bantam/factory-benchmarks/codex-repository-exocortex-cohort-v3.json"));
const schemaPath = resolve(option("schema", ".bantam/factory-benchmarks/codex-repository-assessment.schema.json"));
const model = option("model", "gpt-5.6-terra"), effort = option("effort", "medium");
const repetitions = Number(option("repetitions", "2")), timeoutMs = Number(option("timeout-ms", "600000"));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("--repetitions must be from 1 to 5");
if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new Error("--timeout-ms must be at least 10000");

const root = await mkdtemp(join(tmpdir(), "bantam-codex-exocortex-cohort-"));
try {
  const fixture = await buildFixture(root);
  const answerSchema = {
    type: "object",
    properties: {
      affectedTests: { type: "array", items: { type: "string" } },
      affectedRequirements: { type: "array", items: { type: "string" } },
      releaseDisposition: { type: "string", enum: ["blocked", "ready-for-authority-review", "undetermined"] },
      blockers: { type: "array", items: { type: "object", properties: { code: { type: "string", enum: ["stale-evidence", "stale-authority"] }, requirement: { type: "string" } }, required: ["code", "requirement"], additionalProperties: false } },
      nextOperations: { type: "array", items: { type: "string", enum: ["refresh-evidence", "request-approval", "run-verification", "request-release-decision"] } },
    },
    required: ["affectedTests", "affectedRequirements", "releaseDisposition", "blockers", "nextOperations"],
    additionalProperties: false,
  };
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, `${JSON.stringify(answerSchema, null, 2)}\n`);

  const instruction = [
    "Act as a read-only repository release-assessment worker.",
    "The changed material is src/core.js.",
    "Return every transitively affected test, every affected governed requirement, the current release disposition, every blocker as {code,requirement}, and the unique next operation names.",
    "Sort every array lexicographically (blockers by code then requirement), do not add prose, do not mutate files, and do not infer that a proposed operation has executed.",
  ].join(" ");
  const controlPrompt = `${instruction}\n\nCONTROL INTAKE: inspect the repository and governance.json using read-only tools. Source imports define dependency direction. governance.json is the authoritative accepted mapping, evidence basis, approval basis, current fingerprint, and supersession relationship. Reconstruct the answer yourself.`;
  const cachePrompt = compileCacheAffineShiftPrompt({ packet: fixture.packet });
  const treatmentPrompt = cachePrompt.prompt;

  const arms = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const schedule = repetition % 2 === 1
      ? [["control", controlPrompt], ["exocortex", treatmentPrompt]]
      : [["exocortex", treatmentPrompt], ["control", controlPrompt]];
    for (const [arm, prompt] of schedule) {
      const run = await spawnExternalAgent("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--model", model, "-c", `model_reasoning_effort=\"${effort}\"`, "--sandbox", "read-only", "--output-schema", schemaPath, "--json", prompt], { cwd: root, timeoutMs });
      const trace = parseCodexCohortRun(run.stdout), score = scoreRepositoryAssessment(trace.answer, fixture.expected);
      const article = {
        arm, repetition, sequence: arms.length + 1, model, effort,
        prompt: { bytes: Buffer.byteLength(prompt), approximateTokens: Math.ceil(Buffer.byteLength(prompt) / 4), sha256: sha256(prompt) },
        run: { code: run.code, timedOut: run.timedOut, durationMs: run.durationMs, usage: trace.usage, itemTypes: trace.itemTypes, commands: trace.commands, traceId: trace.traceId, stderrTail: run.stderr.slice(-1200) },
        score, answer: trace.answer,
      };
      arms.push(article);
      console.log(JSON.stringify({ arm, repetition, exact: score.exact, durationMs: run.durationMs, usage: trace.usage, commands: trace.commands.length }));
    }
  }

  const reportBody = {
    schema: "bantam.factory.codex-repository-exocortex-cohort.v1",
    completedAt: new Date().toISOString(),
    question: "Does a proof-bearing Repository Exocortex reduce Codex reconstruction work while preserving exact release assessment?",
    design: { matchedModel: true, matchedEffort: true, matchedAnswerDie: true, crossoverOrder: true, readOnly: true, repetitions, control: "repository plus explicit accepted governance record", treatment: "same repository plus bounded shift-packet briefing" },
    inputs: { model, effort, fixture: fixture.manifest, packet: { packetId: fixture.packet.packetId, estimatedTokens: fixture.packet.estimatedTokens, products: fixture.packet.products.length, omissions: fixture.packet.omissions }, cacheLayout: { standardWorkRef: cachePrompt.standardWorkRef, prefixId: cachePrompt.prefixId, tailId: cachePrompt.tailId, metrics: cachePrompt.metrics }, expected: fixture.expected, answerSchema: schemaPath },
    arms,
    aggregate: { control: summarize(arms.filter((row) => row.arm === "control")), exocortex: summarize(arms.filter((row) => row.arm === "exocortex")) },
    caveats: ["Small first cohort; repeat before qualification.", "Synthetic import-chain factory article, not a general coding task.", "Codex usage includes its own tool interaction and may vary with service caching.", "Exactness is independently gauged from typed factory products."],
  };
  const report = { ...reportBody, reportId: `codex-repository-exocortex-cohort:sha256:${sha256(JSON.stringify(reportBody))}` };
  report.comparison = compare(report.aggregate.control, report.aggregate.exocortex);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: arms.every((row) => row.score.exact) ? "exact-cohort" : "quality-escape", aggregate: report.aggregate, comparison: report.comparison, reportPath: outputPath }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function buildFixture(root) {
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n");
  await writeFile(join(root, "src", "core.js"), "export const value = 1;\n");
  for (let index = 1; index < 80; index += 1) {
    const prior = index === 1 ? "core" : `module-${String(index - 1).padStart(2, "0")}`;
    await writeFile(join(root, "src", `module-${String(index).padStart(2, "0")}.js`), `import { value as prior } from './${prior}.js';\nexport const value = prior + 1;\n`);
  }
  const testIndices = [0, 5, 10, 20, 40, 60, 70, 79];
  for (const index of testIndices) {
    const source = index === 0 ? "core" : `module-${String(index).padStart(2, "0")}`;
    await writeFile(join(root, "test", `${source}.test.js`), `import { value } from '../src/${source}.js';\nif (!Number.isInteger(value)) throw new Error('bad value');\n`);
  }
  const requirements = [
    { requirement: "requirement:core-value", component: "src/core.js", test: "test/core.test.js", authority: "authority:core-board", fingerprint: "current" },
    { requirement: "requirement:module-40-value", component: "src/module-40.js", test: "test/module-40.test.js", authority: "authority:platform-board", fingerprint: "current" },
    { requirement: "requirement:module-79-value", component: "src/module-79.js", test: "test/module-79.test.js", authority: "authority:release-board", fingerprint: "current" },
  ];
  const cell = new RepositoryGovernanceCell({ root });
  let original;
  for (const governance of requirements) original = cell.cycle({ changedPaths: ["src/core.js"], governance });
  const oldFingerprint = original.source.fingerprint;
  await writeFile(join(root, "src", "core.js"), "export const value = 2;\n");
  const changed = cell.cycle({ changedPaths: ["src/core.js"] });
  const packet = compileRepositoryShiftPacket({ task: "Assess the changed core for governed release readiness.", bus: cell.bus, registry: cell.registry, cell: cell.cell, focus: { paths: ["src/core.js"], requirements: requirements.map((row) => row.requirement) }, limits: { maxProducts: 32, maxDependenciesPerProduct: 6 } });
  const expected = repositoryAssessmentGauge(packet);
  const governanceRecord = {
    schema: 1,
    kind: "accepted-governance-record",
    changed: "src/core.js",
    currentFingerprint: changed.source.fingerprint,
    supersedes: oldFingerprint,
    requirements: requirements.map(({ fingerprint: _fingerprint, ...row }) => ({ ...row, evidenceValidatedFingerprint: oldFingerprint, authorityApprovedFingerprint: oldFingerprint })),
    nextOperationPolicy: {
      affectedTest: "run-verification",
      staleEvidence: "refresh-evidence",
      staleAuthority: "request-approval",
      releaseReady: "request-release-decision",
    },
  };
  await writeFile(join(root, "governance.json"), `${JSON.stringify(governanceRecord, null, 2)}\n`);
  const files = ["src/core.js", ...Array.from({ length: 79 }, (_, index) => `src/module-${String(index + 1).padStart(2, "0")}.js`), ...testIndices.map((index) => `test/${index === 0 ? "core" : `module-${String(index).padStart(2, "0")}`}.test.js`), "governance.json"];
  return { packet, expected, manifest: { kind: "synthetic-linear-repository-governance-article", modules: 80, tests: testIndices.length, requirements: requirements.length, changed: "src/core.js", oldFingerprint, currentFingerprint: changed.source.fingerprint, fileManifestSha256: sha256(files.join("\n")), expectedSha256: sha256(JSON.stringify(expected)) } };
}

function summarize(rows) {
  const usage = (key) => rows.map((row) => Number(row.run.usage?.[key] ?? 0));
  const uncached = rows.map((row) => Math.max(0, Number(row.run.usage?.input_tokens ?? 0) - Number(row.run.usage?.cached_input_tokens ?? 0)));
  return { articles: rows.length, exact: rows.filter((row) => row.score.exact).length, yield: rows.filter((row) => row.score.exact).length / rows.length, durationMs: stats(rows.map((row) => row.run.durationMs)), commands: stats(rows.map((row) => row.run.commands.length)), inputTokens: stats(usage("input_tokens")), cachedInputTokens: stats(usage("cached_input_tokens")), uncachedInputTokens: stats(uncached), outputTokens: stats(usage("output_tokens")), reasoningOutputTokens: stats(usage("reasoning_output_tokens")) };
}
function compare(control, treatment) { return { exactYieldDelta: treatment.yield - control.yield, medianDurationRatio: ratio(treatment.durationMs.median, control.durationMs.median), meanDurationRatio: ratio(treatment.durationMs.mean, control.durationMs.mean), medianCommandRatio: ratio(treatment.commands.median, control.commands.median), medianInputTokenRatio: ratio(treatment.inputTokens.median, control.inputTokens.median), meanInputTokenRatio: ratio(treatment.inputTokens.mean, control.inputTokens.mean), meanUncachedInputTokenRatio: ratio(treatment.uncachedInputTokens.mean, control.uncachedInputTokens.mean), medianOutputTokenRatio: ratio(treatment.outputTokens.median, control.outputTokens.median), meanReasoningTokenRatio: ratio(treatment.reasoningOutputTokens.mean, control.reasoningOutputTokens.mean) }; }
function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], median: percentile(sorted, .5), max: sorted.at(-1), mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length }; }
function percentile(sorted, fraction) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]; }
function ratio(value, baseline) { return baseline === 0 ? (value === 0 ? 1 : null) : value / baseline; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
