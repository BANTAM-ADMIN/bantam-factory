// Grounding: put the datalog KB underneath the agent loop.
//
// Two jobs, both cheap relative to a token:
//   1. codeMap()     — a compact, KB-derived map of the codebase injected into context, so the
//                      model knows the structure without re-reading big files to discover it.
//   2. groundAction()— before a read/edit executes, reject a path that PROVABLY doesn't exist
//                      and hand back the nearest real candidates. The model can't waste a turn
//                      (or hallucinate its way) into a file that isn't there.
//
// Path existence is checked against the LIVE filesystem (always current); the KB supplies the
// suggestions and the code map.

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Datalog } from "./datalog.js";
import {
  extractCodeFacts,
  materializeCodeFacts,
  nearestFiles,
  refreshCodeFactIndex,
} from "./codefacts.js";

/** Build a grounding context from a workspace. Cheap; safe on non-code workspaces (empty KB). */
export function buildGrounding(workspace, { maxFiles = 600 } = {}) {
  const db = new Datalog();
  let stats = { files: 0 };
  let factIndex = null;
  try {
    const extracted = extractCodeFacts(db, workspace);
    ({ index: factIndex, ...stats } = extracted);
    if (stats.files > maxFiles) stats.capped = true; // extracted anyway; just note it
  } catch { /* non-code or unreadable workspace -> empty KB, grounding is a no-op */ }
  // Separate from the JS/TS fact-index revision: the repository mapper also
  // understands Go/Python and reads package.json executable metadata.
  return { db, workspace, stats, factIndex, maxFiles, staleFiles: new Set(), mapRevision: 0 };
}

/** Mark analyzed source facts stale after successful workspace edits. */
export function markGroundingStale(ground, changedPaths) {
  if (!ground?.workspace) return [];
  if (!(ground.staleFiles instanceof Set)) ground.staleFiles = new Set();
  const added = [];
  for (const changedPath of changedPaths ?? []) {
    if (!changedPath || typeof changedPath !== "string") continue;
    const absolute = path.isAbsolute(changedPath)
      ? path.resolve(changedPath)
      : path.resolve(ground.workspace, changedPath);
    const relative = path.relative(ground.workspace, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const extensions = ground.factIndex?.exts ?? [".js", ".mjs"];
    if (!extensions.some((extension) => relative.endsWith(extension))) continue;
    if (!ground.staleFiles.has(relative)) {
      ground.staleFiles.add(relative);
      added.push(relative);
    }
  }
  return added;
}

/** Refresh changed file records and atomically replace all derived facts. */
export function refreshGrounding(ground, changedPaths, options = {}) {
  if (ground && (changedPaths ?? []).some((value) => mapRelevantPath(value))) {
    ground.mapRevision = (ground.mapRevision ?? 0) + 1;
  }
  const changed = markGroundingStale(ground, changedPaths);
  const pending = [...(ground?.staleFiles ?? [])].sort();
  if (!ground?.factIndex) {
    return { ok: false, error: "grounding fact index is unavailable", refreshed: [], stale: pending };
  }
  if (!pending.length) return { ok: true, refreshed: [], removed: [], ignored: [], ms: 0 };

  const startedAt = performance.now();
  const update = refreshCodeFactIndex(ground.factIndex, pending, options);
  if (!update.ok) {
    return { ...update, changed, stale: pending, ms: performance.now() - startedAt };
  }
  try {
    const nextDb = new Datalog();
    const nextStats = materializeCodeFacts(nextDb, update.index);
    if (nextStats.files > (ground.maxFiles ?? 600)) nextStats.capped = true;
    const refreshed = [...update.refreshed, ...update.removed].sort();
    ground.db = nextDb;
    ground.factIndex = update.index;
    for (const file of refreshed) ground.staleFiles.delete(file);
    ground.stats = {
      ...nextStats,
      refreshes: (ground.stats?.refreshes ?? 0) + 1,
      refreshMs: (ground.stats?.refreshMs ?? 0) + (performance.now() - startedAt),
      lastRefreshFiles: refreshed,
    };
    return {
      ok: true,
      refreshed,
      removed: update.removed,
      ignored: update.ignored,
      stale: [...ground.staleFiles].sort(),
      ms: performance.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error: error.message, changed, stale: pending, ms: performance.now() - startedAt };
  }
}

function mapRelevantPath(value) {
  const rel = String(value ?? "").replace(/\\/g, "/");
  return /(?:^|\/)package\.json$|\.(?:go|py|js|cjs|mjs)$/.test(rel);
}

/** A compact map of the codebase for the prompt: file -> its top-level definitions. */
export function codeMap(g, { maxFiles = 50, maxSymbols = 10 } = {}) {
  if (!g || g.stats.files === 0) return "";
  const files = g.db.query("file", "?").map((r) => r[0]).sort();
  const lines = files.slice(0, maxFiles).map((f) => {
    const syms = g.db.query("defines", f, "?").map((r) => r[1]).slice(0, maxSymbols);
    return `  ${f}${syms.length ? " — " + syms.join(", ") : ""}`;
  });
  const more = files.length > maxFiles ? `\n  … +${files.length - maxFiles} more files` : "";
  return `Code map (static analysis — consult this instead of reading files just to learn structure):\n${lines.join("\n")}${more}`;
}

/**
 * Return a grounding rejection for an action that references something that provably does not
 * exist, or null to let it through. Only fires on read/edit of a MISSING path — creating a new
 * file (write_file) is always allowed.
 */
export function groundAction(g, action, { onReject } = {}) {
  if (!g || !action) return null;
  const a = action.a;
  const paths = a === "patch"
    ? (action.edits ?? []).map((edit) => edit.p)
    : a === "move_file" ? [action.from] : [action.p];
  if (a !== "read_file" && a !== "replace" && a !== "patch" && a !== "delete_file" && a !== "move_file") return null;
  for (const p of paths) {
    if (!p || typeof p !== "string") continue;
    const abs = path.isAbsolute(p) ? p : path.join(g.workspace, p);
    if (fileExists(abs)) continue;
    // A directory is not "no such file". v25 called `read_file test/` on a real
    // directory and grounding branded it nonexistent — which both lied and
    // pre-empted the executor's own "that's a directory, here's the listing"
    // redirect. Let a real directory through; the executor handles it usefully.
    if (dirExists(abs)) continue;
    const near = nearestFiles(g.db, p, 3);
    const suggest = near.length ? ` Did you mean: ${near.join(", ")}?` : " List the directory to find the correct path.";
    if (onReject) onReject({ action, path: p, suggestions: near });
    return `[grounding] No such file: "${p}". Do not ${a} a path that does not exist.${suggest}`;
  }
  return null;
}

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
