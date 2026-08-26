import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { defineCognitiveActuationRecipe, installStandardCognitiveActuatorRack, projectCognitiveActuationRecipe, runCognitiveActuationRecipe } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-actuation-cell-")); roots.push(root); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "package.json"), '{"config":{"port":80}}\n'); fs.writeFileSync(path.join(root, "src/a.js"), "import x from './old.js';\nexport function twice(v) { return v + v; }\n"); return root; }
function recipe() { return { schema: 1, kind: "bantam.factory-cognitive-actuation-recipe", id: "three-peck-upgrade", version: 1, title: "Three peck upgrade", task: "Update configuration, dependency edge, and function behavior.", steps: [
  { id: "configure", actuator: "json-pointer-set@1", targetPath: "package.json", parameters: { pointer: "/config/port", "value-json": "8080" }, verification: "verify-config" },
  { id: "rewire", actuator: "esm-import-rewrite@1", targetPath: "src/a.js", parameters: { from: "./old.js", to: "./new.js", "expected-count": 1 }, verification: "verify-import" },
  { id: "harden", actuator: "exported-function-body@1", targetPath: "src/a.js", parameters: { "export-name": "twice", "replacement-body": "  if (!Number.isFinite(v)) throw new TypeError('finite');\n  return v * 2;" }, verification: "verify-function" },
], finalVerification: "verify-all" }; }
const passVerifier = async (_root, command) => ({ pass: true, status: "pass", exitCode: 0, durationMs: 1, command, detail: "ok" });

describe("cognitive actuation production cell", () => {
  it("compiles one strict recipe against installed machines and projects its line", () => {
    const { registry } = installStandardCognitiveActuatorRack(), compiled = defineCognitiveActuationRecipe(recipe(), { registry });
    assert.match(compiled.ref, /^cognitive-actuation-recipe:three-peck-upgrade@1:sha256:/);
    assert.deepEqual(compiled.steps.map((step) => step.operation), ["json-pointer-set", "esm-import-rewrite", "exported-function-body"]);
    assert.deepEqual(projectCognitiveActuationRecipe(compiled).nodes.map((node) => node.state), ["planned", "planned", "planned"]);
    assert.throws(() => defineCognitiveActuationRecipe({ ...recipe(), surprise: true }, { registry }), /unknown=\[surprise\]/);
  });

  it("moves one chassis through three permits, workpieces, actuators, and gauges", async () => {
    const root = workspace(), { registry } = installStandardCognitiveActuatorRack();
    const result = await runCognitiveActuationRecipe({ workspace: root, recipe: recipe(), registry, verifier: passVerifier });
    assert.equal(result.status, "released", JSON.stringify(result.failure));
    assert.equal(result.permits.length, 3); assert.equal(result.workpieces.length, 3); assert.equal(result.actuations.length, 3); assert.equal(result.verifications.length, 4);
    assert.equal(new Set(result.permits.map((permit) => permit.chassisFingerprint)).size, 3, "every station must bind the current chassis");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"))).config.port, 8080);
    const source = fs.readFileSync(path.join(root, "src/a.js"), "utf8"); assert.match(source, /\.\/new\.js/); assert.match(source, /return v \* 2/);
    const projection = projectCognitiveActuationRecipe(result.recipe, { frames: result.frames });
    assert.equal(projection.status, "released"); assert.deepEqual(projection.nodes.map((node) => node.state), ["released", "released", "released"]);
  });

  it("rolls the entire article back when a downstream gauge rejects one station", async () => {
    const root = workspace(), beforePackage = fs.readFileSync(path.join(root, "package.json")), beforeSource = fs.readFileSync(path.join(root, "src/a.js")), { registry } = installStandardCognitiveActuatorRack();
    const verifier = async (_root, command) => ({ pass: command !== "verify-import", status: command === "verify-import" ? "fail" : "pass", exitCode: command === "verify-import" ? 1 : 0, durationMs: 1, command, detail: "gauge" });
    const result = await runCognitiveActuationRecipe({ workspace: root, recipe: recipe(), registry, verifier });
    assert.equal(result.status, "contained"); assert.equal(result.failure.stepId, "rewire"); assert.equal(result.failure.code, "verification-failed"); assert.equal(result.rollback.exact, true);
    assert.deepEqual(fs.readFileSync(path.join(root, "package.json")), beforePackage); assert.deepEqual(fs.readFileSync(path.join(root, "src/a.js")), beforeSource);
    assert.equal(result.finalFingerprint, result.baselineFingerprint);
  });

  it("contains an expanded cognitive product before actuation and restores prior released steps", async () => {
    const root = workspace(), before = fs.readFileSync(path.join(root, "package.json")), { registry } = installStandardCognitiveActuatorRack();
    const worker = async ({ step, actuator, permit }) => ({ status: "completed", permitId: permit.permitId, actuatorRef: actuator.ref, targetPath: step.targetPath, parameters: step.id === "rewire" ? { ...step.parameters, shell: "nope" } : step.parameters });
    const result = await runCognitiveActuationRecipe({ workspace: root, recipe: recipe(), registry, worker, verifier: passVerifier });
    assert.equal(result.status, "contained"); assert.equal(result.failure.code, "workpiece-contained"); assert.equal(result.actuations.length, 1); assert.deepEqual(fs.readFileSync(path.join(root, "package.json")), before);
  });

  it("detects an out-of-band test edit after green gauges and restores the complete workspace", async () => {
    const root = workspace(), testPath = path.join(root, "test.js"); fs.writeFileSync(testPath, "original gauge\n"); const before = fs.readFileSync(testPath);
    let tampered = false;
    const worker = async ({ step, actuator, permit }) => { if (!tampered) { fs.writeFileSync(testPath, "weakened gauge\n"); tampered = true; } return { status: "completed", permitId: permit.permitId, actuatorRef: actuator.ref, targetPath: step.targetPath, parameters: step.parameters }; };
    const { registry } = installStandardCognitiveActuatorRack();
    const result = await runCognitiveActuationRecipe({ workspace: root, recipe: recipe(), registry, worker, verifier: passVerifier });
    assert.equal(result.status, "contained"); assert.equal(result.failure.code, "scope-audit-failed"); assert.equal(result.rollback.exact, true); assert.deepEqual(fs.readFileSync(testPath), before);
  });
});
