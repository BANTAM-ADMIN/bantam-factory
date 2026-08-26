import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeFactoryProcess, formatProcessChangeOrder } from "../src/factory/process-engineer.js";

// The process engineer proposes MERGES. Every other mechanism here pushes toward
// finer decomposition, and a ratchet with no pawl in the other direction ends at
// one station per token. These tests pin the two things that make the pawl safe:
// it must refuse to merge across a boundary that has ever caught something, and
// it must present its savings as a hypothesis with an experiment attached.

function event(type, stationAttempt, payload = {}) {
  return { type, payload: { stationAttempt, ...payload } };
}

function cleanRoute() {
  return [
    event("station.started", "alpha-1"),
    event("station.performance", "alpha-1", { operationMs: 120 }),
    event("gauge.result", "alpha-1", { status: "pass" }),
    event("station.released", "alpha-1"),
    event("station.started", "beta-1"),
    event("station.performance", "beta-1", { operationMs: 200 }),
    event("gauge.result", "beta-1", { status: "pass" }),
    event("station.released", "beta-1"),
  ];
}

describe("factory process engineer", () => {
  it("proposes merging a boundary that has never caught anything", () => {
    const order = analyzeFactoryProcess(cleanRoute(), { articleCount: 8 });
    assert.equal(order.proposals.length, 1);
    const [proposal] = order.proposals;
    assert.equal(proposal.id, "merge:alpha+beta");
    assert.deepEqual(proposal.blockedBy, []);
    // Conservative by design: it counts the boundary's fixed cost, never the
    // model time, because it cannot know whether one larger call beats two.
    assert.equal(proposal.predicted.savedMsPerArticle, 120);
    assert.equal(proposal.predicted.savedMsOverObserved, 960);
    assert.equal(proposal.predicted.fewerDispatchesPerArticle, 1);
  });

  it("refuses to merge across a gauge that has ever fired", () => {
    // The boundary is only load-bearing if its gauge catches things. One
    // historical catch is enough to make the merge an escape.
    const events = cleanRoute().map((entry) => (
      entry.type === "gauge.result" && entry.payload.stationAttempt === "alpha-1"
        ? event("gauge.result", "alpha-1", { status: "fail" })
        : entry
    ));
    const order = analyzeFactoryProcess(events, { articleCount: 8 });
    const [proposal] = order.proposals;
    assert.equal(proposal.blockedBy.length, 1);
    assert.match(proposal.blockedBy[0], /has failed 1 time\(s\); merging removes that detection point/);
    assert.match(proposal.rationale, /carrying quality signal/);
    assert.equal(order.summary.blocked, 1);
    assert.equal(order.summary.totalPredictedSavedMsPerArticle, 0);
  });

  it("refuses to merge a station that has unreleased attempts", () => {
    const events = [...cleanRoute(), event("station.started", "alpha-1")];
    const order = analyzeFactoryProcess(events, { articleCount: 1 });
    assert.ok(order.proposals[0].blockedBy.some((reason) => /unreleased attempt/.test(reason)));
  });

  it("states the cost of merging, not only the saving", () => {
    const [proposal] = analyzeFactoryProcess(cleanRoute()).proposals;
    // Merging trades locus resolution for speed. A proposal that reported only
    // the saving would be the same flattery this branch keeps finding.
    assert.equal(proposal.predicted.lostLocusResolutionOperations, 1);
  });

  it("presents a predicted saving as a hypothesis with an experiment attached", () => {
    const [proposal] = analyzeFactoryProcess(cleanRoute()).proposals;
    assert.match(proposal.confirmingExperiment.design, /order-balanced/);
    assert.match(proposal.confirmingExperiment.accept, /statistically indistinguishable/);
    assert.ok(proposal.confirmingExperiment.minimumArticlesPerArm >= 20);
    assert.match(formatProcessChangeOrder(analyzeFactoryProcess(cleanRoute())), /a predicted saving is a hypothesis/);
  });

  it("has no authority and is content-addressed", () => {
    const order = analyzeFactoryProcess(cleanRoute());
    assert.equal(order.authority, "observe-only");
    assert.match(order.ref, /^change-order:sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(order.proposals[0]), true);
    // Same observation, same identity.
    assert.equal(analyzeFactoryProcess(cleanRoute()).ref, order.ref);
  });

  it("handles a route with nothing to merge", () => {
    const order = analyzeFactoryProcess([event("station.started", "only-1"), event("station.released", "only-1")]);
    assert.deepEqual(order.proposals, []);
    assert.match(formatProcessChangeOrder(order), /no adjacent station pairs/);
  });
});
