#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectWorkforceHealthControl, WorkforceRegistry } from "../../src/factory.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-health-control-demo-"));
try {
  const workforce = new WorkforceRegistry(root);
  const healthy = install(workforce, "steady-chicken");
  const broken = install(workforce, "absent-chicken");
  const unreported = install(workforce, "new-chicken");
  workforce.observeHealth({ workerRef: healthy.ref, condition: "available", code: "endpoint-ready", slotsAvailable: 1, quotaRemaining: 500, ttlMs: 60_000 });
  workforce.observeHealth({ workerRef: broken.ref, condition: "unavailable", code: "api-down", slotsAvailable: 0, quotaRemaining: 0, ttlMs: 60_000 });

  const now = Date.now();
  const state = workforce.project({ now });
  const beforeEvents = state.events;
  const control = projectWorkforceHealthControl({ workforce: state, now });
  const repeated = projectWorkforceHealthControl({ workforce: workforce.project({ now: now + 1 }), now: now + 1 });

  console.log(JSON.stringify({
    demonstration: "real workforce journal -> Fact Fabric -> Datalog -> supervisor Pull packets",
    authority: control.authority,
    workforce: {
      head: state.head,
      eventsBeforeProjection: beforeEvents,
      eventsAfterProjection: workforce.project().events,
      workers: [healthy.ref, broken.ref, unreported.ref],
    },
    control: {
      artifactId: control.artifactId,
      stableAcrossMeaninglessPoll: control.artifactId === repeated.artifactId,
      inspectedAt: control.inspectedAt,
      factBasis: control.basis.factBasis,
      projectionId: control.basis.projectionId,
      summary: control.summary,
    },
    exceptions: control.exceptions.map((row) => ({
      exceptionId: row.exceptionId,
      workerRef: row.workerRef,
      code: row.code,
      severity: row.severity,
      packetId: row.packet.packetId,
      proofLeaves: flattenLeaves(row.proof).map((leaf) => ({
        fact: leaf.fact,
        producers: leaf.datoms.map((datom) => ({ src: datom.src, kind: datom.kind, txId: datom.txId })),
      })),
    })),
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function install(workforce, id) {
  return workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id,
    version: 1,
    runtime: "local",
    provider: "demo-plant",
    model: `${id}-model`,
    reasoningEffort: null,
    transport: "llama.cpp-native",
    availabilityClass: "local-compute",
    capabilities: ["semantic.read"],
    cost: { kind: "local", currency: "USD", inputPerMillion: null, outputPerMillion: null, fixedPerUse: null },
  });
}

function flattenLeaves(proof) {
  if (proof.base) return [proof];
  return proof.parents.flatMap(flattenLeaves);
}
