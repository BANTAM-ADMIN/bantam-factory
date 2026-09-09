import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/executor.js";
import { editPaths, editSucceeded, isEditAction } from "../src/edit-actions.js";
import { normalizeWorkspaceAction } from "../src/workspace-alias.js";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-write-batch-"));
  roots.push(root);
  return root;
}

test("write_batch atomically creates and replaces a bounded file set", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "existing.js"), "export const old = true;\n");
  const executor = new Executor(root, { shellSandbox: "host" });
  const action = {
    a: "write_batch",
    files: [
      { p: "existing.js", content: "export const current = true;\n" },
      { p: "nested/new.js", content: "export const created = true;\n" },
    ],
  };

  const result = await executor.execute(action);

  assert.match(result.observation, /wrote batch of 2 files/);
  assert.equal(fs.readFileSync(path.join(root, "existing.js"), "utf8"), action.files[0].content);
  assert.equal(fs.readFileSync(path.join(root, "nested/new.js"), "utf8"), action.files[1].content);
  assert.equal(isEditAction(action), true);
  assert.deepEqual(editPaths(action), ["existing.js", "nested/new.js"]);
  assert.equal(editSucceeded(action, result.observation), true);
});

test("write_batch rejects duplicate paths before changing any file", async () => {
  const root = workspace();
  const target = path.join(root, "same.js");
  fs.writeFileSync(target, "export const original = true;\n");
  const executor = new Executor(root);

  const result = await executor.execute({
    a: "write_batch",
    files: [
      { p: "same.js", content: "export const first = true;\n" },
      { p: "same.js", content: "export const second = true;\n" },
    ],
  });

  assert.match(result.observation, /repeats path same\.js; no files changed/);
  assert.equal(fs.readFileSync(target, "utf8"), "export const original = true;\n");
});

test('write_batch validates modules against their staged package boundary in either file order', async () => {
  for (const reverse of [false, true]) {
    const root = workspace();
    fs.writeFileSync(path.join(root,'package.json'),'{"type":"commonjs"}');
    const executor = new Executor(root);
    const files = [{p:'src/package.json',content:'{"type":"module"}'},
      {p:'src/bus.js',content:'export class Bus { emit() { return 42; } }\n'}];
    const result = await executor.execute({a:'write_batch',files:reverse ? [...files].reverse() : files});
    assert.match(result.observation,/wrote batch of 2 files/);
    const {Bus} = await import(path.join(root,'src/bus.js'));
    assert.equal(new Bus().emit(),42);
  }
});

test('a staged CommonJS boundary cannot disguise an invalid new module or commit the manifest alone', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const executor = new Executor(root);
  const result = await executor.execute({a:'write_batch',files:[
    {p:'src/bus.js',content:'export const value = 42;'},
    {p:'src/package.json',content:'{"type":"commonjs"}'},
  ]});
  assert.match(result.observation,/failed to parse/);
  assert.equal(fs.existsSync(path.join(root,'src')),false);
});

test('atomic patch validates a package type migration against the proposed manifest', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"commonjs"}');
  fs.writeFileSync(path.join(root,'value.js'),'module.exports = 7;\n');
  const executor = new Executor(root);
  const result = await executor.execute({a:'patch',edits:[
    {p:'value.js',old:'module.exports = 7;',new:'export const value = 7;'},
    {p:'package.json',old:'"commonjs"',new:'"module"'},
  ]});
  assert.doesNotMatch(result.observation,/ERROR/);
  assert.equal((await import(path.join(root,'value.js'))).value,7);
});

test("write_batch validates every source before creating earlier targets", async () => {
  const root = workspace();
  const executor = new Executor(root);

  const result = await executor.execute({
    a: "write_batch",
    files: [
      { p: "would-exist.js", content: "export const good = true;\n" },
      { p: "broken.js", content: "export const = ;\n" },
    ],
  });

  assert.match(result.observation, /write_batch.*No files changed|syntax|parse/i);
  assert.equal(fs.existsSync(path.join(root, "would-exist.js")), false);
  assert.equal(fs.existsSync(path.join(root, "broken.js")), false);
});

test("write_batch applies per-path read-only authority before committing", async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "protected"));
  fs.writeFileSync(path.join(root, "protected/gauge.js"), "export const gauge = true;\n");
  const executor = new Executor(root, { readOnlyWorkspacePaths: ["protected"] });

  const result = await executor.execute({
    a: "write_batch",
    files: [
      { p: "allowed.js", content: "export const allowed = true;\n" },
      { p: "protected/gauge.js", content: "export const weakened = true;\n" },
    ],
  });

  assert.match(result.observation, /path is read-only by workspace policy/);
  assert.equal(fs.existsSync(path.join(root, "allowed.js")), false);
  assert.equal(fs.readFileSync(path.join(root, "protected/gauge.js"), "utf8"), "export const gauge = true;\n");
});

test("write_batch rolls back earlier commits when a later rename fails", async () => {
  const root = workspace();
  const existing = path.join(root, "existing.js");
  fs.writeFileSync(existing, "export const original = true;\n");
  let stageCommits = 0;
  const executor = new Executor(root, {
    renameFile(from, to) {
      if (from.includes(".bantam-stage-") && ++stageCommits === 2) {
        throw new Error("injected second commit failure");
      }
      fs.renameSync(from, to);
    },
  });

  const result = await executor.execute({
    a: "write_batch",
    files: [
      { p: "existing.js", content: "export const changed = true;\n" },
      { p: "new.js", content: "export const created = true;\n" },
    ],
  });

  assert.match(result.observation, /atomic write_batch commit failed; rolled back staged writes/);
  assert.equal(fs.readFileSync(existing, "utf8"), "export const original = true;\n");
  assert.equal(fs.existsSync(path.join(root, "new.js")), false);
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".bantam-")), false);
});

test("workspace aliases normalize every write_batch path without touching content", () => {
  const action = {
    a: "write_batch",
    files: [
      { p: "/workspace/src/a.js", content: "/workspace stays literal here" },
      { p: "test/a.test.js", content: "ok" },
    ],
  };

  assert.deepEqual(normalizeWorkspaceAction(action), {
    ...action,
    files: [
      { p: "src/a.js", content: "/workspace stays literal here" },
      action.files[1],
    ],
  });
});
