// Detect a workspace's test framework and how to run a SCOPED subset of its tests. This is the second
// half of the test-impact primitive (roadmap 2.1): `affectedTests` (codefacts.js) answers WHICH tests
// a change could affect; this answers HOW to run just those. Read-only config sniffing — returns null
// when it can't tell, so a caller (the scoped verifier, 1.1) falls back to the full `--verify` command.
//
// A scoped command is a genuine SUBSET of the framework's own runner, so `green (scoped)` is a real
// subset of `green (full)`. When the framework can't be identified, or the user's --verify is an opaque
// pipeline (`make check`, `npm test && npm run e2e`), the caller must NOT synthesize a scoped command.

import fs from "node:fs";
import path from "node:path";

function jsScoped(runner) {
  return (files) => `${runner} ${files.join(" ")}`.trim();
}

// Group changed test files into their Go packages (dir) — `go test` runs by package, not file.
// `-v` so the run emits per-test `--- PASS:`/`--- FAIL:` lines: plain `go test` is silent on success
// (just `ok pkg`), which starves the count-based regression guard. `-v` is a strict output superset —
// same exit code, same `--- FAIL:` failure lines — so it changes nothing the done-gate/test-focus read.
function goScoped(files) {
  const pkgs = [...new Set(files.map((f) => "./" + (path.posix.dirname(f) || ".")))];
  return `go test -v ${pkgs.join(" ")}`;
}

/**
 * @returns {{name: string, scopedCommand: (files: string[]) => string} | null}
 */
export function detectFramework(workspace, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const has = (rel) => exists(path.join(workspace, rel));

  if (has("package.json")) {
    let pkg = {};
    try { pkg = JSON.parse(readFile(path.join(workspace, "package.json"), "utf8")); } catch { /* keep {} */ }
    const testScript = String(pkg.scripts?.test ?? "");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const uses = (name) => new RegExp(`\\b${name}\\b`).test(testScript) || Boolean(deps[name]);
    if (uses("vitest")) return { name: "vitest", scopedCommand: jsScoped("npx vitest run") };
    if (uses("jest")) return { name: "jest", scopedCommand: jsScoped("npx jest") };
    if (uses("mocha")) return { name: "mocha", scopedCommand: jsScoped("npx mocha") };
    // A bun lockfile (or a bun test script) marks a bun project; its built-in runner takes file args.
    if (has("bun.lockb") || has("bun.lock") || uses("bun")) return { name: "bun", scopedCommand: jsScoped("bun test") };
    // Node's built-in runner (`node --test`) is the default when nothing else is declared.
    return { name: "node", scopedCommand: jsScoped("node --test") };
  }

  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tox.ini")) {
    return { name: "pytest", scopedCommand: jsScoped("pytest") };
  }

  if (has("go.mod")) {
    return { name: "go", scopedCommand: goScoped };
  }

  if (has("Cargo.toml")) {
    // cargo has no per-file test selection; `cargo test` runs the crate's own runner, a superset of
    // any affected subset, so its verdict still covers the edit. (Name-filter scoping would need the
    // test path, which changed FILES don't reliably give.)
    return { name: "cargo", scopedCommand: () => "cargo test" };
  }

  if (has("cpanfile") || has("t")) {
    // perl: prove over the t/ directory; -l adds lib/ to @INC (the conventional layout).
    return { name: "perl", scopedCommand: (files) => `prove -l ${files.filter((f) => f.endsWith(".t")).join(" ") || "t/"}`.trim() };
  }

  return null;
}
