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

// Twelve lets two adjacent six-file inspect batches coexist for small-module
// migrations. The packet still has a hard 16K source budget, so this increases
// path coverage rather than prompt size; large files receive bounded slices.
const MAX_FILES = Number(process.env.BANTAM_OPEN_FILES) || 12;
const MAX_LINES = 400;    // per-file line cap so a large file can't blow the budget
const MAX_LINE_LEN = 400; // per-line clip: minified/data files have pathologically long lines
const MAX_BYTES = 24000;  // hard per-file byte cap; line count alone doesn't bound width
// The live panel is a navigation aid, not a second copy of the repository. A
// former 96KB primary-file default routinely crowded the task, observations,
// and repo map out of a small model's context. Keep the whole panel bounded and
// spend that budget around the lines which actually changed.
// Measured 2026-08-15 (trio ticket A, then a paired rerun): at 16000 the panel
// could not render the three files the ticket required — gate-policy.js
// (11.2KB) + done-gates.js (8.0KB) + gate-rejection-counts.js (3.3KB) = 22.5KB
// against a 16KB whole-panel budget — so every entry was a fragment, and the
// local model spent 22 of 30 turns re-reading, six of them the IDENTICAL range
// of gate-policy.js, and never finished the ticket. A fragment is the worst
// panel state: it costs bytes and still forces the read.
//
// The old value was tuned for a local model with far less room ("a former 96KB
// primary-file default routinely crowded the task out"). The dogfood model now
// serves 72k context and the failing run's whole prompt was 40k, so a third of
// the window was paid for and unused. Budget the panel against the window that
// actually exists; BANTAM_PANEL_BYTES overrides for smaller servers.
const CONTEXT_MAX_BYTES = Math.max(4000, Number(process.env.BANTAM_PANEL_BYTES) || 48000);
const PRIMARY_MAX_LINES = Math.min(Number(process.env.BANTAM_PRIMARY_FILE_LINES) || 600, 900);
const PRIMARY_MAX_BYTES = Math.min(Number(process.env.BANTAM_PRIMARY_FILE_BYTES) || 24000, CONTEXT_MAX_BYTES);
const SECONDARY_MAX_LINES = Math.min(Number(process.env.BANTAM_SECONDARY_FILE_LINES) || 400, 600);
const SECONDARY_MAX_BYTES = Math.min(Number(process.env.BANTAM_SECONDARY_FILE_BYTES) || 16000, CONTEXT_MAX_BYTES);
const HUNK_CONTEXT_LINES = 28;
const KEEP = 16;          // path-only recency depth; the byte-bounded renderer caps what is shown

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
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce(coalesceNearby, []);
}

// Two focus ranges a few lines apart describe ONE working region, and the gap
// between them is the most likely place for the next edit.
//
// tb9 turn 33 (2026-08-16, .bantam/runs/2026-08-16T18-34-07-754Z.json): the
// model issued edit_lines on 5283-5293 while the panel showed
// [[245,290],[5271,5282],[5294,5305]] — its two previous mutation seams, with a
// hole exactly where it was now editing. Each range was expanded by its own
// small radius, which cannot close an 11-line gap, so the seam it was working
// in was the one thing it could not see. The recorder logged
// edit-target-partial on that turn and the two after it.
const FOCUS_MERGE_GAP_LINES = 40;

function coalesceNearby(merged, range) {
  const last = merged[merged.length - 1];
  if (last && range.start - last.end - 1 <= FOCUS_MERGE_GAP_LINES) {
    last.end = Math.max(last.end, range.end);
    return merged;
  }
  merged.push({ ...range });
  return merged;
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

// 24 was too tight once nearby seams coalesce into one working region: tb9's
// merged 5271-5305 expands to 41 lines, overflows, and gets head/tail split —
// reproducing the very hole the merge was meant to close, with the model's
// current edit line inside the omitted middle. Frugality for a SINGLE small
// mutation is enforced by the ±3 expansion, not by this cap (a one-line edit
// still costs seven lines); the cap only binds when seams are many or wide, and
// there a contiguous view of the active region beats a punctured one.
function priorityLineIndexes(lines, ranges, maxLines = 48) {
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

function prioritySource(lines, indexes, bodySet = EMPTY_INDEX_SET) {
  if (!indexes.length) return "";
  const rendered = [];
  let prior = -1;
  for (const index of indexes) {
    if (prior >= 0 && index > prior + 1) {
      rendered.push(...omissionMarkers(prior + 1, index - 1, bodySet, "shown below in the file body"));
    }
    const line = lines[index].length > MAX_LINE_LEN
      ? `${lines[index].slice(0, MAX_LINE_LEN)}… (+${lines[index].length - MAX_LINE_LEN} chars — read_file to page)`
      : lines[index];
    rendered.push(`${index + 1}\t${line}`);
    prior = index;
  }
  return rendered.join("\n");
}

// A hole in the BODY is not always a hole in the PANEL. Mutation-seam lines are
// filtered out of the body view so they are not printed twice, which leaves a
// gap the marker loop would otherwise report as "omitted" — while the seam block
// renders those very lines a few rows above. Measured on tc1 (2026-08-17): the
// panel printed lines 81–89 under "accepted mutation seams", then announced
// "… (lines 81–89 omitted)". Lines 84–85 were the two the model had just edited,
// so it re-read the range it had already been shown; the repetition guard
// refused the read as revealing "nothing new", and the run spent two further
// turns searching to confirm an edit that was on screen the whole time.
// Name only what the panel genuinely lacks, and point at where the rest went.
const EMPTY_INDEX_SET = new Set();
const SEAM_ABOVE = 'shown above under "accepted mutation seams"';

// It runs in both directions: the body defers to the seam block above it, and
// the seam block defers to the body below it.
function omissionMarkers(fromIndex, toIndex, elsewhere, where) {
  if (toIndex < fromIndex) return [];
  const runs = [];
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const present = elsewhere.has(index);
    const last = runs[runs.length - 1];
    if (last && last.present === present && last.end === index - 1) last.end = index;
    else runs.push({ start: index, end: index, present });
  }
  return runs.map((run) => (run.present
    ? `… (lines ${run.start + 1}–${run.end + 1} ${where})`
    : `… (lines ${run.start + 1}–${run.end + 1} omitted)`));
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
    if (prior >= 0 && i > prior + 1) rendered.push(...omissionMarkers(prior + 1, i - 1, prioritySet, SEAM_ABOVE));
    else if (prior < 0 && i > 0) rendered.push(...omissionMarkers(0, i - 1, prioritySet, SEAM_ABOVE));
    rendered.push(`${i + 1}\t${clip(lines[i])}`);
    prior = i;
  }
  if (prior >= 0 && prior < lines.length - 1 && ranges.length) rendered.push(...omissionMarkers(prior + 1, lines.length - 1, prioritySet, SEAM_ABOVE));
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
  const priority = prioritySource(lines, priorityIndexes, new Set(indexes));
  const priorityBlock = priority ? `\n## accepted mutation seams (current)\n${priority}\n` : "\n";
  // The outline is NAVIGATION for a file too large to render — the only way to
  // find a symbol past the cap without paging blindly. Appending it after the
  // body put it exactly where the byte cap eats it: measured 2026-08-15, the
  // panel showed bin/bantam.js lines 1-135 of 4718 (its import block) and the
  // outline was truncated away, so a run asked to wire a new subcommand read
  // that file 54 times hunting the dispatch site. Render it BEFORE the body.
  const outlineBlock = more.includes("read_file a specific range;")
    ? `\n## outline (symbols past the rendered slice)\n${more.replace(/^\n… \(\d+ more lines omitted — read_file a specific range; /, "").replace(/\)$/, "")}\n`
    : "";
  const bodyTail = outlineBlock ? "\n… (body clipped — read_file a specific range)" : more;
  let out = `# ${rel} (current, ${lines.length} lines)${outlineBlock}${priorityBlock}${numbered}${bodyTail}`;
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
  editedPaths = null,
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

  // Allocate to what the model is CHANGING before what it merely read.
  //
  // tb4 (2026-08-16, .bantam/runs/2026-08-16T16-16-10-688Z.json): at turn 16
  // src/fixture-runner.js was COMPLETE in the panel; at turn 17 the model
  // issued a `replace` against it and the file was gone entirely — two test
  // files it had just read had displaced it under the drop-rather-than-fragment
  // rule. The flight recorder logged edit-target-absent on turns 17, 38, 39 and
  // 40, each an edit authored against a file the model could not see. Recency
  // of READS was outranking the edit target itself.
  //
  // Reads are cheap to repeat; a blind edit is not. Sorting is stable, so
  // recency order still decides within each group, and render order is
  // unaffected (renderOpenFiles sorts by path for prefix stability).
  // A mutation focus is perishable: it is dropped whenever the edit's new text
  // cannot be located afterwards, and the file silently stops counting as an
  // edit target. Having been EDITED in this run does not perish. tb11 turn 62
  // edited src/fixture-runner.js, already edited earlier in the same run, with
  // the file absent from the panel.
  const editTargets = new Set(
    mutationFocusByPath instanceof Map
      ? mutationFocusByPath.keys()
      : Object.keys(mutationFocusByPath ?? {}),
  );
  for (const rel of (editedPaths instanceof Set ? editedPaths : (editedPaths ?? []))) editTargets.add(rel);
  if (editTargets.size) {
    candidates.sort((a, b) => (editTargets.has(b.rel) ? 1 : 0) - (editTargets.has(a.rel) ? 1 : 0));
  }

  const total = Math.max(512, Math.min(Number(maxBytes) || CONTEXT_MAX_BYTES, CONTEXT_MAX_BYTES));
  // Completion beats weight. A file too large to render completely at ANY
  // budget (bin/bantam.js, 218KB) gains nothing from a bigger slice — it stays
  // a fragment either way — while a file that CAN be completed stops being
  // re-read the moment it is whole. Measured 2026-08-15 (ticket A): the giant
  // held the 4x primary weight and starved gate-policy.js (11.2KB) into a
  // fragment the model then re-read six times at the identical range.
  //
  // So: give un-completable files a bounded seam budget (their mutation seams
  // and outline are still the useful part), and spend everything else
  // completing the files that fit, newest first.
  const SEAM_BUDGET = Math.min(6000, Math.floor(total / 4));
  // Rendered size, not raw size: every line gains a "N\t" prefix and the entry
  // gains a header. Underestimating here allocates just under what the render
  // needs and the byte cap truncates a file that was meant to be complete.
  const sizeOf = (file) => {
    const text = String(file.content ?? "");
    const lineCount = text.split("\n").length;
    return Buffer.byteLength(text, "utf8") + (lineCount * 8) + file.rel.length + 512;
  };
  // What decides completability is the panel's OWN budget, not the per-file
  // default. PRIMARY_MAX_BYTES shapes files that must be clipped; using it as
  // the completion test makes a file that fits the panel permanently partial.
  // Ticket B (2026-08-16): src/fixture-runner.js needs 36,112 rendered bytes,
  // the panel had 48,000, the constant said 24,000 — so it rendered partial on
  // all 54 turns it appeared and the run's completeOpenFileResidencies was 0
  // across 60 turns, with the model re-reading what it already half-had.
  const completable = (file) => sizeOf(file) <= total;
  if (candidates.some((file) => !completable(file))) {
    let remainingBytes = total;
    const plan = [];
    // Un-completable files first, at their capped seam budget.
    for (const file of candidates) {
      if (completable(file)) continue;
      const bytes = Math.min(SEAM_BUDGET, Math.max(256, remainingBytes));
      remainingBytes = Math.max(0, remainingBytes - bytes);
      plan.push({ file, bytes });
    }
    // Then complete as many of the rest as the remaining budget allows.
    //
    // "Drop rather than fragment" is right for a file the model merely read —
    // a fragment invites a re-read — but wrong for one it is EDITING. Skipping
    // a large edit target and then spending its budget on smaller neighbours is
    // how the panel loses the file the model is working in: tb11 turn 62
    // (.bantam/runs/2026-08-16T19-21-23-939Z.json) rendered src/agent.js,
    // src/scope-guard.js and a test file while src/fixture-runner.js — edited
    // earlier that same run and about to be edited again — was absent entirely.
    // A fragment of the file under the cursor beats its absence.
    const EDIT_TARGET_FLOOR = 4000;
    for (const file of candidates) {
      if (!completable(file)) continue;
      const want = sizeOf(file);
      if (want <= remainingBytes) {
        remainingBytes -= want;
        plan.push({ file, bytes: want, complete: true });
        continue;
      }
      if (editTargets.has(file.rel) && remainingBytes >= EDIT_TARGET_FLOOR) {
        plan.push({ file, bytes: remainingBytes });     // fragment, but present
        remainingBytes = 0;
      }
    }
    // Second pass: hand the remainder to the files that could not be completed.
    // Capping them at the seam floor while budget goes unspent is how ticket B
    // ended with 10KB unused and BOTH files it had to edit clipped to 6KB
    // (measured 2026-08-16). Distribute evenly, up to each file's own ceiling.
    const oversized = plan.filter(({ file }) => !completable(file));
    if (oversized.length && remainingBytes > 0) {
      const share = Math.floor(remainingBytes / oversized.length);
      for (const entry of oversized) {
        // Bound by the panel, not the per-file default: these bytes are already
        // spare, and clipping a seam to 24KB while 18KB goes unused is the same
        // unspent-budget defect in a different place.
        const ceiling = Math.min(total, sizeOf(entry.file));
        const extra = Math.max(0, Math.min(share, ceiling - entry.bytes));
        entry.bytes += extra;
        remainingBytes -= extra;
      }
    }
    const order = new Map(candidates.map((file, i) => [file.rel, i]));
    return plan
      .sort((a, b) => order.get(a.file.rel) - order.get(b.file.rel))
      .map(({ file, bytes, complete }, i) => ({
        ...file,
        // A file planned as complete must not be clipped by the LINE cap after
        // surviving the byte test — 668 lines against a 600-line primary cap is
        // still a fragment, and a fragment is what gets re-read.
        lines: complete
          ? String(file.content ?? "").split("\n").length
          : (i === 0 ? Math.max(maxLines, PRIMARY_MAX_LINES) : Math.max(maxLines, SECONDARY_MAX_LINES)),
        bytes,
        focusRanges: combinedFocus(workspace, file.rel, focusByPath),
        priorityRanges: explicitFocus(mutationFocusByPath, file.rel),
      }));
  }
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
    const want = sizeOf(file);
    // Completing a file its share can afford beats holding it to the per-file
    // default. The default shapes fragments; a fragment is what gets re-read.
    const ceiling = Math.max(i === 0 ? PRIMARY_MAX_BYTES : SECONDARY_MAX_BYTES, Math.min(want, share));
    const bytes = Math.max(256, Math.min(ceiling, share));
    const complete = bytes >= want;
    remaining = Math.max(0, remaining - bytes);
    remainingWeight -= weight;
    return {
      ...file,
      // Surviving the byte test and then losing the tail to the LINE cap is
      // still a fragment (668 lines against a 600-line cap, ticket B).
      lines: complete
        ? String(file.content ?? "").split("\n").length
        : (i === 0 ? Math.max(maxLines, PRIMARY_MAX_LINES) : Math.max(maxLines, SECONDARY_MAX_LINES)),
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
    // Edit targets render FIRST, then the rest by path. The whole-panel clip
    // below eats the TAIL, and alphabetical order put the file under active
    // edit (enc.py) after the read-only inputs (data.txt, decomp.c) -- so the
    // one file the model was editing was the one clipped, its replace missed
    // ("matches up to line 92, then DIVERGES"), and it fell back to a full
    // rewrite. write-compressor 2026-08-23, wc-oracle t14->t16. The edit-target
    // set changes rarely, so this costs the prefix only when it changes; a
    // clipped edit target costs a blind rewrite every time.
    const editFirst = new Set([
      ...(options?.editedPaths instanceof Set ? options.editedPaths : (options?.editedPaths ?? [])),
      ...(options?.mutationFocusByPath instanceof Map ? options.mutationFocusByPath.keys() : Object.keys(options?.mutationFocusByPath ?? {})),
    ]);
    const blocks = panelPlan(workspace, openList, options)
      .slice()
      .sort((a, b) => {
        const ea = editFirst.has(a.rel) ? 0 : 1;
        const eb = editFirst.has(b.rel) ? 0 : 1;
        return ea - eb || String(a.rel).localeCompare(String(b.rel));
      })
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

// Candidate paths that exist and are readable — NOT the entries the panel ends
// up emitting, which depend on a byte budget chosen later by
// compileContextPacket. agent.js needed the latter and used this, so a file the
// packet dropped was treated as resident and reads of it were refused
// (tb21, 2026-08-17). It now parses the emitted packet instead; this remains for
// callers that genuinely want the candidate list.
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
