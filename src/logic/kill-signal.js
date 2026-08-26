// kill-signal.js — make a signal kill legible instead of a bare exit code.
//
// A process killed by a signal reports 128+signal and, because it never reached
// its own output, usually prints nothing at all. The model receives:
//
//     $ cd /app && python3 enc.py
//     exit 137
//
// and nothing else. MEASURED on write-compressor (2026-08-22, local): the
// encoder was thrashing at the container's 2 GiB ceiling (rss 1.86 GB, cgroup
// 99.5% full). BANTAM had no handling for 137 anywhere, so nothing said
// "memory". The model diagnosed it correctly ONCE from the bare number, then on
// the next identical result decided "the shell command was compacted, let me
// re-run it" and issued the same command four times. Each attempt sat against
// BANTAM_SHELL_TIMEOUT_MS (300s here) before dying -- 17% of a 30-minute agent
// budget per attempt. The run managed 19 actions in 26 minutes against the
// baseline's 48 in 29.
//
// The remedy is context, not a shorter timeout: say what killed it, say that a
// re-run will do the same, and name the class of change that helps.

const SIGNAL_CODES = new Map([["SIGKILL", 137], ["SIGSEGV", 139], ["SIGABRT", 134], ["SIGTERM", 143]]);

const SIGNALS = new Map([
  [137, { name: "SIGKILL", why: "almost always the out-of-memory killer" }],
  [139, { name: "SIGSEGV", why: "a segmentation fault" }],
  [134, { name: "SIGABRT", why: "an abort (assert, uncaught C++ exception, or glibc error)" }],
  [143, { name: "SIGTERM", why: "an external terminate" }],
]);

/** Bytes → human. Returns null when the value is not usable. */
function human(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0 || n >= Number.MAX_SAFE_INTEGER) return null;
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/**
 * The note to append for a signal-killed command, or "" when the exit code is
 * an ordinary one. `memoryLimitBytes` is the container/cgroup limit when known.
 */
export function killSignalNote(code, { memoryLimitBytes = null, producedOutput = true, signal = null } = {}) {
  // Two paths reach here and only one carries a number. A shell that outlives
  // its child reports the child's death numerically (bash gives 137 for a
  // SIGKILLed child). A process killed directly gives Node code=null plus a
  // signal NAME, and process-runner maps that to a bare `code: 1` -- which is
  // indistinguishable from an ordinary failure unless the signal is read too.
  const byName = signal ? [...SIGNALS.values()].find((s) => s.name === String(signal)) : null;
  const sig = SIGNALS.get(Number(code)) ?? byName;
  if (!sig) return "";
  const effectiveCode = SIGNALS.has(Number(code)) ? Number(code) : SIGNAL_CODES.get(sig.name);
  const limit = human(memoryLimitBytes);
  const parts = [`[killed] the process was killed by ${sig.name} — ${sig.why}.`];
  if (effectiveCode === 137) {
    parts.push(limit
      ? `This container's memory limit is ${limit}, and a process that reaches it is killed with no chance to print anything.`
      : "A process killed this way is stopped before it can print anything.");
    parts.push("Re-running the same command will fail the same way. Reduce PEAK memory:"
      + " stream or chunk instead of building whole lists/strings in RAM, avoid holding"
      + " several copies of the data, and test on a small slice first.");
  } else if (!producedOutput) {
    parts.push("It produced no output because it never reached its own prints.");
  }
  return parts.join(" ");
}

/**
 * The file the command pipes/redirects into a program, if that file is EMPTY.
 * write-compressor (2026-08-23, wc-oracle): `python3 enc.py && cat data.comp |
 * ./decomp ...` ran clean (exit=0) on turns 11, 19, 21, 25 -- because data.comp
 * was 0 bytes every time. The decoder succeeded on nothing; "exit=0" sat on its
 * own line and "compressed size: 0" was buried in stderr. The model iterated
 * for 14 turns reading a vacuous success as progress. Name it, first.
 *
 * `statSize(path) -> bytes|null` is injected so this stays pure.
 */
export function emptyInputNote(command, { statSize = () => null, cwd = "." } = {}) {
  const cmd = String(command ?? "");
  const m = /(?:cat\s+(\S+)\s*\|\s*|<\s*)(\S+)?/.exec(cmd);
  // Candidates: `cat FILE | prog` or `prog < FILE`
  const files = [];
  for (const r of cmd.matchAll(/\bcat\s+([^\s|;&]+)\s*\|/g)) files.push(r[1]);
  for (const r of cmd.matchAll(/<\s*([^\s|;&>]+)/g)) files.push(r[1]);
  for (const f of files) {
    if (/^\/dev\//.test(f) || f.startsWith("<<")) continue;
    const size = statSize(f);
    if (size === 0) {
      return `[empty-input] ${f} is 0 bytes. The program you piped it into ran on NOTHING -- its exit code`
        + ` says nothing about your stream. Your encoder did not write the file (or wrote it empty): fix`
        + ` the write/finish path before reading any further verify as progress.`;
    }
  }
  return "";
}

/** Read the cgroup memory limit from inside the container; null when unknown. */
export function cgroupMemoryLimit(readFile) {
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = String(readFile(p)).trim();
      if (!raw || raw === "max") continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return n;
    } catch { /* not this layout */ }
  }
  return null;
}
