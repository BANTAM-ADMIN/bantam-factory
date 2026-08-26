// kb-map.js — a `map` tool answered from the code KB, for checkouts without the
// repo_map extractor.
//
// 2026-08-24 tour run: shouldSeedRepositoryBrief("take a look at your codebase")
// was true, the brief needed `map`, `map` needed ./repo_map or ../repo_map, and
// neither existed. The station built for the request was dark, silently, and
// the model walked nine directories by hand. The KB already holds every indexed
// file, the dependency graph and the entrypoints; package.json and README hold
// the rest. This tool answers `brief` and `arch` from those and advertises
// nothing it cannot answer — no callers/impact/reach, which need the extractor.

import fs from "node:fs";
import path from "node:path";

import { dispatchBranches, formatDispatch } from "./dispatch-scan.js";

const BRIEF_MAX_CHARS = 3000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function firstParagraph(file, max = 240) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  const title = (lines.find((l) => /^#\s+/.test(l)) ?? "").replace(/^#\s+/, "").trim();
  const body = [];
  let seenTitle = !title;
  for (const line of lines) {
    if (!seenTitle) { if (/^#\s+/.test(line)) seenTitle = true; continue; }
    if (/^#/.test(line)) { if (body.length) break; continue; }
    if (!line.trim()) { if (body.length) break; continue; }
    body.push(line.trim());
  }
  const para = body.join(" ").replace(/\s+/g, " ");
  const clipped = para.length > max ? `${para.slice(0, max - 1)}…` : para;
  return [title, clipped].filter(Boolean).join(": ");
}

function indexedFiles(ground) {
  const paths = ground?.stats?.filePaths;
  return Array.isArray(paths) ? paths : [];
}

/** Top-level directories ranked by indexed source files, with their extension mix. */
function layout(ground, { max = 10 } = {}) {
  const byDir = new Map();
  for (const rel of indexedFiles(ground)) {
    const slash = rel.indexOf("/");
    const dir = slash === -1 ? "." : `${rel.slice(0, slash)}/`;
    const ext = path.extname(rel).slice(1) || "?";
    const entry = byDir.get(dir) ?? { files: 0, exts: new Map() };
    entry.files += 1;
    entry.exts.set(ext, (entry.exts.get(ext) ?? 0) + 1);
    byDir.set(dir, entry);
  }
  const rows = [...byDir.entries()].sort((a, b) => b[1].files - a[1].files);
  const lines = rows.slice(0, max).map(([dir, e]) => {
    const exts = [...e.exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x]) => x).join(", ");
    return `  ${dir} — ${e.files} file${e.files === 1 ? "" : "s"} (${exts})`;
  });
  const rest = rows.length - Math.min(rows.length, max);
  if (rest > 0) lines.push(`  … +${rest} more top-level director${rest === 1 ? "y" : "ies"}`);
  return lines;
}

function declaredEntrypoints(pkg) {
  const out = [];
  if (pkg?.bin && typeof pkg.bin === "object") {
    for (const [name, file] of Object.entries(pkg.bin)) out.push({ name, file: String(file).replace(/^\.\//, "") });
  } else if (typeof pkg?.bin === "string") {
    out.push({ name: pkg.name ?? "bin", file: pkg.bin.replace(/^\.\//, "") });
  }
  if (typeof pkg?.main === "string") out.push({ name: "main", file: pkg.main.replace(/^\.\//, "") });
  return out;
}

function commands(pkg, { max = 5 } = {}) {
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? Object.entries(pkg.scripts) : [];
  const preferred = ["test", "start", "build", "dev", "lint"];
  const ordered = [
    ...preferred.filter((k) => scripts.some(([n]) => n === k)).map((k) => scripts.find(([n]) => n === k)),
    ...scripts.filter(([n]) => !preferred.includes(n)),
  ];
  return ordered.slice(0, max).map(([name, cmd]) => `  npm ${name === "test" || name === "start" ? name : `run ${name}`} → ${String(cmd).slice(0, 100)}`);
}

function readFirst(workspace) {
  const lines = [];
  for (const name of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
    const summary = firstParagraph(path.join(workspace, name));
    if (summary) lines.push(`  ${name} — ${summary}`);
  }
  try {
    const docs = fs.readdirSync(path.join(workspace, "docs")).filter((n) => /handbook|architecture|overview|readme/i.test(n) && n.endsWith(".md")).slice(0, 3);
    if (docs.length) lines.push(`  docs/ — ${docs.join(", ")}`);
  } catch { /* no docs dir */ }
  return lines;
}

function mostDepended(ground, { max = 10 } = {}) {
  const indegree = new Map();
  let edges;
  try { edges = ground.db.query("depends", "?", "?"); } catch { edges = []; }
  for (const [, dependency] of edges) indegree.set(dependency, (indegree.get(dependency) ?? 0) + 1);
  return [...indegree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max)
    .map(([file, n]) => `  ${file} (${n} dependent${n === 1 ? "" : "s"})`);
}

function dispatchOf(workspace, entry) {
  if (!entry) return null;
  let source;
  try { source = fs.readFileSync(path.join(workspace, entry.file), "utf8"); } catch { return null; }
  const branches = dispatchBranches(source);
  return branches.length
    ? `  ${formatDispatch(entry.file, branches)}`
    : `  no top-level command dispatch found in ${entry.file} (it may dispatch through a table or router)`;
}

function clip(text) {
  return text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS - 20)}\n… [brief clipped]` : text;
}

function header(ground, pkg) {
  const n = indexedFiles(ground).length || ground?.stats?.files || 0;
  const name = pkg?.name ? `${pkg.name}${pkg.description ? ` — ${String(pkg.description).slice(0, 160)}` : ""}` : path.basename(ground.workspace);
  return [`# Repository brief — from the code KB (${n} indexed source files; no repo_map extractor installed)`, name];
}

export function briefAnswer(ground) {
  const pkg = readJson(path.join(ground.workspace, "package.json"));
  const entries = declaredEntrypoints(pkg);
  const lines = [
    ...header(ground, pkg),
    "Layout (indexed source files per top-level directory):",
    ...layout(ground),
  ];
  if (entries.length) {
    lines.push("Entrypoints (declared in package.json):");
    for (const e of entries) lines.push(`  ${e.name} → ${e.file}`);
    const dispatch = dispatchOf(ground.workspace, entries[0]);
    if (dispatch) lines.push(dispatch);
  }
  const cmds = commands(pkg);
  if (cmds.length) lines.push("Commands:", ...cmds);
  const docs = readFirst(ground.workspace);
  if (docs.length) lines.push("Read first:", ...docs);
  lines.push("Use `map arch` for dispatch order and the most-depended modules; the `code` tool answers `flow <file>`, `deps <file>`, `symbols <file>`.");
  return clip(lines.join("\n"));
}

export function archAnswer(ground) {
  const pkg = readJson(path.join(ground.workspace, "package.json"));
  const entries = declaredEntrypoints(pkg);
  const lines = [...header(ground, pkg).slice(0, 1).map((h) => h.replace("Repository brief", "Architecture")), "Entrypoints (declared in package.json):"];
  if (entries.length) {
    for (const e of entries) {
      lines.push(`  ${e.name} → ${e.file}`);
      const dispatch = dispatchOf(ground.workspace, e);
      if (dispatch) lines.push(dispatch);
    }
  } else {
    lines.push("  none declared — `code entrypoints` lists executable files the KB found");
  }
  const hubs = mostDepended(ground);
  lines.push("Most-depended modules (in-degree of the import graph):", ...(hubs.length ? hubs : ["  no resolved imports yet"]));
  lines.push("Layout (indexed source files per top-level directory):", ...layout(ground, { max: 12 }));
  return clip(lines.join("\n"));
}

/** The `map` tool for a checkout without the repo_map extractor. */
export function kbMapTool(ground) {
  return {
    name: "map",
    verbs: ["brief", "arch"],
    description: "repository overview from the code KB (no repo_map extractor installed, so no symbol-level call graph) — `brief` (package, layout, declared entrypoints, commands, read-first docs) | `arch` (dispatch order of each entrypoint, most-depended modules, layout). Reach for `brief` FIRST on an unfamiliar codebase instead of listing directories.",
    answer(query) {
      const verb = String(query ?? "").trim().split(/\s+/)[0] ?? "";
      if (verb === "brief") return briefAnswer(ground);
      if (verb === "arch") return archAnswer(ground);
      return `unknown map query "${verb}". Try: brief | arch`;
    },
  };
}
