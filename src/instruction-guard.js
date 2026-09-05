import fs from "node:fs";
import path from "node:path";
import { createPathScopeGuard } from "./scope-guard.js";
import { extractImmutable } from "./logic/self-check.js";

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
  const matches = (relative, named) => named.includes("/")
    ? relative === named
    : path.posix.basename(relative) === named;
  const policy = (name) => {
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
    if (invariants?.mode === "exclusive" && !candidates.every((p) => editable.some((f) => matches(p, f)))) {
      return "instruction-forbidden";
    }
    return null;
  };
  policy.editable = editable;
  policy.forbidden = forbidden;
  // Traverse otherwise ignored directories only when a concrete instruction
  // explicitly names a path within one. Ordinary caches remain out of scope.
  policy.includeGenerated = (rel) => forbidden.some((f) => f === rel || f.startsWith(`${rel}/`));
  return policy;
}

export function composeInstructionGuards({ workspace, instruction, editGuard = null, shellScopeGuard = null } = {}) {
  const invariants = extractImmutable(instruction);
  if (invariants.mode === "none") return { invariants, editGuard, shellScopeGuard };
  const instructionGuard = instructionPathPolicy(workspace, invariants);
  const composedEdit = (relative) => instructionGuard(relative) || editGuard?.(relative) || null;
  Object.assign(composedEdit, editGuard ?? {}, { instruction: invariants });
  const localShell = createPathScopeGuard(workspace, instructionGuard, { includeGenerated: instructionGuard.includeGenerated });
  return {
    invariants,
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
