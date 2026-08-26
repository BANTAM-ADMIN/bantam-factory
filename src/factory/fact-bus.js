import crypto from "node:crypto";

import { FactFabric, canonicalEncode } from "./fact-fabric.js";
import { FactSourceRegistry } from "./fact-context.js";

const LANES = Object.freeze(["observation", "accepted", "derived", "telemetry"]);
const LANE_SET = new Set(LANES);

/**
 * Epistemically separated transport for factory knowledge.
 *
 * A FactBus is deliberately not one large bag of facts. Sensor output,
 * reviewed acceptance, deterministic derivation, and operational telemetry
 * live in different temporal fabrics. Crossing into the accepted lane always
 * requires an explicit acceptance grant.
 */
export class FactBus {
  constructor() {
    this._lanes = new Map(LANES.map((lane) => [lane, new FactFabric()]));
    this._receipts = new Map();
    this._activeLots = new Map();
  }

  static get lanes() { return LANES; }

  view(lane, basis = null) {
    const fabric = this.fabric(lane);
    return basis === null ? fabric.view() : fabric.asOf(basis);
  }

  fabric(lane) {
    const key = requireLane(lane);
    return this._lanes.get(key);
  }

  sources(mapping = Object.fromEntries(LANES.map((lane) => [`$${lane}`, lane]))) {
    const entries = {};
    for (const [name, lane] of Object.entries(mapping)) entries[name] = this.view(lane);
    return new FactSourceRegistry(entries);
  }

  observe(operations, { src, kind = "model-observation" } = {}) {
    return this._commit("observation", operations, { src, kind });
  }

  accept(operations, { src, kind = "reviewed-acceptance", grant } = {}) {
    validateAcceptanceGrant(grant, src);
    return this._commit("accepted", operations, { src, kind, grant });
  }

  measure(operations, { src, kind = "measurement" } = {}) {
    return this._commit("telemetry", operations, { src, kind });
  }

  /** Reserved for qualified cartridge execution; callers must present its ref. */
  derive(operations, { src, kind = "derived-conclusion", cartridgeRef, evaluationId } = {}) {
    requireText(cartridgeRef, "derived cartridge reference");
    requireText(evaluationId, "derived evaluation identity");
    if (src !== cartridgeRef) throw new Error("derived fact src must equal the executing cartridge reference");
    return this._commit("derived", operations, { src, kind, cartridgeRef, evaluationId });
  }

  basis() {
    return deepFreeze(Object.fromEntries(LANES.map((lane) => [lane, this.fabric(lane).basis])));
  }

  snapshot(name) {
    const label = requireText(name, "Fact Bus snapshot name");
    const lanes = Object.fromEntries(LANES.map((lane) => [lane, this.fabric(lane).snapshot(`${label}:${lane}`)]));
    return deepFreeze({ schema: "bantam.factory.fact-bus-basis.v1", name: label, lanes });
  }

  receipt(identity) { return this._receipts.get(identity) ?? null; }

  remember(identity, value) {
    const key = requireText(identity, "Fact Bus receipt identity");
    const previous = this._receipts.get(key);
    if (previous && canonicalEncode(previous) !== canonicalEncode(value)) {
      throw new Error(`Fact Bus receipt collision: ${key}`);
    }
    if (!previous) this._receipts.set(key, deepFreeze(structuredClone(value)));
    return this._receipts.get(key);
  }

  /** Current semantic lot for one cartridge; historical lots remain receipts. */
  activeLot(cartridgeRef) {
    const key = requireText(cartridgeRef, "cartridge reference");
    return this._activeLots.get(key) ?? null;
  }

  activateLot(cartridgeRef, lot) {
    const key = requireText(cartridgeRef, "cartridge reference");
    if (!lot || typeof lot !== "object" || lot.cartridgeRef !== key || typeof lot.evaluationId !== "string") {
      throw new TypeError("active semantic lot must bind its cartridge and evaluation");
    }
    const retained = deepFreeze(structuredClone(lot));
    this._activeLots.set(key, retained);
    return retained;
  }

  _commit(lane, operations, envelope) {
    const key = requireLane(lane);
    const transaction = this.fabric(key).transact(operations, envelope);
    return deepFreeze({
      schema: "bantam.factory.fact-bus-receipt.v1",
      receiptId: `fact-bus-receipt:sha256:${digest({ lane: key, transaction })}`,
      lane: key,
      grant: envelope.grant ? structuredClone(envelope.grant) : null,
      cartridgeRef: envelope.cartridgeRef ?? null,
      evaluationId: envelope.evaluationId ?? null,
      transaction,
    });
  }
}

function validateAcceptanceGrant(grant, src) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw new TypeError("accepted facts require an explicit fact.accept grant");
  }
  const keys = Object.keys(grant).sort();
  if (keys.join("\0") !== ["by", "evidenceRef", "grant"].sort().join("\0")) {
    throw new Error("acceptance grant requires exactly grant, by, and evidenceRef");
  }
  if (grant.grant !== "fact.accept") throw new Error("acceptance grant must be fact.accept");
  requireText(grant.by, "acceptance grant authority");
  requireText(grant.evidenceRef, "acceptance grant evidence");
  if (src !== grant.by) throw new Error("accepted fact src must equal the granting authority");
}

function requireLane(value) {
  if (!LANE_SET.has(value)) throw new Error(`unknown Fact Bus lane: ${value}`);
  return value;
}
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
