#!/usr/bin/env node
// C2 — local containment. A planted-defect experiment, not a unit specimen.
//
// PROOF-PROGRAM.md's C2 bullets describe an experiment: a control route lets a
// known defect escape, the treatment gauge stops the same defect, the suspect
// output is never consumed downstream, and a clean negative control passes
// without a false stop. Unit tests of gauge-fail-then-contain are synthetic
// specimens of the mechanism, not that experiment. This runs the experiment.
//
// The station under test does one small, checkable job: normalize a record list
// (sort by key, drop exact duplicates). The gauge is independent of the worker:
// it compares the product's key set against the admitted material's key set, so
// it never asks the worker whether the worker succeeded.
//
// Four arms, because a gauge tested only against the defect it was built for is
// an advertisement:
//
//   control    dropped-record  · no gauge   → the defect must escape downstream
//   treatment  dropped-record  · gauged     → the defect must stop at the station
//   clean      no defect       · gauged     → must release, with no false stop
//   uncovered  corrupted-value · gauged     → must escape; this arm can only make
//                                             the gauge look worse, and it does
//
// The fourth arm measures the gauge's coverage boundary rather than leaving it
// as an unstated assumption. A key-set gauge is blind to value corruption by
// construction, and the experiment reports how far such a defect travels.
//
//   node scripts/c2-containment-experiment.mjs [--repetitions N]
//
// Writes .bantam/factory-claims/evidence/c2-containment.json, the artifact the
// claim ledger's C2 rung reads.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  FactoryLineController,
  StationRegistry,
  auditFactoryTraveler,
  gaugeRef,
} from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
// A verification run must not be able to overwrite the recorded evidence with a
// smaller cohort. --out redirects everything this script writes.
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1
  ? path.join(REPOSITORY_ROOT, ".bantam/factory-claims")
  : path.resolve(REPOSITORY_ROOT, process.argv[outIndex + 1]);
const EVIDENCE = path.join(OUT, "evidence/c2-containment.json");
const COST_EVIDENCE = path.join(OUT, "evidence/c2-containment-cost.json");
const RUNS = path.join(OUT, "runs/c2-containment");

// The admitted material. Deliberately small and legible: an operator can read it
// and decide by eye whether a product is right.
const MATERIAL = [
  { key: "gamma", value: 3 },
  { key: "alpha", value: 1 },
  { key: "delta", value: 4 },
  { key: "alpha", value: 1 },
  { key: "beta", value: 2 },
  { key: "omega", value: 24 },
];
// The downstream station needs this record. The planted defect drops it, so a
// defect that escapes produces a visibly wrong final product rather than a
// product that merely differs.
const REQUIRED_KEY = "omega";
const EXPECTED_VALUES = new Map(MATERIAL.map((record) => [record.key, record.value]));

// Two defect classes, deliberately. `dropped-record` is what the gauge was
// designed to catch. `corrupted-value` preserves the key set exactly, so the
// gauge is blind to it by construction — that arm measures the gauge's coverage
// boundary instead of leaving it as an unstated assumption.
function normalize(records, { defect }) {
  const seen = new Map();
  for (const record of records) if (!seen.has(record.key)) seen.set(record.key, record);
  const sorted = [...seen.values()].sort((left, right) => left.key.localeCompare(right.key));
  if (defect === "dropped-record") return sorted.slice(0, -1);
  if (defect === "corrupted-value") return sorted.map((record) => ({ ...record, value: record.value + 1 }));
  return sorted;
}

function station({ id, adapter, inputs, gauge, kind = "tool" }) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id,
    version: 1,
    title: id.replaceAll("-", " "),
    purpose: `Execute the ${id} operation of the containment cell.`,
    worker: { kind, adapter },
    inputs,
    outputs: [{ name: "records", artifactType: "bantam.record-list/v1", required: true }],
    capabilities: [`factory.${id}`],
    authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "containment-cell", icon: "station", color: "amber" },
  };
}

function cell() {
  const registry = new StationRegistry();
  const port = [{ name: "records", artifactType: "bantam.record-list/v1", required: true }];
  const intake = registry.install(station({ id: "intake", adapter: "tool.intake/v1", inputs: [] }));
  const normalizeStation = registry.install(station({
    id: "normalize",
    adapter: "worker.normalize/v1",
    inputs: port,
    kind: "model",
  }));
  const consume = registry.install(station({ id: "consume", adapter: "tool.consume/v1", inputs: port }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "containment-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "normalize", station: normalizeStation.ref },
      { id: "consume", station: consume.ref },
    ],
    edges: [
      { from: "intake", out: "records", to: "normalize", in: "records" },
      { from: "normalize", out: "records", to: "consume", in: "records" },
    ],
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: { intake, normalize: normalizeStation, consume } };
}

// One arm = one condition. `defect` plants the off-by-one in the worker;
// `gauged` decides whether the station has a real local gauge or a permissive
// one standing in for "no gauge installed" — the control condition C2 requires.
async function runArticle({ root, jobId, defect, gauged }) {
  const { registry, route, assets } = cell();
  const observed = { consumed: false, finalHasRequiredKey: null, finalValuesCorrect: null, gaugeMs: 0 };

  const adapters = {
    "tool.intake/v1": async () => ({
      productRevision: "artifact:admitted",
      outputs: { records: { records: MATERIAL } },
    }),
    "worker.normalize/v1": async (order) => {
      const records = normalize(order.inputs[0].value.records, { defect });
      return {
        productRevision: `artifact:normalized${defect ? "-defective" : ""}`,
        outputs: { records: { records } },
      };
    },
    "tool.consume/v1": async (order) => {
      // The downstream consumer. If it runs at all on a suspect product, the
      // defect escaped; what it produces tells us whether that mattered.
      observed.consumed = true;
      const { records } = order.inputs[0].value;
      observed.finalHasRequiredKey = records.some((record) => record.key === REQUIRED_KEY);
      observed.finalValuesCorrect = records.every((record) => EXPECTED_VALUES.get(record.key) === record.value);
      return {
        productRevision: "artifact:indexed",
        outputs: { records: { records, index: records.map((record) => record.key) } },
      };
    },
  };

  const pass = async () => ({ status: "pass", evidence: [{ checked: true }] });
  const gauges = new Map([
    [gaugeRef(assets.intake), pass],
    [gaugeRef(assets.consume), pass],
    [gaugeRef(assets.normalize), async (inspection) => {
      const started = process.hrtime.bigint();
      try {
        if (!gauged) return { status: "pass", evidence: [{ gauge: "not-installed" }] };
        // Independent observable: the product's key set must be exactly the
        // admitted material's key set. The gauge never consults the worker.
        const admitted = [...new Set(MATERIAL.map((record) => record.key))].sort();
        const produced = [...new Set(inspection.outputs[0].value.records.map((record) => record.key))].sort();
        const missing = admitted.filter((key) => !produced.includes(key));
        const added = produced.filter((key) => !admitted.includes(key));
        if (missing.length || added.length) {
          return { status: "fail", evidence: [{ missingKeys: missing, unexpectedKeys: added }] };
        }
        return { status: "pass", evidence: [{ keySetPreserved: true, keys: produced.length }] };
      } finally {
        observed.gaugeMs += Number(process.hrtime.bigint() - started) / 1e6;
      }
    }],
  ]);

  const started = process.hrtime.bigint();
  const result = await new FactoryLineController({
    root,
    jobId,
    task: "Normalize the admitted record list.",
    taskFamily: "generic",
    initialProductRevision: "artifact:admitted",
    route,
    registry,
    authority: ["workspace.read"],
    adapters,
    gauges,
  }).run();
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    jobId,
    status: result.supervisor.status,
    contained: result.supervisor.chassis.contained ?? [],
    detectedAtStation: result.supervisor.firstAbnormal?.detectedAtStation ?? null,
    downstreamConsumed: observed.consumed,
    finalHasRequiredKey: observed.finalHasRequiredKey,
    finalValuesCorrect: observed.finalValuesCorrect,
    gaugeMs: observed.gaugeMs,
    durationMs,
    travelerValid: auditFactoryTraveler(result.events).terminal !== undefined,
  };
}

async function arm({ root, label, repetitions, defect, gauged }) {
  const articles = [];
  for (let index = 1; index <= repetitions; index += 1) {
    articles.push(await runArticle({ root, jobId: `${label}-${index}`, defect, gauged }));
  }
  return { label, defect, gauged, repetitions, articles };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flagIndex = process.argv.indexOf("--repetitions");
  const repetitions = flagIndex === -1 ? 20 : Number(process.argv[flagIndex + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  // Three conditions, one planted defect, one gauge.
  const control = await arm({ root: path.join(RUNS, "control"), label: "control", repetitions, defect: "dropped-record", gauged: false });
  const treatment = await arm({ root: path.join(RUNS, "treatment"), label: "treatment", repetitions, defect: "dropped-record", gauged: true });
  const clean = await arm({ root: path.join(RUNS, "clean"), label: "clean", repetitions, defect: null, gauged: true });
  // The arm that can only make the gauge look worse. A defect the gauge was not
  // designed to see must escape; reporting how far it gets is the difference
  // between a demonstration and an advertisement.
  const uncovered = await arm({ root: path.join(RUNS, "uncovered"), label: "uncovered", repetitions, defect: "corrupted-value", gauged: true });

  // A defect "escaped" only if downstream actually consumed it AND the final
  // product is wrong. Reaching downstream with a correct product would not be
  // an escape, and a wrong product nobody consumed would not be either.
  const escapes = control.articles.filter((a) => a.downstreamConsumed && a.finalHasRequiredKey === false).length;
  const stopped = treatment.articles.filter((a) => a.status === "blocked" && a.detectedAtStation?.startsWith("normalize")).length;
  const treatmentConsumers = treatment.articles.filter((a) => a.downstreamConsumed).length;
  const falseStops = clean.articles.filter((a) => a.status !== "released").length;
  const cleanReleasedCorrect = clean.articles.filter((a) => a.status === "released" && a.finalHasRequiredKey === true).length;

  const uncoveredEscapes = uncovered.articles.filter((a) => a.downstreamConsumed && a.finalValuesCorrect === false).length;

  const evidence = {
    schema: 1,
    kind: "bantam.factory-c2-containment-evidence",
    generatedAt: new Date().toISOString(),
    experiment: {
      station: "normalize",
      operation: "sort by key and drop exact duplicates",
      plantedDefect: "off-by-one: the last record is dropped after sorting",
      gauge: "independent key-set comparison against the admitted material",
      controlCondition: "the same route with no gauge installed at the station",
      repetitionsPerArm: repetitions,
    },
    sources: [
      path.relative(REPOSITORY_ROOT, path.join(RUNS, "control")),
      path.relative(REPOSITORY_ROOT, path.join(RUNS, "treatment")),
      path.relative(REPOSITORY_ROOT, path.join(RUNS, "clean")),
      "scripts/c2-containment-experiment.mjs",
    ],
    plantedDefect: {
      escapedControlRoute: escapes === repetitions,
      escapesInControl: escapes,
      stoppedByGauge: stopped === repetitions,
      stopsInTreatment: stopped,
      downstreamConsumers: treatmentConsumers,
    },
    coverage: {
      // Stated as a limit, not a result. The gauge checks key-set preservation,
      // so a defect that preserves the key set is invisible to it.
      uncoveredDefectClass: "corrupted-value: every key retained, every value wrong",
      uncoveredDefectEscapes: uncoveredEscapes,
      uncoveredDefectRepetitions: repetitions,
      gaugeCovers: "record loss and record invention, by exact key-set comparison",
      gaugeDoesNotCover: "any defect that preserves the key set, including value corruption",
    },
    cleanControl: {
      falseStops,
      released: cleanReleasedCorrect,
      repetitions,
    },
    prevention: {
      // What the gauge costs when it finds nothing — the figure that decides
      // whether a gauge is worth installing on green work.
      meanGaugeMsOnCleanWork: Number(mean(clean.articles.map((a) => a.gaugeMs)).toFixed(4)),
      meanArticleMsGauged: Number(mean(clean.articles.map((a) => a.durationMs)).toFixed(4)),
      meanArticleMsUngauged: Number(mean(control.articles.map((a) => a.durationMs)).toFixed(4)),
      totalCost: Number((mean(clean.articles.map((a) => a.gaugeMs)) * repetitions).toFixed(4)),
    },
    arms: [control, treatment, clean, uncovered].map((entry) => ({
      label: entry.label,
      defect: entry.defect,
      gauged: entry.gauged,
      repetitions: entry.repetitions,
      dispositions: entry.articles.reduce((counts, article) => {
        counts[article.status] = (counts[article.status] ?? 0) + 1;
        return counts;
      }, {}),
    })),
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  // The ladder's prevention-cost obligation reads a separate file. Writing the
  // cost where the instrument already looks, rather than repointing the
  // instrument at where this experiment happened to put it, keeps the evidence
  // conforming to the claim instead of the other way round.
  fs.writeFileSync(COST_EVIDENCE, `${JSON.stringify({
    schema: 1,
    kind: "bantam.factory-c2-prevention-cost",
    generatedAt: evidence.generatedAt,
    sources: [path.relative(REPOSITORY_ROOT, EVIDENCE), "scripts/c2-containment-experiment.mjs"],
    prevention: evidence.prevention,
    basis: `${repetitions} clean articles through the gauged route versus ${repetitions} through the ungauged control`,
  }, null, 2)}\n`);

  const { plantedDefect, cleanControl, prevention } = evidence;
  process.stdout.write([
    `C2 CONTAINMENT EXPERIMENT · ${repetitions} articles per arm`,
    "",
    `  control   (defect, no gauge)  escaped downstream with a wrong product: ${plantedDefect.escapesInControl}/${repetitions}`,
    `  treatment (defect, gauged)    stopped at the normalize station:        ${plantedDefect.stopsInTreatment}/${repetitions}`,
    `  treatment                     downstream consumers of suspect output:  ${plantedDefect.downstreamConsumers}`,
    `  clean     (no defect, gauged) false stops:                             ${cleanControl.falseStops}/${repetitions}`,
    `  uncovered (blind defect, gauged) escaped past the gauge:               ${evidence.coverage.uncoveredDefectEscapes}/${repetitions}`,
    "",
    `  gauge cost on clean work: ${prevention.meanGaugeMsOnCleanWork} ms mean per article`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));

  // The experiment fails if it did not actually demonstrate the contrast.
  const demonstrated = plantedDefect.escapedControlRoute
    && plantedDefect.stoppedByGauge
    && plantedDefect.downstreamConsumers === 0
    && cleanControl.falseStops === 0;
  if (!demonstrated) {
    process.stderr.write("C2: the experiment did not demonstrate containment; evidence retained for diagnosis\n");
    return 1;
  }
  return 0;
}

process.exit(await main());
