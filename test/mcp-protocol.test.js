import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { createMcpHttpHandler, ToolError } from "../src/mcp/protocol.js";
import { validateArgs } from "../src/mcp/schema.js";

const TOKEN = "t0ken";
let server, base, lastSignal = null, lastCaller = null;

const tools = [
  { name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 5 } }, required: ["text"] },
    handler: async (args, { caller }) => { lastCaller = caller; return { said: args.text }; } },
  { name: "boom", description: "fails", inputSchema: { type: "object", properties: {} },
    handler: async () => { throw new ToolError("nope, and here is why"); } },
  { name: "hang", description: "waits for abort", inputSchema: { type: "object", properties: {} },
    handler: (_args, { signal }) => new Promise((resolve) => { lastSignal = signal; signal.addEventListener("abort", () => resolve({ aborted: true })); }) },
];

before(async () => {
  const handler = createMcpHttpHandler({
    token: TOKEN,
    resolveAgent: (name, req) => name === "claude" || (name === "operator" && req.headers["x-bantam-operator"] === "1"),
    listTools: () => tools,
    callTool: (name, args, context) => {
      const tool = tools.find((t) => t.name === name);
      return tool ? tool.handler(args, context) : undefined;
    },
    serverInfo: { name: "bantam", version: "test" },
    instructions: "hello",
  });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function rpc(body, { agent = "claude", token = TOKEN, headers = {}, raw = null, method = "POST" } = {}) {
  return fetch(`${base}/mcp/${agent}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
  });
}
const call = async (id, name, args) => (await (await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).json());

describe("MCP protocol", () => {
  it("negotiates a supported protocol version and advertises tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.protocolVersion, "2025-06-18");
    assert.ok(body.result.capabilities.tools);
    assert.equal(body.result.serverInfo.name, "bantam");
    assert.equal(body.result.instructions, "hello");
    const unknown = await (await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
    assert.equal(unknown.result.protocolVersion, "2025-11-25");
  });

  it("lists tools without handlers", async () => {
    const body = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    assert.deepEqual(body.result.tools.map((t) => t.name), ["echo", "boom", "hang"]);
    assert.equal(body.result.tools[0].handler, undefined);
    assert.ok(body.result.tools[0].inputSchema);
  });

  it("calls a tool, stamps the caller, and returns text plus structured content", async () => {
    const body = await call(4, "echo", { text: "hi" });
    assert.equal(lastCaller, "claude");
    assert.deepEqual(body.result.structuredContent, { said: "hi" });
    assert.equal(body.result.content[0].type, "text");
    assert.match(body.result.content[0].text, /"said": "hi"/);
    assert.equal(body.result.isError, undefined);
  });

  it("reports tool errors and invalid arguments as tool results", async () => {
    const failed = await call(5, "boom", {});
    assert.equal(failed.result.isError, true);
    assert.equal(failed.result.content[0].text, "nope, and here is why");
    const invalid = await call(6, "echo", { text: "too long" });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /text must have at most 5 characters/);
    const missing = await call(7, "echo", {});
    assert.match(missing.result.content[0].text, /text is required/);
  });

  it("rejects an unknown tool with invalid params", async () => {
    const body = await call(8, "nope", {});
    assert.equal(body.error.code, -32602);
  });

  it("accepts notifications with 202 and no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  it("answers ping, unknown methods and bad JSON with JSON-RPC shapes", async () => {
    assert.deepEqual((await (await rpc({ jsonrpc: "2.0", id: 9, method: "ping" })).json()).result, {});
    assert.equal((await (await rpc({ jsonrpc: "2.0", id: 10, method: "resources/list" })).json()).error.code, -32601);
    assert.equal((await (await rpc(null, { raw: "{nope" })).json()).error.code, -32700);
    assert.equal((await (await rpc({ id: 11, method: "ping" })).json()).error.code, -32600);
  });

  it("guards the endpoint: token, origin, size, agent and method", async () => {
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null })).status, 401);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "wrong" })).status, 401);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "http://127.0.0.1:3000" } })).status, 200);
    assert.equal((await rpc(null, { raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1024 * 1024 + 10) }) })).status, 413);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { agent: "bantam" })).status, 404);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { agent: "operator" })).status, 404);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { agent: "operator", headers: { "x-bantam-operator": "1" } })).status, 200);
    assert.equal((await rpc(null, { method: "GET" })).status, 405);
    assert.equal((await fetch(`${base}/elsewhere`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" })).status, 404);
  });

  it("aborts the tool's signal when the client goes away", async () => {
    const controller = new AbortController();
    const pending = fetch(`${base}/mcp/claude`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "hang", arguments: {} } }),
    }).catch(() => null);
    for (let i = 0; i < 100 && !lastSignal; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(lastSignal);
    controller.abort();
    await pending;
    for (let i = 0; i < 100 && !lastSignal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(lastSignal.aborted, true);
  });
});

describe("MCP protocol: cancellation and hostile input", () => {
  it("aborts a call when the client sends notifications/cancelled on another request", async () => {
    lastSignal = null;
    const pending = rpc({ jsonrpc: "2.0", id: "wait-1", method: "tools/call", params: { name: "hang", arguments: {} } });
    for (let i = 0; i < 100 && !lastSignal; i++) await new Promise((r) => setTimeout(r, 10));
    const signal = lastSignal;
    assert.equal(signal.aborted, false);
    // Another agent cannot cancel claude's call.
    await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "wait-1" } }, { agent: "operator", headers: { "x-bantam-operator": "1" } });
    assert.equal(signal.aborted, false);
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "wait-1", reason: "user pressed Esc" } });
    assert.equal(res.status, 202);
    assert.equal(signal.aborted, true);
    assert.deepEqual((await (await pending).json()).result.structuredContent, { aborted: true });
  });

  it("answers a malformed path with 404 instead of crashing", async () => {
    const res = await fetch(`${base}/mcp/%E0`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    assert.equal(res.status, 404);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status, 200, "still serving");
  });

  it("rejects tools/call without params as invalid params", async () => {
    const body = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: null })).json();
    assert.equal(body.error.code, -32602);
  });
});

describe("validateArgs", () => {
  it("checks the declared schema subset", () => {
    const schema = { type: "object", additionalProperties: false, required: ["a"], properties: {
      a: { type: "integer", minimum: 1, maximum: 3 }, b: { type: "array", maxItems: 2, items: { type: "string" } }, c: { enum: ["x", "y"] } } };
    assert.equal(validateArgs(schema, { a: 2, b: ["q"], c: "x" }), null);
    assert.equal(validateArgs(schema, { a: 1.5 }), "a must be integer");
    assert.equal(validateArgs(schema, { a: 9 }), "a must be ≤ 3");
    assert.equal(validateArgs(schema, { a: 1, b: [1] }), "b[0] must be string");
    assert.equal(validateArgs(schema, { a: 1, b: ["1", "2", "3"] }), "b must have at most 2 items");
    assert.equal(validateArgs(schema, { a: 1, c: "z" }), 'c must be one of "x", "y"');
    assert.equal(validateArgs(schema, { a: 1, d: 1 }), "d is not a known field");
    assert.equal(validateArgs(schema, {}), "a is required");
  });
});
