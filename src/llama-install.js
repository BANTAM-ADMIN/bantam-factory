// `bantam doctor --install-llama` — fetch a prebuilt llama-server instead of
// building llama.cpp from source (the fragile part of setup). Selection logic:
// Vulkan is the universal prebuilt GPU build (NVIDIA via the driver's Vulkan ICD,
// and AMD, on both Linux and Windows, as one self-contained archive), macOS uses
// Metal-native binaries, and there is no Linux CUDA prebuilt (that stays a
// source build for the power user).
//
// The core is pure over injectable inputs so the platform matrix, asset
// resolution, and extraction are unit-tested without any download.

import fs from "node:fs";
import path from "node:path";

export const RELEASES_LATEST_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";

/**
 * Choose the release-asset platform tag for this host. Returns
 * { platformTag, ext, gpu } or null for an unsupported combo.
 * `hasGpu` should be true when an NVIDIA GPU is detected; `forceVulkan` opts a
 * non-NVIDIA (e.g. AMD) box into the Vulkan build.
 */
export function pickLlamaAsset({ platform, arch, hasGpu = false, forceVulkan = false }) {
  const gpu = Boolean(hasGpu || forceVulkan);
  if (platform === "darwin") {
    return { platformTag: arch === "arm64" ? "macos-arm64" : "macos-x64", ext: "tar.gz", gpu: arch === "arm64" };
  }
  if (platform === "linux") {
    if (arch === "x64") return { platformTag: gpu ? "ubuntu-vulkan-x64" : "ubuntu-x64", ext: "tar.gz", gpu };
    if (arch === "arm64") return { platformTag: gpu ? "ubuntu-vulkan-arm64" : "ubuntu-arm64", ext: "tar.gz", gpu };
    return null;
  }
  if (platform === "win32" && arch === "x64") {
    return { platformTag: gpu ? "win-vulkan-x64" : "win-cpu-x64", ext: "zip", gpu };
  }
  return null;
}

export function assetName(tag, platformTag, ext) {
  return `llama-${tag}-bin-${platformTag}.${ext}`;
}

/**
 * From a GitHub release object, find the asset matching this platform tag + ext.
 * Matches on the `-bin-<platformTag>.<ext>` suffix so it is tag-agnostic.
 * Returns { name, url, size } or null.
 */
export function findReleaseAsset(release, platformTag, ext) {
  const suffix = `-bin-${platformTag}.${ext}`;
  const a = (release?.assets ?? []).find((x) => typeof x?.name === "string" && x.name.endsWith(suffix));
  return a ? { name: a.name, url: a.browser_download_url, size: a.size ?? null } : null;
}

/** Recursively locate an executable `llama-server`(.exe) under `dir`. */
export function findLlamaServer(dir, fsImpl = fs) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fsImpl.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "llama-server" || e.name === "llama-server.exe") return full;
    }
  }
  return null;
}

/**
 * Extract an archive into `dest` (created if needed) by shelling out via the
 * injected `run(cmd, args)`. `.tar.gz` and `.tar` use `tar`; `.zip` uses `tar`
 * too (bsdtar on modern Windows/macOS/Linux reads zips). Returns `dest`.
 */
export function extractArchive({ archive, dest, run }) {
  fs.mkdirSync(dest, { recursive: true });
  if (/\.zip$/i.test(archive)) run("tar", ["-xf", archive, "-C", dest]);
  else run("tar", ["-xzf", archive, "-C", dest]);
  return dest;
}

/** Default install root for fetched llama.cpp binaries. */
export function llamaInstallRoot() {
  return path.join(process.env.HOME || process.cwd(), ".bantam", "llama");
}
