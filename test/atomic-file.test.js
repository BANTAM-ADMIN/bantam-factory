import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../src/atomic-file.js";

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-atomic-file-"));
  tempDirs.push(directory);
  return directory;
}

function temporaryFiles(directory, basename) {
  const prefix = `.${basename}.${process.pid}.`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
}

describe("atomic file writes", () => {
  it("writes text and JSON through same-directory replacements", () => {
    const directory = fixture();
    const textPath = path.join(directory, "nested", "state.txt");
    const jsonPath = path.join(directory, "state.json");

    assert.equal(writeTextAtomic(textPath, "ready"), path.resolve(textPath));
    assert.equal(fs.readFileSync(textPath, "utf8"), "ready");
    assert.equal(writeJsonAtomic(jsonPath, { passed: true }), path.resolve(jsonPath));
    assert.equal(fs.readFileSync(jsonPath, "utf8"), '{\n  "passed": true\n}\n');
    assert.deepEqual(temporaryFiles(path.dirname(textPath), "state.txt"), []);
    assert.deepEqual(temporaryFiles(directory, "state.json"), []);
  });

  it("preserves the mode of an existing regular file", () => {
    const directory = fixture();
    const target = path.join(directory, "private.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o664);

    const previousUmask = process.umask(0o077);
    try {
      writeTextAtomic(target, "new");
    } finally {
      process.umask(previousUmask);
    }

    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.equal(fs.statSync(target).mode & 0o777, 0o664);
  });

  it("leaves the original intact and removes its temporary file when rename fails", (t) => {
    const directory = fixture();
    const target = path.join(directory, "state.txt");
    fs.writeFileSync(target, "original");
    t.mock.method(fs, "renameSync", () => {
      const error = new Error("injected rename failure");
      error.code = "EIO";
      throw error;
    });

    assert.throws(() => writeTextAtomic(target, "replacement"), /injected rename failure/);
    t.mock.restoreAll();

    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);
  });

  it("cleans partial temporary output when mode, write, or sync operations fail", (t) => {
    const directory = fixture();
    const target = path.join(directory, "state.txt");
    fs.writeFileSync(target, "original");
    t.mock.method(fs, "fchmodSync", () => {
      throw new Error("injected mode failure");
    });
    assert.throws(() => writeTextAtomic(target, "replacement"), /injected mode failure/);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);

    t.mock.method(fs, "writeFileSync", () => {
      throw new Error("injected write failure");
    });

    assert.throws(() => writeTextAtomic(target, "replacement"), /injected write failure/);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);

    t.mock.method(fs, "fsyncSync", () => {
      throw new Error("injected sync failure");
    });
    assert.throws(() => writeTextAtomic(target, "replacement"), /injected sync failure/);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);
  });

  it("retries descriptor cleanup after a close failure", (t) => {
    const directory = fixture();
    const target = path.join(directory, "state.txt");
    fs.writeFileSync(target, "original");
    const originalClose = fs.closeSync;
    let closes = 0;
    t.mock.method(fs, "closeSync", (descriptor) => {
      closes++;
      if (closes === 1) throw new Error("injected close failure");
      return originalClose(descriptor);
    });

    assert.throws(() => writeTextAtomic(target, "replacement"), /injected close failure/);
    t.mock.restoreAll();

    assert.equal(closes, 2);
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);
  });

  it("does not perform fallible temporary cleanup after a successful rename", (t) => {
    const directory = fixture();
    const target = path.join(directory, "state.txt");
    t.mock.method(fs, "rmSync", () => {
      throw new Error("redundant cleanup should not run");
    });

    assert.equal(writeTextAtomic(target, "committed"), path.resolve(target));
    t.mock.restoreAll();

    assert.equal(fs.readFileSync(target, "utf8"), "committed");
  });

  it("does not follow a planted predictable temporary-file symlink", (t) => {
    const directory = fixture();
    const target = path.join(directory, "state.txt");
    const victim = path.join(directory, "victim.txt");
    fs.writeFileSync(victim, "untouched");

    t.mock.method(Math, "random", () => 0.5);
    const formerlyPredictable = path.join(directory, `.state.txt.${process.pid}.8.tmp`);
    fs.symlinkSync(victim, formerlyPredictable);

    writeTextAtomic(target, "replacement");

    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
    assert.equal(fs.readFileSync(target, "utf8"), "replacement");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  });

  it("rejects symlink and non-file destinations without changing them", () => {
    const directory = fixture();
    const victim = path.join(directory, "victim.txt");
    const link = path.join(directory, "state.txt");
    const destinationDirectory = path.join(directory, "directory-target");
    fs.writeFileSync(victim, "untouched");
    fs.symlinkSync(victim, link);
    fs.mkdirSync(destinationDirectory);

    assert.throws(() => writeTextAtomic(link, "replacement"), /refusing to atomically replace symlink/);
    assert.throws(() => writeTextAtomic(destinationDirectory, "replacement"), /not a regular file/);
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(temporaryFiles(directory, "state.txt"), []);
  });

  it("rejects invalid paths and cyclic JSON before creating output", () => {
    const directory = fixture();
    assert.throws(() => writeTextAtomic("", "value"), /non-empty string/);
    assert.throws(() => writeTextAtomic("bad\0path", "value"), /NUL bytes/);
    assert.throws(() => writeTextAtomic(path.parse(directory).root, "value"), /filesystem root/);

    const cyclic = {};
    cyclic.self = cyclic;
    const target = path.join(directory, "not-created", "state.json");
    assert.throws(() => writeJsonAtomic(target, cyclic), /circular structure/i);
    assert.throws(() => writeJsonAtomic(target, undefined), /must be serializable/);
    assert.equal(fs.existsSync(path.dirname(target)), false);
  });
});
