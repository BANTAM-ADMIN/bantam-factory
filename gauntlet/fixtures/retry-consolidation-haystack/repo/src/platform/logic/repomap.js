// The `map` tool — a symbolic code-structure surface, richer than the file-level `code` datalog.
// Where `code` answers exists/defines/deps at FILE granularity, `map` answers at SYMBOL + call-graph
// granularity: callers of a function, the blast radius of editing a file, what an entrypoint exercises,
// and a whole-repo brief. It delegates to the standalone repo_map/ extractor+query, which resolves JS
// cross-module imports exactly and Go/Python call graphs syntactically (direct + package-qualified +
// method-by-name); it degrades to structure-only on dynamic dispatch. An exact go/types Go extractor
// exists in EXPERIMENTAL/repo_map but is NOT what this tool runs (the shipped extract.go is go/ast,
// //go:build !types). Registered through the same {name,description,verbs,answer} contract.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export function repoMapCandidates(moduleDir = HERE) {
  return {
    bundledDir: path.resolve(moduleDir, "../../repo_map"),
    siblingDir: path.resolve(moduleDir, "../../../repo_map"),
  };
}
const { bundledDir: BUNDLED_RM, siblingDir: SIBLING_RM } = repoMapCandidates();
// The development checkout keeps the extractor beside BANTAMBUILD:
//   BANTAM/repo_map
//   BANTAM/BANTAMBUILD/src/logic/repomap.js
// Keep this fallback exact rather than searching ancestors for an arbitrary
// directory named repo_map.
const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next", "vendor"]);
const DEFAULT_IGNORED_SCOPES = [".bantam"];
const TEMP_ARTIFACT_DIRS = new Set();
let tempCleanupInstalled = false;
// BANTAM itself keeps full historical/benchmark repositories below these
// directories. They are provenance archives, not current source. Keep these
// project-specific names out of the universal defaults: an ordinary user's
// `fixtures/` or `candidate/` directory may be real production code.
const BANTAM_IGNORED_SCOPES = [
  "comparison/runs",
  "comparison/tasks",
  "comparison/candidates",
  "comparison/worktrees",
  "worktrees",
  ".worktrees",
  "fixtures",
];

function isBantamWorkspace(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return pkg?.name === "bantam" && fs.existsSync(path.join(root, "comparison"));
  } catch { return false; }
}

function ignoredScopes(root) {
  const extra = String(process.env.BANTAM_REPOMAP_IGNORE || "")
    .split(",")
    .map((s) => s.trim().replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, ""))
    .filter(Boolean);
  const project = isBantamWorkspace(root) ? BANTAM_IGNORED_SCOPES : [];
  return [...new Set([...DEFAULT_IGNORED_SCOPES, ...project, ...extra])];
}

function ignoredRelative(root, rel) {
  const posix = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return ignoredScopes(root).some((scope) => posix === scope || posix.startsWith(`${scope}/`));
}

const EXEC_ENV = (workspace) => ({
  ...process.env,
  PATH: `${process.env.PATH || ""}:/usr/local/go/bin`,
  BANTAM_REPOMAP_IGNORE: ignoredScopes(workspace).join(","),
});

function countLangs(root, maxFiles = 4000) {
  const c = { go: 0, py: 0, js: 0 };
  let scanned = 0;
  root = path.resolve(root);
  const stack = [root];
  while (stack.length && scanned < maxFiles) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // readdir order is filesystem-dependent; sorting makes maxFiles sampling stable.
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = ents.length - 1; i >= 0; i -= 1) {
      const e = ents[i];
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        const nestedRepo = full !== root && fs.existsSync(path.join(full, ".git"));
        if (!SKIP.has(e.name) && !e.name.startsWith(".") && !ignoredRelative(root, rel) && !nestedRepo) stack.push(full);
      }
      else {
        scanned += 1;
        let lang = null;
        if (e.name.endsWith(".go")) lang = "go";
        else if (e.name.endsWith(".py")) lang = "py";
        else if (/\.(?:js|cjs|mjs)$/.test(e.name)) lang = "js";
        if (lang) {
          c[lang] += 1;
        }
        if (scanned >= maxFiles) break;
      }
    }
  }
  return c;
}

// Cheap live revision for the lazy map cache. Grounding can refresh after an
// edit while the query registry (and its map tool) stays alive; a forever-cached
// artifact would then answer from pre-edit structure. Stat metadata keeps the
// check much cheaper than extraction while working in ordinary repos and in
// materialized lane workspaces that have no useful Git diff.
function sourceRevision(root, maxFiles = 4000) {
  root = path.resolve(root);
  const stack = [root];
  let scanned = 0;
  let hash = 2166136261;
  const mix = (value) => {
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  };
  while (stack.length && scanned < maxFiles) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = ents.length - 1; i >= 0; i -= 1) {
      const e = ents[i];
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        const nestedRepo = full !== root && fs.existsSync(path.join(full, ".git"));
        if (!SKIP.has(e.name) && !e.name.startsWith(".") && !ignoredRelative(root, rel) && !nestedRepo) stack.push(full);
        continue;
      }
      if (!/\.(?:go|py|js|cjs|mjs)$/.test(e.name) && rel !== "package.json") continue;
      scanned += 1;
      try {
        const stat = fs.statSync(full);
        mix(`${rel.replace(/\\/g, "/")}\0${stat.size}\0${stat.mtimeMs}\0`);
      } catch { mix(`${rel}\0missing\0`); }
      if (scanned >= maxFiles) break;
    }
  }
  return `${scanned}:${hash >>> 0}`;
}

function pickExtractor(counts) {
  if (counts.go >= counts.py && counts.go >= counts.js && counts.go > 0) return { cmd: "go", args: ["run", ".", "@ws@"] };
  if (counts.py >= counts.js && counts.py > 0) return { cmd: "python3", args: ["extract_py.py", "@ws@"] };
  if (counts.js > 0) return { cmd: "node", args: ["extract_js.cjs", "@ws@"] };
  return null;
}

function regularFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function validRepoMapDir(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  try {
    const real = fs.realpathSync(path.resolve(candidate));
    if (!fs.statSync(real).isDirectory()) return null;
    if (!regularFile(path.join(real, "query.py"))) return null;
    return real;
  } catch {
    return null;
  }
}

function secureArtifactPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-map-"));
  fs.chmodSync(dir, 0o700);
  TEMP_ARTIFACT_DIRS.add(dir);
  if (!tempCleanupInstalled) {
    tempCleanupInstalled = true;
    process.once("exit", () => {
      for (const artifactDir of TEMP_ARTIFACT_DIRS) {
        try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch { /* process exit */ }
      }
      TEMP_ARTIFACT_DIRS.clear();
    });
  }
  return path.join(dir, "structure.json");
}

function removeArtifact(file) {
  if (!file) return;
  const dir = path.dirname(file);
  if (!TEMP_ARTIFACT_DIRS.has(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { return; }
  TEMP_ARTIFACT_DIRS.delete(dir);
}

/**
 * Resolve the standalone repo_map implementation once for both registration
 * and execution. An explicit directory (or BANTAM_REPOMAP_DIR) is
 * authoritative: an invalid override disables the map instead of silently
 * running a different extractor. Without an override, use the bundled copy
 * when present, otherwise the exact sibling used by the development checkout.
 */
export function resolveRepoMapDir(
  explicitDir = undefined,
  {
    bundledDir = BUNDLED_RM,
    siblingDir = SIBLING_RM,
  } = {},
) {
  const configured = explicitDir === undefined
    ? process.env.BANTAM_REPOMAP_DIR
    : explicitDir;
  if (configured !== undefined && String(configured).trim()) {
    return validRepoMapDir(String(configured));
  }
  if (fs.existsSync(bundledDir)) return validRepoMapDir(bundledDir);
  return validRepoMapDir(siblingDir);
}

function extractorAvailable(rmDir, extractor) {
  if (!rmDir || !extractor) return false;
  if (extractor.cmd === "node") return regularFile(path.join(rmDir, "extract_js.cjs"));
  if (extractor.cmd === "python3") return regularFile(path.join(rmDir, "extract_py.py"));
  if (extractor.cmd === "go") {
    return regularFile(path.join(rmDir, "go.mod"))
      && regularFile(path.join(rmDir, "extract.go"));
  }
  return false;
}

/** Cheap check: is this a codebase worth mapping? Gates registration — the map earns its keep on
 *  real repos, not tiny workspaces you'd just read (this also keeps trivial fixtures uncluttered).
 *  Tune the floor with BANTAM_MAP_MIN_FILES. */
export function mapUsable(workspace, rmDir = undefined) {
  const resolved = resolveRepoMapDir(rmDir);
  if (!resolved) return false;
  const min = Number(process.env.BANTAM_MAP_MIN_FILES) || 5;
  const c = countLangs(workspace, 400);
  const extractor = pickExtractor(c);
  return c.go + c.py + c.js >= min
    && extractorAvailable(resolved, extractor);
}

/** Source-file count (go/py/js) for repo-scaled budgets — the same walk the
 *  map floor uses, exported so the agent loop can size recon allowances. */
export function sourceFileCount(workspace, maxFiles = 400) {
  const c = countLangs(workspace, maxFiles);
  return c.go + c.py + c.js;
}

const VERBS = { brief: "brief", arch: "arch", flow: "flow", callers: "explain", impact: "impact", reach: "reach", explain: "explain" };

function normalizeImpactPath(workspace, raw) {
  let value = String(raw || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/:\d+(?::\d+)?$/, "");
  // `/app` is the model-facing workspace root used by the file tools.
  if (value === "/app") value = ".";
  else if (value.startsWith("/app/")) value = value.slice(5);

  let rootReal = workspace;
  try { rootReal = fs.realpathSync(workspace); } catch { /* path.resolve fallback */ }
  let candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspace, value || ".");
  try { candidate = fs.realpathSync(candidate); } catch { /* nonexistent substrings remain lexical */ }
  const rel = path.relative(rootReal, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return (rel || ".").split(path.sep).join("/");
}

export function mapTool(workspace, opts = {}) {
  workspace = path.resolve(workspace);           // extractor runs from rmDir, so the path must be absolute
  const rmDir = resolveRepoMapDir(opts.rmDir);
  let artifact = null, artifactRevision = null, attemptedRevision = null, buildErr = null;
  const answerCache = new Map();

  function build() {
    const counts = countLangs(workspace);
    const ex = pickExtractor(counts);
    if (!ex) throw new Error("no Go/Python/JS source to map in this workspace");
    if (!rmDir || !extractorAvailable(rmDir, ex)) {
      throw new Error("repo_map extractor directory is unavailable or invalid");
    }
    const out = secureArtifactPath();
    const args = ex.args.map((a) => (a === "@ws@" ? workspace : a));
    try {
      const json = execFileSync(ex.cmd, args, { cwd: rmDir, env: EXEC_ENV(workspace), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024, timeout: 90000 });
      fs.writeFileSync(out, json, { mode: 0o600, flag: "wx" });
      return out;
    } catch (error) {
      removeArtifact(out);
      throw error;
    }
  }

  function refreshArtifact() {
    let revision = null;
    if (typeof opts.revision === "function") {
      try {
        const supplied = opts.revision();
        if (supplied !== undefined && supplied !== null) revision = `external:${String(supplied)}`;
      } catch { /* fall back to the self-contained workspace fingerprint */ }
    }
    if (revision === null) revision = `workspace:${sourceRevision(workspace)}`;
    if (artifact && artifactRevision === revision) return;
    if (!artifact && buildErr && attemptedRevision === revision) return;
    attemptedRevision = revision;
    const previous = artifact;
    try {
      const next = build();
      artifact = next;
      artifactRevision = revision;
      buildErr = null;
      answerCache.clear();
      if (previous && previous !== next) {
        removeArtifact(previous);
      }
    } catch (error) {
      artifact = null;
      artifactRevision = null;
      buildErr = error;
      answerCache.clear();
    }
  }

  return {
    name: "map",
    description: "understand a whole repo in ONE call, instead of reading files to learn structure — `brief` (repo + executable startup flow) | `arch` (modules, entrypoints, startup/dispatch order) | `flow <file>` (ordered top-level execution) | `impact <file>` | `callers <symbol>` | `reach <symbol>` | `explain <symbol>`. Reach for `brief`/`arch` FIRST on an unfamiliar codebase.",
    verbs: Object.keys(VERBS),
    answer(q) {
      const s = String(q ?? "").trim();
      const sp = s.indexOf(" ");
      const verb = (sp === -1 ? s : s.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? "" : s.slice(sp + 1).trim();
      const cmd = VERBS[verb];
      if (!cmd) return `unknown map query "${verb}". Try: brief | arch | flow <file> | callers <sym> | impact <file> | reach <sym> | explain <sym>`;
      if (!arg && (verb === "callers" || verb === "explain" || verb === "impact" || verb === "reach" || verb === "flow"))
        return `usage: ${verb} <${verb === "impact" || verb === "flow" ? "file" : "symbol"}>`;
      const pathQuery = verb === "impact" || verb === "flow";
      const queryArg = pathQuery ? normalizeImpactPath(workspace, arg) : arg;
      if (pathQuery && queryArg == null) return `[map] path outside workspace: ${arg}`;
      refreshArtifact();
      if (buildErr) return `[map] unavailable: ${buildErr.message}`;
      const cacheKey = `${cmd}\0${queryArg}`;
      if (answerCache.has(cacheKey)) return answerCache.get(cacheKey);
      try {
        const qargs = ["query.py", cmd];
        if (queryArg) qargs.push(queryArg);
        const out = execFileSync("python3", qargs, { cwd: rmDir, env: { ...EXEC_ENV(workspace), STRUCT: artifact }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
        const t = out.trim();
        const answer = t.length > 6000 ? `${t.slice(0, 6000)}\n… [clipped]` : (t || "(no result)");
        answerCache.set(cacheKey, answer);
        return answer;
      } catch (e) {
        return `[map] error: ${String(e.stderr || e.message || "").trim().slice(0, 300)}`;
      }
    },
    dispose() {
      removeArtifact(artifact);
      artifact = null;
      artifactRevision = null;
      attemptedRevision = null;
      buildErr = null;
      answerCache.clear();
    },
  };
}
