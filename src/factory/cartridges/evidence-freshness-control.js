import { definePredicateCartridge } from "../predicate-cartridge.js";

/** Compare active verification evidence with the repository's causal revision chain. */
export function evidenceFreshnessCartridge() {
  return definePredicateCartridge({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge",
    id: "evidence-freshness-control",
    version: 1,
    title: "Evidence freshness control",
    purpose: "Determine whether active requirement evidence belongs to the current repository basis or an explicitly superseded ancestor.",
    sources: [
      { name: "requirements", lane: "derived" },
      { name: "evidence", lane: "accepted" },
      { name: "timeline", lane: "accepted" },
    ],
    loads: [
      { source: "requirements", relation: "affected_requirement_conclusion", pattern: { a: "conclusion/predicate", v: "requirement_affected" }, fields: ["e"] },
      { source: "requirements", relation: "affected_requirement", pattern: { a: "predicate/requirement_affected/arg/requirement" }, fields: ["e", "v"] },
      { source: "requirements", relation: "affected_changed", pattern: { a: "predicate/requirement_affected/arg/changed" }, fields: ["e", "v"] },
      { source: "evidence", relation: "verified_by", pattern: { a: "requirement/verified-by" }, fields: ["e", "v"] },
      { source: "evidence", relation: "active_evidence", pattern: { a: "evidence/active", v: true }, fields: ["e"] },
      { source: "evidence", relation: "evidence_test", pattern: { a: "evidence/test" }, fields: ["e", "v"] },
      { source: "evidence", relation: "evidence_requirement", pattern: { a: "evidence/requirement" }, fields: ["e", "v"] },
      { source: "evidence", relation: "evidence_basis", pattern: { a: "evidence/validated-fingerprint" }, fields: ["e", "v"] },
      { source: "timeline", relation: "current_basis", pattern: { a: "repo/source-fingerprint" }, fields: ["v"] },
      { source: "timeline", relation: "supersedes", pattern: { a: "timeline/repository-supersedes" }, fields: ["e", "v"] },
    ],
    rules: [
      "newer(N,O) :- supersedes(N,O)",
      "newer(N,O) :- supersedes(N,M), newer(M,O)",
      "current_verification_evidence(R,T,E,B,C) :- affected_requirement_conclusion(K), affected_requirement(K,R), affected_changed(K,C), verified_by(R,T), active_evidence(E), evidence_test(E,T), evidence_requirement(E,R), evidence_basis(E,B), current_basis(B)",
      "stale_verification_evidence(R,T,E,Old,Current,C) :- affected_requirement_conclusion(K), affected_requirement(K,R), affected_changed(K,C), verified_by(R,T), active_evidence(E), evidence_test(E,T), evidence_requirement(E,R), evidence_basis(E,Old), current_basis(Current), newer(Current,Old)",
    ],
    conclusions: [
      { relation: "current_verification_evidence", variables: ["requirement", "test", "evidence", "basis", "changed"], title: "Current verification evidence", severity: "info" },
      { relation: "stale_verification_evidence", variables: ["requirement", "test", "evidence", "validated", "current", "changed"], title: "Verification evidence predates affected change", severity: "critical" },
    ],
    pullRecipes: [{
      id: "evidence-freshness-context",
      lane: "derived",
      includeEvidence: true,
      specification: { attributes: {
        "conclusion/predicate": { as: "disposition" }, "conclusion/title": { as: "title" },
        "conclusion/severity": { as: "severity" }, "conclusion/tuple": { as: "evidence" },
        "conclusion/dependencies": { as: "dependencies" }, "conclusion/proof": { as: "proof" },
      } },
    }],
    subscriptions: [{ id: "stale-verification-evidence", predicate: "stale_verification_evidence", minimum: 1, severity: "critical", message: "Active verification evidence predates the current affected repository basis." }],
    qualification: { status: "qualified", scope: ["Causal repository fingerprint chains and explicitly active evidence"], evidenceRefs: ["test:factory-governance-cell:evidence-freshness-v1"] },
    presentation: { group: "quality", icon: "hourglass", color: "red" },
  });
}
