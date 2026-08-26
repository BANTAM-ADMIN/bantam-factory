import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { projectSemanticLotFrame, RepositoryGovernanceCell } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-governance-cell-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src", "core.js"), "export function core() { return 7; }\n");
  fs.writeFileSync(path.join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  fs.writeFileSync(path.join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");
  return root;
}

const governance = {
  requirement: "requirement:core-remains-available",
  component: "src/core.js",
  test: "test/api.test.js",
  authority: "authority:release-board",
  fingerprint: "current",
};

describe("living repository governance cell", () => {
  it("moves an affected requirement from release-ready through stale blocks and back through fresh evidence", () => {
    const root = fixture(), cell = new RepositoryGovernanceCell({ root });
    const first = cell.cycle({ changedPaths: ["src/core.js"], governance });
    assert.deepEqual(first.projection.nodes.map((node) => node.id), ["impact", "verification-routing", "requirement-impact", "evidence-freshness", "release-control"]);
    assert.equal(first.projection.edges.length, 5);
    assert.equal(first.evaluations["requirement-impact"].conclusions.length, 1);
    assert.deepEqual(first.evaluations["requirement-impact"].conclusions[0].tuple, {
      requirement: governance.requirement, changed: "src/core.js", component: "src/core.js",
    });
    assert.deepEqual(first.evaluations["evidence-freshness"].conclusions.map((row) => row.predicate), ["current_verification_evidence"]);
    assert.deepEqual(first.evaluations["release-control"].conclusions.map((row) => row.predicate), ["release_ready"]);
    const ready = first.evaluations["release-control"].conclusions[0];
    assert.ok(ready.dependencies.some((dependency) => dependency.a === "requirement/implemented-by" && dependency.v === "src/core.js"));
    assert.ok(ready.dependencies.some((dependency) => dependency.a === "evidence/validated-fingerprint" && dependency.v === first.source.fingerprint));
    assert.ok(ready.dependencies.some((dependency) => dependency.a === "authority/approved-fingerprint" && dependency.v === first.source.fingerprint));

    fs.writeFileSync(path.join(root, "src", "core.js"), "export function core() { return 8; }\n");
    const stale = cell.cycle({ changedPaths: ["src/core.js"] });
    assert.equal(cell.bus.view("accepted").has(stale.source.fingerprint, "timeline/repository-supersedes", first.source.fingerprint), true);
    assert.deepEqual(stale.evaluations["evidence-freshness"].conclusions.map((row) => row.predicate), ["stale_verification_evidence"]);
    assert.deepEqual(stale.evaluations["release-control"].conclusions.map((row) => row.predicate).sort(), [
      "release_blocked_stale_authority", "release_blocked_stale_evidence",
    ]);
    assert.equal(stale.evaluations["release-control"].transition.recalled.some((row) => row.predicate === "release_ready"), true);
    assert.equal(stale.evaluations["release-control"].signals.filter((row) => row.severity === "critical").length, 2);

    const refreshed = cell.cycle({ changedPaths: ["src/core.js"], governance });
    assert.deepEqual(refreshed.evaluations["evidence-freshness"].conclusions.map((row) => row.predicate), ["current_verification_evidence"]);
    assert.deepEqual(refreshed.evaluations["release-control"].conclusions.map((row) => row.predicate), ["release_ready"]);
    assert.equal(refreshed.evaluations["release-control"].transition.recalled.filter((row) => row.predicate.startsWith("release_blocked_")).length, 2);
    assert.equal(refreshed.evaluations["release-control"].conclusions[0].tuple.basis, stale.source.fingerprint);
    const releaseFrame = projectSemanticLotFrame(cell.bus, { cartridgeRef: cell.registry.get("release-authority-control@1").ref });
    assert.equal(releaseFrame.summary.lots, 3);
    assert.equal(releaseFrame.summary.currentConclusions, 1);
    assert.equal(releaseFrame.summary.recalls, 3);

    const beforeQuietCycle = cell.bus.basis();
    const quiet = cell.cycle({ changedPaths: ["src/core.js"], governance });
    assert.equal(quiet.source.operationCount, 0);
    assert.equal(quiet.governanceReceipt, null);
    assert.deepEqual(cell.bus.basis(), beforeQuietCycle, "an unchanged governed chassis must roll through quiet wickets without writes");
  });

  it("keeps release authority observe-only even when every wicket is green", () => {
    const cell = new RepositoryGovernanceCell({ root: fixture() });
    const cycle = cell.cycle({ changedPaths: ["src/core.js"], governance });
    assert.equal(cycle.evaluations["release-control"].conclusions[0].predicate, "release_ready");
    assert.equal(cycle.evaluations["release-control"].signals[0].subscriptionId, "release-ready");
    assert.equal(cycle.projection.authority, "observe-only");
    assert.equal(typeof cell.bus.transact, "undefined", "Fact Bus does not expose an ungoverned cross-lane transaction");
  });
});
