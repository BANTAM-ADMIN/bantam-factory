// Deterministic concept retrieval over the live grounding snapshot.
//
// This deliberately is not an embedding service in disguise: it performs no
// network calls and has no model dependency. It indexes named function/class
// chunks, ranks them with weighted BM25 lexical evidence, then uses the
// grounding dependency graph as a small reranker. The grounding index is
// replaced atomically after edits, so conceptTool notices that new object and
// rebuilds before answering the next query.

import path from "node:path";

import { isFrozenCopyPath } from "./completeness-critic.js";

const MAX_FILES = 600;
const MAX_CHUNKS = 6000;
const MAX_CHUNKS_PER_FILE = 60;
const MAX_CHUNK_LINES = 180;
const MAX_FILE_TEXT = 24000;
const MAX_SNIPPET = 220;
const DEFAULT_RESULTS = 8;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does",
  "for", "from", "how", "i", "in", "is", "it", "me", "of", "on", "or",
  "our", "that", "the", "this", "to", "we", "what", "where", "which", "with",
]);

const CONCEPT_GROUPS = [
  ["error", "failure", "fault", "exception"],
  ["recover", "recovery", "rollback", "restore", "revert", "retry", "rescue", "fallback"],
  ["validate", "validation", "verify", "check", "guard", "reject", "sanitize"],
  ["input", "request", "payload", "argument", "args", "argv", "parameter", "params", "prompt"],
  ["config", "configuration", "configure", "settings", "options", "environment", "env", "preferences"],
  ["read", "reader", "load", "parse", "fetch", "open", "resolve"],
  ["write", "save", "persist", "store", "commit"],
  ["delete", "remove", "cleanup", "dispose", "purge"],
  ["auth", "authentication", "authorize", "authorization", "permission", "access"],
  ["cache", "memoize", "memoization", "cached"],
  ["start", "startup", "bootstrap", "initialize", "init", "entrypoint"],
  ["route", "routing", "dispatch", "handler", "controller"],
  ["test", "tests", "spec", "fixture", "assert"],
];

const CANONICAL = new Map();
const RELATED = new Map();
for (const group of CONCEPT_GROUPS) {
  const canonical = group[0];
  for (const term of group) {
    CANONICAL.set(term, canonical);
    RELATED.set(term, group);
  }
}

function canonicalToken(raw) {
  let token = String(raw).toLowerCase();
  if (CANONICAL.has(token)) return CANONICAL.get(token);
  if (token.length > 5 && token.endsWith("ies")) token = `${token.slice(0, -3)}y`;
  else if (token.length > 5 && token.endsWith("ing")) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith("ed")) token = token.slice(0, -2);
  else if (token.length > 4 && token.endsWith("s")) token = token.slice(0, -1);
  return CANONICAL.get(token) ?? token;
}

export function conceptTokens(value) {
  const split = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9]*/g) ?? [];
  return split
    .map(canonicalToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function expandedQuery(value) {
  const originals = [...new Set(conceptTokens(value))];
  const weights = new Map(originals.map((term) => [term, 2]));
  for (const original of originals) {
    const rawGroup = RELATED.get(original) ?? CONCEPT_GROUPS.find((group) =>
      group.some((term) => canonicalToken(term) === original)
    );
    for (const related of rawGroup ?? []) {
      const term = canonicalToken(related);
      if (!weights.has(term)) weights.set(term, 0.4);
    }
  }
  return { originals, weights };
}

function lineOffsets(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function leadingIndent(line) {
  const whitespace = /^(\s*)/.exec(line)?.[1] ?? "";
  return whitespace.replace(/\t/g, "    ").length;
}

function precedingCommentStart(lines, declarationLine) {
  let index = declarationLine - 1;
  let sawComment = false;
  let allowedBlank = true;
  while (index >= 0) {
    const text = lines[index].trim();
    if (!text && allowedBlank) {
      allowedBlank = false;
      index -= 1;
      continue;
    }
    if (/^(?:\/\/|\/\*|\*|\*\/|#)/.test(text)) {
      sawComment = true;
      allowedBlank = false;
      index -= 1;
      continue;
    }
    break;
  }
  return sawComment ? index + 1 : declarationLine;
}

// Find a JS/TS declaration's closing brace without letting braces inside
// comments or quoted strings terminate the chunk.
function balancedBraceEnd(source, searchFrom, maxSearch = 800) {
  const limit = Math.min(source.length, searchFrom + maxSearch);
  let open = -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = searchFrom; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (open < 0) {
      if (char === "{") { open = i; depth = 1; }
      else if (i >= limit || char === ";") return -1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function jsDeclarationEnd(source, offsets, lineIndex) {
  const endOffset = balancedBraceEnd(source, offsets[lineIndex]);
  if (endOffset < 0) return Math.min(offsets.length - 1, lineIndex + 24);
  let low = lineIndex;
  let high = offsets.length;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] < endOffset) low = mid;
    else high = mid;
  }
  return low;
}

function pythonDeclarationEnd(lines, lineIndex) {
  const indent = leadingIndent(lines[lineIndex]);
  for (let i = lineIndex + 1; i < lines.length; i += 1) {
    const text = lines[i];
    if (!text.trim() || text.trimStart().startsWith("#")) continue;
    if (leadingIndent(text) <= indent) return i - 1;
  }
  return lines.length - 1;
}

function declarations(source, file) {
  const lines = source.split("\n");
  const offsets = lineOffsets(source);
  const python = path.extname(file).toLowerCase() === ".py";
  const found = [];
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line];
    let match;
    let kind;
    if (python) {
      match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text);
      if (match) kind = "function";
      else {
        match = /^(\s*)class\s+([A-Za-z_]\w*)\b/.exec(text);
        if (match) kind = "class";
      }
    } else {
      match = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/.exec(text);
      if (match) kind = "function";
      else {
        match = /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\b/.exec(text);
        if (match) kind = "class";
      }
      if (!match) {
        match = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(text);
        if (match) kind = "function";
      }
    }
    if (!match) continue;
    const name = python ? match[2] : match[1];
    const start = precedingCommentStart(lines, line);
    const rawEnd = python
      ? pythonDeclarationEnd(lines, line)
      : jsDeclarationEnd(source, offsets, line);
    const end = Math.min(rawEnd, start + MAX_CHUNK_LINES - 1);
    found.push({ name, kind, start, declarationLine: line, end });
    if (found.length >= MAX_CHUNKS_PER_FILE) break;
  }
  return found;
}

function commentText(source) {
  const comments = [];
  for (const match of source.matchAll(/\/\/([^\n]*)|\/\*([\s\S]*?)\*\/|^\s*#([^\n]*)/gm)) {
    comments.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/^\s*\*\s?/gm, " "));
  }
  return comments.join(" ");
}

function frequencies(tokens) {
  const out = new Map();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
  return out;
}

function makeChunk({ file, name, kind, start, end, text, defines = [] }) {
  const comments = commentText(text);
  const identifiers = [file, name, ...defines].filter(Boolean).join(" ");
  const weightedTokens = [
    ...conceptTokens(file), ...conceptTokens(file), ...conceptTokens(file),
    ...conceptTokens(identifiers), ...conceptTokens(identifiers), ...conceptTokens(identifiers),
    ...conceptTokens(identifiers),
    ...conceptTokens(comments), ...conceptTokens(comments),
    ...conceptTokens(text),
  ];
  const firstCode = text.split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^(?:\/\/|\/\*|\*|\*\/|#)/.test(line)) ?? "";
  return {
    file,
    name,
    kind,
    line: start + 1,
    endLine: end + 1,
    text,
    comments,
    identifiers,
    pathText: file,
    tokenFreq: frequencies(weightedTokens),
    length: weightedTokens.length,
    snippet: firstCode.replace(/\s+/g, " ").slice(0, MAX_SNIPPET),
  };
}

export function buildConceptIndex(ground, options = {}) {
  const records = ground?.factIndex?.records;
  const chunks = [];
  if (!(records instanceof Map)) return { chunks, documentFrequency: new Map(), averageLength: 1 };
  const maxFiles = Math.min(MAX_FILES, Math.max(1, Number(options.maxFiles) || MAX_FILES));
  for (const [file, record] of [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, maxFiles)) {
    const source = String(record?.source ?? "");
    const lines = source.split("\n");
    const defs = [...new Set(record?.defines ?? [])].sort();
    const decls = declarations(source, file);
    for (const decl of decls) {
      const text = lines.slice(decl.start, decl.end + 1).join("\n");
      chunks.push(makeChunk({ file, ...decl, text }));
      if (chunks.length >= MAX_CHUNKS) break;
    }
    if (chunks.length >= MAX_CHUNKS) break;
    // A bounded module overview catches meaningful top-level behavior (config
    // reads, registrations, constants) that is not inside a named declaration.
    const overviewEnd = Math.max(0, Math.min(lines.length - 1, MAX_CHUNK_LINES - 1));
    const overviewText = lines.slice(0, overviewEnd + 1).join("\n").slice(0, MAX_FILE_TEXT);
    chunks.push(makeChunk({
      file,
      name: path.basename(file),
      kind: "module",
      start: 0,
      end: overviewEnd,
      text: overviewText,
      defines: defs,
    }));
    if (chunks.length >= MAX_CHUNKS) break;
  }
  const documentFrequency = new Map();
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
    for (const term of chunk.tokenFreq.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    chunks,
    documentFrequency,
    averageLength: chunks.length ? totalLength / chunks.length : 1,
  };
}

function dependencyGraph(db) {
  const incoming = new Map();
  const outgoing = new Map();
  if (!db?.query) return { incoming, outgoing, entrypoints: new Set(), tests: new Set() };
  let edges = [];
  try { edges = db.query("depends", "?", "?"); } catch { /* empty graph */ }
  for (const [from, to] of edges) {
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    if (!incoming.has(to)) incoming.set(to, new Set());
    outgoing.get(from).add(to);
    incoming.get(to).add(from);
  }
  const values = (predicate) => {
    try { return new Set(db.query(predicate, "?").map((row) => row[0])); } catch { return new Set(); }
  };
  return { incoming, outgoing, entrypoints: values("entrypoint"), tests: values("test") };
}

function fieldSignals(chunk, originals) {
  const sources = [
    ["path", new Set(conceptTokens(chunk.pathText))],
    ["identifier", new Set(conceptTokens(chunk.identifiers))],
    ["comment", new Set(conceptTokens(chunk.comments))],
    ["code", new Set(conceptTokens(chunk.text))],
  ];
  return sources
    .filter(([, terms]) => originals.some((term) => terms.has(term)))
    .map(([name]) => name);
}

export function searchConceptIndex(index, ground, question, options = {}) {
  const { originals, weights } = expandedQuery(question);
  if (!originals.length || !index?.chunks?.length) return [];
  const n = index.chunks.length;
  const avg = Math.max(1, index.averageLength);
  const preliminary = [];
  for (const chunk of index.chunks) {
    let lexical = 0;
    const matched = [];
    for (const [term, weight] of weights) {
      const tf = chunk.tokenFreq.get(term) ?? 0;
      if (!tf) continue;
      const df = index.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + ((n - df + 0.5) / (df + 0.5)));
      const norm = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (chunk.length / avg)));
      lexical += weight * idf * norm;
      if (originals.includes(term)) matched.push(term);
    }
    if (!lexical) continue;
    const uniqueMatched = [...new Set(matched)];
    const coverage = uniqueMatched.length / originals.length;
    lexical *= 0.65 + 0.35 * coverage;
    lexical += coverage * 0.8;
    if (chunk.kind === "module") lexical *= 0.82;
    preliminary.push({ chunk, lexical, matched: uniqueMatched, coverage });
  }
  if (!preliminary.length) return [];

  const bestByFile = new Map();
  for (const row of preliminary) {
    bestByFile.set(row.chunk.file, Math.max(bestByFile.get(row.chunk.file) ?? 0, row.lexical));
  }
  const maximum = Math.max(...bestByFile.values(), 1);
  const graph = dependencyGraph(ground?.db);
  const queryWantsTests = originals.includes("test");
  // A run whose task IS the fixture must still be able to find it.
  const queryWantsFrozen = originals.some((word) => /^(fixtures?|vendor|vendored|node_modules|third_party)$/.test(word));
  const ranked = preliminary.map((row) => {
    const file = row.chunk.file;
    const neighbors = new Set([
      ...(graph.incoming.get(file) ?? []),
      ...(graph.outgoing.get(file) ?? []),
    ]);
    const supporting = [...neighbors]
      .map((neighbor) => bestByFile.get(neighbor) ?? 0)
      .filter(Boolean)
      .sort((a, b) => b - a)
      .slice(0, 3);
    const graphSupport = supporting.reduce((sum, score) => sum + score / maximum, 0);
    const centrality = Math.log1p(neighbors.size);
    let score = row.lexical + (0.16 * graphSupport) + (0.025 * centrality);
    if (graph.entrypoints.has(file)) score += 0.08;
    // Test names often repeat the exact prose a user searched for, which can
    // otherwise bury the production implementation. Tests remain searchable
    // (and lose no weight when the question itself asks for tests).
    if (!queryWantsTests && (graph.tests.has(file) || /(?:^|\/)(?:test|tests|__tests__)\//i.test(file))) score *= 0.55;
    // A vendored or fixture copy of the project is a decoy of the worst kind: it
    // holds the same identifiers, comments and structure as the real source, so
    // it matches a concept query at least as well, and it is never the thing to
    // edit. gauntlet/fixtures/retry-consolidation-haystack/repo/ is literally a
    // haystack — the same frozen agent.js the sibling-symbol gate already
    // learned to exclude (isFrozenCopyPath).
    //
    // Measured across the stored runs: 55.4% of ranked hits sat inside a frozen
    // copy and 10 of 14 queries returned one as their #1 result. In
    // 2026-08-16T17-22-16 the model asked where editScopeRefusal lived, was
    // handed the fixture at score 77.3, spent seven actions reading it, and
    // then issued a replace against the real src/agent.js at the fixture's line
    // number — which is where "old text not found" came from.
    //
    // Down-ranked, not dropped: de-indexing these would blind defines/reaches
    // and scoped verification, which the codefacts walker warns against.
    if (!queryWantsFrozen && isFrozenCopyPath(file)) score *= 0.2;
    return {
      ...row,
      score,
      graphNeighbors: neighbors.size,
      graphMatches: supporting.length,
      signals: fieldSignals(row.chunk, originals),
    };
  });
  ranked.sort((a, b) =>
    b.score - a.score
    || b.coverage - a.coverage
    || a.chunk.file.localeCompare(b.chunk.file)
    || a.chunk.line - b.chunk.line
    || a.chunk.name.localeCompare(b.chunk.name)
  );

  const limit = Math.min(20, Math.max(1, Number(options.limit) || DEFAULT_RESULTS));
  const perFile = new Map();
  const output = [];
  for (const row of ranked) {
    const seen = perFile.get(row.chunk.file) ?? 0;
    if (seen >= 1) continue;
    perFile.set(row.chunk.file, seen + 1);
    output.push(row);
    if (output.length >= limit) break;
  }
  return output;
}

export function formatConceptResults(question, results) {
  if (!results.length) return `No concept matches found for "${String(question).trim()}".`;
  const lines = [`Concept matches for "${String(question).trim()}" (${results.length}):`];
  for (let i = 0; i < results.length; i += 1) {
    const row = results[i];
    const chunk = row.chunk;
    const range = chunk.endLine > chunk.line ? `${chunk.line}-${chunk.endLine}` : String(chunk.line);
    const evidence = [
      row.matched.length ? `matched ${row.matched.join(", ")}` : "related vocabulary",
      row.signals.length ? row.signals.join("+") : "code",
      row.graphMatches ? `${row.graphMatches} linked match${row.graphMatches === 1 ? "" : "es"}` : null,
    ].filter(Boolean).join("; ");
    lines.push(
      `${i + 1}. ${chunk.file}:${range} — ${chunk.name} [${chunk.kind}] score ${row.score.toFixed(3)}`,
      `   ${evidence}`,
      chunk.snippet ? `   ${chunk.snippet}` : "",
    );
  }
  return lines.filter(Boolean).join("\n").slice(0, 8000);
}

export function conceptTool(ground, options = {}) {
  let factIndex = null;
  let index = null;
  return {
    name: "concept",
    description: "find behavior by meaning — `concept <question>` (ranked function/class chunks using lexical evidence + dependency-graph context)",
    verbs: ["concept"],
    answer(value) {
      const question = String(value ?? "").trim().replace(/^(?:find|search)\s+/i, "");
      if (!question) return "usage: concept <question> — examples: concept error recovery | concept validate user input | concept read configuration";
      const stale = [...(ground?.staleFiles ?? [])].sort();
      if (stale.length) {
        return `[concept] index is stale after edits to: ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? `, +${stale.length - 8} more` : ""}. Refresh grounding before making retrieval claims.`;
      }
      if (ground?.factIndex !== factIndex || !index) {
        factIndex = ground?.factIndex ?? null;
        index = buildConceptIndex(ground, options);
      }
      return formatConceptResults(
        question,
        searchConceptIndex(index, ground, question, { limit: options.limit }),
      );
    },
  };
}
