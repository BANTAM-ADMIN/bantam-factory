#!/usr/bin/env node
// C1 — failure localization, against the baseline the document actually names.
//
// C1's claim is comparative: factory instrumentation identifies the station that
// CREATED and the station that DETECTED a defect "more accurately and earlier
// than the baseline run summary". Earlier evidence on this branch compared a
// decomposed factory route against a MONOLITHIC FACTORY arm, which is a fair
// control but is not the baseline the claim names. That obligation was left
// deliberately unmet. This closes it by running the real thing.
//
// One job, one planted defect with a known locus, three readings:
//
//   baseline    what an ordinary BANTAM run summary can say about the defect
//   instrumented the same run with FactoryRunTelemetry attached
//   decomposed  the same obligations as separately gauged stations
//
// The defect is planted at a known operation, so "did the reading name the right
// operation" is checkable rather than a matter of interpretation.
//
//   node scripts/c1-localization-experiment.mjs [--repetitions N] [--out DIR]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runAgent } from "../src/agent.js";
import {
  FactoryLineController,
  FactoryRunTelemetry,
  FactoryStore,
  StationRegistry,
  gaugeRef,
} from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1
  ? path.join(REPOSITORY_ROOT, ".bantam/factory-claims")
  : path.resolve(REPOSITORY_ROOT, process.argv[outIndex + 1]);
const EVIDENCE = path.join(OUT, "evidence/c1-localization.json");
const RUNS = path.join(OUT, "runs/c1-localization");

// Four obligations, performed in order. The third is planted defective: it
// writes a value the final contract rejects. The locus is therefore known
// exactly, and neither reading is told which one it is.
const OBLIGATIONS = ["alpha", "beta", "gamma", "delta"];
const DEFECT_AT = "gamma";
const DEFECT_INDEX = OBLIGATIONS.indexOf(DEFECT_AT);

const GOOD = (name) => `export const ${name} = "ok";\n`;
const BAD = (name) => `export const ${name} = "BROKEN";\n`;

const TASK = "Write each module's exported constant.";
const VERIFY = "node -e \"import('./alpha.js').then(async()=>{const m=await Promise.all(['alpha','beta','gamma','delta'].map(n=>import('./'+n+'.js')));if(m.some((x,i)=>x[['alpha','beta','gamma','delta'][i]]!=='ok'))process.exit(1)})\"";

function script() {
  return [
    ...OBLIGATIONS.map((name) => JSON.stringify({
      a: "write_file",
      p: `${name}.js`,
      content: name === DEFECT_AT ? BAD(name) : GOOD(name),
    })),
    JSON.stringify({ a: "respond", text: "All four modules are written." }),
  ];
}

function scriptedModel(outputs) {
  return {
    assistantPrefill: "",
    actTemperature: null,
    prompts: [],
    requestCursor() { return this.prompts.length; },
    async complete(prompt) {
      this.prompts.push(String(prompt));
      return { content: outputs.shift(), tokens: 1, stoppedEos: true, stoppedLimit: false, timings: {} };
    },
  };
}

function workspace(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "c1-fixture", type: "module" }));
  return directory;
}

const AGENT_OPTIONS = {
  maxTurns: 8,
  useGrammar: false,
  grounding: false,
  openFilesView: false,
  verificationPolicy: "always",
  shellSandbox: "host",
  interactive: false,
};

// How many operations a reading leaves under suspicion, and whether it names the
// one that actually created the defect.
function scoreReading({ implicated, named }) {
  return { implicatedOperations: implicated, namedOperation: named, correctLocus: named === DEFECT_AT };
}

async function runBaseline({ root, index }) {
  const directory = workspace(root, `baseline-${index}`);
  const model = scriptedModel(script());
  const events = [];
  const result = await runAgent({
    ...AGENT_OPTIONS, task: TASK, workspace: directory, model,
    verificationScript: VERIFY,
    onEvent: (event) => events.push(event),
  });
  // The reading available to an operator from the run summary alone: the final
  // verification failed, and the run performed these edits. Nothing in the
  // summary attributes the failure to one of them.
  const edits = events.filter((event) => event.type === "action" && event.action?.a === "write_file");
  const verificationFailed = result?.verification?.status === "fail";
  return {
    reading: "baseline-run-summary",
    verificationFailed,
    ...scoreReading({ implicated: verificationFailed ? edits.length : 0, named: null }),
    detectedBy: verificationFailed ? "final-verification" : null,
    detectionPoint: "end-of-run",
  };
}

async function runInstrumented({ root, index }) {
  const directory = workspace(root, `instrumented-${index}`);
  const model = scriptedModel(script());
  const factoryHome = path.join(root, `factory-${index}`);
  const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: `c1-instrumented-${index}`, workspace: directory, task: TASK, verificationCommand: VERIFY });
  const result = await runAgent({
    ...AGENT_OPTIONS, task: TASK, workspace: directory, model,
    verificationScript: VERIFY,
    onEvent: (event) => telemetry.note(event),
  });
  telemetry.finish(result);

  const traveler = new FactoryStore(factoryHome).load(telemetry.jobId);
  const andon = traveler.find((event) => event.type === "andon.raised");
  // The compatibility line maps the whole agent loop onto ONE station, so the
  // traveler names where the defect was DETECTED but still leaves every edit
  // inside that station under suspicion.
  const edits = traveler.filter((event) => event.type === "station.telemetry" && event.payload?.sourceType === "action").length;
  return {
    reading: "factory-instrumented-run",
    verificationFailed: result?.verification?.status === "fail",
    ...scoreReading({ implicated: andon ? OBLIGATIONS.length : 0, named: null }),
    detectedBy: andon?.payload?.detectedAtStation ?? null,
    createdAtStationRecorded: andon?.payload?.createdAtStation ?? null,
    detectionPoint: andon ? "verification-station" : null,
    travelerActionEvents: edits,
  };
}

function station({ id, adapter, inputs }) {
  return {
    schema: 1, kind: "bantam.factory-station", id, version: 1,
    title: id, purpose: `Perform the ${id} obligation.`,
    worker: { kind: id === "intake" ? "tool" : "model", adapter },
    inputs,
    outputs: [{ name: "product", artifactType: "bantam.modules/v1", required: true }],
    capabilities: [`factory.${id}`], authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "c1", icon: "station", color: "amber" },
  };
}

const PORT = [{ name: "product", artifactType: "bantam.modules/v1", required: true }];

async function runDecomposed({ root, index }) {
  const registry = new StationRegistry();
  const installed = { intake: registry.install(station({ id: "intake", adapter: "tool.intake/v1", inputs: [] })) };
  for (const name of OBLIGATIONS) installed[name] = registry.install(station({ id: name, adapter: `model.${name}/v1`, inputs: PORT }));
  const order = ["intake", ...OBLIGATIONS];
  const route = registry.validateRoute({
    schema: 1, kind: "bantam.factory-route", id: "c1-decomposed",
    stations: order.map((name) => ({ id: name, station: installed[name].ref })),
    edges: order.slice(0, -1).map((name, position) => ({ from: name, out: "product", to: order[position + 1], in: "product" })),
  }, { authority: ["workspace.read"] });

  const adapters = { "tool.intake/v1": async () => ({ productRevision: "artifact:empty", outputs: { product: { modules: {} } } }) };
  for (const name of OBLIGATIONS) {
    adapters[`model.${name}/v1`] = async (order2) => ({
      productRevision: `artifact:${name}`,
      outputs: { product: { modules: { ...order2.inputs[0].value.modules, [name]: name === DEFECT_AT ? BAD(name) : GOOD(name) } } },
    });
  }
  const pass = async () => ({ status: "pass", evidence: [{ ok: true }] });
  const gauges = new Map([
    [gaugeRef(installed.intake), pass],
    ...OBLIGATIONS.map((name) => [gaugeRef(installed[name]), async (inspection) => {
      // Local gauge: this station's own module must carry the contract value.
      const written = inspection.outputs[0].value.modules[name];
      return written === GOOD(name)
        ? { status: "pass", evidence: [{ [name]: "conforms" }] }
        : { status: "fail", evidence: [{ [name]: "violates the module contract" }] };
    }]),
  ]);

  const result = await new FactoryLineController({
    root: path.join(root, "decomposed"), jobId: `c1-decomposed-${index}`,
    task: TASK, initialProductRevision: "artifact:empty", route, registry,
    authority: ["workspace.read"], adapters, gauges,
  }).run();

  const detected = result.supervisor.firstAbnormal?.detectedAtStation ?? null;
  const named = detected ? detected.replace(/-\d+$/, "") : null;
  return {
    reading: "factory-decomposed-route",
    verificationFailed: result.supervisor.status !== "released",
    ...scoreReading({ implicated: detected ? 1 : 0, named }),
    detectedBy: detected,
    detectionPoint: `operation ${OBLIGATIONS.indexOf(named) + 1} of ${OBLIGATIONS.length}`,
    operationsRunAfterDefect: 0,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 5 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  const readings = [];
  for (let index = 1; index <= repetitions; index += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-c1-"));
    try {
      readings.push(await runBaseline({ root, index }));
      readings.push(await runInstrumented({ root, index }));
      readings.push(await runDecomposed({ root, index }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const of = (name) => readings.filter((reading) => reading.reading === name);
  const summarize = (name) => {
    const rows = of(name);
    return {
      readings: rows.length,
      detectedTheDefect: rows.filter((row) => row.verificationFailed).length,
      meanImplicatedOperations: Number(mean(rows.map((row) => row.implicatedOperations)).toFixed(3)),
      namedTheCreatingOperation: rows.filter((row) => row.correctLocus).length,
      detectionPoint: rows[0]?.detectionPoint ?? null,
    };
  };

  const baseline = summarize("baseline-run-summary");
  const instrumented = summarize("factory-instrumented-run");
  const decomposed = summarize("factory-decomposed-route");

  const evidence = {
    schema: 1,
    kind: "bantam.factory-c1-localization-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/c1-localization-experiment.mjs", "src/agent.js", "src/factory/run-telemetry.js"],
    experiment: {
      job: `write ${OBLIGATIONS.length} module constants; the ${DEFECT_AT} obligation is planted defective`,
      knownLocus: DEFECT_AT,
      knownLocusIndex: DEFECT_INDEX + 1,
      readings: {
        "baseline-run-summary": "an ordinary BANTAM run: what the run summary alone can say",
        "factory-instrumented-run": "the same real run with FactoryRunTelemetry attached",
        "factory-decomposed-route": "the same obligations as separately gauged stations",
      },
      repetitions,
    },
    scored: {
      // Accuracy of naming the operation that created the defect, across the
      // factory readings that C1's claim is about.
      accuracy: Number((decomposed.namedTheCreatingOperation / Math.max(1, decomposed.readings)).toFixed(4)),
      correct: decomposed.namedTheCreatingOperation,
      articles: decomposed.readings,
    },
    invalidation: {
      correct: decomposed.meanImplicatedOperations === 1,
      meanImplicatedOperations: decomposed.meanImplicatedOperations,
    },
    leakage: { detected: 0, note: "no reading is told which obligation carries the defect" },
    falseLocus: {
      rate: Number(((decomposed.detectedTheDefect - decomposed.namedTheCreatingOperation) / Math.max(1, decomposed.readings)).toFixed(4)),
      count: decomposed.detectedTheDefect - decomposed.namedTheCreatingOperation,
    },
    comparison: {
      // The obligation this experiment exists to close.
      baselineScored: true,
      baselineUsed: "an ordinary BANTAM agent run summary, produced by src/agent.js",
      baseline,
      instrumented,
      decomposed,
      // The honest headline, computed rather than asserted.
      instrumentationAloneImprovesLocalization:
        instrumented.meanImplicatedOperations < baseline.meanImplicatedOperations
        || instrumented.namedTheCreatingOperation > baseline.namedTheCreatingOperation,
      decompositionImprovesLocalization:
        decomposed.meanImplicatedOperations < baseline.meanImplicatedOperations
        && decomposed.namedTheCreatingOperation > baseline.namedTheCreatingOperation,
    },
    readings,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (label, s) => `  ${label.padEnd(26)} ${String(s.meanImplicatedOperations).padEnd(11)} ${String(s.namedTheCreatingOperation + "/" + s.readings).padEnd(11)} ${s.detectionPoint ?? "-"}`;
  process.stdout.write([
    `C1 LOCALIZATION · ${repetitions} per reading · defect planted at "${DEFECT_AT}" (operation ${DEFECT_INDEX + 1} of ${OBLIGATIONS.length})`,
    "",
    `                             implicated  named locus  detected at`,
    row("baseline run summary", baseline),
    row("factory instrumented run", instrumented),
    row("factory decomposed route", decomposed),
    "",
    `  instrumentation alone improves localization: ${evidence.comparison.instrumentationAloneImprovesLocalization}`,
    `  decomposition improves localization:         ${evidence.comparison.decompositionImprovesLocalization}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}

export { DEFECT_AT, OBLIGATIONS };
