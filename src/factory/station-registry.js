import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";

const STATION_KIND = "bantam.factory-station";
const STATION_ID = /^[a-z][a-z0-9-]*$/;
const ARTIFACT_TYPE = /^[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;
const CAPABILITY = /^[a-z][a-z0-9._:-]*$/;
const WORKER_KINDS = new Set(["model", "tool", "human", "composite"]);
const DISPOSITIONS = new Set([
  "released",
  "rework",
  "blocked",
  "contained",
  "scrapped",
  "infrastructure",
]);

export function defineStationAsset(value) {
  const source = requireRecord(value, "station asset");
  const commonKeys = [
    "schema",
    "kind",
    "id",
    "version",
    "title",
    "purpose",
    "worker",
    "inputs",
    "outputs",
    "capabilities",
    "authority",
    "gauge",
    "dispositions",
    "presentation",
  ];
  if (source.schema === 1) requireExactKeys(source, commonKeys, "station asset");
  else if (source.schema === 2) requireExactKeys(source, [...commonKeys, "standardWork"], "station asset");
  else throw new Error("station asset must use bantam.factory-station schema 1 or 2");
  if (source.kind !== STATION_KIND) {
    throw new Error("station asset kind must be bantam.factory-station");
  }
  const id = requirePattern(source.id, STATION_ID, "station id");
  const version = requirePositiveInteger(source.version, "station version");
  const worker = normalizeWorker(source.worker);
  const inputs = normalizePorts(source.inputs, "input");
  const outputs = normalizePorts(source.outputs, "output");
  const capabilities = normalizeStringSet(source.capabilities, CAPABILITY, "capability");
  const authority = normalizeStringSet(source.authority, CAPABILITY, "authority");
  const gauge = normalizeGauge(source.gauge);
  const dispositions = normalizeDispositions(source.dispositions);
  const presentation = normalizePresentation(source.presentation);
  const asset = {
    schema: source.schema,
    kind: STATION_KIND,
    id,
    version,
    title: requireString(source.title, "station title"),
    purpose: requireString(source.purpose, "station purpose"),
    worker,
    inputs,
    outputs,
    capabilities,
    authority,
    gauge,
    dispositions,
    presentation,
    ...(source.schema === 2 ? { standardWork: normalizeStandardWork(source.standardWork) } : {}),
  };
  const ref = stationAssetRef(asset);
  return deepFreeze({ ...asset, ref });
}

function normalizeStandardWork(value) {
  const work = requireRecord(value, "station standard work");
  requireExactKeys(work, ["operation", "instructions", "fixtures", "prohibited", "releaseCriteria"], "station standard work");
  return {
    operation: requireString(work.operation, "standard work operation"),
    instructions: normalizeTextList(work.instructions, "standard work instruction", { required: true }),
    fixtures: normalizeTextList(work.fixtures, "standard work fixture", { required: true }),
    prohibited: normalizeTextList(work.prohibited, "standard work prohibition"),
    releaseCriteria: normalizeTextList(work.releaseCriteria, "standard work release criterion", { required: true }),
  };
}

function normalizeTextList(value, label, { required = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label}s must be an array`);
  const rows = [...new Set(value.map((entry) => requireString(entry, label)))];
  if (required && rows.length === 0) throw new Error(`${label}s must not be empty`);
  return rows;
}

export function stationAssetRef(asset) {
  const body = { ...asset };
  delete body.ref;
  return `station:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`;
}

export class StationRegistry {
  constructor() {
    this.assets = new Map();
  }

  install(value) {
    const asset = defineStationAsset(value);
    const key = `${asset.id}@${asset.version}`;
    const existing = this.assets.get(key);
    if (existing && existing.ref !== asset.ref) {
      throw new Error(`station ${key} is already installed with different bytes`);
    }
    if (existing) return existing;
    this.assets.set(key, asset);
    return asset;
  }

  get(reference) {
    if (typeof reference !== "string") return null;
    if (reference.startsWith("station:")) {
      return [...this.assets.values()].find((asset) => asset.ref === reference) ?? null;
    }
    return this.assets.get(reference) ?? null;
  }

  list() {
    return [...this.assets.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  }

  validateRoute(route, { authority = [] } = {}) {
    return validateFactoryRoute(route, { registry: this, authority });
  }
}

export function validateFactoryRoute(value, { registry, authority = [] } = {}) {
  if (!(registry instanceof StationRegistry)) throw new TypeError("factory route requires a StationRegistry");
  const route = requireRecord(value, "factory route");
  requireExactKeys(route, ["schema", "kind", "id", "stations", "edges"], "factory route");
  if (route.schema !== 1 || route.kind !== "bantam.factory-route") {
    throw new Error("factory route must use bantam.factory-route schema 1");
  }
  const routeId = requirePattern(route.id, STATION_ID, "route id");
  if (!Array.isArray(route.stations) || route.stations.length === 0) {
    throw new Error("factory route requires at least one station");
  }
  if (!Array.isArray(route.edges)) throw new Error("factory route edges must be an array");
  const granted = new Set(normalizeStringSet(authority, CAPABILITY, "route authority"));
  const stations = route.stations.map((row, index) => normalizeRouteStation(row, index, registry, granted));
  const byId = new Map();
  for (const station of stations) {
    if (byId.has(station.id)) throw new Error(`duplicate route station id: ${station.id}`);
    byId.set(station.id, station);
  }
  const edges = route.edges.map((edge, index) => normalizeRouteEdge(edge, index, byId));
  validatePortCoverage(stations, edges);
  validateAcyclic(stations, edges);
  const normalized = {
    schema: 1,
    kind: "bantam.factory-route",
    id: routeId,
    stations: stations.map(({ asset, ...station }) => ({ ...station, stationRef: asset.ref })),
    edges,
  };
  return deepFreeze({ ...normalized, ref: `route:${routeId}:sha256:${sha256(canonicalJson(normalized))}` });
}

function normalizeRouteStation(value, index, registry, granted) {
  const row = requireRecord(value, `route station ${index}`);
  requireExactKeys(row, ["id", "station"], `route station ${index}`);
  const id = requirePattern(row.id, STATION_ID, `route station ${index} id`);
  const reference = requireString(row.station, `route station ${id} reference`);
  const asset = registry.get(reference);
  if (!asset) throw new Error(`route station ${id} references an uninstalled station: ${reference}`);
  const missingAuthority = asset.authority.filter((entry) => !granted.has(entry));
  if (missingAuthority.length) {
    throw new Error(`route station ${id} requires ungranted authority: ${missingAuthority.join(", ")}`);
  }
  return { id, asset };
}

function normalizeRouteEdge(value, index, byId) {
  const edge = requireRecord(value, `route edge ${index}`);
  requireExactKeys(edge, ["from", "out", "to", "in"], `route edge ${index}`);
  const from = requirePattern(edge.from, STATION_ID, `route edge ${index} from`);
  const to = requirePattern(edge.to, STATION_ID, `route edge ${index} to`);
  if (from === to) throw new Error(`route edge ${index} cannot connect a station to itself`);
  const source = byId.get(from);
  const target = byId.get(to);
  if (!source || !target) throw new Error(`route edge ${index} references an unknown station`);
  const out = requirePattern(edge.out, STATION_ID, `route edge ${index} output`);
  const input = requirePattern(edge.in, STATION_ID, `route edge ${index} input`);
  const outputPort = source.asset.outputs.find((port) => port.name === out);
  const inputPort = target.asset.inputs.find((port) => port.name === input);
  if (!outputPort) throw new Error(`route edge ${index} references missing output ${from}.${out}`);
  if (!inputPort) throw new Error(`route edge ${index} references missing input ${to}.${input}`);
  if (outputPort.artifactType !== inputPort.artifactType) {
    throw new Error(`route edge ${index} type mismatch: ${outputPort.artifactType} -> ${inputPort.artifactType}`);
  }
  return { from, out, to, in: input, artifactType: outputPort.artifactType };
}

function validatePortCoverage(stations, edges) {
  const incoming = new Set(edges.map((edge) => `${edge.to}.${edge.in}`));
  for (const station of stations) {
    for (const port of station.asset.inputs) {
      if (port.required && !incoming.has(`${station.id}.${port.name}`)) {
        throw new Error(`required route input is unconnected: ${station.id}.${port.name}`);
      }
    }
  }
  const destinations = new Set();
  for (const edge of edges) {
    const key = `${edge.to}.${edge.in}`;
    if (destinations.has(key)) throw new Error(`route input has multiple producers: ${key}`);
    destinations.add(key);
  }
}

function validateAcyclic(stations, edges) {
  const indegree = new Map(stations.map((station) => [station.id, 0]));
  const outgoing = new Map(stations.map((station) => [station.id, []]));
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift();
    visited += 1;
    for (const target of outgoing.get(id)) {
      const next = indegree.get(target) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== stations.length) throw new Error("factory route contains a production cycle");
}

function normalizePorts(value, label) {
  if (!Array.isArray(value)) throw new Error(`station ${label}s must be an array`);
  const names = new Set();
  return value.map((entry, index) => {
    const port = requireRecord(entry, `${label} port ${index}`);
    requireExactKeys(port, ["name", "artifactType", "required"], `${label} port ${index}`);
    const name = requirePattern(port.name, STATION_ID, `${label} port ${index} name`);
    if (names.has(name)) throw new Error(`duplicate ${label} port: ${name}`);
    names.add(name);
    return {
      name,
      artifactType: requirePattern(port.artifactType, ARTIFACT_TYPE, `${label} port ${name} artifact type`),
      required: port.required === true,
    };
  });
}

function normalizeWorker(value) {
  const worker = requireRecord(value, "station worker");
  requireExactKeys(worker, ["kind", "adapter"], "station worker");
  if (!WORKER_KINDS.has(worker.kind)) throw new Error(`unsupported station worker kind: ${worker.kind}`);
  return { kind: worker.kind, adapter: requireString(worker.adapter, "station worker adapter") };
}

function normalizeGauge(value) {
  const gauge = requireRecord(value, "station gauge");
  requireExactKeys(gauge, ["id", "version", "independent"], "station gauge");
  return {
    id: requirePattern(gauge.id, STATION_ID, "gauge id"),
    version: requirePositiveInteger(gauge.version, "gauge version"),
    independent: gauge.independent === true,
  };
}

function normalizePresentation(value) {
  const presentation = requireRecord(value, "station presentation");
  requireExactKeys(presentation, ["group", "icon", "color"], "station presentation");
  return {
    group: requireString(presentation.group, "station presentation group"),
    icon: requireString(presentation.icon, "station presentation icon"),
    color: requireString(presentation.color, "station presentation color"),
  };
}

function normalizeDispositions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("station dispositions must be a non-empty array");
  const normalized = [...new Set(value.map((entry) => requireString(entry, "station disposition")))].sort();
  for (const entry of normalized) {
    if (!DISPOSITIONS.has(entry)) throw new Error(`unsupported station disposition: ${entry}`);
  }
  if (!normalized.includes("released")) throw new Error("station dispositions must include released");
  return normalized;
}

function normalizeStringSet(value, pattern, label) {
  if (!Array.isArray(value)) throw new Error(`${label}s must be an array`);
  return [...new Set(value.map((entry) => requirePattern(entry, pattern, label)))].sort();
}

function requireExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length || missing.length) {
    throw new Error(`${label} keys are invalid; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`);
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requirePattern(value, pattern, label) {
  const text = requireString(value, label);
  if (!pattern.test(text)) throw new Error(`${label} has an invalid format: ${text}`);
  return text;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
