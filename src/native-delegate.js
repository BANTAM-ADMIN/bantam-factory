import fs from "node:fs";
import path from "node:path";

import {
  applyCodexDelegate,
  formatCodexDelegate,
  loadCodexDelegate,
  runCodexDelegate,
} from "./codex-delegate.js";
import {
  applyClaudeDelegate,
  formatClaudeDelegate,
  loadClaudeDelegate,
  runClaudeDelegate,
} from "./claude-delegate.js";

export async function runNativeDelegate({ provider = "codex", ...options } = {}) {
  const selected = normalizeProvider(provider);
  return selected === "claude"
    ? runClaudeDelegate(options)
    : runCodexDelegate(options);
}

export function loadNativeDelegate(fileOrDirectory) {
  const resolved = path.resolve(String(fileOrDirectory));
  const file = fs.statSync(resolved).isDirectory() ? path.join(resolved, "artifact.json") : resolved;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.kind === "bantam-claude-delegate") return loadClaudeDelegate(file);
  return loadCodexDelegate(file);
}

export async function applyNativeDelegate(options = {}) {
  const { artifact } = loadNativeDelegate(options.artifactPath);
  return artifact.kind === "bantam-claude-delegate"
    ? applyClaudeDelegate(options)
    : applyCodexDelegate(options);
}

export function formatNativeDelegate(artifact) {
  return artifact?.kind === "bantam-claude-delegate"
    ? formatClaudeDelegate(artifact)
    : formatCodexDelegate(artifact);
}

export function normalizeProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "claude" || provider === "claude-code") return "claude";
  if (provider === "codex") return "codex";
  throw new Error(`unsupported native delegate provider: ${value}; use codex or claude`);
}
