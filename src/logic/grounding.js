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
  walk as walkSourceFiles,
} from "./codefacts.js";

/** Build a grounding context from a workspace. Cheap; safe on non-code workspaces (empty KB). */
export function buildGrounding(workspace, { maxFiles = 600, onProgress } = {}) {
  const db = new Datalog();
  let stats = { files: 0 };
  let factIndex = null;
  try {
    const extracted = extractCodeFacts(db, workspace, { onProgress });
    ({ index: factIndex, ...stats } = extracted);
    if (stats.files > maxFiles) stats.capped = true; // extracted anyway; just note it
  } catch { /* non-code or unreadable workspace -> empty KB, grounding is a no-op */ }
  // Separate from the JS/TS fact-index revision: the repository mapper also
  // understands Go/Python and reads package.json executable metadata.
  return { db, workspace, stats, factIndex, maxFiles, staleFiles: new Set(), mapRevision: 0 };
}

/** Mark analyzed source facts stale after successful workspace edits. */
/**
 * Bring a session-persistent KB back in line with the workspace by diff, not
 * demolition. Chat rebuilt the ENTIRE index after every request (operator
 * report, 2026-08-18): the request loop passed `grounding: true` each time,
 * so the KB was discarded and rebuilt while the person sat waiting. This
 * stat-scans the indexed tree (cheap), refreshes only changed/new files and
 * drops deleted ones, and stamps what it saw for the next reconcile.
 */
export function reconcileGrounding(ground, { statFile = (p) => fs.statSync(p) } = {}) {
  if (!ground?.workspace || !ground?.factIndex?.records) return { ok: false, changed: [] };
  const t0 = Date.now();
  const root = ground.factIndex.root ?? path.resolve(ground.workspace);
  const exts = ground.factIndex.exts;
  const stamps = ground.fileStamps instanceof Map ? ground.fileStamps : new Map();
  const seen = new Set();
  const changed = [];
  for (const file of walkSourceFiles(root, exts)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    seen.add(rel);
    let st;
    try { st = statFile(file); } catch { continue; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const known = stamps.get(rel);
    const indexed = ground.factIndex.records.has(rel);
    if (known !== stamp || !indexed) {
      if (known !== undefined || !indexed) changed.push(rel);
      stamps.set(rel, stamp);
    }
  }
  for (const rel of [...ground.factIndex.records.keys()]) {
    if (!seen.has(rel)) { changed.push(rel); stamps.delete(rel); }
  }
  ground.fileStamps = stamps;
  if (changed.length) refreshGrounding(ground, changed);
  return { ok: true, changed, ms: Date.now() - t0 };
}

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

// ---------------------------------------------------------------------------
// Persistent KB cache (operator order, 2026-08-19): the ingested index is a
// project artifact, saved under <workspace>/.bantam/ and restored at the next
// session. Staleness is not a special case — the load path stat-walks the
// tree against the saved mtimeMs:size stamps and reconciles the diff, so a
// folder edited after the save simply refreshes the changed files. A moved
// root or a newer schema invalidates the cache entirely (rebuild beats
// misread). Saves are atomic (tmp + rename) and best-effort: a failed save
// costs a rebuild next session, never a broken one.
const KB_CACHE_VERSION = 1;

export function kbCachePath(workspace) {
  return path.join(workspace, ".bantam", "kb-cache.json");
}

function stampTree(ground) {
  const root = ground.factIndex?.root ?? path.resolve(ground.workspace);
  const stamps = [];
  for (const file of walkSourceFiles(root, ground.factIndex?.exts)) {
    try {
      const st = fs.statSync(file);
      stamps.push([path.relative(root, file).split(path.sep).join("/"), `${st.mtimeMs}:${st.size}`]);
    } catch { /* raced deletion */ }
  }
  return stamps;
}

export function saveGroundingCache(ground, { file } = {}) {
  if (!ground?.db?.snapshot || !ground?.factIndex) return false;
  const target = file ?? kbCachePath(ground.workspace);
  try {
    const stamps = ground.fileStamps instanceof Map && ground.fileStamps.size
      ? [...ground.fileStamps.entries()]
      : stampTree(ground);
    const payload = JSON.stringify({
      version: KB_CACHE_VERSION,
      root: ground.factIndex.root ?? path.resolve(ground.workspace),
      savedAt: new Date().toISOString(),
      stats: ground.stats ?? {},
      factIndex: {
        ...ground.factIndex,
        // Maps flatten to {} under JSON — records must travel as entries.
        records: ground.factIndex.records instanceof Map ? [...ground.factIndex.records.entries()] : ground.factIndex.records,
      },
      fileStamps: stamps,
      dbSnapshot: ground.db.snapshot(),
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + ".tmp", payload);
    fs.renameSync(target + ".tmp", target);
    return true;
  } catch { return false; }
}

export function loadGroundingCache(workspace, { file } = {}) {
  const target = file ?? kbCachePath(workspace);
  let d;
  try { d = JSON.parse(fs.readFileSync(target, "utf8")); } catch { return null; }
  if (d?.version !== KB_CACHE_VERSION) return null;
  if (d.root !== path.resolve(workspace)) return null; // the folder moved — rebuild
  try {
    // installRules: a restored KB is not a museum piece — reconcile will
    // re-extract changed files, and their derived facts need the rules live.
    const db = Datalog.fromSnapshot(d.dbSnapshot, { installRules: true });
    return {
      db,
      workspace,
      stats: d.stats ?? {},
      factIndex: { ...d.factIndex, records: new Map(d.factIndex?.records ?? []) },
      maxFiles: 600,
      staleFiles: new Set(),
      mapRevision: 0,
      fileStamps: new Map(d.fileStamps ?? []),
      restoredFrom: target,
    };
  } catch { return null; }
}
