import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { admitCognitiveWorkpiece, installStandardCognitiveActuatorRack, issueCognitiveActuationPermit, sha256Bytes } from "../src/factory.js";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(files) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-machine-rack-")); roots.push(dir); for (const [name, source] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), source); } return dir; }
function drive(registry, actuator, workspace, targetPath, parameters) { const source = fs.readFileSync(path.join(workspace, targetPath)); const permit = issueCognitiveActuationPermit({ actuator, chassisFingerprint: "fixture:one", articleId: `drive-${actuator.id}`, targets: [{ path: targetPath, sha256: sha256Bytes(source) }] }); const workpiece = admitCognitiveWorkpiece({ answer: { status: "completed", permitId: permit.permitId, actuatorRef: actuator.ref, targetPath, parameters }, actuator, permit }); return registry.execute({ workspace, permit, workpiece }); }

describe("standard cognitive actuator rack", () => {
  it("installs three independently content-addressed machine tools", () => {
    const { registry, assets } = installStandardCognitiveActuatorRack();
    assert.equal(registry.list().length, 3);
    assert.deepEqual(Object.values(assets).map((asset) => asset.authority.release), ["withheld", "withheld", "withheld"]);
  });

  it("sets one existing JSON pointer without permitting prototype or shape expansion", () => {
    const workspace = root({ "package.json": '{"name":"fixture","config":{"port":80}}\n' });
    const { registry, assets } = installStandardCognitiveActuatorRack();
    drive(registry, assets.jsonPointerSet, workspace, "package.json", { pointer: "/config/port", "value-json": "8080" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "package.json"))).config.port, 8080);
    assert.throws(() => drive(registry, assets.jsonPointerSet, workspace, "package.json", { pointer: "/config/missing", "value-json": "true" }), /existing leaf/);
  });

  it("rewires exact static ESM edges while preserving unrelated literals", () => {
    const workspace = root({ "src/a.js": "import x from './old.js';\nexport { y } from './old.js';\nconst note = './old.js';\n" });
    const { registry, assets } = installStandardCognitiveActuatorRack();
    drive(registry, assets.esmImportRewrite, workspace, "src/a.js", { from: "./old.js", to: "./new.js", "expected-count": 2 });
    const source = fs.readFileSync(path.join(workspace, "src/a.js"), "utf8");
    assert.equal((source.match(/\.\/new\.js/g) ?? []).length, 2);
    assert.match(source, /note = '\.\/old\.js'/);
  });

  it("replaces one exported function body but preserves signature and neighbors", () => {
    const workspace = root({ "src/math.js": "const marker = 7;\nexport function twice(value) {\n  return value + value;\n}\nexport function untouched() { return marker; }\n" });
    const { registry, assets } = installStandardCognitiveActuatorRack();
    drive(registry, assets.exportedFunctionBody, workspace, "src/math.js", { "export-name": "twice", "replacement-body": "  if (!Number.isFinite(value)) throw new TypeError('finite value required');\n  return value * 2;" });
    const source = fs.readFileSync(path.join(workspace, "src/math.js"), "utf8");
    assert.match(source, /export function twice\(value\)/);
    assert.match(source, /return value \* 2/);
    assert.match(source, /export function untouched/);
    assert.equal((source.match(/function twice/g) ?? []).length, 1);
  });

  it("contains count mismatches and syntactically invalid body products before motion", () => {
    const workspace = root({ "src/a.js": "import x from './old.js';\n", "src/math.js": "export function twice(value) { return value + value; }\n" });
    const { registry, assets } = installStandardCognitiveActuatorRack();
    const beforeImport = fs.readFileSync(path.join(workspace, "src/a.js"), "utf8");
    assert.throws(() => drive(registry, assets.esmImportRewrite, workspace, "src/a.js", { from: "./old.js", to: "./new.js", "expected-count": 2 }), /count mismatch/);
    assert.equal(fs.readFileSync(path.join(workspace, "src/a.js"), "utf8"), beforeImport);
    const beforeFunction = fs.readFileSync(path.join(workspace, "src/math.js"), "utf8");
    assert.throws(() => drive(registry, assets.exportedFunctionBody, workspace, "src/math.js", { "export-name": "twice", "replacement-body": "return (;" }), /Unexpected token/);
    assert.equal(fs.readFileSync(path.join(workspace, "src/math.js"), "utf8"), beforeFunction);
  });
});
