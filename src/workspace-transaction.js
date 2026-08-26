// Transactional deployment of one already-captured workspace candidate.
//
// The baseline and candidate roots passed here are immutable materializations
// from WorkspaceStore.  We stage backups before touching the live checkout,
// write each replacement through an exclusive sibling file, and retain enough
// state to roll an interrupted deployment back on the next controller start.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-file.js";

const MANIFEST = "manifest.json";
const TRANSACTION_KIND = "bantam.workspace-transaction";
const TRANSACTION_STATES = new Set([
  "prepared",
  "applying",
  "applied",
  "verified",
  "promoted",
  "committed",
  "rolled_back",
  "conflict",
]);
const ACTIVE_STATES = new Set(["prepared", "applying", "applied", "verified"]);
const ROLLBACK_STATES = new Set([...ACTIVE_STATES, "conflict"]);

export function planWorkspaceTransaction(baselineRoot, candidateRoot) {
  const baseline = workspaceManifest(baselineRoot);
  const candidate = workspaceManifest(candidateRoot);
  const paths = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const changes = [];

  for (const relative of paths) {
    const before = baseline.get(relative) ?? null;
    const after = candidate.get(relative) ?? null;
    if (
      before?.sha256 === after?.sha256
      && before?.mode === after?.mode
    ) {
      continue;
    }
    changes.push({
      path: relative,
      kind: before === null ? "added" : after === null ? "deleted" : "modified",
      before,
      after,
    });
  }

  return {
    changes,
    baselineDigest: manifestDigest(baseline),
    candidateDigest: manifestDigest(candidate),
  };
}

export class WorkspaceTransaction {
  constructor({
    workspace,
    baselineRoot = null,
    candidateRoot = null,
    transactionRoot,
    id,
    metadata = {},
    onStagedWrite = null,
  }) {
    this.workspace = requireDirectory(workspace, "live workspace");
    this.baselineRoot = baselineRoot === null
      ? null
      : requireDirectory(baselineRoot, "baseline materialization");
    this.candidateRoot = candidateRoot === null
      ? null
      : requireDirectory(candidateRoot, "candidate materialization");
    this.transactionRoot = path.resolve(requireString(transactionRoot, "transaction root"));
    this.id = validateId(id);
    this.directory = path.join(this.transactionRoot, this.id);
    this.manifestPath = path.join(this.directory, MANIFEST);
    this.metadata = jsonCopy(metadata, "transaction metadata");
    if (onStagedWrite !== null && typeof onStagedWrite !== "function") {
      throw new TypeError("workspace transaction staged-write hook must be a function");
    }
    this.onStagedWrite = onStagedWrite;
    this.manifest = null;
  }

  prepare() {
    if (!this.baselineRoot || !this.candidateRoot) {
      throw new Error("preparing a workspace transaction requires baseline and candidate materializations");
    }
    if (fs.existsSync(this.directory)) {
      throw new Error(`workspace transaction already exists: ${this.id}`);
    }

    const plan = planWorkspaceTransaction(this.baselineRoot, this.candidateRoot);
    if (plan.changes.length === 0) {
      throw new Error("candidate workspace is byte-identical to the baseline");
    }

    fs.mkdirSync(this.transactionRoot, { recursive: true, mode: 0o700 });
    const staging = path.join(
      this.transactionRoot,
      `.preparing-${this.id}-${process.pid}-${crypto.randomBytes(12).toString("hex")}`,
    );
    let created = false;
    let published = false;
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      created = true;
      fs.mkdirSync(path.join(staging, "backups"), { mode: 0o700 });
      fs.mkdirSync(path.join(staging, "staged-writes"), { mode: 0o700 });
      for (const change of plan.changes) {
        validateLiveBaseline(this.workspace, change);
        if (change.before !== null) {
          const source = safeJoin(this.baselineRoot, change.path);
          const baseline = readVerifiedFile(
            source,
            change.before,
            `baseline ${change.path}`,
          );
          const backup = safeJoin(path.join(staging, "backups"), change.path);
          fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
          fs.writeFileSync(backup, baseline.bytes, {
            flag: "wx",
            mode: change.before.mode,
          });
          fs.chmodSync(backup, change.before.mode);
        }
      }

      this.manifest = {
        schema: 1,
        kind: TRANSACTION_KIND,
        id: this.id,
        workspace: this.workspace,
        state: "prepared",
        createdAt: new Date().toISOString(),
        baselineDigest: plan.baselineDigest,
        candidateDigest: plan.candidateDigest,
        changes: plan.changes,
        pendingWrite: null,
        metadata: this.metadata,
      };
      // Publish only a complete preparation. A crash while copying backups
      // leaves a disposable `.preparing-*` directory; a crash after rename
      // leaves a normal durable manifest that startup recovery can load.
      writeJsonAtomic(path.join(staging, MANIFEST), this.manifest);
      fsyncDirectory(staging);
      if (fs.existsSync(this.directory)) {
        throw new Error(`workspace transaction already exists: ${this.id}`);
      }
      fs.renameSync(staging, this.directory);
      published = true;
      fsyncDirectory(this.transactionRoot);
      return this.view();
    } catch (error) {
      this.manifest = null;
      if (created && !published) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch (cleanupError) {
          error.message += `; partial transaction cleanup failed: ${cleanupError.message}`;
        }
      }
      throw error;
    }
  }

  apply() {
    this.requireState("prepared");
    if (!this.candidateRoot) {
      throw new Error("applying a workspace transaction requires a candidate materialization");
    }
    this.transition("applying");
    try {
      for (const change of this.manifest.changes) {
        const destination = safeLivePath(this.workspace, change.path);
        const candidate = change.after === null
          ? null
          : readVerifiedFile(
              safeJoin(this.candidateRoot, change.path),
              change.after,
              `candidate ${change.path}`,
            );
        requireLiveVersion(destination, change.before, `live ${change.path}`);
        if (change.after === null) {
          removeRegularFile(destination, change.path, change.before);
          continue;
        }
        this.writeManagedBytes(change, destination, candidate.bytes, change.after.mode, {
          expectedCurrent: change.before,
          label: `live ${change.path}`,
          operation: "apply",
        });
      }
      this.transition("applied");
      return this.view();
    } catch (error) {
      try {
        this.rollback({ reason: `apply failed: ${error.message}` });
      } catch (rollbackError) {
        throw new Error(
          `workspace deployment failed (${error.message}) and rollback failed (${rollbackError.message}); `
          + `recovery state is retained at ${this.directory}`,
        );
      }
      throw error;
    }
  }

  markVerified(evidence = {}) {
    this.requireState("applied");
    this.manifest.verification = jsonCopy(evidence, "deployment verification");
    this.transition("verified");
    return this.view();
  }

  markPromoted(metadata = {}) {
    this.requireState("verified");
    this.manifest.promotion = jsonCopy(metadata, "promotion metadata");
    this.transition("promoted");
    return this.view();
  }

  abandonPrepared({ reason = "prepared transaction was never applied" } = {}) {
    this.requireState("prepared");
    this.manifest.rollback = {
      reason: String(reason),
      at: new Date().toISOString(),
      liveWorkspaceUntouched: true,
    };
    this.transition("rolled_back");
    return this.view();
  }

  rollback({ reason = "controller rollback" } = {}) {
    if (!this.manifest) this.load();
    if (this.manifest.state === "rolled_back") return this.view();
    if (!ROLLBACK_STATES.has(this.manifest.state)) {
      throw new Error(`cannot roll back ${this.manifest.state} transaction ${this.id}`);
    }

    this.prunePendingWrite({ reason });
    const backups = new Map();
    const conflicts = [];
    for (const change of this.manifest.changes) {
      if (change.before !== null) {
        try {
          backups.set(change.path, readVerifiedFile(
            safeJoin(path.join(this.directory, "backups"), change.path),
            change.before,
            `transaction backup ${change.path}`,
          ));
        } catch (error) {
          conflicts.push({ path: change.path, reason: error.message });
        }
      }
      try {
        const destination = safeLivePath(this.workspace, change.path);
        const current = inspectLiveVersion(destination);
        if (!matchesVersion(current, change.before) && !matchesVersion(current, change.after)) {
          conflicts.push({
            path: change.path,
            reason: `live path matches neither the baseline nor candidate (${describeVersion(current)})`,
          });
        }
      } catch (error) {
        conflicts.push({ path: change.path, reason: error.message });
      }
    }
    if (conflicts.length > 0) {
      this.retainConflict(reason, conflicts);
    }

    for (const change of [...this.manifest.changes].reverse()) {
      const destination = safeLivePath(this.workspace, change.path);
      let current;
      try {
        current = inspectLiveVersion(destination);
        if (!matchesVersion(current, change.before) && !matchesVersion(current, change.after)) {
          this.retainConflict(reason, [{
            path: change.path,
            reason: `live path changed during rollback (${describeVersion(current)})`,
          }]);
        }
      } catch (error) {
        if (this.manifest.state === "conflict") throw error;
        this.retainConflict(reason, [{ path: change.path, reason: error.message }]);
      }
      if (matchesVersion(current, change.before)) continue;
      try {
        if (change.before === null) {
          removeRegularFile(destination, change.path, change.after);
          pruneEmptyParents(path.dirname(destination), this.workspace);
          continue;
        }
        const backup = backups.get(change.path);
        this.writeManagedBytes(change, destination, backup.bytes, change.before.mode, {
          expectedCurrent: change.after,
          label: `live ${change.path}`,
          operation: "rollback",
        });
      } catch (error) {
        let latest;
        try {
          latest = inspectLiveVersion(destination);
        } catch (inspectError) {
          this.retainConflict(reason, [{ path: change.path, reason: inspectError.message }]);
        }
        if (!matchesVersion(latest, change.before) && !matchesVersion(latest, change.after)) {
          this.retainConflict(reason, [{
            path: change.path,
            reason: `live path changed during rollback (${describeVersion(latest)})`,
          }]);
        }
        throw error;
      }
    }
    this.manifest.rollback = {
      reason: String(reason),
      at: new Date().toISOString(),
    };
    this.transition("rolled_back");
    return this.view();
  }

  retainConflict(reason, conflicts) {
    this.manifest.conflict = {
      reason: String(reason),
      at: new Date().toISOString(),
      paths: conflicts,
    };
    this.transition("conflict");
    throw new Error(
      `workspace rollback conflict in transaction ${this.id}; `
      + `unknown live bytes were preserved and recovery state is retained at ${this.directory}: `
      + conflicts.map((entry) => `${entry.path}: ${entry.reason}`).join("; "),
    );
  }

  commit() {
    if (!this.manifest) this.load();
    if (this.manifest.state === "committed") return this.view();
    if (this.manifest.state !== "promoted") {
      throw new Error(`cannot commit transaction ${this.id} from state ${this.manifest.state}`);
    }
    this.prunePendingWrite({ reason: "committing promoted transaction" });
    this.transition("committed");
    fs.rmSync(path.join(this.directory, "backups"), { recursive: true, force: true });
    fs.rmSync(path.join(this.directory, "staged-writes"), { recursive: true, force: true });
    return this.view();
  }

  load() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`cannot read workspace transaction ${this.id}: ${error.message}`);
    }
    validateManifest(value, this.id, this.workspace);
    if (value.pendingWrite === undefined) value.pendingWrite = null;
    this.manifest = value;
    return this;
  }

  view() {
    if (!this.manifest) this.load();
    return jsonCopy(this.manifest, "workspace transaction");
  }

  requireState(expected) {
    if (!this.manifest) this.load();
    if (this.manifest.state !== expected) {
      throw new Error(
        `workspace transaction ${this.id} is ${this.manifest.state}, expected ${expected}`,
      );
    }
  }

  transition(state) {
    this.manifest.state = state;
    this.manifest.updatedAt = new Date().toISOString();
    this.persist();
  }

  persist() {
    writeJsonAtomic(this.manifestPath, this.manifest);
    fsyncDirectory(this.directory);
  }

  writeManagedBytes(change, destination, bytes, mode, {
    expectedCurrent,
    label,
    operation,
  }) {
    if (this.manifest.pendingWrite) {
      throw new Error(`workspace transaction ${this.id} already has a pending staged write`);
    }
    const { tempPath, stagingPath } = pendingWritePaths(change.path);
    const version = operation === "apply" ? change.after : change.before;
    if (!version) {
      throw new Error(`workspace transaction ${operation} has no staged version for ${change.path}`);
    }
    const pending = {
      operation,
      destinationPath: change.path,
      tempPath,
      stagingPath,
      version: jsonCopy(version, "pending staged-write version"),
      device: null,
      inode: null,
    };
    this.manifest.pendingWrite = pending;
    this.persist();
    writeBytesAtomic(destination, bytes, mode, {
      expectedCurrent,
      label,
      tempPath: safeLivePath(this.workspace, tempPath),
      stagingPath: safeJoin(this.directory, stagingPath),
      beforeTempOwned: this.onStagedWrite === null
        ? null
        : () => this.onStagedWrite({
            ...jsonCopy(pending, "pending staged write"),
            phase: "created-unowned",
          }),
      onTempCreated: ({ device, inode }) => {
        pending.device = device;
        pending.inode = inode;
        this.manifest.pendingWrite = pending;
        this.persist();
        if (this.onStagedWrite !== null) {
          this.onStagedWrite({
            ...jsonCopy(pending, "pending staged write"),
            phase: "owned",
          });
        }
      },
      beforeRename: this.onStagedWrite === null
        ? null
        : () => this.onStagedWrite({
            ...jsonCopy(pending, "pending staged write"),
            phase: "ready-to-rename",
          }),
    });
    this.manifest.pendingWrite = null;
    this.persist();
  }

  prunePendingWrite({ reason = "transaction recovery" } = {}) {
    const pending = this.manifest?.pendingWrite;
    if (!pending) return false;
    const paths = [
      {
        label: pending.tempPath,
        path: safeLivePath(this.workspace, pending.tempPath),
        private: false,
      },
      {
        label: pending.stagingPath,
        path: safeJoin(this.directory, pending.stagingPath),
        private: true,
      },
    ];
    const inspected = paths.map((entry) => ({
      ...entry,
      stat: inspectPendingPath(entry.path, entry.label, reason, this),
    }));
    const hasIdentity = pending.device !== null && pending.inode !== null;

    if (!hasIdentity) {
      const livePath = inspected.find((entry) => !entry.private);
      if (livePath.stat !== null) {
        this.retainConflict(reason, [{
          path: livePath.label,
          reason: "pending live staged path existed before transaction ownership was recorded",
        }]);
      }
      const privatePath = inspected.find((entry) => entry.private);
      if (privatePath.stat !== null && !privatePath.stat.isFile()) {
        this.retainConflict(reason, [{
          path: privatePath.label,
          reason: "pending transaction staging path is not a regular file",
        }]);
      }
    } else {
      const mismatch = inspected.find(({ stat }) => (
        stat !== null
        && (
          !stat.isFile()
          || stat.dev.toString() !== pending.device
          || stat.ino.toString() !== pending.inode
        )
      ));
      if (mismatch) {
        this.retainConflict(reason, [{
          path: mismatch.label,
          reason: "pending staged path is not the transaction-owned regular-file inode",
        }]);
      }
    }

    let removed = false;
    for (const entry of inspected) {
      if (entry.stat === null) continue;
      try {
        fs.unlinkSync(entry.path);
        fsyncDirectory(path.dirname(entry.path));
        removed = true;
      } catch (error) {
        this.retainConflict(reason, [{
          path: entry.label,
          reason: `cannot remove verified pending staged write: ${error.message}`,
        }]);
      }
    }
    this.manifest.pendingWrite = null;
    this.persist();
    return removed;
  }
}

/**
 * Roll back incomplete deployments left by an interrupted controller.
 * A caller may declare a transaction promoted after checking its channel CAS;
 * those transactions are finalized instead of reverted.
 */
export function recoverWorkspaceTransactions({
  workspace,
  transactionRoot,
  wasPromoted = () => false,
} = {}) {
  const root = path.resolve(requireString(transactionRoot, "transaction root"));
  if (!fs.existsSync(root)) return [];
  const recovered = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (entry.name.startsWith(".preparing-") || !fs.existsSync(path.join(directory, MANIFEST))) {
      // Preparation never touches the live checkout. Both the current staged
      // format and manifest-less directories left by older builds are safe to
      // discard and must not brick future recovery.
      fs.rmSync(directory, { recursive: true, force: true });
      recovered.push({ id: entry.name, action: "discarded-preparation" });
      continue;
    }
    const transaction = new WorkspaceTransaction({
      workspace,
      transactionRoot: root,
      id: entry.name,
    }).load();
    const state = transaction.manifest.state;
    if (state === "conflict") {
      transaction.prunePendingWrite({
        reason: "recovered transaction with an unresolved rollback conflict",
      });
      throw new Error(
        `workspace transaction ${entry.name} has an unresolved rollback conflict at `
        + `${transaction.directory}`,
      );
    }
    if (state === "promoted") {
      transaction.commit();
      recovered.push({ id: entry.name, action: "committed" });
    } else if (state === "prepared") {
      transaction.abandonPrepared({
        reason: "recovered preparation that never began applying",
      });
      recovered.push({ id: entry.name, action: "rolled_back" });
    } else if (ACTIVE_STATES.has(state)) {
      if (wasPromoted(transaction.view())) {
        transaction.manifest.state = "promoted";
        transaction.persist();
        transaction.commit();
        recovered.push({ id: entry.name, action: "committed" });
      } else {
        transaction.rollback({ reason: "recovered after interrupted deployment" });
        recovered.push({ id: entry.name, action: "rolled_back" });
      }
    }
  }
  return recovered;
}

function workspaceManifest(root) {
  const base = requireDirectory(root, "workspace materialization");
  const result = new Map();
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(base, full).split(path.sep).join("/");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace transaction refuses symbolic links: ${relative}`);
      }
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile()) {
        const bytes = fs.readFileSync(full);
        result.set(relative, {
          sha256: sha256(bytes),
          bytes: bytes.length,
          mode: executableMode(stat.mode),
        });
      } else {
        throw new Error(`workspace transaction refuses special files: ${relative}`);
      }
    }
  };
  visit(base);
  return result;
}

function manifestDigest(manifest) {
  return sha256(Buffer.from(JSON.stringify([...manifest.entries()])));
}

function validateLiveBaseline(workspace, change) {
  const live = safeLivePath(workspace, change.path);
  try {
    requireLiveVersion(live, change.before, `live ${change.path}`);
  } catch {
    throw new Error(`live workspace changed since baseline: ${change.path}`);
  }
}

function validateManifest(value, id, workspace) {
  if (
    value?.schema !== 1
    || value?.kind !== TRANSACTION_KIND
    || value?.id !== id
    || path.resolve(String(value?.workspace ?? "")) !== workspace
    || !Array.isArray(value?.changes)
    || value.changes.length === 0
    || !TRANSACTION_STATES.has(value?.state)
    || !isSha256(value?.baselineDigest)
    || !isSha256(value?.candidateDigest)
    || typeof value?.createdAt !== "string"
    || value?.metadata === null
    || typeof value?.metadata !== "object"
    || Array.isArray(value?.metadata)
  ) {
    throw new Error(`invalid workspace transaction manifest: ${id}`);
  }
  const seen = new Set();
  for (const change of value.changes) {
    if (!validManifestPath(change?.path) || seen.has(change.path)) {
      throw new Error(`invalid workspace transaction manifest: ${id}`);
    }
    seen.add(change.path);
    const before = change.before;
    const after = change.after;
    const validKind = (
      (change.kind === "added" && before === null && validFileVersion(after))
      || (change.kind === "deleted" && validFileVersion(before) && after === null)
      || (
        change.kind === "modified"
        && validFileVersion(before)
        && validFileVersion(after)
        && !sameFileVersion(before, after)
      )
    );
    if (!validKind) throw new Error(`invalid workspace transaction manifest: ${id}`);
  }
  const pending = value.pendingWrite;
  if (
    pending !== undefined
    && pending !== null
    && !validPendingWrite(pending, value.changes, value.state)
  ) {
    throw new Error(`invalid workspace transaction manifest: ${id}`);
  }
}

function validPendingWrite(value, changes, state) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !["applying", "applied", "verified", "conflict"].includes(state)
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "destinationPath",
    "device",
    "inode",
    "operation",
    "stagingPath",
    "tempPath",
    "version",
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || !["apply", "rollback"].includes(value.operation)
    || !validManifestPath(value.destinationPath)
    || !validManifestPath(value.stagingPath)
    || !validManifestPath(value.tempPath)
    || !validFileVersion(value.version)
    || !validOwnedInode(value.device)
    || !validOwnedInode(value.inode)
    || ((value.device === null) !== (value.inode === null))
  ) {
    return false;
  }
  const change = changes.find((entry) => entry.path === value.destinationPath);
  if (!change) return false;
  const expectedVersion = value.operation === "apply" ? change.after : change.before;
  if (!expectedVersion || !sameFileVersion(value.version, expectedVersion)) return false;
  const destinationDirectory = path.posix.dirname(value.destinationPath);
  if (path.posix.dirname(value.tempPath) !== destinationDirectory) return false;
  const basename = escapeRegExp(path.posix.basename(value.destinationPath));
  const match = new RegExp(
    `^\\.${basename}\\.bantam-promote-([0-9]+)-([a-f0-9]{24})$`,
  ).exec(path.posix.basename(value.tempPath));
  return match !== null
    && value.stagingPath === `staged-writes/${match[1]}-${match[2]}.stage`;
}

function validOwnedInode(value) {
  return value === null || (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value));
}

function validManifestPath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === "."
    || value.startsWith("../")
  ) {
    return false;
  }
  return true;
}

function validFileVersion(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && isSha256(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && (value.mode === 0o644 || value.mode === 0o755),
  );
}

function sameFileVersion(left, right) {
  return left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.mode === right.mode;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function readVerifiedFile(file, expected, label) {
  let descriptor;
  let stat;
  let bytes;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(file, flags);
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    bytes = fs.readFileSync(descriptor);
  } catch (error) {
    if (String(error?.message ?? "").startsWith(`${label} `)) throw error;
    throw new Error(`${label} is unavailable: ${error.message}`);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
  const actual = {
    sha256: sha256(bytes),
    bytes: bytes.length,
    mode: executableMode(stat.mode),
  };
  if (!sameFileVersion(actual, expected)) {
    throw new Error(`${label} does not match its transaction digest`);
  }
  return { bytes, version: actual };
}

function inspectLiveVersion(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { special: stat.isSymbolicLink() ? "symbolic link" : "non-regular path" };
  }
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(file, flags);
    stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { special: "non-regular path" };
    const bytes = fs.readFileSync(descriptor);
    return {
      sha256: sha256(bytes),
      bytes: bytes.length,
      mode: executableMode(stat.mode),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") return { special: "symbolic link" };
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function matchesVersion(actual, expected) {
  if (expected === null) return actual === null;
  return actual !== null
    && !actual.special
    && sameFileVersion(actual, expected);
}

function requireLiveVersion(file, expected, label) {
  const actual = inspectLiveVersion(file);
  if (!matchesVersion(actual, expected)) {
    throw new Error(`${label} does not match the expected transaction version`);
  }
  return actual;
}

function describeVersion(value) {
  if (value === null) return "missing";
  if (value.special) return value.special;
  return `${value.sha256}/${value.mode.toString(8)}`;
}

function writeBytesAtomic(destination, bytes, mode, {
  expectedCurrent = undefined,
  label = destination,
  tempPath,
  stagingPath,
  beforeTempOwned = null,
  onTempCreated = null,
  beforeRename = null,
} = {}) {
  const target = path.resolve(destination);
  const liveStaged = path.resolve(requireString(tempPath, "live staged-write path"));
  const transactionStaged = path.resolve(
    requireString(stagingPath, "transaction staged-write path"),
  );
  assertNoSymlinkParent(target);
  assertNoSymlinkParent(liveStaged);
  if (path.dirname(liveStaged) !== path.dirname(target) || liveStaged === target) {
    throw new Error(`invalid staged sibling for workspace file: ${destination}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(transactionStaged), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor = fs.openSync(transactionStaged, flags, mode);
  let identity = null;
  let linked = false;
  let renamed = false;
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw new Error("transaction staged write is not a regular file");
    identity = {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    };
    fsyncDirectory(path.dirname(transactionStaged));
    if (beforeTempOwned !== null) beforeTempOwned();
    if (onTempCreated !== null) {
      onTempCreated(identity);
    }
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (expectedCurrent !== undefined) {
      requireLiveVersion(target, expectedCurrent, label);
    }
    fs.linkSync(transactionStaged, liveStaged);
    linked = true;
    fsyncDirectory(path.dirname(liveStaged));
    if (beforeRename !== null) beforeRename();
    fs.renameSync(liveStaged, target);
    renamed = true;
    fsyncDirectory(path.dirname(target));
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    if (linked && !renamed) {
      removeMatchingInode(liveStaged, identity);
    }
    removeMatchingInode(transactionStaged, identity);
  }
}

function pendingWritePaths(relative) {
  const directory = path.posix.dirname(relative);
  const basename = path.posix.basename(relative);
  const suffix = crypto.randomBytes(12).toString("hex");
  const sibling = `.${basename}.bantam-promote-${process.pid}-${suffix}`;
  return {
    tempPath: directory === "." ? sibling : `${directory}/${sibling}`,
    stagingPath: `staged-writes/${process.pid}-${suffix}.stage`,
  };
}

function inspectPendingPath(target, label, reason, transaction) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    transaction.retainConflict(reason, [{
      path: label,
      reason: `cannot inspect pending staged write safely: ${error.message}`,
    }]);
  }
}

function removeMatchingInode(target, identity) {
  if (identity === null) return false;
  let stat;
  try {
    stat = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (
    !stat.isFile()
    || stat.dev.toString() !== identity.device
    || stat.ino.toString() !== identity.inode
  ) {
    return false;
  }
  fs.unlinkSync(target);
  fsyncDirectory(path.dirname(target));
  return true;
}

function removeRegularFile(destination, relative, expected) {
  requireLiveVersion(destination, expected, `live ${relative}`);
  fs.unlinkSync(destination);
}

function pruneEmptyParents(directory, stop) {
  let current = directory;
  while (current !== stop && current.startsWith(stop + path.sep)) {
    try { fs.rmdirSync(current); }
    catch { break; }
    current = path.dirname(current);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function safeLivePath(root, relative) {
  const target = safeJoin(root, relative);
  assertNoSymlinkParent(target);
  return target;
}

function safeJoin(root, relative) {
  const base = path.resolve(root);
  const rel = String(relative ?? "");
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) {
    throw new Error(`unsafe workspace path: ${rel}`);
  }
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep)) {
    throw new Error(`workspace path escapes root: ${rel}`);
  }
  return target;
}

function assertNoSymlinkParent(target) {
  let current = path.dirname(target);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`workspace path has a symbolic-link parent: ${target}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function requireDirectory(directory, label) {
  const resolved = path.resolve(requireString(directory, label));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) { throw new Error(`${label} is unavailable: ${error.message}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${resolved}`);
  }
  return resolved;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function validateId(value) {
  const id = requireString(value, "transaction id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`invalid transaction id: ${id}`);
  }
  return id;
}

function executableMode(mode) {
  return mode & 0o111 ? 0o755 : 0o644;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonCopy(value, label) {
  let text;
  try { text = JSON.stringify(value); }
  catch (error) { throw new TypeError(`${label} must be JSON-serializable: ${error.message}`); }
  if (typeof text !== "string") throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(text);
}
