import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import {
  auditFactoryShadowSchedule,
  DEFAULT_SHADOW_SCHEDULE_POLICY,
  defineShadowSchedulePolicy,
  FactoryStore,
  projectFactoryShadowSchedule,
  WorkforceRegistry,
} from "../src/factory.js";

const roots = new Set();
const stationRef = `station:shadow-capacity@1:sha256:${"c".repeat(64)}`;

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function plant({ jobs = 2, slots = 1, p95Ms = 10_000, ttlMs = 60_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-shadow-schedule-"));
  roots.add(root);
  const writers = [];
  for (let index = 1; index <= jobs; index += 1) {
    const jobId = `article-${index}`;
    const routeRef = `route:capacity-cell:sha256:${index}`;
    const writer = new FactoryStore(root).create({ jobId, routeRef, initialProductRevision: `tree:${jobId}` });
    writer.append("route.validated", { routeRef });
    writer.append("route.plan", {
      routeRef,
      taskFamily: "capacity-specimen",
      stations: [{ id: "diagnosis", stationRef, title: "Capacity diagnosis", workerKind: "model", capabilities: ["code.diagnose"], authority: ["workspace.read"] }],
      edges: [],
    });
    writers.push(writer);
  }
  const workforce = new WorkforceRegistry(root);
  const worker = workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id: "terra-capacity",
    version: 1,
    runtime: "codex",
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    transport: "codex-app-server",
    availabilityClass: "remote-api",
    capabilities: ["code.diagnose"],
    cost: { kind: "subscription", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
  workforce.qualify({
    workerRef: worker.ref,
    stationRef,
    taskFamily: "capacity-specimen",
    status: "qualified",
    evidence: { articles: 10, passes: 10, escapes: 0, falseStops: 0, p95Ms, meanTotalTokens: 20_000, expectedCostUsd: 0.1 },
    reason: "shadow capacity specimen",
  });
  workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "transport-ok", ttlMs, slotsAvailable: slots });
  return { root, writers, workforce, worker };
}

function stream() {
  let output = "";
  return { write(value) { output += String(value); }, text() { return output; } };
}

describe("factory shadow capacity schedule", () => {
  it("serializes ready work on one observed worker slot without mutating production", () => {
    const { root, writers } = plant({ jobs: 2, slots: 1, p95Ms: 10_000 });
    const counts = writers.map((writer) => writer.events.length);
    const now = Date.now();
    const schedule = projectFactoryShadowSchedule({ root, now });
    assert.equal(schedule.authority, "observe-only");
    assert.equal(schedule.summary.planned, 2);
    assert.equal(schedule.summary.deferred, 0);
    assert.equal(schedule.summary.spanMs, 20_000);
    assert.equal(schedule.allocations[0].slot, 1);
    assert.equal(schedule.allocations[1].slot, 1);
    assert.equal(schedule.allocations[1].plannedStart, schedule.allocations[0].plannedEnd);
    assert.equal(auditFactoryShadowSchedule(schedule).ok, true);
    assert.deepEqual(writers.map((writer) => writer.events.length), counts);
  });

  it("uses bounded parallel lanes when two current slots are observed", () => {
    const { root } = plant({ jobs: 3, slots: 2, p95Ms: 12_000 });
    const schedule = projectFactoryShadowSchedule({ root, now: Date.now() });
    assert.equal(schedule.summary.planned, 3);
    assert.equal(schedule.summary.spanMs, 24_000);
    assert.deepEqual(schedule.allocations.map((row) => row.slot), [1, 2, 1]);
    assert.equal(schedule.allocations[0].plannedStart, schedule.allocations[1].plannedStart);
    assert.equal(schedule.allocations[2].plannedStart, schedule.allocations[0].plannedEnd);
    assert.deepEqual(schedule.allocations.map((row) => row.capacity), [2, 2, 2]);
    assert.ok(schedule.allocations.every((row) => row.capacityEvidence === "current-worker-health"));
  });

  it("rounds fractional p95 evidence up to a schedulable whole millisecond", () => {
    const { root } = plant({ jobs: 1, slots: 1, p95Ms: 10_000.25 });
    const schedule = projectFactoryShadowSchedule({ root, now: Date.now() });
    assert.equal(schedule.allocations[0].durationMs, 10_001);
    assert.equal(schedule.summary.spanMs, 10_001);
  });

  it("defers expired capacity and unknown duration instead of assuming resources", () => {
    const expired = plant({ jobs: 1, slots: 1, p95Ms: 10_000, ttlMs: 1 });
    const expiredSchedule = projectFactoryShadowSchedule({ root: expired.root, now: Date.now() + 10_000 });
    assert.equal(expiredSchedule.summary.planned, 0);
    assert.equal(expiredSchedule.deferred[0].code, "capacity-unknown");

    const unknown = plant({ jobs: 1, slots: 1, p95Ms: null });
    const unknownSchedule = projectFactoryShadowSchedule({ root: unknown.root });
    assert.equal(unknownSchedule.summary.planned, 0);
    assert.equal(unknownSchedule.deferred[0].code, "duration-unknown");
  });

  it("content-addresses strict policy and rejects double-booked or changed plans", () => {
    const { ref: ignored, ...policyBody } = DEFAULT_SHADOW_SCHEDULE_POLICY;
    assert.equal(defineShadowSchedulePolicy(policyBody).ref, DEFAULT_SHADOW_SCHEDULE_POLICY.ref);
    assert.throws(() => defineShadowSchedulePolicy({ ...DEFAULT_SHADOW_SCHEDULE_POLICY, surprise: true }), /fields mismatch/);
    const { root } = plant({ jobs: 2, slots: 1 });
    const schedule = projectFactoryShadowSchedule({ root });
    const tampered = JSON.parse(JSON.stringify(schedule));
    tampered.allocations[1].plannedStart = tampered.allocations[0].plannedStart;
    tampered.allocations[1].plannedEnd = new Date(Date.parse(tampered.allocations[1].plannedStart) + tampered.allocations[1].durationMs).toISOString();
    assert.throws(() => auditFactoryShadowSchedule(tampered), /double-books/);
  });

  it("rejects false summary counts, resource totals, spans, and schema expansion", () => {
    const { root } = plant({ jobs: 2, slots: 1 });
    const schedule = projectFactoryShadowSchedule({ root });
    for (const [field, value] of [["ready", 3], ["planned", 1], ["deferred", 1], ["resources", 2], ["spanMs", 1]]) {
      const tampered = JSON.parse(JSON.stringify(schedule));
      tampered.summary[field] = value;
      assert.throws(() => auditFactoryShadowSchedule(tampered), /summary mismatch/);
    }
    const expanded = JSON.parse(JSON.stringify(schedule));
    expanded.summary.optimistic = true;
    assert.throws(() => auditFactoryShadowSchedule(expanded), /summary fields mismatch/);
    const malformed = JSON.parse(JSON.stringify(schedule));
    malformed.summary.planned = "2";
    assert.throws(() => auditFactoryShadowSchedule(malformed), /must be a non-negative integer/);
  });

  it("rejects unsupported lane capacity, inconsistent worker evidence, and policy-horizon escapes", () => {
    const { root } = plant({ jobs: 2, slots: 2, p95Ms: 10_000 });
    const schedule = projectFactoryShadowSchedule({ root });
    const outsideCapacity = JSON.parse(JSON.stringify(schedule));
    outsideCapacity.allocations[0].slot = 3;
    assert.throws(() => auditFactoryShadowSchedule(outsideCapacity), /slot exceeds observed capacity/);
    const inconsistent = JSON.parse(JSON.stringify(schedule));
    inconsistent.allocations[1].capacity = 3;
    assert.throws(() => auditFactoryShadowSchedule(inconsistent), /worker capacity is inconsistent/);

    const { ref: ignored, ...body } = DEFAULT_SHADOW_SCHEDULE_POLICY;
    const boundedPolicy = defineShadowSchedulePolicy({ ...body, version: 2, maxHorizonMs: 10_000 });
    const bounded = projectFactoryShadowSchedule({ root, policy: boundedPolicy });
    const beyondHorizon = JSON.parse(JSON.stringify(bounded));
    beyondHorizon.allocations[0].durationMs = 10_001;
    beyondHorizon.allocations[0].plannedEnd = new Date(Date.parse(beyondHorizon.allocations[0].plannedStart) + 10_001).toISOString();
    assert.throws(() => auditFactoryShadowSchedule(beyondHorizon), /exceeds policy horizon/);
  });

  it("requires the embedded policy identity and canonical observation timestamps", () => {
    const { root } = plant({ jobs: 1 });
    const schedule = projectFactoryShadowSchedule({ root });
    const missingPolicyRef = JSON.parse(JSON.stringify(schedule));
    delete missingPolicyRef.policy.ref;
    assert.throws(() => auditFactoryShadowSchedule(missingPolicyRef), /embedded shadow schedule policy reference mismatch/);
    const futureDispatch = JSON.parse(JSON.stringify(schedule));
    futureDispatch.dispatchGeneratedAt = new Date(Date.parse(futureDispatch.generatedAt) + 1).toISOString();
    assert.throws(() => auditFactoryShadowSchedule(futureDispatch), /cannot predate/);
    const noncanonical = JSON.parse(JSON.stringify(schedule));
    noncanonical.generatedAt = new Date(noncanonical.generatedAt).toUTCString();
    assert.throws(() => auditFactoryShadowSchedule(noncanonical), /generatedAt is invalid/);
  });

  it("exposes the observe-only capacity plan through the CLI", async () => {
    const { root } = plant({ jobs: 2, slots: 1 });
    const stdout = stream();
    const stderr = stream();
    assert.equal(await runFactoryCommand(["factory", "schedule", "--factory-home", root, "--json"], { stdout, stderr }), 0);
    const schedule = JSON.parse(stdout.text());
    assert.equal(schedule.kind, "bantam.factory-shadow-schedule");
    assert.equal(schedule.summary.planned, 2);
    assert.equal(schedule.authority, "observe-only");
    assert.equal(stderr.text(), "");
  });

  it("returns a monitoring failure when the CLI must defer ready work", async () => {
    const { root } = plant({ jobs: 1, slots: 1, p95Ms: null });
    const stdout = stream();
    const stderr = stream();
    assert.equal(await runFactoryCommand(["factory", "schedule", "--factory-home", root, "--json"], { stdout, stderr }), 1);
    const schedule = JSON.parse(stdout.text());
    assert.equal(schedule.summary.planned, 0);
    assert.equal(schedule.summary.deferred, 1);
    assert.equal(schedule.deferred[0].code, "duration-unknown");
    assert.equal(stderr.text(), "");
  });
});
