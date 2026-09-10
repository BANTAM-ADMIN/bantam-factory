import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkEditedApi } from "../src/api-check.js";

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-api-check-"));
  tempDirs.push(directory);
  return directory;
}

function write(directory, relativePath, source) {
  const destination = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
  return destination;
}

describe("edited API checker", () => {
  it("does not mistake CommonJS exports for an empty ESM export list", async () => {
    const workspace = fixture();
    write(workspace, "harness.cjs", 'function withGame() { return 42; }\nmodule.exports = { withGame };\n');
    const entry = write(workspace, "check.mjs", 'import { withGame } from "./harness.cjs";\nexport const result = withGame();\n');
    assert.equal((await import(pathToFileURL(entry).href)).result, 42);
    assert.deepEqual(checkEditedApi(workspace, "check.mjs"), []);
  });

  it("CommonJS-looking comments and local objects do not hide missing ESM exports", () => {
    const workspace = fixture();
    write(workspace, "module.mjs", '// module.exports = { imaginary };\nconst module = { exports: {} };\nvoid module.exports;\nexport const real = 42;\n');
    write(workspace, "check.mjs", 'import { imaginary } from "./module.mjs";\n');
    assert.match(checkEditedApi(workspace, "check.mjs")[0], /imaginary.*exports: real/);
  });

  it("accepts existing named exports and instance methods", () => {
    const workspace = fixture();
    write(workspace, "client.js", "export class Client { run() {} }\nexport const version = 1;\n");
    write(
      workspace,
      "main.js",
      'import { Client, version } from "./client.js";\nconst client = new Client();\nclient.run();\nvoid version;\n',
    );

    assert.deepEqual(checkEditedApi(workspace, "main.js"), []);
  });

  it("warns for missing named exports and methods and deduplicates method warnings", () => {
    const workspace = fixture();
    write(workspace, "client.js", "export class Client { run() {} }\n");
    write(
      workspace,
      "main.js",
      [
        'import { Client, imagined } from "./client.js";',
        "const client = new Client();",
        "client.models();",
        "client.models();",
        "void imagined;",
        "",
      ].join("\n"),
    );

    const warnings = checkEditedApi(workspace, "main.js");

    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /"imagined" is imported .* exports: Client/);
    assert.match(warnings[1], /client\.models\(\).*class Client has no method "models"/);
  });

  it("resolves exported class aliases, inherited methods, and callable fields", () => {
    const workspace = fixture();
    write(
      workspace,
      "client.js",
      [
        "class Base { inherited() {} }",
        "class Client extends Base {",
        "  field = () => true;",
        "}",
        "export { Client as PublicClient };",
        "",
      ].join("\n"),
    );
    write(
      workspace,
      "main.js",
      [
        'import { PublicClient } from "./client.js";',
        "const client = new PublicClient();",
        "client.inherited();",
        "client.field();",
        "client.imagined();",
        "",
      ].join("\n"),
    );

    const warnings = checkEditedApi(workspace, "main.js");

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /class PublicClient has no method "imagined"/);
  });

  it("does not claim completeness for a class with an unresolved superclass", () => {
    const workspace = fixture();
    write(
      workspace,
      "client.js",
      'import { FrameworkClient } from "framework";\nexport class Client extends FrameworkClient { own() {} }\n',
    );
    write(
      workspace,
      "main.js",
      'import { Client } from "./client.js";\nconst client = new Client();\nclient.frameworkMethod();\n',
    );

    assert.deepEqual(checkEditedApi(workspace, "main.js"), []);
  });

  it("does not report a missing export when an export-star target is unresolved statically", () => {
    const workspace = fixture();
    write(workspace, "inner.js", "export class Client { run() {} }\n");
    write(workspace, "index.js", 'export * from "./inner.js";\n');
    write(
      workspace,
      "main.js",
      'import { Client } from "./index.js";\nconst client = new Client();\nclient.run();\n',
    );

    assert.deepEqual(checkEditedApi(workspace, "main.js"), []);
  });

  it("checks direct construction but avoids calls through shadowed bindings", () => {
    const workspace = fixture();
    write(workspace, "client.js", "export class Client { run() {} }\n");
    write(
      workspace,
      "direct.js",
      'import { Client } from "./client.js";\nnew Client().directlyImagined();\n',
    );
    write(
      workspace,
      "main.js",
      [
        'import { Client } from "./client.js";',
        "const client = new Client();",
        "function useOther(client) { client.notTheImportedClient(); }",
        "function buildOther(Client) {",
        "  const other = new Client();",
        "  other.notTheImportedClass();",
        "}",
        "void client;",
        "",
      ].join("\n"),
    );

    const warnings = checkEditedApi(workspace, "direct.js");

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /new Client\(\)\.directlyImagined\(\)/);
    assert.deepEqual(checkEditedApi(workspace, "main.js"), []);
  });

  it("returns no warnings for unreadable, malformed, missing, or non-file input", () => {
    const workspace = fixture();
    write(workspace, "broken.js", "export const = ;\n");
    fs.mkdirSync(path.join(workspace, "directory.js"));

    assert.deepEqual(checkEditedApi(workspace, "broken.js"), []);
    assert.deepEqual(checkEditedApi(workspace, "missing.js"), []);
    assert.deepEqual(checkEditedApi(workspace, "directory.js"), []);
    assert.deepEqual(checkEditedApi(path.join(workspace, "missing-workspace"), "main.js"), []);
    assert.deepEqual(checkEditedApi("", "main.js"), []);
    assert.deepEqual(checkEditedApi(workspace, null), []);
  });

  it("refuses edited paths and imported-module symlinks that escape the workspace", () => {
    const root = fixture();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    write(root, "outside-client.js", "export class Other {}\n");
    write(
      root,
      "outside-main.js",
      'import { Missing } from "./outside-client.js";\nvoid Missing;\n',
    );

    assert.deepEqual(checkEditedApi(workspace, "../outside-main.js"), []);

    fs.symlinkSync(path.join(root, "outside-main.js"), path.join(workspace, "linked-main.js"));
    assert.deepEqual(checkEditedApi(workspace, "linked-main.js"), []);

    fs.symlinkSync(path.join(root, "outside-client.js"), path.join(workspace, "client.js"));
    write(workspace, "main.js", 'import { Missing } from "./client.js";\nvoid Missing;\n');
    assert.deepEqual(checkEditedApi(workspace, "main.js"), []);
  });

  it("skips oversized source files without reading them", (t) => {
    const workspace = fixture();
    const oversized = path.join(workspace, "oversized.js");
    const descriptor = fs.openSync(oversized, "w");
    fs.ftruncateSync(descriptor, 17 * 1024 * 1024);
    fs.closeSync(descriptor);
    let reads = 0;
    const originalRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args) => {
      reads++;
      return originalRead(...args);
    });

    assert.deepEqual(checkEditedApi(workspace, "oversized.js"), []);
    assert.equal(reads, 0);
  });
});
