// REA (github.com/morluto/rea, npm "rea-agents", MIT) as an optional add-on.
// Bantam never ships or auto-installs it: `bantam addons install rea` puts a
// pinned copy under ~/.bantam/addons/rea, and `--rea` / `:rea on` connects a
// run to its MCP server (src/rea-mcp-client.js). BANTAM_REA_ROOT points at any
// other checkout instead.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const REA_PACKAGE = "rea-agents";
// Where `bantam addons install rea` gets REA. For now, Bantam's fork release:
// upstream 6.5.0 plus the objdump dynamic-section facets (morluto/rea#4868),
// built once and pinned by digest. To return to upstream npm, replace this
// with { version: "<x.y.z>" } (no tarball): installRea then installs
// rea-agents@<x.y.z> from the npm registry.
export const REA_SOURCE = Object.freeze({
  version: "6.5.0-bantam.1",
  tarball: "https://github.com/BANTAM-ADMIN/rea/releases/download/rea-agents-6.5.0-bantam.1/rea-agents-6.5.0-bantam.1.tgz",
  sha256: "00c513cef688dddd34790dc19e96895dfb92473f123c387600fcf70bad64deab",
});
export const REA_VERSION = REA_SOURCE.version;
// rea-agents' own engines field: ^22.19.0 || ^24.11.0 || >=26.0.0.
export const REA_NODE_RANGE = "^22.19.0 || ^24.11.0 || >=26.0.0";

// Same rule as addons.js addonsRoot(). Not imported: addons.js lists this
// add-on, and agent.js loads this module first, so the import would cycle.
export function reaAddonDir(env = process.env) {
  return path.join(env.BANTAM_ADDONS_DIR || path.join(os.homedir(), ".bantam", "addons"), "rea");
}

function packageRoot(dir) {
  return path.join(dir, "node_modules", REA_PACKAGE);
}

/** The REA checkout to run: BANTAM_REA_ROOT, else the add-on install, else null. */
export function findReaRoot(env = process.env) {
  if (env.BANTAM_REA_ROOT) return path.resolve(env.BANTAM_REA_ROOT);
  const root = packageRoot(reaAddonDir(env));
  return fs.existsSync(path.join(root, "scripts", "rea.mjs")) ? root : null;
}

export function reaInstalledVersion(root = findReaRoot()) {
  if (!root) return null;
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

export function nodeSupportsRea(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major === 22) return minor >= 19;
  if (major === 24) return minor >= 11;
  return major >= 26;
}

export const REA_INSTALL_HINT = "bantam addons install rea";

/** Why REA cannot start in this process, or null when it can. */
export function reaUnavailableReason(env = process.env) {
  if (!nodeSupportsRea()) {
    return `REA needs Node ${REA_NODE_RANGE}; this Bantam runs on Node ${process.versions.node}.`;
  }
  if (!findReaRoot(env)) {
    return `REA is not installed. Install it with: ${REA_INSTALL_HINT} (or set BANTAM_REA_ROOT to a checkout).`;
  }
  return null;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Install the pinned REA package into the add-on directory. A tarball source
 * is downloaded and checked against its pinned SHA-256 before npm sees it.
 * Runs npm without REA's own `setup`, which would register REA with other agents.
 */
export async function installRea({ log = console.log, run = spawnSync, source = REA_SOURCE, download = fetchBytes } = {}) {
  if (!nodeSupportsRea()) {
    throw new Error(`REA needs Node ${REA_NODE_RANGE}; this is Node ${process.versions.node}. Upgrade Node, then retry.`);
  }
  const dir = reaAddonDir();
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: "bantam-rea-addon", private: true }, null, 2) + "\n");
  }
  let spec = `${REA_PACKAGE}@${source.version}`;
  if (source.tarball) {
    log(`Downloading ${REA_PACKAGE} ${source.version} from ${source.tarball}`);
    const bytes = await download(source.tarball);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== source.sha256) {
      throw new Error(`downloaded REA package has SHA-256 ${digest}, expected ${source.sha256}; nothing was installed.`);
    }
    spec = path.join(dir, path.basename(new URL(source.tarball).pathname));
    fs.writeFileSync(spec, bytes);
  }
  log(`Installing ${REA_PACKAGE} ${source.version} (about 230 MB once installed) into ${dir}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", spec], {
    cwd: dir, stdio: "inherit",
  });
  if (result.error) throw new Error(`Could not run npm: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm install exited with status ${result.status}; nothing was enabled.`);
  const root = packageRoot(dir);
  if (!fs.existsSync(path.join(root, "scripts", "rea.mjs"))) {
    throw new Error(`npm finished but ${root}/scripts/rea.mjs is missing.`);
  }
  return { root, version: reaInstalledVersion(root) };
}

// Inputs where REA's binary/container/application analysis applies. Kept to
// unambiguous extensions and phrases so ordinary coding tasks never see it.
const RE_EXTENSIONS = /\.(?:exe|dll|sys|so|dylib|elf|o|a|bin|rom|smc|sfc|nes|gb|gbc|gba|nds|n64|z64|v64|iso|img|apk|aab|ipa|dex|jar|class|wasm|asar|msi|pkg|dmg|deb|rpm|appimage|pyc|firmware|fw)\b/i;
const RE_PHRASES = /\b(?:reverse[- ]engineer\w*|disassembl\w*|decompil\w*|binary analysis|firmware|rom (?:file|image|dump)|electron app\w*|app\.asar|minified bundle|obfuscated)\b/i;

export function taskSuggestsRea(task) {
  const text = String(task ?? "");
  return RE_EXTENSIONS.test(text) || RE_PHRASES.test(text);
}

/**
 * One run-stable sentence for the model when the task looks like reverse
 * engineering but REA is not connected. The model cannot install add-ons;
 * it can tell the operator what would help.
 */
export function reaAwarenessText(task, { connected = false, env = process.env } = {}) {
  if (connected || !taskSuggestsRea(task)) return "";
  const installed = Boolean(findReaRoot(env)) && nodeSupportsRea();
  const enable = installed
    ? "It is installed but not enabled for this run; the operator can enable it with --rea or :rea on."
    : `It is not installed; the operator can install it with \`${REA_INSTALL_HINT}\` and then enable it with --rea or :rea on.`;
  return `REA (an optional reverse-engineering MCP add-on for binaries, ROMs, archives and Electron/JavaScript applications) is not connected. ${enable} Do not try to install or run it yourself. Continue with the tools you have, and if REA would materially help, say so in your answer.`;
}
