// Model-free command handler for BANTAM's content-addressed state store.

import fs from "node:fs";
import path from "node:path";
import { LaneStore } from "./lane-store.js";
import { launchPinnedChannel } from "./channel-launcher.js";
import { validatePromotionEvidence, EvidenceError } from "./promotion-evidence.js";

const STATE_COMMANDS = new Set(["state", "channel", "lane"]);
const OPERATIONS = {
  state: new Set(["init"]),
  channel: new Set(["list", "show", "history", "checkpoint", "promote", "rollback", "materialize", "run", "experiment"]),
  lane: new Set(["create", "list", "status", "checkpoint", "fork", "materialize"]),
};

export function isStateCommand(command) {
  return STATE_COMMANDS.has(String(command ?? ""));
}

export function runStateCommand(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const input = Array.isArray(args) ? [...args] : [];
  const jsonRequested = requestedJson(input);
  const succeed = (result) => {
    if (result?.transparent) return result.exitCode;
    writeOutput(stdout, globals.json ? JSON.stringify(result) + "\n" : formatText(result));
    return 0;
  };
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const json = jsonRequested
      ? JSON.stringify({ ok: false, error: message }) + "\n"
      : `error: ${message}\n`;
    writeOutput(stderr, json);
    return error instanceof CommandError ? 2 : 1;
  };
  let globals;
  try {
    if (!Array.isArray(args)) throw new CommandError("command arguments must be an array");
    globals = extractGlobals(input);
    const root = resolveStateHome(cwd, env, globals.stateHome);
    const result = dispatch(globals.args, { cwd: path.resolve(cwd), root, env });
    return result && typeof result.then === "function"
      ? result.then(succeed, fail)
      : succeed(result);
  } catch (error) {
    return fail(error);
  }
}

function dispatch(args, context) {
  const [command, operation, ...rest] = args;
  if (!isStateCommand(command)) throw usage("expected state, channel, or lane command");
  if (!operation) throw usage(`missing ${command} operation`);
  if (!OPERATIONS[command].has(operation)) throw usage(`unknown ${command} operation: ${operation}`);
  const store = new LaneStore(context.root);

  if (command === "state") return runState(operation, rest, store, context);
  if (command === "channel") return runChannel(operation, rest, store, context);
  return runLane(operation, rest, store, context);
}

function runState(operation, args, store, context) {
  if (operation !== "init") throw usage(`unknown state operation: ${operation}`);
  const parsed = parseArgs(args, { flags: ["source"], positionals: 0 });
  const regular = store.readChannel("regular");
  const dev = store.readChannel("dev");
  if (regular && !dev) {
    const repaired = store.initChannel("dev", regular.versionRef);
    return {
      ok: true,
      command: "state.init",
      initialized: true,
      recovered: true,
      stateHome: store.root,
      versionRef: regular.versionRef,
      regular: channelView(regular),
      dev: channelView(repaired),
    };
  }
  if (dev && !regular) {
    const repaired = store.initChannel("regular", dev.versionRef);
    return {
      ok: true,
      command: "state.init",
      initialized: true,
      recovered: true,
      stateHome: store.root,
      versionRef: dev.versionRef,
      regular: channelView(repaired),
      dev: channelView(dev),
    };
  }
  if (regular && dev) {
    return {
      ok: true,
      command: "state.init",
      initialized: false,
      stateHome: store.root,
      regular: channelView(regular),
      dev: channelView(dev),
    };
  }

  const source = requireDirectory(resolvePath(context.cwd, parsed.source ?? context.cwd), "source");
  assertSeparateStateRoot(source, store.root);
  const checkpoint = store.workspaces.capture(source, {
    message: "BANTAM initial harness workspace",
  });
  const versionRef = store.putVersion(harnessVersion(checkpoint));
  const nextRegular = store.initChannel("regular", versionRef);
  const nextDev = store.initChannel("dev", versionRef);
  return {
    ok: true,
    command: "state.init",
    initialized: true,
    stateHome: store.root,
    versionRef,
    regular: channelView(nextRegular),
    dev: channelView(nextDev),
  };
}

function runChannel(operation, args, store, context) {
  if (operation === "list") {
    parseArgs(args, { positionals: 0 });
    return {
      ok: true,
      command: "channel.list",
      channels: store.listChannels().map(channelView),
    };
  }

  if (operation === "show") {
    const parsed = parseArgs(args, { positionals: 1 });
    const channel = requireChannel(store, parsed.positionals[0]);
    return { ok: true, command: "channel.show", channel: channelView(channel) };
  }

  if (operation === "history") {
    const parsed = parseArgs(args, { positionals: 1 });
    const name = parsed.positionals[0];
    requireChannel(store, name);
    return {
      ok: true,
      command: "channel.history",
      channel: name,
      events: store.channelHistory(name).map(channelEventView),
    };
  }

  if (operation === "checkpoint") {
    const parsed = parseArgs(args, { flags: ["source", "expected"], positionals: 1 });
    const name = parsed.positionals[0];
    const current = requireChannel(store, name);
    const expected = parsed.expected ?? current.versionRef;
    if (expected !== current.versionRef) {
      throw new CommandError(
        `stale channel ref ${name}: expected ${expected}, found ${current.versionRef}`,
      );
    }
    const source = requireDirectory(resolvePath(context.cwd, parsed.source ?? context.cwd), "source");
    assertSeparateStateRoot(source, store.root);
    const checkpoint = store.workspaces.capture(source, {
      message: `BANTAM ${name} harness checkpoint`,
    });
    const next = store.advanceChannel(name, expected, harnessVersion(checkpoint), {
      operation: "channel.checkpointed",
      metadata: { source: "state-cli", sourceWorkspace: source },
    });
    return {
      ok: true,
      command: "channel.checkpoint",
      channel: channelView(next),
      previousVersionRef: expected,
    };
  }

  if (operation === "promote") {
    // CLAUDE.md: "move `regular` only after the comparison clears its declared
    // bar." The move now carries validated experiment evidence (--evidence) or
    // an explicit, audited waiver (--allow-unevidenced); the channel event
    // records which. Neither flag is a usage error; both together is a conflict.
    const parsed = parseArgs(args, {
      flags: ["from", "to", "evidence", "arm"],
      booleans: ["allow-unevidenced"],
      positionals: 0,
    });
    const fromName = parsed.from ?? "dev";
    const toName = parsed.to ?? "regular";
    if (fromName === toName) throw new CommandError("promotion source and destination must differ");
    if (parsed.evidence && parsed["allow-unevidenced"]) {
      throw new CommandError("--evidence and --allow-unevidenced are mutually exclusive");
    }
    if (!parsed.evidence && !parsed["allow-unevidenced"]) {
      throw usage("channel promote requires --evidence <experiment-dir|manifest.json> (or an explicit --allow-unevidenced)");
    }
    const from = requireChannel(store, fromName);
    const to = requireChannel(store, toName);
    const sourceWorkspaceTree = from.version?.value?.workspaceTree;
    const sourceWorkspaceCommit = from.version?.value?.workspaceCommit;
    if (typeof sourceWorkspaceTree !== "string") {
      throw new CommandError(`promotion source ${fromName}/${from.versionRef} has no harness workspace tree`);
    }
    if (typeof sourceWorkspaceCommit !== "string") {
      throw new CommandError(`promotion source ${fromName}/${from.versionRef} has no harness workspace commit`);
    }
    let evidence = null;
    if (parsed.evidence) {
      try {
        evidence = validatePromotionEvidence(resolvePath(context.cwd, parsed.evidence), {
          arm: parsed.arm,
          sourceChannel: fromName,
          candidateVersionRef: from.versionRef,
          workspaceCommit: sourceWorkspaceCommit,
          workspaceTree: sourceWorkspaceTree,
          harnessRoot: context.cwd,
        });
      } catch (error) {
        if (error instanceof EvidenceError) throw new CommandError(error.message);
        throw error;
      }
    }
    const promoted = store.advanceChannel(toName, to.versionRef, from.versionRef, {
      operation: "channel.promoted",
      metadata: {
        source: "state-cli",
        from: fromName,
        sourceChannel: fromName,
        sourceVersionRef: from.versionRef,
        sourceWorkspaceCommit,
        sourceWorkspaceTree,
        ...(evidence ? { evidenceManifestSha256: evidence.manifestSha256 } : {}),
        ...(evidence ? { evidence } : { unevidenced: true }),
      },
    });
    return {
      ok: true,
      command: "channel.promote",
      from: fromName,
      to: toName,
      versionRef: promoted.versionRef,
      previousVersionRef: to.versionRef,
      evidence,
      channel: channelView(promoted),
    };
  }

  if (operation === "rollback") {
    const parsed = parseArgs(args, { flags: ["expected", "to"], positionals: 1 });
    const name = parsed.positionals[0];
    if (!parsed.expected || !parsed.to) {
      throw usage("channel rollback requires NAME --expected CURRENT --to PRIOR");
    }
    const current = requireChannel(store, name);
    if (current.versionRef !== parsed.expected) {
      throw new CommandError(
        `stale channel ref ${name}: expected ${parsed.expected}, found ${current.versionRef}`,
      );
    }
    let rolledBack;
    try {
      rolledBack = store.rollbackChannel(name, parsed.expected, parsed.to, { source: "state-cli" });
    } catch (error) {
      throw new CommandError(error.message);
    }
    return {
      ok: true,
      command: "channel.rollback",
      previousVersionRef: parsed.expected,
      versionRef: rolledBack.versionRef,
      channel: channelView(rolledBack),
    };
  }

  if (operation === "materialize") {
    const parsed = parseArgs(args, {
      flags: ["to", "version", "expected"],
      positionals: 1,
    });
    if (!parsed.to) throw usage("channel materialize requires NAME --to DIR");
    const restored = store.materializeChannel(
      parsed.positionals[0],
      resolvePath(context.cwd, parsed.to),
      {
        versionRef: parsed.version ?? null,
        expectedVersionRef: parsed.expected ?? null,
      },
    );
    return {
      ok: true,
      command: "channel.materialize",
      channel: restored.channel,
      versionRef: restored.versionRef,
      destination: restored.destination,
      workspaceCommit: restored.commit,
      workspaceTree: restored.tree,
    };
  }

  if (operation === "run" || operation === "experiment") {
    const delimiter = args.indexOf("--");
    if (delimiter === -1) {
      throw usage(`channel ${operation} requires -- before pinned harness arguments`);
    }
    const parsed = parseArgs(args.slice(0, delimiter), {
      flags: ["lane", "expected", "dependency-root"],
      positionals: 1,
    });
    if (!parsed.lane || !parsed.expected) {
      throw usage(
        `channel ${operation} requires NAME --lane ID --expected VERSION -- ` +
        (operation === "run" ? "[run options]" : "spec.json [experiment options]"),
      );
    }
    const dependencyRoot = parsed["dependency-root"]
      ? requireDirectory(resolvePath(context.cwd, parsed["dependency-root"]), "dependency root")
      : null;
    return launchPinnedChannel({
      store,
      channel: parsed.positionals[0],
      laneId: parsed.lane,
      expectedVersionRef: parsed.expected,
      command: operation,
      dependencyRoot,
      args: args.slice(delimiter + 1),
      env: context.env,
    }).then((exitCode) => ({ transparent: true, exitCode }));
  }

  throw usage(`unknown channel operation: ${operation}`);
}

function runLane(operation, args, store, context) {
  if (operation === "create") {
    const parsed = parseArgs(args, { flags: ["channel", "workspace"], positionals: 1 });
    if (!parsed.channel) throw usage("lane create requires --channel NAME");
    const workspace = requireDirectory(
      resolvePath(context.cwd, parsed.workspace ?? context.cwd),
      "workspace",
    );
    assertSeparateStateRoot(workspace, store.root);
    const lane = store.createLane({
      laneId: parsed.positionals[0],
      channel: parsed.channel,
      sourceWorkspace: workspace,
      controllerState: {},
    });
    return { ok: true, command: "lane.create", lane: laneView(lane) };
  }

  if (operation === "list") {
    parseArgs(args, { positionals: 0 });
    return {
      ok: true,
      command: "lane.list",
      lanes: store.listLanes().map(laneStatusView),
    };
  }

  if (operation === "status") {
    const parsed = parseArgs(args, { positionals: 1 });
    return {
      ok: true,
      command: "lane.status",
      lane: laneStatusView(store.status(parsed.positionals[0])),
    };
  }

  if (operation === "checkpoint") {
    const parsed = parseArgs(args, { flags: ["controller-state"], positionals: 1 });
    const laneId = parsed.positionals[0];
    const state = parseControllerState(parsed["controller-state"] ?? "{}", context.cwd);
    const expected = store.status(laneId).eventId;
    // This command is the explicit operator adoption path: edits made in the
    // private lane workspace since its last checkpoint are intentional input.
    // Normal run acquisition remains strict and rejects unexplained drift.
    const writer = store.acquireLane(laneId, {
      expectedEventId: expected,
      allowWorkspaceDrift: true,
    });
    try {
      const lane = writer.checkpoint(state, { source: "state-cli" });
      return { ok: true, command: "lane.checkpoint", lane: laneView(lane) };
    } finally {
      writer.close();
    }
  }

  if (operation === "fork") {
    const parsed = parseArgs(args, {
      flags: ["from", "event", "channel"],
      positionals: 1,
    });
    if (!parsed.from || !parsed.event) {
      throw usage("lane fork requires NEW --from ID --event ID");
    }
    const lane = store.forkLane({
      laneId: parsed.positionals[0],
      fromLaneId: parsed.from,
      eventId: parsed.event,
      channel: parsed.channel ?? null,
      metadata: { source: "state-cli" },
    });
    return { ok: true, command: "lane.fork", lane: laneView(lane) };
  }

  if (operation === "materialize") {
    const parsed = parseArgs(args, { flags: ["event", "to"], positionals: 1 });
    if (!parsed.event || !parsed.to) {
      throw usage("lane materialize requires ID --event ID --to DIR");
    }
    const destination = resolvePath(context.cwd, parsed.to);
    const restored = store.materialize(parsed.positionals[0], parsed.event, destination);
    return {
      ok: true,
      command: "lane.materialize",
      laneId: restored.laneId,
      eventId: restored.eventId,
      destination: restored.destination,
      workspaceCommit: restored.commit,
      workspaceTree: restored.tree,
      controllerStateRef: restored.controllerStateRef,
    };
  }

  throw usage(`unknown lane operation: ${operation}`);
}

function harnessVersion(checkpoint) {
  return {
    kind: "bantam.harness-workspace",
    workspaceCommit: checkpoint.commit,
    workspaceTree: checkpoint.tree,
    files: checkpoint.files,
  };
}

function channelView(channel) {
  return {
    name: channel.name,
    eventRef: channel.eventRef,
    versionRef: channel.versionRef,
    parentVersionRef: channel.version.parentVersionRef,
    version: channel.version.value,
  };
}

function channelEventView(event) {
  return {
    eventRef: event.eventRef,
    type: event.type,
    time: event.time,
    previousVersionRef: event.previousVersionRef,
    versionRef: event.versionRef,
    metadata: event.metadata,
  };
}

function laneView(lane) {
  return {
    laneId: lane.laneId,
    eventId: lane.eventId,
    sequence: lane.event.seq,
    eventType: lane.event.type,
    channel: lane.channel,
    channelVersionRef: lane.channelVersionRef,
    workspacePath: lane.workspacePath,
    workspaceCommit: lane.workspaceCommit,
    workspaceTree: lane.workspaceTree,
    controllerStateRef: lane.controllerStateRef,
    controllerState: lane.controllerState,
    ancestry: lane.ancestry,
  };
}

function laneStatusView(status) {
  return {
    laneId: status.laneId,
    eventId: status.eventId,
    sequence: status.sequence,
    eventType: status.eventType,
    journalEvents: status.journalEvents,
    channel: status.channel,
    channelVersionRef: status.channelVersionRef,
    workspacePath: status.workspacePath,
    workspaceCommit: status.workspaceCommit,
    workspaceTree: status.workspaceTree,
    controllerStateRef: status.controllerStateRef,
    leased: status.leased,
    ancestry: status.ancestry,
  };
}

function extractGlobals(args) {
  const rest = [];
  let json = false;
  let stateHome;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (token === "--json") {
      if (json) throw usage("--json may only be specified once");
      json = true;
      continue;
    }
    if (token === "--state-home" || token.startsWith("--state-home=")) {
      if (stateHome !== undefined) throw usage("--state-home may only be specified once");
      const inline = token.startsWith("--state-home=") ? token.slice("--state-home=".length) : null;
      if (inline !== null) stateHome = inline;
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw usage("--state-home requires a directory");
        stateHome = value;
      }
      if (!stateHome) throw usage("--state-home requires a directory");
      continue;
    }
    rest.push(token);
  }
  return { args: rest, json, stateHome };
}

function requestedJson(args) {
  const delimiter = args.indexOf("--");
  const globals = delimiter === -1 ? args : args.slice(0, delimiter);
  return globals.includes("--json");
}

function parseArgs(args, { flags = [], booleans = [], positionals }) {
  const allowed = new Set([...flags, ...booleans]);
  const parsed = { positionals: [] };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = token.slice(2, equal === -1 ? undefined : equal);
    if (!allowed.has(name)) throw usage(`unknown option: --${name}`);
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      throw usage(`--${name} may only be specified once`);
    }
    if (booleans.includes(name)) {
      // Boolean flags (e.g. --allow-unevidenced) carry no value; --flag=x is a
      // usage error, and --flag must not consume the next token as its value.
      if (equal !== -1) throw usage(`--${name} takes no value`);
      parsed[name] = true;
      continue;
    }
    const value = equal === -1 ? args[++index] : token.slice(equal + 1);
    if (!value || value.startsWith("--")) throw usage(`--${name} requires a value`);
    parsed[name] = value;
  }
  if (parsed.positionals.length !== positionals) {
    throw usage(`expected ${positionals} positional argument${positionals === 1 ? "" : "s"}, got ${parsed.positionals.length}`);
  }
  return parsed;
}

function parseControllerState(specification, cwd) {
  let raw = specification;
  if (specification.startsWith("@")) {
    if (specification.length === 1) throw usage("controller state @file path is empty");
    const file = resolvePath(cwd, specification.slice(1));
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) { throw new CommandError(`cannot read controller state ${file}: ${error.message}`); }
  }
  try { return JSON.parse(raw); }
  catch (error) { throw new CommandError(`invalid controller state JSON: ${error.message}`); }
}

function requireChannel(store, name) {
  let channel;
  try { channel = store.readChannel(name); }
  catch (error) { throw new CommandError(error.message); }
  if (!channel) throw new CommandError(`channel does not exist: ${name}`);
  return channel;
}

function assertSeparateStateRoot(source, stateHome) {
  if (path.resolve(source) === path.resolve(stateHome)) {
    throw new CommandError(`state home cannot also be the captured workspace: ${stateHome}`);
  }
}

export function resolveStateHome(cwd, env, explicit) {
  if (explicit) return resolvePath(cwd, explicit);
  if (env?.BANTAM_HOME) return path.join(resolvePath(cwd, env.BANTAM_HOME), "state");
  return path.join(path.resolve(cwd), ".bantam", "state");
}

function resolvePath(cwd, value) {
  return path.resolve(cwd, String(value));
}

function requireDirectory(value, label) {
  let stat;
  try { stat = fs.statSync(value); }
  catch { throw new CommandError(`${label} directory does not exist: ${value}`); }
  if (!stat.isDirectory()) throw new CommandError(`${label} is not a directory: ${value}`);
  return value;
}

function formatText(result) {
  if (result.command === "state.init") {
    const action = result.initialized ? "initialized" : "already initialized";
    return `state ${action}: regular=${result.regular.versionRef} dev=${result.dev.versionRef}\n`;
  }
  if (result.command === "channel.list") {
    return result.channels.length
      ? result.channels.map((item) => `${item.name}\t${item.versionRef}`).join("\n") + "\n"
      : "no channels\n";
  }
  if (result.command === "channel.show" || result.command === "channel.checkpoint") {
    return `${result.channel.name}\t${result.channel.versionRef}\n`;
  }
  if (result.command === "channel.promote") {
    return `${result.to}\t${result.versionRef}\tfrom=${result.from}\n`;
  }
  if (result.command === "channel.rollback") {
    return `${result.channel.name}\t${result.versionRef}\trollback-from=${result.previousVersionRef}\n`;
  }
  if (result.command === "channel.history") {
    return result.events.map((event) => (
      `${event.type}\t${event.versionRef}\tfrom=${event.previousVersionRef ?? "null"}`
    )).join("\n") + "\n";
  }
  if (result.command === "channel.materialize") {
    return `${result.channel}\t${result.versionRef}\t${result.destination}\n`;
  }
  if (result.command === "lane.list") {
    return result.lanes.length
      ? result.lanes.map((item) => `${item.laneId}\t${item.eventId}\t${item.channel}`).join("\n") + "\n"
      : "no lanes\n";
  }
  if (result.command === "lane.status") {
    return `${result.lane.laneId}\t${result.lane.eventId}\t${result.lane.channel}\n`;
  }
  if (result.command === "lane.materialize") {
    return `${result.laneId}\t${result.eventId}\t${result.destination}\n`;
  }
  return `${result.lane.laneId}\t${result.lane.eventId}\t${result.lane.workspacePath}\n`;
}

function writeOutput(target, value) {
  if (typeof target === "function") target(value);
  else if (target && typeof target.write === "function") target.write(value);
  else throw new Error("output collector must be a function or expose write(value)");
}

function usage(message) {
  return new CommandError(message);
}

class CommandError extends Error {}
