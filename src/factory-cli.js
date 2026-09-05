import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "./cli-args.js";
import { ModelClient } from "./model.js";
import { FactoryStore } from "./factory/store.js";
import { auditFactoryTraveler, factoryFrameAt, projectFactorySupervisor } from "./factory/traveler.js";
import { formatFactoryFloor, formatFactoryLiveness, projectFactoryLiveness } from "./factory/supervisor.js";
import { collectFactoryReportEvidence, writeFactoryReport } from "./factory/html-report.js";
import { startFactoryFloorServer } from "./factory/floor-server.js";
import { startFactoryYardServer } from "./factory/yard-server.js";
import { formatFactoryDispatchBoard, projectFactoryDispatchBoard } from "./factory/dispatch-board.js";
import { formatFactoryShadowSchedule, projectFactoryShadowSchedule } from "./factory/shadow-schedule.js";
import {
  applyFactoryCodingCell,
  runFactoryCodingCell,
  runFactoryVerifier,
} from "./factory/coding-cell.js";
import { buildFactoryPerformanceReport, formatFactoryPerformance } from "./factory/performance.js";
import { runLifecycleFactoryCell } from "./factory/lifecycle-cell.js";
import { formatLifecycleCohort, loadLifecycleCohort, runLifecycleCohort } from "./factory/lifecycle-cohort.js";
import { formatStaffingRecommendation, formatWorkforce, WorkforceRegistry } from "./factory/workforce.js";
import { onboardLocalWorker } from "./factory/worker-onboarding.js";
import { certifyContractEdgeWorker, runContractEdgeFactoryCell, runContractTestPlanFactoryCell } from "./factory/contract-edge-cell.js";
import { certifyTestScenarioWorker, runTestScenarioFactoryCell } from "./factory/test-scenario-cell.js";
import { formatFactoryBlueprint, loadFactoryBlueprint, projectFactoryBlueprint, writeFactoryBlueprintReport } from "./factory/blueprint.js";
import { analyzeFactoryProcess, formatProcessChangeOrder } from "./factory/process-engineer.js";
import {
  buildClaimRunRecord,
  evaluateProofLadder,
  formatProofLedger,
  loadClaimRunRecord,
  loadProofLadder,
} from "./factory/claim-ledger.js";

const FACTORY_BOOLEAN_FLAGS = new Set(["help", "json", "yes", "once", "codex"]);

export async function runFactoryCommand(argv, {
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  model = undefined,
  runAgentFn = undefined,
  verifier = runFactoryVerifier,
  runLifecycleCohortFn = runLifecycleCohort,
  startFloorServerFn = startFactoryFloorServer,
  startYardServerFn = startFactoryYardServer,
  onboardLocalWorkerFn = onboardLocalWorker,
  runContractEdgeFactoryCellFn = runContractEdgeFactoryCell,
  runContractTestPlanFactoryCellFn = runContractTestPlanFactoryCell,
  runTestScenarioFactoryCellFn = runTestScenarioFactoryCell,
  signal = null,
} = {}) {
  let args;
  try { args = parseArgs(argv, FACTORY_BOOLEAN_FLAGS); }
  catch (error) {
    stderr.write(`factory: ${error.message}\n`);
    return 2;
  }
  const subcommand = String(args._[1] ?? "list").toLowerCase();
  if (args.help) {
    stdout.write(`${factoryUsage()}\n`);
    return 0;
  }
  const unknown = Object.keys(args).find((key) => !new Set([
    "_", "help", "json", "yes", "once", "codex", "factory-home", "at", "timeline", "output",
    "workspace", "verify", "focused-verify", "max-turns", "verify-timeout", "job-id",
    "interval", "idle-after", "port",
    "cell", "public-verify", "editable", "diagnosis-turns", "mutation-turns", "rework-cycles",
    "model", "effort", "endpoint", "profile", "id", "order", "timeout",
    "station-ref", "task-family", "status", "evidence", "limits", "reason",
    "condition", "code", "ttl", "slots", "quota", "capabilities", "max-p95", "max-cost",
    "source-home", "catalog", "expected", "n-predict", "edge-id",
    "ladder", "require",
  ]).has(key));
  if (unknown) {
    stderr.write(`factory: unknown option --${unknown}\n`);
    return 2;
  }
  if (args["factory-home"] === true) {
    stderr.write("factory: --factory-home requires a directory\n");
    return 2;
  }
  const root = resolveFactoryHome({ cwd, env, explicit: args["factory-home"] });
  const store = new FactoryStore(root);

  if (subcommand === "engineer") {
    // Observe-only: proposes merges, never applies one.
    const jobId = args._[2];
    if (!jobId) { stderr.write("factory: engineer requires a job id\n"); return 2; }
    let events;
    try { events = store.load(String(jobId)); }
    catch (error) { stderr.write(`factory engineer: ${error.message}\n`); return 1; }
    const order = analyzeFactoryProcess(events, { articleCount: 1 });
    stdout.write(args.json ? `${JSON.stringify(order, null, 2)}\n` : `${formatProcessChangeOrder(order)}\n`);
    return 0;
  }

  if (subcommand === "claims") {
    // The ledger reads repository-relative evidence, so it is anchored to the
    // working tree rather than to the factory home.
    const ladderFile = typeof args.ladder === "string"
      ? path.resolve(cwd, args.ladder)
      : path.resolve(cwd, "src/factory/claims/proof-ladder.json");
    const recordFile = path.resolve(cwd, ".bantam/factory-claims/run-record.json");
    let ladder;
    try { ladder = loadProofLadder(ladderFile); }
    catch (error) { stderr.write(`factory claims: ${error.message}\n`); return 2; }
    if (args.verify === true) {
      let record;
      try { record = buildClaimRunRecord({ ladder, root: cwd }); }
      catch (error) { stderr.write(`factory claims: cannot run declared suites: ${error.message}\n`); return 1; }
      fs.mkdirSync(path.dirname(recordFile), { recursive: true });
      fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
      stdout.write(`factory claims: recorded ${record.suites.length} suite runs to ${path.relative(cwd, recordFile)}\n`);
    }
    let record = null;
    try { record = loadClaimRunRecord(recordFile); }
    catch (error) { stderr.write(`factory claims: ${error.message}\n`); return 1; }
    const ledger = evaluateProofLadder({ ladder, root: cwd, runRecord: record });
    stdout.write(args.json ? `${JSON.stringify(ledger, null, 2)}\n` : `${formatProofLedger(ledger)}\n`);
    if (typeof args.require === "string") {
      const wanted = args.require.toUpperCase();
      if (!ladder.rungs.some((rung) => rung.id === wanted)) {
        stderr.write(`factory claims: --require names an unknown rung: ${wanted}\n`);
        return 2;
      }
      const earned = ledger.highestEarned;
      const satisfied = earned !== null && earned >= wanted;
      if (!satisfied) {
        stderr.write(`factory claims: required ${wanted}, highest earned is ${earned ?? "none"}\n`);
        return 1;
      }
    }
    return 0;
  }

  if (subcommand === "blueprint") {
    const action = String(args._[2] ?? "show").toLowerCase();
    const file = args._[3];
    if (!file || args._.length !== 4 || !new Set(["show", "report"]).has(action)) {
      stderr.write("factory: blueprint requires show|report and exactly one JSON file\n");
      return 2;
    }
    try {
      const compiled = loadFactoryBlueprint(path.resolve(cwd, file));
      const events = typeof args["job-id"] === "string" ? store.load(args["job-id"]) : null;
      const projection = projectFactoryBlueprint(compiled, { events });
      if (action === "show") {
        stdout.write(args.json ? `${JSON.stringify(projection, null, 2)}\n` : `${formatFactoryBlueprint(projection)}\n`);
      } else {
        if (typeof args.output !== "string") throw new Error("blueprint report requires --output FILE");
        const output = writeFactoryBlueprintReport(path.resolve(cwd, args.output), projection);
        stdout.write(args.json ? `${JSON.stringify({ schema: 1, kind: "bantam.factory-blueprint-report", blueprintRef: projection.blueprintRef, routeRef: projection.routeRef, jobId: projection.jobId, output }, null, 2)}\n` : `factory blueprint report ${output}\n`);
      }
      return 0;
    } catch (error) {
      stderr.write(`factory blueprint failed: ${error.message}\n`);
      return 1;
    }
  }

  if (subcommand === "workers") {
    const action = String(args._[2] ?? "list").toLowerCase();
    const workforce = new WorkforceRegistry(root);
    try {
      if (action === "list") {
        if (args._.length !== 3 && args._.length !== 2) throw new Error("workers list does not accept a target");
        const state = workforce.project();
        stdout.write(args.json ? `${JSON.stringify(state, null, 2)}\n` : `${formatWorkforce(state)}\n`);
        return 0;
      }
      if (action === "eligible") {
        if (args._.length !== 3) throw new Error("workers eligible does not accept a target");
        if (typeof args["station-ref"] !== "string" || typeof args["task-family"] !== "string") throw new Error("workers eligible requires --station-ref and --task-family");
        const report = workforce.eligible({
          stationRef: args["station-ref"],
          taskFamily: args["task-family"],
          requiredCapabilities: commaList(args.capabilities),
          maxP95Ms: optionalNonNegative(args["max-p95"], "--max-p95"),
          maxExpectedCostUsd: optionalNonNegative(args["max-cost"], "--max-cost"),
        });
        stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatStaffingRecommendation(report)}\n`);
        return report.selected ? 0 : 1;
      }
      if (!args.yes) throw new Error(`workers ${action} changes the workforce ledger; repeat with --yes`);
      if (action === "onboard") {
        if (args._.length !== 3) throw new Error("workers onboard does not accept a target");
        if (typeof args.endpoint !== "string") throw new Error("workers onboard requires --endpoint");
        const ttl = positiveIntegerOption(args.ttl, 60_000, "--ttl");
        const slots = nonNegativeIntegerOption(args.slots, null, "--slots");
        if (ttl.error || slots.error) throw new Error(ttl.error ?? slots.error);
        if (slots.value === 0) throw new Error("workers onboard --slots must be positive");
        const result = await onboardLocalWorkerFn({
          root,
          endpoint: args.endpoint,
          profile: typeof args.profile === "string" ? args.profile : "qwen",
          slots: slots.value,
          ttlMs: ttl.value,
        });
        stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `onboarded ${result.worker.ref}\ncontext ${result.contextTokens}  slots ${result.declaredSlots}/${result.observedSlots}  grammar pass\nqualification not granted\n`);
        return 0;
      }
      if (action === "ingest") {
        const jobId = args._[3];
        if (!jobId || args._.length !== 4) throw new Error("workers ingest requires exactly one factory job id");
        if (typeof args["task-family"] !== "string") throw new Error("workers ingest requires --task-family");
        const sourceRoot = typeof args["source-home"] === "string" ? path.resolve(cwd, args["source-home"]) : root;
        const imported = workforce.ingestFactoryPerformance({ events: new FactoryStore(sourceRoot).load(jobId), taskFamily: args["task-family"] });
        stdout.write(args.json ? `${JSON.stringify(imported, null, 2)}\n` : `imported ${imported.length} station qualification specimen(s)\n`);
        return 0;
      }
      if (action === "certify-contract-edge") {
        const workerRef = args._[3];
        if (!workerRef || args._.length !== 4) throw new Error("workers certify-contract-edge requires exactly one worker ref");
        const result = certifyContractEdgeWorker({ workforce, workerRef });
        stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.alreadyQualified ? "already certified" : "certified"} ${workerRef}\npolicy ${result.policy.ref}\nstation ${result.qualification.stationRef}\n`);
        return 0;
      }
      if (action === "certify-test-scenario") {
        const workerRef = args._[3];
        if (!workerRef || args._.length !== 4) throw new Error("workers certify-test-scenario requires exactly one worker ref");
        const result = certifyTestScenarioWorker({ workforce, workerRef });
        stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.alreadyQualified ? "already certified" : "certified"} ${workerRef}\npolicy ${result.policy.ref}\nstation ${result.qualification.stationRef}\n`);
        return 0;
      }
      if (action === "install") {
        const file = args._[3];
        if (!file || args._.length !== 4) throw new Error("workers install requires exactly one profile JSON file");
        const profile = workforce.install(readJsonFile(path.resolve(cwd, file), "worker profile"));
        stdout.write(args.json ? `${JSON.stringify(profile, null, 2)}\n` : `installed ${profile.ref}\n`);
        return 0;
      }
      if (action === "qualify") {
        const workerRef = args._[3];
        if (!workerRef || args._.length !== 4) throw new Error("workers qualify requires exactly one worker ref");
        if (typeof args["station-ref"] !== "string" || typeof args["task-family"] !== "string") throw new Error("workers qualify requires --station-ref and --task-family");
        const event = workforce.qualify({
          workerRef,
          stationRef: args["station-ref"],
          taskFamily: args["task-family"],
          status: typeof args.status === "string" ? args.status : "candidate",
          evidence: typeof args.evidence === "string" ? readJsonFile(path.resolve(cwd, args.evidence), "qualification evidence") : null,
          limits: typeof args.limits === "string" ? readJsonFile(path.resolve(cwd, args.limits), "qualification limits") : null,
          reason: typeof args.reason === "string" ? args.reason : "operator qualification",
        });
        stdout.write(args.json ? `${JSON.stringify(event, null, 2)}\n` : `qualification recorded ${event.id}\n`);
        return 0;
      }
      if (action === "health") {
        const workerRef = args._[3];
        if (!workerRef || args._.length !== 4) throw new Error("workers health requires exactly one worker ref");
        if (typeof args.condition !== "string" || typeof args.code !== "string") throw new Error("workers health requires --condition and --code");
        const ttl = positiveIntegerOption(args.ttl, 60_000, "--ttl");
        const slots = nonNegativeIntegerOption(args.slots, null, "--slots");
        if (ttl.error || slots.error) throw new Error(ttl.error ?? slots.error);
        const event = workforce.observeHealth({
          workerRef,
          condition: args.condition,
          code: args.code,
          ttlMs: ttl.value,
          slotsAvailable: slots.value,
          quotaRemaining: optionalNonNegative(args.quota, "--quota"),
          detail: typeof args.reason === "string" ? args.reason : null,
        });
        stdout.write(args.json ? `${JSON.stringify(event, null, 2)}\n` : `health recorded ${event.id}\n`);
        return 0;
      }
      throw new Error("workers action must be list, onboard, install, qualify, health, ingest, or eligible");
    } catch (error) {
      stderr.write(`factory workers: ${error.message}\n`);
      return 2;
    }
  }

  if (subcommand === "cohort") {
    const action = String(args._[2] ?? "show").toLowerCase();
    if (action === "show") {
      const cohortId = args._[3];
      if (!cohortId || args._.length !== 4) {
        stderr.write("factory: cohort show requires exactly one cohort id\n");
        return 2;
      }
      try {
        const manifest = loadLifecycleCohort(path.join(root, "cohorts", cohortId));
        stdout.write(args.json ? `${JSON.stringify(manifest, null, 2)}\n` : `${formatLifecycleCohort(manifest)}\n`);
        return 0;
      } catch (error) {
        stderr.write(`factory cohort show failed: ${error.message}\n`);
        return 1;
      }
    }
    if (action !== "run") {
      stderr.write("factory: cohort action must be run or show\n");
      return 2;
    }
    if (!args.yes) {
      stderr.write("factory: cohort run launches three model arms; repeat with --yes\n");
      return 2;
    }
    const fixture = args._[3];
    if (!fixture || args._.length !== 4) {
      stderr.write("factory: cohort run requires exactly one fixture directory\n");
      return 2;
    }
    const diagnosisTurns = positiveIntegerOption(args["diagnosis-turns"], 8, "--diagnosis-turns");
    const mutationTurns = positiveIntegerOption(args["mutation-turns"], 30, "--mutation-turns");
    const reworkCycles = nonNegativeIntegerOption(args["rework-cycles"], 1, "--rework-cycles");
    const timeout = positiveIntegerOption(args.timeout, 900_000, "--timeout");
    const verificationTimeout = positiveIntegerOption(args["verify-timeout"], 120_000, "--verify-timeout");
    const optionError = diagnosisTurns.error ?? mutationTurns.error ?? reworkCycles.error ?? timeout.error ?? verificationTimeout.error;
    if (optionError) {
      stderr.write(`factory: ${optionError}\n`);
      return 2;
    }
    try {
      const result = await runLifecycleCohortFn({
        fixtureDir: path.resolve(cwd, fixture),
        root,
        id: typeof args.id === "string" ? args.id : null,
        model: typeof args.model === "string" ? args.model : "terra",
        effort: typeof args.effort === "string" ? args.effort : "medium",
        order: typeof args.order === "string" ? args.order : undefined,
        diagnosisMaxTurns: diagnosisTurns.value,
        mutationMaxTurns: mutationTurns.value,
        maxReworkCycles: reworkCycles.value,
        timeoutMs: timeout.value,
        verificationTimeoutMs: verificationTimeout.value,
        signal,
      });
      stdout.write(args.json ? `${JSON.stringify(result.manifest, null, 2)}\n` : `${formatLifecycleCohort(result.manifest)}\n\nmanifest ${result.manifestPath}\n`);
      return result.manifest.comparability.valid ? 0 : 1;
    } catch (error) {
      stderr.write(`factory cohort run failed: ${error.message}\n`);
      return 1;
    }
  }

  if (subcommand === "stats") {
    if (args._.length !== 2) {
      stderr.write("factory: stats does not accept a job id\n");
      return 2;
    }
    const jobs = [];
    const errors = [];
    for (const jobId of store.list()) {
      try { jobs.push({ jobId, events: store.load(jobId) }); }
      catch (error) { errors.push({ jobId, error: error.message }); }
    }
    const report = buildFactoryPerformanceReport(jobs);
    if (args.json) stdout.write(`${JSON.stringify({ ...report, root, errors }, null, 2)}\n`);
    else {
      stdout.write(`${formatFactoryPerformance(report)}\n`);
      for (const error of errors) stderr.write(`factory stats: skipped ${error.jobId}: ${error.error}\n`);
    }
    return errors.length ? 1 : 0;
  }

  if (subcommand === "contract-edges" || subcommand === "contract-plan") {
    const planMode = subcommand === "contract-plan";
    if (args._.length !== 3) {
      stderr.write(`factory: ${subcommand} requires exactly one quoted contract\n`);
      return 2;
    }
    if (typeof args.catalog !== "string" || typeof args.expected !== "string") {
      stderr.write(`factory: ${subcommand} requires --catalog FILE and --expected ID[,ID...]\n`);
      return 2;
    }
    const nPredict = positiveIntegerOption(args["n-predict"], 512, "--n-predict");
    if (nPredict.error) {
      stderr.write(`factory: ${nPredict.error}\n`);
      return 2;
    }
    let selectedModel = model;
    let ownedModel = null;
    try {
      if (selectedModel === undefined) {
        ownedModel = new ModelClient(args.codex ? {
          codex: true,
          model: normalizeCodexModel(args.model),
          codexEffort: normalizeEffort(args.effort),
        } : {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          ...(typeof args.endpoint === "string" ? { apiUrl: null, apiDialect: "llamacpp" } : {}),
          profile: typeof args.profile === "string" ? args.profile : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        selectedModel = ownedModel;
      }
      const result = await (planMode ? runContractTestPlanFactoryCellFn : runContractEdgeFactoryCellFn)({
        root,
        jobId: typeof args["job-id"] === "string" ? args["job-id"] : null,
        contract: args._[2],
        catalog: readJsonFile(path.resolve(cwd, args.catalog), "contract edge catalog"),
        expectedEdges: commaList(args.expected),
        model: selectedModel,
        nPredict: nPredict.value,
        signal,
      });
      const response = {
        schema: 1,
        kind: planMode ? "bantam.factory-contract-test-plan-command-result" : "bantam.factory-contract-edge-command-result",
        jobId: result.jobId,
        status: result.status,
        stationRef: result.stationRef,
        routeRef: result.routeRef,
        selection: result.selection,
        ...(planMode ? { testPlan: result.testPlan, planStationRef: result.planStationRef } : {}),
        expectedDigest: result.expectedDigest,
        travelerEvents: result.line.events.length,
      };
      stdout.write(args.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `factory ${planMode ? "contract-plan" : "contract-edge"} article ${response.jobId}\nstatus ${response.status}\nselected ${(response.selection?.edges ?? []).join(", ") || "(none)"}${planMode ? `\nobligations ${response.testPlan?.obligations?.length ?? 0}` : ""}\nworker evidence: bantam factory workers ingest ${response.jobId} --task-family contract-edge-enumeration --yes\n`);
      return response.status === "released" ? 0 : 1;
    } catch (error) {
      stderr.write(`factory ${subcommand} failed: ${error.message}\n`);
      return 1;
    } finally {
      ownedModel?.close?.();
    }
  }

  if (subcommand === "test-scenario") {
    if (args._.length !== 3) {
      stderr.write("factory: test-scenario requires exactly one quoted obligation\n");
      return 2;
    }
    if (typeof args["edge-id"] !== "string" || typeof args.catalog !== "string" || typeof args.expected !== "string" || args.expected.includes(",")) {
      stderr.write("factory: test-scenario requires --edge-id ID, --catalog FILE, and one --expected ID\n");
      return 2;
    }
    const nPredict = positiveIntegerOption(args["n-predict"], 256, "--n-predict");
    if (nPredict.error) { stderr.write(`factory: ${nPredict.error}\n`); return 2; }
    let selectedModel = model;
    let ownedModel = null;
    try {
      if (selectedModel === undefined) {
        ownedModel = new ModelClient(args.codex ? {
          codex: true,
          model: normalizeCodexModel(args.model),
          codexEffort: normalizeEffort(args.effort),
        } : {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          ...(typeof args.endpoint === "string" ? { apiUrl: null, apiDialect: "llamacpp" } : {}),
          profile: typeof args.profile === "string" ? args.profile : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        selectedModel = ownedModel;
      }
      const result = await runTestScenarioFactoryCellFn({
        root,
        jobId: typeof args["job-id"] === "string" ? args["job-id"] : null,
        edgeId: args["edge-id"],
        obligation: args._[2],
        scenarios: readJsonFile(path.resolve(cwd, args.catalog), "test scenario catalog"),
        expectedScenario: args.expected,
        model: selectedModel,
        nPredict: nPredict.value,
        signal,
      });
      const response = { schema: 1, kind: "bantam.factory-test-scenario-command-result", jobId: result.jobId, status: result.status, stationRef: result.stationRef, routeRef: result.routeRef, edgeId: result.edgeId, selection: result.selection, expectedDigest: result.expectedDigest, travelerEvents: result.line.events.length };
      stdout.write(args.json ? `${JSON.stringify(response, null, 2)}\n` : `factory test-scenario article ${response.jobId}\nstatus ${response.status}\nscenario ${response.selection?.scenarioId ?? "(none)"}\nworker evidence: bantam factory workers ingest ${response.jobId} --task-family test-scenario-selection --yes\n`);
      return response.status === "released" ? 0 : 1;
    } catch (error) {
      stderr.write(`factory test-scenario failed: ${error.message}\n`);
      return 1;
    } finally {
      ownedModel?.close?.();
    }
  }

  if (subcommand === "build") {
    if (args._.length !== 3) {
      stderr.write("factory: build requires exactly one quoted task\n");
      return 2;
    }
    if (typeof args.verify !== "string" || !args.verify.trim()) {
      stderr.write("factory: build requires --verify COMMAND\n");
      return 2;
    }
    const maxTurns = positiveIntegerOption(args["max-turns"], 30, "--max-turns");
    const verificationTimeoutMs = positiveIntegerOption(args["verify-timeout"], 120_000, "--verify-timeout");
    const diagnosisTurns = positiveIntegerOption(args["diagnosis-turns"], 12, "--diagnosis-turns");
    const mutationTurns = positiveIntegerOption(args["mutation-turns"], maxTurns.value, "--mutation-turns");
    const reworkCycles = nonNegativeIntegerOption(args["rework-cycles"], 1, "--rework-cycles");
    if (maxTurns.error || verificationTimeoutMs.error || diagnosisTurns.error || mutationTurns.error || reworkCycles.error) {
      stderr.write(`factory: ${maxTurns.error ?? verificationTimeoutMs.error ?? diagnosisTurns.error ?? mutationTurns.error ?? reworkCycles.error}\n`);
      return 2;
    }
    try {
      const selectedCell = typeof args.cell === "string" ? args.cell.toLowerCase() : "general";
      if (!new Set(["general", "keyed-lifecycle"]).has(selectedCell)) {
        stderr.write("factory: --cell must be general or keyed-lifecycle\n");
        return 2;
      }
      if (selectedCell === "keyed-lifecycle" && (typeof args["public-verify"] !== "string" || !args["public-verify"].trim())) {
        stderr.write("factory: keyed-lifecycle cell requires --public-verify COMMAND\n");
        return 2;
      }
      let selectedModel = model;
      let ownedModel = null;
      if (selectedModel === undefined && (args.codex || typeof args.endpoint === "string" || typeof args.profile === "string" || typeof args.model === "string")) {
        ownedModel = new ModelClient(args.codex ? {
          codex: true,
          model: normalizeCodexModel(args.model),
          codexEffort: normalizeEffort(args.effort),
        } : {
          endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
          ...(typeof args.endpoint === "string" ? { apiUrl: null, apiDialect: "llamacpp" } : {}),
          profile: typeof args.profile === "string" ? args.profile : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        selectedModel = ownedModel;
      }
      const common = {
        workspace: path.resolve(cwd, typeof args.workspace === "string" ? args.workspace : "."),
        task: args._[2],
        verificationScript: args.verify,
        root,
        jobId: typeof args["job-id"] === "string" ? args["job-id"] : null,
        model: selectedModel,
        verificationTimeoutMs: verificationTimeoutMs.value,
        ...(runAgentFn === undefined ? {} : { runAgentFn }),
        verifier,
      };
      let built;
      try {
        built = selectedCell === "keyed-lifecycle"
          ? await runLifecycleFactoryCell({
            ...common,
            focusedVerificationScript: typeof args["focused-verify"] === "string" ? args["focused-verify"] : null,
            publicVerificationScript: args["public-verify"],
            editablePaths: typeof args.editable === "string" ? args.editable.split(",").map((value) => value.trim()).filter(Boolean) : undefined,
            diagnosisMaxTurns: diagnosisTurns.value,
            mutationMaxTurns: mutationTurns.value,
            maxReworkCycles: reworkCycles.value,
            workforce: new WorkforceRegistry(root),
          })
          : await runFactoryCodingCell({
            ...common,
            focusedVerificationScript: typeof args["focused-verify"] === "string" ? args["focused-verify"] : null,
            maxTurns: maxTurns.value,
          });
      } finally {
        ownedModel?.close?.();
      }
      const response = {
        schema: 1,
        kind: "bantam.factory-build-result",
        jobId: built.manifest.id,
        status: built.manifest.status,
        cell: built.manifest.cell ?? "general",
        baseline: built.manifest.baseline.tree,
        candidate: built.manifest.candidate.tree,
        manifest: built.manifestPath,
        travelerEvents: built.line.events.length,
      };
      if (args.json) stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      else {
        stdout.write(`factory job: ${response.jobId}\nstatus: ${response.status}\nbaseline: ${response.baseline}\ncandidate: ${response.candidate}\nmanifest: ${response.manifest}\n`);
        if (response.status === "released") stdout.write(`apply: bantam factory apply ${response.jobId} --yes\n`);
      }
      return response.status === "released" ? 0 : 1;
    } catch (error) {
      stderr.write(`factory build failed: ${error.message}\n`);
      return 1;
    }
  }

  if (subcommand === "apply") {
    if (!args.yes) {
      stderr.write("factory: apply changes the source workspace; repeat with --yes\n");
      return 2;
    }
    const jobId = args._[2];
    if (!jobId || args._.length !== 3) {
      stderr.write("factory: apply requires exactly one job id\n");
      return 2;
    }
    const verificationTimeoutMs = args["verify-timeout"] === undefined
      ? null
      : positiveIntegerOption(args["verify-timeout"], null, "--verify-timeout");
    if (verificationTimeoutMs?.error) {
      stderr.write(`factory: ${verificationTimeoutMs.error}\n`);
      return 2;
    }
    try {
      const applied = await applyFactoryCodingCell({
        manifestPath: path.join(root, "jobs", jobId, "manifest.json"),
        workspace: typeof args.workspace === "string" ? path.resolve(cwd, args.workspace) : null,
        verificationTimeoutMs: verificationTimeoutMs?.value ?? null,
        verifier,
      });
      const response = { schema: 1, kind: "bantam.factory-apply-result", jobId, status: "applied", workspace: applied.workspace, transaction: applied.transaction.id };
      stdout.write(args.json ? `${JSON.stringify(response, null, 2)}\n` : `factory job ${jobId}: APPLIED\nworkspace: ${applied.workspace}\ntransaction: ${applied.transaction.id}\n`);
      return 0;
    } catch (error) {
      stderr.write(`factory apply failed: ${error.message}\n`);
      return 1;
    }
  }

  if (subcommand === "watch") {
    const jobId = args._[2];
    if (!jobId || args._.length !== 3) {
      stderr.write("factory: watch requires exactly one job id\n");
      return 2;
    }
    const interval = positiveIntegerOption(args.interval, 1_000, "--interval");
    const idleAfter = positiveIntegerOption(args["idle-after"], 30_000, "--idle-after");
    if (interval.error || idleAfter.error) {
      stderr.write(`factory: ${interval.error ?? idleAfter.error}\n`);
      return 2;
    }
    let prior = null;
    while (!signal?.aborted) {
      let events;
      try { events = store.load(jobId); }
      catch (error) {
        stderr.write(`factory: cannot watch ${jobId}: ${error.message}\n`);
        return 1;
      }
      const live = projectFactoryLiveness(events, { idleAfterMs: idleAfter.value });
      const signature = `${live.sequence}:${live.condition}:${live.idleMs >= live.idleAfterMs}`;
      if (signature !== prior) {
        stdout.write(args.json ? `${JSON.stringify(live)}\n` : `${formatFactoryLiveness(live)}\n`);
        prior = signature;
      }
      if (args.once || live.terminal) return live.condition === "released" ? 0 : (live.terminal ? 1 : 0);
      await wait(interval.value, signal);
    }
    return 130;
  }

  if (subcommand === "list") {
    if (args._.length !== 2) {
      stderr.write("factory: list does not accept a job id\n");
      return 2;
    }
    const rows = store.list().map((jobId) => {
      try {
        const events = store.load(jobId);
        const supervisor = projectFactorySupervisor(events);
        return { jobId, status: supervisor.status, events: events.length, chassis: supervisor.chassis.active };
      } catch (error) {
        return { jobId, status: "corrupt", events: null, chassis: null, error: error.message };
      }
    });
    if (args.json) stdout.write(`${JSON.stringify({ schema: 1, kind: "bantam.factory-list", root, jobs: rows }, null, 2)}\n`);
    else {
      stdout.write(`BANTAM FACTORY JOBS\nroot  ${root}\n`);
      if (!rows.length) stdout.write("(no travelers)\n");
      for (const row of rows) stdout.write(`${row.jobId}  ${row.status}  ${row.events ?? "—"} events  ${row.chassis ?? row.error}\n`);
    }
    return rows.some((row) => row.status === "corrupt") ? 1 : 0;
  }

  if (subcommand === "dispatch") {
    if (args._.length !== 2) {
      stderr.write("factory: dispatch does not accept a job id\n");
      return 2;
    }
    const board = projectFactoryDispatchBoard({ root });
    stdout.write(args.json ? `${JSON.stringify(board, null, 2)}\n` : `${formatFactoryDispatchBoard(board)}\n`);
    return board.summary.unstaffedReady > 0 || board.workforceError ? 1 : 0;
  }

  if (subcommand === "schedule") {
    if (args._.length !== 2) {
      stderr.write("factory: schedule does not accept a job id\n");
      return 2;
    }
    const schedule = projectFactoryShadowSchedule({ root });
    stdout.write(args.json ? `${JSON.stringify(schedule, null, 2)}\n` : `${formatFactoryShadowSchedule(schedule)}\n`);
    return schedule.summary.deferred > 0 ? 1 : 0;
  }

  if (subcommand === "floor") {
    const jobId = args._[2];
    if (!jobId || args._.length !== 3) {
      stderr.write("factory: floor requires exactly one job id\n");
      return 2;
    }
    const port = nonNegativeIntegerOption(args.port, 4_317, "--port");
    const interval = positiveIntegerOption(args.interval, 1_000, "--interval");
    const rangeError = port.value > 65_535
      ? "--port must be from 0 to 65535"
      : (interval.value < 100 || interval.value > 60_000 ? "--interval must be from 100 to 60000ms" : null);
    if (port.error || interval.error || rangeError) {
      stderr.write(`factory: ${port.error ?? interval.error ?? rangeError}\n`);
      return 2;
    }
    try {
      const floor = await startFloorServerFn({ root, jobId, port: port.value, pollIntervalMs: interval.value, signal });
      const ready = { schema: 1, kind: "bantam.factory-floor-server", jobId, url: floor.url, root };
      stdout.write(args.json ? `${JSON.stringify(ready)}\n` : `BANTAMFACTORY chicken floor\n${floor.url}\njob ${jobId}\nCtrl-C stops the local viewer.\n`);
      await floor.closed;
      return signal?.aborted ? 130 : 0;
    } catch (error) {
      stderr.write(`factory: cannot start floor for ${jobId}: ${error.message}\n`);
      return 1;
    }
  }

  if (subcommand === "yard") {
    if (args._.length !== 2) {
      stderr.write("factory: yard does not accept a job id\n");
      return 2;
    }
    const port = nonNegativeIntegerOption(args.port, 4_318, "--port");
    const interval = positiveIntegerOption(args.interval, 1_000, "--interval");
    const idleAfter = positiveIntegerOption(args["idle-after"], 30_000, "--idle-after");
    const rangeError = port.value > 65_535
      ? "--port must be from 0 to 65535"
      : (interval.value < 100 || interval.value > 60_000
          ? "--interval must be from 100 to 60000ms"
          : (idleAfter.value > 86_400_000 ? "--idle-after must be at most 86400000ms" : null));
    if (port.error || interval.error || idleAfter.error || rangeError) {
      stderr.write(`factory: ${port.error ?? interval.error ?? idleAfter.error ?? rangeError}\n`);
      return 2;
    }
    try {
      const yard = await startYardServerFn({ root, port: port.value, pollIntervalMs: interval.value, idleAfterMs: idleAfter.value, signal });
      const ready = { schema: 1, kind: "bantam.factory-yard-server", url: yard.url, root };
      stdout.write(args.json ? `${JSON.stringify(ready)}\n` : `BANTAMFACTORY control tower\n${yard.url}\nCtrl-C closes the local factory yard.\n`);
      await yard.closed;
      return signal?.aborted ? 130 : 0;
    } catch (error) {
      stderr.write(`factory: cannot start yard: ${error.message}\n`);
      return 1;
    }
  }

  if (!new Set(["show", "audit", "report"]).has(subcommand)) {
    stderr.write(`factory: unknown command ${subcommand}\n${factoryUsage()}\n`);
    return 2;
  }
  const jobId = args._[2];
  if (!jobId || args._.length !== 3) {
    stderr.write(`factory: ${subcommand} requires exactly one job id\n`);
    return 2;
  }
  let events;
  try { events = store.load(jobId); }
  catch (error) {
    stderr.write(`factory: cannot load ${jobId}: ${error.message}\n`);
    return 1;
  }
  const at = args.at === undefined ? events.length : Number(args.at);
  if (!Number.isInteger(at) || at < 1 || at > events.length) {
    stderr.write(`factory: --at must be an event sequence from 1 to ${events.length}\n`);
    return 2;
  }
  if (subcommand === "report") {
    if (args.output === true) {
      stderr.write("factory: --output requires a file path\n");
      return 2;
    }
    const destination = path.resolve(cwd, typeof args.output === "string"
      ? args.output
      : path.join(".bantam", "factory-reports", `${jobId}.html`));
    try {
      const evidence = collectFactoryReportEvidence(store, events);
      let workforce = null;
      try { workforce = new WorkforceRegistry(root).project(); } catch { /* a corrupt workforce lane must not hide a valid job report */ }
      writeFactoryReport(destination, events, { sequence: at, evidence, workforce });
    }
    catch (error) {
      stderr.write(`factory: cannot write report: ${error.message}\n`);
      return 1;
    }
    if (args.json) stdout.write(`${JSON.stringify({ schema: 1, kind: "bantam.factory-report", jobId, sequence: at, output: destination }, null, 2)}\n`);
    else stdout.write(`factory report: ${destination}\n`);
    return 0;
  }
  if (subcommand === "audit") {
    try {
      const audit = auditFactoryTraveler(events);
      stdout.write(args.json ? `${JSON.stringify(audit, null, 2)}\n` : `factory traveler ${jobId}: OK (${audit.eventCount} events, terminal=${audit.terminal})\n`);
      return 0;
    } catch (error) {
      stderr.write(`factory traveler ${jobId}: INVALID: ${error.message}\n`);
      return 1;
    }
  }
  const timelineLimit = args.timeline === undefined ? 12 : Number(args.timeline);
  if (!Number.isInteger(timelineLimit) || timelineLimit < 1) {
    stderr.write("factory: --timeline must be a positive integer\n");
    return 2;
  }
  if (args.json) {
    stdout.write(`${JSON.stringify({
      schema: 1,
      kind: "bantam.factory-floor",
      root,
      audit: auditFactoryTraveler(events),
      frame: factoryFrameAt(events, at),
      supervisor: projectFactorySupervisor(events, at),
    }, null, 2)}\n`);
  } else {
    stdout.write(`${formatFactoryFloor(events, { sequence: at, timelineLimit })}\n`);
  }
  return 0;
}

export function resolveFactoryHome({ cwd = process.cwd(), env = process.env, explicit } = {}) {
  const configured = typeof explicit === "string" && explicit
    ? explicit
    : (env.BANTAM_FACTORY_HOME || path.join(cwd, ".bantam", "factory"));
  return path.resolve(cwd, configured);
}

export function factoryUsage() {
  return `bantam factory engineer <job-id> [--json]
bantam factory claims [--verify] [--require C0..C6] [--ladder FILE] [--json]
bantam factory build "<task>" --verify "<command>" [--cell general|keyed-lifecycle] [--focused-verify "<command>"] [--public-verify "<command>"] [--codex --model terra|sol --effort LEVEL] [--workspace DIR] [--max-turns N] [--job-id ID] [--factory-home DIR] [--json]
bantam factory cohort run <fixture-dir> --yes [--id ID] [--model terra|sol] [--effort LEVEL] [--order native,bantam,factory] [--factory-home DIR] [--json]
bantam factory cohort show <cohort-id> [--factory-home DIR] [--json]
bantam factory workers list [--factory-home DIR] [--json]
bantam factory workers onboard --endpoint URL [--profile qwen] [--slots N] [--ttl MS] --yes [--factory-home DIR] [--json]
bantam factory workers install <profile.json> --yes [--factory-home DIR] [--json]
bantam factory workers qualify <worker-ref> --station-ref REF --task-family ID [--status candidate|qualified|suspended|removed] --yes
bantam factory workers health <worker-ref> --condition available|degraded|unavailable --code CODE [--ttl MS] [--slots N] --yes
bantam factory workers ingest <factory-job-id> --task-family ID [--source-home DIR] --yes [--json]
bantam factory workers certify-contract-edge <worker-ref> --yes [--factory-home DIR] [--json]
bantam factory workers certify-test-scenario <worker-ref> --yes [--factory-home DIR] [--json]
bantam factory workers eligible --station-ref REF --task-family ID [--capabilities a,b] [--max-p95 MS] [--max-cost USD] [--json]
bantam factory blueprint show <blueprint.json> [--job-id ID] [--factory-home DIR] [--json]
bantam factory blueprint report <blueprint.json> --output FILE [--job-id ID] [--factory-home DIR] [--json]
bantam factory apply <job-id> --yes [--workspace DIR] [--factory-home DIR] [--json]
bantam factory list [--factory-home DIR] [--json]
bantam factory dispatch [--factory-home DIR] [--json]
bantam factory schedule [--factory-home DIR] [--json]
bantam factory stats [--factory-home DIR] [--json]
bantam factory contract-edges "<contract>" --catalog FILE --expected ID[,ID...] [--endpoint URL] [--profile NAME] [--model ID] [--n-predict N] [--job-id ID] [--factory-home DIR] [--json]
bantam factory contract-plan "<contract>" --catalog FILE --expected ID[,ID...] [--endpoint URL] [--profile NAME] [--model ID] [--n-predict N] [--job-id ID] [--factory-home DIR] [--json]
bantam factory test-scenario "<obligation>" --edge-id ID --catalog FILE --expected ID [--endpoint URL] [--profile NAME] [--model ID] [--n-predict N] [--job-id ID] [--factory-home DIR] [--json]
bantam factory watch <job-id> [--interval MS] [--idle-after MS] [--once] [--factory-home DIR] [--json]
bantam factory show <job-id> [--at EVENT] [--timeline N] [--factory-home DIR] [--json]
bantam factory audit <job-id> [--factory-home DIR] [--json]
bantam factory report <job-id> [--at EVENT] [--output FILE] [--factory-home DIR] [--json]
bantam factory floor <job-id> [--port PORT] [--interval MS] [--factory-home DIR] [--json]
bantam factory yard [--port PORT] [--interval MS] [--idle-after MS] [--factory-home DIR] [--json]

Build in an isolated factory cell, explicitly promote a released candidate, or inspect its durable traveler.`;
}

function positiveIntegerOption(value, fallback, label) {
  if (value === undefined) return { value: fallback };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return { error: `${label} must be a positive integer` };
  return { value: number };
}

function nonNegativeIntegerOption(value, fallback, label) {
  if (value === undefined) return { value: fallback };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return { error: `${label} must be a non-negative integer` };
  return { value: number };
}

function optionalNonNegative(value, label) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function commaList(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("--capabilities requires a comma-separated list");
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readJsonFile(file, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${label} JSON could not be read: ${error.message}`); }
  return value;
}

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function normalizeCodexModel(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "terra";
  if (key === "terra") return "gpt-5.6-terra";
  if (key === "sol") return "gpt-5.6-sol";
  if (/^gpt-[a-z0-9.-]+$/.test(key)) return key;
  throw new Error(`factory: invalid Codex model ${value}`);
}

function normalizeEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "medium";
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error(`factory: invalid Codex effort ${value}`);
  }
  return effort;
}
