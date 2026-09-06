#!/usr/bin/env node
// Native peer CLIs in a fresh outer container; never load operator credentials.
// Native configuration references (checked 2026-09-06):
// https://opencode.ai/docs/cli/ and https://opencode.ai/docs/providers/
// https://hermes-agent.nousresearch.com/docs/user-guide/configuration/
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process-runner.js";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), "..");
const IMAGE = "ubuntu:24.04";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const HERMES_CODE_DIRS = ["hermes_cli", "agent", "tools", "providers", "gateway", "cron", "plugins", "skills", "optional-skills", "assets", "locales", "hermes_agent.egg-info", "acp_adapter"];

export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("endpoint must be a local HTTP URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error("endpoint must be a loopback HTTP URL without credentials/query/fragment");
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith('/v1') ? basePath : `${basePath}/v1`;
  return url.toString().replace(/\/$/, "");
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f,:]/.test(value)) throw new Error(`${label} must be an absolute path without mount separators`);
  return path.resolve(value);
}

function canonicalFuturePath(value) {
  const suffix = [];
  let current = value;
  while (!fs.existsSync(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('output has an unresolved symlink ancestor');
    suffix.unshift(path.basename(current)); current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function validateOptions(options) {
  if (!['hermes', 'opencode'].includes(options.arm)) throw new Error('arm must be hermes or opencode');
  if (typeof options.model !== 'string' || !options.model.trim() || /[\x00-\x1f]/.test(options.model)) throw new Error('model is required and cannot contain control characters');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 1800) throw new Error('timeout must be 1..1800 seconds');
  outputBudget(options.maxOutputTokens);
  for (const name of ['workspace', 'taskFile', 'output']) absolute(options[name], name);
  if (['/', os.homedir(), REPO].includes(path.resolve(options.workspace))) throw new Error('workspace must be a disposable candidate directory');
  normalizeEndpoint(options.endpoint);
}

function outputBudget(value = 8192) {
  if (!Number.isInteger(value) || value < 1 || value > 32768) throw new Error('max output tokens must be 1..32768');
  return value;
}

export function parseOptions(argv) {
  const values = {};
  const names = new Set(["arm", "workspace", "task-file", "output", "endpoint", "model", "timeout-seconds", "max-output-tokens"]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--probe") { values.probe = true; continue; }
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !names.has(key) || Object.hasOwn(values, key) || typeof argv[i + 1] !== "string") throw new Error(`invalid or duplicate option: ${argv[i]}`);
    values[key] = argv[++i];
  }
  if (!["hermes", "opencode"].includes(values.arm)) throw new Error("arm must be hermes or opencode");
  for (const key of ["workspace", "task-file", "output"]) values[key] = absolute(values[key], key);
  if (!values.model || /[\x00-\x1f]/.test(values.model)) throw new Error("model is required and cannot contain control characters");
  const timeoutSeconds = values["timeout-seconds"] === undefined ? 600 : Number(values["timeout-seconds"]);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) throw new Error("timeout must be 1..1800 seconds");
  const maxOutputTokens = outputBudget(values['max-output-tokens'] === undefined ? 8192 : Number(values['max-output-tokens']));
  return { arm: values.arm, workspace: values.workspace, taskFile: values["task-file"], output: values.output, endpoint: normalizeEndpoint(values.endpoint), model: values.model, timeoutSeconds, maxOutputTokens, probe: values.probe === true };
}

export function nativeConfig({ arm, endpoint, model, maxOutputTokens = 8192 }) {
  const baseURL = normalizeEndpoint(endpoint);
  const output = outputBudget(maxOutputTokens);
  if (arm === "opencode") return {
    $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled",
    model: `local/${model}`, small_model: `local/${model}`, enabled_providers: ["local"],
    plugin: [], mcp: {}, permission: "allow",
    provider: { local: { npm: "@ai-sdk/openai-compatible", name: "BANTAM isolated local endpoint",
      options: { baseURL, apiKey: "local-no-credential" },
      models: { [model]: { name: model, limit: { context: 65536, output } } } } },
  };
  if (arm !== "hermes") throw new Error("unknown native arm");
  const auxiliary = Object.fromEntries(["compression", "vision", "approval", "web_extract", "session_search", "skills_hub", "mcp", "title_generation"]
    .map(name => [name, { provider: "main", model, base_url: baseURL, api_key: "local-no-credential", ...(name === "title_generation" ? { enabled: false } : {}) }]));
  return {
    model: { provider: "custom", default: model, base_url: baseURL, api_key: "local-no-credential", context_length: 65536, max_tokens: output },
    fallback_providers: [], auxiliary,
    terminal: { backend: "local", cwd: "/workspace" },
    delegation: { model, base_url: baseURL, api_key: "local-no-credential" },
    memory: { memory_enabled: false, user_profile_enabled: false },
  };
}

export function discoverRuntime(arm) {
  const executable = fs.realpathSync(execFileSync("which", [arm], { encoding: "utf8" }).trim());
  const runtime = { arm, executable, tools: ["/usr/bin/node", "/usr/bin/git"], npm: "/usr/lib/node_modules/npm", libraries: [], mounts: [] };
  if (arm === "opencode") {
    const packageFile = path.resolve(executable, "..", "..", "package.json");
    runtime.version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
    runtime.mounts.push({ source: executable, target: "/opt/opencode" });
    runtime.entry = ["/opt/opencode"];
  } else if (arm === "hermes") {
    const python = fs.readFileSync(executable, "utf8").split("\n", 1)[0].replace(/^#!/, "");
    if (!path.isAbsolute(python) || python.includes(" ")) throw new Error("Hermes requires an absolute Python interpreter shebang");
    const info = JSON.parse(execFileSync(python, ["-c", "import importlib.util,json,sys; s=importlib.util.find_spec('hermes_cli'); print(json.dumps({'root':str(s.submodule_search_locations[0]),'prefix':sys.prefix,'version':f'{sys.version_info.major}.{sys.version_info.minor}'}))"], { encoding: "utf8", timeout: 10000 }));
    const codeRoot = path.dirname(info.root);
    const versionText = fs.readFileSync(path.join(info.root, "__init__.py"), "utf8");
    runtime.version = `${versionText.match(/__version__\s*=\s*"([^"]+)"/)?.[1] ?? "unknown"} (${versionText.match(/__release_date__\s*=\s*"([^"]+)"/)?.[1] ?? "unknown"})`;
    runtime.pythonVersion = info.version;
    runtime.mounts.push({ source: fs.realpathSync(python), target: "/opt/python/bin/python" }, { source: path.join(info.prefix, "lib"), target: "/opt/python/lib" });
    // Code/data assets only: never bind the installed checkout root, .env,
    // logs, project siblings, or the operator's Hermes home into the container.
    for (const entry of fs.readdirSync(codeRoot, { withFileTypes: true })) {
      if ((entry.isFile() && (entry.name.endsWith(".py") || entry.name === "pyproject.toml")) || (entry.isDirectory() && HERMES_CODE_DIRS.includes(entry.name))) runtime.mounts.push({ source: path.join(codeRoot, entry.name), target: `/opt/hermes/${entry.name}` });
    }
    // Append, do not prepend, third-party packages: this installation also has
    // an obsolete enum backport which must not shadow Python's stdlib enum.
    runtime.entry = ["/opt/python/bin/python", "-S", "-c", `import sys,runpy; sys.path.append('/opt/python/lib/python${info.version}/site-packages'); runpy.run_module('hermes_cli.main',run_name='__main__')`];
  } else throw new Error("unknown native arm");
  const libraries = new Set();
  for (const file of [...runtime.tools, runtime.executable]) {
    if (arm === "hermes" && file === runtime.executable) continue;
    for (const match of execFileSync("ldd", [file], { encoding: "utf8" }).matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)) libraries.add(match[1]);
  }
  runtime.libraries = [...libraries];
  runtime.executableDigest = sha(fs.readFileSync(executable));
  return runtime;
}

export function buildDockerArgs({ options, runtime, control, state, cidfile, name }) {
  validateOptions(options);
  if (runtime.arm !== options.arm) throw new Error('runtime arm mismatch');
  if (!/^bantam-peer-[a-z0-9-]+$/.test(name)) throw new Error("invalid peer container name");
  const mount = (source, target, readonly = true) => ["--mount", `type=bind,src=${absolute(source, "mount source")},dst=${absolute(target, "mount target")}${readonly ? ",readonly" : ""}`];
  const env = {
    PATH: "/tmp/peer-bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", TERM: "dumb",
    XDG_CONFIG_HOME: "/state/config", XDG_DATA_HOME: "/state/data", XDG_CACHE_HOME: "/state/cache", XDG_STATE_HOME: "/state/state",
    OPENCODE_CONFIG: "/control/native-config.json", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_AUTO_SHARE: "false", OPENCODE_DISABLE_TERMINAL_TITLE: "1",
    // OpenCode 1.18.23 otherwise applies its separate 32,000-token ceiling.
    ...(runtime.arm === 'opencode' ? { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(outputBudget(options.maxOutputTokens)) } : {}),
    HERMES_HOME: "/state/hermes",
    HERMES_CONTAINER: "1", HERMES_SKIP_NODE_BOOTSTRAP: "1", HERMES_YOLO_MODE: "1", TERMINAL_ENV: "local", TERMINAL_CWD: "/workspace",
    HERMES_WRITE_SAFE_ROOT: "/workspace", HERMES_INFERENCE_MODEL: options.model,
    OPENAI_BASE_URL: options.endpoint, OPENAI_API_KEY: "local-no-credential",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8",
    ...(runtime.arm === "hermes" ? { PYTHONHOME: "/opt/python", PYTHONPATH: "/opt/hermes" } : {}),
  };
  return ["run", "--rm", "--pull", "never", "--init", "--name", name, "--cidfile", absolute(cidfile, "cidfile"),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--pids-limit", "384", "--memory", "4g", "--cpus", "2",
    "--network", options.probe ? "none" : "host",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=768m,mode=1777", "--tmpfs", "/home/ubuntu:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700",
    ...mount(options.workspace, "/workspace", false), ...mount(state, "/state", false), ...mount(control, "/control"),
    ...(options.arm === 'hermes' ? [...mount(path.join(control, 'native-config.json'), '/state/hermes/config.yaml'), ...mount(path.join(control, 'empty.env'), '/state/hermes/.env')] : []),
    ...mount(SELF, "/opt/peer/scripts/peer-fight-cli.mjs"), ...mount(path.join(REPO, "src/process-runner.js"), "/opt/peer/src/process-runner.js"),
    ...mount(path.join(REPO, "package.json"), "/opt/peer/package.json"),
    ...runtime.mounts.flatMap(row => mount(row.source, row.target)),
    ...runtime.tools.flatMap(file => mount(file, file)), ...runtime.libraries.flatMap(file => mount(fs.realpathSync(file), file)),
    ...mount("/usr/lib/git-core", "/usr/lib/git-core"), ...mount("/usr/share/git-core", "/usr/share/git-core"), ...mount(runtime.npm, "/opt/npm"),
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--workdir", "/workspace", IMAGE,
    "/usr/bin/node", "/opt/peer/scripts/peer-fight-cli.mjs", "--inside"];
}

export async function runPeer(options, { runtime = discoverRuntime(options.arm), processRunner = runProcess, signal = null } = {}) {
  validateOptions(options);
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw new Error("tested peer runtime requires Linux x64 and uid/gid 1000");
  const workspace = fs.realpathSync(absolute(options.workspace, "workspace"));
  const output = canonicalFuturePath(absolute(options.output, "output"));
  if (["/", os.homedir(), REPO].includes(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error("workspace must be a disposable candidate directory");
  if (inside(workspace, output) || inside(output, workspace) || fs.existsSync(output)) throw new Error("output must be a fresh directory separate from candidate");
  const taskFile = fs.realpathSync(absolute(options.taskFile, "task file"));
  const task = fs.readFileSync(taskFile, "utf8");
  if (!task.trim() || Buffer.byteLength(task) > 128 * 1024) throw new Error("task must be nonempty and at most 128 KiB");
  options = { ...options, workspace, output, endpoint: normalizeEndpoint(options.endpoint), maxOutputTokens: outputBudget(options.maxOutputTokens) };
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const control = path.join(output, "control"), state = path.join(output, "native");
  fs.mkdirSync(control); fs.mkdirSync(state);
  if (options.arm === 'hermes') fs.mkdirSync(path.join(state, 'hermes'));
  const name = `bantam-peer-${options.arm}-${crypto.randomUUID()}`, cidfile = path.join(output, "container.cid");
  writeJson(path.join(control, "native-config.json"), nativeConfig(options));
  writeJson(path.join(control, "invocation.json"), { ...options, entry: runtime.entry });
  fs.writeFileSync(path.join(control, "task.txt"), task, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(control, "empty.env"), "", { flag: "wx", mode: 0o600 });
  const dockerArgs = buildDockerArgs({ options, runtime, control, state, cidfile, name });
  const launch = { schema: "bantam.peer-launch.v1", arm: options.arm, nativeVersion: runtime.version, executableDigest: runtime.executableDigest,
    launcherDigest: sha(fs.readFileSync(SELF)), taskDigest: sha(task), model: options.model, endpoint: options.endpoint,
    contextLimit: 65536, outputLimit: options.maxOutputTokens,
    outputProfile: { maxOutputTokens: options.maxOutputTokens, scope: 'native combined reasoning and action response',
      reservationCaveat: 'Native output limits may also change prompt reservations and compaction thresholds; not a pure output-only context ablation.' },
    timeoutSeconds: options.timeoutSeconds, container: { name, cidfile, image: IMAGE },
    network: options.probe ? "none" : "host: required to reach loopback recording proxy; this is filesystem isolation, not an egress allowlist",
    runtime, args: dockerArgs, startedAt: new Date().toISOString(), probe: options.probe === true };
  writeJson(path.join(output, "launch.json"), launch);
  const started = Date.now();
  let execution, cleanup;
  const cancellation = new AbortController();
  const relay = () => cancellation.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  signals.forEach(name => process.once(name, relay));
  const joinedSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  try {
    execution = await processRunner("docker", dockerArgs, { timeoutMs: (options.timeoutSeconds + 15) * 1000, signal: joinedSignal, maxBuffer: 32 * 1024 * 1024,
      onOutput: ({ stream, text }) => { fs.appendFileSync(path.join(output, `${stream}.log`), text); (stream === "stderr" ? process.stderr : process.stdout).write(text); } });
  } catch (error) {
    execution = { code: null, signal: null, error: String(error.message ?? error) };
  } finally {
    signals.forEach(name => process.off(name, relay));
    let id = null;
    try { const value = fs.readFileSync(cidfile, "utf8").trim(); if (/^[a-f0-9]{64}$/.test(value)) id = value; } catch {}
    const target = id ?? name;
    let removed;
    try { removed = await processRunner("docker", ["rm", "--force", target], { timeoutMs: 10000 }); }
    catch (error) { removed = { code: null, stderr: String(error.message ?? error) }; }
    cleanup = { target, exactCid: id, code: removed.code, stdout: removed.stdout ?? '', stderr: removed.stderr ?? '', absent: removed.code === 0 || /No such container/.test(removed.stderr ?? "") };
    writeJson(path.join(output, "cleanup.json"), cleanup);
  }
  const result = { schema: "bantam.peer-result.v1", arm: options.arm, nativeVersion: runtime.version, launcherDigest: launch.launcherDigest,
    startedAt: launch.startedAt, finishedAt: new Date().toISOString(), wallMs: Date.now() - started, code: execution.code, signal: execution.signal ?? null,
    timedOut: Boolean(execution.timedOut) || execution.code === 124, aborted: Boolean(execution.aborted), bufferExceeded: Boolean(execution.bufferExceeded), error: execution.error ?? null,
    cleanup, nativeDirectory: state, transcript: options.arm === "opencode" ? "stdout.log (native JSON events) and native/data" : "native/hermes (native sessions) and native/usage.json",
    usageAuthority: "native secondary metadata; parent recording proxy is authoritative for full context and usage" };
  writeJson(path.join(output, "result.json"), result);
  if (!cleanup.absent) throw new Error("cannot confirm exact peer container cleanup");
  return result;
}

async function runInside() {
  const config = JSON.parse(fs.readFileSync("/control/invocation.json", "utf8"));
  for (const dir of ["/tmp/peer-bin", "/state/config", "/state/data", "/state/cache", "/state/state", "/state/hermes"]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, target] of [["npm", "/opt/npm/bin/npm-cli.js"], ["npx", "/opt/npm/bin/npx-cli.js"]]) fs.symlinkSync(target, `/tmp/peer-bin/${name}`);
  if (config.arm === 'hermes') for (const name of ['python', 'python3']) fs.symlinkSync('/opt/python/bin/python', `/tmp/peer-bin/${name}`);
  // Inline config is the final OpenCode configuration layer. It cannot inherit
  // a host provider, auth store, project parent configuration or default plugin.
  if (config.arm === "opencode") process.env.OPENCODE_CONFIG_CONTENT = fs.readFileSync("/control/native-config.json", "utf8");
  const [exe, ...prefix] = config.entry;
  const version = execFileSync(exe, [...prefix, "--version"], { encoding: "utf8", timeout: 15000 });
  writeJson("/state/native-version.json", { output: version.trim(), arm: config.arm });
  if (config.probe) {
    const help = execFileSync(exe, [...prefix, ...(config.arm === "opencode" ? ["run"] : []), "--help"], { encoding: "utf8", timeout: 30000 });
    fs.writeFileSync("/state/help.txt", help);
    fs.accessSync('/workspace', fs.constants.W_OK);
    process.stdout.write(JSON.stringify({ arm: config.arm, version: version.trim(), probe: true, hostHomeAbsent: !fs.existsSync("/home/operator"), candidateWritable: true }) + "\n");
    return 0;
  }
  const task = fs.readFileSync("/control/task.txt", "utf8");
  if (config.arm === 'hermes') {
    // Installed Hermes 0.20 resolves providers from HERMES_HOME/config.yaml,
    // not HERMES_CONFIG or OPENAI_BASE_URL. Refuse to start a conversation if
    // its own provider resolver selects anything except this run's proxy.
    const check = "import sys,json; sys.path.append(f'/opt/python/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'); from hermes_cli.runtime_provider import resolve_runtime_provider; from hermes_cli.config import load_config; r=resolve_runtime_provider(requested='custom',target_model=sys.argv[1]); c=load_config(); assert r.get('base_url','').rstrip('/') == sys.argv[2], 'Hermes resolved outside the recording endpoint'; assert c['model']['max_tokens'] == int(sys.argv[3]), 'Hermes output limit mismatch'; print(json.dumps({'provider':r.get('provider'),'base_url':r.get('base_url'),'maxOutputTokens':c['model']['max_tokens']}))";
    const resolved = execFileSync(exe, ['-S', '-c', check, config.model, config.endpoint, String(config.maxOutputTokens)], { encoding: 'utf8', timeout: 15000 });
    writeJson('/state/provider-check.json', JSON.parse(resolved.trim()));
  }
  const args = config.arm === "opencode" ? ["run", "--pure", "--format", "json", "-m", `local/${config.model}`, task]
    : [...prefix, "-z", task, "--yolo", "--no-restore-cwd", "--model", config.model, "--provider", "custom", "--usage-file", "/state/usage.json"];
  const child = spawn("/usr/bin/timeout", ["--signal=TERM", "--kill-after=5s", `${config.timeoutSeconds}s`, exe, ...args], { stdio: "inherit" });
  return await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const work = process.argv[2] === "--inside" ? runInside() : process.argv.includes("--help")
    ? (process.stdout.write("peer-fight-cli --arm hermes|opencode --workspace ABS --task-file ABS --output ABS --endpoint http://127.0.0.1:PORT[/v1] --model ID [--timeout-seconds 600] [--max-output-tokens 8192] [--probe]\n"), Promise.resolve(0))
    : runPeer(parseOptions(process.argv.slice(2))).then(result => result.code ?? 1);
  work.then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`peer-fight-cli: ${error.message}\n`); process.exitCode = 1; });
}
