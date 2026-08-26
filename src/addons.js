// Add-ons: everything BANTAM can use but does not ship. The harness repo
// stays pure — no weights, no inference server, no voice models vendored.
// Add-ons install under ~/.bantam/addons/<name> on explicit request
// (doctor --setup, or `bantam addons install <name>`), with sizes shown
// before any download and checksummed/resumable transfers.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findLlamaServer } from "./llama-install.js";
import { DEFAULT_REPO, DEFAULT_QUANT, QUANTS, EXTRAS, ggufName, modelsDir } from "./provision.js";

export function addonsRoot() {
  return process.env.BANTAM_ADDONS_DIR || path.join(os.homedir(), ".bantam", "addons");
}

const GB = (n) => `${(n / 1e9).toFixed(1)} GB`;

export const ADDONS = [
  {
    name: "llama-cpp",
    label: "llama.cpp server (prebuilt)",
    what: "local inference server — Vulkan/Metal prebuilt, ~50 MB",
    status() {
      const bin = findLlamaServer(path.join(addonsRoot(), "llama-cpp"));
      return bin ? { installed: true, detail: bin } : { installed: false, detail: "not installed" };
    },
    installHint: "bantam doctor --install-llama",
  },
  {
    name: "local-model",
    label: `local model (${DEFAULT_REPO})`,
    what: `stock Apache-2.0 weights, ${GB(QUANTS[DEFAULT_QUANT])} (${DEFAULT_QUANT}) — the bench-record model`,
    status() {
      const f = path.join(modelsDir(), ggufName());
      try { const st = fs.statSync(f); return { installed: st.size > 1e9, detail: f }; }
      catch { return { installed: false, detail: `not found in ${modelsDir()}` }; }
    },
    installHint: "bantam doctor --provision",
  },
  {
    name: "vision",
    label: "vision companion (mmproj)",
    what: `screenshot/image input for the local model, ${GB(EXTRAS.vision.bytes)}`,
    status() {
      const f = path.join(modelsDir(), EXTRAS.vision.file);
      return fs.existsSync(f) ? { installed: true, detail: f } : { installed: false, detail: "not installed" };
    },
    installHint: "bantam doctor --provision-extra vision",
  },
  {
    name: "mtp",
    label: "speculative-decoding sidecar (MTP)",
    what: `faster generation for the local model, ${GB(EXTRAS.mtp.bytes)}`,
    status() {
      const f = path.join(modelsDir(), EXTRAS.mtp.file);
      return fs.existsSync(f) ? { installed: true, detail: f } : { installed: false, detail: "not installed" };
    },
    installHint: "bantam doctor --provision-extra mtp",
  },
  {
    name: "voice",
    label: "voice I/O",
    what: "talk to BANTAM out loud — LitheVoice engine (local VAD/STT/TTS, ~4 GB of models fetched by ITS installer) or any provider implementing src/voice/contract.md",
    status() {
      const d = path.join(addonsRoot(), "voice");
      return fs.existsSync(d) ? { installed: true, detail: d } : { installed: false, detail: "not installed" };
    },
    installHint: "git clone the LitheVoice repo into ~/.bantam/addons/voice, then run its scripts/setup.sh (fetches pinned, hash-verified voice models with consent)",
  },
];

export function renderAddons() {
  const lines = ["Add-ons live in " + addonsRoot() + " and " + modelsDir() + " — never in the repo.", ""];
  for (const a of ADDONS) {
    const st = a.status();
    lines.push(`  ${st.installed ? "●" : "○"} ${a.name.padEnd(12)} ${a.label}`);
    lines.push(`      ${a.what}`);
    lines.push(`      ${st.installed ? st.detail : "install: " + a.installHint}`);
  }
  return lines.join("\n");
}
