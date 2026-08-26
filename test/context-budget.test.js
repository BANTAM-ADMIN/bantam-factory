import { strict as s } from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ContextBudget } from "../src/context-budget.js";

it("defines fitsInTurn only once so class-method shadowing cannot hide budget logic", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/context-budget.js", import.meta.url)),
    "utf8",
  );
  s.equal(source.match(/^\s*fitsInTurn\(/gm)?.length, 1);
});

describe("ContextBudget", () => {
  it("starts with zero usage and ok status", () => {
    const b = new ContextBudget(8000);
    s.equal(b.used, 0);
    s.equal(b.remaining(), 8000);
    s.equal(b.ratio(), 0);
    s.equal(b.status(), "ok");
    s.equal(b.estimatedTurnsRemaining(), 0);
  });

  it("tracks per-turn allocations", () => {
    const b = new ContextBudget(8000);
    const entry = b.allocate(1, 500, "read_file");
    s.equal(entry.turn, 1);
    s.equal(entry.cost, 500);
    s.equal(entry.category, "reads");
    s.equal(entry.remaining, 7500);
    s.equal(b.used, 500);
    s.equal(b.turns.length, 1);
  });

  it("categorizes actions correctly", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 100, "read_file");
    b.allocate(1, 100, "list_dir");
    b.allocate(1, 100, "search");
    b.allocate(1, 100, "inspect");
    b.allocate(2, 200, "replace");
    b.allocate(2, 200, "write_file");
    b.allocate(3, 150, "shell");
    b.allocate(4, 100, "query");
    b.allocate(5, 50, "done");
    b.allocate(5, 50, "respond");

    const cats = b.categoryBreakdown();
    s.equal(cats.reads, 400);
    s.equal(cats.writes, 400);
    s.equal(cats.shell, 150);
    s.equal(cats.queries, 100);
    s.equal(cats.misc, 100);
  });

  it("warns at 75% threshold", () => {
    const b = new ContextBudget(1000, 0.75, 0.90);
    b.allocate(1, 600);
    s.equal(b.status(), "ok");
    s.equal(b.warnings.length, 0);
    b.allocate(2, 151);
    s.equal(b.status(), "warning");
    s.equal(b.warnings.length, 1);
  });

  it("goes critical at 90% threshold", () => {
    const b = new ContextBudget(1000, 0.75, 0.90);
    b.allocate(1, 901);
    s.equal(b.status(), "critical");
    s.equal(b.criticals.length, 1);
  });

  it("goes exhausted when budget exceeded", () => {
    const b = new ContextBudget(1000);
    b.allocate(1, 1000);
    s.equal(b.status(), "exhausted");
    s.equal(b.remaining(), 0);
  });

  it("estimates turns remaining based on average cost", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 500);
    b.allocate(2, 500);
    b.allocate(3, 500);
    s.equal(b.estimatedTurnsRemaining(), 13);
  });

  it("fitsInTurn checks per-turn budget", () => {
    const b = new ContextBudget(8000, 0.75, 0.90, 2000);
    b.allocate(1, 1500);
    s.equal(b.fitsInTurn(500), true);
    s.equal(b.fitsInTurn(501), false);
  });

  it("fitsInSession checks session budget", () => {
    const b = new ContextBudget(1000);
    b.allocate(1, 800);
    s.equal(b.fitsInSession(200), true);
    s.equal(b.fitsInSession(201), false);
  });

  it("summary returns all fields", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 500, "read_file");
    const sum = b.summary();
    s.equal(sum.max, 8000);
    s.equal(sum.perTurnMax, 2000);
    s.equal(sum.used, 500);
    s.equal(sum.remaining, 7500);
    s.equal(sum.ratio, 0.063);
    s.equal(sum.status, "ok");
    s.equal(sum.turns, 1);
    s.equal(sum.avgCost, 500);
    s.equal(sum.estimatedTurnsRemaining, 15);
    s.ok(sum.categories);
    s.equal(sum.warnings, 0);
    s.equal(sum.criticals, 0);
  });

  it("reset clears all state", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 500);
    b.allocate(2, 300);
    b.reset();
    s.equal(b.used, 0);
    s.equal(b.turns.length, 0);
    s.equal(b.warnings.length, 0);
    s.equal(b.criticals.length, 0);
    s.equal(b.status(), "ok");
  });

  it("unknown action type falls back to misc category", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 100, "unknown_action");
    s.equal(b.categories.misc, 100);
  });

  it("no action argument falls back to misc category", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 100);
    s.equal(b.categories.misc, 100);
  });

  it("remaining never goes negative", () => {
    const b = new ContextBudget(500);
    b.allocate(1, 600);
    s.equal(b.remaining(), 0);
  });

  it("ratio is 1 when max is 0", () => {
    const b = new ContextBudget(0);
    s.equal(b.ratio(), 1);
  });

  it("estimatedTurnsRemaining is 0 when no turns", () => {
    const b = new ContextBudget(8000);
    s.equal(b.estimatedTurnsRemaining(), 0);
  });

  it("estimatedTurnsRemaining is 0 when avg cost is 0", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 0);
    s.equal(b.estimatedTurnsRemaining(), 0);
  });

  it("multiple allocations in same turn tracked correctly", () => {
    const b = new ContextBudget(8000, 0.75, 0.90, 2000);
    b.allocate(1, 500, "read_file");
    b.allocate(1, 300, "search");
    s.equal(b.used, 800);
    s.equal(b.fitsInTurn(1200), true);
    s.equal(b.fitsInTurn(1201), false);
  });

  it("warning entries contain turn, ratio, and remaining", () => {
    const b = new ContextBudget(1000, 0.5, 0.75);
    b.allocate(1, 501);
    s.equal(b.warnings.length, 1);
    s.equal(b.warnings[0].turn, 1);
    s.ok(b.warnings[0].ratio >= 0.5);
    s.ok(b.warnings[0].remaining > 0);
  });

  it("critical entries contain turn, ratio, and remaining", () => {
    const b = new ContextBudget(1000, 0.5, 0.75);
    b.allocate(1, 751);
    s.equal(b.criticals.length, 1);
    s.equal(b.criticals[0].turn, 1);
    s.ok(b.criticals[0].ratio >= 0.75);
    s.ok(b.criticals[0].remaining > 0);
  });

  it("category breakdown returns a copy (not internal reference)", () => {
    const b = new ContextBudget(8000);
    b.allocate(1, 100, "read_file");
    const copy = b.categoryBreakdown();
    copy.reads = 999;
    s.equal(b.categories.reads, 100);
  });
});
