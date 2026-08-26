import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/;

/**
 * Capture the exact fixture bytes that determine what a run sees and how it is
 * graded. Only compact roots are persisted; task repositories can be large.
 */
export function captureFixtureProvenance({ fixtureDir, workspace, taskSpecBytes }) {
  const taskSpecSha256 = sha256(taskSpecBytes);
  const repo = hashTree(workspace);
  const grader = hashTree(path.join(fixtureDir, "grader"), { missing: true });
  const evaluatorSha256 = combine([
    "bantam-fixture-evaluator-v1",
    taskSpecSha256,
    repo.sha256,
    grader.sha256,
  ]);
  return Object.freeze({
    schema: 1,
    taskSpecSha256,
    repoTreeSha256: repo.sha256,
    repoFiles: repo.files,
    repoBytes: repo.bytes,
    graderTreeSha256: grader.sha256,
    graderFiles: grader.files,
    graderBytes: grader.bytes,
    evaluatorSha256,
  });
}

/** Recompute the self-contained root without reading the original fixture. */
export function fixtureEvaluatorRoot(value) {
  if (!value || value.schema !== 1) return null;
  const parts = [
    value.taskSpecSha256,
    value.repoTreeSha256,
    value.graderTreeSha256,
  ];
  if (!parts.every((item) => typeof item === "string" && HASH.test(item))) return null;
  return combine(["bantam-fixture-evaluator-v1", ...parts]);
}

function hashTree(root, { missing = false } = {}) {
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    if (!missing) throw new Error(`fixture provenance tree is missing: ${resolved}`);
    return {
      sha256: combine(["bantam-fixture-tree-v1", "missing"]),
      files: 0,
      bytes: 0,
    };
  }
  const entries = [];
  let bytes = 0;
  walk(resolved);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = crypto.createHash("sha256").update("bantam-fixture-tree-v1\0");
  for (const entry of entries) {
    hash.update(entry.type).update("\0");
    hash.update(entry.path).update("\0");
    hash.update(entry.sha256).update("\0");
  }
  return { sha256: hash.digest("hex"), files: entries.length, bytes };

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(resolved, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full);
        bytes += content.length;
        entries.push({ type: "file", path: rel, sha256: sha256(content) });
      } else if (entry.isSymbolicLink()) {
        const target = Buffer.from(fs.readlinkSync(full), "utf8");
        bytes += target.length;
        entries.push({ type: "symlink", path: rel, sha256: sha256(target) });
      }
    }
  }
}

function combine(parts) {
  return sha256(Buffer.from(parts.join("\0"), "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
