// Bounded, typed current-source observations. A snapshot is context, not proof
// that the implementation is correct or permission to replace unread bytes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTION_DEFINITIONS, LINE_EDIT_FEATURE, PATCH_ACTION_FEATURE, actionPromptMenuLine } from "./action-protocol.js";

export const CONTEXT_UPDATE_MAX_CHARS = 3000;
const MAX_FILES = 4;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LINES = 160;
const KNOWN_ACTIONS = new Set(ACTION_DEFINITIONS.map(definition => definition.verb));

// A turn-scoped grammar grant must carry its matching interface through the
// same bounded, recorded channel as current source. It is not source evidence
// or permission to bypass edit scope, and does not expand the two-record budget.
export function createActionContractUpdate({ generation, turn, availableVerbs, reason, recoveryPath = null } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0
      || !Number.isSafeInteger(turn) || turn < 0
      || !Array.isArray(availableVerbs) || !availableVerbs.length
      || availableVerbs.length > KNOWN_ACTIONS.size
      || availableVerbs.some(verb => !KNOWN_ACTIONS.has(verb))
      || new Set(availableVerbs).size !== availableVerbs.length
      || !availableVerbs.includes(reason === 'verification-repair' ? 'patch' : 'edit_lines')
      || !["edit-recovery", "document-revision", "verification-repair"].includes(reason)
      || (recoveryPath !== null && !safeRelativePath(recoveryPath))) return null;
  const text = [
    `ACTION INTERFACE FOR TURN ${turn + 1} (generation ${generation}). Later turn interfaces supersede this one.`,
    reason === "edit-recovery"
      ? `EDIT RECOVERY ACTIVE${recoveryPath ? `: ${recoveryPath}` : ""}. The failed exact-match proposal was NOT APPLIED. Use actual current bytes, not that proposal.`
      : reason === 'verification-repair'
        ? 'TEST REPAIR: the current executed suite reports multiple failures after an authored test edit. If you have already diagnosed independent corrections, apply them together; do not invent changes to fill a batch.'
        : "DOCUMENT REVISION: use the current document and its audited requirements.",
    `Available actions on this turn: ${availableVerbs.join(", ")}.`,
    reason === 'verification-repair' ? 'Atomic patch syntax (exact CURRENT old bytes; all edits land or none):' : "Line-pointer edit syntax (all fields required; start/end are positive, inclusive line numbers):",
    reason === 'verification-repair'
      ? actionPromptMenuLine('patch', { features: [PATCH_ACTION_FEATURE] })
      : actionPromptMenuLine("edit_lines", { features: [LINE_EDIT_FEATURE] }),
    availableVerbs.includes("read_file")
      ? "If the required current range is omitted or clipped, read_file that exact path/range before editing. Otherwise use the already delivered numbered bytes."
      : "read_file is unavailable on this turn. Use already delivered current bytes for the available edit action; do not guess omitted content. A write_file rewrite is appropriate only when the complete current file is known and write_file is available. If required bytes are missing, do not overwrite unseen content.",
    "Repair only a demonstrated implementation or fixture defect. This interface grants no protected-file permission and is not verification evidence. Existing scope and completion checks still apply.",
  ].join("\n");
  if (text.length > CONTEXT_UPDATE_MAX_CHARS) return null;
  const metadata = { generation, turn, availableVerbs: [...availableVerbs], reason, recoveryPath };
  const digest = crypto.createHash("sha256").update(JSON.stringify(metadata)).update(text).digest("hex");
  return { schema: 1, id: `action-contract:${turn}:${digest}`, kind: "action-contract",
    ...metadata, text, paths: [] };
}

export function actionContractUpdateValid(update) {
  const expected = createActionContractUpdate(update);
  return Boolean(expected && update.schema === expected.schema && update.kind === expected.kind
    && update.id === expected.id && update.text === expected.text
    && Array.isArray(update.paths) && update.paths.length === 0);
}

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
