// Verifier autodetect. BANTAM's small model is trustworthy because a verifier
// grades every change before a result is called done — but --verify is an
// optional flag a newcomer won't know to set. When an interactive session starts
// with no verifier, detect the project's own test command and offer to attach it.
//
// Pure over an injectable fs so every ecosystem branch is unit-testable.

import fs from "node:fs";
import path from "node:path";

const NPM_PLACEHOLDER = /no test specified/i;

function read(fsImpl, file) {
  try { return fsImpl.readFileSync(file, "utf8"); } catch { return null; }
}

function hasTestFile(fsImpl, dir) {
  for (const sub of ["tests", "test"]) {
    const d = path.join(dir, sub);
    let entries;
    try { entries = fsImpl.readdirSync(d); } catch { continue; }
    if (entries.some((n) => /^test_.*\.py$/.test(n) || /_test\.py$/.test(n) || /^test.*\.py$/.test(n))) return true;
  }
  return false;
}

/**
 * Detect the project's test command. Returns { command, source, confidence } for
 * the strongest signal, or null. Checked in order of how authoritative the signal
 * is: a *declared* test command (package.json, Makefile, justfile) outranks an
 * *inferred* language-native one (pytest/cargo/go).
 */
export function detectVerifier(dir, fsImpl = fs) {
  const at = (f) => path.join(dir, f);

  // 1) Declared npm test (skip the `npm init` placeholder that always fails).
  const pkgRaw = read(fsImpl, at("package.json"));
  if (pkgRaw) {
    try {
      const test = JSON.parse(pkgRaw)?.scripts?.test;
      if (test && !NPM_PLACEHOLDER.test(test)) {
        return { command: "npm test", source: "package.json scripts.test", confidence: "high" };
      }
    } catch { /* malformed package.json — fall through */ }
  }

  // 2) A Makefile `test:` target — the project's declared entrypoint.
  const makefile = read(fsImpl, at("Makefile")) ?? read(fsImpl, at("makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) {
    return { command: "make test", source: "Makefile test target", confidence: "high" };
  }

  // 3) A justfile `test` recipe.
  const just = read(fsImpl, at("justfile")) ?? read(fsImpl, at("Justfile"));
  if (just && /^test\b/m.test(just)) {
    return { command: "just test", source: "justfile test recipe", confidence: "high" };
  }

  // 4) Python: an explicit pytest config, or a tests/ dir with test files.
  const pyproject = read(fsImpl, at("pyproject.toml"));
  const setupcfg = read(fsImpl, at("setup.cfg"));
  const pytestConfigured =
    (pyproject && /\[tool\.pytest/.test(pyproject)) ||
    (setupcfg && /\[tool:pytest\]/.test(setupcfg)) ||
    read(fsImpl, at("pytest.ini")) != null ||
    read(fsImpl, at("tox.ini")) != null;
  if (pytestConfigured || hasTestFile(fsImpl, dir)) {
    return { command: "python -m pytest", source: pytestConfigured ? "pytest config" : "tests/ directory", confidence: pytestConfigured ? "high" : "medium" };
  }

  // 5) Rust.
  if (read(fsImpl, at("Cargo.toml")) != null) {
    return { command: "cargo test", source: "Cargo.toml", confidence: "medium" };
  }

  // 6) Go.
  if (read(fsImpl, at("go.mod")) != null) {
    return { command: "go test ./...", source: "go.mod", confidence: "medium" };
  }

  return null;
}
