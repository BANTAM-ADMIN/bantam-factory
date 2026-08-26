// test/helpers/env-guards.js — shared environment-prerequisite detection for tests
// PLATFORM TRAP (2026-08-18): node:test SKIPS on `{ skip: null }` — the key's
// presence wins over its falsiness. Guards therefore return `false` (run),
// never null. Discovered when ten host-runnable tests silently skipped.
// that need external tools (Chromium, Codex endpoint). Each function returns a
// string reason when the prerequisite is ABSENT, or false when it is present.
// Tests use the result as a node:test {skip: reason} value: false means run the
// test, a string means skip with that reason.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const CHROMIUM_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium",
];

/**
 * Returns a skip-reason string when no Chromium binary is available, or false
 * when one is found (via BANTAM_CHROMIUM env var or on PATH).
 */
export function chromiumSkipReason(env = process.env) {
  if (env.BANTAM_CHROMIUM) return false;
  for (const name of CHROMIUM_CANDIDATES) {
    try {
      execFileSync("which", [name], { stdio: ["ignore", "ignore", "ignore"] });
      return false;
    } catch { /* not found, keep looking */ }
  }
  return "no Chromium binary found (set BANTAM_CHROMIUM or install chromium)";
}

/**
 * Returns a skip-reason string when the Codex app-server endpoint is not
 * configured, or false when it is.
 */
export function codexSkipReason(env = process.env) {
  if (env.BANTAM_CODEX_ENDPOINT) return false;
  return "BANTAM_CODEX_ENDPOINT not set (Codex app-server endpoint required)";
}

/**
 * Returns a skip-reason string when a required file does not exist, or false
 * when it does.
 */
export function fileSkipReason(filePath) {
  try {
    fs.accessSync(filePath);
    return false;
  } catch {
    return `required file not found: ${filePath}`;
  }
}

/**
 * Returns a skip-reason string when outbound network is unreachable, or false
 * when a real TCP connection succeeds. Probes a well-known host on port 443.
 */
export function networkSkipReason(host = "api.github.com", port = 443, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const done = (reason) => {
      socket.destroy();
      resolve(reason);
    };
    socket.once("connect", () => done(false));
    socket.once("timeout", () => done(`network unreachable: ${host}:${port} (timeout ${timeoutMs}ms)`));
    socket.once("error", (err) => done(`network unreachable: ${host}:${port} (${err.code || err.message})`));
  });
}

/**
 * Returns a skip-reason string when a required state path does not exist, or
 * false when it does. The path may be a file or directory.
 */
export function statePathSkipReason(p) {
  try {
    fs.accessSync(p);
    return false;
  } catch {
    return `required state path not found: ${p}`;
  }
}

/**
 * Composite guard: returns the first non-false reason from the given reasons,
 * or false when all are false (all prerequisites present).
 */
export function compositeSkipReason(...reasons) {
  for (const r of reasons) {
    if (r !== false) return r;
  }
  return false;
}

/**
 * Vision prerequisite: the model server must report a vision modality
 * (llama.cpp /props with an mmproj loaded). Returns false when vision is
 * PRESENT (platform trap: `{skip: null}` still skips), or the true reason.
 * Endpoint override: BANTAM_VISION_ENDPOINT (defaults to the local server).
 */
export function visionSkipReason(env = process.env) {
  const endpoint = env.BANTAM_VISION_ENDPOINT || "http://127.0.0.1:8085";
  try {
    const out = execFileSync("curl", ["-sS", "-m", "4", `${endpoint.replace(/\/$/, "")}/props`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    if (JSON.parse(out)?.modalities?.vision) return false;
    return `model server at ${endpoint} has no vision projector loaded (start it via tools/serve-vision.sh)`;
  } catch {
    return `no model server reachable at ${endpoint}`;
  }
}
