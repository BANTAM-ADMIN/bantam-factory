// A run checkpoint stored the workspace PATH but not its BYTES. So `--resume-run`
// restored the dialogue and then warned "--workspace must already match that
// artifact cursor" — useless once the container that held the workspace was town
// down. A 153-turn run truncated by a harness timeout cost 50 minutes to redo
// COLD, because the partial gpt2.c the model had built lived only in the dead
// container. This captures the small, text, agent-authored files INTO the
// checkpoint so a resume can reconstruct the workspace anywhere.
//
// What it must NEVER do: swallow the weights. gpt2-124M.ckpt (binary, ~500MB),
// a.out (ELF), node_modules — embedding those would bloat the artifact past use
// and defeat the point. Two gates keep it lean: a per-file size cap, and a
// NUL-byte binary sniff (TF checkpoints, ELF binaries, images all trip it).

import fs from "node:fs";
import path from "node:path";

export const SNAPSHOT_DEFAULTS = {
  perFileCap: 512 * 1024, // 512KB: a source file over this is almost certainly generated/data
  totalCap: 4 * 1024 * 1024, // 4MB: the whole snapshot stays smaller than one model turn's tokens
  maxFiles: 500,
  // Directories that are either huge, regenerable, or not the agent's work.
  excludeDirs: new Set([
    "node_modules", ".git", ".bantam", ".bantam-checkpoints", "__pycache__",
    ".cache", "dist", "build", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  ]),
};

/** Cheap binary sniff: a NUL in the first 4KB. Catches .ckpt, ELF a.out, images, .pyc. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk `dir` and return the small text files, ready to embed in a checkpoint.
 * Pure and NON-THROWING: any fs error degrades to returning what was gathered so
 * far. Never called from a signal handler — the checkpoint refreshes this on the
 * autosave cadence (normal loop context) and the signal flush writes the last one.
 *
 * @returns {{root:string, files:{path:string,content:string,size:number}[],
 *            skipped:{path:string,size:number,why:string}[], truncated:boolean,
 *            totalBytes:number}}
 */
export function snapshotWorkspace(dir, opts = {}) {
  const cfg = { ...SNAPSHOT_DEFAULTS, ...opts };
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let truncated = false;

  if (!dir || typeof dir !== "string") {
    return { root: dir ?? null, files, skipped, truncated, totalBytes };
  }

  let root;
  try { root = fs.realpathSync(dir); } catch { root = dir; }

  const stack = [root];
  while (stack.length) {
    if (files.length >= cfg.maxFiles || totalBytes >= cfg.totalCap) { truncated = true; break; }
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; } // unreadable dir → skip, never throw
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue; // don't follow links (could escape the workspace or loop)
      if (ent.isDirectory()) {
        if (!cfg.excludeDirs.has(ent.name)) stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, full) || ent.name;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > cfg.perFileCap) { skipped.push({ path: rel, size: st.size, why: "too-big" }); continue; }
      if (totalBytes + st.size > cfg.totalCap) { skipped.push({ path: rel, size: st.size, why: "total-cap" }); truncated = true; continue; }
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      if (looksBinary(buf)) { skipped.push({ path: rel, size: st.size, why: "binary" }); continue; }
      files.push({ path: rel, content: buf.toString("utf8"), size: st.size });
      totalBytes += st.size;
      if (files.length >= cfg.maxFiles) { truncated = true; break; }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, files, skipped, truncated, totalBytes };
}

/**
 * Reconstruct a workspace from a snapshot: write every captured file under `dir`.
 * Used by the resume path. Returns {written, failed}. Non-throwing per file so one
 * bad path can't abort the restore.
 */
export function restoreWorkspace(snapshot, dir, { skipExisting = false } = {}) {
  const written = [];
  const failed = [];
  const skippedExisting = [];
  if (!snapshot || !Array.isArray(snapshot.files) || !dir) return { written, failed, skippedExisting };
  const root = path.resolve(dir);
  for (const f of snapshot.files) {
    // Refuse absolute paths and .. escapes: a checkpoint must not write outside its workspace.
    if (!f || typeof f.path !== "string" || path.isAbsolute(f.path)) { failed.push(f?.path ?? "?"); continue; }
    const dest = path.resolve(root, f.path);
    if (dest !== root && !dest.startsWith(root + path.sep)) { failed.push(f.path); continue; }
    // Fill gaps only: never clobber a file already present (the operator may have
    // staged the real task inputs into --workspace; the resume must not overwrite them).
    if (skipExisting && fs.existsSync(dest)) { skippedExisting.push(f.path); continue; }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content ?? "");
      written.push(f.path);
    } catch { failed.push(f.path); }
  }
  return { written, failed, skippedExisting };
}
