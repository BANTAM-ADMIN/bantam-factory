// Bounded, typed current-source observations. A snapshot is context, not proof
// that the implementation is correct or permission to replace unread bytes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONTEXT_UPDATE_MAX_CHARS = 3000;
const MAX_FILES = 4;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LINES = 160;

export function createContextUpdate(workspace, { kind, paths, generation, focusLine } = {}) {
  if (!["decision", "edit-recovery"].includes(kind)
      || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(paths)) return null;
  let root;
  try { root = fs.realpathSync(path.resolve(workspace)); } catch { return null; }
  const candidates = [...new Set(paths.filter(safeRelativePath))].slice(0, MAX_FILES);
  const captures = [];
  for (let i = 0; i < candidates.length; i++) {
    // Fixed shares also bound reads that are subsequently discarded because
    // decoding or a post-read identity check rejects the candidate.
    const capture = captureSource(root, candidates[i], Math.floor(MAX_READ_BYTES / candidates.length));
    if (!capture) continue;
    captures.push(capture);
  }
  if (!captures.length) return null;

  const heading = `${kind === "decision" ? "[review]\n" : ""}CURRENT SOURCE SNAPSHOT (${kind}; generation ${generation}). Bounded disk observations, not a passing verification proof.\n`;
  const guidance = "\nFor omitted/clipped bytes or later changes, use read_file with the exact path before editing. Do not reconstruct unread text.\n";
  const fileBudget = Math.floor((CONTEXT_UPDATE_MAX_CHARS - heading.length - guidance.length) / captures.length);
  const rendered = captures.map(capture => renderCapture(capture, fileBudget,
    kind === "edit-recovery" && Number.isSafeInteger(focusLine) && focusLine > 0 ? focusLine : null));
  const text = heading + rendered.map(row => row.text).join("") + guidance;
  const hash = crypto.createHash("sha256").update(`${kind}\0${generation}\0`);
  for (const capture of captures) {
    // This binds captured bytes, not an invented full-file digest when the
    // read was capped. Size and rendered selection also affect the receipt.
    hash.update(`${capture.path}\0${capture.fileBytes}\0${capture.bytes.length}\0`).update(capture.bytes);
  }
  hash.update(text);
  return {
    schema: 1, id: `${kind}:${generation}:${hash.digest("hex")}`, kind, generation,
    text, paths: rendered.map(row => row.metadata),
  };
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !/[\\\x00-\x1f\x7f]/.test(value)
    && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

function captureSource(root, relative, maxBytes) {
  let descriptor;
  try {
    let full = root;
    for (const part of relative.split("/")) {
      full = path.join(full, part);
      if (fs.lstatSync(full).isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(full);
    if (!inside(root, real)) return null;
    descriptor = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
      | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) return null;
    // On Linux, validate the opened object as well as the pre-open pathname.
    // This also catches an ancestor swapped to an escaping symlink at open.
    if (process.platform === "linux" && !inside(root, fs.realpathSync(`/proc/self/fd/${descriptor}`))) return null;
    const buffer = Buffer.alloc(Math.min(maxBytes, before.size));
    let readBytes = 0;
    while (readBytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, readBytes, buffer.length - readBytes, readBytes);
      if (!count) break;
      readBytes += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    const bytes = buffer.subarray(0, readBytes);
    const readTruncated = readBytes < after.size;
    // Streaming decode holds an incomplete final UTF-8 sequence instead of
    // inventing a replacement character at the read limit. Non-text is omitted.
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes, { stream: readTruncated });
    if (source.includes("\0")) return null;
    return { path: relative, bytes, source, fileBytes: after.size, readTruncated };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function renderCapture(capture, budget, focusLine) {
  const lines = capture.source ? capture.source.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const requestedOutside = Boolean(focusLine && focusLine > lines.length && capture.readTruncated);
  const focus = focusLine && focusLine <= lines.length ? focusLine : null;
  // Start at the requested line so an arbitrarily long preceding line cannot
  // consume the bounded excerpt before the actual repair site is reached.
  const start = focus ? focus - 1 : 0;
  const heading = `\n# ${capture.path} — CURRENT source\n`;
  const sourceBudget = budget - heading.length - 220;
  let body = "", end = start, clippedChars = 0;
  const lineCap = Math.min(240, Math.max(24, Math.floor(sourceBudget / (focus ? 4 : 1))));
  while (end < lines.length && end - start < MAX_LINES) {
    const number = `${end + 1}\t`;
    const limit = Math.min(lineCap, sourceBudget - body.length - number.length - 1);
    if (limit <= 0) break;
    const source = lines[end];
    const displayed = source.slice(0, limit);
    body += `${number}${displayed}\n`;
    clippedChars += source.length - displayed.length;
    end++;
    if (source.length > displayed.length) break;
  }
  if (!lines.length) body = "(empty file)\n";
  const omittedLines = lines.length - (end - start);
  const truncated = capture.readTruncated || omittedLines > 0 || clippedChars > 0;
  const omissions = [
    ...(omittedLines ? [`${omittedLines} lines omitted`] : []),
    ...(clippedChars ? [`${clippedChars} characters omitted from shown lines`] : []),
    ...(capture.readTruncated ? [`${capture.fileBytes - capture.bytes.length} bytes not read`] : []),
    ...(requestedOutside ? ["requested line lies beyond bounded read"] : []),
  ];
  const footer = truncated ? `[partial snapshot: ${omissions.join("; ")}]\n` : "[complete file snapshot]\n";
  return {
    text: heading + body + footer,
    metadata: {
      path: capture.path, startLine: start + 1, endLine: end,
      readBytes: capture.bytes.length, fileBytes: capture.fileBytes,
      readTruncated: capture.readTruncated, truncated,
    },
  };
}
