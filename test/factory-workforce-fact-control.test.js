import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { projectWorkforceHealthControl, publishWorkforceFacts, WorkforceHealthControlCache, WorkforceRegistry } from "../src/factory.js";

const temporary = new Set();

afterEach(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
  temporary.clear();
});

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-workforce-facts-"));
  temporary.add(root);
  return new WorkforceRegistry(root);
}

function install(workforce, id = "fact-chicken") {
  return workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id,
    version: 1,
    runtime: "local",
    provider: "plant",
    model: `${id}-model`,
    reasoningEffort: null,
    transport: "llama.cpp-native",
    availabilityClass: "local-compute",
    capabilities: ["contract.extract", "semantic.read"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
}

describe("Fact Fabric workforce health control", () => {
  it("publishes real workforce records with exact profile and event provenance", () => {
    const workforce = registry();
    const worker = install(workforce);
    workforce.observeHealth({
      workerRef: worker.ref,
      condition: "available",
      code: "endpoint-ready",
      slotsAvailable: 2,
      quotaRemaining: 100,
      ttlMs: 60_000,
    });
    const state = workforce.project();
    const beforeEvents = state.events;
    const published = publishWorkforceFacts(state, { now: Date.now() });

    assert.equal(published.view.has(worker.ref, "worker/installed", true), true);
    assert.equal(published.view.has(worker.ref, "worker/capability", "semantic.read"), true);
    assert.equal(published.view.has(worker.ref, "health/slots-available", 2), true);
    assert.equal(published.view.has(worker.ref, "health/quota-remaining", 100), true);
    assert.equal(published.fabric.provenance(worker.ref, "health/condition", "available")[0].src, state.health[0].eventId);
    assert.equal(workforce.project().events, beforeEvents, "read adapter must not append workforce events");
    assert.deepEqual(published.basis.workforceHead, state.head);
  });

  it("keeps a healthy current worker off the semantic andon board", () => {
    const workforce = registry();
    const worker = install(workforce);
    workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "ready", slotsAvailable: 1, quotaRemaining: 5, ttlMs: 60_000 });
    const now = Date.now();
    const first = projectWorkforceHealthControl({ workforce: workforce.project({ now }), now });
    const second = projectWorkforceHealthControl({ workforce: workforce.project({ now: now + 1 }), now: now + 1 });

    assert.equal(first.summary.total, 0);
    assert.deepEqual(first.exceptions, []);
    assert.equal(first.artifactId, second.artifactId, "polling inside one semantic health state must not churn artifact identity");
    assert.notEqual(first.inspectedAt, second.inspectedAt, "inspection time remains visible metadata");
    assert.equal(first.authority, "observe-only");
  });

  it("derives separate unavailable, capacity, and quota exceptions with exact proof leaves", () => {
    const workforce = registry();
    const worker = install(workforce, "broken-chicken");
    workforce.observeHealth({
      workerRef: worker.ref,
      condition: "unavailable",
      code: "api-down",
      slotsAvailable: 0,
      quotaRemaining: 0,
      ttlMs: 60_000,
      detail: "connection refused",
    });
    const now = Date.now();
    const state = workforce.project({ now });
    const control = projectWorkforceHealthControl({ workforce: state, now });
    const codes = control.exceptions.map((row) => row.code).sort();

    assert.deepEqual(codes, ["capacity-zero", "health-unavailable", "quota-zero"]);
    assert.equal(control.summary.total, 3);
    assert.equal(control.summary.critical, 3);
    assert.match(control.artifactId, /^workforce-health-control:sha256:/);
    for (const exception of control.exceptions) {
      assert.equal(exception.workerRef, worker.ref);
      assert.equal(exception.packet.data.workerRef, worker.ref);
      assert.equal(exception.packet.data.code, exception.code);
      assert.equal(exception.packet.data.sourceBasis.workforceHead, state.head);
      assert.equal(exception.packet.data.proof.parents.some((parent) => parent.datoms.some((datom) => datom.src === state.health[0].eventId)), true);
      assert.equal(exception.packet.data.$evidence.code[0].src, "rule:worker-health-out-of-control@1");
    }
  });

  it("distinguishes missing, expired, and degraded observations", () => {
    const missingRegistry = registry();
    const missing = install(missingRegistry, "missing-chicken");
    const missingState = missingRegistry.project();
    const missingControl = projectWorkforceHealthControl({ workforce: missingState, now: Date.now() });
    assert.deepEqual(missingControl.exceptions.map((row) => [row.workerRef, row.code]), [[missing.ref, "health-missing"]]);
    assert.equal(missingControl.exceptions[0].proof.parents.some((parent) => parent.datoms[0].kind === "deterministic-absence-at-basis"), true);

    const expiredRegistry = registry();
    const expired = install(expiredRegistry, "expired-chicken");
    expiredRegistry.observeHealth({ workerRef: expired.ref, condition: "available", code: "was-ready", slotsAvailable: 1, ttlMs: 1 });
    const observed = expiredRegistry.project().health[0];
    const expiredNow = Date.parse(observed.expiresAt) + 1;
    const beforeExpiry = projectWorkforceHealthControl({ workforce: expiredRegistry.project({ now: expiredNow - 2 }), now: expiredNow - 2 });
    const afterExpiry = projectWorkforceHealthControl({ workforce: expiredRegistry.project({ now: expiredNow }), now: expiredNow });
    assert.deepEqual(afterExpiry.exceptions.map((row) => row.code), ["health-expired"]);
    assert.notEqual(beforeExpiry.artifactId, afterExpiry.artifactId, "crossing a TTL boundary must create a new semantic artifact");

    const degradedRegistry = registry();
    const degraded = install(degradedRegistry, "degraded-chicken");
    degradedRegistry.observeHealth({ workerRef: degraded.ref, condition: "degraded", code: "latency-high", slotsAvailable: 1, ttlMs: 60_000 });
    const degradedNow = Date.now();
    const degradedControl = projectWorkforceHealthControl({ workforce: degradedRegistry.project({ now: degradedNow }), now: degradedNow });
    assert.deepEqual(degradedControl.exceptions.map((row) => row.code), ["health-degraded"]);
    assert.equal(degradedControl.exceptions[0].severity, "warning");
  });

  it("fails closed on malformed workforce projections", () => {
    assert.throws(() => publishWorkforceFacts(null), /workforce projection/);
    assert.throws(() => publishWorkforceFacts({ schema: 1, kind: "bantam.factory-workforce" }), /arrays are required/);
    assert.throws(() => projectWorkforceHealthControl({ workforce: { schema: 2 }, now: Date.now() }), /workforce projection/);
  });

  it("caches unchanged semantic state and invalidates on journal or TTL changes", () => {
    const workforce = registry();
    const worker = install(workforce, "cached-chicken");
    workforce.observeHealth({ workerRef: worker.ref, condition: "available", code: "ready", slotsAvailable: 1, ttlMs: 5_000 });
    const observed = workforce.project().health[0];
    const beforeExpiry = Date.parse(observed.expiresAt) - 1;
    const cache = new WorkforceHealthControlCache({ limit: 2 });
    const retainedState = workforce.project({ now: beforeExpiry });
    const first = cache.project({ scope: "plant-a", workforce: retainedState, now: beforeExpiry });
    const hit = cache.project({ scope: "plant-a", workforce: retainedState, now: beforeExpiry });
    assert.equal(hit, first);
    assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 1, limit: 2 });

    const expiredAt = Date.parse(observed.expiresAt) + 1;
    const expired = cache.project({ scope: "plant-a", workforce: retainedState, now: expiredAt });
    assert.notEqual(expired, first);
    assert.deepEqual(expired.exceptions.map((row) => row.code), ["health-expired"]);
    workforce.observeHealth({ workerRef: worker.ref, condition: "unavailable", code: "down", slotsAvailable: 0, ttlMs: 5_000 });
    const changed = cache.project({ scope: "plant-a", workforce: workforce.project(), now: Date.now() });
    assert.notEqual(changed.artifactId, expired.artifactId);
    assert.equal(cache.stats().misses, 3);
  });
});
