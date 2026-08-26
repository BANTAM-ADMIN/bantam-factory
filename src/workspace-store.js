// Content-addressed workspace checkpoints backed by Git plumbing.
//
// The store is deliberately separate from the user's repository. We hash raw
// bytes ourselves and populate a temporary index with cacheinfo, so repository
// hooks, clean filters, and the user's staging area never run or change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FALLBACK_EXCLUDES = new Set([".git", ".bantam", "node_modules"]);

export class WorkspaceStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.gitDir = path.join(this.root, "store.git");
    if (!fs.existsSync(this.gitDir)) {
      fs.mkdirSync(this.root, { recursive: true });
      git(["init", "--bare", "--quiet", this.gitDir]);
    }
  }

  capture(workspace, {
    parent = null,
    laneId = null,
    message = "BANTAM workspace checkpoint",
    excludePaths = [],
  } = {}) {
    const base = path.resolve(workspace);
    const snapshot = this.treeForWorkspace(base, {
      excludePaths,
      baselineCommit: parent,
    });
    const args = ["commit-tree", snapshot.tree, "-m", String(message)];
    if (parent) args.splice(2, 0, "-p", String(parent));
    const commit = gitStore(this.gitDir, args, { identity: true }).trim();
    if (laneId) {
      const lane = validateLaneId(laneId);
      gitStore(this.gitDir, ["update-ref", `refs/bantam/lanes/${lane}`, commit]);
    }
    return { commit, tree: snapshot.tree, files: snapshot.files };
  }

  treeForWorkspace(workspace, { excludePaths = [], baselineCommit = null } = {}) {
    const base = path.resolve(workspace);
    const files = listWorkspaceFiles(base, {
      excludePaths: [this.root, ...excludePaths],
      gitDir: this.gitDir,
      baselineCommit,
    });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-index-"));
    const index = path.join(temp, "index");
    try {
      gitStore(this.gitDir, ["read-tree", "--empty"], { index });
      const entries = [];
      for (const rel of files) {
        const full = safeJoin(base, rel);
        let stat;
        try { stat = fs.lstatSync(full); } catch { continue; }
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        const bytes = stat.isSymbolicLink()
          ? Buffer.from(fs.readlinkSync(full), "utf8")
          : fs.readFileSync(full);
        const oid = gitStore(this.gitDir, ["hash-object", "-w", "--stdin"], { input: bytes }).trim();
        const mode = stat.isSymbolicLink() ? "120000" : ((stat.mode & 0o111) ? "100755" : "100644");
        entries.push(`${mode} ${oid}\t${rel}\0`);
      }
      if (entries.length) {
        gitStore(this.gitDir, ["update-index", "-z", "--index-info"], {
          index,
          input: Buffer.from(entries.join(""), "utf8"),
        });
      }
      const tree = gitStore(this.gitDir, ["write-tree"], { index }).trim();
      return { tree, files: entries.length };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  materialize(commit, destination) {
    const target = path.resolve(destination);
    rejectSymlinkComponents(target);
    let existing = null;
    try { existing = fs.lstatSync(target); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink()) {
      throw new Error(`materialize destination is a symbolic link: ${target}`);
    }
    if (existing && !existing.isDirectory()) {
      throw new Error(`materialize destination is not a directory: ${target}`);
    }
    if (existing && fs.readdirSync(target).length) {
      throw new Error(`materialize destination is not empty: ${target}`);
    }
    const tree = this.treeOf(commit);
    fs.mkdirSync(target, { recursive: true });
    const raw = gitStore(this.gitDir, ["ls-tree", "-r", "-z", String(commit)], { encoding: "buffer" });
    for (const record of splitNul(raw)) {
      const tab = record.indexOf(0x09);
      if (tab === -1) throw new Error("invalid git tree record");
      const header = record.subarray(0, tab).toString("utf8");
      const rel = record.subarray(tab + 1).toString("utf8");
      const [mode, type, oid] = header.split(" ");
      if (type !== "blob") continue;
      const full = safeJoin(target, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const bytes = gitStore(this.gitDir, ["cat-file", "blob", oid], { encoding: "buffer" });
      if (mode === "120000") fs.symlinkSync(bytes.toString("utf8"), full);
      else {
        fs.writeFileSync(full, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
        fs.chmodSync(full, mode === "100755" ? 0o755 : 0o644);
      }
    }
    return { commit: String(commit), tree, destination: target };
  }

  treeOf(commit) {
    return gitStore(this.gitDir, ["rev-parse", `${commit}^{tree}`]).trim();
  }

  hasCommit(commit) {
    try {
      gitStore(this.gitDir, ["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

export function listWorkspaceFiles(workspace, {
  excludePaths = [],
  gitDir = null,
  baselineCommit = null,
} = {}) {
  const root = path.resolve(workspace);
  const excluded = exclusionPrefixes(root, excludePaths);
  if (excluded.includes("")) return [];
  // Materialized lanes intentionally have no .git pointer: exposing the
  // state store would let task commands mutate its history. Use the prior
  // immutable commit only as a temporary index so Git still knows which
  // files are tracked and can apply the workspace's .gitignore rules to new
  // logs, caches, and secrets.
  if (gitDir && baselineCommit) {
    try {
      return listWithExternalIndex(root, gitDir, baselineCommit, excluded);
    } catch { /* fall through to an ordinary repository or empty index */ }
  }
  try {
    // `git -C <workspace>` walks through ancestors. A standalone task
    // workspace nested below some unrelated repository (for example beneath
    // that repository's ignored `.bantam/` directory) must not inherit the
    // ancestor's tracked set or ignore rules. Doing so can silently capture an
    // empty baseline even though the requested workspace contains files.
    const repositoryRoot = git(["-C", root, "rev-parse", "--show-toplevel"]).trim();
    if (path.resolve(repositoryRoot) !== root) {
      if (gitDir) return listWithExternalIndex(root, gitDir, null, excluded);
      throw new Error("workspace is nested below a different repository root");
    }
    const raw = git(["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "buffer",
    });
    return splitNul(raw)
      .map((entry) => entry.toString("utf8"))
      .filter(Boolean)
      .filter((entry) => !isExcluded(entry, excluded))
      .sort();
  } catch {
    if (gitDir) {
      try { return listWithExternalIndex(root, gitDir, null, excluded); }
      catch { /* Git unavailable/corrupt: retain the conservative raw fallback */ }
    }
    const out = [];
    walkFallback(root, "", out, excluded);
    return out.sort();
  }
}

function listWithExternalIndex(root, gitDir, baselineCommit, excluded) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-list-index-"));
  const index = path.join(temp, "index");
  try {
    gitStore(gitDir, baselineCommit
      ? ["read-tree", String(baselineCommit)]
      : ["read-tree", "--empty"], { index });
    const raw = git([
      `--git-dir=${gitDir}`,
      `--work-tree=${root}`,
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], {
      encoding: "buffer",
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    return splitNul(raw)
      .map((entry) => entry.toString("utf8"))
      .filter(Boolean)
      .filter((entry) => !isExcluded(entry, excluded))
      .sort();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function exclusionPrefixes(root, values) {
  const prefixes = [];
  for (const value of values) {
    if (!value) continue;
    const absolute = path.resolve(root, String(value));
    const relative = path.relative(root, absolute);
    if (!relative) {
      prefixes.push("");
      continue;
    }
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    prefixes.push(relative.split(path.sep).join("/").replace(/\/$/, ""));
  }
  return [...new Set(prefixes)].sort();
}

function isExcluded(relativePath, prefixes) {
  const normalized = String(relativePath).split(path.sep).join("/").replace(/^\.\//, "");
  return prefixes.some((prefix) => !prefix || normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function walkFallback(root, rel, out, excluded = []) {
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (FALLBACK_EXCLUDES.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (isExcluded(child, excluded)) continue;
    if (entry.isDirectory()) walkFallback(root, child, out, excluded);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(child);
  }
}

function splitNul(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const out = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue;
    if (index > start) out.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

function safeJoin(root, rel) {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) throw new Error(`unsafe workspace path: ${rel}`);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error(`workspace path escapes root: ${rel}`);
  return full;
}

function rejectSymlinkComponents(destination) {
  let current = destination;
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`materialize destination has a symbolic link component: ${current}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateLaneId(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid lane id: ${id}`);
  return id;
}

function gitStore(gitDir, args, options = {}) {
  const env = {
    ...process.env,
    ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
    ...(options.identity ? {
      GIT_AUTHOR_NAME: "BANTAM",
      GIT_AUTHOR_EMAIL: "bantam@local",
      GIT_COMMITTER_NAME: "BANTAM",
      GIT_COMMITTER_EMAIL: "bantam@local",
    } : {}),
  };
  return git([`--git-dir=${gitDir}`, ...args], { ...options, env });
}

function git(args, { input = undefined, encoding = "utf8", env = process.env } = {}) {
  return execFileSync("git", args, {
    input,
    encoding,
    env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}
