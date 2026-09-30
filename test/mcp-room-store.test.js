import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { RoomStore } from "../src/mcp/room-store.js";

const temporary = [];
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }); });
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-room-store-"));
  temporary.push(dir);
  return path.join(dir, "room.jsonl");
}

describe("room store", () => {
  it("numbers records and keeps them across reopen", () => {
    const file = tempFile();
    const store = new RoomStore(file);
    assert.equal(store.append({ type: "message", text: "a" }).seq, 1);
    const second = store.append({ type: "message", text: "b" });
    assert.equal(second.seq, 2);
    assert.match(second.at, /^\d{4}-\d\d-\d\dT/);
    const reopened = new RoomStore(file);
    assert.equal(reopened.lastSeq, 2);
    assert.deepEqual(reopened.records().map((r) => r.text), ["a", "b"]);
    assert.equal(reopened.append({ type: "message", text: "c" }).seq, 3);
    assert.equal(reopened.recovered, false);
  });

  it("drops only a torn final line left by a crash", () => {
    const file = tempFile();
    const store = new RoomStore(file);
    store.append({ type: "message", text: "kept" });
    fs.appendFileSync(file, '{"seq":2,"type":"mess');
    const reopened = new RoomStore(file);
    assert.equal(reopened.recovered, true);
    assert.equal(reopened.lastSeq, 1);
    assert.equal(reopened.append({ type: "message", text: "next" }).seq, 2);
    assert.deepEqual(new RoomStore(file).records().map((r) => r.text), ["kept", "next"]);
  });

  it("refuses to start over corruption in the middle of the log", () => {
    const file = tempFile();
    fs.writeFileSync(file, '{"seq":1,"type":"message"}\nnot json\n{"seq":3,"type":"message"}\n');
    assert.throws(() => new RoomStore(file), /room log line 2 is corrupt/);
  });

  it("refuses out-of-order sequence numbers", () => {
    const file = tempFile();
    fs.writeFileSync(file, '{"seq":1,"type":"message"}\n{"seq":1,"type":"message"}\n');
    assert.throws(() => new RoomStore(file), /sequence/);
  });

  it("notifies listeners after the record is on disk", () => {
    const file = tempFile();
    const store = new RoomStore(file);
    const seen = [];
    const stop = store.onAppend((record) => seen.push([record.seq, fs.readFileSync(file, "utf8").includes('"seq":' + record.seq)]));
    store.append({ type: "message" });
    stop();
    store.append({ type: "message" });
    assert.deepEqual(seen, [[1, true]]);
  });

  it("rejects records without a type", () => {
    const store = new RoomStore(tempFile());
    assert.throws(() => store.append({ text: "x" }), /type/);
  });
});
