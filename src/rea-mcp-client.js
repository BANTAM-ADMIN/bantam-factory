// Small stdio MCP client used by Bantam's optional REA action.
// It intentionally starts the caller-selected local REA dispatcher directly,
// without a shell, and lets the user choose which advertised tools are exposed.
// REA itself is an add-on (src/rea-addon.js): BANTAM_REA_ROOT or the copy that
// `bantam addons install rea` put under ~/.bantam/addons/rea.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findReaRoot, reaUnavailableReason } from "./rea-addon.js";
import { createRequire } from "node:module";

const BANTAM_VERSION = createRequire(import.meta.url)("../package.json").version;

// "*" exposes every advertised tool through searchable discovery; a
// comma-separated BANTAM_REA_TOOLS list narrows that to an explicit allowlist.
const DEFAULT_TOOLS = "*";

function resultContext(output) {
  let evidence;
  try { evidence = JSON.parse(output); } catch { return ""; }
  const rows = evidence?.normalized_result?.rows;
  if (!Array.isArray(rows) || !rows.some(row => row?.properties?.relationship_kind === "commonjs-export"
    && row.properties.exported_name === "default")) return "";
  return "\n[REA interpretation context] These rows include a CommonJS export-binding labeled default. That label alone does not establish an ESM default export or the named members of the assigned object. Verify module.exports/exports in the cited source before describing the public export API.";
}
const sharedSessions = new Map();
const environmentIds = new WeakMap();
let nextEnvironmentId = 0;

function sessionKey(options = {}) {
  const env = options.env ?? process.env;
  if (!environmentIds.has(env)) environmentIds.set(env, ++nextEnvironmentId);
  return JSON.stringify([
    options.command ?? process.env.BANTAM_REA_MCP_COMMAND ?? process.execPath,
    options.args ?? process.env.BANTAM_REA_MCP_ARGS ?? null,
    options.cwd ?? options.workspace ?? findReaRoot(options.env ?? process.env),
    options.toolNames ?? process.env.BANTAM_REA_TOOLS ?? DEFAULT_TOOLS,
    options.startupTimeoutMs ?? null, options.toolTimeoutMs ?? null,
    options.shutdownTimeoutMs ?? null, environmentIds.get(env),
  ]);
}

/** Share one stdio server when Bantam opens nested agent runs on the same loop. */
export async function acquireReaMcpClient(options) {
  const key = sessionKey(options);
  let entry = sharedSessions.get(key);
  if (!entry) {
    entry = { users: 0, promise: startReaMcpClient(options) };
    sharedSessions.set(key, entry);
  }
  entry.users++;
  let session;
  try { session = await entry.promise; }
  catch (cause) {
    entry.users--;
    if (sharedSessions.get(key) === entry) sharedSessions.delete(key);
    throw cause;
  }
  let released = false;
  return {
    ...session,
    close: async () => {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.users === 0) {
        if (sharedSessions.get(key) === entry) sharedSessions.delete(key);
        await session.close();
      }
    },
  };
}

// Tools REA reports it cannot run on this host, from binary_session's
// tool_availability. target_required is not a host limit: open_binary fixes it.
const HOST_LIMITS = new Set(["provider_missing", "provider_unavailable", "unsupported_host"]);
async function unusableHere(request, byName, targetBound = new Set()) {
  const unusable = new Map();
  if (!byName.has("binary_session")) return unusable;
  try {
    const result = await request("tools/call", { name: "binary_session", arguments: {} });
    const text = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("");
    const session = text ? JSON.parse(text) : result.structuredContent;
    for (const group of (session?.result ?? session)?.tool_availability?.groups ?? []) {
      if (!group.available && group.reason === "target_required") for (const name of group.names ?? []) targetBound.add(name);
      if (group.available || !HOST_LIMITS.has(group.reason)) continue;
      for (const name of group.names ?? []) unusable.set(name, group.remediation || group.reason);
    }
  } catch { /* availability is advisory; discovery still works without it */ }
  return unusable;
}

// A deep provider (Ghidra, IDA, pwntools...) being absent says nothing about
// the lighter tools: open_binary often makes objdump-backed tools usable. Name
// what REA reports runnable right now so a failed call is not a dead end.
async function availableNow(request, targetBound, failedTool) {
  if (!targetBound.size) return "";
  try {
    const result = await request("tools/call", { name: "binary_session", arguments: {} });
    const text = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("");
    const session = text ? JSON.parse(text) : result.structuredContent;
    const names = ((session?.result ?? session)?.tool_availability?.groups ?? [])
      .filter((group) => group.available)
      .flatMap((group) => group.names ?? [])
      .filter((name) => name !== failedTool && targetBound.has(name));
    return names.length
      ? `\n[REA availability] ${failedTool} needs a provider this machine lacks. Tools for the open target that REA reports usable now: ${names.join(", ")}. Try a relevant one before concluding the evidence is unavailable.`
      : "";
  } catch { return ""; }
}

// The "Route the target first" section of REA's agent skill: which tool to
// start from for each kind of input. Read from the installed package.
function routingGuide(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const start = text.indexOf("## Route the target first");
  if (start < 0) return [];
  const end = text.indexOf("\n## ", start + 4);
  const section = text.slice(start, end < 0 ? undefined : end).trim();
  return [`REA's own routing guide (start from the tool it names for your input type; if no route fits the input, REA most likely does not support that format, so say so and use your other tools rather than searching repeatedly):\n${section}`];
}

export async function startReaMcpClient({
  command = process.env.BANTAM_REA_MCP_COMMAND || process.execPath,
  args,
  cwd,
  // The run's workspace. REA runs on the host, outside the shell sandbox, so
  // it needs host paths; relative paths resolve here too.
  workspace = null,
  env = process.env,
  toolNames = process.env.BANTAM_REA_TOOLS || DEFAULT_TOOLS,
  startupTimeoutMs = Number(process.env.BANTAM_REA_MCP_STARTUP_TIMEOUT_MS) || 30_000,
  toolTimeoutMs = 600_000,
  shutdownTimeoutMs = 1_000,
  // REA's own routing guide; the default launch reads it from the installed
  // package so it always matches the running version.
  guideFile,
} = {}) {
  if (args === undefined && env.BANTAM_REA_MCP_ARGS) args = JSON.parse(env.BANTAM_REA_MCP_ARGS);
  const workspaceRoot = workspace ? path.resolve(workspace) : null;
  cwd ??= workspaceRoot ?? undefined;
  if (args === undefined || cwd === undefined) {
    // Only the default launch needs an installed REA; an explicit command and
    // working directory (tests, a custom wrapper) bring their own.
    const reason = args === undefined ? reaUnavailableReason(env) : null;
    if (reason) throw new Error(reason);
    const root = findReaRoot(env);
    args ??= [path.join(root, "scripts/rea.mjs"), "mcp"];
    cwd ??= root ?? process.cwd();
    if (root) guideFile ??= path.join(root, "skills", "reverse-engineer-anything", "SKILL.md");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("BANTAM_REA_MCP_ARGS must be a JSON array of strings");
  }
  if (!toolNames?.trim()) {
    throw new Error("Set BANTAM_REA_TOOLS to a comma-separated allowlist of REA MCP tool names");
  }

  const child = spawn(command, args, {
    cwd,
    env: { ...env, REA_LOG_LEVEL: env.REA_LOG_LEVEL || "error" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  let stdoutBuffer = "";
  let stderrTail = "";
  let closed = false;
  let closePromise = null;
  const childClosed = new Promise(resolve => child.once("close", resolve));

  const failPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const end = stdoutBuffer.indexOf("\n");
      if (end < 0) break;
      const line = stdoutBuffer.slice(0, end).trim();
      stdoutBuffer = stdoutBuffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { failPending(new Error("REA MCP server wrote invalid JSON to stdout")); continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "REA MCP request failed"));
      else entry.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });
  child.stdin.on("error", cause => failPending(new Error(`REA MCP stdin failed: ${cause.message}`)));
  child.once("error", (cause) => failPending(new Error(`Could not start REA MCP server: ${cause.message}`)));
  child.once("exit", (code, signal) => {
    closed = true;
    const detail = stderrTail.trim();
    failPending(new Error(`REA MCP server exited (${signal || code})${detail ? `: ${detail}` : ""}`));
  });

  const request = (method, params, timeoutMs = startupTimeoutMs, signal = null) => {
    if (closed || child.stdin.destroyed) return Promise.reject(new Error("REA MCP server is not running"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        pending.delete(id);
        signal?.removeEventListener("abort", abort);
        if (!closed && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Bantam request timed out" } })}\n`);
        entry?.reject(new Error(`REA MCP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Bantam action cancelled" } })}\n`);
        clearTimeout(timer);
        pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(new Error("REA MCP action was cancelled"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (cause) => { signal?.removeEventListener("abort", abort); reject(cause); },
        timer,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (cause) => {
        if (!cause) return;
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(cause);
      });
    });
  };

  const notify = (method, params) => {
    if (!closed && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bantam-factory", version: BANTAM_VERSION },
    });
    notify("notifications/initialized", {});

    const advertised = [];
    let cursor;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      advertised.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);

    const discoveryMode = toolNames.trim() === "*";
    const selectedNames = new Set(discoveryMode ? advertised.map(tool => tool.name)
      : toolNames.split(",").map((name) => name.trim()).filter(Boolean));
    const byName = new Map(advertised.map((tool) => [tool.name, tool]));
    const missing = [...selectedNames].filter((name) => !byName.has(name));
    if (missing.length) throw new Error(`REA MCP allowlist contains unknown tool(s): ${missing.join(", ")}`);
    const tools = [...selectedNames].map((name) => byName.get(name));
    if (!tools.length) throw new Error("BANTAM_REA_TOOLS selected no REA MCP tools");
    const learned = new Set(discoveryMode ? [] : selectedNames);
    // Tools that wait for open_binary; once a target is bound, these are the
    // ones a provider failure should point to.
    const targetBound = new Set();
    const unusable = await unusableHere(request, byName, targetBound);

    const discover = ({ q = "", name = "", page = 1 } = {}) => {
      // An exact tool-name search is already an unambiguous schema request.
      // Accept it rather than requiring another model turn to move q into name.
      if (!name && tools.some(tool => tool.name === q.trim())) name = q.trim();
      if (name) {
        const definition = tools.find(tool => tool.name === name);
        if (!definition) throw new Error(`REA tool ${JSON.stringify(name)} is not available in this session; use rea_tools to search`);
        learned.add(name);
        // Calls need the complete INPUT contract. MCP's outputSchema may
        // contain hundreds of provider result definitions (170 KB for a single
        // view tool), which evicts the source being investigated. This is a
        // metadata projection, never a truncation of an analysis observation.
        const { title, description, inputSchema, annotations } = definition;
        return JSON.stringify({ name, title, description, inputSchema, annotations,
          ...(unusable.has(name) ? { unavailable_here: unusable.get(name) } : {}),
          schema_scope: "complete-input", output_schema_included: false });
      }
      if (!Number.isSafeInteger(page) || page < 1) throw new Error("REA discovery page must be a positive integer");
      const terms = q.toLowerCase().match(/[a-z0-9]+/g) || [];
      const tokens = value => new Set((value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
      const matches = tools.map(tool => ({tool, score: terms.reduce((score, term) => score
        + (tokens(tool.name).has(term) ? 4 : 0)
        + (tokens(tool.description).has(term) ? 1 : 0), 0)}))
        .filter(row => !terms.length || row.score > 0)
        // Tools this machine cannot run stay listed, after every runnable match.
        .sort((a,b) => unusable.has(a.tool.name) - unusable.has(b.tool.name)
          || b.score-a.score || a.tool.name.localeCompare(b.tool.name));
      const start = (page-1)*12;
      return JSON.stringify({ query: q, available_tools: tools.length, matching_tools: matches.length,
        page, next_page: start+12 < matches.length ? page+1 : null,
        tools: matches.slice(start,start+12).map(({tool}) => ({name:tool.name, description:tool.description,
          ...(unusable.has(tool.name) ? { unavailable_here: unusable.get(tool.name) } : {})})),
        next_step: "Fetch a full input schema with rea_tools name before invoking that tool. Availability does not establish support for a particular target format. Skip tools marked unavailable_here unless the operator installs what they name." });
    };

    const prompt = [
      `REA MCP connected: ${tools.length} tools available${discoveryMode ? " through searchable discovery" : " in an explicit allowlist"}.`,
      ...(workspaceRoot ? [`REA runs on the host, not in the shell sandbox. Give it host paths: the workspace is ${JSON.stringify(workspaceRoot)}, so a workspace file is ${JSON.stringify(path.join(workspaceRoot, "<file>"))}. Do not guess other mount points such as /workspace.`] : []),
      'Use {"a":"rea_tools","q":"archive"} to search capabilities, or {"a":"rea_tools","name":"open_binary"} to retrieve a complete tool schema. An exact tool name in q also retrieves that schema. Do not equate a small displayed menu with the server\'s full capabilities.',
      "Discover suitable tools for the actual input type before claiming support or lack of support. Match the tool to the input: a native binary, ROM or firmware image is not a JavaScript application.",
      "Call rea_tool with tool set to the listed name and args set to a JSON object encoded as a string.",
      "Identify a target's format, platform and product from observed file/header evidence, not from what its name suggests or from memory of similar files.",
      ...(unusable.size ? [`${unusable.size} REA tools cannot run on this machine (a provider such as adb, pwntools or TShark is missing, or the host is not macOS); discovery marks them unavailable_here with REA's remedy.`] : []),
      ...routingGuide(guideFile),
      ...(discoveryMode ? ["Fetch a tool's schema using rea_tools name before its first call. Discovery returns metadata, not analysis evidence. Preserve returned Evidence IDs, limitations and scope."]
        : tools.map((tool) => JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))),
    ].join("\n");

    return {
      tools,
      prompt,
      discover,
      call: async ({ tool, args: encodedArgs }, { signal } = {}) => {
        const definition = tools.find((candidate) => candidate.name === tool);
        if (!definition) throw new Error(`Tool ${JSON.stringify(tool)} is not enabled for this run`);
        if (!learned.has(tool)) {
          // Recover at the decision point: return the actual input contract
          // instead of making the model spend another action finding it.
          const schema = discover({ name: tool });
          throw new Error(`Schema first: this ${tool} call was not dispatched. Review the complete input schema below and retry with its exact arguments in your next action.\n${schema}`);
        }
        let parsedArgs;
        try { parsedArgs = JSON.parse(encodedArgs); }
        catch { throw new Error("args must contain a valid JSON object"); }
        if (!parsedArgs || Array.isArray(parsedArgs) || typeof parsedArgs !== "object") {
          throw new Error("args must contain a JSON object");
        }
        const result = await request("tools/call", { name: tool, arguments: parsedArgs }, toolTimeoutMs, signal);
        const text = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
        const output = text || (result.structuredContent === undefined
          ? ""
          : JSON.stringify(result.structuredContent, null, 2));
        if (result.isError) {
          const missing = /"code"\s*:\s*"provider_(?:unavailable|missing)"/.test(output)
            ? await availableNow(request, targetBound, tool) : "";
          return `REA MCP tool error: ${output || "unknown error"}${missing}`;
        }
        return output ? output + resultContext(output) : "REA MCP tool returned no content";
      },
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }

  function close() {
    return closePromise ??= (async () => {
      closed = true;
      failPending(new Error("REA MCP client closed"));
      if (!child.stdin.destroyed) child.stdin.end();
      const waitForClose = ms => new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        childClosed.then(() => { clearTimeout(timer); resolve(true); });
      });
      if (await waitForClose(shutdownTimeoutMs)) return;
      child.kill("SIGTERM");
      if (await waitForClose(shutdownTimeoutMs)) return;
      child.kill("SIGKILL");
      if (await waitForClose(shutdownTimeoutMs)) return;
      throw new Error("REA MCP child did not close after SIGKILL; cleanup is unresolved");
    })();
  }
}
