// Bounded archival for generated visual evidence.
//
// Fixture workspaces are disposable. A run artifact that records only a binary
// diff proves that an image existed, but cannot render the image later. This
// module copies only changed files from the managed assets/generated/ subtree
// into a sibling attachment directory before workspace cleanup.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";

const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".json"]);
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export function archiveGeneratedAttachments({
  workspace,
  artifactPath,
  before = new Map(),
  limits = {},
} = {}) {
  const policy = normalizedLimits(limits);
  const sourceRoot = path.join(path.resolve(workspace), "assets", "generated");
  const attachmentRoot = `${path.resolve(artifactPath).replace(/\.json$/i, "")}.attachments`;
  const files = [];
  const omitted = [];
  let totalBytes = 0;

  for (const candidate of generatedCandidates(sourceRoot)) {
    const sourcePath = candidate.abs;
    const workspaceRel = `assets/generated/${candidate.rel}`;
    const extension = path.extname(candidate.rel).toLowerCase();
    if (!ALLOWED.has(extension)) {
      omitted.push({ path: workspaceRel, reason: "unsupported-extension" });
      continue;
    }
    if (candidate.kind !== "file") {
      omitted.push({ path: workspaceRel, reason: candidate.kind });
      continue;
    }
    if (candidate.bytes > policy.maxFileBytes) {
      omitted.push({ path: workspaceRel, reason: "file-size-limit", bytes: candidate.bytes });
      continue;
    }
    if (files.length >= policy.maxFiles) {
      omitted.push({ path: workspaceRel, reason: "file-count-limit", bytes: candidate.bytes });
      continue;
    }
    if (totalBytes + candidate.bytes > policy.maxTotalBytes) {
      omitted.push({ path: workspaceRel, reason: "total-size-limit", bytes: candidate.bytes });
      continue;
    }

    const data = readRegularFileNoFollow(sourcePath);
    const sha256 = hash(data);
    if (before?.get?.(workspaceRel) === sha256) continue;

    const destination = path.join(attachmentRoot, "assets", "generated", ...candidate.rel.split("/"));
    writeExclusive(destination, data);
    const artifactRelativePath = relativePosix(path.dirname(path.resolve(artifactPath)), destination);
    files.push({
      sourcePath: workspaceRel,
      path: artifactRelativePath,
      mediaType: mediaType(extension),
      bytes: data.length,
      sha256,
    });
    totalBytes += data.length;
  }

  const status = files.length ? (omitted.length ? "partial" : "captured") : "none";
  const result = {
    schema: 1,
    status,
    policy,
    files,
    totalBytes,
    omitted,
    indexPath: null,
  };
  if (files.length) {
    const indexFile = path.join(attachmentRoot, "index.json");
    result.indexPath = relativePosix(path.dirname(path.resolve(artifactPath)), indexFile);
    writeJsonAtomic(indexFile, result);
  }
  return result;
}

function generatedCandidates(root) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { return []; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  const rows = [];
  const walk = (dir, prefix = "") => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) rows.push({ abs, rel, bytes: stat.size, kind: "symlink" });
      else if (stat.isDirectory()) walk(abs, rel);
      else if (stat.isFile()) rows.push({ abs, rel, bytes: stat.size, kind: "file" });
      else rows.push({ abs, rel, bytes: stat.size, kind: "non-regular" });
    }
  };
  walk(root);
  return rows;
}

function readRegularFileNoFollow(filePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`attachment source is not a regular file: ${filePath}`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusive(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(filePath, flags, 0o644);
  try {
    const written = fs.writeSync(descriptor, data, 0, data.length, null);
    if (written !== data.length) {
      throw new Error(`attachment write was incomplete: wrote ${written} of ${data.length}`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizedLimits(raw) {
  return {
    maxFiles: bounded(raw.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxFileBytes: bounded(raw.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: bounded(raw.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
  };
}

function bounded(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function relativePosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function mediaType(extension) {
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".html": "text/html",
    ".json": "application/json",
  })[extension] ?? "application/octet-stream";
}
