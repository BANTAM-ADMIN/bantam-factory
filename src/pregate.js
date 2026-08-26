// Static pre-gate on edits.
//
// The moment the model writes or edits a source file, run an instant,
// language-appropriate SYNTAX check and, if it fails, fold the error straight
// into the observation. A broken edit is caught in milliseconds instead of
// costing a whole read/test cycle — a cheap local check that makes a small model
// meaningfully more effective.
//
// This is NOT the hidden grader (which runs the tests). It only asks "does this
// file parse?", so it never reveals the verification and can't be gamed.

import { execFileSync } from "node:child_process";
import path from "node:path";

const CHECKERS = {
  ".js": ["node", ["--check"]],
  ".mjs": ["node", ["--check"]],
  ".cjs": ["node", ["--check"]],
  // py_compile writes __pycache__ into the workspace even under PYTHONDONTWRITEBYTECODE=1
  // (checked on 3.12) — a harness-caused mutation that tree snapshots then blame on the
  // model (the v37-39 phantom-contamination class). So this checker compiles the real
  // file's bytes in memory and writes nothing.
  ".py": ["python3", ["-c", "import sys; p=sys.argv[1]; compile(open(p, 'rb').read(), p, 'exec')"]],
  ".go": ["gofmt", ["-e"]],
};

/**
 * Syntax-check a single file. Returns { ok } or { ok:false, error } or
 * { ok:true, skipped:true } for unsupported extensions / missing toolchain.
 */
export function staticCheck(workspace, relPath) {
  const spec = CHECKERS[path.extname(relPath).toLowerCase()];
  if (!spec) return { ok: true, skipped: true };
  const [cmd, args] = spec;
  // `path.resolve`, not `path.join`: the model routinely writes to an absolute in-workspace path
  // (`/app/x.js`), and joining that onto the workspace yields `/app/app/x.js`. The checker then
  // ran against a nonexistent file and reported MODULE_NOT_FOUND as though the model had written
  // a syntax error — sending it off to "fix" code that was already valid.
  const root = path.resolve(workspace);
  const full = path.resolve(root, relPath);
  // Never run a checker outside the workspace; nothing to say about a file we don't own.
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: true, skipped: true };
  try {
    execFileSync(cmd, [...args, full], {
      cwd: workspace,
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    // A missing toolchain (ENOENT) is not a syntax error — don't punish the model.
    if (e.code === "ENOENT") return { ok: true, skipped: true };
    const msg = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim();
    return { ok: false, error: clip(msg) };
  }
}

function clip(s, n = 800) {
  return s.length <= n ? s : s.slice(0, n) + "\n… (clipped)";
}
