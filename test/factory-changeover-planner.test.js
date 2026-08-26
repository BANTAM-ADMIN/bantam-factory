import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineWorkerPool, formatCampaignPlan, planCampaign } from "../src/factory/changeover-planner.js";

// One GPU holds one model, so worker selection is a setup problem and not only a
// routing problem. These pin the arithmetic that makes "horses for courses"
// executable, and the two properties that keep it honest: it never silently
// drops work it cannot staff, and it starts and stops nothing.
const POOL = [
  { id: "diffusiongemma", capabilities: ["bulk-semantic", "high-throughput"], changeoverSeconds: 8, notes: "die does not bind; needs a fixture and a gauge" },
  { id: "qwen-27b", capabilities: ["bound-die", "bulk-semantic"], changeoverSeconds: 12, notes: "grammar and JSON dies bind" },
  { id: "orion-26b-a4b", capabilities: ["bound-die", "concurrent-lanes"], changeoverSeconds: 15 },
];

const op = (id, requires, estimateSeconds = 10) => ({ id, requires, estimateSeconds });

describe("factory changeover planner", () => {
  it("groups work by worker so the machine is retooled once per campaign", () => {
    // Arrival order deliberately alternates, which is the worst case.
    const operations = [
      op("a", ["bulk-semantic"]), op("b", ["bound-die"]),
      op("c", ["bulk-semantic"]), op("d", ["bound-die"]),
    ];
    const plan = planCampaign({ operations, pool: POOL, resident: "diffusiongemma" });
    assert.equal(plan.summary.changeovers, 1);
    assert.equal(plan.summary.naiveChangeovers, 3);
    assert.equal(plan.summary.changeoversAvoided, 2);
    // The resident worker's campaign runs first — its changeover is already paid.
    assert.equal(plan.campaigns[0].worker, "diffusiongemma");
    assert.equal(plan.campaigns[0].changeoverRequired, false);
  });

  it("never silently drops work it cannot staff", () => {
    const plan = planCampaign({ operations: [op("impossible", ["time-travel"])], pool: POOL, resident: null });
    assert.equal(plan.summary.unstaffable, 1);
    assert.equal(plan.unstaffable[0].id, "impossible");
    assert.match(plan.unstaffable[0].reason, /no installed worker/);
    assert.match(formatCampaignPlan(plan), /UNSTAFFABLE impossible/);
  });

  it("charges a cold start as a changeover", () => {
    const plan = planCampaign({ operations: [op("a", ["bulk-semantic"])], pool: POOL, resident: null });
    assert.equal(plan.campaigns[0].changeoverRequired, true);
    assert.equal(plan.summary.changeoverSeconds, 8);
  });

  it("does not charge a changeover between workers on different resources", () => {
    // A worker on its own hardware is not a retool of the shared machine.
    const pool = [...POOL, { id: "codex-remote", capabilities: ["bound-die"], changeoverSeconds: 0, resource: "provider" }];
    const plan = planCampaign({
      operations: [op("a", ["bulk-semantic"]), op("b", ["concurrent-lanes"])],
      pool, resident: "diffusiongemma",
    });
    // Only the orion swap is a real retool; the provider worker would not be.
    assert.equal(plan.summary.changeovers, 1);
  });

  it("prefers a worker that already carries other work over a cheaper changeover", () => {
    // Two operations both satisfiable by qwen; putting them together is worth
    // more than either individual setup cost.
    const operations = [op("x", ["bound-die"]), op("y", ["bound-die"]), op("z", ["bound-die"])];
    const plan = planCampaign({ operations, pool: POOL, resident: null });
    assert.equal(plan.campaigns.length, 1);
    assert.equal(plan.campaigns[0].operationCount, 3);
    assert.equal(plan.summary.changeovers, 1);
  });

  it("is observe-only, content-addressed, and stable for the same input", () => {
    const operations = [op("a", ["bulk-semantic"]), op("b", ["bound-die"])];
    const first = planCampaign({ operations, pool: POOL, resident: "qwen-27b" });
    const second = planCampaign({ operations, pool: POOL, resident: "qwen-27b" });
    assert.equal(first.authority, "observe-only");
    assert.equal(first.ref, second.ref);
    assert.match(first.ref, /^campaign:sha256:[0-9a-f]{64}$/);
    assert.match(formatCampaignPlan(first), /starts and stops nothing/);
  });

  it("rejects a malformed pool rather than planning around it", () => {
    assert.throws(() => defineWorkerPool([{ id: "x", capabilities: [] }]), /missing changeoverSeconds/);
    assert.throws(() => defineWorkerPool([{ id: "x", capabilities: [], changeoverSeconds: -1 }]), /non-negative/);
    assert.throws(() => defineWorkerPool([
      { id: "x", capabilities: [], changeoverSeconds: 1 },
      { id: "x", capabilities: [], changeoverSeconds: 1 },
    ]), /repeats x/);
  });
});
