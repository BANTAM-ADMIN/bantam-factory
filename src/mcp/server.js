// `bantam mcp serve`: one localhost MCP server per room directory.
//
// The server owns the room exclusively (a lock under .crew/runtime), creates
// the room scaffold and bearer token on first use, and hosts the chosen
// toolsets. A toolset that cannot start is reported and left out; the rest
// still serve.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { acquireExclusiveFileLock } from "../exclusive-file-lock.js";
import { writeJsonAtomic } from "../atomic-file.js";
import { createMcpHttpHandler } from "./protocol.js";
import { Room } from "./room.js";
import { RoomStore } from "./room-store.js";
import { createRoomToolset } from "./toolsets/room.js";

export const DEFAULT_PORT = 8095;
export const DEFAULT_TOOLSETS = Object.freeze(["room", "jobs", "jev", "writer"]);

export const TOOLSET_FACTORIES = Object.freeze({
  room: async () => createRoomToolset(),
  jobs: async (options) => (await import("./toolsets/jobs.js")).createJobsToolset(options),
  jev: async (options) => (await import("./toolsets/jev.js")).createJevToolset(options),
  writer: async (options) => (await import("./toolsets/writer.js")).createWriterToolset(options),
});

const PROTOCOL_MD = `# Room protocol

- Read the brief (room_brief) before starting. The operator (the human) owns the goal.
- Claim a task (task_claim) before changing what it covers.
- Workers run on isolated copies. Nothing reaches the live files except job_apply,
  which verifies the candidate, applies it transactionally and verifies again.
- Post findings early when they change someone's approach; keep messages short and
  point at evidence (files, job ids) instead of pasting it.
- Steering a running job (job_steer) is guidance for its assigned task, not a new task.
- While waiting on a job or a reply, call room_wait instead of polling.
- A task is verified by someone other than its owner. Do not call the work done while
  acceptance checks, requested reviews or blockers are unresolved.
`;

const BRIEF_MD = `# Brief

(The operator writes the shared goal, constraints and acceptance criteria here.)
`;

export const SERVER_INSTRUCTIONS = "BANTAM room: a shared message log and task board with the operator (the human) and BANTAM, plus BANTAM worker jobs (local model and Codex) that run on isolated copies and apply only through verification. Books are written with the writer_* tools under an enforced process: the writer drafts, a different agent critiques, BANTAM checks every draft. Start with room_brief. When waiting on a job, a check or a reply, call room_wait rather than polling.";

export function roomPaths(roomDir) {
  const root = path.resolve(roomDir);
  const crew = path.join(root, ".crew");
  const runtime = path.join(crew, "runtime");
  return { root, crew, runtime, log: path.join(crew, "room.jsonl"), token: path.join(runtime, "token"),
    lock: path.join(runtime, "server.lock"), serverInfo: path.join(runtime, "server.json") };
}

export function ensureRoom(roomDir) {
  const paths = roomPaths(roomDir);
  if (!fs.statSync(paths.root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`room directory does not exist: ${paths.root}`);
  fs.mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.runtime, 0o700);
  for (const [file, text] of [[path.join(paths.crew, "brief.md"), BRIEF_MD], [path.join(paths.crew, "protocol.md"), PROTOCOL_MD]]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, { mode: 0o644 });
  }
  if (!fs.existsSync(paths.token)) {
    try { fs.writeFileSync(paths.token, crypto.randomBytes(24).toString("base64url") + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return paths;
}

export function readToken(roomDir) {
  return fs.readFileSync(roomPaths(roomDir).token, "utf8").trim();
}

export async function startMcpServer({
  roomDir,
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  toolsets = DEFAULT_TOOLSETS,
  factories = TOOLSET_FACTORIES,
  toolsetOptions = {},
  mode = "llama",
  log = () => {},
} = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("the BANTAM MCP server binds to localhost only");
  const paths = ensureRoom(roomDir);
  let lock;
  try { lock = acquireExclusiveFileLock(paths.lock, { kind: "bantam-mcp" }); }
  catch (error) {
    if (error?.code === "ELOCKED") throw new Error(`another BANTAM MCP server already owns this room (${paths.lock})`);
    throw error;
  }
  const started = [];
  let server = null;
  try {
    const token = readToken(paths.root);
    const store = new RoomStore(paths.log);
    if (store.recovered) log({ event: "room_log_recovered", file: paths.log });
    const room = new Room(store);
    const ctx = { room, store, roomDir: paths.root, runtimeDir: paths.runtime, log, toolsets: [], mode };
    for (const name of toolsets) {
      const factory = factories[name];
      if (!factory) throw new Error(`unknown toolset: ${name} (have ${Object.keys(factories).join(", ")})`);
      try {
        const toolset = await factory(toolsetOptions[name] ?? {});
        await toolset.start(ctx);
        started.push(toolset);
        ctx.toolsets.push(name);
      } catch (error) {
        log({ event: "toolset_skipped", toolset: name, error: error.message });
      }
    }
    const tools = started.flatMap((t) => t.tools);
    const names = new Set();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`two toolsets define ${tool.name}`);
      names.add(tool.name);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    const handler = createMcpHttpHandler({
      token,
      resolveAgent: (name, req) => name !== "bantam" && (name !== "operator" || req.headers["x-bantam-operator"] === "1"),
      listTools: () => tools,
      callTool: (name, args, context) => byName.get(name).handler(args, context),
      serverInfo: { name: "bantam", title: "BANTAM", version: packageVersion() },
      instructions: SERVER_INSTRUCTIONS,
      log,
    });
    server = http.createServer(handler);
    // room_wait holds a request open for minutes; do not let Node cut it off.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    const bound = server.address().port;
    const url = `http://${host === "::1" ? "[::1]" : host}:${bound}`;
    writeJsonAtomic(paths.serverInfo, { url, port: bound, pid: process.pid, startedAt: new Date().toISOString(), toolsets: ctx.toolsets, mode });
    log({ event: "mcp_listening", url, toolsets: ctx.toolsets, room: paths.root });
    let closed = false;
    return {
      url, port: bound, token, room, toolsets: ctx.toolsets, tools: tools.map((t) => t.name),
      async close() {
        if (closed) return;
        closed = true;
        await shutdown({ server, started, lock, paths, log });
      },
    };
  } catch (error) {
    await shutdown({ server, started, lock, paths, log });
    throw error;
  }
}

async function shutdown({ server, started, lock, paths, log }) {
  for (const toolset of [...started].reverse()) {
    try { await toolset.stop(); } catch (error) { log({ event: "toolset_stop_failed", toolset: toolset.name, error: error.message }); }
  }
  if (server) {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }
  try { fs.rmSync(paths.serverInfo, { force: true }); } catch { /* best effort */ }
  lock?.release();
}

function packageVersion() {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0"; }
}
