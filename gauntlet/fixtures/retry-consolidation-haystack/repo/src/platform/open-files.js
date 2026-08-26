// Open-file context — keep the CURRENT contents of files the model is editing in
// view, so it can author exact "replace" edits instead of rewriting whole files
// from stale memory.
//
// Why this exists (bowling analysis, docs/TIMELINE): on a hard task the model kept
// re-emitting the ENTIRE file with write_file and regressed its own passing tests
// (pass count oscillated 11→3→19→29→30). Root cause was structural, not capability:
// the prompt replayed the model's past write_file blobs but never showed the file
// as it exists NOW, so authoring a minimal `replace` (whose "old" must match current
// text byte-for-byte) was harder than a full rewrite. Its two `replace`s both landed
// (0 replace failures across the whole suite) — it just rarely chose them. This panel
// removes the asymmetry by always showing current, line-numbered file state.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { outlineJs, formatOutline } from "./file-outline.js";

const MAX_FILES = Number(process.env.BANTAM_OPEN_FILES) || 4;  // co-edited work files kept visible (a 3-file feature left one invisible at 2)
const MAX_LINES = 200;    // per-file line cap so a large file can't blow the budget
const MAX_LINE_LEN = 400; // per-line clip: minified/data files have pathologically long lines
const MAX_BYTES = 12000;  // hard per-file byte cap; line count alone doesn't bound width
// The live panel is a navigation aid, not a second copy of the repository. A
// former 96KB primary-file default routinely crowded the task, observations,
// and repo map out of a small model's context. Keep the whole panel bounded and
// spend that budget around the lines which actually changed.
const CONTEXT_MAX_BYTES = 16000;
const PRIMARY_MAX_LINES = Math.min(Number(process.env.BANTAM_PRIMARY_FILE_LINES) || 320, 500);
const PRIMARY_MAX_BYTES = Math.min(Number(process.env.BANTAM_PRIMARY_FILE_BYTES) || 12000, CONTEXT_MAX_BYTES);
const SECONDARY_MAX_LINES = Math.min(Number(process.env.BANTAM_SECONDARY_FILE_LINES) || 200, 320);
const SECONDARY_MAX_BYTES = Math.min(Number(process.env.BANTAM_SECONDARY_FILE_BYTES) || 4000, CONTEXT_MAX_BYTES);
const HUNK_CONTEXT_LINES = 28;
const KEEP = 8;           // recency-list depth; render caps how many are shown

// Record that `p` was just edited: move it to the front (most recent), dedup, bound.
export function noteOpenFile(list, p) {
  if (!p || typeof p !== "string") return Array.isArray(list) ? list : [];
  const prev = Array.isArray(list) ? list : [];
  return [p, ...prev.filter((x) => x !== p)].slice(0, KEEP);
}

export function forgetOpenFile(list, p) {
  const prev = Array.isArray(list) ? list : [];
  return prev.filter((entry) => entry !== p);
}

function utf8Bytes(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

function clipUtf8(s, maxBytes, marker) {
  const text = String(s ?? "");
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffix = utf8Bytes(marker) < maxBytes ? marker : "";
  const room = Math.max(0, maxBytes - utf8Bytes(suffix));
  // Buffer slicing can split a multi-byte character. Dropping the one trailing
  // replacement glyph keeps the cap exact and the prompt valid UTF-8.
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD$/, "");
  return `${head}${suffix}`;
}

function normalizedRanges(ranges, totalLines) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .map((range) => {
      const start = Number(Array.isArray(range) ? range[0] : range?.start);
      const end = Number(Array.isArray(range) ? range[1] : (range?.end ?? range?.start));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return {
        start: Math.max(1, Math.min(totalLines, Math.floor(Math.min(start, end)))),
        end: Math.max(1, Math.min(totalLines, Math.floor(Math.max(start, end)))),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

// Select changed lines first, then grow equal context around each hunk. This is
// deterministic and keeps multiple integration seams visible instead of letting
// the first large hunk consume the entire panel.
function focusedLineIndexes(ranges, totalLines, maxLines) {
  const selected = new Set();
  const add = (n) => {
    if (n >= 1 && n <= totalLines && selected.size < maxLines) selected.add(n - 1);
  };
  for (const range of ranges) {
    const width = range.end - range.start + 1;
    if (width <= maxLines) {
      for (let n = range.start; n <= range.end; n += 1) add(n);
    } else {
      const head = Math.ceil(maxLines / 2);
      for (let n = range.start; n < range.start + head; n += 1) add(n);
      for (let n = Math.max(range.start + head, range.end - (maxLines - head) + 1); n <= range.end; n += 1) add(n);
    }
    if (selected.size >= maxLines) break;
  }
  for (let radius = 1; radius <= HUNK_CONTEXT_LINES && selected.size < maxLines; radius += 1) {
    for (const range of ranges) {
      add(range.start - radius);
      add(range.end + radius);
      if (selected.size >= maxLines) break;
    }
  }
  return [...selected].sort((a, b) => a - b);
}

function diffHunks(workspace, rel) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff", "--", rel],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500, maxBuffer: 2 * 1024 * 1024 },
    );
    const ranges = [];
    for (const line of diff.split("\n")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] == null ? 1 : Number(m[2]);
      // A pure deletion has a zero-width new-side hunk. Show its surviving seam.
      ranges.push({ start: Math.max(1, start), end: Math.max(1, start + Math.max(1, count) - 1) });
    }
    return ranges;
  } catch {
    return [];
  }
}

function explicitFocus(focusByPath, rel) {
  if (!focusByPath) return undefined;
  if (focusByPath instanceof Map) return focusByPath.get(rel);
  return focusByPath[rel];
}

function combinedFocus(workspace, rel, focusByPath) {
  const inspected = explicitFocus(focusByPath, rel);
  const changed = diffHunks(workspace, rel);
  // A recent read is a useful navigation window, but it must not displace the
  // source-of-truth Git hunks. That replacement hid earlier edits in large CLI
  // files whenever the model later inspected one narrow range. Rendering both
  // stays bounded by focusedLineIndexes and lets one file expose its parser,
  // dispatch, and help seams together.
  return [
    ...changed,
    ...(Array.isArray(inspected) ? inspected : []),
  ];
}

function priorityLineIndexes(lines, ranges, maxLines = 24) {
  const normalized = normalizedRanges(ranges, lines.length);
  if (!normalized.length) return [];
  const expanded = normalized.map((range) => ({
    start: Math.max(1, range.start - 3),
    end: Math.min(lines.length, range.end + 3),
  }));
  // Unlike the general hunk selector, this is already explicitly expanded by
  // ±3. Do not grow it again to the 24-line cap: a one-line mutation should
  // cost seven lines, not silently become another broad source window.
  const selected = new Set();
  for (const range of expanded) {
    const room = maxLines - selected.size;
    if (room <= 0) break;
    const width = range.end - range.start + 1;
    if (width <= room) {
      for (let line = range.start; line <= range.end; line++) selected.add(line - 1);
      continue;
    }
    const head = Math.ceil(room / 2);
    for (let line = range.start; line < range.start + head; line++) selected.add(line - 1);
    for (let line = range.end - (room - head) + 1; line <= range.end; line++) selected.add(line - 1);
  }
  return [...selected].sort((a, b) => a - b);
}

function prioritySource(lines, indexes) {
  if (!indexes.length) return "";
  const rendered = [];
  let prior = -1;
  for (const index of indexes) {
    if (prior >= 0 && index > prior + 1) rendered.push(`… (lines ${prior + 2}–${index} omitted)`);
    const line = lines[index].length > MAX_LINE_LEN
      ? `${lines[index].slice(0, MAX_LINE_LEN)}… (+${lines[index].length - MAX_LINE_LEN} chars — read_file to page)`
      : lines[index];
    rendered.push(`${index + 1}\t${line}`);
    prior = index;
  }
  return rendered.join("\n");
}

// Line-numbered rendering that matches read_file's `<n>\t<line>` format, so the
// model can reuse a number directly as a "replace" { line } anchor. `focusRanges`
// is optional to preserve the original public API.
export function formatOneFile(rel, content, maxLines = MAX_LINES, maxBytes = MAX_BYTES, {
  focusRanges = [],
  priorityRanges = [],
} = {}) {
  const lines = String(content ?? "").split("\n");
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || MAX_LINES));
  const byteLimit = Math.max(256, Math.min(Math.floor(Number(maxBytes) || MAX_BYTES), CONTEXT_MAX_BYTES));
  const ranges = normalizedRanges(focusRanges, lines.length);
  // A short prose file can still overflow its byte allocation. In that case
  // the accepted mutation seam is just as important as it is in a long source
  // file: without it, a newer tiny artifact can push the current edited line
  // past this file's byte clip while stale claims about that line stay visible.
  const needsPriority = lines.length > lineLimit || utf8Bytes(content) > byteLimit;
  const priorityIndexes = needsPriority
    ? priorityLineIndexes(lines, priorityRanges)
    : [];
  const prioritySet = new Set(priorityIndexes);
  const selectedIndexes = lines.length <= lineLimit
    ? lines.map((_, i) => i)
    : (ranges.length ? focusedLineIndexes(ranges, lines.length, lineLimit) : lines.slice(0, lineLimit).map((_, i) => i));
  // The leading mutation slice is a guarantee, not a second copy. Remove its
  // lines from the ordinary focused view when Git hunks select them too.
  const indexes = selectedIndexes.filter((index) => !prioritySet.has(index));
  const clip = (l) => (l.length > MAX_LINE_LEN ? `${l.slice(0, MAX_LINE_LEN)}… (+${l.length - MAX_LINE_LEN} chars — read_file to page)` : l);
  const rendered = [];
  let prior = -1;
  for (const i of indexes) {
    if (prior >= 0 && i > prior + 1) rendered.push(`… (lines ${prior + 2}–${i} omitted)`);
    else if (prior < 0 && i > 0) rendered.push(`… (lines 1–${i} omitted)`);
    rendered.push(`${i + 1}\t${clip(lines[i])}`);
    prior = i;
  }
  if (prior >= 0 && prior < lines.length - 1 && ranges.length) rendered.push(`… (lines ${prior + 2}–${lines.length} omitted)`);
  const numbered = rendered.join("\n");
  let more = "";
  const shownLines = new Set([...priorityIndexes, ...indexes]).size;
  if (shownLines < lines.length) {
    // On an overflowing JS file, name the symbols past the cap instead of
    // hiding them: a wiring edit needs to know WHERE things live, and paging
    // 200 lines at a time through a 1200-line CLI burns turns (observed on
    // the 2026-07-13 self-hosting run).
    const outline = /\.(js|mjs|cjs)$/.test(rel)
      ? formatOutline(outlineJs(String(content ?? "")), { fromLine: ranges.length ? 1 : lineLimit + 1 })
      : null;
    const omitted = lines.length - shownLines;
    more = outline
      ? `\n… (${omitted} more lines omitted — read_file a specific range; ${outline})`
      : `\n… (${omitted} more lines omitted — use read_file to page the rest)`;
  }
  // Accepted mutations are source truth, not merely navigation hints. Render
  // their tiny current slice first so a wide earlier read cannot consume the
  // byte cap before a later edit line is reached (common in large CLI files).
  const priority = prioritySource(lines, priorityIndexes);
  const priorityBlock = priority ? `\n## accepted mutation seams (current)\n${priority}\n` : "\n";
  let out = `# ${rel} (current, ${lines.length} lines)${priorityBlock}${numbered}${more}`;
  // Final guard: even after per-line clipping, cap total bytes so one file can't dominate.
  out = clipUtf8(out, byteLimit, `\n… (panel truncated at ${byteLimit} bytes — use read_file)`);
  return out;
}

function panelPlan(workspace, openList, {
  maxFiles = MAX_FILES,
  maxLines = MAX_LINES,
  maxBytes = CONTEXT_MAX_BYTES,
  focusByPath,
  mutationFocusByPath,
} = {}) {
  const candidates = [];
  for (const rel of (openList || []).slice(0, maxFiles)) {
    try {
      const content = fs.readFileSync(path.join(workspace, rel), "utf8");
      candidates.push({ rel, content });
    } catch {
      // Deleted/unreadable files do not consume one of the context allocations.
    }
  }

  const total = Math.max(512, Math.min(Number(maxBytes) || CONTEXT_MAX_BYTES, CONTEXT_MAX_BYTES));
  // Weight the newest edited file 4:1 over each older file. If the packet is
  // tight, drop oldest files until every rendered block can receive its real
  // 256-byte minimum; never reserve secondary bytes ahead of the primary.
  let count = candidates.length;
  while (count > 1) {
    const available = total - ((count - 1) * 2);
    if (available >= 256 * (count + 3)) break; // weights: primary=4, each secondary=1
    count--;
  }
  const selected = candidates.slice(0, count);
  let remaining = Math.max(0, total - ((selected.length - 1) * 2));
  let remainingWeight = selected.length + 3;
  return selected.map((file, i) => {
    const weight = i === 0 ? 4 : 1;
    const share = Math.floor(remaining * weight / remainingWeight);
    const ceiling = i === 0 ? PRIMARY_MAX_BYTES : SECONDARY_MAX_BYTES;
    const bytes = Math.max(256, Math.min(ceiling, share));
    remaining = Math.max(0, remaining - bytes);
    remainingWeight -= weight;
    return {
      ...file,
      lines: i === 0 ? Math.max(maxLines, PRIMARY_MAX_LINES) : Math.max(maxLines, SECONDARY_MAX_LINES),
      bytes,
      focusRanges: combinedFocus(workspace, file.rel, focusByPath),
      priorityRanges: explicitFocus(mutationFocusByPath, file.rel),
    };
  });
}

// Render current contents of the most-recently-edited files, read FRESH from disk
// each call so the view is never stale. Unreadable/deleted files are skipped.
export function renderOpenFiles(workspace, openList, options = {}) {
  // Render in a STABLE path order while keeping recency-based selection and the
  // 4:1 byte weighting toward the newest file. The panel sits in the prompt's
  // volatile tail, so if its SEQUENCE follows recency, one new read pushes every
  // other file down and the whole panel's bytes shift -- the prefix then breaks at
  // the panel's first byte rather than at the file that actually changed.
  // Measured on a gpt-5.6-terra run: quiet turns discarded 2,700-5,600 characters
  // of cached prefix, and the discarded region began at the panel start every time.
  const blocks = panelPlan(workspace, openList, options)
    .slice()
    .sort((a, b) => String(a.rel).localeCompare(String(b.rel)))
    .map((file) => formatOneFile(
    file.rel,
    file.content,
    file.lines,
    file.bytes,
    { focusRanges: file.focusRanges, priorityRanges: file.priorityRanges },
  ));
  return blocks.join("\n\n");
}

// Paths rendered COMPLETELY (no truncation) in the panel — their current
// contents are already in the model's context, so a read of them returns
// nothing new. The agent short-circuits such reads (self-hosting v10: 63 of
// 89 reads were of files already fully shown in the panel).
export function fullyRenderedPaths(workspace, openList, options = {}) {
  const full = new Map();
  for (const file of panelPlan(workspace, openList, options)) {
    const rendered = formatOneFile(
      file.rel,
      file.content,
      file.lines,
      file.bytes,
      { focusRanges: file.focusRanges, priorityRanges: file.priorityRanges },
    );
    // A panel can contain every line number while still clipping one very long
    // line. In that case an explicit ranged read carries bytes the panel does
    // not, so its observation must remain in prompt history.
    if (!/more lines omitted|panel truncated|chars — read_file to page/.test(rendered)) {
      full.set(file.rel, String(file.content).split("\n").length);
    }
  }
  return full;
}

// Paths whose current contents can actually appear in the panel. Prompt history uses this
// list to replace stale read_file dumps with a pointer to the fresher live copy.
export function renderedOpenPaths(workspace, openList, { maxFiles = MAX_FILES } = {}) {
  const paths = [];
  for (const rel of (openList || []).slice(0, maxFiles)) {
    try {
      const fullPath = path.join(workspace, rel);
      if (!fs.statSync(fullPath).isFile()) continue;
      fs.accessSync(fullPath, fs.constants.R_OK);
      paths.push(rel);
    } catch {
      // Deleted or unreadable files are skipped by renderOpenFiles too.
    }
  }
  return paths;
}
