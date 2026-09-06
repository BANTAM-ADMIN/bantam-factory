// Shared signals for commands that exercise a produced artifact or a real test runner.
//
// This is deliberately a small shell lexer, not a shell parser. It only separates command
// segments and words while respecting quotes, then classifies the executable and task arguments.
// Precision matters: quoted prose must not become verification evidence.

import { shellSegments, splitShellWords } from "../shell-lex.js";

const DIRECT_TEST_RUNNERS = new Set([
  "pytest", "py.test", "jest", "vitest", "mocha", "ctest", "tox", "nox", "rspec", "phpunit", "prove",
]);
const JS_PACKAGE_RUNNERS = new Set(["npm", "yarn", "pnpm", "bun"]);
const GRADLE_RUNNERS = new Set(["gradle", "gradlew"]);
const MAVEN_RUNNERS = new Set(["mvn", "mvnw"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE_VALUE_OPTIONS = new Set(["--filter", "-F", "--workspace", "-w", "--prefix", "-C", "--dir"]);
const NPX_VALUE_OPTIONS = new Set(["--package", "-p", "--call", "-c", "--cache", "--userconfig"]);
const GRADLE_VALUE_OPTIONS = new Set(["--task", "-p", "--project-dir", "-c", "--settings-file", "-b", "--build-file", "-I", "--init-script", "--include-build", "--max-workers"]);
const MAKE_VALUE_OPTIONS = new Set(["-C", "-f", "--file", "-I", "--include-dir", "-j", "--jobs"]);

// Kept exported for compatibility with earlier consumers. New code should call isDeliverableRun.
export const DELIVERABLE_RUN_RE =
  /^(?:\.\/|\/app\/)|^(?:python3?|node|ruby)\s+\S+\.(?:py|[mc]?js|rb)\b|^(?:go|cargo|dotnet)\s+run\b|^Rscript\b|^java\s+-jar\b/i;

export const CONTROL_FLOW_RE = /^\s*(?:grep|test|\[|find|which|ls|diff|cmp|rg)\b/;

export const CRASH_RE =
  /\bSegmentation fault\b|\(core dumped\)|\bSIGSEGV\b|\bSIGABRT\b|Aborted\s*\(core|munmap_chunk|double free|stack smashing detected/i;

// Two traps this regex must dodge, both observed on a PASSING `cargo test` ("ok. 1 passed; 0 failed"):
//  * failed-COUNT alternatives require a NON-ZERO count — a bare `\d+ failed` matches "0 failed";
//  * the FAILED verdict marker must be case-SENSITIVE — under the old blanket /i it matched the word
//    "failed" anywhere, which both flagged every green cargo run AND made the count check dead code.
// Case is now handled per-alternative instead of one regex-wide /i. The line-anchored FAIL forms are
// go's ("--- FAIL: TestX", "FAIL\tpkg") and the jest/vitest FAIL headers — none appear on success.
// Interpreter parse/startup failures: a traceback ending in SyntaxError never
// ran the deliverable at all — that is a hard failure even when the shell
// wrapper swallowed the exit code (fair-bantam t53, 2026-08-18).
export const INTERPRETER_FAIL_RE = /Traceback \(most recent call last\)|SyntaxError|IndentationError/;

export const RUNNER_FAIL_RE =
  /\b[1-9]\d*\s+[Ff]ailed\b|\bFAILED\b(?!\s*\(0\))|=====\s*FAILURES|\bAssertionError\b|(?<!\b0\s)\btests? [Ff]ailed\b|\b[Rr]untime [Ee]rror\b|(?:^|\n)\s*--- FAIL: |(?:^|\n)FAIL[ \t]|(?:^|\n)not ok\b|(?:^|\n)\s*[1-9]\d* fail\b|(?:^|\n)\(fail\) /;

// Legacy process status lines, not requirements such as "invalid names exit 1".
export const EXIT_RE = /^[ \t]*(?:exit(?:[ \t]*code|[ \t]*status)?|returncode)[ \t]*[:=]?[ \t]*(-?\d+)[ \t]*$/gim;

/**
 * Historical turns have only rendered text. Restrict their fallback to the
 * process portion, before any appended harness annotation. New turns must use
 * their structured receipt instead. Keep stdout/stderr section delimiters.
 * Unknown bracketed annotations are uncertainty, never a successful process.
 */
export function legacyProcessObservation(observation) {
  const text = String(observation ?? "").replace(/^\$[^\n]*(?:\n|$)/, "");
  const annotation = /(?:^|\n)[ \t]*\[((?!stderr\]|stdout\])[a-z][a-z0-9_ /:-]*)\](?=[ \t\r\n]|$)/im.exec(text);
  // A program may itself print [error], [info], or another bracketed label.
  // Without typed provenance an unknown boundary is not safe to truncate and
  // then certify from the surviving prefix. Decline to infer an outcome.
  if (annotation && !/^(?:guidance|assignment|review|completion-audit|fs|verification-scope|impact|peer|budget|panel|repetition|done-guard|trusted-review-evidence)$/i.test(annotation[1])) return "";
  return (annotation ? text.slice(0, annotation.index) : text).trim();
}

/** Is any command segment a recognized test runner invocation? */
// `bash -c 'inner'` runs INNER, and the payload arrives from splitShellWords as
// one clean word — but nothing re-entered it, so a test suite piped through grep
// inside the quotes (`bash -c 'node --test … | grep "# fail"'`) was invisible to
// every consumer here. Live consequence (2026-08-17): done-guard's provenance
// check refused a green wrapped suite, and a finished refactor run bounced both
// its dones and hit the turn cap with 18/18 passing on disk. Expand launcher
// payloads into their own segments before classifying, recursively (a wrapper
// in a wrapper is still the inner command), with a depth cap for safety.
function expandedSegments(command, depth = 0) {
  const out = [];
  for (const segment of shellSegments(command)) {
    const words = unwrapLaunchers(splitShellWords(segment));
    const base = executableName(words[0] ?? "");
    if (depth < 3 && /^(?:ba|z|da)?sh$/.test(base) && /^-l?c$/.test(words[1] ?? "") && typeof words[2] === "string") {
      out.push(...expandedSegments(words[2], depth + 1));
      continue;
    }
    out.push(segment);
  }
  return out;
}

export function isTestCommand(command) {
  return expandedSegments(command).some((segment) => isTestWords(unwrapLaunchers(splitShellWords(segment))));
}

export function isDeliverableRun(cmd, { editedNames } = {}) {
  if (isTestCommand(cmd)) return true;
  // A file the model itself created or edited IS the deliverable, whatever its
  // name looks like. The extension heuristics below missed `python3 gguf-scope`
  // (extensionless Unix-style tool, 2026-08-18 bake-off arm-B): seven red
  // self-tests then an accepted done, because the gate judged the command by
  // its name shape instead of by the run's own edit history.
  const edited = editedNames instanceof Set ? editedNames : new Set(editedNames ?? []);
  const namesEdited = (args) => args.some((arg) => {
    const bare = String(arg).replace(/^\.\//, "").split("/").pop();
    return bare && edited.has(bare);
  });
  return expandedSegments(cmd).some((segment) => {
    const words = unwrapLaunchers(splitShellWords(segment));
    if (!words.length) return false;
    const base = executableName(words[0]);
    const args = words.slice(1);
    if (/^(?:\.\/|\/app\/)/.test(words[0])) return !CONTROL_FLOW_RE.test(words.join(" "));
    if (edited.size && /^(?:python3?|node|nodejs|ruby|perl)$/.test(base) && namesEdited(args)) return true;
    if (/^python3?$/.test(base)) return args.some((arg) => /\.py$/i.test(arg));
    if (base === "node" || base === "nodejs") return args.some((arg) => /\.[mc]?js$/i.test(arg));
    if (base === "ruby") return args.some((arg) => /\.rb$/i.test(arg));
    if (base === "perl") return args.some((arg) => /\.(?:t|pl)$/i.test(arg));
    if (base === "rscript") return args.length > 0;
    if (["go", "cargo", "dotnet"].includes(base)) return positional(args)[0]?.toLowerCase() === "run";
    if (base === "java") return args.includes("-jar");
    if (base === "valgrind") return args.length > 0;
    return DELIVERABLE_RUN_RE.test(words.join(" "));
  });
}

// An inline-eval probe (`python -c`, `node -e/-p`, `ruby/perl -e`) tests
// exactly the cases the model is already holding in its head — never the ones
// it forgot. It is not verification: swb2-sympy-rational (2026-07-17) ran
// thirteen probes and zero suite runs across 30 turns while the visible
// baseline suite sat red on its edit. Probe streaks feed the same auto-verify
// breaker that blind edits do.
export function isInlineEvalProbe(cmd) {
  return shellSegments(cmd).some((segment) => {
    const words = unwrapLaunchers(splitShellWords(segment));
    if (!words.length) return false;
    const base = executableName(words[0]);
    const args = words.slice(1);
    const stdinHereDoc = args.includes("-") && /(?:^|\s)<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/m.test(segment);
    if (/^python3?$/.test(base)) return args.includes("-c") || stdinHereDoc;
    if (base === "node" || base === "nodejs") {
      return args.some((a) => a === "-e" || a === "-p" || a === "--eval" || a === "--print")
        || stdinHereDoc;
    }
    if (base === "ruby" || base === "perl") return args.includes("-e") || stdinHereDoc;
    return false;
  });
}

export function nonZeroExit(obs) {
  let m;
  EXIT_RE.lastIndex = 0;
  while ((m = EXIT_RE.exec(String(obs ?? ""))) !== null) {
    const code = parseInt(m[1], 10);
    if (code !== 0) return code;
  }
  return null;
}

function isTestWords(words) {
  if (!words.length) return false;
  const base = executableName(words[0]);
  const args = words.slice(1);
  const pos = positional(args);
  const lower = pos.map((arg) => arg.toLowerCase());

  if (isInformationalInvocation(args)) return false;
  if (DIRECT_TEST_RUNNERS.has(base)) return true;
  if (base === "node" || base === "nodejs") return args.some((arg) => arg === "--test" || arg.startsWith("--test="));
  if (base === "bun") return lower[0] === "test";
  if (base === "deno") return lower[0] === "test";
  if (JS_PACKAGE_RUNNERS.has(base)) {
    const packageArgs = commandPositionals(args, PACKAGE_VALUE_OPTIONS);
    if (/^test(?::[A-Za-z0-9_-]+)?$/i.test(packageArgs[0] ?? "")) return true;
    if (/^(?:run|run-script)$/i.test(packageArgs[0] ?? "") && /^test(?::[A-Za-z0-9_-]+)?$/i.test(packageArgs[1] ?? "")) return true;
    if (/^(?:exec|dlx)$/i.test(packageArgs[0] ?? "") && DIRECT_TEST_RUNNERS.has(executableName(packageArgs[1]))) return true;
  }
  if (base === "npx") {
    const command = commandPositionals(args, NPX_VALUE_OPTIONS)[0];
    return DIRECT_TEST_RUNNERS.has(executableName(command));
  }
  if (/^python3?$/.test(base)) {
    const moduleAt = args.indexOf("-m");
    return moduleAt !== -1 && /^(?:pytest|unittest)$/.test(String(args[moduleAt + 1] ?? "").toLowerCase());
  }
  if (base === "go") return lower[0] === "test";
  if (base === "cargo") return lower[0] === "test" || (lower[0] === "nextest" && lower[1] === "run");
  if (base === "make") return commandPositionals(args, MAKE_VALUE_OPTIONS).some((arg) => /^(?:test|tests|check)$/i.test(arg));
  if (GRADLE_RUNNERS.has(base)) {
    return commandPositionals(args, GRADLE_VALUE_OPTIONS).some((arg) => /test/i.test(arg.replace(/^:+/, "")));
  }
  if (MAVEN_RUNNERS.has(base)) return lower.some((arg) => /^(?:test|verify|integration-test)$/.test(arg));
  if (base === "dotnet" || base === "bazel" || base === "swift" || base === "mix"
      || base === "meson" || base === "flutter" || base === "dart") return lower[0] === "test";
  if (base === "zig") return lower[0] === "test" || (lower[0] === "build" && lower[1] === "test");
  if (base === "cmake") {
    const targetAt = args.indexOf("--target");
    return targetAt !== -1 && /^(?:test|check)$/i.test(args[targetAt + 1] ?? "");
  }
  if (base === "composer") return /^test(?::[A-Za-z0-9_-]+)?$/i.test(pos[0] ?? "");
  return false;
}

function executableName(value) {
  return String(value ?? "").replace(/^[({!]+/, "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function positional(args) {
  return args
    .map((arg) => arg.replace(/[)}]+$/, ""))
    .filter((arg) => arg && !arg.startsWith("-") && !ASSIGNMENT_RE.test(arg));
}

function commandPositionals(args, valueOptions = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || ASSIGNMENT_RE.test(arg)) continue;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      const option = arg.split("=", 1)[0];
      if (valueOptions.has(option) && !arg.includes("=") && i + 1 < args.length) i++;
      continue;
    }
    out.push(arg.replace(/[)}]+$/, ""));
  }
  return out;
}

function isInformationalInvocation(args) {
  return args.some((arg) => /^(?:-h|--help|-V|--version)$/.test(arg));
}

function unwrapLaunchers(input) {
  const words = [...input];
  let changed = true;
  while (words.length && changed) {
    changed = false;
    while (words.length && (ASSIGNMENT_RE.test(words[0]) || /^[({!]+$/.test(words[0]))) {
      words.shift();
      changed = true;
    }
    const base = executableName(words[0]);
    if (["command", "exec", "nohup", "time", "if", "then", "elif", "do"].includes(base)) {
      words.shift();
      changed = true;
    } else if (base === "env") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-u", "--unset", "-C", "--chdir"].includes(option) && words.length) words.shift();
      }
      changed = true;
    } else if (base === "sudo") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-u", "-g", "-h", "-p", "-C", "-r", "-t"].includes(option) && words.length) words.shift();
      }
      changed = true;
    } else if (base === "timeout") {
      words.shift();
      while (words[0]?.startsWith("-")) words.shift();
      if (words.length) words.shift();
      changed = true;
    } else if (base === "nice") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-n", "--adjustment"].includes(option) && words.length) words.shift();
      }
      changed = true;
    } else if (["stdbuf", "xvfb-run"].includes(base)) {
      words.shift();
      while (words[0]?.startsWith("-")) words.shift();
      changed = true;
    } else if (["poetry", "uv", "pipenv"].includes(base) && words[1] === "run") {
      words.splice(0, 2);
      changed = true;
    } else if (base === "bundle" && words[1] === "exec") {
      words.splice(0, 2);
      changed = true;
    }
  }
  return words;
}

/**
 * The stable identity of a shell failure: its last meaningful line. Tracebacks
 * end with the exception; runners end with their summary. Volatile scratch
 * paths are masked so `> /tmp/a1.txt` vs `> /tmp/b1.txt` reruns share a
 * signature (the arm-B evasion, 2026-08-18). Returns null when the
 * observation shows no failure signal.
 */
export function shellFailureSignature(observation) {
  const o = legacyProcessObservation(observation);
  if (!(CRASH_RE.test(o) || RUNNER_FAIL_RE.test(o) || nonZeroExit(o) !== null)) return null;
  const lines = o.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "failure";
  return last.replace(/\/tmp\/[\w.-]+/g, "/tmp/…").replace(/\d{4,}/g, "N");
}
