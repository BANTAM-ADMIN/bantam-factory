// Fail-fast classification for package-manager commands in Bantam's default
// Docker sandbox. The sandbox deliberately has no network, so starting a
// registry-backed install there only creates a long, opaque timeout.

import fs from "node:fs";
import path from "node:path";
import { shellSegments, splitShellWords } from "./shell-lex.js";

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const GLOBAL_VALUE_OPTIONS = new Set([
  "--cache", "--config", "--config-file", "--cwd", "--directory", "--global-folder",
  "--prefix", "--project", "--python", "--root", "--store-dir", "--userconfig",
  "--workspace", "-C", "-c",
]);

const MANAGER_DESTINATIONS = Object.freeze({
  npm: "node_modules",
  yarn: "node_modules",
  pnpm: "node_modules",
  pip: ".venv",
  uv: ".venv",
  conda: "a project-local environment",
  apt: "the container image's system package database",
  apk: "the container image's system package database",
  cargo: "Cargo's configured install/cache directories",
  go: "the Go module cache or GOBIN",
  gem: "RubyGems' configured install/cache directories",
});

// Managers that write into the CONTAINER IMAGE's filesystem. The sandbox is
// `docker run --rm --read-only` and the host /usr is bind-mounted over the
// image's, so these can neither persist nor become visible: the tool has to
// come from the host instead.
const SYSTEM_PACKAGE_MANAGERS = new Set(["apt", "apk"]);
// Managers whose default action lands in the workspace (node_modules) or in the
// persistent sandbox HOME (/tmp), so an operator-approved install survives later
// commands. A `-g`/`--global` install targets the read-only mounted interpreter
// instead, so it is classified separately.
const GLOBAL_INSTALL_MANAGERS = new Set(["npm", "yarn", "pnpm"]);
const GLOBAL_INSTALL_FLAGS = new Set(["-g", "--global", "--location=global"]);

const SYSTEM_SCRIPT_EXECUTABLES = new Set([
  "bash", "bun", "cargo", "cd", "cmake", "cp", "deno", "echo", "false", "go", "make",
  "mkdir", "mv", "node", "perl", "printf", "pwd", "python", "python3", "rm", "ruby", "sh",
  "test", "true",
]);

const NODE_BINARY_PACKAGES = Object.freeze({
  ng: "@angular/cli",
  tsc: "typescript",
  "tsserver": "typescript",
});

/**
 * Prevent npm scripts (or direct commands) from falling through to an unrelated host-global binary
 * when package.json declares a project-local tool but node_modules/.bin does not contain it. This is
 * the exact path that let a missing JavaScript Vite resolve to Miniconda's unrelated Python `vite`.
 */
export function classifyMissingLocalNodeTool(command, workspace) {
  const manifest = readNodeManifest(workspace);
  if (!manifest) return null;
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]);
  if (!declared.size) return null;

  const source = String(command ?? "");
  for (const rawSegment of shellSegments(source)) {
    const words = unwrapCommand(splitShellWords(rawSegment)).words;
    if (!words.length) continue;
    const outer = executableName(words[0]);
    const candidates = outer === "npm"
      ? npmScriptExecutables(words.slice(1), manifest.scripts || {})
      : [outer];
    for (const executable of candidates) {
      if (!executable || SYSTEM_SCRIPT_EXECUTABLES.has(executable)) continue;
      const packageName = NODE_BINARY_PACKAGES[executable] || executable;
      if (!declared.has(packageName)) continue;
      if (hasLocalNodeBinary(workspace, executable)) continue;
      const operation = outer === "npm" ? npmScriptOperation(words.slice(1)) : "execute";
      const classification = {
        kind: "missing-local-node-tool",
        blocked: true,
        networkRequired: true,
        ecosystem: "npm",
        operation,
        executable,
        packageName,
        command: source,
        segment: rawSegment.trim(),
        destination: "node_modules",
        reason: "project-local-binary-missing",
      };
      classification.message = [
        `[dependency-preflight] Blocked ${operation}: no command was run.`,
        `package.json declares ${packageName}, but the project-local executable node_modules/.bin/${executable} is missing.`,
        `Running it now could select an unrelated host-global '${executable}' from the inherited PATH.`,
        "Install the target project's dependencies from a trusted terminal, or restart Bantam with --shell-network and ask it to install dependencies before retrying the script.",
      ].join("\n");
      return classification;
    }
  }
  return null;
}

/**
 * Identify a package install/fetch that cannot use the network in the default
 * Docker sandbox. Returns null for unrelated commands and for commands that
 * explicitly require offline/local-only resolution.
 *
 * The result is deliberately data-first so the executor and UI can make their
 * own policy decision without parsing prose.
 */
export function classifyOfflineInstall(command) {
  const source = String(command ?? "");
  for (const rawSegment of shellSegments(source)) {
    const tokens = splitShellWords(rawSegment);
    if (!tokens.length) continue;

    const unwrapped = unwrapCommand(tokens);
    const match = classifyWords(unwrapped.words, unwrapped.assignments);
    if (!match || match.offline) continue;

    const scope = installScope(match.ecosystem, unwrapped.words);
    const classification = {
      kind: "offline-package-install",
      blocked: true,
      networkRequired: true,
      ecosystem: match.ecosystem,
      operation: match.operation,
      executable: match.executable,
      command: source,
      segment: rawSegment.trim(),
      destination: MANAGER_DESTINATIONS[match.ecosystem],
      // Where the install would land, and whether it can survive the command.
      // The sandbox runs `docker run --rm --read-only`, so only workspace/HOME
      // writes persist; this is what the operator prompt and guidance key off.
      scope,
      persistent: scope === "project",
      reason: "default-docker-no-network",
    };
    return { ...classification, message: formatOfflineInstallMessage(classification) };
  }
  return null;
}

/**
 * Detect a shell command that fetches from the INTERNET (an external host), so a
 * benchmark run with network disabled cannot download reference implementations,
 * datasets, or the answer. Integrity line (operator, 2026-08-20): the model must
 * solve from the inputs the task PROVIDED, not from a reference it fetched — a
 * gpt2-codegolf run found open internet and downloaded the official GPT-2
 * encoder/vocab, which invalidates the result. This works in host-sandbox mode,
 * where the docker `--network none` isolation is not applied.
 *
 * Local/loopback and private-range hosts are allowed (a task may legitimately
 * curl a local service); only a public host/domain is blocked.
 */
const _FETCH_TOOL = /(?:^|[\s;&|(])(curl|wget|aria2c|lynx|links|scp|sftp|rsync|git\s+clone|pip\s+download)\b/i;
const _PY_NET = /urllib\.request|\burlopen\s*\(|\brequests\.(?:get|post|head|put)\b|\bhttpx\b|\bhttp\.client\b|socket\.create_connection/;
const _NODE_NET = /\bnode-fetch\b|\baxios\b|https?:\/\/[^\s'"`]+["'`]?\s*\)?\s*(?:,|\.then|await)/;
// http(s):// URL whose host is NOT loopback/private (i.e. a public internet host).
const _PUBLIC_URL = /\bhttps?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)[A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]/i;

export function classifyNetworkFetch(command) {
  const source = String(command ?? "");
  const hasPublicUrl = _PUBLIC_URL.test(source);
  const usesFetchTool = _FETCH_TOOL.test(source);
  const usesPyNet = _PY_NET.test(source);
  const hit =
    (usesFetchTool && (hasPublicUrl || /\bgit\s+clone\b|\bpip\s+download\b/i.test(source)))
    || (usesPyNet && (hasPublicUrl || /urlopen|requests\./.test(source)))
    || (_NODE_NET.test(source) && hasPublicUrl);
  if (!hit) return null;
  return {
    kind: "network-blocked",
    blocked: true,
    command: source,
    message:
      "[network-blocked] Network is disabled for this task. Do NOT download reference "
      + "implementations, datasets, tokenizers, or model files from the internet — solve using ONLY "
      + "the inputs the task PROVIDED in the workspace. Fetching a reference (e.g. the official GPT-2 "
      + "encoder/vocab or a reference model) makes the result invalid. Derive everything you need from "
      + "the local provided files, and verify with a script you write yourself.",
  };
}

/**
 * A run CRASHED (segfault / abort / bus error). Advise rebuilding with a
 * sanitizer, which names the exact file:line and cause in one run — instead of
 * hunting it by hand with print statements. Process jig, not an answer (TB2
 * gpt2-codegolf, 2026-08-20: the model debugged a segfault by adding `fprintf`
 * traces; AddressSanitizer would have pinpointed the null global deref
 * immediately). Fires only on a crash of a locally-run binary that was not
 * already built with a sanitizer.
 */
export function classifyCrashSanitizer(command, exitCode, output) {
  const cmd = String(command ?? "");
  const text = String(output ?? "");
  const crashed =
    [132, 134, 135, 136, 139].includes(Number(exitCode))
    || /Segmentation fault|core dumped|\bSIGSEGV\b|\bSIGABRT\b|bus error|stack smashing detected|double free|munmap_chunk|free\(\): invalid/i.test(text);
  if (!crashed) return null;
  // The crash must come from RUNNING a compiled binary (./x), not a tool that
  // merely printed one of these words.
  if (!/(?:^|[\s;&|`(])\.\/\S+/.test(cmd)) return null;
  if (/-fsanitize/.test(cmd) || /AddressSanitizer|LeakSanitizer|runtime error:/i.test(text)) return null;
  // A binary that crashes while READING the agent's output is most likely
  // choking on that output, not on its own code. write-compressor (2026-08-22):
  // the PROVIDED decoder segfaulted on the agent's malformed data.comp, and
  // this steer fired 17 times telling a Python-writing agent to rebuild
  // "SOURCE.c" with -fsanitize. It never ran gcc (correctly), but 17 x 300
  // chars of advice for the wrong program is pure tail noise, and it hid the
  // true reading: the stream is malformed. Detect the shape -- a file piped
  // or redirected INTO the crashing ./binary -- and say that instead.
  const fedInput = /\|\s*(?:\S+\s+)*?\.\/\S+|\.\/\S+[^|;&]*?<\s*\S+/.test(cmd);
  if (fedInput) {
    const m = /\.\/([^\s;|&<>)]+)/.exec(cmd);   // stop at shell punctuation: "./decomp;" is not a name
    const bin = m ? m[1] : "the program";
    return {
      kind: "crash-malformed-input",
      message:
        `[crash] ./${bin} crashed while reading the input you piped into it. When a program that is`
        + " GIVEN to you crashes on YOUR output, the first suspect is the output, not the program:"
        + " your stream is malformed in a way its reader does not guard against (a length, offset, or"
        + " terminator it trusts). Do not rebuild or sanitize the given program. Instead, shrink the"
        + " input until it stops crashing -- a one-token or one-literal case -- then grow it and find"
        + " the first byte sequence that breaks it; that is the encoder bug.",
    };
  }
  return {
    kind: "crash-sanitizer",
    message:
      "[sanitizer] Your program CRASHED (segfault/abort). Do NOT hunt it by adding print statements — "
      + "rebuild with a sanitizer and it names the exact file:line and cause in ONE run: "
      + "`gcc -g -fsanitize=address,undefined SOURCE.c -o dbg -lm && ./dbg ARGS`. It pinpoints null "
      + "derefs, out-of-bounds, use-after-free, uninitialized reads, and integer overflow directly. "
      + "Fix exactly what it reports, then drop -fsanitize for the final build.",
  };
}

/**
 * Strip the ASAN/UBSAN SHADOW-MEMORY hex dump from sanitizer output, keeping the
 * actionable part (the ERROR line, the `#0..#N file:line` stack, and SUMMARY).
 *
 * TB2 gpt2-codegolf (2026-08-20): the model was handed the exact bug on every
 * crash — `heap-buffer-overflow /app/gpt2.c:13 in gemm` — but each observation
 * also carried ~46 lines of `0x51f...: fa fa fa fa ...` shadow bytes plus the
 * legend: pure noise that dilutes the one line that matters and burns prompt
 * budget on every sanitizer run. This drops everything from "Shadow bytes around
 * the buggy address:" onward and leaves a one-line pointer to the real signal.
 */
export function stripSanitizerNoise(output) {
  const text = String(output ?? "");
  const marker = "Shadow bytes around the buggy address:";
  const idx = text.indexOf(marker);
  if (idx < 0) return text; // not ASAN shadow output — leave untouched
  const kept = text.slice(0, idx).replace(/\s+$/, "");
  return (
    kept
    + "\n[sanitizer shadow-memory hex dump omitted — the ERROR, the #0..#N stack "
    + "(file:line), and the SUMMARY above are the exact bug location; fix that]"
  );
}

// A descriptive alias makes call sites read naturally without locking them to
// the shorter original name.
export const classifyOfflineInstallCommand = classifyOfflineInstall;

export function formatOfflineInstallMessage(classification) {
  const manager = classification?.ecosystem || "package manager";
  const operation = classification?.operation || "install";
  const destination = classification?.destination || "the project's dependency environment";
  // An exec-style block (npx / npm exec) usually doesn't need the network at
  // all — the tool is typically already a project dependency. Say so FIRST:
  // the typewriter replay (chat r0 @ 2026-08-17T23:10) built for 55 turns and
  // then stalled on `npm exec` when ./node_modules/.bin/<tool> would have run
  // offline. Context at the point of failure beats a standing prompt rule.
  const execFallback = operation === "exec"
    ? "If the tool is already a project dependency, run its binary directly instead — `./node_modules/.bin/<tool> ...` (list what exists with `ls node_modules/.bin`), or `npm exec --offline --no-install -- <tool> ...`. That needs no network and is usually all this situation requires."
    : null;
  const systemScope = classification?.scope === "system";
  const persistent = classification?.persistent === true;
  return [
    `[offline-install] Blocked ${manager} ${operation}: no command was run.`,
    ...(execFallback ? [execFallback] : []),
    "Bantam's default Docker shell has networking disabled, so it cannot reach package registries or system mirrors.",
    ...(systemScope
      ? [
          "This manager writes into the container image, which Bantam shadows with the host's read-only /usr and discards after every command (`docker run --rm --read-only`): an in-container apt/apk install can neither persist nor become visible.",
          "To give the sandbox a system tool, make it available on the HOST where the sandbox already mounts read-only — a normal install under /usr or /usr/local, or an extra root (for example the Chrome .deb at /opt/google/chrome) via BANTAM_SHELL_MOUNT_RO=/opt/google/chrome. Snap-only installs stay unreachable; use a non-snap build.",
          "A browser the project drives itself is different: install the project dependency (Playwright/Puppeteer) and let its own downloader fetch the browser into HOME, which is persistent sandbox scratch. Approve network for that install instead of installing a system package.",
        ]
      : [
          `This manager normally writes to ${destination}${persistent ? ", which sits inside the writable workspace or the persistent sandbox HOME, so an approved install survives later commands" : ""}. Node dependencies belong in the target project's node_modules; Python dependencies belong in a project-local .venv (a bare 'pip install' targets the read-only mounted interpreter, so create the venv first).`,
        ]),
    "Run the install from a normal terminal outside Bantam, or let Bantam ask the operator and approve it: answer the prompt interactively, or start with --allow-installs (or BANTAM_ALLOW_INSTALLS=1) to approve network for classified installs without prompting.",
    "Alternatively, restart Bantam with --shell-network (or BANTAM_SHELL_NETWORK=1) only if you trust the model and workspace. This keeps Docker filesystem confinement but permits model-chosen commands to send workspace data over the network.",
    "Do not switch to BANTAM_SHELL_SANDBOX=host merely to install packages: host mode has no filesystem confinement and can access anything your user account can.",
  ].join("\n");
}

/**
 * Where would this install land, and can it survive the command?
 *   project -> workspace node_modules/.venv or the persistent sandbox HOME (persists)
 *   global  -> the read-only mounted interpreter/tool prefix (does not persist)
 *   system  -> the container image rootfs (does not persist; the image is discarded)
 */
function installScope(ecosystem, words) {
  if (SYSTEM_PACKAGE_MANAGERS.has(ecosystem)) return "system";
  if (GLOBAL_INSTALL_MANAGERS.has(ecosystem) && words.some((word) => GLOBAL_INSTALL_FLAGS.has(word))) {
    return "global";
  }
  return "project";
}

function classifyWords(words, assignments) {
  if (!words.length) return null;
  let executable = executableName(words[0]);
  let args = words.slice(1);

  // `python -m pip` and `python -m uv` are common enough that treating Python
  // as a generic wrapper is safer than relying on executable-name matching.
  if (isPython(executable)) {
    const moduleIndex = args.indexOf("-m");
    if (moduleIndex === -1 || moduleIndex + 1 >= args.length) return null;
    const moduleName = executableName(args[moduleIndex + 1]);
    if (moduleName !== "pip" && moduleName !== "uv") return null;
    executable = moduleName;
    args = args.slice(moduleIndex + 2);
  }

  if (/^pip(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    return simpleClassification("pip", executable, args, new Set(["install", "download", "wheel"]), {
      offlineFlags: ["--no-index"],
    });
  }

  switch (executable) {
    case "npm":
      return classifyNpm(executable, args);
    case "npx":
      return classifyNpx(executable, args);
    case "yarn":
      return classifyYarn(executable, args);
    case "pnpm":
      return simpleClassification("pnpm", executable, args,
        new Set(["install", "i", "add", "fetch", "update", "up", "dlx"]));
    case "uv":
      return classifyUv(executable, args);
    case "uvx":
      return classifyUvx(executable, args);
    case "conda":
    case "mamba":
    case "micromamba":
      return classifyConda(executable, args);
    case "apt":
    case "apt-get":
      return simpleClassification("apt", executable, args,
        new Set(["install", "update", "upgrade", "full-upgrade", "dist-upgrade", "download", "source", "build-dep"]), {
          offlineFlags: ["--no-download"],
        });
    case "apk":
      return simpleClassification("apk", executable, args,
        new Set(["add", "update", "upgrade", "fetch", "fix"]), {
          offlineFlags: ["--no-network"],
        });
    case "cargo":
      return classifyCargo(executable, args);
    case "go":
      return classifyGo(executable, args, assignments);
    case "gem":
      return simpleClassification("gem", executable, args,
        new Set(["install", "fetch", "update"]), {
          offlineFlags: ["--local"],
        });
    default:
      return null;
  }
}

function classifyNpm(executable, args) {
  const parsed = firstSubcommand(args);
  if (!parsed) return null;
  const installs = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "ci", "add", "install-ci-test", "install-test"]);
  if (installs.has(parsed.operation)) return result("npm", executable, parsed.operation, args);
  if (parsed.operation !== "exec") return null;
  if (onlyInformationalArgs(args.slice(parsed.index + 1))) return null;
  return result("npm", executable, "exec", args, ["--offline", "--no-install"]);
}

function classifyNpx(executable, args) {
  if (!args.length || onlyInformationalArgs(args)) return null;
  // npx/npm exec may use an already-installed binary, but if it is absent they
  // consult the registry. Static preflight cannot prove the binary is local,
  // so require the caller to make that intent explicit.
  return result("npm", executable, "exec", args, ["--offline", "--no-install"]);
}

function classifyYarn(executable, args) {
  const parsed = firstSubcommand(args);
  if (!parsed) {
    // Classic and modern Yarn both treat a bare invocation (possibly with
    // configuration flags such as --cwd) as an install. Help/version do not.
    if (args.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))) return null;
    return result("yarn", executable, "install", args);
  }
  if (["run", "test", "build", "exec", "node"].includes(parsed.operation)) return null;
  if (!["install", "add", "upgrade", "up", "fetch", "dlx"].includes(parsed.operation)) return null;
  return result("yarn", executable, parsed.operation, args);
}

function classifyUv(executable, args) {
  const parsed = firstSubcommand(args);
  if (!parsed) return null;
  let operation = parsed.operation;
  if (["sync", "add"].includes(operation)) return result("uv", executable, operation, args);

  if (operation === "pip") {
    const nested = firstSubcommand(args.slice(parsed.index + 1));
    if (nested && ["install", "sync"].includes(nested.operation)) {
      return result("uv", executable, `pip ${nested.operation}`, args);
    }
  }
  if (operation === "tool" || operation === "python") {
    const nested = firstSubcommand(args.slice(parsed.index + 1));
    if (nested && (nested.operation === "install" || (operation === "tool" && nested.operation === "run"))) {
      return result("uv", executable, `${operation} ${nested.operation}`, args);
    }
  }
  return null;
}

function classifyUvx(executable, args) {
  if (!args.length || onlyInformationalArgs(args)) return null;
  return result("uv", executable, "tool run", args);
}

function classifyConda(executable, args) {
  const parsed = firstSubcommand(args);
  if (!parsed) return null;
  if (["install", "create", "update", "upgrade"].includes(parsed.operation)) {
    return result("conda", executable, parsed.operation, args, ["--offline"]);
  }
  if (parsed.operation === "env") {
    const nested = firstSubcommand(args.slice(parsed.index + 1));
    if (nested && ["create", "update"].includes(nested.operation)) {
      return result("conda", executable, `env ${nested.operation}`, args, ["--offline"]);
    }
  }
  return null;
}

function classifyCargo(executable, args) {
  // Cargo permits a +toolchain selector before its actual subcommand.
  const withoutToolchain = args[0]?.startsWith("+") ? args.slice(1) : args;
  return simpleClassification("cargo", executable, withoutToolchain,
    new Set(["install", "fetch", "add", "update"]));
}

function classifyGo(executable, args, assignments) {
  const parsed = firstSubcommand(args);
  if (!parsed) return null;
  const proxyOff = String(assignments.get("GOPROXY") ?? "").toLowerCase() === "off";
  if (["install", "get"].includes(parsed.operation)) {
    return result("go", executable, parsed.operation, args, [], proxyOff);
  }
  if (parsed.operation === "mod") {
    const nested = firstSubcommand(args.slice(parsed.index + 1));
    if (nested?.operation === "download") {
      return result("go", executable, "mod download", args, [], proxyOff);
    }
  }
  return null;
}

function simpleClassification(ecosystem, executable, args, operations, { offlineFlags = ["--offline"] } = {}) {
  const parsed = firstSubcommand(args);
  if (!parsed || !operations.has(parsed.operation)) return null;
  return result(ecosystem, executable, parsed.operation, args, offlineFlags);
}

function result(ecosystem, executable, operation, args, offlineFlags = ["--offline"], forcedOffline = false) {
  return {
    ecosystem,
    executable,
    operation,
    offline: forcedOffline || offlineFlags.some((flag) => args.includes(flag)),
  };
}

function firstSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      return i + 1 < args.length ? { operation: args[i + 1].toLowerCase(), index: i + 1 } : null;
    }
    if (arg.startsWith("-")) {
      const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!arg.includes("=") && GLOBAL_VALUE_OPTIONS.has(option)) i++;
      continue;
    }
    return { operation: arg.toLowerCase(), index: i };
  }
  return null;
}

function onlyInformationalArgs(args) {
  return args.length > 0 && args.every((arg) => ["--help", "-h", "--version", "-v"].includes(arg));
}

function unwrapCommand(tokens) {
  let index = 0;
  const assignments = new Map();

  while (index < tokens.length) {
    while (index < tokens.length && ASSIGNMENT_RE.test(tokens[index])) {
      noteAssignment(assignments, tokens[index++]);
    }
    if (index >= tokens.length) break;

    const executable = executableName(tokens[index]);
    if (executable === "sudo") {
      index = skipOptions(tokens, index + 1, new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user"]));
      continue;
    }
    if (executable === "env") {
      index = skipOptions(tokens, index + 1, new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"]));
      while (index < tokens.length && ASSIGNMENT_RE.test(tokens[index])) {
        noteAssignment(assignments, tokens[index++]);
      }
      continue;
    }
    if (["command", "nohup"].includes(executable)) {
      index = skipOptions(tokens, index + 1, new Set());
      continue;
    }
    if (executable === "time") {
      index = skipOptions(tokens, index + 1, new Set(["-f", "-o", "--format", "--output"]));
      continue;
    }
    if (executable === "nice") {
      index = skipOptions(tokens, index + 1, new Set(["-n", "--adjustment"]));
      continue;
    }
    if (executable === "timeout") {
      index = skipOptions(tokens, index + 1, new Set(["-k", "-s", "--kill-after", "--signal"]));
      if (index < tokens.length) index++; // duration
      continue;
    }
    if (executable === "corepack") {
      index++;
      continue;
    }
    break;
  }

  return { words: tokens.slice(index), assignments };
}

function skipOptions(tokens, start, valueOptions) {
  let index = start;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    if (tokens[index] === "--") return index + 1;
    const option = tokens[index].includes("=") ? tokens[index].slice(0, tokens[index].indexOf("=")) : tokens[index];
    index++;
    if (!tokens[index - 1].includes("=") && valueOptions.has(option) && index < tokens.length) index++;
  }
  return index;
}

function noteAssignment(assignments, token) {
  const separator = token.indexOf("=");
  const key = token.slice(0, separator).toUpperCase();
  assignments.set(key, token.slice(separator + 1));
}

function executableName(value) {
  return String(value ?? "")
    .replace(/^[({]+/, "")
    .replace(/[)}]+$/, "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
}

function isPython(executable) {
  return executable === "py" || /^python(?:\d+(?:\.\d+)*)?$/.test(executable);
}

function readNodeManifest(workspace) {
  try {
    const file = path.join(path.resolve(workspace), "package.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function npmScriptOperation(args) {
  const parsed = firstSubcommand(args);
  if (!parsed) return "npm script";
  if (parsed.operation === "run" || parsed.operation === "run-script") {
    const name = nextWord(args, parsed.index + 1);
    return name ? `npm run ${name}` : "npm run";
  }
  if (["start", "stop", "restart", "test"].includes(parsed.operation)) return `npm ${parsed.operation}`;
  return `npm ${parsed.operation}`;
}

function npmScriptExecutables(args, scripts) {
  const operation = npmScriptOperation(args);
  const scriptName = operation.startsWith("npm run ")
    ? operation.slice("npm run ".length)
    : operation.startsWith("npm ") ? operation.slice("npm ".length) : null;
  const script = scriptName ? scripts[scriptName] : null;
  if (typeof script !== "string" || !script.trim()) return [];
  const executables = [];
  for (const segment of shellSegments(script)) {
    const words = unwrapCommand(splitShellWords(segment)).words;
    if (words.length) executables.push(executableName(words[0]));
  }
  return executables;
}

function nextWord(args, start) {
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

function hasLocalNodeBinary(workspace, executable) {
  const bin = path.join(path.resolve(workspace), "node_modules", ".bin", executable);
  return fs.existsSync(bin) || fs.existsSync(`${bin}.cmd`);
}
