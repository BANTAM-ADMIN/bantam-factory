import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { admitCognitiveWorkpiece, CognitiveActuatorRegistry, defineCognitiveActuatorAsset, issueCognitiveActuationPermit, sha256Bytes } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const asset = () => ({ schema: 1, kind: "bantam.factory-cognitive-actuator", id: "uppercase-value", version: 1, title: "Uppercase fitted value", purpose: "Replace one exact token with its uppercased form.", operation: "uppercase-value", adapter: "bantam.factory.actuator.uppercase/v1", inputDie: { schema: 1, kind: "bantam.factory-actuator-input-die", fields: [{ name: "token", type: "string", required: true, minLength: 1, maxLength: 20 }], additionalProperties: false }, limits: { maxInputBytes: 1000, maxOutputBytes: 1000, maxTargets: 1 }, authority: { execute: "fitted-only", release: "withheld" }, presentation: { icon: "press", color: "amber", group: "actuation" } });

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-actuator-")); roots.push(root); fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src/a.txt"), "hello chicken\n"); return root; }

describe("cognitive actuator registry", () => {
  it("content-addresses strict machine tools and rejects schema expansion", () => {
    const machine = defineCognitiveActuatorAsset(asset());
    assert.match(machine.ref, /^cognitive-actuator:uppercase-value@1:sha256:/);
    assert.equal(Object.isFrozen(machine.inputDie.fields), true);
    assert.throws(() => defineCognitiveActuatorAsset({ ...asset(), surprise: true }), /unknown=\[surprise\]/);
    assert.throws(() => defineCognitiveActuatorAsset({ ...machine, title: "tampered" }), /content hash/);
  });

  it("admits only exact permit-bound workpieces through the machine die", () => {
    const machine = defineCognitiveActuatorAsset(asset());
    const permit = issueCognitiveActuationPermit({ actuator: machine, chassisFingerprint: "repo:one", articleId: "article-one", targets: [{ path: "src/a.txt", sha256: "a".repeat(64) }] });
    const answer = { status: "completed", permitId: permit.permitId, actuatorRef: machine.ref, targetPath: "src/a.txt", parameters: { token: "chicken" } };
    assert.equal(admitCognitiveWorkpiece({ answer, actuator: machine, permit }).disposition, "admitted-for-actuation");
    const escaped = admitCognitiveWorkpiece({ answer: { ...answer, targetPath: "test/a.test.js", parameters: { token: "chicken", shell: "rm" } }, actuator: machine, permit });
    assert.deepEqual(escaped.reasons, ["target-out-of-scope", "unknown-parameters:shell"]);
  });

  it("executes one fitted operation atomically while withholding release", () => {
    const root = fixture(), registry = new CognitiveActuatorRegistry();
    const machine = registry.install(asset(), ({ source, parameters }) => source.replace(parameters.token, parameters.token.toUpperCase()));
    const before = fs.readFileSync(path.join(root, "src/a.txt"));
    const permit = issueCognitiveActuationPermit({ actuator: machine, chassisFingerprint: "repo:one", articleId: "article-one", targets: [{ path: "src/a.txt", sha256: sha256Bytes(before) }] });
    const workpiece = admitCognitiveWorkpiece({ answer: { status: "completed", permitId: permit.permitId, actuatorRef: machine.ref, targetPath: "src/a.txt", parameters: { token: "chicken" } }, actuator: machine, permit });
    const record = registry.execute({ workspace: root, permit, workpiece });
    assert.equal(fs.readFileSync(path.join(root, "src/a.txt"), "utf8"), "hello CHICKEN\n");
    assert.equal(record.releaseAuthority, "withheld");
    assert.match(record.actuationId, /^cognitive-actuation-record:sha256:/);
    assert.throws(() => registry.execute({ workspace: root, permit, workpiece }), /stale target baseline/);
  });

  it("fails before motion on stale bytes, symlinks, malformed output, and adapter collisions", () => {
    const root = fixture(), registry = new CognitiveActuatorRegistry();
    const adapter = ({ source }) => source.toUpperCase(), machine = registry.install(asset(), adapter);
    assert.equal(registry.install(asset(), adapter).ref, machine.ref);
    assert.throws(() => registry.install(asset(), () => "other"), /adapter identity changed/);
    const permit = issueCognitiveActuationPermit({ actuator: machine, chassisFingerprint: "repo:one", articleId: "article-one", targets: [{ path: "src/a.txt", sha256: "b".repeat(64) }] });
    const workpiece = admitCognitiveWorkpiece({ answer: { status: "completed", permitId: permit.permitId, actuatorRef: machine.ref, targetPath: "src/a.txt", parameters: { token: "hello" } }, actuator: machine, permit });
    assert.throws(() => registry.execute({ workspace: root, permit, workpiece }), /stale target baseline/);
    assert.equal(fs.readFileSync(path.join(root, "src/a.txt"), "utf8"), "hello chicken\n");
  });
});
