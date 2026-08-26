#!/usr/bin/env node
import { performance } from "node:perf_hooks";

import { projectWorkforceHealthControl, publishWorkforceFacts, WorkforceHealthControlCache } from "../src/factory.js";

const workerCount = positiveInteger(process.argv[2] ?? 1_000, "worker count");
const workforce = syntheticWorkforce(workerCount);
const now = Date.parse("2026-08-01T12:00:00.000Z");

const publishStart = performance.now();
const published = publishWorkforceFacts(workforce, { now });
const publishMs = performance.now() - publishStart;

const controlStart = performance.now();
const control = projectWorkforceHealthControl({ workforce, now });
const controlMs = performance.now() - controlStart;

const repeatStart = performance.now();
const repeated = projectWorkforceHealthControl({ workforce, now: now + 1 });
const repeatMs = performance.now() - repeatStart;
if (control.artifactId !== repeated.artifactId) throw new Error("unchanged semantic health state churned artifact identity");
const cache = new WorkforceHealthControlCache();
cache.project({ scope: "benchmark", workforce, now });
const cacheStart = performance.now();
const cached = cache.project({ scope: "benchmark", workforce, now: now + 1 });
const cacheHitMs = performance.now() - cacheStart;
if (cached.artifactId !== control.artifactId) throw new Error("cached control diverged from complete evaluation");

console.log(JSON.stringify({
  schema: "bantam.factory.workforce-health-control-benchmark.v1",
  parameters: { workerCount, healthObservations: workforce.health.length, workforceEvents: workforce.events },
  publication: {
    milliseconds: round(publishMs),
    facts: published.fabric.operationCount,
    transactions: published.fabric.transactionCount,
    factsPerSecond: rate(published.fabric.operationCount, publishMs),
    projectionId: published.basis.projectionId,
  },
  control: {
    milliseconds: round(controlMs),
    repeatMilliseconds: round(repeatMs),
    cacheHitMilliseconds: round(cacheHitMs),
    workersPerSecond: rate(workerCount, controlMs),
    exceptions: control.summary.total,
    critical: control.summary.critical,
    warning: control.summary.warning,
    stableAcrossMeaninglessPoll: true,
    artifactId: control.artifactId,
  },
}, null, 2));

function syntheticWorkforce(count) {
  const profiles = [];
  const health = [];
  for (let index = 0; index < count; index += 1) {
    const ref = `worker:bench-${index}@1:sha256:${hex(index)}`;
    profiles.push({
      schema: 1,
      kind: "bantam.factory-worker-profile",
      id: `bench-${index}`,
      version: 1,
      runtime: "local",
      provider: "benchmark",
      model: `synthetic-${index % 8}`,
      reasoningEffort: null,
      transport: "memory",
      availabilityClass: "local-compute",
      capabilities: ["semantic.read", `lane.${index % 16}`],
      cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
      ref,
    });
    if (index % 20 === 2) continue;
    const unavailable = index % 20 === 0;
    const degraded = index % 20 === 1;
    health.push({
      workerRef: ref,
      condition: unavailable ? "unavailable" : degraded ? "degraded" : "available",
      code: unavailable ? "api-down" : degraded ? "latency-high" : "ready",
      ttlMs: 60_000,
      expiresAt: "2099-01-01T00:00:00.000Z",
      slotsAvailable: unavailable ? 0 : 1,
      quotaRemaining: unavailable ? 0 : 100,
      detail: null,
      eventId: `workforce-health-event:${hex(index + count)}`,
      time: "2026-08-01T11:59:00.000Z",
      current: true,
    });
  }
  return {
    schema: 1,
    kind: "bantam.factory-workforce",
    events: profiles.length + health.length,
    head: `workforce-head:${hex(count * 3)}`,
    profiles,
    qualifications: [],
    health,
  };
}

function hex(value) { return value.toString(16).padStart(64, "0").slice(-64); }
function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) throw new TypeError(`${label} must be an integer from 1 through 100000`);
  return parsed;
}
function round(value) { return Math.round(value * 100) / 100; }
function rate(count, milliseconds) { return Math.round(count / (milliseconds / 1_000)); }
