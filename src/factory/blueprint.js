// Portable factory definition. The same content-addressed JSON compiles the
// execution route and feeds the visual projection; adapters remain installed
// plant machinery referenced by stable IDs in station assets.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "../journal.js";
import { FactoryLineController } from "./line-controller.js";
import { StationRegistry, defineStationAsset } from "./station-registry.js";
import { projectFactorySupervisor } from "./traveler.js";

const BLUEPRINT_KIND = "bantam.factory-blueprint";
const ID = /^[a-z][a-z0-9-]*$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BLUEPRINT_REF = /^blueprint:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/;
const DIRECTIONS = new Set(["left-to-right", "top-to-bottom"]);

export function defineFactoryBlueprint(value) {
  const source = record(value, "factory blueprint");
  const fields = ["schema", "kind", "id", "version", "title", "taskFamily", "routeId", "authority", "stations", "edges", "layout"];
  exact(source, Object.hasOwn(source, "ref") ? [...fields, "ref"] : fields, "factory blueprint");
  if (source.schema !== 1 || source.kind !== BLUEPRINT_KIND) throw new Error(`factory blueprint must use ${BLUEPRINT_KIND} schema 1`);
  if (!Array.isArray(source.stations) || source.stations.length === 0) throw new Error("factory blueprint requires stations");
  if (!Array.isArray(source.edges)) throw new Error("factory blueprint edges must be an array");
  const stationIds = new Set();
  const stations = source.stations.map((entry, index) => {
    const row = record(entry, `factory blueprint station ${index}`);
    const hasTaskFamily = Object.hasOwn(row, "taskFamily");
    exact(row, hasTaskFamily ? ["id", "asset", "taskFamily"] : ["id", "asset"], `factory blueprint station ${index}`);
    const id = pattern(row.id, ID, `factory blueprint station ${index} id`);
    if (stationIds.has(id)) throw new Error(`duplicate factory blueprint station id: ${id}`);
    stationIds.add(id);
    const asset = defineStationAsset(row.asset);
    return { id, asset: stripRef(asset), ...(hasTaskFamily ? { taskFamily: pattern(row.taskFamily, ID, `factory blueprint station ${index} task family`) } : {}) };
  });
  const edges = source.edges.map((entry, index) => {
    const row = record(entry, `factory blueprint edge ${index}`);
    exact(row, ["from", "out", "to", "in"], `factory blueprint edge ${index}`);
    return {
      from: pattern(row.from, ID, `factory blueprint edge ${index} source`),
      out: pattern(row.out, ID, `factory blueprint edge ${index} output`),
      to: pattern(row.to, ID, `factory blueprint edge ${index} destination`),
      in: pattern(row.in, ID, `factory blueprint edge ${index} input`),
    };
  });
  const layout = normalizeLayout(source.layout, stationIds);
  const body = {
    schema: 1,
    kind: BLUEPRINT_KIND,
    id: pattern(source.id, ID, "factory blueprint id"),
    version: positiveInteger(source.version, "factory blueprint version"),
    title: text(source.title, "factory blueprint title"),
    taskFamily: pattern(source.taskFamily, ID, "factory blueprint task family"),
    routeId: pattern(source.routeId, ID, "factory blueprint route id"),
    authority: stringSet(source.authority, "factory blueprint authority"),
    stations,
    edges,
    layout,
  };
  const ref = blueprintRef(body);
  if (Object.hasOwn(source, "ref") && source.ref !== ref) throw new Error("factory blueprint content hash does not match");
  return deepFreeze({ ...body, ref });
}

export function blueprintRef(value) {
  const body = { ...value };
  delete body.ref;
  return `blueprint:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`;
}

export function compileFactoryBlueprint(value) {
  const blueprint = defineFactoryBlueprint(value);
  const registry = new StationRegistry();
  const assets = {};
  for (const station of blueprint.stations) assets[station.id] = registry.install(station.asset);
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: blueprint.routeId,
    stations: blueprint.stations.map((station) => ({ id: station.id, station: assets[station.id].ref })),
    edges: blueprint.edges,
  }, { authority: blueprint.authority });
  return deepFreeze({
    schema: 1,
    kind: "bantam.compiled-factory-blueprint",
    blueprint,
    registry,
    route,
    assets,
  }, { skip: new Set([registry]) });
}

export function loadFactoryBlueprint(file) {
  const source = path.resolve(text(file, "factory blueprint file"));
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch (error) { throw new Error(`cannot read factory blueprint ${source}: ${error.message}`); }
  return compileFactoryBlueprint(parsed);
}

export async function runFactoryBlueprint({
  compiled,
  root,
  jobId,
  task = "",
  initialProductRevision,
  adapters,
  gauges,
  workspaceLabel = null,
  rework = {},
  signal = null,
  time,
} = {}) {
  const plant = requireCompiled(compiled);
  const controller = new FactoryLineController({
    root,
    jobId,
    task,
    taskFamily: plant.blueprint.taskFamily,
    initialProductRevision,
    route: plant.route,
    registry: plant.registry,
    authority: plant.blueprint.authority,
    adapters,
    gauges,
    workspaceLabel,
    rework,
    blueprint: plant.blueprint,
  });
  return controller.run({ signal, time });
}

export function projectFactoryBlueprint(compiled, { events = null } = {}) {
  const plant = requireCompiled(compiled);
  if (events !== null) {
    if (!Array.isArray(events)) throw new Error("live factory blueprint projection requires traveler events");
    const loaded = events.find((event) => event.type === "blueprint.loaded");
    if (!loaded) throw new Error("traveler does not record a factory blueprint");
    if (loaded.payload.blueprintRef !== plant.blueprint.ref || loaded.payload.routeRef !== plant.route.ref) throw new Error("traveler factory blueprint does not match the loaded definition");
  }
  const supervisor = events === null ? null : projectFactorySupervisor(events);
  const attempts = new Map();
  for (const row of supervisor?.stations ?? []) if (row.routeStationId) attempts.set(row.routeStationId, row);
  const positions = new Map(plant.blueprint.layout.stations.map((row) => [row.id, row]));
  const nodes = plant.route.stations.map((station) => {
    const asset = plant.assets[station.id];
    const attempt = attempts.get(station.id) ?? null;
    return {
      id: station.id,
      stationRef: asset.ref,
      title: asset.title,
      purpose: asset.purpose,
      workerKind: asset.worker.kind,
      adapter: asset.worker.adapter,
      taskFamily: plant.blueprint.stations.find((row) => row.id === station.id)?.taskFamily ?? plant.blueprint.taskFamily,
      capabilities: asset.capabilities,
      authority: asset.authority,
      standardWork: asset.standardWork ?? null,
      presentation: asset.presentation,
      position: positions.get(station.id),
      state: attempt?.state ?? "planned",
      stationAttempt: attempt?.stationAttempt ?? null,
      gaugeStatus: attempt?.gaugeStatus ?? null,
    };
  });
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-blueprint-projection",
    blueprintRef: plant.blueprint.ref,
    routeRef: plant.route.ref,
    title: plant.blueprint.title,
    taskFamily: plant.blueprint.taskFamily,
    authority: plant.blueprint.authority,
    direction: plant.blueprint.layout.direction,
    nodes,
    edges: plant.route.edges.map((edge) => ({ ...edge })),
    live: events !== null,
    jobId: supervisor?.jobId ?? null,
    status: supervisor?.status ?? null,
  });
}

export function projectRecordedFactoryBlueprint(store, events) {
  if (!store || typeof store.getEvidence !== "function") throw new Error("recorded factory blueprint projection requires an evidence store");
  if (!Array.isArray(events)) throw new Error("recorded factory blueprint projection requires traveler events");
  const loaded = events.find((event) => event.type === "blueprint.loaded");
  if (!loaded) throw new Error("traveler does not record a factory blueprint");
  const definition = store.getEvidence(loaded.payload.artifactRef);
  const compiled = compileFactoryBlueprint(definition);
  if (compiled.blueprint.ref !== loaded.payload.blueprintRef || compiled.route.ref !== loaded.payload.routeRef) {
    throw new Error("recorded factory blueprint artifact does not match its traveler binding");
  }
  return projectFactoryBlueprint(compiled, { events });
}

export function formatFactoryBlueprint(projection) {
  if (!projection || projection.kind !== "bantam.factory-blueprint-projection") throw new Error("factory blueprint formatter requires a projection");
  const lines = [
    `BANTAMFACTORY BLUEPRINT  ${projection.title}`,
    `blueprint ${projection.blueprintRef}`,
    `route     ${projection.routeRef}`,
    `family    ${projection.taskFamily}`,
    `authority ${projection.authority.join(", ") || "none"}`,
    "",
  ];
  for (const node of projection.nodes) lines.push(`${node.state.toUpperCase().padEnd(10)} ${node.id.padEnd(18)} ${node.workerKind.padEnd(9)} ${node.title}`);
  lines.push("", "MATERIAL FLOW");
  for (const edge of projection.edges) lines.push(`${edge.from}.${edge.out} -> ${edge.to}.${edge.in}  ${edge.artifactType}`);
  return lines.join("\n");
}

export function renderFactoryBlueprint(projection) {
  if (!projection || projection.kind !== "bantam.factory-blueprint-projection") throw new Error("factory blueprint renderer requires a projection");
  const data = safeScriptJson(projection);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(projection.title)} · BANTAMFACTORY</title><style>
:root{color-scheme:dark;--gold:#e7bb5b;--ink:#f0e4c4;--muted:#827c69;--edge:#454638;--green:#81d56d;--red:#ed6c53;--blue:#74a9ba}*{box-sizing:border-box}body{margin:0;background:#090b09;color:var(--ink);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}header{display:flex;align-items:center;gap:18px;padding:18px 24px;border-bottom:1px solid #5a4d32;background:#0d100d}h1{margin:0;color:#edcb83;font:800 19px system-ui,sans-serif;letter-spacing:.08em}header span{color:var(--muted)}main{display:grid;grid-template-columns:minmax(700px,1fr) 340px;gap:12px;padding:12px}.panel{border:1px solid var(--edge);border-radius:5px;background:#11140f;overflow:hidden}.panel h2{margin:0;padding:10px 13px;border-bottom:1px solid #34362e;color:#b8aa82;font:800 9px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase}.canvas{position:relative;min-height:620px;overflow:auto;background:radial-gradient(circle at 50% 0,#3b3322,transparent 45%),repeating-linear-gradient(0deg,transparent 0 39px,#24271f 40px),repeating-linear-gradient(90deg,transparent 0 39px,#24271f 40px)}svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.flow{stroke:#7d6938;stroke-width:5;fill:none}.station{position:absolute;width:230px;min-height:145px;padding:12px;border:1px solid #555544;border-left:4px solid var(--blue);border-radius:4px;background:linear-gradient(145deg,#22261f,#10130f);box-shadow:6px 7px #060806;cursor:pointer}.station.model{border-left-color:var(--gold)}.station.released{border-left-color:var(--green)}.station.fail,.station.blocked,.station.contained,.station.infrastructure{border-left-color:var(--red)}.station b{display:block;color:#f0d28a;font:800 13px system-ui,sans-serif}.station small{display:block;color:var(--muted)}.state{margin:9px 0;color:#bcb397;text-transform:uppercase}.ports{font-size:9px;color:#7f7968;line-height:1.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.inspector{padding:14px;white-space:pre-wrap;overflow-wrap:anywhere}.inspector b{color:var(--gold)}.meta{padding:10px 13px;color:var(--muted);border-top:1px solid #34362e;overflow-wrap:anywhere}@media(max-width:1050px){main{grid-template-columns:1fr}.canvas{min-height:700px}}
</style></head><body><header><div>🐔</div><h1>${html(projection.title)}</h1><span>${html(projection.taskFamily)} · ${projection.live ? `LIVE ${html(projection.jobId)}` : "BLUEPRINT"}</span></header><main><section class="panel"><h2>Executable factory layout</h2><div class="canvas" id="canvas"></div><div class="meta">Blueprint ${html(projection.blueprintRef)}<br>Route ${html(projection.routeRef)}</div></section><aside class="panel"><h2>Station inspector</h2><div class="inspector" id="inspector">Select a station.</div></aside></main><script id="blueprint" type="application/json">${data}</script><script>
'use strict';const P=JSON.parse(document.getElementById('blueprint').textContent),C=document.getElementById('canvas'),I=document.getElementById('inspector');const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),short=v=>String(v??'').length>39?String(v).slice(0,21)+'…'+String(v).slice(-15):String(v??'');const scale=280,offset=35;const point=n=>({x:offset+n.position.x*scale,y:offset+n.position.y*190});const byId=new Map(P.nodes.map(n=>[n.id,n]));const svg='<svg>'+P.edges.map(e=>{const a=point(byId.get(e.from)),b=point(byId.get(e.to));return '<path class="flow" d="M '+(a.x+230)+' '+(a.y+72)+' C '+(a.x+260)+' '+(a.y+72)+', '+(b.x-30)+' '+(b.y+72)+', '+b.x+' '+(b.y+72)+'"><title>'+esc(e.artifactType)+'</title></path>'}).join('')+'</svg>';C.innerHTML=svg+P.nodes.map(n=>{const p=point(n);return '<article class="station '+esc(n.workerKind)+' '+esc(n.state)+'" data-id="'+esc(n.id)+'" style="left:'+p.x+'px;top:'+p.y+'px"><b>'+esc(n.title)+'</b><small>'+esc(n.id)+' · '+esc(n.workerKind)+'</small><div class="state">'+esc(n.state)+'</div><div class="ports" title="'+esc(n.adapter+' | '+n.stationRef)+'">'+esc(short(n.adapter))+'<br>'+esc(short(n.stationRef))+'</div></article>'}).join('');C.style.minWidth=(Math.max(...P.nodes.map(n=>point(n).x))+300)+'px';C.style.minHeight=(Math.max(...P.nodes.map(n=>point(n).y))+220)+'px';C.addEventListener('click',e=>{const card=e.target.closest('[data-id]');if(!card)return;const n=byId.get(card.dataset.id);I.innerHTML='<b>'+esc(n.title)+'</b><br><br>'+esc(n.purpose)+'<br><br>STATE&nbsp;&nbsp;'+esc(n.state)+'<br>WORKER '+esc(n.workerKind)+'<br>TASK FAMILY '+esc(n.taskFamily)+'<br>ADAPTER '+esc(n.adapter)+'<br>STATION '+esc(n.stationRef)+'<br>AUTHORITY '+esc(n.authority.join(', ')||'none')+'<br>CAPABILITIES '+esc(n.capabilities.join(', ')||'none')+'<br><br>STANDARD WORK<br>'+esc(n.standardWork?JSON.stringify(n.standardWork,null,2):'not recorded')});
</script></body></html>`;
}

export function writeFactoryBlueprintReport(file, projection) {
  const target = path.resolve(text(file, "factory blueprint report output"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try { fs.writeFileSync(temporary, renderFactoryBlueprint(projection), { mode: 0o600 }); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
  return target;
}

function requireCompiled(value) {
  if (!value || value.kind !== "bantam.compiled-factory-blueprint" || !value.blueprint || !value.route || !(value.registry instanceof StationRegistry)) throw new Error("compiled factory blueprint is required");
  if (!BLUEPRINT_REF.test(value.blueprint.ref) || blueprintRef(value.blueprint) !== value.blueprint.ref) throw new Error("compiled factory blueprint identity is invalid");
  return value;
}

function normalizeLayout(value, stationIds) {
  const row = record(value, "factory blueprint layout");
  exact(row, ["direction", "stations"], "factory blueprint layout");
  if (!DIRECTIONS.has(row.direction)) throw new Error(`unsupported factory blueprint layout direction: ${row.direction}`);
  if (!Array.isArray(row.stations)) throw new Error("factory blueprint layout stations must be an array");
  const seen = new Set();
  const stations = row.stations.map((entry, index) => {
    const position = record(entry, `factory blueprint layout station ${index}`);
    exact(position, ["id", "x", "y"], `factory blueprint layout station ${index}`);
    const id = pattern(position.id, ID, `factory blueprint layout station ${index} id`);
    if (!stationIds.has(id)) throw new Error(`factory blueprint layout references unknown station: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate factory blueprint layout station: ${id}`);
    seen.add(id);
    return { id, x: coordinate(position.x, `${id} x`), y: coordinate(position.y, `${id} y`) };
  });
  const missing = [...stationIds].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`factory blueprint layout omits stations: ${missing.join(", ")}`);
  return { direction: row.direction, stations };
}

function stripRef(asset) { const { ref: ignored, ...body } = asset; return body; }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exact(value, keys, label) { const allowed = new Set(keys); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); const missing = keys.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`); }
function text(value, label) { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function pattern(value, regex, label) { const result = text(value, label); if (!regex.test(result)) throw new Error(`invalid ${label}: ${result}`); return result; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`); return number; }
function coordinate(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 0 || number > 1000) throw new Error(`factory blueprint coordinate ${label} must be an integer from 0 to 1000`); return number; }
function stringSet(value, label) { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return [...new Set(value.map((entry) => pattern(entry, TOKEN, label)))].sort(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeScriptJson(value) { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function html(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function deepFreeze(value, { skip = new Set() } = {}) { if (!value || typeof value !== "object" || Object.isFrozen(value) || skip.has(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child, { skip }); return value; }
