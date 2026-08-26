import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";
import { PredicateCartridgeRegistry, runPredicateCartridge } from "./predicate-cartridge.js";

const ID = /^[a-z][a-z0-9-]*$/;
const RELATION = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strict, content-addressed assembly drawing for cooperating cartridges. */
export function definePredicateCartridgeCell(value, { registry } = {}) {
  if (!(registry instanceof PredicateCartridgeRegistry)) throw new TypeError("predicate cartridge cell requires a PredicateCartridgeRegistry");
  const row = record(value, "predicate cartridge cell");
  const fields = ["schema", "kind", "id", "version", "title", "purpose", "nodes", "edges", "presentation"];
  exact(row, Object.hasOwn(row, "ref") ? [...fields, "ref"] : fields, "predicate cartridge cell");
  if (row.schema !== 1 || row.kind !== "bantam.factory-predicate-cartridge-cell") throw new Error("predicate cartridge cell must use schema 1");
  if (!Array.isArray(row.nodes) || !row.nodes.length) throw new Error("predicate cartridge cell nodes must not be empty");
  if (!Array.isArray(row.edges)) throw new TypeError("predicate cartridge cell edges must be an array");
  const nodes = unique(row.nodes.map((item, index) => {
    const node = record(item, `cartridge cell node ${index}`); exact(node, ["id", "cartridge"], `cartridge cell node ${index}`);
    const cartridgeRef = text(node.cartridge, `cartridge cell node ${index} cartridge`);
    const cartridge = registry.get(cartridgeRef);
    if (!cartridge) throw new Error(`cartridge cell node references an uninstalled cartridge: ${cartridgeRef}`);
    return { id: token(node.id, `cartridge cell node ${index} id`), cartridgeRef: cartridge.ref, cartridge };
  }), "id", "cartridge cell node");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = row.edges.map((item, index) => {
    const edge = record(item, `cartridge cell edge ${index}`); exact(edge, ["from", "predicate", "to", "source"], `cartridge cell edge ${index}`);
    const from = token(edge.from, `cartridge cell edge ${index} from`), to = token(edge.to, `cartridge cell edge ${index} to`);
    if (from === to || !byId.has(from) || !byId.has(to)) throw new Error(`cartridge cell edge ${index} references invalid nodes`);
    const predicate = relation(edge.predicate, `cartridge cell edge ${index} predicate`);
    const source = token(edge.source, `cartridge cell edge ${index} target source`);
    const producer = byId.get(from).cartridge, consumer = byId.get(to).cartridge;
    if (!producer.conclusions.some((conclusion) => conclusion.relation === predicate)) throw new Error(`cartridge cell edge ${index} predicate is not produced by ${from}: ${predicate}`);
    if (!consumer.sources.some((candidate) => candidate.name === source && candidate.lane === "derived")) throw new Error(`cartridge cell edge ${index} target source is not a derived input of ${to}: ${source}`);
    if (!consumer.loads.some((load) => load.source === source && load.pattern.a === "conclusion/predicate" && load.pattern.v === predicate)) {
      throw new Error(`cartridge cell edge ${index} has no exact predicate intake at ${to}.${source}`);
    }
    return { from, predicate, to, source };
  });
  topological(nodes, edges);
  const normalized = {
    schema: 1,
    kind: row.kind,
    id: token(row.id, "predicate cartridge cell id"),
    version: positive(row.version, "predicate cartridge cell version"),
    title: text(row.title, "predicate cartridge cell title"),
    purpose: text(row.purpose, "predicate cartridge cell purpose"),
    nodes: nodes.map(({ id, cartridgeRef }) => ({ id, cartridge: cartridgeRef })),
    edges,
    presentation: normalizePresentation(row.presentation),
  };
  const ref = `predicate-cartridge-cell:${normalized.id}@${normalized.version}:sha256:${digest(normalized)}`;
  if (Object.hasOwn(row, "ref") && row.ref !== ref) throw new Error("predicate cartridge cell content hash does not match");
  return deepFreeze({ ...normalized, ref });
}

export function runPredicateCartridgeCell({ cell: value, registry, bus } = {}) {
  const cell = definePredicateCartridgeCell(value, { registry });
  if (!bus || typeof bus.activeLot !== "function") throw new TypeError("predicate cartridge cell requires a FactBus-compatible bus");
  const evaluations = [];
  for (const nodeId of topological(cell.nodes, cell.edges)) {
    const node = cell.nodes.find((candidate) => candidate.id === nodeId);
    const cartridge = registry.get(node.cartridge);
    evaluations.push({ nodeId, evaluation: runPredicateCartridge({ cartridge, bus }) });
  }
  const projection = projectPredicateCartridgeCell(cell, { registry, bus });
  const body = {
    schema: "bantam.factory.predicate-cartridge-cell-run.v1",
    kind: "bantam.factory-predicate-cartridge-cell-run",
    cellRef: cell.ref,
    busBasis: bus.basis(),
    evaluations,
    projection,
  };
  return deepFreeze({ ...body, artifactId: `predicate-cartridge-cell-run:sha256:${digest(body)}` });
}

/** Backend-owned topology and current state for a 1:1 visual projection. */
export function projectPredicateCartridgeCell(value, { registry, bus } = {}) {
  const cell = definePredicateCartridgeCell(value, { registry });
  const nodes = cell.nodes.map((node) => {
    const cartridge = registry.get(node.cartridge), active = bus.activeLot(cartridge.ref);
    return {
      id: node.id,
      cartridgeRef: cartridge.ref,
      title: cartridge.title,
      purpose: cartridge.purpose,
      presentation: cartridge.presentation,
      state: active ? (active.conclusions.length ? "produced" : "clear") : "idle",
      activeLotId: active?.lotId ?? null,
      productCount: active?.conclusions.length ?? 0,
    };
  });
  const body = {
    schema: "bantam.factory.predicate-cartridge-cell-projection.v1",
    kind: "bantam.factory-predicate-cartridge-cell-projection",
    authority: "observe-only",
    cellRef: cell.ref,
    busBasis: bus.basis(),
    nodes,
    edges: cell.edges.map((edge) => ({ ...edge, materialType: `predicate:${edge.predicate}` })),
  };
  return deepFreeze({ ...body, projectionId: `predicate-cartridge-cell-projection:sha256:${digest(body)}` });
}

function topological(nodes, edges) {
  const indegree = new Map(nodes.map((node) => [node.id, 0])), outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) { indegree.set(edge.to, indegree.get(edge.to) + 1); outgoing.get(edge.from).push(edge.to); }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id).sort(), order = [];
  while (ready.length) { const id = ready.shift(); order.push(id); for (const target of outgoing.get(id).sort()) { const next = indegree.get(target) - 1; indegree.set(target, next); if (next === 0) ready.push(target); } ready.sort(); }
  if (order.length !== nodes.length) throw new Error("predicate cartridge cell contains a production cycle");
  return order;
}
function normalizePresentation(value) { const row = record(value, "cartridge cell presentation"); exact(row, ["group", "icon", "color"], "cartridge cell presentation"); return { group: token(row.group, "cell presentation group"), icon: token(row.icon, "cell presentation icon"), color: token(row.color, "cell presentation color") }; }
function unique(rows, key, label) { const seen = new Set(); for (const row of rows) { if (seen.has(row[key])) throw new Error(`duplicate ${label}: ${row[key]}`); seen.add(row[key]); } return rows; }
function relation(value, label) { const result = text(value, label); if (!RELATION.test(result)) throw new Error(`${label} has an invalid format: ${result}`); return result; }
function token(value, label) { const result = text(value, label); if (!ID.test(result)) throw new Error(`${label} has an invalid format: ${result}`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); return value; }
function exact(value, fields, label) { const allowed = new Set(fields), unknown = Object.keys(value).filter((key) => !allowed.has(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
