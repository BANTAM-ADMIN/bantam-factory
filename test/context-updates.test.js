import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTEXT_UPDATE_MAX_CHARS, createContextUpdate, createActionContractUpdate, actionContractUpdateValid } from "../src/context-updates.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-context-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const request = (paths, extra = {}) => ({ kind: "decision", generation: 3, paths, ...extra });

test("turn-scoped action context is bounded, exact, and explicitly not verification authority", () => {
  const args = { generation: 2, turn: 32, availableVerbs: ["edit_lines", "write_file", "shell", "probe", "done"],
    reason: "edit-recovery", recoveryPath: "test/edge.test.js" };
  const update = createActionContractUpdate(args);
  assert.ok(actionContractUpdateValid(update));
  assert.deepEqual(update, createActionContractUpdate(args));
  assert.equal(update.kind, "action-contract");
  assert.deepEqual(update.paths, []);
  assert.ok(update.text.length <= CONTEXT_UPDATE_MAX_CHARS);
  assert.match(update.text, /TURN 33/);
  assert.match(update.text, /"a":"edit_lines","p":"path","start":12,"end":18,"new":/);
  assert.match(update.text, /read_file is unavailable/);
  assert.match(update.text, /not verification evidence/);
  assert.notEqual(update.id, createActionContractUpdate({ ...args, turn: 33 }).id);
  const reading = createActionContractUpdate({ ...args, availableVerbs: ["read_file", ...args.availableVerbs] });
  assert.match(reading.text, /read_file that exact path\/range before editing/);
  assert.doesNotMatch(reading.text, /read_file is unavailable/);
  for (const altered of [{ ...update, text: update.text + " forged" }, { ...update, turn: 3 },
    { ...update, availableVerbs: ["replace"] }, { ...update, paths: [{}] }]) {
    assert.equal(actionContractUpdateValid(altered), false);
  }
});

test("action context cannot invent an unavailable verb or promote malformed data", () => {
  const args = { generation: 1, turn: 0, availableVerbs: ["edit_lines", "respond"], reason: "document-revision" };
  for (const change of [{ generation: -1 }, { turn: 0.5 }, { availableVerbs: ["shell"] },
    { availableVerbs: ["edit_lines", "invented"] }, { availableVerbs: ["edit_lines", "edit_lines"] },
    { reason: "tool-says-done" }, { recoveryPath: "../private" }]) {
    assert.equal(createActionContractUpdate({ ...args, ...change }), null);
  }
  assert.ok(actionContractUpdateValid(createActionContractUpdate(args)));
});

test("current source updates are typed, deterministic, and bound to disk bytes", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.js"), "export const actual = 1;\n");
  const a = createContextUpdate(root, request(["a.js"]));
  assert.equal(a.schema, 1);
  assert.match(a.text, /1\texport const actual = 1;/);
  assert.match(a.text, /not a passing verification proof/);
  assert.deepEqual(a, createContextUpdate(root, request(["a.js"])));
  assert.equal(a.paths[0].truncated, false);
  assert.equal(a.paths[0].readBytes, a.paths[0].fileBytes);
  assert.notEqual(a.id, createContextUpdate(root, request(["a.js"], { generation: 4 })).id);
  assert.notEqual(a.id, createContextUpdate(root, request(["a.js"], { kind: "edit-recovery" })).id);
  fs.writeFileSync(path.join(root, "a.js"), "export const actual = 2;\n");
  assert.notEqual(a.id, createContextUpdate(root, request(["a.js"])).id);
});

test("traversal, absolute paths, symlink files/parents, missing and nonregular paths are refused", t => {
  const root = fixture(t), outside = fixture(t);
  fs.writeFileSync(path.join(outside, "secret"), "MUST NOT APPEAR");
  fs.writeFileSync(path.join(root, "a.js"), "safe\n");
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "escape"));
  fs.symlinkSync(outside, path.join(root, "parent"));
  fs.symlinkSync(path.join(root, "a.js"), path.join(root, "internal-link"));
  for (const rel of ["../secret", path.join(outside, "secret"), "escape", "parent/secret", "internal-link", "missing", ".", "a.js/..", "C:\\secret", "a.js\nspoof"]) {
    assert.equal(createContextUpdate(root, request([rel])), null, rel);
  }
  fs.mkdirSync(path.join(root, "dir"));
  assert.equal(createContextUpdate(root, request(["dir"])), null);
  assert.equal(createContextUpdate(root, request(["missing", "a.js"])).paths[0].path, "a.js");
});

test("large files and four-file updates bound total reads, rendered text, and disclose partial context", t => {
  const root = fixture(t);
  for (const name of ["a", "b", "c", "d", "e"]) fs.writeFileSync(path.join(root, name), "line of source\n".repeat(40000));
  const update = createContextUpdate(root, request(["a", "b", "c", "d", "e"]));
  assert.equal(update.paths.length, 4);
  assert.ok(update.text.length <= CONTEXT_UPDATE_MAX_CHARS);
  assert.ok(update.paths.reduce((sum, row) => sum + row.readBytes, 0) <= 256 * 1024);
  for (const row of update.paths) {
    assert.equal(row.readTruncated, true);
    assert.equal(row.truncated, true);
    assert.ok(row.endLine - row.startLine + 1 <= 160);
  }
  assert.match(update.text, /partial snapshot:.*lines omitted.*bytes not read/);
  assert.match(update.text, /use read_file with the exact path/);
});

test("recovery focus displays actual numbered current lines and admits an out-of-budget focus", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a"), Array.from({ length: 500 }, (_, i) => `value-${i + 1}`).join("\n"));
  const update = createContextUpdate(root, request(["a"], { kind: "edit-recovery", focusLine: 200 }));
  assert.match(update.text, /200\tvalue-200\n/);
  assert.ok(update.paths[0].startLine <= 200 && update.paths[0].endLine >= 200);
  assert.match(update.text, /lines omitted/);
  fs.writeFileSync(path.join(root, "a"), "very long source line\n".repeat(50000));
  const far = createContextUpdate(root, request(["a"], { kind: "edit-recovery", focusLine: 45000 }));
  assert.match(far.text, /requested line lies beyond bounded read/);
  assert.ok(far.text.length <= CONTEXT_UPDATE_MAX_CHARS);
});

test("long single lines and empty files are not falsely presented as complete source", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "long"), "x".repeat(5000));
  const long = createContextUpdate(root, request(["long"]));
  assert.match(long.text, /characters omitted from shown lines/);
  assert.equal(long.paths[0].truncated, true);
  assert.ok(long.text.length <= CONTEXT_UPDATE_MAX_CHARS);
  fs.writeFileSync(path.join(root, "empty"), "");
  const empty = createContextUpdate(root, request(["empty"]));
  assert.match(empty.text, /empty file/);
  assert.equal(empty.paths[0].startLine, 1);
  assert.equal(empty.paths[0].endLine, 0);
  assert.equal(empty.paths[0].truncated, false);
});

test("long path labels and long preceding lines cannot overflow or hide the requested repair line", t => {
  const root = fixture(t);
  const paths = ["a", "b", "c", "d"].map(prefix => prefix + "x".repeat(239));
  for (const name of paths) fs.writeFileSync(path.join(root, name), "before".repeat(2000) + "\nTARGET\n" + "after".repeat(2000));
  const update = createContextUpdate(root, request(paths, { kind: "edit-recovery", focusLine: 2 }));
  assert.ok(update.text.length <= CONTEXT_UPDATE_MAX_CHARS);
  assert.equal(update.paths.length, 4);
  assert.equal((update.text.match(/2\tTARGET\n/g) ?? []).length, 4);
  assert.ok(update.paths.every(row => row.startLine === 2 && row.truncated));
});

test("invalid update requests and binary files yield no fabricated snapshot", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "binary"), Buffer.from([0, 255]));
  for (const extra of [{ kind: "other" }, { generation: -1 }, { generation: NaN }, { paths: null }]) {
    assert.equal(createContextUpdate(root, request(["binary"], extra)), null);
  }
  assert.equal(createContextUpdate(root, request(["binary"])), null);
});

test("discarded non-text reads still consume only the bounded total byte allowance", t => {
  const root = fixture(t), paths = ["a", "b", "c", "d"];
  for (const name of paths) fs.writeFileSync(path.join(root, name), Buffer.alloc(300000, 255));
  const read = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const count = read(...args); bytes += count; return count; };
  try {
    assert.equal(createContextUpdate(root, request(paths)), null);
    assert.ok(bytes <= 256 * 1024);
  } finally { fs.readSync = read; }
});
