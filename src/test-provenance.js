import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { full as walk } from "acorn-walk";
import { isGeneratedPath, isTestPath } from "./scope-guard.js";
import { extractTestBlock } from "./logic/test-focus.js";

function javascriptTests(source) {
  try {
    const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
    const bindings = new Set(["test", "it"]);
    for (const node of tree.body) {
      if (node.type !== "ImportDeclaration" || !/^(?:node:test|vitest|@jest\/globals)$/.test(node.source.value)) continue;
      for (const spec of node.specifiers) {
        if ((spec.type === "ImportDefaultSpecifier" && node.source.value === "node:test")
            || (spec.type === "ImportSpecifier" && ["test", "it"].includes(spec.imported.name))) bindings.add(spec.local.name);
      }
    }
    const rootName = (node) => {
      if (node?.type === "Identifier") return node.name;
      if (node?.type === "MemberExpression") return rootName(node.object);
      if (node?.type === "CallExpression") return rootName(node.callee);
      return null;
    };
    const tests = [];
    walk(tree, (node) => {
      if (node.type !== "CallExpression" || !bindings.has(rootName(node.callee))) return;
      tests.push({ start: node.start, end: node.end,
        firstLine: node.loc.start.line, lastLine: node.loc.end.line,
        source: source.slice(node.start, node.end) });
    });
    return tests.sort((a, b) => a.start - b.start || b.end - a.end);
  } catch { return null; }
}

function testAtLine(tests, line) {
  if (!Number.isInteger(line) || line < 1 || !tests) return null;
  const matches = tests.filter((test) => test.firstLine <= line && test.lastLine >= line);
  const innermost = matches.filter((candidate) => !matches.some((other) =>
    other !== candidate && other.start >= candidate.start && other.end <= candidate.end));
  return innermost.length === 1 ? innermost[0] : null;
}

function appendedTest(original, current, originalTests, currentTests, target) {
  // Byte-preserved supplied source establishes a new section unambiguously.
  if (current.startsWith(original) && target.start >= original.length) return true;
  if (!originalTests?.length || !currentTests) return false;
  // Also allow changes to imports/comments around an otherwise preserved test
  // section. Every original AST block must still occur exactly once, in order,
  // and the new block must follow that entire section. A renamed/replaced test
  // cannot qualify merely because its new name was absent at the start.
  let priorEnd = -1;
  const originalCounts = new Map();
  const currentMatches = new Map();
  for (const test of originalTests) originalCounts.set(test.source, (originalCounts.get(test.source) ?? 0) + 1);
  for (const test of currentTests) {
    const matches = currentMatches.get(test.source) ?? [];
    matches.push(test);
    currentMatches.set(test.source, matches);
  }
  for (const supplied of originalTests) {
    if (originalCounts.get(supplied.source) !== 1) return false;
    const matches = currentMatches.get(supplied.source) ?? [];
    if (matches.length !== 1 || matches[0].start < priorEnd) return false;
    priorEnd = matches[0].end;
  }
  return target.start >= priorEnd;
}

const SNAPSHOT_SCHEMA = 1;

function safeSnapshotPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function restoreSnapshot(snapshot, { maxBytes, maxFiles }) {
  if (!snapshot || snapshot.schema !== SNAPSHOT_SCHEMA || typeof snapshot.complete !== "boolean"
      || !Array.isArray(snapshot.initialPaths) || !Array.isArray(snapshot.excludedPaths)
      || !Array.isArray(snapshot.originals) || snapshot.initialPaths.length > maxFiles
      || snapshot.excludedPaths.length > maxFiles || snapshot.originals.length > maxFiles) return null;
  const initialPaths = new Set(), excludedPaths = new Set(), originals = new Map();
  for (const rel of snapshot.initialPaths) {
    if (!safeSnapshotPath(rel) || initialPaths.has(rel)) return null;
    initialPaths.add(rel);
  }
  for (const rel of snapshot.excludedPaths) {
    if (!safeSnapshotPath(rel) || !initialPaths.has(rel) || excludedPaths.has(rel)) return null;
    excludedPaths.add(rel);
  }
  let bytes = 0;
  for (const row of snapshot.originals) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const [rel, source] = row;
    if (!safeSnapshotPath(rel) || !initialPaths.has(rel) || !isTestPath(rel)
        || originals.has(rel) || typeof source !== "string"
        || [...excludedPaths].some((entry) => rel === entry || rel.startsWith(entry + "/"))) return null;
    bytes += Buffer.byteLength(source, "utf8");
    if (bytes > maxBytes) return null;
    originals.set(rel, source);
  }
  return { initialPaths, excludedPaths, originals, complete: snapshot.complete };
}

/** Capture the original test inventory once, or restore that same basis on resume.
 * Snapshots are trusted run evidence, not a proof against a caller forging a film.
 * Explicit missing/invalid resume evidence stays unknown; it must not promote the
 * current model-authored workspace into supplied authority by rescanning it.
 */
export function createTestProvenance(workspace, options = {}) {
  const { maxBytes = 32 * 1024 * 1024, maxFiles = 10000, protectedPath = () => false } = options;
  const root = fs.realpathSync(workspace);
  let originals = new Map();
  const originalTests = new Map();
  const currentTests = new Map();
  let initialPaths = new Set();
  let excludedPaths = new Set();
  let bytes = 0, files = 0, complete = true;
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { complete = false; return; }
    for (const entry of entries) {
      if (files >= maxFiles) { complete = false; return; }
      files++;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!safeSnapshotPath(rel)) { complete = false; continue; }
      initialPaths.add(rel);
      if (isGeneratedPath(rel)) { excludedPaths.add(rel); continue; }
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.isFile() || !isTestPath(rel)) continue;
      try {
        const size = fs.statSync(full).size;
        if (bytes + size > maxBytes) { complete = false; continue; }
        const text = fs.readFileSync(full, "utf8");
        const sourceBytes = Buffer.byteLength(text, "utf8");
        if (bytes + sourceBytes > maxBytes) { complete = false; continue; }
        bytes += sourceBytes;
        originals.set(rel, text);
      } catch { complete = false; }
    }
  };
  if (Object.hasOwn(options, "snapshot")) {
    const restored = restoreSnapshot(options.snapshot, { maxBytes, maxFiles });
    if (restored) ({ originals, initialPaths, excludedPaths, complete } = restored);
    else complete = false;
  } else visit(root);
  const classify = (failure) => {
    if (!failure?.file) return "unknown";
    try {
      const requested = path.resolve(root, failure.file);
      if (!requested.startsWith(root + path.sep)) return "unknown";
      const requestedRel = path.relative(root, requested).split(path.sep).join("/");
      if (protectedPath(requestedRel)) return "protected";
      const full = fs.realpathSync(requested);
      if (!full.startsWith(root + path.sep)) return "unknown";
      const rel = path.relative(root, full).split(path.sep).join("/");
      // An edit cannot promote a caller-protected oracle into an editable one.
      if (protectedPath(rel)) return "protected";
      if (fs.statSync(full).size > maxBytes) return "unknown";
      const current = fs.readFileSync(full, "utf8");
      const original = originals.get(rel);
      if (original === undefined) {
        const excluded = [...excludedPaths].some((entry) => rel === entry || rel.startsWith(entry + "/"));
        return complete && !initialPaths.has(rel) && !excluded ? "generated" : "unknown";
      }
      if (original === current) return "baseline";
      const ext = path.extname(rel);
      if (/^\.[mc]?js$/.test(ext)) {
        if (!originalTests.has(rel)) originalTests.set(rel, javascriptTests(original));
        if (currentTests.get(rel)?.source !== current) currentTests.set(rel, { source: current, tests: javascriptTests(current) });
        const supplied = originalTests.get(rel);
        const present = currentTests.get(rel).tests;
        const target = testAtLine(present, failure.line);
        if (target && supplied) {
          if (supplied.some((test) => test.source === target.source)) return "baseline-context-changed";
          if (appendedTest(original, current, supplied, present, target)) return "self-authored";
        }
      }
      const lang = ext === ".py" ? "py" : ext === ".go" ? "go" : ext === ".rs" ? "rs" : "js";
      const block = failure.line ? extractTestBlock(current, failure.line, { lang }) : null;
      if (block && original.includes(block)) return "baseline-context-changed";
      return "added-or-modified";
    } catch { return "unknown"; }
  };
  // Copies prevent an artifact consumer from changing the live classifier's
  // authority. Relative paths allow restoring into a different private cell.
  classify.snapshot = () => ({ schema: SNAPSHOT_SCHEMA, complete,
    initialPaths: [...initialPaths], excludedPaths: [...excludedPaths],
    originals: [...originals].map(([rel, source]) => [rel, source]) });
  return classify;
}
