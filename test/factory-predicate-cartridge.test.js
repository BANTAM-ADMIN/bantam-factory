import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  FactBus,
  PredicateCartridgeRegistry,
  RepositoryIntelligenceCell,
  RepositoryTwin,
  compareSemanticLotFrames,
  definePredicateCartridge,
  definePredicateCartridgeCell,
  inspectRepositoryChangeImpact,
  projectSemanticLotFrame,
  repositoryChangeImpactCartridge,
  runPredicateCartridge,
} from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function repositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-cartridge-")); roots.push(root);
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src", "core.js"), "export function core() { return 7; }\n");
  fs.writeFileSync(path.join(root, "src", "api.js"), "import { core } from './core.js';\nexport function api() { return core(); }\n");
  fs.writeFileSync(path.join(root, "test", "api.test.js"), "import { api } from '../src/api.js';\napi();\n");
  return root;
}

describe("Fact Bus", () => {
  it("keeps observation, acceptance, derivation, and telemetry in separate temporal lanes", () => {
    const bus = new FactBus();
    bus.observe([{ op: "assert", e: "claim:1", a: "claim/status", v: "candidate" }], { src: "model:dg" });
    assert.equal(bus.view("observation").has("claim:1", "claim/status", "candidate"), true);
    assert.equal(bus.view("accepted").has("claim:1", "claim/status", "candidate"), false);
    assert.throws(() => bus.accept([{ op: "assert", e: "claim:1", a: "claim/status", v: "accepted" }], { src: "review:gauge" }), /fact.accept grant/);
    bus.accept([{ op: "assert", e: "claim:1", a: "claim/status", v: "accepted" }], {
      src: "review:gauge",
      grant: { grant: "fact.accept", by: "review:gauge", evidenceRef: "review-article:1" },
    });
    assert.deepEqual(bus.basis(), { observation: 1, accepted: 1, derived: 0, telemetry: 0 });
    assert.throws(() => bus.view("invented"), /unknown Fact Bus lane/);
  });
});

describe("Predicate Cartridges", () => {
  it("installs content-addressed semantic machine drawings and rejects byte conflicts", () => {
    const asset = repositoryChangeImpactCartridge();
    const registry = new PredicateCartridgeRegistry();
    assert.equal(registry.install(asset).ref, asset.ref);
    assert.equal(registry.install(structuredClone(asset)).ref, asset.ref);
    assert.equal(registry.get("repository-change-impact@1").ref, asset.ref);
    const conflicting = structuredClone(asset); delete conflicting.ref; conflicting.title = "Different machine";
    assert.throws(() => registry.install(conflicting), /different bytes/);
    assert.match(asset.ref, /^predicate-cartridge:repository-change-impact@1:sha256:[a-f0-9]{64}$/);
  });

  it("fails closed on undeclared sources, unqualified machinery, and schema expansion", () => {
    const source = structuredClone(repositoryChangeImpactCartridge()); delete source.ref;
    source.loads[0].source = "imaginary";
    assert.throws(() => definePredicateCartridge(source), /unknown source/);
    const expanded = structuredClone(repositoryChangeImpactCartridge()); delete expanded.ref; expanded.magic = true;
    assert.throws(() => definePredicateCartridge(expanded), /unknown=\[magic\]/);
    const candidate = structuredClone(repositoryChangeImpactCartridge()); delete candidate.ref; candidate.qualification.status = "candidate";
    assert.throws(() => runPredicateCartridge({ cartridge: candidate, bus: new FactBus() }), /not qualified/);
  });

  it("content-addresses cartridge cells and mechanically validates their predicate conveyors", () => {
    const cell = new RepositoryIntelligenceCell({ root: repositoryFixture() });
    assert.match(cell.cell.ref, /^predicate-cartridge-cell:repository-intelligence-cell@1:sha256:/);
    assert.deepEqual(cell.cell.edges, [{ from: "impact", predicate: "affected_test", to: "verification-routing", source: "impact" }]);
    const invalid = structuredClone(cell.cell); delete invalid.ref; invalid.edges[0].predicate = "imaginary_product";
    assert.throws(() => definePredicateCartridgeCell(invalid, { registry: cell.registry }), /not produced/);
    const expanded = structuredClone(cell.cell); delete expanded.ref; expanded.surprise = true;
    assert.throws(() => definePredicateCartridgeCell(expanded, { registry: cell.registry }), /unknown=\[surprise\]/);
  });

  it("compiles a real repository change into proof-bearing impact, Pull context, and an Andon signal", () => {
    const result = inspectRepositoryChangeImpact({ root: repositoryFixture(), changedPaths: ["src/core.js"] });
    const impact = result.evaluation.conclusions.filter((row) => row.predicate === "affected_by_change");
    const tests = result.evaluation.conclusions.filter((row) => row.predicate === "affected_test");
    assert.deepEqual(impact.map((row) => row.tuple.consumer).sort(), ["src/api.js", "src/core.js", "test/api.test.js"]);
    assert.deepEqual(tests.map((row) => row.tuple.test), ["test/api.test.js"]);
    assert.equal(result.evaluation.signals.length, 1);
    assert.equal(result.evaluation.signals[0].subscriptionId, "affected-test-required");
    assert.equal(result.evaluation.packets["codex-impact-context"].length, 4);
    const packet = result.evaluation.packets["codex-impact-context"].find((row) => row.data.predicate === "affected_test");
    assert.deepEqual(packet.data.tuple, { test: "test/api.test.js", changed: "src/core.js" });
    assert.equal(packet.data.dependencies.length, 4);
    assert.equal(packet.data.$evidence.proof[0].kind, "derived-lot-intake");
    const leaves = flattenLeaves(tests[0].proof);
    assert.ok(leaves.every((leaf) => leaf.datoms.every((datom) => datom.kind === "deterministic-repository-structure")));
    assert.deepEqual(leaves.filter((leaf) => leaf.fact[0] === "depends").map((leaf) => leaf.fact.slice(1)), [
      ["test/api.test.js", "src/api.js"],
      ["src/api.js", "src/core.js"],
    ], "the recursive proof must retain the exact primitive dependency chain");
    assert.match(result.evaluation.artifactId, /^predicate-evaluation-artifact:sha256:/);
  });

  it("reuses an identical semantic lot instead of manufacturing duplicate derived history", () => {
    const root = repositoryFixture();
    const bus = new FactBus();
    const authority = "review:test";
    bus.accept([
      { op: "assert", e: "src/core.js", a: "repo/file", v: true },
      { op: "assert", e: "src/core.js", a: "repo/changed", v: true },
    ], { src: authority, grant: { grant: "fact.accept", by: authority, evidenceRef: root } });
    const cartridge = repositoryChangeImpactCartridge();
    const first = runPredicateCartridge({ cartridge, bus });
    const basis = bus.basis();
    const second = runPredicateCartridge({ cartridge, bus });
    assert.equal(first.artifactId, second.artifactId);
    assert.deepEqual(bus.basis(), basis);
  });

  it("retains unaffected semantic products and recalls only conclusions whose exact support disappeared", () => {
    const root = repositoryFixture();
    const twin = new RepositoryTwin({ root });
    const first = twin.cycle({ changedPaths: ["src/core.js"] });
    const firstBasis = twin.bus.fabric("derived").basis;
    assert.equal(first.evaluation.conclusions.length, 4);
    const retainedConclusion = first.evaluation.conclusions.find((row) => row.tuple.consumer === "src/core.js");
    const retainedProofTx = twin.bus.view("derived").match({ e: retainedConclusion.conclusionId, a: "conclusion/proof" })[0].txId;

    fs.writeFileSync(path.join(root, "src", "unrelated.js"), "export const unrelated = true;\n");
    const unrelated = twin.cycle({ changedPaths: ["src/core.js"] });
    const unrelatedBasis = twin.bus.fabric("derived").basis;
    assert.equal(unrelated.source.delta.asserted, 3, "new file, new fingerprint, and its temporal supersession edge are asserted");
    assert.equal(unrelated.evaluation.transition.retained.length, 4);
    assert.equal(unrelated.evaluation.transition.revised.length, 0);
    assert.equal(unrelated.evaluation.transition.recalled.length, 0);
    assert.equal(twin.bus.view("derived").match({ e: retainedConclusion.conclusionId, a: "conclusion/proof" })[0].txId, retainedProofTx,
      "an unrelated source delta must not rewrite a retained semantic product");
    assert.deepEqual(compareSemanticLotFrames(twin.bus, {
      cartridgeRef: twin.cartridge.ref, leftBasis: firstBasis, rightBasis: unrelatedBasis,
    }).summary, { introduced: 0, recalled: 0, retained: 4 });

    fs.writeFileSync(path.join(root, "src", "api.js"), "export function api() { return 9; }\n");
    const disconnected = twin.cycle({ changedPaths: ["src/core.js"] });
    assert.deepEqual(disconnected.evaluation.conclusions.map((row) => row.tuple.consumer), ["src/core.js"]);
    assert.equal(disconnected.evaluation.transition.retained.length, 1);
    assert.equal(disconnected.evaluation.transition.recalled.length, 3);
    assert.equal(disconnected.evaluation.transition.introduced.length, 0);
    assert.equal(disconnected.evaluation.signals.some((row) => row.subscriptionId === "affected-test-required"), false);
    assert.equal(disconnected.evaluation.signals.some((row) => row.subscriptionId === "semantic-lot-recall"), true);
    assert.ok(disconnected.evaluation.transition.recalled.every((row) => row.invalidatedDependencies.some((dependency) =>
      dependency.relation === "depends" && dependency.e === "src/api.js" && dependency.v === "src/core.js")));
    for (const recall of disconnected.evaluation.transition.recalled) {
      assert.equal(twin.bus.view("derived").match({ e: recall.conclusionId }).length, 0, "recalled product must leave current derived state");
      assert.equal(twin.bus.fabric("derived").history({ e: recall.conclusionId }).some((datom) => datom.op === "assert"), true,
        "recalled product must remain in history for causal replay");
    }
    assert.equal(twin.bus.view("derived").has(first.evaluation.transition.lotId, "lot/status", "superseded"), true);
    assert.equal(twin.bus.view("derived").has(disconnected.evaluation.transition.lotId, "lot/status", "active"), true);
    const firstFrame = projectSemanticLotFrame(twin.bus, { cartridgeRef: twin.cartridge.ref, basis: firstBasis });
    const currentFrame = projectSemanticLotFrame(twin.bus, { cartridgeRef: twin.cartridge.ref });
    assert.equal(firstFrame.summary.currentConclusions, 4);
    assert.equal(firstFrame.summary.recalls, 0);
    assert.equal(currentFrame.summary.currentConclusions, 1);
    assert.equal(currentFrame.summary.recalls, 3);
    assert.equal(currentFrame.timeline.length, 3);
    assert.deepEqual(compareSemanticLotFrames(twin.bus, {
      cartridgeRef: twin.cartridge.ref, leftBasis: firstBasis, rightBasis: currentFrame.basis,
    }).summary, { introduced: 0, recalled: 3, retained: 1 });
  });

  it("composes cartridges into a semantic assembly cell and cascades exact recalls downstream", () => {
    const root = repositoryFixture();
    const cell = new RepositoryIntelligenceCell({ root });
    const first = cell.cycle({ changedPaths: ["src/core.js"] });
    assert.equal(first.impact.evaluation.conclusions.filter((row) => row.predicate === "affected_test").length, 1);
    assert.equal(first.verification.conclusions.length, 1);
    assert.equal(first.cellRef, cell.cell.ref);
    assert.deepEqual(first.projection.nodes.map((node) => [node.id, node.state, node.productCount]), [
      ["impact", "produced", 4], ["verification-routing", "produced", 1],
    ]);
    assert.deepEqual(first.projection.edges.map((edge) => edge.materialType), ["predicate:affected_test"]);
    assert.deepEqual(first.verification.conclusions[0].tuple, { test: "test/api.test.js", changed: "src/core.js" });
    assert.ok(first.verification.conclusions[0].dependencies.some((dependency) =>
      dependency.lane === "accepted" && dependency.e === "src/api.js" && dependency.a === "repo/depends" && dependency.v === "src/core.js"),
    "the downstream work order must inherit primitive support through the upstream cartridge");
    assert.ok(first.verification.conclusions[0].dependencies.some((dependency) =>
      dependency.lane === "derived" && dependency.e.startsWith("conclusion:repository-change-impact:")),
    "the downstream manifest must also bind the immediate upstream semantic product");

    fs.writeFileSync(path.join(root, "src", "api.js"), "export function api() { return 9; }\n");
    const second = cell.cycle({ changedPaths: ["src/core.js"] });
    assert.equal(second.verification.conclusions.length, 0);
    assert.equal(second.verification.transition.recalled.length, 1);
    assert.equal(second.verification.transition.recalled[0].predicate, "verification_work_order");
    assert.ok(second.verification.transition.recalled[0].invalidatedDependencies.some((dependency) =>
      dependency.e === "src/api.js" && dependency.a === "repo/depends" && dependency.v === "src/core.js"));
    assert.equal(second.verification.signals.some((signal) => signal.subscriptionId === "semantic-lot-recall"), true);
  });
});

function flattenLeaves(proof) { return proof.base ? [proof] : proof.parents.flatMap(flattenLeaves); }
