// Action Recommender tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActionRecommender } from "../src/action-recommender.js";
import { ActionEfficiency } from "../src/action-efficiency.js";
import { ActionDecisionTree } from "../src/action-decision-tree.js";
import { ContextBudget } from "../src/context-budget.js";

describe("ActionRecommender — basic scoring", () => {
  it("scores all default candidates and returns ranked list", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({});
    assert.ok(ranked.length > 0, "should return at least one candidate");
    assert.ok(ranked.every(r => typeof r.score === "number"), "each result has a numeric score");
    assert.ok(ranked.every(r => typeof r.action === "string"), "each result has an action name");
    assert.ok(ranked.every(r => typeof r.breakdown === "object"), "each result has a breakdown");
    // Verify descending order
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].score >= ranked[i].score, "results should be sorted descending by score");
    }
  });

  it("best() returns the top recommendation", () => {
    const rec = new ActionRecommender();
    const best = rec.best({});
    assert.ok(best !== null, "best should not be null");
    const ranked = rec.recommend({});
    assert.equal(best.action, ranked[0].action, "best matches top-ranked action");
  });

  it("viable() filters by threshold", () => {
    const rec = new ActionRecommender();
    const all = rec.recommend({});
    const viable = rec.viable({}, 0);
    assert.ok(viable.length <= all.length, "viable subset <= all");
    assert.ok(viable.every(v => v.score >= 0), "all viable scores >= threshold");
  });

  it("summary() returns valid structure", () => {
    const rec = new ActionRecommender();
    const s = rec.summary();
    assert.equal(s.efficiency, null, "no efficiency registered");
    assert.equal(s.decisionTree, null, "no decision tree registered");
    assert.equal(s.budget, null, "no budget registered");
    assert.equal(s.fileStatsSize, 0, "empty file stats");
  });
});

describe("ActionRecommender — with efficiency tracker", () => {
  it("boosts actions with high success rate", () => {
    const eff = new ActionEfficiency();
    for (let i = 0; i < 10; i++) eff.record("query", true, 5);
    for (let i = 0; i < 10; i++) eff.record("shell", false, 50);

    const rec = new ActionRecommender();
    rec.registerEfficiency(eff);
    const ranked = rec.recommend({});

    const queryIdx = ranked.findIndex(r => r.action === "query");
    const shellIdx = ranked.findIndex(r => r.action === "shell");
    assert.ok(queryIdx < shellIdx, "query (high success) should rank above shell (low success)");
  });

  it("penalizes actions with low success rate", () => {
    const eff = new ActionEfficiency();
    for (let i = 0; i < 5; i++) eff.record("read_file", false, 3);
    for (let i = 0; i < 5; i++) eff.record("read_file", true, 3);

    const rec = new ActionRecommender();
    rec.registerEfficiency(eff);
    const ranked = rec.recommend({});
    const readFile = ranked.find(r => r.action === "read_file");
    assert.ok(readFile.breakdown.efficiency > 0, "50/50 should still give positive efficiency");
  });
});

describe("ActionRecommender — with decision tree", () => {
  it("boosts actions on successful paths", () => {
    const tree = new ActionDecisionTree();
    tree.recordPath(["read_file", "replace"], true);
    tree.recordPath(["read_file", "shell"], false);

    const rec = new ActionRecommender();
    rec.registerDecisionTree(tree);
    const ranked = rec.recommend({ lastAction: "read_file" });

    const replace = ranked.find(r => r.action === "replace");
    assert.ok(replace.breakdown.decisionTree > 0, "replace should get decision tree bonus");
  });

  it("no decision tree bonus when no last action", () => {
    const tree = new ActionDecisionTree();
    tree.recordPath(["read_file", "replace"], true);

    const rec = new ActionRecommender();
    rec.registerDecisionTree(tree);
    const ranked = rec.recommend({});
    assert.ok(ranked.every(r => r.breakdown.decisionTree === 0), "no bonus without lastAction");
  });
});

describe("ActionRecommender — heuristic rules", () => {
  it("post-failure-recon: prefers recon actions after failure", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ lastAction: "replace", lastFailed: true });
    const readIdx = ranked.findIndex(r => r.action === "read_file");
    const replaceIdx = ranked.findIndex(r => r.action === "replace");
    assert.ok(readIdx < replaceIdx, "read_file should rank above replace after failure");
  });

  it("budget-conscious: prefers cheap actions when budget is tight", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ budgetUsed: 7500, budgetRemaining: 2500 });
    const query = ranked.find(r => r.action === "query");
    const shell = ranked.find(r => r.action === "shell");
    assert.ok(query.breakdown.rules > shell.breakdown.rules, "query should get budget bonus");
  });

  it("post-listdir-explore: prefers read/search after list_dir", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ lastAction: "list_dir" });
    const readIdx = ranked.findIndex(r => r.action === "read_file");
    const listIdx = ranked.findIndex(r => r.action === "list_dir");
    assert.ok(readIdx < listIdx, "read_file should rank above list_dir after list_dir");
  });

  it("post-read-act: prefers editing after read_file", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ lastAction: "read_file" });
    const replaceIdx = ranked.findIndex(r => r.action === "replace");
    const readIdx = ranked.findIndex(r => r.action === "read_file");
    assert.ok(replaceIdx < readIdx, "replace should rank above read_file after read_file");
  });

  it("post-shell-verify: prefers inspection after shell", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ lastAction: "shell" });
    const readIdx = ranked.findIndex(r => r.action === "read_file");
    const shellIdx = ranked.findIndex(r => r.action === "shell");
    assert.ok(readIdx < shellIdx, "read_file should rank above shell after shell");
  });

  it("avoid-repeat: penalizes repeating the same action", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ lastAction: "read_file" });
    const read = ranked.find(r => r.action === "read_file");
    assert.ok(read.breakdown.rules < 0, "repeating read_file should have negative rule score");
  });

  it("prefer-query-for-structure: boosts query on structure hints", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ hint: "structure" });
    const query = ranked.find(r => r.action === "query");
    assert.ok(query.breakdown.rules > 0, "query should get structure bonus");
  });
});

describe("ActionRecommender — custom candidates", () => {
  it("only scores provided candidates", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ candidates: ["read_file", "query"] });
    assert.equal(ranked.length, 2, "should score exactly the provided candidates");
    assert.ok(ranked.some(r => r.action === "read_file"));
    assert.ok(ranked.some(r => r.action === "query"));
  });

  it("handles empty candidates gracefully", () => {
    const rec = new ActionRecommender();
    const ranked = rec.recommend({ candidates: [] });
    assert.equal(ranked.length, 0, "empty candidates returns empty array");
  });
});

describe("ActionRecommender — full integration", () => {
  it("combines all subsystems for a realistic recommendation", () => {
    const eff = new ActionEfficiency();
    for (let i = 0; i < 8; i++) eff.record("read_file", true, 5);
    for (let i = 0; i < 3; i++) eff.record("replace", true, 3);
    for (let i = 0; i < 2; i++) eff.record("shell", false, 50);

    const tree = new ActionDecisionTree();
    tree.recordPath(["read_file", "replace"], true);
    tree.recordPath(["read_file", "replace"], true);
    tree.recordPath(["read_file", "shell"], false);

    const budget = new ContextBudget(8000);
    budget.allocate(1, 1200);
    budget.allocate(2, 800);

    const rec = new ActionRecommender();
    rec.registerEfficiency(eff);
    rec.registerDecisionTree(tree);
    rec.registerBudget(budget);

    const ranked = rec.recommend({
      lastAction: "read_file",
      budgetUsed: 2000,
      budgetRemaining: 6000,
    });

    // replace should rank high: efficiency + decision tree + post-read-act rule
    const replace = ranked.find(r => r.action === "replace");
    assert.ok(replace.score > 0, "replace should have positive total score");
    assert.ok(replace.breakdown.decisionTree > 0, "decision tree bonus applied");
    assert.ok(replace.breakdown.rules > 0, "post-read-act rule bonus applied");

    // Summary should reflect all subsystems
    const s = rec.summary();
    assert.ok(s.efficiency !== null, "efficiency in summary");
    assert.ok(s.decisionTree !== null, "decision tree in summary");
    assert.ok(s.budget !== null, "budget in summary");
  });
});
