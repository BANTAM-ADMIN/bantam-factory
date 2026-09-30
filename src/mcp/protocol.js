// MCP over Streamable HTTP, the small part BANTAM needs: one JSON-RPC request
// per POST answered with application/json, notifications acknowledged with 202,
// no server-initiated streams (GET/DELETE → 405), no sessions.
//
// Knows nothing about tools beyond the registry it is handed. The caller's name
// comes from the URL (/mcp/<agent>) and is stamped by the server, never by a
// tool argument, so an agent cannot speak as another.
import crypto from "node:crypto";
import { validateArgs } from "./schema.js";

export const PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);
export const MAX_BODY_BYTES = 1024 * 1024;
const AGENT = /^[a-z][a-z0-9-]{0,31}$/;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** A failure the calling model should read and act on (not a protocol error). */
export class ToolError extends Error {}

function sameToken(given, expected) {
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body = null, headers = {}) {
  if (res.headersSent) return;
  const text = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === null ? {} : { "content-type": "application/json" }), ...headers });
  res.end(text);
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function toolResult(value) {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  const structured = value !== null && typeof value === "object" && !Array.isArray(value);
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(structured ? { structuredContent: value } : {}) };
}

/**
 * @param {object} options
 * @param {string|(() => string)} options.token  Bearer token every request must carry.
 * @param {(name: string, req) => boolean} options.resolveAgent  whether /mcp/<name> may connect.
 * @param {() => Array<{name, description, inputSchema}>} options.listTools
 * @param {(name, args, {caller, signal}) => Promise<any>} options.callTool
 */
export function createMcpHttpHandler({ token, resolveAgent, listTools, callTool, serverInfo, instructions = null, log = () => {} }) {
  const expected = () => (typeof token === "function" ? token() : token);

  async function dispatch(message, caller, signal) {
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        ...(instructions ? { instructions } : {}),
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      return { tools: listTools().map(({ name, title, description, inputSchema, annotations }) => ({ name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}) })) };
    }
    if (method === "tools/call") {
      const tool = listTools().find((t) => t.name === params?.name);
      if (!tool) return { error: rpcError(id, -32602, `unknown tool: ${String(params?.name)}`) };
      const args = params.arguments ?? {};
      const problem = validateArgs(tool.inputSchema, args);
      if (problem) return { content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${problem}` }], isError: true };
      try {
        return toolResult(await callTool(tool.name, args, { caller, signal }));
      } catch (error) {
        if (error instanceof ToolError) return { content: [{ type: "text", text: error.message }], isError: true };
        log({ event: "tool_crash", tool: tool.name, caller, error: error?.stack ?? String(error) });
        return { content: [{ type: "text", text: `${tool.name} failed inside BANTAM: ${error?.message ?? error}` }], isError: true };
      }
    }
    return { error: rpcError(id, -32601, `method not found: ${String(method)}`) };
  }

  return function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "this server answers POST only" }, { allow: "POST" });
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!auth || !sameToken(auth[1].trim(), expected())) return send(res, 401, { error: "missing or wrong bearer token" });
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
    const caller = decodeURIComponent(match[1]);
    if (!AGENT.test(caller) || !resolveAgent(caller, req)) return send(res, 404, { error: `unknown agent: ${caller}` });

    const chunks = [];
    let size = 0, tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("error", () => {});
    req.on("end", async () => {
      if (tooLarge) return send(res, 413, rpcError(null, -32600, `request body exceeds ${MAX_BODY_BYTES} bytes`));
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return send(res, 400, rpcError(null, -32700, "parse error")); }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return send(res, 400, rpcError(message?.id, -32600, "invalid request"));
      }
      // Notifications and client responses carry no id: acknowledge, nothing to return.
      if (message.id === undefined) return send(res, 202);
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableFinished) controller.abort(); });
      try {
        const result = await dispatch(message, caller, controller.signal);
        if (result?.error) return send(res, 200, result.error);
        send(res, 200, { jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        log({ event: "rpc_crash", method: message.method, error: error?.stack ?? String(error) });
        send(res, 200, rpcError(message.id, -32603, "internal error"));
      }
    });
  };
}
