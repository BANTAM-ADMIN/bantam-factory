import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const IDENTITY_SLOT = /(?:seq(?:uence)?|gen(?:eration)?|epoch|version|revision|token|nonce|serial|counter)/i;
const PENDING_SLOT = /(?:pending|in.?flight|active|current|request|operation)/i;
const SETTLEMENT_CALLBACK = /(?:\.catch\s*\(|\.finally\s*\(|\(\s*(?:result|value|res|error|err|reason)\s*\)\s*=>)/i;

/** Find narrow, high-confidence async ownership risks in current source files. */
export function findStateAuditRisks(workspace, { paths = [], maxFiles = 80, maxBytes = 1_000_000 } = {}) {
  const root = path.resolve(workspace);
  const files = candidateFiles(root, paths, maxFiles);
  const risks = [];
  let bytes = 0;
  for (const file of files) {
    let source;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      bytes += stat.size;
      if (bytes > maxBytes) break;
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    risks.push(...findStateAuditRisksInSource(source, portableRelative(root, file)));
  }
  return risks;
}

export function findStateAuditRisksInSource(source, file = "source.js") {
  const sourceText = String(source ?? "");
  const lines = sourceText.split(/\r?\n/);
  const risks = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const sharedResult = /\breturn\s+\w+\.map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([A-Za-z_$][\w$]*)\.get\s*\(\s*\1\.key\s*\)\s*\)/.exec(line);
    if (sharedResult) {
      const resultMap = sharedResult[2];
      const storesResultRecord = new RegExp(
        `\\b${escapeRegExp(resultMap)}\\.set\\s*\\([^,]+,\\s*\\{[^}]{0,240}\\b(?:status|value|reason)\\b`,
        "s",
      ).test(sourceText);
      if (storesResultRecord) {
        risks.push(risk(file, index + 1, "shared-result-wrapper",
          `returns the same stored result record for duplicate inputs; construct an independent wrapper per input while preserving required value/reason identity`));
      }
    }

    for (const match of line.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\.clear\s*\(\s*\)/g)) {
      if (!IDENTITY_SLOT.test(match[1])) continue;
      risks.push(risk(file, index + 1, "identity-reset",
        `clears likely operation-identity state \`${match[1]}\`; a fresh operation can reuse an old value after reset`));
    }

    for (const match of line.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\.delete\s*\(/g)) {
      if (!PENDING_SLOT.test(match[1])) continue;
      const callbackStart = nearestSettlementCallback(lines, index);
      if (callbackStart === -1) continue;
      const context = lines.slice(callbackStart, index + 1).join("\n");
      if (hasIdentityGuard(context)) continue;
      risks.push(risk(file, index + 1, "unguarded-settlement-cleanup",
        `deletes \`${match[1]}\` from a settlement path without a nearby current-operation identity guard`));
    }
  }
  risks.push(...loopScopedParameterValidationRisks(sourceText, file));
  return dedupeRisks(risks);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loopScopedParameterValidationRisks(source, file) {
  const risks = [];
  const functions = source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/g,
  );
  for (const match of functions) {
    const collection = match[2];
    const parameter = match[3];
    const bodyStart = match.index + match[0].length;
    const functionEnd = matchingBrace(source, bodyStart - 1);
    const body = source.slice(bodyStart, functionEnd === -1 ? bodyStart + 2400 : functionEnd);
    for (const loop of body.matchAll(/\bfor\s*\(([^)]*)\)\s*\{/g)) {
      const header = loop[1];
      const iteratesCollection = new RegExp(
        `(?:\\b${escapeRegExp(collection)}\\.length\\b|\\bof\\s+${escapeRegExp(collection)}\\b)`,
      ).test(header);
      if (!iteratesCollection) continue;
      const loopOpen = bodyStart + loop.index + loop[0].lastIndexOf("{");
      const loopEnd = matchingBrace(source, loopOpen);
      if (loopEnd === -1) continue;
      const loopBody = source.slice(loopOpen + 1, loopEnd);
      const validation = new RegExp(
        `\\btypeof\\s+${escapeRegExp(parameter)}\\s*!==?\\s*["']function["'][\\s\\S]{0,180}?\\bthrow\\s+new\\s+TypeError`,
      ).exec(loopBody);
      if (!validation) continue;
      const offset = loopOpen + 1 + validation.index;
      const line = source.slice(0, offset).split(/\r?\n/).length;
      risks.push(risk(file, line, "loop-scoped-parameter-validation",
        `validates function-wide parameter \`${parameter}\` only inside a \`${collection}\` loop; an empty collection bypasses the precondition`));
    }
  }
  return risks;
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function formatStateAuditRisks(risks) {
  if (!Array.isArray(risks) || risks.length === 0) return "";
  const rows = risks.slice(0, 6).map((item) => `- ${item.path}:${item.line} ${item.message}`);
  return `\n\n[state-audit static signals] These source patterns require proof or correction; visible tests do not clear them:\n${rows.join("\n")}`;
}

function nearestSettlementCallback(lines, deleteIndex) {
  for (let index = deleteIndex; index >= Math.max(0, deleteIndex - 12); index--) {
    if (SETTLEMENT_CALLBACK.test(lines[index])) return index;
  }
  return -1;
}

function hasIdentityGuard(context) {
  return /\bif\s*\([\s\S]{0,240}?(?:===|!==)[\s\S]{0,240}?\)/.test(context);
}

function candidateFiles(root, requested, maxFiles) {
  const explicit = [...new Set((requested ?? [])
    .map((item) => safeSourcePath(root, item))
    .filter(Boolean))];
  if (explicit.length) return explicit.slice(0, maxFiles);

  const roots = ["src", "lib", "app"].map((name) => path.join(root, name)).filter(isDirectory);
  const stack = roots.length ? roots : [root];
  const files = [];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "test" || entry.name === "tests") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files.sort();
}

function safeSourcePath(root, requested) {
  if (typeof requested !== "string" || !SOURCE_EXTENSIONS.has(path.extname(requested))) return null;
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

function isDirectory(file) {
  try { return fs.lstatSync(file).isDirectory(); } catch { return false; }
}

function portableRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function risk(file, line, kind, message) {
  return { path: file, line, kind, message };
}

function dedupeRisks(risks) {
  const seen = new Set();
  return risks.filter((item) => {
    const key = `${item.path}:${item.line}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
