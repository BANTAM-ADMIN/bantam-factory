import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Room } from "../src/mcp/room.js";
import { RoomStore } from "../src/mcp/room-store.js";
import { ToolError } from "../src/mcp/protocol.js";

const temporary = [];
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }); });
function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-room-"));
  temporary.push(dir);
  return path.join(dir, "room.jsonl");
}
const open = (file) => new Room(new RoomStore(file));
const texts = (result) => result.messages.map((m) => m.text);

describe("room messages", () => {
  it("delivers direct and broadcast messages, never back to the sender", () => {
    const room = open(tempLog());
    room.post("operator", { to: ["claude"], text: "direct" });
    room.post("claude", { to: ["all"], text: "from claude to all" });
    room.post("bantam", { to: ["all"], kind: "event", text: "broadcast" });
    room.post("operator", { to: ["codex"], text: "not for claude" });
    assert.deepEqual(texts(room.inbox("claude")), ["direct", "broadcast"]);
    assert.deepEqual(texts(room.inbox("claude")), []);
    assert.deepEqual(texts(room.inbox("operator")), ["from claude to all", "broadcast"]);
  });

  it("keeps read cursors across a restart", () => {
    const file = tempLog();
    const room = open(file);
    room.post("operator", { to: ["claude"], text: "one" });
    room.post("operator", { to: ["claude"], text: "two" });
    assert.deepEqual(texts(room.inbox("claude", { limit: 1 })), ["one"]);
    assert.deepEqual(texts(open(file).inbox("claude")), ["two"]);
  });

  it("validates messages", () => {
    const room = open(tempLog());
    assert.throws(() => room.post("claude", { to: [], text: "x" }), ToolError);
    assert.throws(() => room.post("claude", { to: ["Bad Name"], text: "x" }), /not an agent name/);
    assert.throws(() => room.post("claude", { to: ["all"], kind: "gossip", text: "x" }), /kind must be/);
    assert.throws(() => room.post("claude", { to: ["all"], text: "  " }), /empty/);
    assert.throws(() => room.post("claude", { to: ["all"], text: "x".repeat(16 * 1024 + 1) }), /exceeds/);
    assert.throws(() => room.post("claude", { to: ["all"], text: "x", replyTo: "m99" }), /no message m99/);
    assert.throws(() => room.post("claude", { to: ["all"], text: "x", task: "t9" }), /no task t9/);
  });

  it("wakes a waiter when a message arrives", async () => {
    const room = open(tempLog());
    const started = Date.now();
    const waiting = room.wait("claude", { timeoutMs: 5000 });
    setTimeout(() => room.post("bantam", { to: ["claude"], kind: "event", text: "job done" }), 50);
    const result = await waiting;
    assert.deepEqual(texts(result), ["job done"]);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(texts(room.inbox("claude")), []);
  });

  it("returns at once when mail is already waiting, and times out otherwise", async () => {
    const room = open(tempLog());
    room.post("operator", { to: ["claude"], text: "waiting already" });
    assert.deepEqual(texts(await room.wait("claude", { timeoutMs: 5000 })), ["waiting already"]);
    const result = await room.wait("claude", { timeoutMs: 30 });
    assert.deepEqual(result, { messages: [], remaining: 0, timedOut: true });
  });

  it("releases an aborted waiter without marking anything read", async () => {
    const room = open(tempLog());
    const controller = new AbortController();
    const waiting = room.wait("claude", { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    const result = await waiting;
    assert.equal(result.aborted, true);
    room.post("operator", { to: ["claude"], text: "after the client left" });
    assert.deepEqual(texts(room.inbox("claude")), ["after the client left"]);
  });

  it("ignores messages not addressed to the waiter", async () => {
    const room = open(tempLog());
    const waiting = room.wait("claude", { timeoutMs: 100 });
    room.post("operator", { to: ["codex"], text: "other" });
    room.post("claude", { to: ["all"], text: "own" });
    assert.equal((await waiting).timedOut, true);
  });

  it("records acknowledgments in history", () => {
    const room = open(tempLog());
    const { id } = room.post("operator", { to: ["claude"], kind: "question", text: "ready?" });
    assert.throws(() => room.ack("codex", id), /not addressed/);
    room.ack("claude", id);
    const history = room.history();
    assert.deepEqual(history.messages[0].ackedBy, ["claude"]);
    assert.equal(history.lastSeq, 2);
  });
});

describe("room tasks", () => {
  it("admits exactly one claimant", async () => {
    const room = open(tempLog());
    const { id } = room.createTask("operator", { title: "Revise chapter 2" });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => room.claimTask("claude", id)),
      Promise.resolve().then(() => room.claimTask("codex", id)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(results.find((r) => r.status === "rejected").reason.message, /claimed \(owner claude\)/);
  });

  it("enforces ownership and independent verification", () => {
    const file = tempLog();
    const room = open(file);
    const { id } = room.createTask("operator", { title: "t" });
    room.claimTask("claude", id);
    assert.throws(() => room.updateTask("codex", id, "working"), /only claude \(the owner\)/);
    room.updateTask("claude", id, "working");
    room.updateTask("claude", id, "review", "diff in jobs/j1");
    assert.throws(() => room.updateTask("claude", id, "verified"), /someone other than its owner/);
    room.updateTask("bantam", id, "verified");
    room.updateTask("claude", id, "done");
    assert.throws(() => room.updateTask("claude", id, "working"), /done is final/);
    const reopened = open(file).listTasks();
    assert.equal(reopened.tasks[0].state, "done");
    assert.equal(reopened.tasks[0].owner, "claude");
  });

  it("names the allowed moves on an invalid transition and clears the owner on release", () => {
    const room = open(tempLog());
    const { id } = room.createTask("operator", { title: "t" });
    assert.throws(() => room.updateTask("claude", id, "working"), /ready → working/);
    room.claimTask("claude", id);
    assert.throws(() => room.updateTask("claude", id, "done"), /can go to working, review, ready, blocked/);
    assert.equal(room.updateTask("claude", id, "ready").owner, null);
    assert.equal(room.claimTask("codex", id).owner, "codex");
  });

  it("lets the operator make any listed move", () => {
    const room = open(tempLog());
    const { id } = room.createTask("operator", { title: "t" });
    room.claimTask("claude", id);
    room.updateTask("claude", id, "review");
    assert.equal(room.updateTask("operator", id, "verified").state, "verified");
    assert.deepEqual(room.listTasks({ state: "verified" }).tasks.map((t) => t.id), [id]);
  });
});
