/** Strict Process IR definition, semantic linker, and observe-only projection. */

import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";
import { compileFactoryBlueprint, projectFactoryBlueprint } from "./blueprint.js";
import { gaugeRef } from "./compatibility-line.js";
import { StationRegistry } from "./station-registry.js";
import { defineCognitiveProcessControlEvidence, validateCognitiveProcessQualification } from "./cognitive-process-control.js";

const ID = /^[a-z][a-z0-9-]*$/;
const TASK = /^[a-z][a-z0-9._-]*$/;
const KINDS = new Set(["bounded-judgment", "deterministic", "authority-decision"]);

/** Define strict Process IR v1 and its immutable compilation identity. */
export function defineFactoryProcessIr(value) {
  exact(value, [
    "schema", "kind", "id", "version", "title", "taskFamily", "basis", "goal",
    "authority", "operations", "edges", "proofObligations", "release", "layout",
  ], "factory Process IR", ["ref"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-process-ir") throw new Error("factory Process IR must use schema 1");
  const basis = normalizeBasis(value.basis);
  const goal = normalizeGoal(value.goal);
  const operations = normalizeOperations(value.operations);
  const operationIds = new Set(operations.map((row) => row.id));
  const obligations = normalizeObligations(value.proofObligations, operationIds);
  const obligationIds = new Set(obligations.map((row) => row.id));
  for (const operation of operations) for (const obligation of operation.obligationIds) if (!obligationIds.has(obligation)) throw new Error(`Process IR operation ${operation.id} references unknown obligation: ${obligation}`);
  const edges = normalizeEdges(value.edges, operationIds);
  const release = normalizeRelease(value.release, operationIds, obligationIds);
  const layout = normalizeLayout(value.layout, operationIds);
  const body = {
    schema: 1,
    kind: value.kind,
    id: pattern(value.id, ID, "Process IR id"),
    version: positive(value.version, "Process IR version"),
    title: text(value.title, "Process IR title"),
    taskFamily: pattern(value.taskFamily, TASK, "Process IR task family"),
    basis,
    goal,
    authority: stringSet(value.authority, "Process IR authority"),
    operations,
    edges,
    proofObligations: obligations,
    release,
    layout,
  };
  const ref = `process-ir:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref !== undefined && value.ref !== ref) throw new Error("factory Process IR content hash does not match");
  return deepFreeze({ ...body, ref });
}

/**
 * Link Process IR against installed physical and cognitive machinery. This is
 * observe-only: a linked graph gains no execution or release authority.
 */
export function linkFactoryProcessIr({
  ir: value,
  stationRegistry,
  processQualifications = [],
  installedGaugeRefs = [],
  installedContextKitRefs = [],
  installedRecoveryPolicyRefs = [],
  installedProcessControlEvidence = [],
  trustedProcessControlIssuerRefs = [],
  workerResources = [],
  now = new Date().toISOString(),
} = {}) {
  const ir = defineFactoryProcessIr(value);
  if (!(stationRegistry instanceof StationRegistry)) throw new TypeError("Process IR linker requires a StationRegistry");
  if (!Array.isArray(processQualifications)) throw new TypeError("Process IR process qualifications must be an array");
  for (const report of processQualifications) validateCognitiveProcessQualification(report);
  if (new Set(processQualifications.map((report) => report.process.ref)).size !== processQualifications.length) throw new Error("Process IR linker received duplicate process qualifications");
  const gauges = new Set(stringSet(installedGaugeRefs, "installed gauge ref"));
  const contextKits = new Set(stringSet(installedContextKitRefs, "installed context kit ref"));
  const recoveryPolicies = new Set(stringSet(installedRecoveryPolicyRefs, "installed recovery policy ref"));
  const controlEvidence = normalizeProcessControlEvidence(installedProcessControlEvidence);
  const trustedControlIssuers = new Set(stringSet(trustedProcessControlIssuerRefs, "trusted process control issuer ref"));
  const linkedAt = instant(now, "Process IR link time");
  const resources = normalizeWorkerResources(workerResources);
  const granted = new Set(ir.authority);
  const diagnostics = [];
  const bindings = [];
  const assetByOperation = new Map();

  for (const operation of ir.operations) {
    const station = stationRegistry.get(operation.stationRef);
    if (!station) {
      diagnostics.push(diag("station-uninstalled", operation.id, operation.stationRef));
      continue;
    }
    assetByOperation.set(operation.id, station);
    const missingAuthority = station.authority.filter((item) => !granted.has(item));
    for (const authority of missingAuthority) diagnostics.push(diag("authority-ungranted", operation.id, authority));
    if (operation.kind === "bounded-judgment" && station.worker.kind !== "model") diagnostics.push(diag("operation-kind-worker-mismatch", operation.id, `${operation.kind}:${station.worker.kind}`));
    if (operation.kind === "deterministic" && station.worker.kind === "model") diagnostics.push(diag("operation-kind-worker-mismatch", operation.id, `${operation.kind}:${station.worker.kind}`));
    if (operation.kind === "authority-decision" && station.worker.kind !== "human") diagnostics.push(diag("operation-kind-worker-mismatch", operation.id, `${operation.kind}:${station.worker.kind}`));
    const stationGauge = gaugeRef(station);
    if (!gauges.has(stationGauge)) diagnostics.push(diag("station-gauge-uninstalled", operation.id, stationGauge));
    if (station.worker.kind === "model") {
      linkCognitiveOperation({ operation, station, reports: processQualifications, resources, gauges, contextKits, recoveryPolicies, controlEvidence, trustedControlIssuers, linkedAt, diagnostics, bindings });
    } else {
      if (operation.processRef !== null) diagnostics.push(diag("process-bound-to-nonmodel-operation", operation.id, operation.processRef));
      bindings.push({ operationId: operation.id, stationRef: station.ref, workerKind: station.worker.kind, processRef: null, workerRef: null, status: "installed" });
    }
  }

  for (const obligation of ir.proofObligations) {
    const gaugeOperation = ir.operations.find((row) => row.id === obligation.gaugeOperationId);
    const station = assetByOperation.get(obligation.gaugeOperationId);
    if (!gaugeOperation || !station) continue;
    if (!station.gauge.independent) diagnostics.push(diag("obligation-gauge-not-independent", obligation.gaugeOperationId, obligation.id));
    if (station.worker.kind === "model") diagnostics.push(diag("obligation-gauge-is-model-worker", obligation.gaugeOperationId, obligation.id));
    if (!gaugeOperation.obligationIds.includes(obligation.id)) diagnostics.push(diag("obligation-not-claimed-by-gauge", obligation.gaugeOperationId, obligation.id));
  }
  const releaseCoverage = new Set(ir.release.obligationIds);
  for (const obligation of ir.proofObligations) if (!releaseCoverage.has(obligation.id)) diagnostics.push(diag("release-obligation-uncovered", null, obligation.id));
  const releaseOperation = ir.operations.find((row) => row.id === ir.release.operationId);
  const releaseStation = assetByOperation.get(ir.release.operationId);
  if (releaseOperation && releaseStation && !releaseStation.outputs.some((port) => port.name === ir.release.outputPort)) diagnostics.push(diag("release-output-missing", ir.release.operationId, ir.release.outputPort));

  let blueprint = null, projection = null, routeRef = null;
  if (!diagnostics.length) {
    try {
      blueprint = {
        schema: 1,
        kind: "bantam.factory-blueprint",
        id: ir.id,
        version: ir.version,
        title: ir.title,
        taskFamily: ir.taskFamily,
        routeId: `${ir.id}-route`,
        authority: ir.authority,
        stations: ir.operations.map((operation) => ({ id: operation.id, asset: stripRef(assetByOperation.get(operation.id)), taskFamily: operation.taskFamily })),
        edges: ir.edges,
        layout: { direction: ir.layout.direction, stations: ir.layout.operations },
      };
      const compiled = compileFactoryBlueprint(blueprint);
      blueprint = compiled.blueprint;
      projection = projectFactoryBlueprint(compiled);
      routeRef = compiled.route.ref;
    } catch (error) {
      diagnostics.push(diag("route-link-failed", null, error.message));
      blueprint = null;
      projection = null;
    }
  }

  const body = {
    schema: 1,
    kind: "bantam.factory-process-link-report",
    authority: "observe-only",
    irRef: ir.ref,
    basis: ir.basis,
    status: diagnostics.length ? "rejected" : "linked",
    diagnostics,
    bindings,
    blueprintRef: blueprint?.ref ?? null,
    routeRef,
    blueprint,
    projection,
  };
  return deepFreeze({ ...body, artifactId: `process-link-report:sha256:${digest(body)}` });
}

/** Render the exact link report as a reviewable compiler floor. */
export function renderFactoryProcessLinkReport(report) {
  if (!report || report.kind !== "bantam.factory-process-link-report") throw new TypeError("process-link renderer requires a link report");
  const expected = `process-link-report:sha256:${digest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "artifactId")))}`;
  if (report.artifactId !== expected) throw new Error("process-link report content hash does not match");
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Process Compiler · BANTAMFACTORY</title><style>
:root{--bg:#080d0a;--panel:#121a14;--grid:#202b22;--ink:#f4e9c7;--muted:#9b947a;--gold:#efbb4b;--green:#70d888;--red:#ed6a5a;--blue:#65b9cc;--violet:#a68aed}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -10%,#3b4227,transparent 36%),repeating-linear-gradient(0deg,transparent 0 39px,var(--grid) 40px),repeating-linear-gradient(90deg,transparent 0 39px,var(--grid) 40px),var(--bg);color:var(--ink);font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}header{display:flex;align-items:center;gap:16px;padding:19px 25px;background:#0a100ceF;border-bottom:1px solid #6f582d}h1{margin:0;color:#f4ca70;font:900 21px system-ui;letter-spacing:.08em}header p{margin:5px 0 0;color:var(--muted)}.status{margin-left:auto;padding:8px 12px;border:1px solid var(--green);color:var(--green);font-weight:900}.status.rejected{border-color:var(--red);color:var(--red)}main{max-width:1500px;margin:auto;padding:16px}.floor{position:relative;min-height:430px;border:1px solid #3d493f;background:#0c120ed9;overflow:auto}.station{position:absolute;width:240px;min-height:155px;border:1px solid #465248;border-left:4px solid var(--blue);background:linear-gradient(145deg,#1d281f,#101611);box-shadow:7px 8px #0006;padding:12px}.station.model{border-left-color:var(--gold)}.station.error{border-color:var(--red)}.station b{display:block;color:#f2cf83;font:900 13px system-ui}.station small{color:var(--muted)}.machine{margin:12px -4px 7px;padding:7px;background:#0a100c;border-left:2px solid var(--violet);word-break:break-all}.gauge{color:var(--green)}svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.flow{stroke:#806b39;stroke-width:5;fill:none}.lower{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.panel{border:1px solid #3d493f;background:#0c120e}.panel h2{margin:0;padding:10px 12px;border-bottom:1px solid #3d493f;color:var(--gold);font-size:10px;letter-spacing:.12em}.rows{padding:10px}.row{padding:8px;margin-bottom:6px;background:#141d16;border-left:3px solid var(--red)}.ok{border-left-color:var(--green)}details{margin-top:12px;border:1px solid #3d493f;background:#090d0a}summary{padding:10px;color:var(--gold);cursor:pointer}pre{max-height:460px;overflow:auto;padding:12px;white-space:pre-wrap;color:#aebaa9}@media(max-width:900px){.lower{grid-template-columns:1fr}}
</style></head><body><header><div style="font-size:42px">🐓</div><div><h1>PROCESS COMPILER LINK FLOOR</h1><p>typed graph · installed machinery · qualified processes · proof closure · authority check</p></div><div class="status ${report.status}">${report.status.toUpperCase()}</div></header><main><section class="floor" id="floor"></section><section class="lower"><article class="panel"><h2>LINKER DIAGNOSTICS</h2><div class="rows" id="diagnostics"></div></article><article class="panel"><h2>PHYSICAL BINDINGS</h2><div class="rows" id="bindings"></div></article></section><details><summary>EXACT BACKEND LINK ARTIFACT</summary><pre id="raw"></pre></details></main><script id="report" type="application/json">${data}</script><script>
'use strict';const R=JSON.parse(document.getElementById('report').textContent),P=R.projection,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),short=v=>String(v??'').length>38?String(v).slice(0,19)+'…'+String(v).slice(-14):String(v??'');const F=document.getElementById('floor');if(P){const by=new Map(P.nodes.map(n=>[n.id,n])),scale=285,ox=35,oy=70,pt=n=>({x:ox+n.position.x*scale,y:oy+n.position.y*175});F.innerHTML='<svg>'+P.edges.map(e=>{const a=pt(by.get(e.from)),b=pt(by.get(e.to));return '<path class="flow" d="M '+(a.x+240)+' '+(a.y+75)+' C '+(a.x+270)+' '+(a.y+75)+', '+(b.x-30)+' '+(b.y+75)+', '+b.x+' '+(b.y+75)+'"/>'}).join('')+'</svg>'+P.nodes.map(n=>{const b=R.bindings.find(x=>x.operationId===n.id);const p=pt(n);const db=b?.dieBinding?.status?' · die-binding '+b.dieBinding.status:'';return '<article class="station '+n.workerKind+'" style="left:'+p.x+'px;top:'+p.y+'px"><b>'+esc(n.title)+'</b><small>'+esc(n.id)+' · '+esc(n.workerKind)+'</small><div class="machine">'+esc(short(b?.processRef||n.adapter))+'</div><span class="gauge">✓ gauge linked'+esc(db)+'</span></article>'}).join('');F.style.minWidth=(Math.max(...P.nodes.map(n=>pt(n).x))+310)+'px';F.style.minHeight=(Math.max(...P.nodes.map(n=>pt(n).y))+230)+'px'}else{F.innerHTML='<div style="padding:30px;color:var(--red)">GRAPH REJECTED BEFORE BLUEPRINT EMISSION. Inspect diagnostics below.</div>'}document.getElementById('diagnostics').innerHTML=R.diagnostics.length?R.diagnostics.map(d=>'<div class="row"><b>'+esc(d.code)+'</b><br>'+esc(d.operationId||'graph')+' · '+esc(d.detail)+'</div>').join(''):'<div class="row ok">✓ station resolution<br>✓ typed material flow<br>✓ process qualification<br>✓ worker capacity<br>✓ gauge and recovery assets<br>✓ proof closure<br>✓ authority envelope</div>';document.getElementById('bindings').innerHTML=R.bindings.map(b=>'<div class="row '+(b.status==='qualified'||b.status==='installed'?'ok':'')+'"><b>'+esc(b.operationId)+'</b> · '+esc(b.workerKind)+'<br>'+esc(short(b.processRef||b.stationRef))+(b.dieBinding?'<br>die-binding '+esc(b.dieBinding.status)+' · '+esc(b.prevention.kind)+' · '+esc(b.prevention.necessity):'')+'</div>').join('');document.getElementById('raw').textContent=JSON.stringify(R,null,2);
</script></body></html>`;
}

function linkCognitiveOperation({ operation, station, reports, resources, gauges, contextKits, recoveryPolicies, controlEvidence, trustedControlIssuers, linkedAt, diagnostics, bindings }) {
  if (operation.processRef === null) { diagnostics.push(diag("model-process-missing", operation.id, station.ref)); return; }
  const report = reports.find((row) => row.process.ref === operation.processRef);
  if (!report) { diagnostics.push(diag("process-qualification-missing", operation.id, operation.processRef)); return; }
  const process = report.process;
  const dieBinding = process.dieBinding ?? { stackRef: null, mechanism: null, canaryRef: null, status: "untested", legacy: true };
  const prevention = process.prevention ?? { kind: "none", mechanismRef: null, evidenceRef: null, necessity: "not-applicable", necessityEvidenceRef: null };
  if (process.stationRef !== station.ref) diagnostics.push(diag("process-station-mismatch", operation.id, process.stationRef));
  if (process.taskFamily !== operation.taskFamily) diagnostics.push(diag("process-task-family-mismatch", operation.id, process.taskFamily));
  if (report.status !== "qualified") diagnostics.push(diag("process-not-qualified", operation.id, report.artifactId));
  if (process.dieBinding?.canaryRef) verifyControlEvidence({
    ref: process.dieBinding.canaryRef,
    expected: { stationRef: process.stationRef, taskFamily: process.taskFamily, stackRef: process.dieBinding.stackRef, mechanismRef: process.dieRef, mechanism: process.dieBinding.mechanism, gauge: "sampler-canary", finding: process.dieBinding.status, controlStatus: "passed" },
    installed: controlEvidence, trustedIssuers: trustedControlIssuers, linkedAt, diagnostics, operationId: operation.id,
    missingCode: "die-binding-evidence-uninstalled", mismatchCode: "die-binding-evidence-mismatch",
  });
  if (prevention.evidenceRef) verifyControlEvidence({
    ref: prevention.evidenceRef,
    expected: {
      stationRef: process.stationRef, taskFamily: process.taskFamily, stackRef: dieBinding.stackRef, mechanismRef: prevention.mechanismRef,
      mechanism: prevention.kind === "sampler-die" ? dieBinding.mechanism : "prefill",
      gauge: prevention.kind === "sampler-die" ? "sampler-canary" : "prefill-continuation",
      finding: prevention.kind === "sampler-die" ? "bound" : "applied",
      controlStatus: "passed",
    },
    installed: controlEvidence, trustedIssuers: trustedControlIssuers, linkedAt, diagnostics, operationId: operation.id,
    missingCode: "prevention-evidence-uninstalled", mismatchCode: "prevention-evidence-mismatch",
  });
  if (prevention.necessityEvidenceRef) verifyControlEvidence({
    ref: prevention.necessityEvidenceRef,
    expected: { stationRef: process.stationRef, taskFamily: process.taskFamily, stackRef: dieBinding.stackRef, mechanismRef: prevention.mechanismRef, mechanism: prevention.kind, gauge: "bare-arm", finding: prevention.necessity, controlStatus: "passed" },
    installed: controlEvidence, trustedIssuers: trustedControlIssuers, linkedAt, diagnostics, operationId: operation.id,
    missingCode: "prevention-necessity-evidence-uninstalled", mismatchCode: "prevention-necessity-evidence-mismatch",
  });
  if (operation.requiresBoundDie === true && dieBinding.status !== "bound") {
    const code = dieBinding.status === "intermittent" ? "die-binding-intermittent"
      : dieBinding.status === "not-bound" ? "die-binding-not-bound"
        : "die-binding-untested";
    diagnostics.push(diag(code, operation.id, dieBinding.canaryRef ?? process.ref));
  }
  if (!contextKits.has(process.contextKitRef)) diagnostics.push(diag("context-kit-uninstalled", operation.id, process.contextKitRef));
  if (!recoveryPolicies.has(process.recoveryPolicyRef)) diagnostics.push(diag("recovery-policy-uninstalled", operation.id, process.recoveryPolicyRef));
  for (const reference of process.gaugeRefs) if (!gauges.has(reference)) diagnostics.push(diag("process-gauge-uninstalled", operation.id, reference));
  const resource = resources.get(process.workerRef);
  if (!resource) diagnostics.push(diag("worker-resource-missing", operation.id, process.workerRef));
  else {
    if (resource.condition === "unavailable") diagnostics.push(diag("worker-unavailable", operation.id, process.workerRef));
    if (resource.slotsAvailable < 1) diagnostics.push(diag("worker-capacity-zero", operation.id, process.workerRef));
    if (process.dieBinding && resource.stackRef === null) diagnostics.push(diag("worker-stack-unverified", operation.id, process.dieBinding.stackRef));
    else if (process.dieBinding && resource.stackRef !== process.dieBinding.stackRef) diagnostics.push(diag("worker-stack-mismatch", operation.id, `${resource.stackRef} != ${process.dieBinding.stackRef}`));
  }
  const evidenceRefs = [dieBinding.canaryRef, prevention.evidenceRef, prevention.necessityEvidenceRef].filter(Boolean);
  const evidence = [...new Set(evidenceRefs)].map((ref) => controlEvidence.get(ref)).filter(Boolean).map((row) => ({
    ref: row.ref, issuerRef: row.issuerRef, gauge: row.gauge, finding: row.finding,
    controlStatus: row.controlStatus, controlTrials: row.controlTrials,
    controlPasses: row.controlPasses, controlPassRate: row.controlPassRate,
    observedAt: row.observedAt, validUntil: row.validUntil,
  }));
  bindings.push({ operationId: operation.id, stationRef: station.ref, workerKind: station.worker.kind, processRef: process.ref, workerRef: process.workerRef, status: report.status, dieBinding, prevention, ...(evidence.length ? { controlEvidence: evidence } : {}) });
}

function normalizeBasis(value) { exact(value, ["chassisRef", "factBasis", "workforceHead", "processRegistryHead"], "Process IR basis"); return { chassisRef: text(value.chassisRef, "Process IR chassisRef"), factBasis: nonnegative(value.factBasis, "Process IR factBasis"), workforceHead: nullableText(value.workforceHead, "Process IR workforceHead"), processRegistryHead: nullableText(value.processRegistryHead, "Process IR processRegistryHead") }; }
function normalizeGoal(value) { exact(value, ["objective", "acceptanceContractRef"], "Process IR goal"); return { objective: text(value.objective, "Process IR objective"), acceptanceContractRef: text(value.acceptanceContractRef, "Process IR acceptanceContractRef") }; }
function normalizeOperations(value) { if (!Array.isArray(value) || !value.length) throw new TypeError("Process IR operations must be a non-empty array"); const seen = new Set(); return value.map((row, index) => { exact(row, ["id", "kind", "stationRef", "taskFamily", "processRef", "obligationIds"], `Process IR operation ${index}`, ["requiresBoundDie"]); const id = pattern(row.id, ID, `Process IR operation ${index} id`); if (seen.has(id)) throw new Error(`duplicate Process IR operation: ${id}`); seen.add(id); if (!KINDS.has(row.kind)) throw new Error(`unsupported Process IR operation kind: ${row.kind}`); if (Object.hasOwn(row, "requiresBoundDie") && typeof row.requiresBoundDie !== "boolean") throw new TypeError(`Process IR operation ${id} requiresBoundDie must be Boolean`); if (row.requiresBoundDie === true && row.kind !== "bounded-judgment") throw new Error(`non-model Process IR operation ${id} cannot require a bound die`); return { id, kind: row.kind, stationRef: text(row.stationRef, `Process IR operation ${id} stationRef`), taskFamily: pattern(row.taskFamily, TASK, `Process IR operation ${id} taskFamily`), processRef: row.processRef === null ? null : text(row.processRef, `Process IR operation ${id} processRef`), obligationIds: stringSet(row.obligationIds, `Process IR operation ${id} obligation`), ...(Object.hasOwn(row, "requiresBoundDie") ? { requiresBoundDie: row.requiresBoundDie } : {}) }; }); }
function normalizeEdges(value, operations) { if (!Array.isArray(value)) throw new TypeError("Process IR edges must be an array"); return value.map((row, index) => { exact(row, ["from", "out", "to", "in"], `Process IR edge ${index}`); const edge = { from: pattern(row.from, ID, `Process IR edge ${index} from`), out: pattern(row.out, ID, `Process IR edge ${index} out`), to: pattern(row.to, ID, `Process IR edge ${index} to`), in: pattern(row.in, ID, `Process IR edge ${index} in`) }; if (!operations.has(edge.from) || !operations.has(edge.to)) throw new Error(`Process IR edge ${index} references an unknown operation`); return edge; }); }
function normalizeObligations(value, operations) { if (!Array.isArray(value) || !value.length) throw new TypeError("Process IR proof obligations must be a non-empty array"); const seen = new Set(); return value.map((row, index) => { exact(row, ["id", "description", "gaugeOperationId"], `Process IR obligation ${index}`); const id = pattern(row.id, ID, `Process IR obligation ${index} id`); if (seen.has(id)) throw new Error(`duplicate Process IR obligation: ${id}`); seen.add(id); const gaugeOperationId = pattern(row.gaugeOperationId, ID, `Process IR obligation ${id} gaugeOperationId`); if (!operations.has(gaugeOperationId)) throw new Error(`Process IR obligation ${id} references unknown gauge operation: ${gaugeOperationId}`); return { id, description: text(row.description, `Process IR obligation ${id} description`), gaugeOperationId }; }); }
function normalizeRelease(value, operations, obligations) { exact(value, ["operationId", "outputPort", "obligationIds"], "Process IR release"); const operationId = pattern(value.operationId, ID, "Process IR release operationId"); if (!operations.has(operationId)) throw new Error(`Process IR release references unknown operation: ${operationId}`); const obligationIds = stringSet(value.obligationIds, "Process IR release obligation"); for (const id of obligationIds) if (!obligations.has(id)) throw new Error(`Process IR release references unknown obligation: ${id}`); return { operationId, outputPort: pattern(value.outputPort, ID, "Process IR release outputPort"), obligationIds }; }
function normalizeLayout(value, operations) { exact(value, ["direction", "operations"], "Process IR layout"); if (!Array.isArray(value.operations)) throw new TypeError("Process IR layout operations must be an array"); if (!new Set(["left-to-right", "top-to-bottom"]).has(value.direction)) throw new Error("Process IR layout has unsupported direction"); const seen = new Set(); const rows = value.operations.map((row, index) => { exact(row, ["id", "x", "y"], `Process IR layout operation ${index}`); const id = pattern(row.id, ID, `Process IR layout operation ${index} id`); if (!operations.has(id) || seen.has(id)) throw new Error(`Process IR layout contains unknown or duplicate operation: ${id}`); seen.add(id); return { id, x: nonnegative(row.x, `Process IR layout ${id} x`), y: nonnegative(row.y, `Process IR layout ${id} y`) }; }); if (seen.size !== operations.size) throw new Error("Process IR layout must position every operation"); return { direction: value.direction, operations: rows }; }
function normalizeWorkerResources(value) { if (!Array.isArray(value)) throw new TypeError("Process IR worker resources must be an array"); const map = new Map(); for (const [index, row] of value.entries()) { exact(row, ["workerRef", "condition", "slotsAvailable"], `worker resource ${index}`, ["stackRef"]); const workerRef = text(row.workerRef, `worker resource ${index} workerRef`); if (map.has(workerRef)) throw new Error(`duplicate Process IR worker resource: ${workerRef}`); if (!["available", "degraded", "unavailable"].includes(row.condition)) throw new Error(`invalid worker resource condition: ${row.condition}`); map.set(workerRef, { workerRef, condition: row.condition, slotsAvailable: nonnegative(row.slotsAvailable, `worker resource ${index} slotsAvailable`), stackRef: Object.hasOwn(row, "stackRef") ? text(row.stackRef, `worker resource ${index} stackRef`) : null }); } return map; }
function normalizeProcessControlEvidence(value) { if (!Array.isArray(value)) throw new TypeError("installed process control evidence must be an array"); const map = new Map(); for (const row of value) { const evidence = defineCognitiveProcessControlEvidence(row); if (map.has(evidence.ref)) throw new Error(`duplicate installed process control evidence: ${evidence.ref}`); map.set(evidence.ref, evidence); } return map; }
function verifyControlEvidence({ ref, expected, installed, trustedIssuers, linkedAt, diagnostics, operationId, missingCode, mismatchCode }) {
  const evidence = installed.get(ref);
  if (!evidence) { diagnostics.push(diag(missingCode, operationId, ref)); return; }
  if (!trustedIssuers.has(evidence.issuerRef)) diagnostics.push(diag("process-control-evidence-untrusted-issuer", operationId, evidence.issuerRef));
  if (Date.parse(evidence.observedAt) > Date.parse(linkedAt)) diagnostics.push(diag("process-control-evidence-not-yet-valid", operationId, ref));
  if (Date.parse(evidence.validUntil) <= Date.parse(linkedAt)) diagnostics.push(diag("process-control-evidence-expired", operationId, ref));
  for (const [field, expectedValue] of Object.entries(expected)) if (evidence[field] !== expectedValue) diagnostics.push(diag(mismatchCode, operationId, `${field}:${evidence[field]} != ${expectedValue}`));
}
function diag(code, operationId, detail) { return { code, operationId, detail: String(detail) }; }
function stripRef(value) { const copy = structuredClone(value); delete copy.ref; return copy; }
function exact(value, required, label, optional = []) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); const missing = required.filter((key) => !Object.hasOwn(value, key)); const allowed = new Set([...required, ...optional]); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); if (missing.length || unknown.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function stringSet(value, label) { if (!Array.isArray(value)) throw new TypeError(`${label}s must be an array`); const rows = value.map((item, index) => text(item, `${label} ${index}`)); if (new Set(rows).size !== rows.length) throw new Error(`${label}s must not contain duplicates`); return rows.sort(); }
function nullableText(value, label) { return value === null ? null : text(value, label); }
function pattern(value, regex, label) { const result = text(value, label); if (!regex.test(result)) throw new Error(`${label} has invalid format`); return result; }
function instant(value, label) { const result = text(value, label); if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO-8601 instant`); return new Date(result).toISOString(); }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function nonnegative(value, label) { if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`); return value; }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
