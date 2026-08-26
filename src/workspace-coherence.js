// Detect out-of-band changes to files whose contents BANTAM has already used.
//
// The prompt's open-file panel is refreshed from disk each turn, but the read
// ledger and repetition guard also cache the claim that an earlier read is
// still current. This tracker binds that claim to exact file bytes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class WorkspaceCoherenceTracker {
  constructor(workspace, { maxPaths = 12 } = {}) {
    this.workspace = path.resolve(workspace);
    this.maxPaths = Math.max(1, Number.isInteger(maxPaths) ? maxPaths : 12);
    this.fingerprints = new Map();
  }

  watch(paths) {
    for (const candidate of normalizePaths(paths)) {
      const resolved = this._resolve(candidate);
      if (!resolved) continue;
      this.fingerprints.delete(candidate);
      this.fingerprints.set(candidate, fingerprint(resolved));
      while (this.fingerprints.size > this.maxPaths) {
        this.fingerprints.delete(this.fingerprints.keys().next().value);
      }
    }
  }

  refresh(paths) {
    this.watch(paths);
  }

  snapshot() {
    return Object.fromEntries(this.fingerprints);
  }

  restore(snapshot) {
    this.fingerprints.clear();
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    for (const [candidate, value] of Object.entries(snapshot)) {
      if (typeof value !== "string" || !this._resolve(candidate)) continue;
      this.fingerprints.set(candidate, value);
      while (this.fingerprints.size > this.maxPaths) {
        this.fingerprints.delete(this.fingerprints.keys().next().value);
      }
    }
  }

  scan() {
    const changed = [];
    for (const [candidate, prior] of this.fingerprints) {
      const resolved = this._resolve(candidate);
      const current = resolved ? fingerprint(resolved) : "outside";
      if (current !== prior) {
        changed.push(candidate);
        this.fingerprints.set(candidate, current);
      }
    }
    return changed;
  }

  _resolve(candidate) {
    const resolved = path.resolve(this.workspace, candidate);
    const relative = path.relative(this.workspace, resolved);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return resolved;
    }
    return null;
  }
}

function normalizePaths(paths) {
  const values = Array.isArray(paths) ? paths : [paths];
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

function fingerprint(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(filePath)}`;
    if (stat.isDirectory()) return `directory:${stat.mode}`;
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    return `file:${stat.mode}:${stat.size}:${hash}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
    return `unreadable:${error?.code ?? "unknown"}`;
  }
}
