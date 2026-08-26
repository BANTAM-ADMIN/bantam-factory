// Resolve one completed Local/Sol/Terra turn from a trio session into the exact
// artifacts consumed by teacher collaboration.
//
// This removes an error-prone operator step while retaining the consent
// boundary: resolving evidence is local/read-only; Codex calls still require
// the collaborate command's explicit --yes.

import fs from "node:fs";
import path from "node:path";

const TRIO_KIND = "bantam-trio-session";
const REQUIRED_ARMS = Object.freeze(["local", "sol", "terra"]);

export function loadTrioTeacherArtifacts(sessionDir, {
  turn = "latest",
  fsImpl = fs,
} = {}) {
  const directory = requireDirectory(sessionDir, fsImpl);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = readJsonFile(manifestPath, fsImpl, "trio manifest");
  if (manifest?.kind !== TRIO_KIND || !Array.isArray(manifest.turns)) {
    throw new Error("invalid trio session manifest");
  }
  const record = selectTurn(manifest.turns, turn);
  const paths = {};
  const artifacts = {};
  for (const arm of REQUIRED_ARMS) {
    const relative = record?.arms?.[arm]?.artifactPath;
    if (typeof relative !== "string" || !relative.trim()) {
      throw new Error(`trio turn ${record.turn} has no ${arm} artifact`);
    }
    const artifactPath = safeEvidencePath(directory, relative, fsImpl);
    paths[arm] = artifactPath;
    artifacts[arm] = readJsonFile(artifactPath, fsImpl, `${arm} artifact`);
  }
  const tasks = new Set(REQUIRED_ARMS.map((arm) => String(artifacts[arm]?.task ?? "")));
  if (tasks.size !== 1 || tasks.has("")) {
    throw new Error(`trio turn ${record.turn} artifacts do not contain one exact shared task`);
  }
  return {
    sessionDir: directory,
    sessionId: String(manifest.id ?? path.basename(directory)),
    turn: record.turn,
    task: artifacts.local.task,
    paths,
    artifacts,
  };
}

function selectTurn(turns, requested) {
  const completed = turns.filter((record) => (
    Number.isInteger(record?.turn) && record?.completedAt && record?.arms
  ));
  if (!completed.length) throw new Error("trio session has no completed turn");
  if (requested === undefined || requested === null || requested === "" || requested === "latest") {
    return completed.reduce((latest, record) => (
      record.turn > latest.turn ? record : latest
    ));
  }
  const number = Number(requested);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`invalid trio turn "${requested}"; expected latest or a positive integer`);
  }
  const selected = completed.find((record) => record.turn === number);
  if (!selected) throw new Error(`trio session has no completed turn ${number}`);
  return selected;
}

function safeEvidencePath(directory, relative, fsImpl) {
  const normalized = relative.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`trio artifact path escapes the session: ${relative}`);
  }
  const candidate = path.resolve(directory, normalized);
  if (!inside(directory, candidate)) {
    throw new Error(`trio artifact path escapes the session: ${relative}`);
  }
  let stat;
  try {
    stat = fsImpl.lstatSync(candidate);
  } catch (error) {
    throw new Error(`trio artifact is unavailable: ${relative}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`trio artifact is not a regular file: ${relative}`);
  }
  const realDirectory = fsImpl.realpathSync(directory);
  const realCandidate = fsImpl.realpathSync(candidate);
  if (!inside(realDirectory, realCandidate)) {
    throw new Error(`trio artifact resolves outside the session: ${relative}`);
  }
  return candidate;
}

function requireDirectory(value, fsImpl) {
  const directory = path.resolve(String(value ?? ""));
  let stat;
  try {
    stat = fsImpl.statSync(directory);
  } catch (error) {
    throw new Error(`trio session is unavailable: ${error.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`trio session is not a directory: ${directory}`);
  return directory;
}

function readJsonFile(file, fsImpl, label) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
