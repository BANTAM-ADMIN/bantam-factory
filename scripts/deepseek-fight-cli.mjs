#!/usr/bin/env node
// Published DeepSeek Harness, standard headless profile, in a disposable outer
// Docker boundary. Installation/config are arena-local; no host home is mounted.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process-runner.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEEPSEEK_VERSION = "0.1.2-rc.1";
export const DEFAULT_IMAGE = `bantam/deepseek-fight:${DEEPSEEK_VERSION}`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f,:]/.test(value)) {
    throw new Error(`${label} must be an absolute path without mount separators`);
  }
  return path.resolve(value);
}

export function parseArgs(args) {
  const keys = new Map([
    ["--workspace", "workspace"], ["--task-file", "taskFile"], ["--output", "output"],
    ["--endpoint", "endpoint"], ["--model", "model"], ["--timeout-seconds", "timeoutSeconds"],
    ["--max-output-tokens", "maxOutputTokens"],
  ]);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = keys.get(args[index]);
    if (!key || Object.hasOwn(result, key) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`unknown, duplicate, or incomplete argument: ${args[index]}`);
    }
    result[key] = args[++index];
  }
  for (const key of ["workspace", "taskFile", "output", "endpoint", "model"]) {
    if (!result[key]) throw new Error(`missing ${key}`);
  }
  result.timeoutSeconds = Number(result.timeoutSeconds ?? 600);
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 1 || result.timeoutSeconds > 1800) {
    throw new Error("timeout must be 1..1800 seconds");
  }
  result.maxOutputTokens = outputCap(Number(result.maxOutputTokens ?? 8192));
  return result;
}

function outputCap(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 32768) throw new Error("max output tokens must be 1024..32768");
  return value;
}

export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash || url.search) {
    throw new Error("endpoint must be a credential-free loopback HTTP(S) URL");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/v1";
  return url.toString().replace(/\/$/, "");
}

export function buildPatch({ endpoint, model, maxOutputTokens = 8192 }) {
  if (typeof model !== "string" || model.length < 1 || model.length > 2048 || /[\x00-\x1f]/.test(model)) {
    throw new Error("model must be a nonempty literal identifier without control characters");
  }
  outputCap(maxOutputTokens);
  // JSON is valid YAML: quoting cannot turn a model identifier into a !!js tag.
  return `${JSON.stringify([
    { id: "agent-default-model", config: { provider: "local-fight", model } },
    { id: "llm-deepseek", disabled: true },
    { id: "llm-pi-ai", config: { providers: { "local-fight": {
      apiKeyEnv: "BANTAM_LOCAL_PLACEHOLDER_KEY", api: "openai-completions",
      baseURL: normalizeEndpoint(endpoint),
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsUsageInStreaming: true },
      models: [{ id: model, contextWindow: 65536, maxTokens: maxOutputTokens }],
    } } } },
    { id: "session-persistence-jsonl", config: { root: "/dsh/sessions", compression: "none", packChunks: false } },
  ], null, 2)}\n`;
}

export function buildDockerArgs({ workspace, home, patchFile, cidfile, name, image, task, timeoutSeconds = 600 }) {
  const root = absolute(workspace, "workspace");
  if (["/", os.homedir(), REPO].includes(root) || inside(root, REPO)) {
    throw new Error("use a disposable candidate, not a home, repository root, or their ancestor");
  }
  if (!/^deepseek-fight-[a-z0-9-]+$/.test(name)) throw new Error("invalid owned container name");
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error("runtime image must be an inspected immutable Docker image ID");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) throw new Error("invalid timeout");
  if (typeof task !== "string" || !task.trim() || Buffer.byteLength(task) > 128 * 1024 || task.includes("\0")) {
    throw new Error("task must be nonempty UTF-8 text, at most 128 KiB, without NUL");
  }
  const state = absolute(home, "native home");
  if (inside(root, state) || inside(state, root)) throw new Error("native home must be outside the candidate");
  const mount = (source, target, readonly = false) => ["--mount",
    `type=bind,src=${absolute(source, "mount source")},dst=${target}${readonly ? ",readonly" : ""}`];
  return [
    "run", "--rm", "--pull", "never", "--init", "--name", name, "--cidfile", absolute(cidfile, "CID receipt"),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--user", "1000:1000",
    // The local inference/recording proxy listens on loopback. This is NOT an
    // egress sandbox: host network services and outbound network remain reachable.
    "--network", "host",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs", "/home/node:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700",
    ...mount(root, "/workspace"), ...mount(state, "/dsh"), ...mount(patchFile, "/run/fight.patch.yml", true),
    "--env", "HOME=/home/node", "--env", "DSH_HOME=/dsh",
    "--env", "DSH_PERMISSION_MODE=danger-full-access", "--env", "DSH_TELEMETRY_DISABLED=1",
    "--env", "DSH_TELEMETRY_MODE=DISABLED", "--env", "BANTAM_LOCAL_PLACEHOLDER_KEY=local-no-secret",
    "--env", "NO_COLOR=1", "--env", "LANG=C.UTF-8", "--env", "GIT_CONFIG_NOSYSTEM=1",
    "--workdir", "/workspace", image,
    "/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`,
    "/usr/local/bin/node", "/opt/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "--profile", "headless", "--patch", "/run/fight.patch.yml", "--", task,
  ];
}

/** Only settled assistant/message counters are summed, never their duplicated
 * streaming usage events. Seeded child logs exclude their inherited prefix.
 * Auxiliary provider calls may be absent here; the parent wire recorder owns
 * whole-run totals, including retries/title generation/compaction. */
export function summarizeSessionTexts(texts) {
  const totals = { inputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const sessions = [];
  const errors = [];
  let assistantMessages = 0;
  let messagesWithUsage = 0;
  let toolCalls = 0;
  const seen = new Set();
  for (const { file, text } of texts) {
    try {
      const records = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const header = records.shift();
      if (header?.type !== "session" || header.version !== 0 || typeof header.id !== "string") throw new Error("unsupported session header");
      if (seen.has(header.id)) throw new Error("duplicate session ID");
      const cut = header.seedLength ?? 0;
      if (!Number.isSafeInteger(cut) || cut < 0) throw new Error("invalid inherited prefix length");
      const own = records.filter((record) => Number.isSafeInteger(record.seq) && record.seq >= cut);
      const messages = own.filter((record) => record.type === "assistant/message");
      const local = { ...totals };
      for (const key of Object.keys(local)) local[key] = 0;
      let usageCount = 0;
      for (const record of messages) {
        const usage = record.data?.usage;
        if (!usage) continue;
        const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
        for (const key of fields) {
          const value = usage[key] ?? (key.startsWith("cache") ? 0 : undefined);
          if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key}`);
        }
        // Fresh input includes cache creation: only cache reads are reuse.
        local.freshInputTokens += usage.inputTokens + (usage.cacheWriteTokens ?? 0);
        local.cachedInputTokens += usage.cacheReadTokens ?? 0;
        local.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        local.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        local.outputTokens += usage.outputTokens;
        usageCount++;
      }
      for (const key of Object.keys(totals)) totals[key] += local[key];
      messagesWithUsage += usageCount;
      assistantMessages += messages.length;
      toolCalls += own.filter((record) => record.type === "tool/call").length;
      seen.add(header.id);
      sessions.push({ file, id: header.id, parentSession: header.parentSession ?? null, inheritedEvents: cut,
        assistantMessages: messages.length, messagesWithUsage: usageCount,
        turnEndReasons: own.filter((record) => record.type === "turn/end").map((record) => record.data?.reason?.kind ?? record.data?.reason ?? null) });
    } catch (error) { errors.push({ file, error: error.message }); }
  }
  return { ...totals, assistantMessages, messagesWithUsage, toolCalls, sessions, errors,
    usageSource: "native settled assistant/message only; whole-run wire accounting may include additional calls",
    usageAvailable: messagesWithUsage > 0 && errors.length === 0,
  };
}

export function readNativeSessions(root) {
  const texts = [];
  const skipped = [];
  let bytes = 0;
  const walk = (directory, depth = 0) => {
    if (depth > 6) { skipped.push("session directory depth limit"); return; }
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink()) { skipped.push("symlink session directory"); return; }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skipped.push(path.relative(root, file)); continue; }
      if (entry.isDirectory()) { walk(file, depth + 1); continue; }
      if (entry.name !== "session.jsonl" || !entry.isFile()) continue;
      const size = fs.statSync(file).size;
      if ((bytes += size) > 128 * 1024 * 1024) { skipped.push("session byte limit"); continue; }
      texts.push({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") });
    }
  };
  try { walk(root); }
  catch (error) { skipped.push(`session collection failed: ${error.message}`); }
  return { ...summarizeSessionTexts(texts), skipped,
    artifacts: texts.map(({ file, text }) => ({ file, bytes: Buffer.byteLength(text), sha256: sha256(text) })) };
}

export function inspectRuntime(imageReference = process.env.BANTAM_DEEPSEEK_IMAGE || DEFAULT_IMAGE) {
  const inspection = JSON.parse(execFileSync("docker", ["image", "inspect", imageReference], { encoding: "utf8", timeout: 15000 }))[0];
  if (!/^sha256:[0-9a-f]{64}$/.test(inspection?.Id)) throw new Error("cannot pin installed Docker image");
  const version = execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", inspection.Id,
    "node", "-e", 'const fs=require("node:fs"); console.log(JSON.stringify({version:JSON.parse(fs.readFileSync("/opt/deepseek/node_modules/@deepseek-ai/dsh/package.json")).version,node:process.version,lock:require("node:crypto").createHash("sha256").update(fs.readFileSync("/opt/deepseek/package-lock.json")).digest("hex")}))'],
  { encoding: "utf8", timeout: 15000 });
  const metadata = JSON.parse(version);
  if (metadata.version !== DEEPSEEK_VERSION) throw new Error(`expected DeepSeek ${DEEPSEEK_VERSION}; found ${metadata.version}`);
  return { imageReference, image: inspection.Id, repoDigests: inspection.RepoDigests ?? [], ...metadata };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
    throw new Error("qualified runtime requires Linux x64, uid/gid 1000");
  }
  const workspace = fs.realpathSync(absolute(options.workspace, "workspace"));
  if (!fs.statSync(workspace).isDirectory()) throw new Error("workspace must be a directory");
  const taskFile = absolute(options.taskFile, "task file");
  if (!fs.lstatSync(taskFile).isFile()) throw new Error("task file must be a regular nonsymlink file");
  if (fs.statSync(taskFile).size > 128 * 1024) throw new Error("task file exceeds 128 KiB");
  const task = fs.readFileSync(taskFile, "utf8");
  const requestedOutput = absolute(options.output, "output");
  const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
  if (inside(workspace, output) || inside(output, workspace)) throw new Error("output must be outside the candidate");
  if (fs.existsSync(output)) throw new Error("output must be a new directory; refusing to overwrite an attempt");
  const endpoint = normalizeEndpoint(options.endpoint);
  const patch = buildPatch({ endpoint, model: options.model, maxOutputTokens: options.maxOutputTokens });
  const runtime = inspectRuntime();
  const name = `deepseek-fight-${process.pid}-${crypto.randomUUID()}`;
  const home = path.join(output, "native-home");
  const patchFile = path.join(output, "fight.patch.yml");
  const cidfile = path.join(output, "container.cid");
  const dockerArgs = buildDockerArgs({ workspace, home, patchFile, cidfile, name,
    image: runtime.image, task, timeoutSeconds: options.timeoutSeconds });
  fs.mkdirSync(output, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(patchFile, patch, { flag: "wx", mode: 0o444 });
  const write = (file, value) => fs.writeFileSync(path.join(output, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  const launch = { schema: "bantam.deepseek-fight-launch.v1", runtime, profile: "headless", toolsMode: "native standard default",
    workspace, containerWorkspace: "/workspace", endpoint, model: options.model,
    contextWindow: 65536, maxTokens: options.maxOutputTokens, requestedMaxOutputTokens: options.maxOutputTokens,
    timeoutSeconds: options.timeoutSeconds,
    taskSha256: sha256(task), patchSha256: sha256(patch), dockerArgs, name, cidfile,
    isolation: "outer Docker; only candidate/native-home writable; no host home, auth, grader, or repository mounts",
    network: "host network for loopback model proxy; NOT an egress isolation boundary",
    nativeEvidence: "native home is worker-visible and writable; external recorder/independent grader remain authoritative",
  };
  write("launch.json", launch);
  const abort = new AbortController();
  const signalHandlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => abort.abort()]));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  const cleanup = () => {
    const saved = fs.existsSync(cidfile) ? fs.readFileSync(cidfile, "utf8").trim() : "";
    const target = /^[0-9a-f]{64}$/.test(saved) ? saved : name;
    try { execFileSync("docker", ["rm", "--force", target], { stdio: "ignore", timeout: 10000 }); }
    catch { /* This exact --rm container may already have exited. */ }
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let result;
  try {
    result = await runProcess("docker", dockerArgs, { timeoutMs: (options.timeoutSeconds + 15) * 1000,
      maxBuffer: 32 * 1024 * 1024, signal: abort.signal });
  } finally {
    cleanup();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
  write("stdout.log", result.stdout);
  write("stderr.log", result.stderr);
  const summary = { schema: "bantam.deepseek-fight-result.v1", startedAt, endedAt: new Date().toISOString(),
    wallMs: Math.round(performance.now() - started),
    process: { code: result.code, signal: result.signal, timedOut: result.timedOut || result.code === 124,
      aborted: result.aborted, bufferExceeded: result.bufferExceeded, error: result.error?.message ?? null },
    native: readNativeSessions(path.join(home, "sessions")),
    acceptance: "not graded by this adapter",
  };
  write("result.json", summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return result.code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`deepseek-fight-cli: ${error.message}\n`); process.exitCode = 1;
  });
}
