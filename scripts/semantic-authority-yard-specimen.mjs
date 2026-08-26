#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectFactoryYard, projectMutationAuthorityControl, renderFactoryYard } from "../src/factory.js";

const artifactPath = path.resolve(process.argv[2] ?? ".bantam/factory-benchmarks/diffusiongemma-semantic-object-v10.json");
const reportDirectory = path.resolve(".bantam/factory-reports");
const reportPath = path.join(reportDirectory, "semantic-authority-control.html");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-semantic-yard-"));
try {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const control = projectMutationAuthorityControl({ artifact });
  const yard = projectFactoryYard({ root, semanticControls: [control] });
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, renderFactoryYard(yard, { liveEndpoint: "/api/yard", pollIntervalMs: 60_000, title: "BANTAM FACTORY · MUTATION AUTHORITY" }));
  console.log(JSON.stringify({ reportPath, artifactId: control.artifactId, exceptions: control.summary.total, semanticObjectId: control.basis.semanticObjectId }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
