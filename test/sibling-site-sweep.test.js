import assert from "node:assert/strict";
import test from "node:test";

import { guardSignature, siblingSites, siblingSweepObjection } from "../src/logic/sibling-site-sweep.js";

// Preregistration: docs/superpowers/reports/2026-08-15-sibling-site-sweep-preregistration.md
// The defect: fix the site the symptom names, miss its structural twin in the
// same function. Measured on django-15572 (our patch WAS the gold patch's
// first hunk) and on channel-filter's Boolean(flag) coercion.

const DJANGO_15572_AFTER = `def get_template_directories():
    items = set()
    for backend in engines.all():
        if not isinstance(backend, DjangoTemplates):
            continue

        items.update(cwd / to_path(dir) for dir in backend.engine.dirs if dir)

        for loader in backend.engine.template_loaders:
            if not hasattr(loader, "get_dirs"):
                continue
            items.update(
                cwd / to_path(directory)
                for directory in loader.get_dirs()
                if not is_django_path(directory)
            )
    return items
`;

const CHANNEL_FILTER_AFTER = `export function normalizeChannels(value) {
  if (!Array.isArray(value)) throw new TypeError("array required");
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new TypeError("strings only");
    out.push(entry.trim().toLowerCase());
  }
  return out;
}

export function normalizeDelivery(value) {
  const out = {};
  for (const [key, flag] of Object.entries(value ?? {})) {
    out[String(key).trim().toLowerCase()] = Boolean(flag);
  }
  return out;
}
`;

test("guardSignature normalizes a guard/coercion edit to its shape", () => {
  assert.equal(guardSignature("        items.update(cwd / to_path(dir) for dir in backend.engine.dirs if dir)").kind, "if-guard");
  assert.equal(guardSignature('    if (typeof entry !== "string") throw new TypeError("x");').kind, "type-check");
  assert.equal(guardSignature("  const x = 1;").kind, null);
});

test("django-15572: the unguarded sibling comprehension is reported", () => {
  const sites = siblingSites({
    content: DJANGO_15572_AFTER,
    editedLines: [7],          // the guarded items.update line (1-based)
    path: "django/template/autoreload.py",
  });
  assert.ok(sites.length >= 1, "must find the loader.get_dirs sibling");
  const joined = sites.map((s) => s.text).join(" | ");
  assert.match(joined, /loader\.get_dirs\(\)|for directory in/);
  // Must not report the line it just edited.
  assert.ok(!sites.some((s) => s.line === 7), "never reports the edited line");
});

test("channel-filter: a strict function's unstrict twin is reported", () => {
  const sites = siblingSites({
    content: CHANNEL_FILTER_AFTER,
    editedLines: [5],          // the typeof entry check
    path: "src/channel-filter.js",
    wholeFile: true,           // twins may live in a sibling function
  });
  const joined = sites.map((s) => s.text).join(" | ");
  assert.match(joined, /Boolean\(flag\)|String\(key\)/);
});

test("no sites: a fully-swept file reports nothing", () => {
  const swept = DJANGO_15572_AFTER.replace("if not is_django_path(directory)", "if directory and not is_django_path(directory)");
  const sites = siblingSites({ content: swept, editedLines: [7], path: "x.py" });
  assert.equal(sites.length, 0);
});

test("objection: bounded, opt-in, and silent without sites", () => {
  const turns = [{ action: { a: "replace", p: "django/template/autoreload.py" }, editApplied: true }];
  const readFile = () => DJANGO_15572_AFTER;
  const on = { enabled: true, readFile, editedLinesFor: () => [7] };
  const msg = siblingSweepObjection(turns, 0, on);
  assert.ok(msg, "fires on an unswept sibling");
  assert.match(msg, /\[sibling-sweep\]/);
  assert.match(msg, /autoreload\.py/);
  assert.equal(siblingSweepObjection(turns, 1, on), null, "bounded to one rejection");
  assert.equal(siblingSweepObjection(turns, 0, { ...on, enabled: false }), null, "opt-in");
  assert.equal(siblingSweepObjection([], 0, on), null, "no edits, no objection");
});
