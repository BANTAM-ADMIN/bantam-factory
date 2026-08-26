import { definePredicateCartridge } from "../predicate-cartridge.js";

/** Join structural impact with accepted product obligations. */
export function requirementChangeImpactCartridge() {
  return definePredicateCartridge({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge",
    id: "requirement-change-impact",
    version: 1,
    title: "Requirement change-impact cartridge",
    purpose: "Propagate exact repository change impact into accepted product requirements without asking a model to reconstruct traceability.",
    sources: [
      { name: "impact", lane: "derived" },
      { name: "requirements", lane: "accepted" },
    ],
    loads: [
      { source: "impact", relation: "impact_conclusion", pattern: { a: "conclusion/predicate", v: "affected_by_change" }, fields: ["e"] },
      { source: "impact", relation: "impact_component", pattern: { a: "predicate/affected_by_change/arg/consumer" }, fields: ["e", "v"] },
      { source: "impact", relation: "impact_changed", pattern: { a: "predicate/affected_by_change/arg/changed" }, fields: ["e", "v"] },
      { source: "requirements", relation: "implemented_by", pattern: { a: "requirement/implemented-by" }, fields: ["e", "v"] },
    ],
    rules: [
      "requirement_affected(R,C,M) :- impact_conclusion(K), impact_component(K,M), impact_changed(K,C), implemented_by(R,M)",
    ],
    conclusions: [{ relation: "requirement_affected", variables: ["requirement", "changed", "component"], title: "Product requirement affected by repository change", severity: "warning" }],
    pullRecipes: [{
      id: "affected-requirement-context",
      lane: "derived",
      includeEvidence: true,
      specification: { attributes: {
        "conclusion/predicate": { as: "predicate" }, "conclusion/title": { as: "title" },
        "conclusion/tuple": { as: "traceability" }, "conclusion/dependencies": { as: "dependencies" },
        "conclusion/proof": { as: "proof" }, "conclusion/status": { as: "status" },
      } },
    }],
    subscriptions: [{ id: "requirement-impact-detected", predicate: "requirement_affected", minimum: 1, severity: "warning", message: "A repository change reaches an accepted product requirement." }],
    qualification: { status: "qualified", scope: ["Exact joins over accepted requirement-to-component mappings"], evidenceRefs: ["test:factory-governance-cell:requirement-impact-v1"] },
    presentation: { group: "product", icon: "contract", color: "orange" },
  });
}
