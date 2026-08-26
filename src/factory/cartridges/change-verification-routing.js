import { FactBus } from "../fact-bus.js";
import { PredicateCartridgeRegistry, definePredicateCartridge } from "../predicate-cartridge.js";
import { definePredicateCartridgeCell, runPredicateCartridgeCell } from "../predicate-cartridge-cell.js";
import { RepositoryTwin, repositoryChangeImpactCartridge } from "./repository-change-impact.js";

const POLICY_ENTITY = "policy:change-verification-routing@1";
const POLICY_AUTHORITY = "authority:factory-quality-engineering";

/**
 * Downstream cartridge that converts structural impact into typed verification
 * work orders. It proves that semantic products can become material for a
 * second qualified machine without returning to prose or a model context.
 */
export function changeVerificationRoutingCartridge() {
  return definePredicateCartridge({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge",
    id: "change-verification-routing",
    version: 1,
    title: "Change verification routing cartridge",
    purpose: "Turn accepted change-impact conclusions into proof-bearing verification work orders under reviewed quality policy.",
    sources: [
      { name: "impact", lane: "derived" },
      { name: "policy", lane: "accepted" },
    ],
    loads: [
      { source: "impact", relation: "affected_test_conclusion", pattern: { a: "conclusion/predicate", v: "affected_test" }, fields: ["e"] },
      { source: "impact", relation: "affected_test_arg", pattern: { a: "predicate/affected_test/arg/test" }, fields: ["e", "v"] },
      { source: "impact", relation: "affected_changed_arg", pattern: { a: "predicate/affected_test/arg/changed" }, fields: ["e", "v"] },
      { source: "policy", relation: "verification_routing_policy", pattern: { a: "policy/verification-routing", v: true }, fields: ["e"] },
    ],
    rules: [
      "verification_work_order(T,C) :- affected_test_conclusion(K), affected_test_arg(K,T), affected_changed_arg(K,C), verification_routing_policy(P)",
    ],
    conclusions: [{
      relation: "verification_work_order",
      variables: ["test", "changed"],
      title: "Verification work order required",
      severity: "warning",
    }],
    pullRecipes: [{
      id: "verification-work-order",
      lane: "derived",
      includeEvidence: true,
      specification: { attributes: {
        "conclusion/predicate": { as: "operation" },
        "conclusion/title": { as: "title" },
        "conclusion/severity": { as: "severity" },
        "conclusion/tuple": { as: "material" },
        "conclusion/dependencies": { as: "dependencies" },
        "conclusion/proof": { as: "proof" },
        "conclusion/status": { as: "status" },
      } },
    }],
    subscriptions: [{
      id: "verification-work-order-issued",
      predicate: "verification_work_order",
      minimum: 1,
      severity: "warning",
      message: "Structural change impact requires verification work to enter the dispatch queue.",
    }],
    qualification: {
      status: "qualified",
      scope: ["Routing currently affected static tests under reviewed policy", "No test execution or release authority"],
      evidenceRefs: ["test:factory-predicate-cartridge:two-cartridge-cell-v1"],
    },
    presentation: { group: "quality", icon: "clipboard", color: "yellow" },
  });
}

export function installChangeVerificationPolicy(bus) {
  if (!(bus instanceof FactBus)) throw new TypeError("verification policy requires a FactBus");
  if (bus.view("accepted").has(POLICY_ENTITY, "policy/verification-routing", true)) return null;
  return bus.accept([{ op: "assert", e: POLICY_ENTITY, a: "policy/verification-routing", v: true }], {
    src: POLICY_AUTHORITY,
    kind: "reviewed-factory-policy",
    grant: { grant: "fact.accept", by: POLICY_AUTHORITY, evidenceRef: "policy-article:change-verification-routing@1" },
  });
}

export function repositoryIntelligenceCellAsset({ registry } = {}) {
  return definePredicateCartridgeCell({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge-cell",
    id: "repository-intelligence-cell",
    version: 1,
    title: "Repository intelligence cell",
    purpose: "Convert exact repository deltas into impact products and governed verification work orders with transitive proof lineage.",
    nodes: [
      { id: "impact", cartridge: repositoryChangeImpactCartridge().ref },
      { id: "verification-routing", cartridge: changeVerificationRoutingCartridge().ref },
    ],
    edges: [{ from: "impact", predicate: "affected_test", to: "verification-routing", source: "impact" }],
    presentation: { group: "repository", icon: "assembly-line", color: "amber" },
  }, { registry });
}

/** Two-machine semantic assembly cell with cascading product recall. */
export class RepositoryIntelligenceCell {
  constructor({ root, bus = new FactBus() } = {}) {
    this.bus = bus;
    installChangeVerificationPolicy(this.bus);
    this.repository = new RepositoryTwin({ root, bus: this.bus, cartridge: repositoryChangeImpactCartridge() });
    this.routingCartridge = changeVerificationRoutingCartridge();
    this.registry = new PredicateCartridgeRegistry();
    this.registry.install(this.repository.cartridge);
    this.registry.install(this.routingCartridge);
    this.cell = repositoryIntelligenceCellAsset({ registry: this.registry });
    this.cycles = 0;
  }

  cycle({ changedPaths } = {}) {
    const impact = this.repository.cycle({ changedPaths });
    const execution = runPredicateCartridgeCell({ cell: this.cell, registry: this.registry, bus: this.bus });
    const verification = execution.evaluations.find((row) => row.nodeId === "verification-routing").evaluation;
    this.cycles += 1;
    return deepFreeze({
      schema: "bantam.factory.repository-intelligence-cell-cycle.v1",
      cycle: this.cycles,
      impact,
      verification,
      cellRef: this.cell.ref,
      projection: execution.projection,
      busBasis: this.bus.basis(),
    });
  }
}

function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
