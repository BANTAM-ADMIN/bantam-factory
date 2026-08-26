#!/usr/bin/env node
// C0 — observability parity. The floor of the ladder, and the rung nothing on
// this branch had done.
//
// C0's claim: an unchanged BANTAM run can be represented as a factory job and
// route without changing its behavior. Everything above it depends on that,
// because a factory description that alters the run is describing a different
// run. Every other experiment on this branch drives the FactoryLineController
// directly, which cannot answer this question — the question is about the actual
// agent loop.
//
// So this runs the real `runAgent` twice on identical workspaces with an
// identical scripted model, once plain and once with FactoryRunTelemetry
// attached exactly as `bin/bantam.js --factory` attaches it, and compares:
//
//   workspace trees      identical start, identical end
//   model requests       byte-identical prompt sequences
//   trajectory           identical actions and terminal disposition
//   reconstruction       the traveler independently audits and replays
//   overhead             instrumented wall time over control wall time
//
// The model is scripted, so the trajectory is deterministic and any divergence
// is the instrumentation's doing. That is the point: a noisy comparison could
// not detect a small behavioral change.
//
//   node scripts/c0-parity-experiment.mjs [--repetitions N] [--out DIR]

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runAgent } from "../src/agent.js";
import { FactoryRunTelemetry, auditFactoryTraveler, FactoryStore } from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1
  ? path.join(REPOSITORY_ROOT, ".bantam/factory-claims")
  : path.resolve(REPOSITORY_ROOT, process.argv[outIndex + 1]);
const EVIDENCE = path.join(OUT, "evidence/c0-parity.json");
const RUNS = path.join(OUT, "runs/c0-parity");

const TASK = "Set the exported value to the reviewed constant.";
const SEED = {
  "value.js": 'export const value = "old";\n',
  "notes.md": "The reviewed constant is 'new'.\n",
};

// One scripted trajectory: read the notes, write the file, finish. Identical in
// both arms, so a difference in outcome can only come from instrumentation.
function script() {
  return [
    JSON.stringify({ a: "read_file", p: "notes.md" }),
    JSON.stringify({ a: "write_file", p: "value.js", content: 'export const value = "new";\n' }),
    JSON.stringify({ a: "respond", text: "The exported value now matches the reviewed constant." }),
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

function seedWorkspace(root, name) {
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace, { recursive: true });
  for (const [file, contents] of Object.entries(SEED)) fs.writeFileSync(path.join(workspace, file), contents);
  return workspace;
}

// A digest of the whole tree: every relative path and its exact bytes. Two trees
// with the same digest are the same tree.
function treeDigest(workspace) {
  const rows = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".bantam" || entry.name === ".git") continue;
        walk(absolute);
      } else if (entry.isFile()) {
        rows.push([path.relative(workspace, absolute), crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
      }
    }
  };
  walk(workspace);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function trajectoryOf(events) {
  // The observable behavior of the run: which actions were taken, in order, and
  // how it ended. Timings and identifiers are deliberately excluded — they are
  // expected to differ and are not behavior.
  return events
    .filter((event) => event.type === "action" || event.type === "verification" || event.type === "give_up")
    .map((event) => {
      const action = event.action ?? {};
      return [event.type, action.a ?? null, action.p ?? null].join("|");
    });
}

const AGENT_OPTIONS = {
  maxTurns: 6,
  useGrammar: false,
  grounding: false,
  openFilesView: false,
  verificationPolicy: "after_edit",
  shellSandbox: "host",
  interactive: false,
};

async function runControl({ root, index }) {
  const workspace = seedWorkspace(root, `control-${index}`);
  const before = treeDigest(workspace);
  const model = scriptedModel(script());
  const events = [];
  // The agent loop performs its own durable artifact writes in both arms; the
  // control count is the baseline the instrumented count is compared against.
  const realFsync = fs.fsyncSync;
  let loopFsyncs = 0;
  fs.fsyncSync = (...args) => { loopFsyncs += 1; return realFsync.apply(fs, args); };
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await runAgent({ ...AGENT_OPTIONS, task: TASK, workspace, model, onEvent: (event) => events.push(event) });
  } finally {
    fs.fsyncSync = realFsync;
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { arm: "control", before, after: treeDigest(workspace), prompts: model.prompts, trajectory: trajectoryOf(events), responded: result.responded === true, wallMs, loopFsyncs, telemetry: null };
}

async function runInstrumented({ root, index }) {
  const workspace = seedWorkspace(root, `instrumented-${index}`);
  const before = treeDigest(workspace);
  const model = scriptedModel(script());
  const events = [];
  const factoryHome = path.join(root, `factory-${index}`);
  const jobId = `c0-parity-${index}`;
  // Attached exactly as bin/bantam.js --factory attaches it: the telemetry sees
  // every event the logger sees and is otherwise not in the loop.
  const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId, workspace, task: TASK });
  // Load-independent overhead witness: count actual fsync syscalls issued while
  // the live loop runs. Wall-clock ratios stay recorded as context, but they
  // are not the witness — two agents sharing this machine made the same code
  // measure 11.25x and 21.35x within fifteen minutes.
  const realFsync = fs.fsyncSync;
  let noteFsyncs = 0;
  fs.fsyncSync = (...args) => { noteFsyncs += 1; return realFsync.apply(fs, args); };
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await runAgent({
      ...AGENT_OPTIONS,
      task: TASK,
      workspace,
      model,
      onEvent: (event) => { telemetry.note(event); events.push(event); },
    });
  } finally {
    fs.fsyncSync = realFsync;
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  let finishFsyncs = 0;
  fs.fsyncSync = (...args) => { finishFsyncs += 1; return realFsync.apply(fs, args); };
  let report;
  try {
    report = telemetry.finish(result);
  } finally {
    fs.fsyncSync = realFsync;
  }

  // The traveler must reconstruct the run without trusting the writer.
  let audit = null;
  let auditError = null;
  try { audit = auditFactoryTraveler(new FactoryStore(factoryHome).load(telemetry.jobId)); }
  catch (error) { auditError = error.message; }

  return {
    arm: "instrumented",
    before,
    after: treeDigest(workspace),
    prompts: model.prompts,
    trajectory: trajectoryOf(events),
    responded: result.responded === true,
    wallMs,
    telemetry: {
      ok: report?.ok ?? false,
      error: report?.error ?? null,
      overheadMs: report?.overheadMs ?? null,
      notedEvents: report?.telemetry?.notedEvents ?? null,
      noteDurability: report?.telemetry?.noteDurability ?? null,
      noteFsyncs,
      finishFsyncs,
      auditedEvents: audit?.eventCount ?? null,
      auditTerminal: audit?.terminal ?? null,
      auditError,
    },
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 8 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }
  fs.rmSync(RUNS, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });

  const pairs = [];
  for (let index = 1; index <= repetitions; index += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-c0-"));
    try {
      // Order alternates so a warm-cache advantage cannot accrue to one arm.
      const [control, instrumented] = index % 2 === 1
        ? [await runControl({ root, index }), await runInstrumented({ root, index })]
        : (await (async () => {
          const b = await runInstrumented({ root, index });
          const a = await runControl({ root, index });
          return [a, b];
        })());
      pairs.push({ index, control, instrumented });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const same = (pick) => pairs.every((pair) => JSON.stringify(pick(pair.control)) === JSON.stringify(pick(pair.instrumented)));
  const identicalStart = same((run) => run.before);
  const identicalEnd = same((run) => run.after);
  const identicalPrompts = same((run) => run.prompts);
  const identicalTrajectory = same((run) => run.trajectory);
  const identicalDisposition = same((run) => run.responded);
  const ratios = pairs.map((pair) => pair.instrumented.wallMs / pair.control.wallMs);
  const p95Ratio = percentile(ratios, 0.95);
  const audited = pairs.filter((pair) => pair.instrumented.telemetry.auditTerminal === true).length;
  const telemetryOk = pairs.every((pair) => pair.instrumented.telemetry.ok);

  const evidence = {
    schema: 1,
    kind: "bantam.factory-c0-parity-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/c0-parity-experiment.mjs", "src/factory/run-telemetry.js"],
    experiment: {
      loop: "src/agent.js runAgent — the real BANTAM agent loop, not the factory line controller",
      model: "scripted deterministic responses; identical script in both arms",
      instrumentation: "FactoryRunTelemetry attached exactly as bin/bantam.js --factory attaches it",
      pairsPerRun: repetitions,
      ordering: "arm order alternates by repetition",
    },
    workspace: {
      identicalTrees: identicalStart && identicalEnd,
      identicalStartingTrees: identicalStart,
      identicalFinalTrees: identicalEnd,
    },
    model: {
      // C0 accepts identical requests OR an explicitly measured delta. These are
      // byte-identical, so the delta is zero and stated as such.
      requestDelta: identicalPrompts ? 0 : pairs.filter((pair) => JSON.stringify(pair.control.prompts) !== JSON.stringify(pair.instrumented.prompts)).length,
      identicalPrompts,
      promptsPerRun: pairs[0]?.control.prompts.length ?? 0,
    },
    trajectory: {
      identical: identicalTrajectory && identicalDisposition,
      identicalActions: identicalTrajectory,
      identicalTerminalDisposition: identicalDisposition,
      observed: pairs[0]?.control.trajectory ?? [],
    },
    reconstruction: {
      travelersAudited: audited,
      pairs: pairs.length,
      telemetryComplete: telemetryOk,
      meanAuditedEvents: pairs.length ? pairs.reduce((total, pair) => total + (pair.instrumented.telemetry.auditedEvents ?? 0), 0) / pairs.length : 0,
    },
    overhead: {
      // The witness: durable-sync operations the OBSERVER adds per observed
      // event during the live loop window — instrumented-arm fsyncs minus the
      // control arm's own deterministic loop fsyncs. Load-independent — it
      // counts syscalls, not time.
      instrumentedLoopFsyncs: pairs.reduce((total, pair) => total + pair.instrumented.telemetry.noteFsyncs, 0),
      controlLoopFsyncs: pairs.reduce((total, pair) => total + (pair.control.loopFsyncs ?? 0), 0),
      notedEvents: pairs.reduce((total, pair) => total + (pair.instrumented.telemetry.notedEvents ?? 0), 0),
      noteFsyncsPerEvent: (() => {
        const events = pairs.reduce((total, pair) => total + (pair.instrumented.telemetry.notedEvents ?? 0), 0);
        const instrumented = pairs.reduce((total, pair) => total + pair.instrumented.telemetry.noteFsyncs, 0);
        const control = pairs.reduce((total, pair) => total + (pair.control.loopFsyncs ?? 0), 0);
        return events ? Number(((instrumented - control) / events).toFixed(4)) : null;
      })(),
      meanFinishFsyncs: Number((pairs.reduce((total, pair) => total + pair.instrumented.telemetry.finishFsyncs, 0) / pairs.length).toFixed(2)),
      // Context, not witness: wall-clock is load-dependent on a shared machine.
      p95Ratio: p95Ratio === null ? null : Number(p95Ratio.toFixed(4)),
      meanRatio: Number((ratios.reduce((total, value) => total + value, 0) / ratios.length).toFixed(4)),
      meanSelfReportedOverheadMs: Number((pairs.reduce((total, pair) => total + (pair.instrumented.telemetry.overheadMs ?? 0), 0) / pairs.length).toFixed(4)),
      meanControlWallMs: Number((pairs.reduce((total, pair) => total + pair.control.wallMs, 0) / pairs.length).toFixed(4)),
      meanInstrumentedWallMs: Number((pairs.reduce((total, pair) => total + pair.instrumented.wallMs, 0) / pairs.length).toFixed(4)),
    },
    pairs,
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  process.stdout.write([
    `C0 PARITY EXPERIMENT · ${repetitions} matched pairs · real BANTAM agent loop`,
    "",
    `  identical starting trees        ${identicalStart}`,
    `  identical final trees           ${identicalEnd}`,
    `  identical model requests        ${identicalPrompts} (delta ${evidence.model.requestDelta})`,
    `  identical trajectory            ${identicalTrajectory}`,
    `  identical terminal disposition  ${identicalDisposition}`,
    `  travelers independently audited ${audited}/${pairs.length}`,
    "",
    `  note fsyncs per event           ${evidence.overhead.noteFsyncsPerEvent}  (witness: == 0)`,
    `  finish fsyncs (terminal batch)  ${evidence.overhead.meanFinishFsyncs} mean`,
    `  wall p95 ratio (context only)   ${evidence.overhead.p95Ratio}`,
    `  telemetry self-reported cost    ${evidence.overhead.meanSelfReportedOverheadMs} ms mean`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));

  const behaviourPreserved = identicalStart && identicalEnd && identicalPrompts && identicalTrajectory
    && identicalDisposition && telemetryOk && audited === pairs.length;
  if (!behaviourPreserved) {
    process.stderr.write("C0: instrumentation changed the run, or a traveler did not audit; evidence retained\n");
    return 1;
  }
  return 0;
}

process.exit(await main());
