// A deliberately small read-only model station: select contract edge identifiers
// from a fixed public catalog, then let an independent downstream gauge compare
// the exact selection with held-out expected material.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../journal.js";
import { ModelClient } from "../model.js";
import { compileFactoryBlueprint, runFactoryBlueprint } from "./blueprint.js";
import { gaugeRef } from "./compatibility-line.js";
import { defineTestObligationPacket, formatTestScenarioPrompt, testScenarioGrammar, validateTestScenarioResponse } from "./test-scenario-cell.js";

const RESPONSE_KIND = "bantam.contract-edge-selection";
const EDGE_ID = /^[a-z][a-z0-9-]*$/;
const BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/contract-edge-cell.json", import.meta.url)), "utf8"));
const TEST_PLAN_BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/contract-test-plan-cell.json", import.meta.url)), "utf8"));
const TEST_CASE_BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/contract-test-case-cell.json", import.meta.url)), "utf8"));
const TEST_PLAN_KIND = "bantam.contract-test-plan";

const qualificationPolicyBody = Object.freeze({
  schema: 1,
  kind: "bantam.factory-qualification-policy",
  id: "contract-edge-first-cohort",
  version: 1,
  taskFamily: "contract-edge-enumeration",
  minimumArticles: 5,
  minimumYield: 1,
  maximumEscapes: 0,
  maximumFalseStops: 0,
  maximumP95Ms: 10_000,
  maximumMeanTotalTokens: 1_000,
});
export const CONTRACT_EDGE_QUALIFICATION_POLICY = deepFreeze({
  ...qualificationPolicyBody,
  ref: `qualification-policy:${qualificationPolicyBody.id}@${qualificationPolicyBody.version}:sha256:${sha256(canonicalJson(qualificationPolicyBody))}`,
});

export function contractEdgeCellLine() {
  return compileFactoryBlueprint(BLUEPRINT_SOURCE);
}

export function contractTestPlanCellLine() {
  return compileFactoryBlueprint(TEST_PLAN_BLUEPRINT_SOURCE);
}

export function contractTestCaseCellLine() {
  return compileFactoryBlueprint(TEST_CASE_BLUEPRINT_SOURCE);
}

export async function runContractEdgeFactoryCell(options = {}) {
  return runContractFactoryArticle({ ...options, compiled: contractEdgeCellLine(), includeTestPlan: false });
}

export async function runContractTestPlanFactoryCell(options = {}) {
  return runContractFactoryArticle({ ...options, compiled: contractTestPlanCellLine(), includeTestPlan: true });
}

export async function runContractTestCaseFactoryCell(options = {}) {
  return runContractFactoryArticle({ ...options, compiled: contractTestCaseCellLine(), includeTestPlan: true, includeTestScenario: true });
}

async function runContractFactoryArticle({
  root,
  jobId = null,
  contract,
  catalog,
  expectedEdges,
  model = undefined,
  nPredict = 512,
  signal = null,
  compiled,
  includeTestPlan,
  includeTestScenario = false,
  scenarioEdgeId = null,
  scenarios = null,
  expectedScenario = null,
  planBuilder = buildContractTestPlan,
} = {}) {
  if (includeTestPlan && typeof planBuilder !== "function") throw new TypeError("contract test plan builder must be a function");
  const contractText = requiredText(contract, "contract text", 20_000);
  const normalizedCatalog = normalizeCatalog(catalog);
  const expected = normalizeExpected(expectedEdges, normalizedCatalog);
  let scenarioFixture = null;
  if (includeTestScenario) {
    const edgeId = requiredId(scenarioEdgeId, "scenario obligation edge id");
    if (!expected.includes(edgeId)) throw new Error(`scenario obligation edge is absent from expected plan: ${edgeId}`);
    scenarioFixture = defineTestObligationPacket({ edgeId, obligation: "Pending released plan obligation.", scenarios });
    const expectedId = requiredId(expectedScenario, "expected test scenario");
    if (!scenarioFixture.scenarios.some((row) => row.id === expectedId)) throw new Error(`expected test scenario is absent from public rack: ${expectedId}`);
    scenarioFixture = { edgeId, scenarios: scenarioFixture.scenarios, expected: expectedId };
  }
  if (!Number.isInteger(nPredict) || nPredict < 32 || nPredict > 4096) throw new Error("contract edge nPredict must be from 32 to 4096");
  const packet = deepFreeze({ schema: 1, kind: "bantam.contract-packet", contract: contractText, catalog: normalizedCatalog });
  const initialProductRevision = `artifact:${sha256(canonicalJson(packet))}`;
  const id = jobId === null ? `contract-edge-${Date.now()}-${crypto.randomBytes(3).toString("hex")}` : requiredId(jobId, "contract edge job id");
  const grammar = contractEdgeGrammar(normalizedCatalog.map((row) => row.id));
  const prompt = contractEdgePrompt(packet);
  const ownsModel = model === undefined;
  const worker = model ?? new ModelClient();
  const { route, assets } = compiled;
  const edgeInspection = assets.inspection ?? assets["edge-inspection"];
  let parsedSelection = null;
  let parsedPlan = null;
  let scenarioPacket = null;
  let parsedScenario = null;
  const adapters = {
    "bantam.factory.contract-edge-intake/v1": async (order) => ({ productRevision: order.inputProductRevision, outputs: { contract: packet } }),
    "bantam.factory.contract-edge-enumerator/v1": async (order, { emit }) => {
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
      const completion = await worker.complete(prompt, { grammar, nPredict, signal, recordLabel: "factory-contract-edge" });
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
        outputs: { response: { schema: 1, kind: "bantam.contract-edge-response", raw: String(completion.content ?? "") } },
        performance: modelPerformance(worker, before),
      };
    },
    "bantam.factory.contract-edge-inspection/v1": async (order) => ({
      productRevision: order.inputProductRevision,
      outputs: { response: input(order, "response") },
    }),
  };
  const gauges = {
    [gaugeRef(assets.intake)]: async () => ({ status: "pass", evidence: [{ kind: "contract-packet-admitted", contractDigest: sha256(contractText), catalogIds: normalizedCatalog.map((row) => row.id) }] }),
    [gaugeRef(assets.enumerate)]: async (order) => {
      const validation = validateContractEdgeResponse(output(order, "response").raw, normalizedCatalog);
      parsedSelection = validation.selection;
      return { status: validation.pass ? "pass" : "fail", evidence: [{ kind: "contract-edge-shape-gauge", ...validation }] };
    },
    [gaugeRef(edgeInspection)]: async (order) => {
      const validation = validateContractEdgeResponse(input(order, "response").raw, normalizedCatalog);
      const selected = validation.selection?.edges ?? [];
      const missing = expected.filter((idValue) => !selected.includes(idValue));
      const extra = selected.filter((idValue) => !expected.includes(idValue));
      const pass = validation.pass && missing.length === 0 && extra.length === 0;
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "contract-edge-exact-set-gauge", pass, expectedDigest: sha256(canonicalJson(expected)), selected, missing, extra }] };
    },
  };
  if (includeTestPlan) {
    adapters["bantam.factory.contract-test-plan/v1"] = async (order) => {
      const contractPacket = input(order, "contract");
      const validation = validateContractEdgeResponse(input(order, "response").raw, contractPacket.catalog);
      if (!validation.pass) throw new Error(`released contract edge response is invalid: ${validation.code}`);
      const plan = planBuilder({ contract: contractPacket.contract, catalog: contractPacket.catalog, selection: validation.selection });
      return { productRevision: `artifact:${sha256(canonicalJson(plan))}`, outputs: { plan } };
    };
    adapters["bantam.factory.contract-test-plan-inspection/v1"] = async (order) => ({
      productRevision: order.inputProductRevision,
      outputs: { plan: input(order, "plan") },
    });
    gauges[gaugeRef(assets.plan)] = async (order) => {
      const contractPacket = input(order, "contract");
      const selectionValidation = validateContractEdgeResponse(input(order, "response").raw, contractPacket.catalog);
      const validation = validateContractTestPlan(output(order, "plan"), {
        contract: contractPacket.contract,
        catalog: contractPacket.catalog,
        selection: selectionValidation.selection,
      });
      parsedPlan = validation.plan;
      return { status: validation.pass ? "pass" : "fail", evidence: [{ kind: "contract-test-plan-shape-gauge", ...validation }] };
    };
    gauges[gaugeRef(assets["plan-inspection"])] = async (order) => {
      const actual = input(order, "plan");
      const expectedPlan = buildContractTestPlan({ contract: contractText, catalog: normalizedCatalog, selection: { schema: 1, kind: RESPONSE_KIND, edges: expected } });
      const pass = canonicalJson(actual) === canonicalJson(expectedPlan);
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "contract-test-plan-exact-coverage-gauge", pass, actualDigest: sha256(canonicalJson(actual)), expectedDigest: sha256(canonicalJson(expectedPlan)) }] };
    };
  }
  if (includeTestScenario) {
    adapters["bantam.factory.test-obligation-feeder/v1"] = async (order) => {
      const plan = input(order, "plan");
      const matches = plan.obligations.filter((row) => row.edgeId === scenarioFixture.edgeId);
      if (matches.length !== 1) throw new Error(`released plan must contain exactly one ${scenarioFixture.edgeId} obligation`);
      scenarioPacket = defineTestObligationPacket({ edgeId: scenarioFixture.edgeId, obligation: matches[0].description, scenarios: scenarioFixture.scenarios });
      return { productRevision: order.inputProductRevision, outputs: { obligation: scenarioPacket } };
    };
    adapters["bantam.factory.test-scenario-selector/v1"] = async (order, { emit }) => {
      const packetValue = input(order, "obligation");
      const promptValue = formatTestScenarioPrompt(packetValue);
      const grammarValue = testScenarioGrammar(packetValue.scenarios.map((row) => row.id));
      const before = usageSnapshot(worker);
      emit("worker-button", { schema: 1, kind: "bantam.factory-worker-button", stationAttempt: order.stationAttempt, workerRef: modelIdentity(worker), prompt: promptValue, grammar: grammarValue, authority: order.authority });
      const completion = await worker.complete(promptValue, { grammar: grammarValue, nPredict: Math.min(nPredict, 1024), signal, recordLabel: "factory-test-scenario" });
      emit("worker-peck", { schema: 1, kind: "bantam.factory-worker-peck", stationAttempt: order.stationAttempt, workerRef: modelIdentity(worker), response: completion.content, tokens: integer(completion.tokens), stoppedEos: Boolean(completion.stoppedEos), stoppedLimit: Boolean(completion.stoppedLimit) });
      return { productRevision: order.inputProductRevision, outputs: { selection: { schema: 1, kind: "bantam.test-scenario-response", raw: String(completion.content ?? "") } }, performance: modelPerformance(worker, before) };
    };
    adapters["bantam.factory.test-scenario-inspection/v1"] = async (order) => ({ productRevision: order.inputProductRevision, outputs: { selection: input(order, "selection") } });
    gauges[gaugeRef(assets.obligation)] = async (order) => {
      const actual = output(order, "obligation");
      const pass = scenarioPacket !== null && canonicalJson(actual) === canonicalJson(scenarioPacket);
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "test-obligation-feeder-gauge", pass, edgeId: scenarioFixture.edgeId, packetDigest: sha256(canonicalJson(actual)) }] };
    };
    gauges[gaugeRef(assets.select)] = async (order) => {
      const validation = validateTestScenarioResponse(output(order, "selection").raw, scenarioFixture.scenarios);
      parsedScenario = validation.selection;
      return { status: validation.pass ? "pass" : "fail", evidence: [{ kind: "test-scenario-shape-gauge", ...validation }] };
    };
    gauges[gaugeRef(assets["scenario-inspection"])] = async (order) => {
      const validation = validateTestScenarioResponse(input(order, "selection").raw, scenarioFixture.scenarios);
      const actual = validation.selection?.scenarioId ?? null;
      const pass = validation.pass && actual === scenarioFixture.expected;
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "test-scenario-exact-gauge", pass, edgeId: scenarioFixture.edgeId, expectedDigest: sha256(scenarioFixture.expected), selected: actual }] };
    };
  }
  try {
    const line = await runFactoryBlueprint({
      compiled,
      root,
      jobId: id,
      task: contractText,
      initialProductRevision,
      adapters,
      gauges,
      workspaceLabel: `contract://${id}`,
      signal,
    });
    return deepFreeze({
      schema: 1,
      kind: includeTestScenario ? "bantam.factory-contract-test-case-result" : includeTestPlan ? "bantam.factory-contract-test-plan-result" : "bantam.factory-contract-edge-result",
      jobId: id,
      status: line.supervisor.status,
      stationRef: assets.enumerate.ref,
      routeRef: route.ref,
      selection: parsedSelection,
      ...(includeTestPlan ? { testPlan: parsedPlan, planStationRef: assets.plan.ref } : {}),
      ...(includeTestScenario ? { scenarioSelection: parsedScenario, scenarioStationRef: assets.select.ref, scenarioEdgeId: scenarioFixture.edgeId } : {}),
      expectedDigest: sha256(canonicalJson(expected)),
      line,
    });
  } finally {
    if (ownsModel) worker.close?.();
  }
}

export function certifyContractEdgeWorker({ workforce, workerRef } = {}) {
  if (!workforce || typeof workforce.project !== "function" || typeof workforce.qualify !== "function") throw new TypeError("contract edge certification requires a workforce registry");
  const ref = requiredText(workerRef, "contract edge worker ref", 500);
  const stationRef = contractEdgeCellLine().assets.enumerate.ref;
  const state = workforce.project();
  const qualification = state.qualifications.find((row) => (
    row.workerRef === ref
    && row.stationRef === stationRef
    && row.taskFamily === CONTRACT_EDGE_QUALIFICATION_POLICY.taskFamily
  ));
  if (!qualification) throw new Error("contract edge certification requires imported candidate evidence for the exact station and task family");
  if (qualification.status === "qualified") return deepFreeze({ policy: CONTRACT_EDGE_QUALIFICATION_POLICY, qualification, alreadyQualified: true });
  if (qualification.status !== "candidate") throw new Error(`contract edge certification requires candidate status, found ${qualification.status}`);
  const evidence = qualification.evidence;
  const failures = [];
  if (evidence.articles < CONTRACT_EDGE_QUALIFICATION_POLICY.minimumArticles) failures.push(`articles ${evidence.articles}/${CONTRACT_EDGE_QUALIFICATION_POLICY.minimumArticles}`);
  const yieldRate = evidence.articles ? evidence.passes / evidence.articles : 0;
  if (yieldRate < CONTRACT_EDGE_QUALIFICATION_POLICY.minimumYield) failures.push(`yield ${yieldRate.toFixed(3)}/${CONTRACT_EDGE_QUALIFICATION_POLICY.minimumYield.toFixed(3)}`);
  if (evidence.escapes > CONTRACT_EDGE_QUALIFICATION_POLICY.maximumEscapes) failures.push(`escapes ${evidence.escapes}/${CONTRACT_EDGE_QUALIFICATION_POLICY.maximumEscapes}`);
  if (evidence.falseStops > CONTRACT_EDGE_QUALIFICATION_POLICY.maximumFalseStops) failures.push(`false-stops ${evidence.falseStops}/${CONTRACT_EDGE_QUALIFICATION_POLICY.maximumFalseStops}`);
  if (!Number.isFinite(evidence.p95Ms) || evidence.p95Ms > CONTRACT_EDGE_QUALIFICATION_POLICY.maximumP95Ms) failures.push(`p95 ${evidence.p95Ms ?? "unknown"}/${CONTRACT_EDGE_QUALIFICATION_POLICY.maximumP95Ms}ms`);
  if (!Number.isFinite(evidence.meanTotalTokens) || evidence.meanTotalTokens > CONTRACT_EDGE_QUALIFICATION_POLICY.maximumMeanTotalTokens) failures.push(`mean-tokens ${evidence.meanTotalTokens ?? "unknown"}/${CONTRACT_EDGE_QUALIFICATION_POLICY.maximumMeanTotalTokens}`);
  if (evidence.sourceRefs.length < evidence.articles) failures.push(`source-refs ${evidence.sourceRefs.length}/${evidence.articles}`);
  if (failures.length) throw new Error(`contract edge certification policy failed: ${failures.join("; ")}`);
  const event = workforce.qualify({
    workerRef: ref,
    stationRef,
    taskFamily: CONTRACT_EDGE_QUALIFICATION_POLICY.taskFamily,
    status: "qualified",
    evidence,
    limits: { maxP95Ms: CONTRACT_EDGE_QUALIFICATION_POLICY.maximumP95Ms, maxExpectedCostUsd: null, authority: ["contract.read"] },
    reason: `certified by ${CONTRACT_EDGE_QUALIFICATION_POLICY.ref}`,
  });
  const certified = workforce.project().qualifications.find((row) => row.eventId === event.id);
  return deepFreeze({ policy: CONTRACT_EDGE_QUALIFICATION_POLICY, qualification: certified, alreadyQualified: false });
}

export function contractEdgeGrammar(ids) {
  const normalized = normalizeIdList(ids, "contract edge grammar identifier");
  if (!normalized.length) throw new Error("contract edge grammar requires identifiers");
  const choices = normalized.map((id) => JSON.stringify(JSON.stringify(id))).join(" | ");
  return String.raw`root ::= ws "{" ws "\"schema\"" ws ":" ws "1" ws "," ws "\"kind\"" ws ":" ws "\"${RESPONSE_KIND}\"" ws "," ws "\"edges\"" ws ":" ws edges ws "}" ws
edges ::= "[" ws (edge (ws "," ws edge)*)? ws "]"
edge ::= ${choices}
ws ::= [ \t\n]*
`;
}

export function validateContractEdgeResponse(raw, catalog) {
  const allowed = new Set(normalizeCatalog(catalog).map((row) => row.id));
  let value;
  try { value = JSON.parse(String(raw ?? "").trim()); }
  catch { return deepFreeze({ pass: false, code: "invalid-json", selection: null }); }
  if (!record(value)) return deepFreeze({ pass: false, code: "invalid-object", selection: null });
  const keys = Object.keys(value).sort();
  if (canonicalJson(keys) !== canonicalJson(["edges", "kind", "schema"])) return deepFreeze({ pass: false, code: "schema-expansion", selection: null });
  if (value.schema !== 1 || value.kind !== RESPONSE_KIND || !Array.isArray(value.edges)) return deepFreeze({ pass: false, code: "invalid-envelope", selection: null });
  if (value.edges.some((id) => typeof id !== "string" || !allowed.has(id))) return deepFreeze({ pass: false, code: "unknown-edge", selection: null });
  if (new Set(value.edges).size !== value.edges.length) return deepFreeze({ pass: false, code: "duplicate-edge", selection: null });
  const selection = deepFreeze({ schema: 1, kind: RESPONSE_KIND, edges: [...value.edges].sort() });
  return deepFreeze({ pass: true, code: "conforming", selection });
}

export function buildContractTestPlan({ contract, catalog, selection } = {}) {
  const contractText = requiredText(contract, "test plan contract text", 20_000);
  const normalizedCatalog = normalizeCatalog(catalog);
  const selectionValidation = validateContractEdgeResponse(JSON.stringify(selection), normalizedCatalog);
  if (!selectionValidation.pass) throw new Error(`test plan selection is invalid: ${selectionValidation.code}`);
  const descriptions = new Map(normalizedCatalog.map((row) => [row.id, row.description]));
  const edges = selectionValidation.selection.edges;
  return deepFreeze({
    schema: 1,
    kind: TEST_PLAN_KIND,
    contractDigest: sha256(contractText),
    selectionDigest: sha256(canonicalJson(edges)),
    obligations: edges.map((edgeId) => ({ edgeId, description: descriptions.get(edgeId) })),
  });
}

export function validateContractTestPlan(value, { contract, catalog, selection } = {}) {
  let expected;
  try { expected = buildContractTestPlan({ contract, catalog, selection }); }
  catch (error) { return deepFreeze({ pass: false, code: "invalid-source-material", plan: null, detail: error.message }); }
  if (!record(value)) return deepFreeze({ pass: false, code: "invalid-object", plan: null });
  if (Object.keys(value).sort().join(",") !== "contractDigest,kind,obligations,schema,selectionDigest") return deepFreeze({ pass: false, code: "schema-expansion", plan: null });
  if (value.schema !== 1 || value.kind !== TEST_PLAN_KIND || !Array.isArray(value.obligations)) return deepFreeze({ pass: false, code: "invalid-envelope", plan: null });
  if (value.contractDigest !== expected.contractDigest || value.selectionDigest !== expected.selectionDigest) return deepFreeze({ pass: false, code: "source-digest-mismatch", plan: null });
  const malformed = value.obligations.some((row) => !record(row) || Object.keys(row).sort().join(",") !== "description,edgeId" || typeof row.edgeId !== "string" || typeof row.description !== "string");
  if (malformed) return deepFreeze({ pass: false, code: "invalid-obligation", plan: null });
  const actualEdges = value.obligations.map((row) => row.edgeId);
  if (new Set(actualEdges).size !== actualEdges.length) return deepFreeze({ pass: false, code: "duplicate-obligation", plan: null });
  const expectedEdges = expected.obligations.map((row) => row.edgeId);
  const missing = expectedEdges.filter((edgeId) => !actualEdges.includes(edgeId));
  const extra = actualEdges.filter((edgeId) => !expectedEdges.includes(edgeId));
  if (missing.length || extra.length) return deepFreeze({ pass: false, code: "coverage-mismatch", plan: null, missing, extra });
  if (canonicalJson(value) !== canonicalJson(expected)) return deepFreeze({ pass: false, code: "noncanonical-obligation", plan: null, missing, extra });
  return deepFreeze({ pass: true, code: "conforming", plan: expected, missing: [], extra: [] });
}

function contractEdgePrompt(packet) {
  return `You operate one read-only BANTAMFACTORY station. Select every catalog edge case required by the contract. Select no inapplicable edge. Return only the constrained JSON object; do not explain.\n\nCONTRACT\n${packet.contract}\n\nPUBLIC EDGE CATALOG\n${packet.catalog.map((row) => `${row.id}: ${row.description}`).join("\n")}\n\nOUTPUT KEYS\nschema, kind, edges`;
}

function normalizeCatalog(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("contract edge catalog must contain from 1 to 64 entries");
  const seen = new Set();
  return deepFreeze(value.map((entry, index) => {
    if (!record(entry) || Object.keys(entry).sort().join(",") !== "description,id") throw new Error(`contract edge catalog entry ${index} must contain only id and description`);
    const id = requiredId(entry.id, `contract edge catalog entry ${index} id`);
    if (!EDGE_ID.test(id)) throw new Error(`invalid contract edge identifier: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate contract edge identifier: ${id}`);
    seen.add(id);
    return { id, description: requiredText(entry.description, `contract edge catalog entry ${id} description`, 500) };
  }));
}

function normalizeExpected(value, catalog) {
  const ids = normalizeIdList(value, "expected contract edge");
  const allowed = new Set(catalog.map((row) => row.id));
  for (const id of ids) if (!allowed.has(id)) throw new Error(`expected contract edge is absent from catalog: ${id}`);
  return deepFreeze([...ids].sort());
}

function normalizeIdList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}s must be an array`);
  const ids = value.map((entry) => requiredId(entry, label));
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${label}`);
  return ids;
}

function modelPerformance(model, before) {
  const after = usageSnapshot(model);
  const delta = before && after ? Object.fromEntries(["requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens", "cacheMissTokens", "reasoningTokens", "costUsd"].map((field) => [field, Math.max(0, Number(after[field] ?? 0) - Number(before[field] ?? 0))])) : null;
  return {
    workerRef: modelIdentity(model),
    turns: 1,
    modelRequests: integer(delta?.requests),
    inputTokens: integer(delta?.inputTokens),
    outputTokens: integer(delta?.outputTokens),
    totalTokens: integer(delta?.totalTokens),
    cacheHitTokens: integer(delta?.cacheHitTokens),
    cacheMissTokens: integer(delta?.cacheMissTokens),
    reasoningTokens: integer(delta?.reasoningTokens),
    estimatedCostUsd: delta ? Math.max(0, Number(delta.costUsd) || 0) : null,
  };
}

function modelIdentity(model) {
  if (typeof model?.metadata !== "function") return "local:injected-contract-edge-worker";
  const metadata = model.metadata();
  return [metadata.runtime ?? "model", metadata.model ?? metadata.profile ?? "unknown", metadata.reasoningEffort].filter(Boolean).join(":");
}

function usageSnapshot(model) { return typeof model?.usageSummary === "function" ? model.usageSummary() : null; }
function input(order, name) { const row = order.inputs.find((entry) => entry.port === name); if (!row) throw new Error(`contract edge work order is missing ${name}`); return row.value; }
function output(order, name) { const row = order.outputs.find((entry) => entry.port === name); if (!row) throw new Error(`contract edge inspection order is missing ${name}`); return row.value; }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredId(value, label) { const text = String(value ?? ""); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`invalid ${label}: ${text}`); return text; }
function requiredText(value, label, maximum) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`); return text; }
function integer(value) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
