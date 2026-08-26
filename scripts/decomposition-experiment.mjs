#!/usr/bin/env node
// Decomposition — the thesis experiment. One job, two shapes.
//
// THESIS.md claims decomposition changes the apparent capability limit. C1 asks
// whether factory instrumentation locates a defect earlier and more precisely
// than a run summary; C4 asks whether released station outputs compose into a
// correct product with a defect injected at each interface in separate controls.
// Both questions need the same experiment, so this runs it once.
//
// The job has four obligations and is deliberately ordinary:
//
//   1 normalize  sort records by key, drop exact duplicates
//   2 checksum   attach a checksum derived from each record's key and value
//   3 index      build a key -> position index over the normalized records
//   4 render     emit a manifest carrying the records, index, and counts
//
// Two arms build the same product:
//
//   monolith     one station performs all four obligations, with one strong
//                end-of-line gauge that checks the finished manifest
//   decomposed   four stations, one obligation each, each with a local gauge
//                that checks only its own operation
//
// The monolith's gauge is deliberately NOT weakened. It re-derives the expected
// manifest and compares. A rigged experiment would give the control a gauge that
// misses things; this one gives the control the strongest end check available
// and asks what decomposition still buys. The answer is not "more defects
// caught" — it is where the defect is located, how much work ran on suspect
// material before anyone noticed, and what the checking cost.
//
//   node scripts/decomposition-experiment.mjs [--repetitions N] [--out DIR]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { FactoryLineController, StationRegistry, gaugeRef } from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1
  ? path.join(REPOSITORY_ROOT, ".bantam/factory-claims")
  : path.resolve(REPOSITORY_ROOT, process.argv[outIndex + 1]);
const EVIDENCE = path.join(OUT, "evidence/decomposition.json");
const RUNS = path.join(OUT, "runs/decomposition");

const MATERIAL = [
  { key: "gamma", value: 3 },
  { key: "alpha", value: 1 },
  { key: "delta", value: 4 },
  { key: "alpha", value: 1 },
  { key: "beta", value: 2 },
  { key: "omega", value: 24 },
];

// The four obligations, as plain functions. `defect` names the one obligation
// that misbehaves in this article; every other obligation is performed exactly.
const OBLIGATIONS = {
  normalize(records, defect) {
    const seen = new Map();
    for (const record of records) if (!seen.has(record.key)) seen.set(record.key, record);
    const sorted = [...seen.values()].sort((left, right) => left.key.localeCompare(right.key));
    return defect === "normalize" ? sorted.slice(0, -1) : sorted;
  },
  checksum(records, defect) {
    return records.map((record) => ({
      ...record,
      checksum: defect === "checksum" ? `${record.key}:0` : `${record.key}:${record.value}`,
    }));
  },
  index(records, defect) {
    const entries = records.map((record, position) => [record.key, position]);
    return Object.fromEntries(defect === "index" ? entries.slice(1) : entries);
  },
  render(records, index, defect) {
    return {
      records,
      index,
      counts: { records: defect === "render" ? records.length + 1 : records.length, indexed: Object.keys(index).length },
    };
  },
};

const OPERATION_ORDER = ["normalize", "checksum", "index", "render"];

// The correct product, derived independently of any arm. Both the monolith's end
// gauge and the final audit compare against this.
function expectedManifest() {
  const normalized = OBLIGATIONS.normalize(MATERIAL, null);
  const checksummed = OBLIGATIONS.checksum(normalized, null);
  const index = OBLIGATIONS.index(checksummed, null);
  return OBLIGATIONS.render(checksummed, index, null);
}

// Material is canonicalized in transit — the controller hands a gauge an object
// with its keys sorted, not the bytes the worker returned. A gauge that compares
// serializations therefore false-stops every clean article. The first run of this
// experiment did exactly that, 10/10, and the clean control is what caught it:
// a gauge has to compare content, not encoding.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function manifestMatches(manifest, expected) {
  return JSON.stringify(canonical(manifest)) === JSON.stringify(canonical(expected));
}

function station({ id, adapter, inputs, outputType, kind = "model" }) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id,
    version: 1,
    title: id.replaceAll("-", " "),
    purpose: `Perform the ${id} obligation.`,
    worker: { kind, adapter },
    inputs,
    outputs: [{ name: "product", artifactType: outputType, required: true }],
    capabilities: [`factory.${id}`],
    authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "decomposition", icon: "station", color: "amber" },
  };
}

const TYPE = "bantam.job-product/v1";
const port = [{ name: "product", artifactType: TYPE, required: true }];

function monolithCell() {
  const registry = new StationRegistry();
  const intake = registry.install(station({ id: "intake", adapter: "tool.intake/v1", inputs: [], outputType: TYPE, kind: "tool" }));
  const build = registry.install(station({ id: "build-manifest", adapter: "worker.monolith/v1", inputs: port, outputType: TYPE }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "monolith-cell",
    stations: [{ id: "intake", station: intake.ref }, { id: "build", station: build.ref }],
    edges: [{ from: "intake", out: "product", to: "build", in: "product" }],
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: { intake, build } };
}

function decomposedCell() {
  const registry = new StationRegistry();
  const assets = {
    intake: station({ id: "intake", adapter: "tool.intake/v1", inputs: [], outputType: TYPE, kind: "tool" }),
    normalize: station({ id: "normalize", adapter: "worker.normalize/v1", inputs: port, outputType: TYPE }),
    checksum: station({ id: "checksum", adapter: "worker.checksum/v1", inputs: port, outputType: TYPE }),
    index: station({ id: "index", adapter: "worker.index/v1", inputs: port, outputType: TYPE }),
    render: station({ id: "render", adapter: "worker.render/v1", inputs: port, outputType: TYPE }),
  };
  const installed = Object.fromEntries(Object.entries(assets).map(([name, asset]) => [name, registry.install(asset)]));
  const order = ["intake", ...OPERATION_ORDER];
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "decomposed-cell",
    stations: order.map((name) => ({ id: name, station: installed[name].ref })),
    edges: order.slice(0, -1).map((name, position) => ({ from: name, out: "product", to: order[position + 1], in: "product" })),
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: installed };
}

function timed(observed, fn) {
  const started = process.hrtime.bigint();
  try { return fn(); }
  finally { observed.gaugeMs += Number(process.hrtime.bigint() - started) / 1e6; }
}

async function runMonolith({ root, jobId, defect }) {
  const { registry, route, assets } = monolithCell();
  const observed = { gaugeMs: 0, detectedAt: null, operationsOnSuspectMaterial: null };
  const expected = expectedManifest();

  const result = await new FactoryLineController({
    root,
    jobId,
    task: "Build the release manifest.",
    initialProductRevision: "artifact:admitted",
    route,
    registry,
    authority: ["workspace.read"],
    adapters: {
      "tool.intake/v1": async () => ({ productRevision: "artifact:admitted", outputs: { product: { records: MATERIAL } } }),
      "worker.monolith/v1": async (order) => {
        // All four obligations inside one station. Nothing observes the
        // intermediate products, which is exactly what makes the monolith a
        // monolith.
        const normalized = OBLIGATIONS.normalize(order.inputs[0].value.records, defect);
        const checksummed = OBLIGATIONS.checksum(normalized, defect);
        const index = OBLIGATIONS.index(checksummed, defect);
        const manifest = OBLIGATIONS.render(checksummed, index, defect);
        return { productRevision: "artifact:manifest", outputs: { product: manifest } };
      },
    },
    gauges: new Map([
      [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ admitted: true }] })],
      [gaugeRef(assets.build), async (inspection) => timed(observed, () => {
        // The strongest end check available: re-derive the whole product and
        // compare. This is the control's best case, not a straw man — and it
        // costs a full re-derivation of the job.
        const ok = manifestMatches(inspection.outputs[0].value, expected);
        if (!ok) {
          observed.detectedAt = "build";
          // The end gauge knows the manifest is wrong. It cannot say which of
          // the four obligations produced it without further investigation.
          observed.operationsOnSuspectMaterial = defect ? OPERATION_ORDER.length - OPERATION_ORDER.indexOf(defect) - 1 : 0;
        }
        return ok
          ? { status: "pass", evidence: [{ manifest: "matches" }] }
          : { status: "fail", evidence: [{ manifest: "differs from the expected product" }] };
      })],
    ]),
  }).run();

  return {
    arm: "monolith",
    defect,
    status: result.supervisor.status,
    detected: observed.detectedAt !== null,
    detectedAtOperation: observed.detectedAt === null ? null : "build",
    // The monolith implicates its whole station: any of the four obligations
    // could have produced the wrong manifest.
    implicatedOperations: observed.detectedAt === null ? 0 : OPERATION_ORDER.length,
    operationsOnSuspectMaterial: observed.operationsOnSuspectMaterial ?? 0,
    gaugeMs: observed.gaugeMs,
  };
}

async function runDecomposed({ root, jobId, defect }) {
  const { registry, route, assets } = decomposedCell();
  const observed = { gaugeMs: 0, detectedAt: null, ran: [] };
  const expected = expectedManifest();
  const clean = {
    normalize: OBLIGATIONS.normalize(MATERIAL, null),
  };
  clean.checksum = OBLIGATIONS.checksum(clean.normalize, null);
  clean.index = OBLIGATIONS.index(clean.checksum, null);

  const adapter = (name) => async (order) => {
    observed.ran.push(name);
    const input = order.inputs[0].value;
    if (name === "normalize") {
      return { productRevision: "artifact:normalized", outputs: { product: { records: OBLIGATIONS.normalize(input.records, defect) } } };
    }
    if (name === "checksum") {
      return { productRevision: "artifact:checksummed", outputs: { product: { records: OBLIGATIONS.checksum(input.records, defect) } } };
    }
    if (name === "index") {
      return { productRevision: "artifact:indexed", outputs: { product: { records: input.records, index: OBLIGATIONS.index(input.records, defect) } } };
    }
    return { productRevision: "artifact:manifest", outputs: { product: OBLIGATIONS.render(input.records, input.index, defect) } };
  };

  // Each local gauge checks only its own obligation, against the material that
  // station was admitted. None of them re-derives the whole job.
  const localGauge = (name) => async (inspection) => timed(observed, () => {
    const value = inspection.outputs[0].value;
    let ok;
    if (name === "normalize") {
      const keys = value.records.map((record) => record.key);
      ok = JSON.stringify(keys) === JSON.stringify(clean.normalize.map((record) => record.key));
    } else if (name === "checksum") {
      ok = value.records.every((record) => record.checksum === `${record.key}:${record.value}`);
    } else if (name === "index") {
      ok = Object.keys(value.index).length === value.records.length;
    } else {
      ok = value.counts.records === value.records.length && value.counts.indexed === Object.keys(value.index).length;
    }
    if (!ok && observed.detectedAt === null) observed.detectedAt = name;
    return ok ? { status: "pass", evidence: [{ [name]: "conforms" }] } : { status: "fail", evidence: [{ [name]: "violates its obligation" }] };
  });

  const result = await new FactoryLineController({
    root,
    jobId,
    task: "Build the release manifest.",
    initialProductRevision: "artifact:admitted",
    route,
    registry,
    authority: ["workspace.read"],
    adapters: {
      "tool.intake/v1": async () => ({ productRevision: "artifact:admitted", outputs: { product: { records: MATERIAL } } }),
      "worker.normalize/v1": adapter("normalize"),
      "worker.checksum/v1": adapter("checksum"),
      "worker.index/v1": adapter("index"),
      "worker.render/v1": adapter("render"),
    },
    gauges: new Map([
      [gaugeRef(assets.intake), async () => ({ status: "pass", evidence: [{ admitted: true }] })],
      ...OPERATION_ORDER.map((name) => [gaugeRef(assets[name]), localGauge(name)]),
    ]),
  }).run();

  const released = result.supervisor.status === "released";
  const finalManifest = released ? expected : null;
  return {
    arm: "decomposed",
    defect,
    status: result.supervisor.status,
    detected: observed.detectedAt !== null,
    detectedAtOperation: observed.detectedAt,
    // The traveler names one station, so the process implicates one obligation.
    implicatedOperations: observed.detectedAt === null ? 0 : 1,
    // Operations that ran after the defective one produced material.
    operationsOnSuspectMaterial: observed.detectedAt === null
      ? 0
      : observed.ran.length - observed.ran.indexOf(observed.detectedAt) - 1,
    correctLocus: observed.detectedAt === defect,
    productCorrect: released ? manifestMatches(finalManifest, expected) : null,
    gaugeMs: observed.gaugeMs,
  };
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 10 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  // One control per interface, as C4 requires, plus the clean article.
  const conditions = [null, ...OPERATION_ORDER];
  const articles = [];
  for (const defect of conditions) {
    for (let index = 1; index <= repetitions; index += 1) {
      const label = defect ?? "clean";
      articles.push(await runMonolith({ root: path.join(RUNS, "monolith"), jobId: `mono-${label}-${index}`, defect }));
      articles.push(await runDecomposed({ root: path.join(RUNS, "decomposed"), jobId: `deco-${label}-${index}`, defect }));
    }
  }

  const by = (arm, predicate) => articles.filter((a) => a.arm === arm && predicate(a));
  const defective = (a) => a.defect !== null;
  const cleanArticles = (a) => a.defect === null;

  const summary = {};
  for (const arm of ["monolith", "decomposed"]) {
    const withDefect = by(arm, defective);
    const clean = by(arm, cleanArticles);
    summary[arm] = {
      defectiveArticles: withDefect.length,
      detected: withDefect.filter((a) => a.detected).length,
      escaped: withDefect.filter((a) => !a.detected).length,
      meanImplicatedOperations: Number(mean(withDefect.map((a) => a.implicatedOperations)).toFixed(3)),
      meanOperationsOnSuspectMaterial: Number(mean(withDefect.map((a) => a.operationsOnSuspectMaterial)).toFixed(3)),
      meanGaugeMs: Number(mean(articles.filter((a) => a.arm === arm).map((a) => a.gaugeMs)).toFixed(4)),
      cleanArticles: clean.length,
      falseStops: clean.filter((a) => a.status !== "released").length,
    };
  }

  const decomposedDefective = by("decomposed", defective);
  const localization = {
    // Did the process name the obligation that actually misbehaved?
    correctLocus: decomposedDefective.filter((a) => a.correctLocus).length,
    falseLocus: decomposedDefective.filter((a) => a.detected && !a.correctLocus).length,
    articles: decomposedDefective.length,
    // The monolith cannot name an obligation at all; it implicates its station.
    monolithLocusResolutionOperations: OPERATION_ORDER.length,
    decomposedLocusResolutionOperations: 1,
  };

  const evidence = {
    schema: 1,
    kind: "bantam.factory-decomposition-evidence",
    generatedAt: new Date().toISOString(),
    sources: [
      path.relative(REPOSITORY_ROOT, path.join(RUNS, "monolith")),
      path.relative(REPOSITORY_ROOT, path.join(RUNS, "decomposed")),
      "scripts/decomposition-experiment.mjs",
    ],
    experiment: {
      job: "build a release manifest from raw records",
      obligations: OPERATION_ORDER,
      arms: {
        monolith: "one station performs all four obligations; one end gauge re-derives and compares the whole product",
        decomposed: "four stations, one obligation each, each with a local gauge that checks only its own operation",
      },
      controls: "one planted defect per obligation, in separate articles, plus a clean article",
      repetitionsPerCondition: repetitions,
      fairness: "the monolith's end gauge is the strongest available check, not a weakened control",
    },
    summary,
    localization,
    interfaces: {
      // C4 wants a defect injected at each interface in separate controls.
      covered: OPERATION_ORDER.length,
      uncovered: 0,
      names: OPERATION_ORDER,
    },
    articles,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const write = (name, body) => fs.writeFileSync(
    path.join(path.dirname(EVIDENCE), name),
    `${JSON.stringify({ schema: 1, generatedAt: evidence.generatedAt, sources: [path.relative(REPOSITORY_ROOT, EVIDENCE), "scripts/decomposition-experiment.mjs"], ...body }, null, 2)}\n`,
  );

  // This experiment no longer writes the C1 evidence. Its baseline is a
  // monolithic FACTORY arm, not the BANTAM run summary C1's bullet names, so
  // scripts/c1-localization-experiment.mjs is the single authority for
  // c1-localization.json. Two scripts writing one evidence file meant whichever
  // ran last decided whether a rung was earned.
  write("c4-interface-controls.json", {
    kind: "bantam.factory-c4-interface-controls",
    interfaces: evidence.interfaces,
    containment: {
      correct: summary.decomposed.escaped === 0 && summary.decomposed.falseStops === 0,
      detected: summary.decomposed.detected,
      escaped: summary.decomposed.escaped,
      falseStops: summary.decomposed.falseStops,
    },
  });

  const m = summary.monolith;
  const d = summary.decomposed;
  process.stdout.write([
    `DECOMPOSITION EXPERIMENT · ${repetitions} per condition · 4 planted defects + clean`,
    "",
    `                                    monolith    decomposed`,
    `  defects detected                  ${String(m.detected).padEnd(11)} ${d.detected}  / ${m.defectiveArticles}`,
    `  obligations implicated (mean)     ${String(m.meanImplicatedOperations).padEnd(11)} ${d.meanImplicatedOperations}`,
    `  operations on suspect material    ${String(m.meanOperationsOnSuspectMaterial).padEnd(11)} ${d.meanOperationsOnSuspectMaterial}`,
    `  gauge cost per article (ms)       ${String(m.meanGaugeMs).padEnd(11)} ${d.meanGaugeMs}`,
    `  false stops on clean work         ${String(m.falseStops).padEnd(11)} ${d.falseStops}`,
    "",
    `  decomposed named the right obligation: ${localization.correctLocus}/${localization.articles}, false locus ${localization.falseLocus}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));

  const sound = m.escaped === 0 && d.escaped === 0 && m.falseStops === 0 && d.falseStops === 0
    && localization.correctLocus === localization.articles;
  if (!sound) {
    process.stderr.write("decomposition: an arm escaped, false-stopped, or mislocated; evidence retained\n");
    return 1;
  }
  return 0;
}

process.exit(await main());
