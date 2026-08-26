#!/usr/bin/env node
// known-failures.cjs — generator for .bantam/known-failures.json, the declared
// baseline of inherited test failures that the done-gates honor (loadKnownFailures
// in src/done-guard.js reads a top-level `failures` array of strings and matches
// them by substring against `not ok` test names).
//
// Usage:
//   node tools/known-failures.cjs --write [--cmd "npm test"]
//     Runs the test command, parses the `not ok N - name` lines from its output,
//     and writes .bantam/known-failures.json with the names, a recorded date, and
//     the command used. Prints what it wrote.
//   node tools/known-failures.cjs --check [--cmd "npm test"]
//     Re-runs the test command and reports NEW failures not in the manifest
//     (exit 1 if any, exit 0 otherwise) plus manifest entries that no longer
//     fail (candidates for retirement).
//
// Zero dependencies. CommonJS.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CMD = 'npm test';
const MANIFEST_REL = path.join('.bantam', 'known-failures.json');

// `not ok 12 - some test name` — the TAP failure line. Tolerates leading
// whitespace (nested subtests) and a trailing ` # annotation`.
const NOT_OK_RE = /^\s*not ok\s+(\d+)\s*-\s*(.+?)(?:\s+#\s.*)?\s*$/;

/** Parse `not ok N - name` lines out of a test run's combined output. Returns names in first-seen order, deduped. Absolute paths (e.g. a whole-file failure line) are stored repo-relative so the manifest stays portable. */
function parseNotOkNames(output, workspace) {
  const names = [];
  const seen = new Set();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const m = line.match(NOT_OK_RE);
    if (!m) continue;
    let name = m[2].trim();
    if (path.isAbsolute(name)) name = path.relative(workspace, name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Run a shell command, return { status, output } (stdout + stderr combined). */
function runCommand(cmd) {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  return { status: res.status ?? 1, output };
}

/** Load the existing manifest's failure names, or [] if absent/unreadable. */
function loadManifestNames(workspace) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspace, MANIFEST_REL), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.failures;
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
}

/** True when a manifest entry still matches (substring) any currently failing name. */
function entryStillFails(entry, failingNames) {
  return failingNames.some((n) => n.includes(entry) || entry.includes(n));
}

function writeManifest(workspace, cmd, names) {
  const manifest = {
    recorded: new Date().toISOString().slice(0, 10),
    command: cmd,
    failures: names,
  };
  const file = path.join(workspace, MANIFEST_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return { file, manifest };
}

/** Parse CLI args: one of --write/--check plus an optional --cmd "...". */
function parseArgs(argv) {
  let mode = null;
  let cmd = DEFAULT_CMD;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check') mode = a;
    else if (a === '--cmd') cmd = argv[++i] || DEFAULT_CMD;
  }
  return { mode, cmd };
}

/**
 * Core of --check: compare currently failing names against manifest entries.
 * Returns { newFailures, retired } — failures not covered by any manifest
 * entry, and manifest entries that no longer match any failing name.
 */
function checkFailures(failing, known) {
  const newFailures = failing.filter((n) => !known.some((k) => n.includes(k) || k.includes(n)));
  const retired = known.filter((k) => !entryStillFails(k, failing));
  return { newFailures, retired };
}

function main(argv) {
  const workspace = process.cwd();
  const { mode, cmd } = parseArgs(argv);
  if (mode !== '--write' && mode !== '--check') {
    console.error('usage: node tools/known-failures.cjs --write [--cmd "npm test"] | --check [--cmd "npm test"]');
    process.exit(2);
  }

  const { status, output } = runCommand(cmd);
  const failing = parseNotOkNames(output);

  if (mode === '--write') {
    const { file, manifest } = writeManifest(workspace, cmd, failing);
    console.log(`wrote ${path.relative(workspace, file)} (${failing.length} known failure${failing.length === 1 ? '' : 's'}):`);
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
  }

  // --check
  const known = loadManifestNames(workspace);
  const { newFailures, retired } = checkFailures(failing, known);

  console.log(`checked ${cmd}: ${failing.length} failing, ${known.length} in manifest`);
  if (newFailures.length) {
    console.log(`NEW failures (not in manifest):`);
    for (const n of newFailures) console.log(`  + ${n}`);
  }
  if (retired.length) {
    console.log(`no longer failing (candidates for retirement):`);
    for (const k of retired) console.log(`  - ${k}`);
  }
  if (!newFailures.length && !retired.length) console.log('manifest matches reality; nothing new, nothing retired');
  process.exit(newFailures.length ? 1 : 0);
}

module.exports = { parseNotOkNames, runCommand, loadManifestNames, entryStillFails, checkFailures, writeManifest, parseArgs, MANIFEST_REL, DEFAULT_CMD };

if (require.main === module) main(process.argv.slice(2));
