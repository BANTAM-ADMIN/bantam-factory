#!/usr/bin/env node

/** Compile retained live model evidence into process passports and a visual wind tunnel. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  COGNITIVE_DEFECT_CLASSES,
  CognitiveProcessRegistry,
  defineCognitiveDefectRoutingPolicy,
  defineWorkerProfile,
  evaluateCognitiveProcessQualification,
  projectCognitiveProcessControl,
  routeCognitiveProcessAttempt,
  selectCognitiveProcess,
  semanticSensorStationAsset,
  verbatimAnchorStationAsset,
} from "../src/factory.js";

const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index < 0 ? fallback : argv[index + 1]; };
const dieEvidencePath = resolve(option("die-evidence", ".bantam/factory-benchmarks/diffusiongemma-die-convergence-v2.json"));
const anchorEvidencePath = resolve(option("anchor-evidence", ".bantam/factory-benchmarks/diffusiongemma-anchor-holdout-v1.json"));
const output = resolve(option("output", ".bantam/factory-benchmarks/cognitive-process-wind-tunnel-v1.json"));
const htmlOutput = resolve(option("html", ".bantam/factory-reports/cognitive-process-wind-tunnel-v1.html"));
const factoryRoot = resolve(option("factory-home", ".bantam"));

const [dieEvidence, anchorEvidence] = await Promise.all([
  readJson(dieEvidencePath), readJson(anchorEvidencePath),
]);
if (dieEvidence.schema !== "bantam.factory.diffusiongemma-die-convergence.v1") throw new Error("unexpected die evidence schema");
if (anchorEvidence.schema !== "bantam.factory.diffusiongemma-anchor-holdout.v1") throw new Error("unexpected anchor evidence schema");
const semanticStation = semanticSensorStationAsset();
const anchorStation = verbatimAnchorStationAsset();
const worker = defineWorkerProfile({
  schema: 1,
  kind: "bantam.factory-worker-profile",
  id: "local-diffusiongemma-dg-awq",
  version: 1,
  runtime: "local",
  provider: "plant",
  model: "diffusiongemma-9b-it-awq",
  reasoningEffort: null,
  transport: "openai-compatible",
  availabilityClass: "local-compute",
  capabilities: ["model.semantic-work", "source.anchor.locate", "semantic.matrix.classify"],
  cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
});

const routingPolicy = defineCognitiveDefectRoutingPolicy({
  schema: 1,
  kind: "bantam.factory-cognitive-defect-routing-policy",
  id: "diffusion-worker-bounded-rework",
  version: 1,
  routes: COGNITIVE_DEFECT_CLASSES.map((defect) => ({
    defect,
    action: ({
      "ambiguous-source": "recompile-context",
      "die-rejected": "split-lot",
      infrastructure: "alternate-worker",
      "malformed-output": "redraw",
      "protocol-fitting": "supervisor-review",
      "registry-inseparable": "recompile-context",
      "retry-exhausted": "stronger-worker",
      "semantic-rejection": "stronger-worker",
      "unknown-handle": "split-lot",
      "unmatched-source": "redraw",
      "wrong-record-escape": "stronger-worker",
    })[defect],
    maxAttempts: (defect === "wrong-record-escape" || defect === "semantic-rejection") ? 1 : 2,
  })),
});

const diePolicy = {
  schema: 1,
  kind: "bantam.factory-cognitive-process-qualification-policy",
  id: "semantic-matrix-native-tool-v1",
  version: 1,
  minimumArticles: 20,
  minimumStressClasses: 3,
  minimumFirstPassYield: 0.95,
  minimumRecoveredYield: 0.95,
  maximumEscapeRate: 0,
  maximumP95Ms: 2_000,
  maximumMeanCanvases: 1.5,
  maximumPassesPerReleased: 10,
};

const dieReports = ["verbose", "columns", "bits"].map((die) => evaluateCognitiveProcessQualification({
  process: processForDie(die, routingPolicy.ref),
  policy: diePolicy,
  attempts: dieEvidence.runs.filter((run) => run.die === die).map((run) => dieAttempt(run, dieEvidencePath)),
}));
const dieSelection = selectCognitiveProcess(dieReports);

const anchorPolicy = {
  schema: 1,
  kind: "bantam.factory-cognitive-process-qualification-policy",
  id: "verbatim-anchor-adversarial-v1",
  version: 1,
  minimumArticles: 60,
  minimumStressClasses: 6,
  minimumFirstPassYield: 0.9,
  minimumRecoveredYield: 0.9,
  maximumEscapeRate: 0,
  maximumP95Ms: 1_000,
  maximumMeanCanvases: 1,
  maximumPassesPerReleased: 6,
};
const anchorAttempts = anchorEvidence.runs.map((run) => anchorAttempt(run, anchorEvidencePath));
const anchorReport = evaluateCognitiveProcessQualification({
  process: processForAnchor(routingPolicy.ref),
  policy: anchorPolicy,
  attempts: anchorAttempts,
});
const anchorRoutes = anchorAttempts.filter((attempt) => !attempt.finalAccepted).map((attempt) => routeCognitiveProcessAttempt({ attempt, policy: routingPolicy }));
const processControl = projectCognitiveProcessControl([...dieReports, anchorReport], { basis: "live-evidence:diffusiongemma-wind-tunnel-v1" });
const registry = new CognitiveProcessRegistry(factoryRoot);
for (const qualification of [...dieReports, anchorReport]) {
  registry.install(qualification.process);
  registry.recordQualification(qualification);
}
const registryState = registry.project();
const registrySelection = registry.select({ stationRef: dieReports[0].process.stationRef, taskFamily: dieReports[0].process.taskFamily });
if (registrySelection.selected !== dieSelection.selected) throw new Error("durable registry selection diverged from the wind-tunnel article");

const report = {
  schema: "bantam.factory.cognitive-process-wind-tunnel.v1",
  kind: "bantam.factory-cognitive-process-wind-tunnel",
  generatedAt: new Date().toISOString(),
  authority: "observe-only",
  sources: { dieEvidencePath, anchorEvidencePath },
  routingPolicy,
  diePolicy,
  dieReports,
  dieSelection,
  anchorPolicy,
  anchorReport,
  anchorRoutes: summarizeRoutes(anchorRoutes),
  processControl,
  registry: {
    root: factoryRoot,
    head: registryState.head,
    events: registryState.events,
    processes: registryState.processes.length,
    qualifications: registryState.qualifications.length,
    selected: registrySelection.selected,
  },
  findings: [
    "The columns die is the only qualified semantic-matrix process in this retained cohort.",
    "Lower passes per canvas did not rescue the two-canvas bit process; total committed sampler work and yield govern.",
    "The anchor process remains candidate because exact localization cannot prevent semantically wrong-record selection.",
    "Every observed failure now enters a named chute; none is silently repaired into release authority.",
  ],
};

await Promise.all([mkdir(dirname(output), { recursive: true }), mkdir(dirname(htmlOutput), { recursive: true })]);
await Promise.all([writeFile(output, `${JSON.stringify(report, null, 2)}\n`), writeFile(htmlOutput, render(report))]);
console.log(JSON.stringify({
  output,
  htmlOutput,
  selectedDieProcess: dieSelection.selected,
  dieStatuses: Object.fromEntries(dieReports.map((row) => [row.process.id, row.status])),
  anchorStatus: anchorReport.status,
  anchorEscapes: anchorReport.metrics.escapes,
  controlAndons: processControl.summary.total,
}, null, 2));

function processForDie(die, recoveryPolicyRef) {
  return {
    schema: 1,
    kind: "bantam.factory-cognitive-process-passport",
    id: `diffusiongemma-semantic-${die}`,
    version: 2,
    taskFamily: "semantic-matrix-inspection",
    workerRef: worker.ref,
    stationRef: semanticStation.ref,
    contextKitRef: "context-kit:semantic-matrix-rack@1",
    dieRef: `die:native-tool-${die}@1`,
    gaugeRefs: ["gauge:exact-semantic-matrix@1"],
    recoveryPolicyRef,
  };
}

function processForAnchor(recoveryPolicyRef) {
  return {
    schema: 1,
    kind: "bantam.factory-cognitive-process-passport",
    id: "diffusiongemma-verbatim-anchor",
    version: 2,
    taskFamily: "semantic-evidence-localization",
    workerRef: worker.ref,
    stationRef: anchorStation.ref,
    contextKitRef: "context-kit:adversarial-pointed-records@1",
    dieRef: "die:native-tool-verbatim-anchor@1",
    gaugeRefs: ["gauge:exact-source-membership@1", "gauge:hidden-semantic-answer@1"],
    recoveryPolicyRef,
  };
}

function dieAttempt(run, source) {
  const defects = [];
  if (run.protocolFittingApplied) defects.push("protocol-fitting");
  if (!run.accepted) defects.push(run.ok ? "die-rejected" : "infrastructure");
  return {
    attemptId: `die-${run.die}-round-${run.round}`,
    stressClass: `call-position-${run.position}`,
    firstPassAccepted: run.strictAccepted,
    finalAccepted: run.accepted,
    escapedDefect: false,
    defects,
    telemetry: {
      elapsedMs: run.elapsedMs,
      committedCanvases: run.sampler?.canvases ?? 0,
      adaptivePasses: run.sampler?.passes ?? 0,
      promptTokens: run.usage?.prompt_tokens ?? 0,
      completionTokens: run.usage?.completion_tokens ?? 0,
      calls: 1,
    },
    evidenceRefs: [`${source}#run=${run.round}&die=${run.die}`],
  };
}

function anchorAttempt(run, source) {
  const outcome = run.outcome;
  const correct = outcome === "correct-location";
  const escaped = outcome === "wrong-location-escape";
  const defect = ({
    "wrong-location-escape": "wrong-record-escape",
    unmatched: "unmatched-source",
    malformed: "malformed-output",
    ambiguous: "ambiguous-source",
    "registry-rejected": "registry-inseparable",
  })[outcome];
  return {
    attemptId: `anchor-k${run.neighbors}-trial-${run.trial}`,
    stressClass: `neighbors-${run.neighbors}`,
    firstPassAccepted: correct || escaped,
    finalAccepted: correct,
    escapedDefect: escaped,
    defects: defect ? [defect] : [],
    telemetry: {
      elapsedMs: run.elapsedMs ?? 0,
      committedCanvases: run.sampler?.canvases ?? 0,
      adaptivePasses: run.sampler?.passes ?? 0,
      promptTokens: run.usage?.prompt_tokens ?? 0,
      completionTokens: run.usage?.completion_tokens ?? 0,
      calls: outcome === "registry-rejected" ? 0 : 1,
    },
    evidenceRefs: [`${source}#neighbors=${run.neighbors}&trial=${run.trial}`],
  };
}

function summarizeRoutes(routes) {
  const counts = {};
  for (const route of routes) counts[`${route.defect}:${route.action}`] = (counts[`${route.defect}:${route.action}`] ?? 0) + 1;
  return { articles: routes.length, counts };
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
function esc(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function render(report) {
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BANTAM Cognitive Wind Tunnel</title><style>
:root{--ink:#f6edcf;--muted:#a8a080;--floor:#0b100d;--panel:#141b16;--line:#39453a;--amber:#f2b84b;--green:#73d68a;--red:#ef6b5c;--violet:#ad8df2;--blue:#65bed1}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -20%,#3f4529 0,transparent 37%),repeating-linear-gradient(0deg,#0a0f0c 0 31px,#0c120e 32px),var(--floor);color:var(--ink);font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}header{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:18px;padding:20px 28px;border-bottom:1px solid #725c31;background:#0c120eee}.bird{font-size:50px}h1{margin:0;color:#f6ca70;font:900 22px/1 system-ui;letter-spacing:.08em}header p{margin:8px 0 0;color:var(--muted)}.stamp{padding:10px 13px;border:1px solid var(--violet);color:var(--violet);font-weight:900}main{max-width:1500px;margin:auto;padding:18px}.rail{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.machine{position:relative;min-height:265px;border:1px solid var(--line);background:linear-gradient(145deg,#1a231c,#101611);box-shadow:0 12px 35px #0006;overflow:hidden}.machine.qualified{border-color:var(--green);box-shadow:0 0 28px #73d68a18}.machine.candidate{border-color:var(--red)}.machine:before{content:'';display:block;height:11px;background:repeating-linear-gradient(90deg,#8a6b30 0 18px,#282318 18px 29px)}.head{display:flex;justify-content:space-between;padding:13px;border-bottom:1px solid var(--line)}.state{color:var(--red);font-weight:900}.qualified .state{color:var(--green)}.bay{height:80px;position:relative;background:repeating-linear-gradient(90deg,#101611 0 42px,#1d261f 42px 44px)}.chicken{position:absolute;left:18px;bottom:6px;font-size:48px}.die{position:absolute;right:18px;bottom:12px;padding:13px;border:2px solid #775c2a;background:#bd8732;color:#17120a;font-weight:900}.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;padding:12px}.metric{padding:8px;background:#0c120e;border-left:2px solid var(--blue)}.metric b{display:block;font-size:16px;color:var(--ink)}.metric small{color:var(--muted)}.blockers{padding:0 12px 12px;color:var(--red)}.selection{margin:14px 0;padding:13px;border-left:4px solid var(--green);background:#111912}.lower{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}.cell,.sorter{border:1px solid var(--line);background:#101611}.title{padding:11px 13px;border-bottom:1px solid var(--line);color:var(--amber);font-weight:900;letter-spacing:.09em}.anchor{padding:15px}.andon{display:inline-block;padding:5px 8px;border:1px solid var(--red);color:var(--red);font-weight:900}.big{font:900 31px/1 system-ui;margin:12px 0}.chutes{display:grid;gap:7px;padding:12px}.chute{display:grid;grid-template-columns:1fr auto;gap:10px;padding:9px;border-left:3px solid var(--violet);background:#151d17}.findings{margin-top:14px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.finding{padding:11px;border:1px solid var(--line);background:#101611;color:var(--muted)}details{margin-top:14px;border:1px solid var(--line);background:#090d0a}summary{padding:11px;cursor:pointer;color:var(--amber)}pre{max-height:480px;overflow:auto;padding:13px;color:#aebba9;white-space:pre-wrap}@media(max-width:900px){.rail,.lower,.findings{grid-template-columns:1fr}}
</style></head><body><header><div class="bird">🐓</div><div><h1>COGNITIVE PROCESS WIND TUNNEL</h1><p>live evidence → process passports → adversarial dies → shadow staffing decision</p></div><div class="stamp">OBSERVE-ONLY METROLOGY</div></header><main><section class="rail" id="rail"></section><div class="selection" id="selection"></div><section class="lower"><article class="cell"><div class="title">ANCHOR CELL · SEMANTIC ESCAPE TEST</div><div class="anchor" id="anchor"></div></article><article class="sorter"><div class="title">DEFECT SORTER · NAMED CHUTES</div><div class="chutes" id="chutes"></div></article></section><section class="findings" id="findings"></section><details><summary>EXACT BACKEND ARTIFACT · CLICK TO INSPECT</summary><pre id="raw"></pre></details></main><script id="data" type="application/json">${data}</script><script>
'use strict';const D=JSON.parse(document.getElementById('data').textContent),pct=n=>(n*100).toFixed(0)+'%',num=n=>Number(n).toFixed(2),short=s=>s.split(':')[1]||s;document.getElementById('rail').innerHTML=D.dieReports.map(r=>'<article class="machine '+r.status+'"><div class="head"><b>'+short(r.process.dieRef).toUpperCase()+'</b><span class="state">'+r.status.toUpperCase()+'</span></div><div class="bay"><span class="chicken">🐔</span><span class="die">'+r.process.id.split('-').at(-1)+'</span></div><div class="metrics"><div class="metric"><b>'+pct(r.metrics.firstPassYield)+'</b><small>first-pass yield</small></div><div class="metric"><b>'+pct(r.metrics.recoveredYield)+'</b><small>fitted yield</small></div><div class="metric"><b>'+num(r.metrics.meanCanvases)+'</b><small>canvases/article</small></div><div class="metric"><b>'+num(r.metrics.passesPerReleased||0)+'</b><small>passes/release</small></div></div><div class="blockers">'+(r.blockers.map(b=>'⚠ '+b.code).join('<br>')||'✓ every qualification die cleared')+'</div></article>').join('');const selected=D.dieReports.find(r=>r.process.ref===D.dieSelection.selected);document.getElementById('selection').innerHTML='<b>SHADOW PROCESS SELECTION:</b> '+(selected?selected.process.id:'NO QUALIFIED PROCESS')+' · '+D.dieSelection.explanation;const A=D.anchorReport;document.getElementById('anchor').innerHTML='<span class="andon">'+A.status.toUpperCase()+'</span><div class="big">'+A.metrics.escapes+' WRONG-RECORD ESCAPES</div><div>'+A.metrics.released+'/'+A.metrics.articles+' released · '+pct(A.metrics.firstPassYield)+' apparent first-pass acceptance · '+pct(A.metrics.escapeRate)+' independently detected escape rate</div><p style="color:var(--muted)">Exact membership knows which record was copied. It cannot know whether the worker copied the right record. The semantic gauge catches that defect and the process passport remains unqualified.</p>';document.getElementById('chutes').innerHTML=Object.entries(D.anchorRoutes.counts).map(([k,v])=>{const [defect,action]=k.split(':');return '<div class="chute"><b>'+defect+'</b><span>'+v+' → '+action+'</span></div>'}).join('');document.getElementById('findings').innerHTML=D.findings.map(x=>'<div class="finding">'+x+'</div>').join('');document.getElementById('raw').textContent=JSON.stringify(D,null,2);
</script></body></html>`;
}
