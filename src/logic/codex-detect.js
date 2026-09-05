// codex-detect.js — is the Codex CLI here, and is it signed in?
//
// BANTAM can broker image generation and image reading through a signed-in
// Codex account (`:image`, `:eyes codex`). Both spend that account's quota, so
// they are off by default — but "off by default" had become "hidden": a user
// with a perfectly good Codex plan never found out the capability existed.
// This is the probe the first-run offer is built on.
//
// Pure over injectable probes so every branch is testable without a Codex
// install. bin/bantam.js supplies the real ones. Nothing here throws: a probe
// that fails reads as "not detected", never as a crash on the first screen.

/** Parse `codex login status` output. Exit 0 + "Logged in" is the signal. */
function parseLoginStatus(res) {
  if (!res || res.ok !== true) return null;
  const text = String(res.stdout ?? "").trim();
  if (!/logged in/i.test(text) || /not logged in/i.test(text)) return null;
  if (/chatgpt/i.test(text)) return "chatgpt";
  if (/api key/i.test(text)) return "apikey";
  return "unknown";
}

/** Fallback: the auth file the CLI writes. Presence of tokens or a key is enough. */
function parseAuthFile(auth) {
  if (!auth || typeof auth !== "object") return null;
  const mode = String(auth.auth_mode ?? "").toLowerCase();
  if (mode === "chatgpt" || (auth.tokens && typeof auth.tokens === "object")) return "chatgpt";
  if (mode === "apikey" || typeof auth.OPENAI_API_KEY === "string") return "apikey";
  return null;
}

/**
 * probes:
 *   which(name)      -> path | null
 *   version()        -> string | null           (`codex --version`)
 *   loginStatus()    -> { ok, stdout } | null   (`codex login status`)
 *   readAuth()       -> object | null           (~/.codex/auth.json, parsed)
 *
 * Returns { installed, path, version, signedIn, method, source }.
 */
export function detectCodex(probes = {}) {
  const safe = (fn, fallback = null) => { try { return fn ? fn() : fallback; } catch { return fallback; } };
  const path = safe(() => probes.which?.("codex"));
  if (!path) return { installed: false, path: null, version: null, signedIn: false, method: null, source: null };

  const version = safe(() => probes.version?.()) || null;
  const viaStatus = parseLoginStatus(safe(() => probes.loginStatus?.()));
  if (viaStatus) return { installed: true, path, version, signedIn: true, method: viaStatus, source: "login-status" };

  const viaAuth = parseAuthFile(safe(() => probes.readAuth?.()));
  if (viaAuth) return { installed: true, path, version, signedIn: true, method: viaAuth, source: "auth-file" };

  return { installed: true, path, version, signedIn: false, method: null, source: null };
}

/** One line for a human: "Codex 0.149.0 is installed and signed in (ChatGPT)". */
export function describeCodex(c) {
  if (!c?.installed) return "Codex CLI is not installed";
  const name = `Codex${c.version ? ` ${c.version}` : ""}`;
  if (!c.signedIn) return `${name} is installed but not signed in`;
  const how = c.method === "chatgpt" ? "ChatGPT plan" : c.method === "apikey" ? "API key" : "signed in";
  return `${name} is installed and signed in (${how})`;
}
