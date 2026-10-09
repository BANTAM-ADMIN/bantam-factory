// `bantam mcp …`: serve a room, and let the operator talk into it and watch it.
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PORT, DEFAULT_TOOLSETS, ensureRoom, readToken, roomPaths, startMcpServer } from "./server.js";
import { MESSAGE_KINDS } from "./room.js";

export const MCP_USAGE = `bantam mcp — BANTAM as an MCP server for Claude Code (docs/MCP.md)

  bantam mcp serve  [--room DIR] [--mode llama|jev] [--port ${DEFAULT_PORT}] [--toolsets ${DEFAULT_TOOLSETS.join(",")}]
                    [--local-endpoint http://127.0.0.1:8085] [--stand-in-model gpt-5.6-luna] [--codex-lanes 1]

  --mode llama  (default) local jobs run BANTAM on the llama.cpp model; Jev starts on demand
                and trades the GPU with it.
  --mode jev    DiffusionGemma starts with the server and stays awake; local jobs run BANTAM
                with a Codex model standing in for the local one (--stand-in-model).
  --codex-lanes how many Codex jobs run at once (1-4, default 1); each job has its own workspace.
  bantam mcp config [--room DIR] [--agent claude]   print the claude mcp add command
  bantam mcp say    [--room DIR] [--to claude] [--kind note] <text…>
  bantam mcp log    [--room DIR] [--follow] [--all]
  bantam mcp status [--room DIR]

  --room defaults to the current directory.`;

export function parseMcpArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (["follow", "all", "help"].includes(key)) { flags[key] = true; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    flags[key] = value;
  }
  return { sub: rest[0] ?? "help", rest: rest.slice(1), flags };
}

function runningServer(roomDir) {
  const { serverInfo } = roomPaths(roomDir);
  try {
    const info = JSON.parse(fs.readFileSync(serverInfo, "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch { return null; }
}

async function operatorCall(roomDir, info, name, args) {
  const res = await fetch(`${info.url}/mcp/operator`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${readToken(roomDir)}`, "x-bantam-operator": "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw new Error(body.result.content[0].text);
  return body.result.structuredContent;
}

export function formatRecord(record) {
  const time = record.at.slice(11, 19);
  if (record.type === "message") {
    const extra = [record.task && `task ${record.task}`, record.replyTo && `re ${record.replyTo}`].filter(Boolean).join(", ");
    return `${time} ${record.id} ${record.from} → ${record.to.join(",")} [${record.kind}]${extra ? ` (${extra})` : ""}\n    ${record.text.replace(/\n/g, "\n    ")}${record.artifacts ? `\n    artifacts: ${record.artifacts.join(", ")}` : ""}`;
  }
  if (record.type === "task") return `${time} task ${record.task.id} ${record.task.state}${record.task.owner ? ` (${record.task.owner})` : ""}: ${record.task.title}${record.task.note ? ` — ${record.task.note}` : ""}`;
  if (record.type === "ack") return `${time} ${record.by} acknowledged ${record.message}`;
  return null;
}

export async function runMcpCli(argv, { out = console.log } = {}) {
  let parsed;
  try { parsed = parseMcpArgs(argv); } catch (error) { out(`  ${error.message}\n\n${MCP_USAGE}`); return 2; }
  const { sub, rest, flags } = parsed;
  const roomDir = path.resolve(flags.room ?? process.cwd());
  try {
    if (sub === "serve") {
      const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
      const toolsets = (flags.toolsets ?? DEFAULT_TOOLSETS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
      const mode = flags.mode ?? "llama";
      if (!["llama", "jev"].includes(mode)) throw new Error("--mode must be llama or jev");
      const localEndpoint = flags["local-endpoint"] ?? process.env.BANTAM_ENDPOINT ?? "http://127.0.0.1:8085";
      const standInModel = mode === "jev" ? (flags["stand-in-model"] ?? "gpt-5.6-luna") : null;
      const codexLanes = flags["codex-lanes"] === undefined ? 1 : Number(flags["codex-lanes"]);
      if (!Number.isInteger(codexLanes) || codexLanes < 1 || codexLanes > 4) throw new Error("--codex-lanes must be 1 to 4");
      const lanes = { local: 1, codex: codexLanes };
      const log = (entry) => {
        if (entry.event === "tool_crash" || entry.event === "rpc_crash") out(`  ! ${entry.event}: ${entry.error}`);
        else if (entry.event === "toolset_skipped") out(`  ! toolset ${entry.toolset} is off: ${entry.error}`);
        else if (entry.event === "room_log_recovered") out(`  ! the room log's last line was torn by a crash and has been dropped`);
        else if (entry.event === "job") out(`  job ${entry.job} ${entry.state}${entry.detail ? `: ${entry.detail}` : ""}`);
        else if (entry.event === "jev_ready") out("  Jev: DiffusionGemma is awake");
        else if (entry.event === "jev_start_failed") out(`  ! Jev could not start: ${entry.error}`);
      };
      const server = await startMcpServer({ roomDir, port, toolsets, log, mode,
        toolsetOptions: mode === "jev"
          ? { jobs: { standInModel, lanes }, jev: { localEndpoint: null, eager: true }, writer: {} }
          : { jobs: { localEndpoint, lanes }, jev: { localEndpoint }, writer: { localEndpoint } } });
      out(`  BANTAM MCP serving ${server.url}/mcp/<agent>  room ${roomDir}`);
      out(mode === "jev" ? `  mode: jev · DiffusionGemma stays awake · local jobs run on ${standInModel} (stand-in)` : `  mode: llama · local jobs on ${localEndpoint} · Jev on demand`);
      out(`  codex lanes: ${codexLanes}`);
      out(`  toolsets: ${server.toolsets.join(", ") || "(none)"} · ${server.tools.length} tools`);
      out(`  connect Claude Code:  bantam mcp config --room ${JSON.stringify(roomDir)}`);
      out(`  watch the room:       bantam mcp log --follow --room ${JSON.stringify(roomDir)}`);
      await new Promise((resolve) => {
        const stop = () => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      out("  stopping…");
      await server.close();
      return 0;
    }
    if (sub === "config") {
      ensureRoom(roomDir);
      const info = runningServer(roomDir);
      const agent = flags.agent ?? "claude";
      const url = `${info?.url ?? `http://127.0.0.1:${flags.port ?? DEFAULT_PORT}`}/mcp/${agent}`;
      if (agent === "codex") {
        // Codex reads the token from an environment variable, never from its config file.
        out(`codex mcp add bantam --url ${url} --bearer-token-env-var BANTAM_MCP_TOKEN`);
        out(`\n# then in ~/.codex/config.toml under [mcp_servers.bantam]:\ntool_timeout_sec = 660                 # room_wait blocks up to 600 s\ndefault_tools_approval_mode = "approve" # needed for codex exec; optional interactively`);
        out(`\n# start Codex in the room with the token:\nBANTAM_MCP_TOKEN=$(cat ${JSON.stringify(path.join(roomPaths(roomDir).runtime, "token"))}) codex`);
        return 0;
      }
      out(`claude mcp add --transport http bantam ${url} --header "Authorization: Bearer ${readToken(roomDir)}"`);
      out(`\n# or in .mcp.json:\n${JSON.stringify({ mcpServers: { bantam: { type: "http", url, headers: { Authorization: `Bearer ${readToken(roomDir)}` } } } }, null, 2)}`);
      return 0;
    }
    if (sub === "say") {
      const text = rest.join(" ").trim();
      if (!text) throw new Error("say needs text");
      const kind = flags.kind ?? "note";
      if (!MESSAGE_KINDS.includes(kind)) throw new Error(`--kind must be one of ${MESSAGE_KINDS.join(", ")}`);
      const info = runningServer(roomDir);
      if (!info) throw new Error(`no BANTAM MCP server is running for ${roomDir} (start one with bantam mcp serve)`);
      const to = (flags.to ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
      const posted = await operatorCall(roomDir, info, "room_post", { to, kind, text });
      out(`  posted ${posted.id} → ${to.join(",")}`);
      return 0;
    }
    if (sub === "log") {
      const { log } = roomPaths(roomDir);
      if (!fs.existsSync(log)) throw new Error(`no room log at ${log}`);
      let offset = 0, partial = "";
      const print = () => {
        const size = fs.statSync(log).size;
        if (size <= offset) return;
        const fd = fs.openSync(log, "r");
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = size;
        const lines = (partial + buffer.toString("utf8")).split("\n");
        partial = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const record = JSON.parse(line);
          if (!flags.all && record.type === "cursor") continue;
          const text = formatRecord(record);
          if (text) out(text);
        }
      };
      print();
      if (!flags.follow) return 0;
      const timer = setInterval(print, 500);
      await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      clearInterval(timer);
      return 0;
    }
    if (sub === "status") {
      const info = runningServer(roomDir);
      out(info ? `  serving ${info.url} (pid ${info.pid}, since ${info.startedAt}) · toolsets ${info.toolsets.join(", ")}` : "  not serving");
      const jobsDir = path.join(roomPaths(roomDir).runtime, "jobs");
      const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).map((id) => {
        try { return JSON.parse(fs.readFileSync(path.join(jobsDir, id, "job.json"), "utf8")); } catch { return null; }
      }).filter(Boolean) : [];
      for (const job of jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-15)) {
        out(`  ${job.id} ${job.worker.padEnd(12)} ${job.state.padEnd(11)} ${job.task.split("\n")[0].slice(0, 70)}`);
      }
      return 0;
    }
    out(MCP_USAGE);
    return sub === "help" ? 0 : 2;
  } catch (error) {
    out(`  bantam mcp ${sub}: ${error.message}`);
    return 1;
  }
}
