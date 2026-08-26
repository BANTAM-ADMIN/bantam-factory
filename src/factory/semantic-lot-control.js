import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";

/**
 * Read-only control-tower frame for semantic products at one derived basis.
 * The projection is made entirely from Fact Bus state, so a future visual has
 * no shadow lifecycle model to drift from the backend.
 */
export function projectSemanticLotFrame(bus, { cartridgeRef, basis = null } = {}) {
  requireBus(bus);
  const cartridge = text(cartridgeRef, "semantic lot cartridge reference");
  const derived = bus.fabric("derived");
  const targetBasis = basis === null ? derived.basis : basis;
  const view = bus.view("derived", targetBasis);
  const lotIds = view.match({ a: "lot/cartridge", v: cartridge }).map((datom) => datom.e).sort();
  const lots = lotIds.map((lotId) => ({
    lotId,
    evaluationId: one(view, lotId, "lot/evaluation"),
    sourceBasis: one(view, lotId, "lot/source-basis"),
    status: one(view, lotId, "lot/status"),
    supersededBy: one(view, lotId, "lot/superseded-by"),
    conclusionIds: many(view, lotId, "lot/conclusion"),
  }));
  const active = lots.find((lot) => lot.status === "active") ?? null;
  const conclusions = (active?.conclusionIds ?? []).map((conclusionId) => ({
    conclusionId,
    predicate: one(view, conclusionId, "conclusion/predicate"),
    title: one(view, conclusionId, "conclusion/title"),
    severity: one(view, conclusionId, "conclusion/severity"),
    tuple: one(view, conclusionId, "conclusion/tuple"),
    status: one(view, conclusionId, "conclusion/status"),
    dependencies: one(view, conclusionId, "conclusion/dependencies") ?? [],
  })).sort((a, b) => a.conclusionId.localeCompare(b.conclusionId));
  const lotSet = new Set(lotIds);
  const recallIds = view.match({ a: "recall/from-lot" }).filter((datom) => lotSet.has(datom.v)).map((datom) => datom.e).sort();
  const recalls = recallIds.map((recallId) => ({
    recallId,
    conclusionId: one(view, recallId, "recall/conclusion"),
    fromLotId: one(view, recallId, "recall/from-lot"),
    toLotId: one(view, recallId, "recall/to-lot"),
    reason: one(view, recallId, "recall/reason"),
    invalidatedDependencies: one(view, recallId, "recall/invalidated-dependencies") ?? [],
  }));
  const timeline = groupTimeline(derived.history({ src: cartridge }).filter((datom) => datom.tx <= targetBasis));
  const body = {
    schema: "bantam.factory.semantic-lot-frame.v1",
    kind: "bantam.factory-semantic-lot-frame",
    authority: "observe-only",
    cartridgeRef: cartridge,
    basis: targetBasis,
    summary: {
      lots: lots.length,
      activeLots: lots.filter((lot) => lot.status === "active").length,
      supersededLots: lots.filter((lot) => lot.status === "superseded").length,
      currentConclusions: conclusions.length,
      recalls: recalls.length,
    },
    activeLotId: active?.lotId ?? null,
    lots,
    conclusions,
    recalls,
    timeline,
  };
  return deepFreeze({ ...body, frameId: `semantic-lot-frame:sha256:${digest(body)}` });
}

/** Exact semantic-product delta between any two points on the factory clock. */
export function compareSemanticLotFrames(bus, { cartridgeRef, leftBasis, rightBasis } = {}) {
  const left = projectSemanticLotFrame(bus, { cartridgeRef, basis: leftBasis });
  const right = projectSemanticLotFrame(bus, { cartridgeRef, basis: rightBasis });
  const leftIds = new Set(left.conclusions.map((row) => row.conclusionId));
  const rightIds = new Set(right.conclusions.map((row) => row.conclusionId));
  const introduced = right.conclusions.filter((row) => !leftIds.has(row.conclusionId));
  const recalled = left.conclusions.filter((row) => !rightIds.has(row.conclusionId));
  const retained = right.conclusions.filter((row) => leftIds.has(row.conclusionId));
  const body = {
    schema: "bantam.factory.semantic-lot-comparison.v1",
    kind: "bantam.factory-semantic-lot-comparison",
    authority: "observe-only",
    cartridgeRef: left.cartridgeRef,
    left: { basis: left.basis, frameId: left.frameId, activeLotId: left.activeLotId },
    right: { basis: right.basis, frameId: right.frameId, activeLotId: right.activeLotId },
    summary: { introduced: introduced.length, recalled: recalled.length, retained: retained.length },
    introduced,
    recalled,
    retained,
  };
  return deepFreeze({ ...body, comparisonId: `semantic-lot-comparison:sha256:${digest(body)}` });
}

function groupTimeline(datoms) {
  const groups = new Map();
  for (const datom of datoms) {
    const group = groups.get(datom.tx) ?? { basis: datom.tx, txId: datom.txId, kind: datom.kind, assertions: 0, retractions: 0, lotIds: new Set(), recallIds: new Set() };
    if (datom.op === "assert") group.assertions += 1; else group.retractions += 1;
    if (datom.a.startsWith("lot/")) group.lotIds.add(datom.e);
    if (datom.a.startsWith("recall/")) group.recallIds.add(datom.e);
    groups.set(datom.tx, group);
  }
  return [...groups.values()].sort((a, b) => a.basis - b.basis).map((group) => ({
    basis: group.basis,
    txId: group.txId,
    kind: group.kind,
    assertions: group.assertions,
    retractions: group.retractions,
    lotIds: [...group.lotIds].sort(),
    recallIds: [...group.recallIds].sort(),
  }));
}

function one(view, entity, attribute) {
  const rows = view.match({ e: entity, a: attribute });
  if (rows.length > 1) throw new Error(`semantic lot control found ambiguous ${entity} ${attribute}`);
  return rows[0]?.v ?? null;
}
function many(view, entity, attribute) { return view.match({ e: entity, a: attribute }).map((datom) => datom.v).sort(); }
function requireBus(bus) { if (!bus || typeof bus.view !== "function" || typeof bus.fabric !== "function") throw new TypeError("semantic lot control requires a FactBus-compatible bus"); }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
