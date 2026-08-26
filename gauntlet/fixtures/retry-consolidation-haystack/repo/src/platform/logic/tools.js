// Symbolic-tool registry — the on-demand query surface under the agent.
//
// The model poses a question; exact symbolic tools or deterministic ranked retrieval answer it. This is
// the "pull grounding on demand" fix (force-feeding the whole KB was net-negative), and it's a
// REGISTRY on purpose: today the only tool is `code` (CPU datalog). Tomorrow a GPU tensor-datalog,
// the superopt synth+proof engine, or an RT-core search engine register with the SAME shape —
// { name, description, answer(q) } — and the agent-facing interface never changes.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nearestFiles, affectedTests } from "./codefacts.js";
import { scopedVerifyPlan } from "./scoped-verify.js";
import { recordTurns, stateAsOf } from "./runlog.js";
import { mapTool, mapUsable, resolveRepoMapDir } from "./repomap.js";
import { conceptTool } from "./concept-search.js";
import { codexViewImageTool, describeImageWithCodex, detectVision, viewImageTool } from "./vision.js";
import {
  chromiumBinary,
  codexPreviewVisionEnabled,
  previewTool,
  taskAwarePreviewVisionEnabled,
} from "./preview.js";
import { codexImageEnabled, codexImageTool } from "./codex-image.js";

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.lastTool = null;            // name of the tool that handled the most recent answer()
    this.lastOutcome = null;         // normalized envelope for the most recent routed query
  }
  register(tool) { this.tools.set(tool.name, tool); return this; }
  get(name) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }
  dispose() {
    for (const tool of this.list()) {
      try { tool.dispose?.(); } catch { /* best-effort tool cleanup */ }
    }
  }
  /** One-line menu of every tool, for the prompt. */
  describe() { return this.list().map((t) => `  ${t.name}: ${t.description}`).join("\n"); }

  /** Verb -> tool name, for tools that declare `verbs`. First declaration wins. */
  _verbOwner(verb) {
    for (const t of this.list()) {
      if (t.verbs?.includes(verb)) return t.name;
    }
    return null;
  }

  _allVerbs() {
    return this.list().flatMap((t) => (t.verbs ?? []).map((v) => [v, t.name]));
  }

  /**
   * Answer a query.
   *
   * Routing, in order: an explicit `tool: rest` or bare `tool rest`; then a bare VERB owned by a
   * tool (`schema` -> sqlite, `actions shell` -> history); then the default tool, but only for its
   * own verbs; otherwise the menu.
   *
   * That last step exists because the model does not always type our tool names. A
   * wrong-but-plausible answer from the default tool stops the model from retrying; the menu
   * makes the available routed tools explicit.
   */
  answer(q, def = "code") {
    const s = String(q ?? "").trim();
    if (!s) return this._run(def, s);

    const colon = s.match(/^([A-Za-z_]\w*):\s*(.*)$/s);          // explicit `tool: rest`
    if (colon && this.tools.has(colon[1])) return this._run(colon[1], colon[2]);

    const sp = s.search(/\s/);                                    // bare `tool rest`
    const head = sp === -1 ? s : s.slice(0, sp);
    const rest = sp === -1 ? "" : s.slice(sp + 1).trim();
    if (head !== def && this.tools.has(head)) return this._run(head, rest);

    // Bare verb: the model typed the operation without the tool name.
    const owner = this._verbOwner(head);
    if (owner) return this._run(owner, s);

    // Take over the fallthrough only when the query could have gone somewhere else. With just the
    // default tool registered there is nothing to disambiguate, so its own long-standing
    // "unknown query" answer stands. Once another substrate is registered — the case that actually
    // failed live — an unclaimed query gets the menu instead of a confident answer from a tool the
    // model never asked.
    const verbs = this._allVerbs();
    if (!verbs.some(([, tool]) => tool !== def)) return this._run(def, s);

    if (this.get(def)?.verbs?.includes(head)) return this._run(def, s);
    return this._unrouted(s, head, verbs);
  }

  /** No tool claimed this. Say so, show the menu, and suggest the closest verb. */
  _unrouted(query, head, verbs) {
    this.lastTool = null;
    this.lastOutcome = normalizeToolOutcome({
      tool: null,
      answer: null,
      raw: {
        status: "failed",
        retryable: true,
        failures: [{ kind: "unrouted", reason: `no tool claimed query verb ${head}` }],
      },
    });
    const near = verbs
      .map(([v, tool]) => [editDistance(head.toLowerCase(), v), v, tool])
      .filter(([d, v]) => d <= Math.max(2, Math.floor(v.length / 3)))
      .sort((a, b) => a[0] - b[0])[0];
    const hint = near ? `\nDid you mean: ${near[2]} ${near[1]} ?` : "";
    return `[query] "${clipQuery(query)}" didn't match a tool. Available:\n${this.describe()}${hint}`;
  }

  _run(name, q) {
    this.lastTool = name;
    this.lastOutcome = null;
    const t = this.get(name);
    if (!t) return this._toolError(name, new Error(`no such tool "${name}"`));
    try {
      const answer = t.answer(q);
      if (answer && typeof answer.then === "function") {
        return answer.then(
          (value) => this._finish(name, t, value),
          (error) => this._toolError(name, error),
        );
      }
      return this._finish(name, t, answer);
    } catch (error) {
      return this._toolError(name, error);
    }
  }

  _finish(name, tool, answer) {
    const raw = tool.lastOutcome ?? (name === "preview" ? previewOutcome(tool.lastResult) : null);
    this.lastOutcome = normalizeToolOutcome({ tool: name, answer, raw });
    return answer;
  }

  _toolError(name, error) {
    const reason = String(error?.message ?? error).slice(0, 500);
    this.lastOutcome = normalizeToolOutcome({
      tool: name,
      answer: null,
      raw: {
        status: "error",
        retryable: error?.retryable ?? null,
        failures: [{
          kind: String(error?.code ?? "tool_error"),
          reason,
        }],
      },
    });
    return `[query] error: ${reason}`;
  }
}

const TOOL_STATUSES = new Set(["pass", "partial", "failed", "blocked", "error"]);

export function normalizeToolOutcome({ tool, answer, raw = null } = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const invalidStatus = raw && source.status !== undefined && !TOOL_STATUSES.has(source.status);
  let status = invalidStatus ? "error" : TOOL_STATUSES.has(source.status) ? source.status : "pass";
  if (!raw && /^\[[^\]]+\]\s+error:/i.test(String(answer ?? ""))) status = "error";
  const blocked = normalizeBlocked(source.blocked);
  if (blocked) status = "blocked";
  const standard = new Set([
    "status", "terminal", "retryable", "artifacts", "failures", "blocked",
    "usage", "proof",
  ]);
  const details = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !standard.has(key))
    .map(([key, value]) => [key, serializable(value)]));
  return {
    schema: 1,
    tool: typeof tool === "string" && tool ? tool : null,
    status,
    terminal: Boolean(source.terminal ?? blocked?.terminal),
    retryable: typeof source.retryable === "boolean" ? source.retryable : null,
    artifacts: [...new Set((Array.isArray(source.artifacts) ? source.artifacts : [])
      .filter((item) => typeof item === "string" && item.length > 0))],
    failures: [
      ...(invalidStatus
        ? [{ kind: "invalid_outcome_status", reason: `unsupported tool outcome status ${String(source.status)}` }]
        : []),
      ...normalizeFailures(source.failures),
    ],
    blocked,
    usage: source.usage && typeof source.usage === "object"
      ? serializable(source.usage)
      : null,
    proof: source.proof && typeof source.proof === "object"
      ? serializable(source.proof)
      : null,
    details,
  };
}

function previewOutcome(proof) {
  if (!proof || typeof proof !== "object") return null;
  return {
    status: proof.status === "pass" ? "pass" : "failed",
    retryable: true,
    proof,
    previewStatus: proof.status,
  };
}

function normalizeBlocked(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    terminal: Boolean(value.terminal),
    ecosystem: typeof value.ecosystem === "string" ? value.ecosystem : null,
    operation: typeof value.operation === "string" ? value.operation : null,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 1000) : null,
  };
}

function normalizeFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((failure) => {
    if (typeof failure === "string") return { kind: "failure", reason: failure.slice(0, 1000) };
    if (!failure || typeof failure !== "object") {
      return { kind: "failure", reason: String(failure).slice(0, 1000) };
    }
    return {
      kind: typeof failure.kind === "string" ? failure.kind : "failure",
      reason: String(failure.reason ?? failure.message ?? "tool failure").slice(0, 1000),
      ...(typeof failure.code === "string" ? { code: failure.code } : {}),
      ...(typeof failure.timeoutKind === "string" ? { timeoutKind: failure.timeoutKind } : {}),
    };
  });
}

function serializable(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return null; }
}

function clipQuery(s, n = 60) { return s.length <= n ? s : `${s.slice(0, n)}…`; }

/** Levenshtein, small inputs only (verb tokens). */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const SQLITE_SCAN_LIMIT = 80;
const SQLITE_SCAN_DEPTH = 4;
const SQLITE_SKIP_DIRS = new Set([
  ".git", ".bantam", "node_modules", "__pycache__", ".venv", "venv", "env", ".cache",
  "coverage", "dist", "build", "target", ".next",
]);
const SQLITE_FILE_RE = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i;
const SQLITE_BASE_RE = /\.(?:db|sqlite|sqlite3)$/i;

function clipText(s, max = 8000) {
  s = String(s ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n... [${s.length - max} chars clipped]`;
}

function statFile(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function resolveInside(workspace, requested) {
  const raw = String(requested ?? "").trim();
  if (!raw) throw new Error("missing path");
  const root = path.resolve(workspace);
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside workspace: ${raw}`);
  return { abs, rel: rel || "." };
}

function readPrefix(file, n = 64) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function walMagic(buf) {
  if (buf.length < 4) return "too short for WAL magic";
  const hex = `0x${buf.subarray(0, 4).toString("hex")}`;
  const known = hex === "0x377f0682" || hex === "0x377f0683";
  return `${hex}${known ? " (SQLite WAL magic)" : " (not standard SQLite WAL magic)"}`;
}

function describeWal(workspace, requested) {
  const target = resolveInside(workspace, requested);
  const walAbs = target.rel.endsWith("-wal") ? target.abs : `${target.abs}-wal`;
  const walRel = target.rel.endsWith("-wal") ? target.rel : `${target.rel}-wal`;
  const st = statFile(walAbs);
  if (!st?.isFile()) return `no WAL sidecar found at ${walRel}.`;
  const head = readPrefix(walAbs, 32);
  return [
    `${walRel}: ${st.size} bytes; magic ${walMagic(head)}.`,
    `first ${head.length} bytes: ${head.toString("hex")}`,
    "This inspected the raw WAL sidecar only; it did not open the SQLite database.",
    "For WAL-recovery tasks, copy/analyze the sidecar before running sqlite3 on the base database, because opening a corrupt or encrypted WAL can consume or remove it.",
  ].join("\n");
}

export function findSqliteFiles(workspace, { limit = SQLITE_SCAN_LIMIT, maxDepth = SQLITE_SCAN_DEPTH } = {}) {
  const root = path.resolve(workspace);
  const out = [];
  function walk(dir, depth) {
    if (out.length >= limit || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= limit) break;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (ent.isDirectory()) {
        if (!SQLITE_SKIP_DIRS.has(ent.name)) walk(abs, depth + 1);
      } else if (ent.isFile() && SQLITE_FILE_RE.test(ent.name)) {
        out.push(rel);
      }
    }
  }
  walk(root, 0);
  return out.sort();
}

function sqliteFileLine(workspace, rel) {
  const abs = path.resolve(workspace, rel);
  const st = statFile(abs);
  const size = st?.isFile() ? `${st.size} bytes` : "missing";
  if (rel.endsWith("-wal")) {
    const magic = st?.isFile() ? `; magic ${walMagic(readPrefix(abs, 4))}` : "";
    return `${rel} (${size}; WAL sidecar${magic})`;
  }
  if (!SQLITE_BASE_RE.test(rel)) return `${rel} (${size})`;
  const walRel = `${rel}-wal`;
  const walSt = statFile(path.resolve(workspace, walRel));
  return `${rel} (${size}${walSt?.isFile() ? `; WAL sidecar ${walRel} ${walSt.size} bytes` : ""})`;
}

function isReadOnlySql(sql) {
  let s = String(sql ?? "").trim().replace(/;+$/g, "").trim();
  if (!s) return false;
  if (s.includes(";")) return false;
  if (/^(?:select|with)\b/i.test(s)) return true;
  if (/^explain\s+query\s+plan\b/i.test(s)) return true;
  if (/^pragma\s+(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list|schema_version|page_count|page_size|integrity_check|quick_check)\b/i.test(s)) return true;
  return false;
}

function stripOuterSqlQuotes(sql) {
  const s = String(sql ?? "").trim();
  if (s.length < 2) return s;
  const q = s[0];
  if ((q === "\"" || q === "'") && s.at(-1) === q) {
    return s.slice(1, -1).replaceAll(`\\${q}`, q).trim();
  }
  return s;
}

function runSqliteCli(args, options = {}) {
  return execFileSync("sqlite3", args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * The `sqlite` tool - a safe SQLite/WAL probe for database recovery tasks.
 * `files` and `wal` never open the database; `schema`/`query` use sqlite3 read-only.
 */
export function sqliteTool(workspace, { runSqlite = runSqliteCli, scan = findSqliteFiles } = {}) {
  return {
    name: "sqlite",
    description: "inspect SQLite inputs safely - `files` | `tables <db>` | `wal <db>` (raw sidecar, no DB open) | `schema <db>` | `query <db> <read-only SQL>`",
    verbs: ["tables", "wal", "schema", "query"],
    answer(q) {
      try {
        const s = String(q ?? "").trim();
        const sp = s.indexOf(" ");
        const verb = (sp === -1 ? s : s.slice(0, sp)).toLowerCase() || "files";
        const arg = sp === -1 ? "" : s.slice(sp + 1).trim();
        switch (verb) {
          case "files": {
            const files = scan(workspace);
            if (!files.length) return "no SQLite database or WAL sidecar files found in this workspace.";
            const clipped = files.slice(0, SQLITE_SCAN_LIMIT).map((rel) => sqliteFileLine(workspace, rel));
            const more = files.length > clipped.length ? `\n... +${files.length - clipped.length} more` : "";
            return `SQLite files (${files.length}):\n${clipped.join("\n")}${more}\nIf the task is WAL recovery, inspect/copy the WAL sidecar before opening the base database with sqlite3.`;
          }
          case "wal": {
            if (!arg) return "usage: sqlite wal <db-or-wal-path>";
            return describeWal(workspace, arg);
          }
          case "tables": {
            if (!arg) return "usage: sqlite tables <db>";
            const db = resolveInside(workspace, arg);
            const st = statFile(db.abs);
            if (!st?.isFile()) return `no database file found at ${db.rel}.`;
            const out = runSqlite(["-readonly", "--", db.abs, ".tables"], { cwd: workspace }).trim();
            return `SQLite tables for ${db.rel}: ${out || "(none)"}`;
          }
          case "schema": {
            if (!arg) return "usage: sqlite schema <db>";
            const db = resolveInside(workspace, arg);
            const st = statFile(db.abs);
            if (!st?.isFile()) return `no database file found at ${db.rel}.`;
            const out = runSqlite(["-readonly", "--", db.abs, ".schema"], { cwd: workspace });
            return `SQLite schema for ${db.rel}:\n${clipText(out.trim() || "(empty schema)")}`;
          }
          case "query": {
            const gap = arg.search(/\s/);
            if (gap === -1) return "usage: sqlite query <db> <read-only SQL>";
            const dbArg = arg.slice(0, gap);
            const sql = stripOuterSqlQuotes(arg.slice(gap + 1));
            if (!isReadOnlySql(sql)) return "refusing to run SQL that is not a single read-only SELECT/WITH/EXPLAIN QUERY PLAN or metadata PRAGMA.";
            const db = resolveInside(workspace, dbArg);
            const st = statFile(db.abs);
            if (!st?.isFile()) return `no database file found at ${db.rel}.`;
            const out = runSqlite(["-readonly", "-json", "--", db.abs, sql], { cwd: workspace });
            return `SQLite query result for ${db.rel}:\n${clipText(out.trim() || "[]")}`;
          }
          default:
            return `unknown sqlite query "${verb}". Try: files | tables <db> | wal <db> | schema <db> | query <db> <read-only SQL>`;
        }
      } catch (e) {
        return `[sqlite] ${e.message}`;
      }
    },
  };
}

/**
 * The `code` tool — exact answers over the datalog KB (a grounding context from buildGrounding).
 * Verbs: exists | defines | symbols | entrypoints | deps | affects | files
 */
export function codeTool(ground) {
  return {
    name: "code",
    description: "ask the code KB — `entrypoints` | `exists <path>` | `defines <symbol>` | `symbols <file>` | `deps <file>` | `affects <file>` | `tests <file>` (which tests cover it + the scoped command) | `broken [file]` (relative imports that resolve to no file) | `files [substr]`",
    verbs: ["entrypoints", "exists", "defines", "symbols", "deps", "affects", "tests", "broken", "files"],
    answer(q) {
      const s = String(q).trim();
      const sp = s.indexOf(" ");
      const verb = (sp === -1 ? s : s.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? "" : s.slice(sp + 1).trim();
      if (verb === "exists") {
        if (!arg) return "usage: exists <path>";
        if (!ground?.workspace) return "the code KB is empty (this workspace has no analyzed source files).";
        const abs = path.isAbsolute(arg) ? arg : path.join(ground.workspace, arg);
        if (fileExists(abs)) return `yes — "${arg}" exists.`;
        const near = nearestFiles(ground.db, arg, 3);
        return `no — "${arg}" does not exist.${near.length ? ` Nearest real files: ${near.join(", ")}` : ""}`;
      }
      const staleFiles = [...(ground?.staleFiles ?? [])].sort();
      if (staleFiles.length && ["entrypoints", "defines", "symbols", "deps", "affects", "tests", "broken", "files"].includes(verb)) {
        const shown = staleFiles.slice(0, 8).join(", ");
        const more = staleFiles.length > 8 ? `, +${staleFiles.length - 8} more` : "";
        return `[code] Structural KB is stale after edits to: ${shown}${more}. It will not make structural claims from the pre-edit snapshot. Use read_file/search for current facts; live exists checks remain available.`;
      }
      if (!ground || ground.stats.files === 0) return "the code KB is empty (this workspace has no analyzed source files).";
      switch (verb) {
        case "defines": {
          if (!arg) return "usage: defines <symbol>";
          const files = ground.db.query("defines", "?", arg).map((r) => r[0]);
          return files.length ? `"${arg}" is defined in: ${files.join(", ")}` : `"${arg}" is not defined anywhere in the code KB.`;
        }
        case "symbols": {
          if (!arg) return "usage: symbols <file>";
          const syms = ground.db.query("defines", arg, "?").map((r) => r[1]);
          if (!syms.length) return `no definitions found in ${arg} (check the path with \`exists\`).`;
          const shown = syms.slice(0, 60);
          const more = syms.length > shown.length ? `, … +${syms.length - shown.length} more` : "";
          const entrypointHint = ground.db.has("entrypoint", arg)
            ? `\n${arg} is an executable entrypoint; ask \`flow ${arg}\` for its ordered top-level startup and command dispatch.`
            : "";
          return `${arg} defines (${syms.length}): ${shown.join(", ")}${more}${entrypointHint}`;
        }
        case "entrypoints": {
          const files = ground.db.query("entrypoint", "?").map((r) => r[0]).sort();
          return files.length
            ? `executable entrypoints (${files.length}): ${files.join(", ")}\nUse \`flow <file>\` to inspect startup and dispatch order.`
            : "no executable entrypoints were identified from package metadata or shebangs.";
        }
        case "deps": {
          if (!arg) return "usage: deps <file>";
          const d = ground.db.query("reaches", arg, "?").map((r) => r[1]).filter((f) => f !== arg).sort();
          return d.length ? `${arg} transitively depends on (${d.length}): ${d.join(", ")}` : `${arg} has no tracked dependencies.`;
        }
        case "affects": {
          if (!arg) return "usage: affects <file>";
          const a = ground.db.query("reaches", "?", arg).map((r) => r[0]).filter((f) => f !== arg).sort();
          return a.length ? `changing ${arg} affects (${a.length}): ${a.join(", ")}` : `nothing tracked depends on ${arg}.`;
        }
        case "tests": {
          if (!arg) return "usage: tests <file> — which tests exercise this file, and the scoped command to run only them";
          const plan = scopedVerifyPlan(ground.workspace, [arg], ground.db);
          if (plan) return `tests reaching ${arg} (${plan.tests.length}): ${plan.tests.join(", ")}\nrun just these: ${plan.command}`;
          const affected = affectedTests(ground.db, [arg]);
          if (affected.length) return `tests reaching ${arg} (${affected.length}): ${affected.join(", ")} — framework not auto-detected; run them with your project's test command.`;
          return `no tracked test reaches ${arg}; run the full test suite to be safe.`;
        }
        case "broken": {
          const rows = ground.db.query("unresolved", "?", "?").filter((r) => !arg || r[0] === arg);
          if (!rows.length) return arg ? `no broken relative imports in ${arg}.` : "no broken relative imports tracked.";
          return `broken relative imports (${rows.length}): ${rows.map((r) => `${r[0]} → ${r[1]}`).join(", ")}`;
        }
        case "files": {
          const all = ground.db.query("file", "?").map((r) => r[0]).filter((f) => !arg || f.includes(arg)).sort();
          return `files${arg ? ` matching "${arg}"` : ""} (${all.length}): ${all.slice(0, 60).join(", ")}${all.length > 60 ? " …" : ""}`;
        }
        default:
          return `unknown query "${verb}". Try: entrypoints | exists | defines | symbols | deps | affects | tests | broken | files`;
      }
    },
  };
}

/**
 * The `history` tool — exact answers about THIS run so far, from the EAVT run-log. `getTurns`
 * returns the live trajectory (so the answer is always current). This is the run-history query
 * surface: the model can ask what it has done instead of re-deriving it from the transcript.
 */
export function historyTool(getTurns) {
  return {
    name: "history",
    description: "ask about THIS run — `edits` (files changed so far) | `tests` (last test result) | `actions` (what you've done) | `at <turn>` (state as of a turn)",
    verbs: ["edits", "tests", "actions", "at"],
    answer(q) {
      const turns = (typeof getTurns === "function" ? getTurns() : getTurns) || [];
      const log = recordTurns(turns);
      const s = String(q).trim();
      const sp = s.indexOf(" ");
      const verb = (sp === -1 ? s : s.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? "" : s.slice(sp + 1).trim();
      switch (verb || "edits") {
        case "edits": {
          const st = stateAsOf(log, turns.length);
          return st.filesEdited.length ? `files edited this run (${st.filesEdited.length}): ${st.filesEdited.join(", ")}` : "no files edited yet this run.";
        }
        case "tests": {
          const st = stateAsOf(log, turns.length);
          return st.lastVerdict ? `last test verdict: ${st.lastVerdict.result} (turn ${st.lastVerdict.turn})` : "no test has been run yet this run.";
        }
        case "actions": {
          const counts = {};
          for (const d of log.datoms) if (d.a === "action") counts[d.v] = (counts[d.v] || 0) + 1;
          const parts = Object.entries(counts).map(([k, v]) => `${k}:${v}`);
          return parts.length ? `actions so far — ${parts.join(", ")} (${turns.length} turns)` : "no actions yet this run.";
        }
        case "at": {
          const t = parseInt(arg, 10);
          if (Number.isNaN(t)) return "usage: at <turn-number>";
          const st = stateAsOf(log, t);
          const repo = st.repositoryQuery ? `; retained repository query \`${st.repositoryQuery.query}\` from turn ${st.repositoryQuery.turn}` : "";
          return `as of turn ${t}: edited ${st.filesEdited.join(", ") || "nothing"}; last test verdict ${st.lastVerdict ? st.lastVerdict.result : "none"}${repo}.`;
        }
        default:
          return `unknown history query "${verb}". Try: edits | tests | actions | at <turn>`;
      }
    },
  };
}

/** Build a registry with the code tool wired to a grounding context. */
export function buildToolRegistry(ground, opts = {}) {
  const reg = new ToolRegistry().register(codeTool(ground));
  if (ground?.factIndex?.records instanceof Map && ground.factIndex.records.size) {
    reg.register(conceptTool(ground));
  }
  if (ground?.workspace && findSqliteFiles(ground.workspace, { limit: 1 }).length) {
    reg.register(sqliteTool(ground.workspace));
  }
  // The `map` tool: symbol-level call-graph queries via the repo_map extractor. Advertise it only
  // when the workspace has mappable source and the extractor is reachable (opt out with BANTAM_NO_MAP).
  const repoMapDir = resolveRepoMapDir();
  if (ground?.workspace && !process.env.BANTAM_NO_MAP
      && repoMapDir && mapUsable(ground.workspace, repoMapDir)) {
    reg.register(mapTool(ground.workspace, {
      // Bind execution to the same validated implementation that passed the
      // availability gate. Do not re-resolve a changed environment variable.
      rmDir: repoMapDir,
      // Grounding already refreshes changed source transactionally. Reuse its
      // monotonic revision so a retained live map is O(1) to validate each
      // turn instead of restatting the repository on every prompt assembly.
      revision: () => ground.mapRevision ?? ground.stats?.refreshes ?? 0,
    }));
  }
  // The `view_image` tool: only when the loaded model has a vision projector (mmproj). Opt out with
  // BANTAM_NO_VISION. Needs the endpoint, so it is threaded in from the run loop.
  const localVision = Boolean(
    ground?.workspace && opts.endpoint && !process.env.BANTAM_NO_VISION && detectVision(opts.endpoint),
  );
  const codexVision = Boolean(
    ground?.workspace && opts.codex && !process.env.BANTAM_NO_VISION,
  );
  if (codexVision) {
    reg.register(codexViewImageTool(ground.workspace, {
      model: opts.codexModel,
      effort: opts.codexEffort,
      onEvent: opts.onEvent,
      onExternalUsage: opts.onExternalUsage,
    }));
  } else if (localVision) {
    reg.register(viewImageTool(ground.workspace, opts.endpoint));
  }
  // The `preview` tool: eyes for web work — headless render + error capture (+ vision
  // description when available). Register it even before HTML exists: build tasks
  // commonly start from an empty directory, and the tool must become useful after
  // index.html is created without rebuilding the registry. Opt out with BANTAM_NO_PREVIEW.
  if (ground?.workspace && !process.env.BANTAM_NO_PREVIEW
      && chromiumBinary()) {
    reg.register(previewTool(ground.workspace, {
      endpoint: opts.endpoint,
      vision: localVision,
      taskContext: opts.task,
      taskAwareReview: taskAwarePreviewVisionEnabled(opts.env),
      describeScreenshot: codexVision && codexPreviewVisionEnabled(opts.env)
        ? (screenshot, prompt) => describeImageWithCodex(screenshot, prompt, {
          workspace: ground.workspace,
          model: opts.codexModel,
          effort: opts.codexEffort,
          onEvent: opts.onEvent,
          onExternalUsage: opts.onExternalUsage,
          purpose: "preview_vision",
        })
        : null,
    }));
  }
  // Opt-in because a Codex image call consumes the signed-in Codex account,
  // but deliberately independent of the task model: any local/API model can
  // ask BANTAM to create a managed workspace asset when this is enabled.
  if (ground?.workspace && codexImageEnabled(opts.env)) {
    reg.register(codexImageTool(ground.workspace, {
      onEvent: opts.onEvent,
      onExternalUsage: opts.onExternalUsage,
      env: opts.env,
      signal: opts.signal,
    }));
  }
  return reg;
}
