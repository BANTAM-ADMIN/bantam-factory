// Catch a broken shell script when it is WRITTEN, not when it is run.
//
// TB2 compile-compcert (2026-08-21). The run authored build_compcert.sh, ran it,
// and got back:
//
//     build_compcert.sh: line 101: unexpected EOF while looking for matching '"'
//
// An unbalanced quote. bash reports it at the END of the file with a line number
// pointing at where it gave up looking, not at the quote that opened — line 101
// of a script whose real fault may be forty lines earlier. And the failure only
// surfaces at execution, after the configure step it wraps has already run and
// spent its minutes.
//
// `bash -n` parses without executing and names the fault at authoring time, for
// the cost of one subprocess against a file the run just wrote. Same shape as
// the async-assertion guard: a mechanical check the model cannot forget to run,
// applied at the moment the mistake is cheapest to fix.

import { execFileSync } from "node:child_process";
import path from "node:path";

const SHELL_EXT = /\.(?:sh|bash)$/i;
const SHEBANG = /^#!.*\b(?:ba)?sh\b/;

/** Is this a shell script we can parse-check? Extension, or a shebang. */
export function looksLikeShell(filePath, content = "") {
  if (SHELL_EXT.test(String(filePath ?? ""))) return true;
  const first = String(content ?? "").split("\n", 1)[0] ?? "";
  return SHEBANG.test(first);
}

/**
 * Parse-check a shell script the run just authored. Returns a hint string when
 * the script cannot parse, or null when it is fine (or unknowable).
 *
 * Never throws: a guard that breaks the turn it was meant to help is worse than
 * no guard.
 */
export function shellSyntaxHint(filePath, {
  workspace = ".",
  readFile = null,
  check = null,
} = {}) {
  try {
    const rel = String(filePath ?? "");
    if (!rel) return null;
    // Extension first, and only fall back to reading for a shebang. Reading
    // every edited file to sniff line 1 would put a file read on EVERY edit in
    // the sweep, including multi-megabyte data files a run just rewrote — a
    // guard should not tax the path it is watching.
    const base = rel.split("/").pop() ?? rel;
    if (!SHELL_EXT.test(rel)) {
      // Only an EXTENSIONLESS file can be a shebang script worth sniffing
      // (`runner`, `build`). A .py/.csv/.json edit is never a shell script, so
      // it costs zero reads — the guard must not tax every edit in the sweep.
      if (base.includes(".")) return null;
      const content = typeof readFile === "function" ? readFile(rel) : null;
      if (!looksLikeShell(rel, content ?? "")) return null;
    }

    const abs = path.isAbsolute(rel) ? rel : path.resolve(workspace, rel);
    let stderr = "";
    if (typeof check === "function") {
      stderr = check(abs) ?? "";
    } else {
      try {
        execFileSync("bash", ["-n", abs], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
        return null;
      } catch (e) {
        stderr = String(e?.stderr ?? "").trim();
        // A non-syntax failure (file vanished, bash missing) is not a finding.
        if (!stderr || /No such file|command not found/i.test(stderr)) return null;
      }
    }
    if (!stderr) return null;

    const firstLine = stderr.split("\n").find(Boolean) ?? stderr;
    const unbalanced = /unexpected EOF while looking for matching/i.test(stderr);
    return `\n\n[shell-syntax] \`${rel}\` does not parse: ${firstLine.slice(0, 200)}\n`
      + (unbalanced
        ? "That message points at where bash GAVE UP, not at the quote or bracket that opened — the real fault is usually earlier in the file. "
        : "")
      + "Fix it now, before running it: a script that cannot parse fails at execution, after whatever it wraps has already spent its time, "
      + "and reports a line number that misleads. `bash -n <file>` re-checks it for free.";
  } catch {
    return null;
  }
}
