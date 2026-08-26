// Sharp test-failure feedback — the "read the error, fix THIS test" half of the write→run→edit loop.
//
// A small model handed the raw `node --test` dump (a wall of `ok` lines around one `not ok`) often
// can't find the signal, so it edits blindly and never converges even when it is one assertion away.
// This turns that dump into a focused steer: for each failing test, the exact expected-vs-actual AND
// the test's own source, so the model can trace why its code produces the wrong value and fix it.

import fs from "node:fs";
import path from "node:path";

const FOCUS_TAG = "[fix-tests]";

/** Parse pass/fail counts from a test run. Returns { passed, failed, total } or null. */
export function parseTestCounts(output) {
  const t = String(output ?? "");
  const p = t.match(/^\s*#\s*pass\s+(\d+)\s*$/m);
  const f = t.match(/^\s*#\s*fail\s+(\d+)\s*$/m);
  if (p && f) {
    // A CANCELLED test is a test that hung and was killed by --test-timeout. node
    // reports it under `# cancelled`, NOT `# fail`, so reading only pass/fail
    // calls a timed-out run "all passed" — a green verdict on an exit-1 failure.
    // v34 sat stuck 14 turns because the harness told it its hanging tests passed.
    // A cancelled test did not pass; count it as failed.
    const c = t.match(/^\s*#\s*cancelled\s+(\d+)\s*$/m);
    const cancelled = c ? Number(c[1]) : 0;
    const passed = Number(p[1]);
    const failed = Number(f[1]) + cancelled;
    return { passed, failed, total: passed + failed, ...(cancelled ? { cancelled } : {}) };
  }
  const nm = t.match(/(\d+)\s*\/\s*(\d+)\s+tests?\s+passed/i);
  if (nm) return { passed: Number(nm[1]), failed: Number(nm[2]) - Number(nm[1]), total: Number(nm[2]) };
  // perl `prove` failure summary — must precede the generic passed/failed branch, whose
  // "(\d+) failed" would read "Tests: 2 Failed: 1" as TWO failures.
  const prove = t.match(/\bTests:\s*(\d+)\s+Failed:\s*(\d+)\b/);
  if (prove) { const total = Number(prove[1]), failed = Number(prove[2]); return { passed: total - failed, failed, total }; }
  // jest/vitest print a per-SUITE line ("Test Suites: 1 failed" / "Test Files  1 failed") BEFORE the
  // per-test totals — a whole-text "(\d+) failed" grabs the suite count. Scope to the "Tests" line.
  const testsLine = t.match(/^\s*Tests:?\s+(.+)$/m);
  const counted = testsLine ? testsLine[1] : t;
  const pp = counted.match(/\b(\d+)\s+passed\b/i);
  const ff = counted.match(/\b(\d+)\s+failed\b/i);
  if (pp || ff) { const passed = pp ? Number(pp[1]) : 0, failed = ff ? Number(ff[1]) : 0; return { passed, failed, total: passed + failed }; }
  // go test -v: count top-level "--- PASS/FAIL:" lines. Subtests are INDENTED ("    --- FAIL:"), so an
  // anchored ^ counts each test function once — the stable denominator the regression guard needs.
  const goPass = (t.match(/^--- PASS: /gm) || []).length;
  const goFail = (t.match(/^--- FAIL: /gm) || []).length;
  if (goPass || goFail) return { passed: goPass, failed: goFail, total: goPass + goFail };
  // bun test: bare " N pass" / " N fail" summary lines (no "passed"/"failed" words at all).
  const bunPass = t.match(/^\s*(\d+) pass$/m);
  const bunFail = t.match(/^\s*(\d+) fail$/m);
  if (bunPass && bunFail) {
    const passed = Number(bunPass[1]), failed = Number(bunFail[1]);
    return { passed, failed, total: passed + failed };
  }
  // perl `prove` all-pass summary: "Files=1, Tests=2" + "Result: PASS". (The failing-summary
  // "Tests: N Failed: M" branch sits above the generic passed/failed matcher.)
  const proveOk = t.match(/^Files=\d+, Tests=(\d+)/m);
  if (proveOk && /^Result: PASS$/m.test(t)) return { passed: Number(proveOk[1]), failed: 0, total: Number(proveOk[1]) };
  // Raw TAP plan fallback (perl Test::More and any plain TAP emitter): a "1..N" plan with bare
  // ok / not ok lines and no runner summary. Anchored ^ so nested/indented subtest lines don't
  // double-count. Last resort — every runner-specific branch above is more authoritative.
  if (/^1\.\.\d+$/m.test(t)) {
    const okCount = (t.match(/^ok \d+/gm) || []).length;
    const notOk = (t.match(/^not ok \d+/gm) || []).length;
    if (okCount || notOk) return { passed: okCount, failed: notOk, total: okCount + notOk };
  }
  return null;
}

/** Parse a test run into failing tests: { name, file, line, expected, actual, diff }. Dispatches on
 *  the runner's output format: node --test / TAP, pytest, go test, vitest, jest, cargo test. Each
 *  parser is validated against REAL runner output — synthetic samples lie (the go -v ordering trap). */
export function parseTestFailures(output) {
  const text = String(output ?? "");
  // perl Test::More before the generic TAP branch: raw perl output has `not ok` lines too, but its
  // location/diff live in "#   Failed test ... at FILE line N." comments the node parser can't read
  // (and `prove` output has the comments WITHOUT the not-ok lines).
  if (/^#\s+Failed test\b/m.test(text)) return parsePerlFailures(text);
  if (/^\s*not ok \d+ - /m.test(text)) return parseNodeFailures(text);
  if (/^FAILED\s+\S+::/m.test(text) || /={3,}\s*FAILURES\s*={3,}/.test(text)) return parsePytestFailures(text);
  if (/^\s*--- FAIL: /m.test(text)) return parseGoFailures(text);
  if (/^\s*FAIL\s+\S+\s+>\s+/m.test(text)) return parseVitestFailures(text);
  if (/^\s*●\s+\S/m.test(text) && /^\s*(?:Expected|Received)[:\s]/m.test(text)) return parseJestFailures(text);
  if (/^test \S+ \.\.\. FAILED$/m.test(text)) return parseCargoFailures(text);
  if (/^\(fail\) /m.test(text)) return parseBunFailures(text);
  return parseNodeFailures(text);
}

// bun test: an inline "error: expect(received).toBe(expected)" with jest-style Expected:/Received:
// and an "at ... (file:LINE:col)" stack line, then a "(fail) test name [1.00ms]" marker AFTER the
// detail block. Scan backward from each (fail) marker for its detail.
function parseBunFailures(text) {
  const fails = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\(fail\) (.+?)(?:\s+\[[\d.]+m?s\])?\s*$/);
    if (!m) continue;
    let file = null, line = null, actual = null, expected = null;
    for (let j = i - 1; j >= 0 && j > i - 20; j--) {
      if (/^\(fail\) |^\(pass\) /.test(lines[j])) break;
      const loc = lines[j].match(/^\s*at .*\((\S+?):(\d+)(?::\d+)?\)\s*$/);
      if (loc && line === null && !/node_modules/.test(loc[1])) { file = loc[1]; line = Number(loc[2]); }
      const ex = lines[j].match(/^\s*Expected:\s*(.+?)\s*$/);
      if (ex && expected === null) expected = ex[1];
      const re = lines[j].match(/^\s*Received:\s*(.+?)\s*$/);
      if (re && actual === null) actual = re[1];
    }
    fails.push({
      name: m[1], file, line, actual, expected,
      diff: actual !== null || expected !== null ? [`+ ${actual ?? "?"}`, `- ${expected ?? "?"}`] : [],
    });
  }
  return fails;
}

// perl Test::More (raw `perl t/x.t` or via `prove`): each failure prints a comment block —
//   #   Failed test 'name'
//   #   at t/x.t line 5.
//   #          got: '-1'
//   #     expected: '5'
function parsePerlFailures(text) {
  const fails = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+Failed test '(.+)'\s*$/) ?? lines[i].match(/^#\s+Failed test\b.*$/);
    if (!m) continue;
    let name = m[1] ?? null, file = null, line = null, actual = null, expected = null;
    for (let j = i + 1; j < lines.length && j < i + 8; j++) {
      if (/^#\s+Failed test\b/.test(lines[j])) break;
      const loc = lines[j].match(/^#\s+at (\S+) line (\d+)\.?\s*$/);
      if (loc) { file = loc[1]; line = Number(loc[2]); }
      const got = lines[j].match(/^#\s+got:\s*(.+?)\s*$/);
      if (got) actual = got[1].replace(/^'(.*)'$/, "$1");
      const exp = lines[j].match(/^#\s+expected:\s*(.+?)\s*$/);
      if (exp) expected = exp[1].replace(/^'(.*)'$/, "$1");
    }
    fails.push({
      name: name ?? `${file ?? "test"}:${line ?? "?"}`, file, line, actual, expected,
      diff: actual !== null || expected !== null ? [`+ ${actual ?? "?"}`, `- ${expected ?? "?"}`] : [],
    });
  }
  return fails;
}

// vitest: " FAIL  file > test name" header, an "AssertionError: expected X to be Y" message, a
// "- Expected / + Received" diff (same polarity as ours: + is what the code produced), and the
// assert location as " ❯ file:LINE:col".
function parseVitestFailures(text) {
  const fails = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/);
    if (!m) continue;
    const file = m[1];
    let line = null, actual = null, expected = null;
    for (let j = i + 1; j < lines.length && j < i + 30; j++) {
      if (/^\s*FAIL\s+\S+\s+>\s+/.test(lines[j])) break;
      const ae = lines[j].match(/expected (.+?) to (?:be|equal|deeply equal|strictly equal) (.+?)(?:\s*\/\/.*)?$/);
      if (ae && actual === null) { actual = ae[1].trim(); expected = ae[2].trim(); }
      const de = lines[j].match(/^\s*- (.+)$/);   // "- Expected" block line
      const dr = lines[j].match(/^\s*\+ (.+)$/);  // "+ Received" block line
      if (de && de[1] !== "Expected" && expected === null) expected = de[1].trim();
      if (dr && dr[1] !== "Received" && actual === null) actual = dr[1].trim();
      const loc = lines[j].match(/❯\s+(\S+?):(\d+)(?::\d+)?\s*$/);
      if (loc && line === null && loc[1] === file) line = Number(loc[2]);
    }
    fails.push({
      name: m[2], file, line, actual, expected,
      diff: actual !== null || expected !== null ? [`+ ${actual ?? "?"}`, `- ${expected ?? "?"}`] : [],
    });
  }
  return fails;
}

// jest: "FAIL ./file" header, "● test name" per failure, "Expected: X / Received: Y", and the assert
// location in a stack line "at ... (file:LINE:col)".
function parseJestFailures(text) {
  const fails = [];
  const lines = text.split("\n");
  const header = text.match(/^FAIL\s+(\S+)/m);
  const headerFile = header ? header[1].replace(/^\.\//, "") : null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*●\s+(.+?)\s*$/);
    if (!m || /^Console$/.test(m[1])) continue;
    let file = headerFile, line = null, actual = null, expected = null;
    for (let j = i + 1; j < lines.length && j < i + 30; j++) {
      if (/^\s*●\s+/.test(lines[j]) || /^(Test Suites|Tests):/.test(lines[j])) break;
      const ex = lines[j].match(/^\s*Expected:\s*(.+?)\s*$/);
      const re = lines[j].match(/^\s*Received:\s*(.+?)\s*$/);
      if (ex && expected === null) expected = ex[1];
      if (re && actual === null) actual = re[1];
      const loc = lines[j].match(/^\s*at .*\((\S+?):(\d+)(?::\d+)?\)\s*$/);
      if (loc && line === null && !/node_modules/.test(loc[1])) { file = loc[1].replace(/^\.\//, ""); line = Number(loc[2]); }
    }
    fails.push({
      name: m[1], file, line, actual, expected,
      diff: actual !== null || expected !== null ? [`+ ${actual ?? "?"}`, `- ${expected ?? "?"}`] : [],
    });
  }
  return fails;
}

// cargo test: "test path::name ... FAILED", then a "---- path::name stdout ----" block with
// "panicked at src/file.rs:LINE:col:" and assert_eq!'s "left: X / right: Y" (left is what the code
// produced, right the expectation).
function parseCargoFailures(text) {
  const fails = [];
  for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) {
    const name = m[1];
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = text.match(new RegExp(`^---- ${esc} stdout ----$([\\s\\S]*?)(?=^----|^failures:|^test result:)`, "m"));
    let file = null, line = null, actual = null, expected = null, msg = "";
    if (block) {
      const loc = block[1].match(/panicked at (\S+?\.rs):(\d+)(?::\d+)?/);
      if (loc) { file = loc[1]; line = Number(loc[2]); }
      const lr = block[1].match(/left:\s*(.+)\n\s*right:\s*(.+?)\s*$/m);
      if (lr) { actual = lr[1].trim(); expected = lr[2].trim(); }
      else { msg = (block[1].split("\n").map((l) => l.trim()).find((l) => l && !/panicked at|RUST_BACKTRACE/.test(l)) ?? ""); }
    }
    fails.push({
      name, file, line, actual, expected,
      diff: actual !== null ? [`+ ${actual}`, `- ${expected}`] : (msg ? [msg] : []),
    });
  }
  return fails;
}

// go test: "--- FAIL: TestName" paired with an indented "file.go:LINE: message" (the t.Errorf output).
// The location's POSITION depends on -v: plain `go test` buffers it BELOW the FAIL header; `go test -v`
// (the scoped-verify command) streams it ABOVE, between `=== RUN Name` and `--- FAIL:`. Handle both.
function parseGoFailures(text) {
  const lines = text.split("\n");
  const fails = [];
  const isMarker = (s) => /^\s*(?:--- (?:FAIL|PASS|SKIP):|=== (?:RUN|PAUSE|CONT|NAME)|PASS|FAIL|ok|SKIP)\b/.test(s);
  const locOf = (s) => s.match(/^\s+([^\s:]+\.go):(\d+):\s*(.*)$/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*--- FAIL:\s+(\S+)/);
    if (!m) continue;
    let file = null, line = null, msg = "";
    for (let j = i + 1; j < lines.length && j < i + 12; j++) {   // non-verbose: location below the header
      if (isMarker(lines[j])) break;
      const loc = locOf(lines[j]);
      if (loc) { file = loc[1]; line = Number(loc[2]); msg = loc[3].trim(); break; }
    }
    for (let j = i - 1; !file && j >= 0 && j > i - 12; j--) {     // verbose: location above, since `=== RUN`
      if (/^\s*=== RUN\b/.test(lines[j]) || /^\s*--- (?:FAIL|PASS|SKIP):/.test(lines[j])) break;
      const loc = locOf(lines[j]);
      if (loc) { file = loc[1]; line = Number(loc[2]); msg = loc[3].trim(); break; }
    }
    // Go messages are free-form; try common "got X, want Y" / "= X, want Y" shapes for a clean diff.
    const gw = msg.match(/(?:got|=)\s*(.+?),?\s*want(?:ed)?\s+(.+?)\s*$/i) || msg.match(/expected\s+(.+?),?\s*got\s+(.+?)\s*$/i);
    fails.push({
      name: m[1], file, line,
      actual: gw ? gw[1].trim() : null,
      expected: gw ? gw[2].trim() : null,
      diff: gw ? [`+ ${gw[1].trim()}`, `- ${gw[2].trim()}`] : (msg ? [msg] : []),
    });
  }
  return fails;
}

// pytest: a `FAILED path::test_name - reason` summary line, with the assert location taken from the
// detailed FAILURES block ("____ test_name ____" … "file.py:LINE: AssertionError").
function parsePytestFailures(text) {
  const lines = text.split("\n");
  const locByName = new Map();
  let cur = null;
  for (const L of lines) {
    const hdr = L.match(/^_{3,}\s*(\S.*?\S|\S)\s*_{3,}\s*$/);
    if (hdr) { cur = hdr[1].trim().replace(/\[.*\]$/, ""); continue; }
    const loc = L.match(/^([^\s:]+\.py):(\d+):\s/);
    if (loc && cur) locByName.set(cur, { file: loc[1], line: Number(loc[2]) });
  }
  const fails = [];
  for (const L of lines) {
    const m = L.match(/^FAILED\s+(\S+?)::(\S+?)(?:\s+-\s+(.*))?\s*$/);
    if (!m) continue;
    const file = m[1];
    const name = m[2].replace(/\[.*\]$/, "");
    const reason = (m[3] || "").trim();
    const loc = locByName.get(name);
    const a = reason.match(/assert\s+(.+?)\s*==\s*(.+)$/) || reason.match(/^(.+?)\s*!=\s*(.+)$/);
    fails.push({
      name, file, line: loc?.line ?? null,
      actual: a ? a[1].trim() : null,
      expected: a ? a[2].trim() : null,
      diff: a ? [`+ ${a[1].trim()}`, `- ${a[2].trim()}`] : (reason ? [reason] : []),
    });
  }
  return fails;
}

/** Parse node --test / TAP output into failing tests. */
function parseNodeFailures(output) {
  const lines = String(output ?? "").split("\n");
  const fails = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+?)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^# /.test(name) || name.length > 200) continue;
    let file = null, line = null, expected = null, actual = null;
    const diff = [];
    for (let j = i + 1; j < lines.length && j < i + 45; j++) {
      const L = lines[j];
      // Long test observations preserve a head and tail separated by an explicit
      // lossy-clipping marker. Never carry a test block across that seam: the
      // retained tail may belong to a different failure, and merging its
      // location/diff into the head test creates false causal context.
      if (isLossyTestOutputBoundary(L)) break;
      if (/^\s*(?:not )?ok \d+ - /.test(L)) break;          // next test block
      const loc = L.match(/location:\s*'([^']+):(\d+):\d+'/);
      if (loc) { file = loc[1]; line = Number(loc[2]); continue; }
      const exp = L.match(/^\s*expected:\s*(.+?)\s*$/);      // single-line "expected: X"
      if (exp && exp[1]) { expected = exp[1]; continue; }
      const act = L.match(/^\s*actual:\s*(.+?)\s*$/);
      if (act && act[1]) { actual = act[1]; continue; }
      // diff lines like "+   version: 1" / "-   version: 2" (skip the "+ actual - expected" header).
      // Cap the count so a giant object/Promise dump doesn't flood the steer.
      if (diff.length < 8 && /^\s*[+-]\s+\S/.test(L) && !/actual - expected/.test(L)) diff.push(L.trim());
    }
    fails.push({ name, file, line, expected, actual, diff });
  }
  return fails;
}

function isLossyTestOutputBoundary(line) {
  return /test output digest:\s*(?:skipped|preserved tail)|verification output clipped;\s*tail preserved|\[\d+ chars clipped\]/i.test(String(line ?? ""));
}

/** Extract the test body containing (1-based) startLine. Handles JS `test('…', …)` blocks (brace
 *  balanced) AND Python `def test_…():` blocks (indentation). For pytest, startLine is the failing
 *  assert, not the declaration, so we first scan up to the enclosing definition. */
export function extractTestBlock(source, startLine, { maxLines = 45, lang } = {}) {
  const lines = String(source ?? "").split("\n");
  if (startLine < 1 || startLine > lines.length) return null;
  const pyDecl = /^\s*(?:async\s+)?def\s+\w+/;
  const goDecl = /^\s*func\s+\w+\s*\(/;
  const rsDecl = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/;
  const jsDecl = /(?:^|[\s.=(])(?:test|it)\s*\(|(?:async\s+)?function\s+\w+|=>\s*\{?\s*$/;
  // Prefer the explicit lang (from the file extension); fall back to source heuristics.
  if (!lang) {
    if (pyDecl.test(lines[startLine - 1]) || (!/(?:test|it)\s*\(/.test(lines[startLine - 1]) && !goDecl.test(source) && lines.some((l) => pyDecl.test(l)))) lang = "py";
    else if (/^package\s+\w/m.test(source) && lines.some((l) => goDecl.test(l))) lang = "go";
    else lang = "js";
  }
  const isPy = lang === "py";
  const decl = isPy ? pyDecl : lang === "go" ? goDecl : lang === "rs" ? rsDecl : jsDecl;
  // Walk up to the enclosing declaration line (the failure line is often the assert, not the header).
  let idx = startLine - 1;
  for (let i = startLine - 1; i >= Math.max(0, startLine - 30); i--) {
    if (decl.test(lines[i])) { idx = i; break; }
  }
  const block = [lines[idx]];
  if (isPy) {
    const base = lines[idx].match(/^\s*/)[0].length;
    for (let i = idx + 1; i < lines.length && block.length < maxLines; i++) {
      if (lines[i].trim() === "") { block.push(lines[i]); continue; }
      if (lines[i].match(/^\s*/)[0].length <= base) break;   // dedent -> end of def
      block.push(lines[i]);
    }
    while (block.length && block[block.length - 1].trim() === "") block.pop();
    return block.join("\n");
  }
  let depth = 0, started = false;
  for (const ch of lines[idx]) { if (ch === "(" || ch === "{") { depth++; started = true; } else if (ch === ")" || ch === "}") depth--; }
  if (started && depth <= 0) return block.join("\n");   // single-line test: already balanced
  for (let i = idx + 1; i < lines.length && block.length < maxLines; i++) {
    block.push(lines[i]);
    for (const ch of lines[i]) { if (ch === "(" || ch === "{") { depth++; started = true; } else if (ch === ")" || ch === "}") depth--; }
    if (started && depth <= 0) break;
  }
  return block.join("\n");
}

/**
 * Give the stuck-test side call enough of the test harness to expand wrappers
 * and fixtures instead of guessing from the test name. The exact failing block
 * remains the center of the packet; a bounded file prelude supplies imports and
 * shared helpers, while a short local lead-in covers fixtures declared nearer
 * the failing test.
 */
export function extractTestDiagnosticContext(source, startLine, {
  maxPreludeLines = 80,
  maxLeadLines = 24,
  maxTestLines = 45,
  maxChars = 7000,
  lang,
} = {}) {
  const text = String(source ?? "");
  const lines = text.split("\n");
  const block = extractTestBlock(text, startLine, { maxLines: maxTestLines, lang });
  if (!block) return null;

  const firstBlockLine = block.split("\n", 1)[0];
  let blockStart = Math.max(0, startLine - 1);
  for (let i = blockStart; i >= Math.max(0, blockStart - 30); i -= 1) {
    if (lines[i] === firstBlockLine) { blockStart = i; break; }
  }

  const firstTest = lines.findIndex((line) => /(?:^|[\s.=(])(?:test|it)\s*\(|^\s*(?:async\s+)?def\s+test_|^\s*func\s+Test\w*\s*\(/.test(line));
  const preludeEnd = firstTest >= 0 ? Math.min(firstTest, blockStart) : blockStart;
  const prelude = lines.slice(0, Math.min(preludeEnd, maxPreludeLines)).join("\n").trimEnd();
  const leadStart = Math.max(preludeEnd, blockStart - maxLeadLines);
  const lead = lines.slice(leadStart, blockStart).join("\n").trim();

  const supportParts = [];
  if (prelude) supportParts.push(`TEST FILE SETUP / SHARED HELPERS:\n${prelude}`);
  if (lead && leadStart > Math.min(preludeEnd, maxPreludeLines)) {
    supportParts.push(`LOCAL SETUP IMMEDIATELY BEFORE THE FAILURE:\n${lead}`);
  }
  const support = supportParts.join("\n\n");
  const failing = `FAILING TEST BODY:\n${block}`;
  const limit = Math.max(256, Number.isInteger(maxChars) ? maxChars : 7000);
  if (!support) return clipDiagnosticTestContext(failing, limit, "failing test");
  const separator = "\n\n";
  const supportBudget = Math.floor((limit - separator.length) * 0.6);
  const failingBudget = limit - separator.length - supportBudget;
  return `${clipDiagnosticTestContext(support, supportBudget, "test support")}\n\n${clipDiagnosticTestContext(failing, failingBudget, "failing test")}`;
}

function clipDiagnosticTestContext(value, maxChars, label) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  const marker = `\n… [${label} clipped]`;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** Select a real implementation path named on the diagnosis's FIX line only. */
export function diagnosedImplementationPath(diagnosis, candidates) {
  const rawFixLine = String(diagnosis ?? "").split(/\r?\n/).find((line) => /(?:^|\]\s+)FIX:\s*/.test(line));
  if (!rawFixLine) return null;
  const fixLine = rawFixLine.slice(rawFixLine.indexOf("FIX:"));
  for (const candidate of [...new Set(Array.isArray(candidates) ? candidates : [])]) {
    if (typeof candidate !== "string" || !candidate || likelyTestPath(candidate)) continue;
    let at = fixLine.indexOf(candidate);
    while (at >= 0) {
      const before = at === 0 ? "" : fixLine[at - 1];
      const afterAt = at + candidate.length;
      const after = afterAt >= fixLine.length ? "" : fixLine[afterAt];
      if ((!before || /[\s"'`(]/.test(before)) && (!after || /[\s"'`):,]/.test(after))) return candidate;
      at = fixLine.indexOf(candidate, at + 1);
    }
  }
  return null;
}

function likelyTestPath(value) {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\.)test\.[^/]+$|(?:^|\.)spec\.[^/]+$/i.test(String(value));
}

/**
 * Build a focused steer from failing-test output. `readTestFile(relOrAbs)` returns a test file's
 * source (workspace-confined by the caller). Returns the steer string, or null if nothing parsed.
 */
export function formatFailingTestFocus(output, readTestFile, { maxTests = 2 } = {}) {
  const fails = parseTestFailures(output);
  if (!fails.length) return null;
  const counts = parseTestCounts(output);
  const passMatch = String(output).match(/#\s*pass\s+(\d+)/);
  const passed = counts?.passed ?? (passMatch ? Number(passMatch[1]) : null);
  // Clipping intentionally retains only a subset of detailed failure blocks.
  // Prefer the runner's authoritative summary when it accounts for at least the
  // records we could parse; never tell the model that the retained subset is the
  // complete failure count.
  const failed = counts && counts.failed >= fails.length ? counts.failed : fails.length;
  const shown = fails.slice(0, maxTests);
  const parts = [`${FOCUS_TAG} ${failed} test(s) fail${passed != null ? ` (${passed} already pass)` : ""}. Fix them ONE at a time — trace why your code produces the wrong value, edit, then re-run the tests:`];
  for (const f of shown) {
    let block = null;
    if (f.file && f.line && typeof readTestFile === "function") {
      const ext = path.extname(f.file).toLowerCase();
      const lang = ext === ".py" ? "py" : ext === ".go" ? "go" : ext === ".rs" ? "rs" : "js";
      try { const src = readTestFile(f.file); if (src) block = extractTestBlock(src, f.line, { lang }); } catch { /* ignore */ }
    }
    // TAP diff convention: `+` lines are ACTUAL (what the code produced), `-` lines are EXPECTED.
    const cap = (s) => (s.length > 140 ? s.slice(0, 140) + "…" : s);
    const got = cap(f.diff.filter((d) => d.startsWith("+")).map((d) => d.replace(/^\+\s*/, "")).join(", "));
    const want = cap(f.diff.filter((d) => d.startsWith("-")).map((d) => d.replace(/^-\s*/, "")).join(", "));
    const diffLine = got || want
      ? `your code produced { ${got || "?"} }, but the test requires { ${want || "?"} }`
      : (f.expected != null && f.actual != null ? `expected ${f.expected}, got ${f.actual}` : "see the assertion in the test output");
    parts.push(`\nFAILING: "${f.name}"${f.file ? ` (${path.basename(f.file)}:${f.line})` : ""}\n  ${diffLine}`);
    if (block) parts.push(`  the test that must pass:\n${block.split("\n").map((l) => "    " + l).join("\n")}`);
    parts.push(`  Your implementation produced the wrong value here. Work out exactly which line of your code causes it, fix that, and re-run — do not guess-and-retry.`);
  }
  return parts.join("\n");
}

/**
 * Focused diagnostic reasoning call: when the model is STUCK on one test (repeated focused feedback
 * hasn't moved it), decompose — hand it ONLY that failing test + its current implementation + the
 * exact failure, and ask it to reason out the root cause and fix, free of the noisy agentic loop.
 * Returns the model's diagnosis text, or null. This is the "call the llm for a hard sub-step" lever.
 */
export async function diagnoseFailingTest({ model, buildRawPrompt, testName, testSource, implSource, diff, nPredict = 640, signal = null }) {
  const instruction = `You keep failing ONE test and cannot fix it. Stop guessing. Give the implementation fix FIRST so a truncated answer still contains the actionable change.

STRICT OUTPUT — exactly these THREE short lines, in this order, with nothing before FIX:
FIX: <implementation path + symbol/line + exact code change; max 35 words>
CAUSE: <the precise implementation branch/error that produced the failure; max 35 words>
TRACE: <only the 2-4 decisive runtime steps, joined with ->; max 45 words>

THE FAILING TEST "${testName}" AND ITS BOUNDED SUPPORT CONTEXT (the test is correct and must pass unchanged):
${testSource}

CURRENT IMPLEMENTATION CONTEXT (path-labelled; choose the file that actually owns the fault):
${implSource}

THE FAILURE: ${diff}

Before choosing a fix, expand every helper/wrapper used by the failing test far enough to establish the real function or executable entrypoint and its concrete arguments/environment. Every TRACE arrow must follow a branch that is reachable in the current code; never infer dispatch from the test name.

Do not repeat the test or context. Do not propose changing the test. Name the exact implementation path and code change on the FIRST line, then stop after TRACE.`;
  try {
    const out = await model.complete(buildRawPrompt(instruction), { nPredict, signal });
    const text = String(out?.content || "").replace(/<\/?think>/g, "").trim();
    return normalizeFailingTestDiagnosis(text) ?? (text ? text.slice(0, 1400) : null);
  } catch { return null; }
}

/** Keep the final complete answer when a reasoning model self-corrects noisily. */
export function normalizeFailingTestDiagnosis(value) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let latest = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^FIX:\s+\S/.test(lines[i])) continue;
    if (!/^CAUSE:\s+\S/.test(lines[i + 1] ?? "")) continue;
    if (!/^TRACE:\s+\S/.test(lines[i + 2] ?? "")) continue;
    latest = lines.slice(i, i + 3).join("\n");
  }
  return latest;
}

/** Read a test file confined to the workspace (for the agent to pass as readTestFile). */
export function workspaceTestReader(workspace) {
  const root = fs.realpathSync(path.resolve(workspace));
  return (fileRef) => {
    const abs = path.isAbsolute(fileRef) ? path.resolve(fileRef) : path.resolve(root, fileRef);
    const real = fs.realpathSync(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return null;   // stay inside the workspace
    return fs.readFileSync(real, "utf8");
  };
}
