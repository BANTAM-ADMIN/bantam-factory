// One bounded semantic operation: select one test scenario for one obligation
// from a finite public rack, then compare it with an independent expected ID.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../journal.js";
import { ModelClient } from "../model.js";
import { compileFactoryBlueprint, runFactoryBlueprint } from "./blueprint.js";
import { gaugeRef } from "./compatibility-line.js";

const PACKET_KIND = "bantam.test-obligation";
const SELECTION_KIND = "bantam.test-scenario-selection";
const ID = /^[a-z][a-z0-9-]*$/;
const BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/test-scenario-cell.json", import.meta.url)), "utf8"));
const qualificationPolicyBody = Object.freeze({
  schema: 1,
  kind: "bantam.factory-qualification-policy",
  id: "test-scenario-first-cohort",
  version: 1,
  taskFamily: "test-scenario-selection",
  minimumArticles: 5,
  minimumYield: 1,
  maximumEscapes: 0,
  maximumFalseStops: 0,
  maximumP95Ms: 5_000,
  maximumMeanTotalTokens: 700,
});
export const TEST_SCENARIO_QUALIFICATION_POLICY = deepFreeze({ ...qualificationPolicyBody, ref: `qualification-policy:${qualificationPolicyBody.id}@${qualificationPolicyBody.version}:sha256:${sha256(canonicalJson(qualificationPolicyBody))}` });

export function testScenarioCellLine() {
  return compileFactoryBlueprint(BLUEPRINT_SOURCE);
}

export async function runTestScenarioFactoryCell({
  root,
  jobId = null,
  edgeId,
  obligation,
  scenarios,
  expectedScenario,
  model = undefined,
  nPredict = 256,
  signal = null,
} = {}) {
  const packet = defineTestObligationPacket({ edgeId, obligation, scenarios });
  const expected = requiredId(expectedScenario, "expected test scenario");
  if (!packet.scenarios.some((row) => row.id === expected)) throw new Error(`expected test scenario is absent from public rack: ${expected}`);
  if (!Number.isInteger(nPredict) || nPredict < 24 || nPredict > 1024) throw new Error("test scenario nPredict must be from 24 to 1024");
  const initialProductRevision = `artifact:${sha256(canonicalJson(packet))}`;
  const id = jobId === null ? `test-scenario-${Date.now()}-${crypto.randomBytes(3).toString("hex")}` : requiredId(jobId, "test scenario job id");
  const grammar = testScenarioGrammar(packet.scenarios.map((row) => row.id));
  const prompt = formatTestScenarioPrompt(packet);
  const ownsModel = model === undefined;
  const worker = model ?? new ModelClient();
  const compiled = testScenarioCellLine();
  const { route, assets } = compiled;
  let parsedSelection = null;
  const adapters = {
    "bantam.factory.test-obligation-intake/v1": async (order) => ({ productRevision: order.inputProductRevision, outputs: { obligation: packet } }),
    "bantam.factory.test-scenario-selector/v1": async (order, { emit }) => {
      const before = usageSnapshot(worker);
      emit("worker-button", {
        schema: 1,
        kind: "bantam.factory-worker-button",
        stationAttempt: order.stationAttempt,
        workerRef: modelIdentity(worker),
        prompt,
        grammar,
        authority: order.authority,
      });
      const completion = await worker.complete(prompt, { grammar, nPredict, signal, recordLabel: "factory-test-scenario" });
      emit("worker-peck", {
        schema: 1,
        kind: "bantam.factory-worker-peck",
        stationAttempt: order.stationAttempt,
        workerRef: modelIdentity(worker),
        response: completion.content,
        tokens: integer(completion.tokens),
        stoppedEos: Boolean(completion.stoppedEos),
        stoppedLimit: Boolean(completion.stoppedLimit),
      });
      return {
        productRevision: order.inputProductRevision,
        outputs: { selection: { schema: 1, kind: "bantam.test-scenario-response", raw: String(completion.content ?? "") } },
        performance: modelPerformance(worker, before),
      };
    },
    "bantam.factory.test-scenario-inspection/v1": async (order) => ({ productRevision: order.inputProductRevision, outputs: { selection: input(order, "selection") } }),
  };
  const gauges = {
    [gaugeRef(assets.intake)]: async () => ({ status: "pass", evidence: [{ kind: "test-obligation-admitted", edgeId: packet.edgeId, packetDigest: sha256(canonicalJson(packet)), scenarioIds: packet.scenarios.map((row) => row.id) }] }),
    [gaugeRef(assets.select)]: async (order) => {
      const validation = validateTestScenarioResponse(output(order, "selection").raw, packet.scenarios);
      parsedSelection = validation.selection;
      return { status: validation.pass ? "pass" : "fail", evidence: [{ kind: "test-scenario-shape-gauge", ...validation }] };
    },
    [gaugeRef(assets.inspection)]: async (order) => {
      const validation = validateTestScenarioResponse(input(order, "selection").raw, packet.scenarios);
      const actual = validation.selection?.scenarioId ?? null;
      const pass = validation.pass && actual === expected;
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "test-scenario-exact-gauge", pass, edgeId: packet.edgeId, expectedDigest: sha256(expected), selected: actual }] };
    },
  };
  try {
    const line = await runFactoryBlueprint({
      compiled,
      root,
      jobId: id,
      task: packet.description,
      initialProductRevision,
      adapters,
      gauges,
      workspaceLabel: `obligation://${packet.edgeId}/${id}`,
      signal,
    });
    return deepFreeze({
      schema: 1,
      kind: "bantam.factory-test-scenario-result",
      jobId: id,
      status: line.supervisor.status,
      stationRef: assets.select.ref,
      routeRef: route.ref,
      edgeId: packet.edgeId,
      selection: parsedSelection,
      expectedDigest: sha256(expected),
      line,
    });
  } finally {
    if (ownsModel) worker.close?.();
  }
}

export function certifyTestScenarioWorker({ workforce, workerRef } = {}) {
  if (!workforce || typeof workforce.project !== "function" || typeof workforce.qualify !== "function") throw new TypeError("test scenario certification requires a workforce registry");
  const ref = requiredText(workerRef, "test scenario worker ref", 500);
  const stationRef = testScenarioCellLine().assets.select.ref;
  const state = workforce.project();
  const qualification = state.qualifications.find((row) => row.workerRef === ref && row.stationRef === stationRef && row.taskFamily === TEST_SCENARIO_QUALIFICATION_POLICY.taskFamily);
  if (!qualification) throw new Error("test scenario certification requires imported candidate evidence for the exact station and task family");
  if (qualification.status === "qualified") return deepFreeze({ policy: TEST_SCENARIO_QUALIFICATION_POLICY, qualification, alreadyQualified: true });
  if (qualification.status !== "candidate") throw new Error(`test scenario certification requires candidate status, found ${qualification.status}`);
  const evidence = qualification.evidence;
  const failures = [];
  if (evidence.articles < TEST_SCENARIO_QUALIFICATION_POLICY.minimumArticles) failures.push(`articles ${evidence.articles}/${TEST_SCENARIO_QUALIFICATION_POLICY.minimumArticles}`);
  const yieldRate = evidence.articles ? evidence.passes / evidence.articles : 0;
  if (yieldRate < TEST_SCENARIO_QUALIFICATION_POLICY.minimumYield) failures.push(`yield ${yieldRate.toFixed(3)}/${TEST_SCENARIO_QUALIFICATION_POLICY.minimumYield.toFixed(3)}`);
  if (evidence.escapes > TEST_SCENARIO_QUALIFICATION_POLICY.maximumEscapes) failures.push(`escapes ${evidence.escapes}/${TEST_SCENARIO_QUALIFICATION_POLICY.maximumEscapes}`);
  if (evidence.falseStops > TEST_SCENARIO_QUALIFICATION_POLICY.maximumFalseStops) failures.push(`false-stops ${evidence.falseStops}/${TEST_SCENARIO_QUALIFICATION_POLICY.maximumFalseStops}`);
  if (!Number.isFinite(evidence.p95Ms) || evidence.p95Ms > TEST_SCENARIO_QUALIFICATION_POLICY.maximumP95Ms) failures.push(`p95 ${evidence.p95Ms ?? "unknown"}/${TEST_SCENARIO_QUALIFICATION_POLICY.maximumP95Ms}ms`);
  if (!Number.isFinite(evidence.meanTotalTokens) || evidence.meanTotalTokens > TEST_SCENARIO_QUALIFICATION_POLICY.maximumMeanTotalTokens) failures.push(`mean-tokens ${evidence.meanTotalTokens ?? "unknown"}/${TEST_SCENARIO_QUALIFICATION_POLICY.maximumMeanTotalTokens}`);
  if (evidence.sourceRefs.length < evidence.articles) failures.push(`source-refs ${evidence.sourceRefs.length}/${evidence.articles}`);
  if (failures.length) throw new Error(`test scenario certification policy failed: ${failures.join("; ")}`);
  const event = workforce.qualify({
    workerRef: ref,
    stationRef,
    taskFamily: TEST_SCENARIO_QUALIFICATION_POLICY.taskFamily,
    status: "qualified",
    evidence,
    limits: { maxP95Ms: TEST_SCENARIO_QUALIFICATION_POLICY.maximumP95Ms, maxExpectedCostUsd: null, authority: ["test-obligation.read"] },
    reason: `certified by ${TEST_SCENARIO_QUALIFICATION_POLICY.ref}`,
  });
  const certified = workforce.project().qualifications.find((row) => row.eventId === event.id);
  return deepFreeze({ policy: TEST_SCENARIO_QUALIFICATION_POLICY, qualification: certified, alreadyQualified: false });
}

export function testScenarioGrammar(ids) {
  const normalized = normalizeIds(ids, "test scenario grammar identifier");
  if (normalized.length < 2) throw new Error("test scenario grammar requires at least two choices");
  const choices = normalized.map((id) => JSON.stringify(JSON.stringify(id))).join(" | ");
  return String.raw`root ::= ws "{" ws "\"schema\"" ws ":" ws "1" ws "," ws "\"kind\"" ws ":" ws "\"${SELECTION_KIND}\"" ws "," ws "\"scenarioId\"" ws ":" ws scenario ws "}" ws
scenario ::= ${choices}
ws ::= [ \t\n]*
`;
}

export function validateTestScenarioResponse(raw, scenarios) {
  const allowed = new Set(normalizeScenarios(scenarios).map((row) => row.id));
  let value;
  try { value = JSON.parse(String(raw ?? "").trim()); }
  catch { return deepFreeze({ pass: false, code: "invalid-json", selection: null }); }
  if (!record(value)) return deepFreeze({ pass: false, code: "invalid-object", selection: null });
  if (Object.keys(value).sort().join(",") !== "kind,scenarioId,schema") return deepFreeze({ pass: false, code: "schema-expansion", selection: null });
  if (value.schema !== 1 || value.kind !== SELECTION_KIND || typeof value.scenarioId !== "string") return deepFreeze({ pass: false, code: "invalid-envelope", selection: null });
  if (!allowed.has(value.scenarioId)) return deepFreeze({ pass: false, code: "unknown-scenario", selection: null });
  return deepFreeze({ pass: true, code: "conforming", selection: { schema: 1, kind: SELECTION_KIND, scenarioId: value.scenarioId } });
}

export function defineTestObligationPacket({ edgeId, obligation, scenarios } = {}) {
  return deepFreeze({
    schema: 1,
    kind: PACKET_KIND,
    edgeId: requiredId(edgeId, "test obligation edge id"),
    description: requiredText(obligation, "test obligation description", 1_000),
    scenarios: normalizeScenarios(scenarios),
  });
}

function normalizeScenarios(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) throw new Error("test scenario rack must contain from 2 to 32 entries");
  const seen = new Set();
  return deepFreeze(value.map((entry, index) => {
    if (!record(entry) || Object.keys(entry).sort().join(",") !== "description,id") throw new Error(`test scenario entry ${index} must contain only id and description`);
    const id = requiredId(entry.id, `test scenario entry ${index} id`);
    if (!ID.test(id)) throw new Error(`invalid test scenario identifier: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate test scenario identifier: ${id}`);
    seen.add(id);
    return { id, description: requiredText(entry.description, `test scenario ${id} description`, 500) };
  }));
}

export function formatTestScenarioPrompt(packet) {
  return `You operate one BANTAMFACTORY station. You receive exactly one test obligation. Choose the one public scenario that most directly and completely tests it. Return only the constrained JSON object; do not explain.\n\nOBLIGATION ${packet.edgeId}\n${packet.description}\n\nPUBLIC SCENARIO RACK\n${packet.scenarios.map((row) => `${row.id}: ${row.description}`).join("\n")}\n\nOUTPUT KEYS\nschema, kind, scenarioId`;
}

function modelPerformance(model, before) {
  const after = usageSnapshot(model);
  const delta = before && after ? Object.fromEntries(["requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens", "cacheMissTokens", "reasoningTokens", "costUsd"].map((field) => [field, Math.max(0, Number(after[field] ?? 0) - Number(before[field] ?? 0))])) : null;
  return { workerRef: modelIdentity(model), turns: 1, modelRequests: integer(delta?.requests), inputTokens: integer(delta?.inputTokens), outputTokens: integer(delta?.outputTokens), totalTokens: integer(delta?.totalTokens), cacheHitTokens: integer(delta?.cacheHitTokens), cacheMissTokens: integer(delta?.cacheMissTokens), reasoningTokens: integer(delta?.reasoningTokens), estimatedCostUsd: delta ? Math.max(0, Number(delta.costUsd) || 0) : null };
}

function modelIdentity(model) { if (typeof model?.metadata !== "function") return "local:injected-test-scenario-worker"; const metadata = model.metadata(); return [metadata.runtime ?? "model", metadata.model ?? metadata.profile ?? "unknown", metadata.reasoningEffort].filter(Boolean).join(":"); }
function usageSnapshot(model) { return typeof model?.usageSummary === "function" ? model.usageSummary() : null; }
function input(order, name) { const row = order.inputs.find((entry) => entry.port === name); if (!row) throw new Error(`test scenario work order is missing ${name}`); return row.value; }
function output(order, name) { const row = order.outputs.find((entry) => entry.port === name); if (!row) throw new Error(`test scenario inspection order is missing ${name}`); return row.value; }
function normalizeIds(value, label) { if (!Array.isArray(value)) throw new Error(`${label}s must be an array`); const ids = value.map((entry) => requiredId(entry, label)); if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${label}`); return ids; }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredId(value, label) { const text = String(value ?? ""); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`invalid ${label}: ${text}`); return text; }
function requiredText(value, label, maximum) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`); return text; }
function integer(value) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
