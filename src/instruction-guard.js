import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPathScopeGuard, isTestPath, isGeneratedPath } from "./scope-guard.js";
import { extractImmutable, immutableViolations } from "./logic/self-check.js";

const instructionHash = instruction => createHash("sha256").update(String(instruction ?? "")).digest("hex");
const safeFrozenPath = value => typeof value === "string" && value.length > 0 && value.length <= 4096
  && !/[\\\0:]/.test(value) && !path.posix.isAbsolute(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && part !== "__proto__");
const plainRecord = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Only restore harness-owned contextBasis, never text emitted by the model.
// These checks bind a checkpoint to its task and constrain its shape/paths;
// they do not authenticate a film supplied by a caller who can forge evidence.
function restoreFrozenTests(snapshot, instruction) {
  if (snapshot == null || snapshot.instructionSha256 !== instructionHash(instruction)) return null;
  if (!plainRecord(snapshot) || snapshot.schema !== 1 || !Array.isArray(snapshot.existingTests)
      || snapshot.existingTests.length > 20000 || !snapshot.existingTests.every(safeFrozenPath)
      || new Set(snapshot.existingTests).size !== snapshot.existingTests.length
      || !plainRecord(snapshot.hashes)) throw Error("invalid same-task frozen-test checkpoint");
  const paths = new Set(snapshot.existingTests);
  if (Object.keys(snapshot.hashes).length !== paths.size || Object.entries(snapshot.hashes).some(([rel, hash]) =>
    !safeFrozenPath(rel) || !paths.has(rel) || typeof hash !== "string"
      || !/^(?:[a-f0-9]{64}|symlink:[a-f0-9]{64}|<deleted>|<outside>)$/.test(hash))) {
    throw Error("invalid same-task frozen-test checkpoint hashes");
  }
  return { existingTests: [...paths], hashes: { ...snapshot.hashes } };
}

// Resolve the instruction's class once, before any action. New tests do not
// join this set later. Reuse public test-path conventions, not fixture graders.
function existingTestPaths(workspace) {
  const root = fs.realpathSync(workspace), found = new Set();let entries = 0;
  const inside = absolute => absolute === root || absolute.startsWith(`${root}${path.sep}`);
  const relative = absolute => path.relative(root, absolute).split(path.sep).join("/");
  function walk(directory, prefix, ancestors) {
    if (ancestors.size > 64) throw Error("existing-test snapshot exceeded its directory-depth bound");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isGeneratedPath(rel)) continue;
      if (++entries > 20_000) throw Error("existing-test snapshot exceeded its 20000-entry bound");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, rel, new Set([...ancestors, absolute]));continue;
      }
      const testPath = isTestPath(rel);
      if (testPath && (entry.isFile() || entry.isSymbolicLink())) found.add(rel);
      if (!entry.isSymbolicLink()) continue;
      let canonical, stat;
      try { canonical = fs.realpathSync(absolute);if (!inside(canonical)) continue;stat = fs.statSync(canonical); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") continue;throw error; }
      if (testPath && stat.isFile()) found.add(relative(canonical));
      // A supplied test directory may itself be an in-workspace alias. Freeze
      // its existing members and canonical targets, not future child paths.
      if (stat.isDirectory() && isTestPath(`${rel}/_`) && !ancestors.has(canonical)) {
        found.add(rel);walk(canonical, rel, new Set([...ancestors, canonical]));
      }
    }
  }
  walk(root, "", new Set([root]));
  // Include canonical targets of regular files reached through directory aliases.
  for (const rel of [...found]) {
    try { const canonical = fs.realpathSync(path.join(root, rel));if (inside(canonical) && fs.statSync(canonical).isFile()) found.add(relative(canonical)); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ELOOP") throw error; }
  }
  return [...found].sort();
}

export function instructionPathPolicy(workspace, invariants) {
  const root = fs.realpathSync(path.resolve(workspace));
  const normalize = (name) => {
    const value = String(name ?? "").replace(/^\/app\//, "").replace(/^~\//, "");
    const absolute = path.resolve(root, value);
    return absolute === root || absolute.startsWith(`${root}${path.sep}`)
      ? path.relative(root, absolute).split(path.sep).join("/")
      : null;
  };
  const forbidden = (invariants?.forbidden ?? []).map(normalize).filter(Boolean);
  const editable = (invariants?.editable ?? []).map(normalize).filter(Boolean);
  const existingTests = new Set((invariants?.existingTests ?? []).map(normalize).filter(Boolean));
  const existingTestNodes = new Set(existingTests);
  for (const file of existingTests) {
    const parts = file.split("/");
    while (parts.length > 1) { parts.pop();existingTestNodes.add(parts.join("/")); }
  }
  const matches = (relative, named) => named.includes("/")
    ? relative === named
    : path.posix.basename(relative) === named;
  const policy = (name, { structural = true } = {}) => {
    const relative = normalize(name);
    if (relative === null) return "instruction-forbidden";
    const candidates = [relative];
    // Resolve existing symlink aliases as well as the path the action names.
    try {
      const real = fs.realpathSync(path.resolve(root, relative));
      const resolved = normalize(real);
      if (resolved !== null) candidates.push(resolved);
    } catch { /* a new path still has lexical authority */ }
    if (candidates.some((p) => forbidden.some((f) => matches(p, f)))) return "instruction-forbidden";
    if (candidates.some((p) => (structural ? existingTestNodes : existingTests).has(p))) return "instruction-forbidden";
    if (invariants?.mode === "exclusive" && !candidates.every((p) => editable.some((f) => matches(p, f)))) {
      return "instruction-forbidden";
    }
    return null;
  };
  policy.editable = editable;
  policy.forbidden = forbidden;
  policy.existingTests = [...existingTests];
  // Traverse otherwise ignored directories only when a concrete instruction
  // explicitly names a path within one. Ordinary caches remain out of scope.
  policy.includeGenerated = (rel) => [...forbidden, ...existingTests].some((f) => f === rel || f.startsWith(`${rel}/`));
  return policy;
}

export function composeInstructionGuards({ workspace, instruction, editGuard = null, shellScopeGuard = null,
  frozenTests = null } = {}) {
  let invariants = extractImmutable(instruction);
  if (invariants.mode === "none") return { invariants, editGuard, shellScopeGuard, protectedExistingTests: [] };
  let frozenTestCheckpoint = null;
  if (invariants.preserveExistingTests) {
    const restored = restoreFrozenTests(frozenTests, instruction);
    const exceptions = new Set((invariants.existingTestExceptions ?? []).map(name =>
      path.relative(path.resolve(workspace), path.resolve(workspace, name)).split(path.sep).join("/")));
    // An exception removes only this instruction's class constraint. Explicit
    // named prohibitions and caller-provided guards remain independently live.
    const paths = restored?.existingTests ?? existingTestPaths(workspace).filter(rel => !exceptions.has(rel));
    invariants = { ...invariants, existingTests: paths };
    const hashes = restored?.hashes ?? immutableViolations.snapshot(workspace,
      { mode: "forbid", forbidden: [], existingTests: paths }).hashes;
    frozenTestCheckpoint = { schema: 1, instructionSha256: instructionHash(instruction), existingTests: [...paths], hashes };
  }
  const root = fs.realpathSync(workspace);
  const protectedExistingTests = (invariants.existingTests ?? []).filter(relative => {
    try {
      const real = fs.realpathSync(path.join(root, relative));
      return real.startsWith(`${root}${path.sep}`) && fs.statSync(real).isFile();
    } catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP") return false;throw error; }
  });
  const instructionGuard = instructionPathPolicy(workspace, invariants);
  const composedEdit = (relative) => instructionGuard(relative) || editGuard?.(relative) || null;
  Object.assign(composedEdit, editGuard ?? {}, { instruction: invariants, existingTests: instructionGuard.existingTests });
  // Protected children restore their parents safely. A second parent-removal
  // violation would otherwise delete those just-restored children again.
  const localShell = createPathScopeGuard(workspace, relative => instructionGuard(relative, { structural: false }), { includeGenerated: instructionGuard.includeGenerated });
  return {
    invariants, protectedExistingTests, frozenTestCheckpoint,
    editGuard: composedEdit,
    shellScopeGuard: shellScopeGuard ? composeShellGuards(localShell, shellScopeGuard) : localShell,
  };
}

function composeShellGuards(first, second) {
  return {
    capture() { return [first.capture(), second.capture()]; },
    rollback(snapshots) {
      // Both compare against their own pre-action snapshot. A restored overlap
      // is already clean for the second guard; no permitted write is restored.
      const results = [first.rollback(snapshots[0]), second.rollback(snapshots[1])];
      const unique = (field, key) => [...new Map(results.flatMap((r) => r[field]).map((item) => [key(item), item])).values()];
      return {
        clean: results.every((r) => r.clean),
        violations: unique("violations", (v) => v.path),
        restored: unique("restored", (p) => p),
        remaining: unique("remaining", (v) => v.path),
      };
    },
  };
}
