import { definePredicateCartridge } from "../predicate-cartridge.js";

/** Combine evidence freshness with revision-bound release authority. */
export function releaseAuthorityCartridge() {
  return definePredicateCartridge({
    schema: 1,
    kind: "bantam.factory-predicate-cartridge",
    id: "release-authority-control",
    version: 1,
    title: "Release evidence and authority control",
    purpose: "Open release only when current evidence and current authority approval meet at the affected requirement; otherwise emit exact blocking products.",
    sources: [
      { name: "freshness", lane: "derived" },
      { name: "governance", lane: "accepted" },
    ],
    loads: [
      { source: "freshness", relation: "current_evidence_conclusion", pattern: { a: "conclusion/predicate", v: "current_verification_evidence" }, fields: ["e"] },
      { source: "freshness", relation: "stale_evidence_conclusion", pattern: { a: "conclusion/predicate", v: "stale_verification_evidence" }, fields: ["e"] },
      { source: "freshness", relation: "current_requirement", pattern: { a: "predicate/current_verification_evidence/arg/requirement" }, fields: ["e", "v"] },
      { source: "freshness", relation: "current_test", pattern: { a: "predicate/current_verification_evidence/arg/test" }, fields: ["e", "v"] },
      { source: "freshness", relation: "current_evidence", pattern: { a: "predicate/current_verification_evidence/arg/evidence" }, fields: ["e", "v"] },
      { source: "freshness", relation: "current_evidence_basis", pattern: { a: "predicate/current_verification_evidence/arg/basis" }, fields: ["e", "v"] },
      { source: "freshness", relation: "current_changed", pattern: { a: "predicate/current_verification_evidence/arg/changed" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_requirement", pattern: { a: "predicate/stale_verification_evidence/arg/requirement" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_test", pattern: { a: "predicate/stale_verification_evidence/arg/test" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_evidence", pattern: { a: "predicate/stale_verification_evidence/arg/evidence" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_validated", pattern: { a: "predicate/stale_verification_evidence/arg/validated" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_current", pattern: { a: "predicate/stale_verification_evidence/arg/current" }, fields: ["e", "v"] },
      { source: "freshness", relation: "stale_changed", pattern: { a: "predicate/stale_verification_evidence/arg/changed" }, fields: ["e", "v"] },
      { source: "governance", relation: "release_authority", pattern: { a: "requirement/release-authority" }, fields: ["e", "v"] },
      { source: "governance", relation: "authority_approval", pattern: { a: "authority/approved-fingerprint" }, fields: ["e", "v"] },
      { source: "governance", relation: "current_basis", pattern: { a: "repo/source-fingerprint" }, fields: ["v"] },
      { source: "governance", relation: "supersedes", pattern: { a: "timeline/repository-supersedes" }, fields: ["e", "v"] },
    ],
    rules: [
      "newer(N,O) :- supersedes(N,O)",
      "newer(N,O) :- supersedes(N,M), newer(M,O)",
      "release_ready(R,T,E,A,B,C) :- current_evidence_conclusion(K), current_requirement(K,R), current_test(K,T), current_evidence(K,E), current_evidence_basis(K,B), current_changed(K,C), release_authority(R,A), authority_approval(A,B)",
      "release_blocked_stale_evidence(R,T,E,Old,Current,C) :- stale_evidence_conclusion(K), stale_requirement(K,R), stale_test(K,T), stale_evidence(K,E), stale_validated(K,Old), stale_current(K,Current), stale_changed(K,C)",
      "affected_requirement(R,C) :- current_evidence_conclusion(K), current_requirement(K,R), current_changed(K,C)",
      "affected_requirement(R,C) :- stale_evidence_conclusion(K), stale_requirement(K,R), stale_changed(K,C)",
      "release_blocked_stale_authority(R,A,Old,Current,C) :- affected_requirement(R,C), release_authority(R,A), authority_approval(A,Old), current_basis(Current), newer(Current,Old)",
    ],
    conclusions: [
      { relation: "release_ready", variables: ["requirement", "test", "evidence", "authority", "basis", "changed"], title: "Release evidence and authority are current", severity: "info" },
      { relation: "release_blocked_stale_evidence", variables: ["requirement", "test", "evidence", "validated", "current", "changed"], title: "Release blocked by stale verification evidence", severity: "critical" },
      { relation: "release_blocked_stale_authority", variables: ["requirement", "authority", "approved", "current", "changed"], title: "Release blocked by stale authority approval", severity: "critical" },
    ],
    pullRecipes: [{
      id: "release-control-context",
      lane: "derived",
      includeEvidence: true,
      specification: { attributes: {
        "conclusion/predicate": { as: "disposition" }, "conclusion/title": { as: "title" },
        "conclusion/severity": { as: "severity" }, "conclusion/tuple": { as: "releaseMaterial" },
        "conclusion/dependencies": { as: "dependencies" }, "conclusion/proof": { as: "proof" },
      } },
    }],
    subscriptions: [
      { id: "release-ready", predicate: "release_ready", minimum: 1, severity: "info", message: "Current evidence and revision-bound authority satisfy the release wicket." },
      { id: "release-blocked-stale-evidence", predicate: "release_blocked_stale_evidence", minimum: 1, severity: "critical", message: "Release is blocked because active evidence predates the affected repository basis." },
      { id: "release-blocked-stale-authority", predicate: "release_blocked_stale_authority", minimum: 1, severity: "critical", message: "Release is blocked because authority approval predates the affected repository basis." },
    ],
    qualification: { status: "qualified", scope: ["Revision-bound evidence and authority over accepted requirement mappings", "Observe-only release disposition"], evidenceRefs: ["test:factory-governance-cell:release-authority-v1"] },
    presentation: { group: "release", icon: "wicket", color: "gold" },
  });
}
