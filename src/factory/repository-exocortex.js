import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";
import { PredicateCartridgeRegistry } from "./predicate-cartridge.js";

const PRIORITY = Object.freeze({
  release_blocked_stale_authority: 100,
  release_blocked_stale_evidence: 100,
  stale_verification_evidence: 90,
  verification_work_order: 80,
  requirement_affected: 70,
  release_ready: 60,
  current_verification_evidence: 50,
  affected_test: 40,
  affected_by_change: 30,
});

/**
 * Compile durable repository cognition into a bounded worker shift packet.
 *
 * This is intentionally read-only. It gives a worker buttons and proof, but it
 * neither executes the buttons nor converts a semantic disposition into
 * mutation or release authority.
 */
export function compileRepositoryShiftPacket({
  task,
  bus,
  registry,
  cell,
  focus = {},
  limits = {},
} = {}) {
  requireBus(bus);
  if (!(registry instanceof PredicateCartridgeRegistry)) throw new TypeError("repository shift packet requires a PredicateCartridgeRegistry");
  const drawing = requireCell(cell);
  const goal = text(task, "repository shift task");
  const scope = normalizeFocus(focus);
  const budget = normalizeLimits(limits);
  const products = collectProducts({ bus, registry, cell: drawing, scope });
  const selected = products.slice(0, budget.maxProducts).map((product) => compactProduct(product, budget));
  const omitted = products.slice(selected.length);
  const buttons = buildButtons(selected);
  const andons = buildAndons(selected);
  const fingerprint = currentFingerprint(bus);
  const body = {
    schema: "bantam.factory.repository-shift-packet.v1",
    kind: "bantam.factory-repository-shift-packet",
    authority: "observe-and-propose-only",
    task: goal,
    cellRef: drawing.ref,
    chassis: { repositoryFingerprint: fingerprint, busBasis: bus.basis() },
    focus: scope,
    limits: budget,
    summary: {
      availableProducts: products.length,
      admittedProducts: selected.length,
      omittedProducts: omitted.length,
      buttons: buttons.length,
      andons: andons.length,
      releaseDisposition: disposition(selected),
    },
    andons,
    buttons,
    products: selected,
    omissions: omissionSummary(omitted),
    stopConditions: [
      "Do not treat a proposed button as executed work.",
      "Do not treat release_ready as deployment authority.",
      "Stop and refresh this packet if the repository fingerprint changes.",
      "Escalate when required proof is omitted or no qualified station owns the next operation.",
    ],
  };
  const briefing = renderRepositoryShiftBriefing(body);
  const packet = {
    ...body,
    estimatedTokens: Math.ceil(briefing.length / 4),
    briefing,
  };
  return deepFreeze({ ...packet, packetId: `repository-shift-packet:sha256:${digest(packet)}` });
}

/** Human/model-readable projection generated from the same packet as the UI. */
export function renderRepositoryShiftBriefing(packet) {
  if (!packet || packet.schema !== "bantam.factory.repository-shift-packet.v1") throw new TypeError("repository shift briefing requires a shift packet body");
  const lines = [
    `# BANTAMFACTORY shift packet`,
    `Task: ${packet.task}`,
    `Chassis: ${packet.chassis.repositoryFingerprint ?? "unknown"}`,
    `Disposition: ${packet.summary.releaseDisposition}`,
    `Authority: ${packet.authority}`,
    "",
    "## Andons",
    ...(packet.andons.length ? packet.andons.map((row) => `- [${row.severity}] ${row.message}`) : ["- none"]),
    "",
    "## Available buttons",
    ...(packet.buttons.length ? packet.buttons.map((row) => `- ${row.label} | station=${row.station} | authority=${row.authority} | material=${canonicalEncode(row.material)}`) : ["- none; supervisor routing required"]),
    "",
    "## Admitted semantic products",
    ...packet.products.map((row) => `- ${row.predicate} @ ${row.station}: ${canonicalEncode(row.tuple)} | dependencies=${row.dependencies.length}/${row.dependencyCount}`),
    "",
    `Omitted products: ${packet.omissions.count}`,
    ...packet.stopConditions.map((condition) => `STOP: ${condition}`),
  ];
  return `${lines.join("\n")}\n`;
}

function collectProducts({ bus, registry, cell, scope }) {
  const products = [];
  for (const node of cell.nodes) {
    const cartridge = registry.get(node.cartridge);
    if (!cartridge) throw new Error(`shift packet cell references an uninstalled cartridge: ${node.cartridge}`);
    const lot = bus.activeLot(cartridge.ref);
    for (const conclusion of lot?.conclusions ?? []) {
      if (!matchesFocus(conclusion.tuple, scope)) continue;
      products.push({ ...conclusion, station: node.id, cartridgeRef: cartridge.ref, lotId: lot.lotId });
    }
  }
  return products.sort((left, right) =>
    (PRIORITY[right.predicate] ?? 0) - (PRIORITY[left.predicate] ?? 0)
    || left.station.localeCompare(right.station)
    || left.conclusionId.localeCompare(right.conclusionId));
}

function compactProduct(product, limits) {
  const dependencies = product.dependencies.slice(0, limits.maxDependenciesPerProduct).map((row) => ({
    lane: row.lane, e: row.e, a: row.a, v: row.v,
  }));
  return {
    conclusionId: product.conclusionId,
    station: product.station,
    cartridgeRef: product.cartridgeRef,
    lotId: product.lotId,
    predicate: product.predicate,
    title: product.title,
    severity: product.severity,
    tuple: product.tuple,
    dependencyCount: product.dependencies.length,
    dependencies,
    dependenciesTruncated: dependencies.length < product.dependencies.length,
  };
}

function buildButtons(products) {
  const rows = [];
  for (const product of products) {
    const common = { sourceConclusionId: product.conclusionId, material: product.tuple, authority: "propose-only" };
    if (product.predicate === "verification_work_order") rows.push({ operation: "run-verification", label: `Run ${product.tuple.test}`, station: "qualified-test-station", ...common });
    if (product.predicate === "release_blocked_stale_evidence") rows.push({ operation: "refresh-evidence", label: `Refresh evidence for ${product.tuple.requirement}`, station: "evidence-renewal", ...common });
    if (product.predicate === "release_blocked_stale_authority") rows.push({ operation: "request-approval", label: `Request revision-bound approval for ${product.tuple.requirement}`, station: "authority-review", ...common });
    if (product.predicate === "release_ready") rows.push({ operation: "request-release-decision", label: `Present ${product.tuple.requirement} to release authority`, station: "release-board", ...common });
  }
  const unique = new Map(rows.map((row) => [`${row.operation}\0${canonicalEncode(row.material)}`, row]));
  return [...unique.values()].sort((a, b) => a.operation.localeCompare(b.operation) || a.label.localeCompare(b.label));
}

function buildAndons(products) {
  const rows = [];
  for (const product of products) {
    if (product.predicate === "release_blocked_stale_evidence") rows.push({ severity: "critical", code: "stale-evidence", message: `${product.tuple.requirement} has no current verification evidence for this chassis.`, sourceConclusionId: product.conclusionId });
    if (product.predicate === "release_blocked_stale_authority") rows.push({ severity: "critical", code: "stale-authority", message: `${product.tuple.requirement} lacks approval bound to this chassis.`, sourceConclusionId: product.conclusionId });
    if (product.predicate === "verification_work_order") rows.push({ severity: "warning", code: "verification-work", message: `${product.tuple.test} is required by the current change impact.`, sourceConclusionId: product.conclusionId });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code) || a.sourceConclusionId.localeCompare(b.sourceConclusionId));
}

function disposition(products) {
  if (products.some((row) => row.predicate.startsWith("release_blocked_"))) return "blocked";
  if (products.some((row) => row.predicate === "release_ready")) return "ready-for-authority-review";
  return "undetermined";
}

function omissionSummary(products) {
  const byPredicate = {};
  for (const product of products) byPredicate[product.predicate] = (byPredicate[product.predicate] ?? 0) + 1;
  return { count: products.length, byPredicate: Object.fromEntries(Object.entries(byPredicate).sort(([a], [b]) => a.localeCompare(b))) };
}

function currentFingerprint(bus) {
  const rows = bus.view("accepted").match({ a: "repo/source-fingerprint" });
  if (rows.length > 1) throw new Error("repository shift packet found multiple current source fingerprints");
  return rows[0]?.v ?? null;
}

function matchesFocus(tuple, focus) {
  const selected = [...focus.paths, ...focus.requirements];
  if (!selected.length) return true;
  const values = new Set(Object.values(tuple).filter((value) => typeof value === "string"));
  return selected.some((value) => values.has(value));
}

function normalizeFocus(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const unknown = Object.keys(row).filter((key) => !["paths", "requirements"].includes(key));
  if (unknown.length) throw new Error(`repository shift focus has unknown fields: ${unknown.join(", ")}`);
  return { paths: strings(row.paths ?? [], "focus path"), requirements: strings(row.requirements ?? [], "focus requirement") };
}
function normalizeLimits(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const unknown = Object.keys(row).filter((key) => !["maxProducts", "maxDependenciesPerProduct"].includes(key));
  if (unknown.length) throw new Error(`repository shift limits have unknown fields: ${unknown.join(", ")}`);
  return { maxProducts: positive(row.maxProducts ?? 24, "max products"), maxDependenciesPerProduct: positive(row.maxDependenciesPerProduct ?? 12, "max dependencies per product") };
}
function requireCell(value) { if (!value || typeof value !== "object" || !Array.isArray(value.nodes) || typeof value.ref !== "string") throw new TypeError("repository shift packet requires a compiled predicate cartridge cell"); return value; }
function requireBus(bus) { if (!bus || typeof bus.view !== "function" || typeof bus.activeLot !== "function" || typeof bus.basis !== "function") throw new TypeError("repository shift packet requires a FactBus-compatible bus"); }
function strings(value, label) { if (!Array.isArray(value)) throw new TypeError(`${label}s must be an array`); return [...new Set(value.map((item) => text(item, label)))].sort(); }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
