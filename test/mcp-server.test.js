import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { startMcpServer, TOOLSET_FACTORIES, roomPaths } from "../src/mcp/server.js";
import { runMcpCli } from "../src/mcp/cli.js";

const temporary = [], servers = [];
afterEach(async () => {
  while (servers.length) await servers.pop().close();
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});
function tempRoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-mcp-room-"));
  temporary.push(dir);
  return dir;
}
async function serve(options) {
  const server = await startMcpServer({ port: 0, ...options });
  servers.push(server);
  return server;
}
async function rpc(server, method, params, agent = "claude", headers = {}) {
  const res = await fetch(`${server.url}/mcp/${agent}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}
const fake = { name: "fake", tools: [{ name: "fake_ping", description: "p", inputSchema: { type: "object", properties: {} }, handler: async () => "pong" }], start() {}, stop() { fake.stopped = true; } };
const factories = { ...TOOLSET_FACTORIES, fake: async () => fake, broken: async () => ({ name: "broken", tools: [], start() { throw new Error("no engine"); }, stop() {} }) };

describe("MCP server", () => {
  it("scaffolds the room and serves the room tools end to end", async () => {
    const roomDir = tempRoom();
    const server = await serve({ roomDir, toolsets: ["room", "fake"], factories });
    const paths = roomPaths(roomDir);
    assert.ok(fs.existsSync(path.join(paths.crew, "brief.md")));
    assert.ok(fs.existsSync(path.join(paths.crew, "protocol.md")));
    assert.equal(fs.statSync(paths.token).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.runtime).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(paths.serverInfo, "utf8")).pid, process.pid);

    const init = await rpc(server, "initialize", { protocolVersion: "2025-06-18" });
    assert.match(init.result.instructions, /room_brief/);
    const names = (await rpc(server, "tools/list")).result.tools.map((t) => t.name);
    assert.ok(names.includes("room_wait") && names.includes("fake_ping"));

    const posted = await rpc(server, "tools/call", { name: "room_post", arguments: { to: ["operator"], text: "hello" } });
    assert.equal(posted.result.structuredContent.id, "m1");
    const inbox = await rpc(server, "tools/call", { name: "room_inbox", arguments: {} }, "operator", { "x-bantam-operator": "1" });
    assert.equal(inbox.result.structuredContent.messages[0].from, "claude");
    const brief = await rpc(server, "tools/call", { name: "room_brief", arguments: {} });
    assert.equal(brief.result.structuredContent.you, "claude");
    assert.deepEqual(brief.result.structuredContent.toolsets, ["room", "fake"]);
  });

  it("serves an agent's long wait until a message arrives", async () => {
    const server = await serve({ roomDir: tempRoom(), toolsets: ["room"] });
    const waiting = rpc(server, "tools/call", { name: "room_wait", arguments: { timeout_s: 10 } });
    await new Promise((r) => setTimeout(r, 100));
    server.room.post("bantam", { to: ["claude"], kind: "event", text: "job j1 succeeded" });
    const result = await waiting;
    assert.equal(result.result.structuredContent.messages[0].text, "job j1 succeeded");
  });

  it("gives one server per room", async () => {
    const roomDir = tempRoom();
    await serve({ roomDir, toolsets: ["room"] });
    await assert.rejects(startMcpServer({ roomDir, port: 0, toolsets: ["room"] }), /already owns this room/);
  });

  it("leaves out a toolset that cannot start and stops the others on close", async () => {
    const logged = [];
    const server = await startMcpServer({ roomDir: tempRoom(), port: 0, toolsets: ["room", "broken", "fake"], factories, log: (e) => logged.push(e) });
    assert.deepEqual(server.toolsets, ["room", "fake"]);
    assert.deepEqual(logged.find((e) => e.event === "toolset_skipped"), { event: "toolset_skipped", toolset: "broken", error: "no engine" });
    await server.close();
    assert.equal(fake.stopped, true);
  });

  it("releases the room lock on close", async () => {
    const roomDir = tempRoom();
    const first = await startMcpServer({ roomDir, port: 0, toolsets: ["room"] });
    await first.close();
    assert.equal(fs.existsSync(roomPaths(roomDir).lock), false);
    assert.equal(fs.existsSync(roomPaths(roomDir).serverInfo), false);
    await serve({ roomDir, toolsets: ["room"] });
  });

  it("rejects unknown toolsets and non-local hosts", async () => {
    await assert.rejects(startMcpServer({ roomDir: tempRoom(), port: 0, toolsets: ["nope"] }), /unknown toolset: nope/);
    await assert.rejects(startMcpServer({ roomDir: tempRoom(), port: 0, host: "0.0.0.0" }), /localhost only/);
  });

  it("lets the operator post from the command line into a running server", async () => {
    const roomDir = tempRoom();
    const server = await serve({ roomDir, toolsets: ["room"] });
    const lines = [];
    assert.equal(await runMcpCli(["say", "--room", roomDir, "--to", "claude", "please", "start"], { out: (l) => lines.push(l) }), 0);
    assert.match(lines[0], /posted m1 → claude/);
    const inbox = server.room.inbox("claude");
    assert.equal(inbox.messages[0].from, "operator");
    assert.equal(inbox.messages[0].text, "please start");
    const log = [];
    assert.equal(await runMcpCli(["log", "--room", roomDir], { out: (l) => log.push(l) }), 0);
    assert.match(log.join("\n"), /m1 operator → claude \[note\]\n {4}please start/);
    const config = [];
    await runMcpCli(["config", "--room", roomDir], { out: (l) => config.push(l) });
    assert.match(config[0], new RegExp(`claude mcp add --transport http bantam ${server.url.replace(/\./g, "\\.")}/mcp/claude --header "Authorization: Bearer ${server.token}"`));
  });
});
