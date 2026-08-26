#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FactoryStore, projectFactoryYard, renderFactoryYard, WorkforceRegistry } from "../src/factory.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-health-yard-"));
const reportDirectory = path.resolve(".bantam/factory-reports");
const reportPath = path.join(reportDirectory, "workforce-health-control.html");
try {
  new FactoryStore(root).create({
    jobId: "semantic-control-line",
    routeRef: "route:semantic-control-specimen",
    initialProductRevision: "tree:semantic-control-specimen",
  });
  const workforce = new WorkforceRegistry(root);
  const worker = workforce.install({
    schema: 1,
    kind: "bantam.factory-worker-profile",
    id: "api-chicken",
    version: 1,
    runtime: "api",
    provider: "specimen",
    model: "factory-api-worker",
    reasoningEffort: null,
    transport: "openai-compatible",
    availabilityClass: "remote-api",
    capabilities: ["semantic.read"],
    cost: { kind: "metered", currency: "USD", inputPerMillion: 1, outputPerMillion: 4, fixedPerUse: 0 },
  });
  workforce.observeHealth({
    workerRef: worker.ref,
    condition: "unavailable",
    code: "api-down",
    slotsAvailable: 0,
    quotaRemaining: 0,
    ttlMs: 60_000,
    detail: "Specimen outage for semantic andon visual inspection.",
  });
  const yard = projectFactoryYard({ root, now: Date.now(), idleAfterMs: 1 });
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, renderFactoryYard(yard, { liveEndpoint: "/api/yard", title: "BANTAM FACTORY · SEMANTIC ANDON" }));
  console.log(JSON.stringify({ reportPath, artifactId: yard.factControl.artifactId, exceptions: yard.factControl.summary.total }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
