// `bantam doctor --provision` — fetch a known-good GGUF from Hugging Face so a new
// user does not have to hunt one down. Defaults to the exact model this project
// runs (the 4-bit / Q4_K_M quant). The download is resumable and disk-checked
// because it is ~17 GB and will get interrupted.
//
// The core is pure over an injectable `fetchImpl`/`fsImpl` so resume, restart, and
// progress are unit-tested with tiny in-memory bodies — no real multi-GB pull.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";

export const DEFAULT_REPO = "llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF";
const MODEL_STEM = "Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved";
export const DEFAULT_QUANT = "Q4_K_M";

// Approximate on-disk sizes (bytes) for the sanity/disk checks; the real size is
// taken from Content-Length at download time.
export const QUANTS = {
  Q3_K_M: 14.1e9, Q3_K_L: 15.2e9,
  Q4_K_S: 16.2e9, Q4_K_M: 17211797600, // exact, confirmed from HF Content-Range
  Q5_K_S: 19.2e9, Q5_K_M: 19.7e9,
  Q6_K: 22.8e9, Q8_0: 29e9,
};

export function ggufName(quant = DEFAULT_QUANT) {
  return `${MODEL_STEM}-${quant}.gguf`;
}

export function resolveUrl({ repo = DEFAULT_REPO, file }) {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

/** Default target directory for downloaded models (matches doctor's scan list). */
export function modelsDir() {
  return process.env.BANTAM_MODELS_DIR || path.join(os.homedir(), "models");
}

/** Free bytes on the filesystem holding `dir` (walks up to an existing parent). */
export function freeDiskBytes(dir, fsImpl = fs) {
  let d = path.resolve(dir);
  while (!fsImpl.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const s = fsImpl.statfsSync(d);
    return s.bavail * s.bsize;
  } catch { return null; }
}

/**
 * Resolve what to fetch and whether there is room. `ggufUrl` overrides the repo
 * (power-user escape hatch); otherwise the quant selects the file in DEFAULT_REPO.
 */
export function planProvision({ dir = modelsDir(), quant = DEFAULT_QUANT, ggufUrl = null, freeBytes = null }) {
  const file = ggufUrl ? path.basename(new URL(ggufUrl).pathname) : ggufName(quant);
  const url = ggufUrl || resolveUrl({ file });
  const dest = path.join(dir, file);
  const expectedBytes = ggufUrl ? null : (QUANTS[quant] ?? null);
  const needBytes = expectedBytes ? Math.ceil(expectedBytes * 1.1) : null;
  const enoughDisk = freeBytes == null || needBytes == null ? null : freeBytes >= needBytes;
  return { url, dest, file, quant: ggufUrl ? null : quant, expectedBytes, needBytes, enoughDisk };
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** A single-line progress string. `elapsedMs` drives rate/ETA. */
export function renderProgress({ received, total, elapsedMs }) {
  const pct = total ? Math.min(100, (received / total) * 100) : null;
  const rate = elapsedMs > 0 ? received / (elapsedMs / 1000) : 0;
  const etaS = rate > 0 && total ? Math.max(0, (total - received) / rate) : null;
  const etaStr = etaS == null ? "?"
    : etaS >= 3600 ? `${Math.floor(etaS / 3600)}h${Math.floor((etaS % 3600) / 60)}m`
      : etaS >= 60 ? `${Math.floor(etaS / 60)}m${Math.floor(etaS % 60)}s`
        : `${Math.ceil(etaS)}s`;
  const head = pct == null ? formatBytes(received) : `${pct.toFixed(1)}%`;
  return `  ${head}  ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""}  ${formatBytes(rate)}/s  ETA ${etaStr}`;
}

/**
 * Stream `url` to `dest`, resuming from an existing `<dest>.part` via HTTP Range.
 * Injectable `fetchImpl`/`fsImpl`/`now` for tests. Returns { bytes, resumedFrom }.
 * A server that ignores Range (responds 200) restarts from zero. On success the
 * `.part` is atomically renamed to `dest`.
 */
export async function downloadResumable({
  url, dest, onProgress = () => {}, signal = null,
  fetchImpl = fetch, fsImpl = fs, now = Date.now,
}) {
  const part = `${dest}.part`;
  fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
  let resumedFrom = 0;
  try { resumedFrom = fsImpl.statSync(part).size; } catch { resumedFrom = 0; }

  const headers = resumedFrom > 0 ? { Range: `bytes=${resumedFrom}-` } : {};
  const res = await fetchImpl(url, { headers, signal, redirect: "follow" });

  // Server ignored the Range and is sending the whole file again → restart clean.
  if (resumedFrom > 0 && res.status !== 206) {
    resumedFrom = 0;
    try { fsImpl.rmSync(part, { force: true }); } catch { /* ignore */ }
  }
  if (!res.ok && res.status !== 206) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }

  const contentLength = Number(res.headers.get("content-length") || 0) || 0;
  const total = resumedFrom + contentLength || null;
  const out = fsImpl.createWriteStream(part, { flags: resumedFrom > 0 ? "a" : "w" });
  const startedAt = now();
  let received = resumedFrom;
  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
      if (!out.write(chunk)) await once(out, "drain");
      received += chunk.length;
      onProgress({ received, total, elapsedMs: now() - startedAt });
    }
  } finally {
    out.end();
    await once(out, "finish").catch(() => {
      // Ignore — stream already finished.
    });
  }
  if (total && received < total) {
    throw new Error(`download truncated: got ${received} of ${total} bytes (re-run to resume)`);
  }
  fsImpl.renameSync(part, dest);
  return { bytes: received, resumedFrom };
}
