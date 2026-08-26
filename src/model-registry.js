// Editing .bantam/models.json — the registration path behind `bantam models`.
//
// Reading the registry is deliberately forgiving: listModels() drops entries
// whose start script is missing so that a stranger's stale registry cannot
// masquerade as working models. That forgiveness is exactly why WRITING has to
// be strict. A typo'd path used to be a silent no-show — the model simply never
// appeared in the startup picker and nothing said why. Every check that the
// reader skips is enforced here, at the one moment an operator is present to
// read the complaint.
import fs from "node:fs";
import path from "node:path";

import { defaultModelRegistryPath, normalizeModelEntry } from "./model-launcher.js";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:8085";

/** Which registry file a write lands in: BANTAM_MODELS wins, else this checkout's. */
export function registryPathForWrite() {
  return process.env.BANTAM_MODELS || defaultModelRegistryPath();
}

/**
 * Read a registry file. Absent is an empty registry; unparseable THROWS —
 * returning [] there would let the next add overwrite a file the operator
 * hand-edited and merely fumbled.
 */
export function readRegistryFile(file = registryPathForWrite()) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("registry must be a JSON array");
  return parsed.map(normalizeModelEntry);
}

function writeRegistryFile(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function numberOrError(value, field) {
  if (value === undefined || value === null || value === "") return { ok: true };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${field} must be a positive number (got "${value}")` };
  return { ok: true, value: n };
}

/** Validate a registration request; returns the entry to store, or an error. */
export function validateModelEntry(input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "a model needs a name (used by `bantam swap <name>` and `:model <name>`)" };

  const scriptInput = String(input.script ?? "").trim();
  if (!scriptInput) return { ok: false, error: "a model needs --script: the shell script that starts its llama-server" };
  const script = path.resolve(scriptInput);
  if (!fs.existsSync(script)) {
    return { ok: false, error: `no launch script at ${script}` };
  }
  const stat = fs.statSync(script);
  if (stat.isDirectory()) {
    // The natural mistake: pointing at the model folder. Name what is in there
    // so the correction is one copy-paste away.
    let candidates = [];
    try { candidates = fs.readdirSync(script).filter((f) => f.endsWith(".sh")).sort(); }
    catch { /* unreadable — the base message still stands */ }
    const hint = candidates.length
      ? ` — launch scripts found there: ${candidates.join(", ")}`
      : " — point --script at the .sh that starts llama-server, not the model folder";
    return { ok: false, error: `${script} is a directory${hint}` };
  }

  const endpoint = String(input.endpoint ?? "").trim() || DEFAULT_ENDPOINT;
  let parsedEndpoint;
  try { parsedEndpoint = new URL(endpoint); }
  catch { return { ok: false, error: `endpoint must be a URL like ${DEFAULT_ENDPOINT} (got "${endpoint}")` }; }
  if (!/^https?:$/.test(parsedEndpoint.protocol)) {
    return { ok: false, error: `endpoint must be http or https (got "${endpoint}")` };
  }

  // `priority` ranks the startup picker: the highest-priority registered model
  // is the one recommended and listed first. `warn` is shown right there in the
  // picker, because the reason not to choose something has to be visible at the
  // moment of choosing.
  const priority = numberOrError(input.priority, "--priority");
  if (!priority.ok) return priority;
  const slots = numberOrError(input.slots, "--slots");
  if (!slots.ok) return slots;
  const ctx = numberOrError(input.ctx, "--ctx");
  if (!ctx.ok) return ctx;
  const vramMb = numberOrError(input.vramMb, "--vram-mb");
  if (!vramMb.ok) return vramMb;

  const entry = { name, endpoint: endpoint.replace(/\/$/, ""), script };
  if (input.vision) entry.vision = true;
  if (slots.value !== undefined) entry.slots = slots.value;
  if (ctx.value !== undefined) entry.ctx = ctx.value;
  if (vramMb.value !== undefined) entry.vramMb = vramMb.value;
  if (String(input.match ?? "").trim()) entry.match = String(input.match).trim();
  if (String(input.profile ?? "").trim()) entry.profile = String(input.profile).trim();
  if (String(input.notes ?? "").trim()) entry.notes = String(input.notes).trim();
  if (priority.value !== undefined) entry.priority = priority.value;
  if (String(input.warn ?? "").trim()) entry.warn = String(input.warn).trim();
  return { ok: true, entry, executable: Boolean(stat.mode & 0o111) };
}

/** Register one model. `replace: true` overwrites an entry with the same name. */
export function addModel(input, { file = registryPathForWrite(), replace = false } = {}) {
  const checked = validateModelEntry(input);
  if (!checked.ok) return checked;

  let entries;
  try { entries = readRegistryFile(file); }
  catch (err) { return { ok: false, error: `could not read ${file}: ${err.message}` }; }

  const at = entries.findIndex((e) => String(e.name ?? "").toLowerCase() === checked.entry.name.toLowerCase());
  if (at !== -1 && !replace) {
    return { ok: false, error: `"${entries[at].name}" is already registered — pass --replace to overwrite it` };
  }
  if (at === -1) entries.push(checked.entry);
  else entries[at] = checked.entry;

  writeRegistryFile(file, entries);
  return { ok: true, entry: checked.entry, file, replaced: at !== -1, executable: checked.executable };
}

/** Unregister one model by name (or by its display label). */
export function removeModel(name, { file = registryPathForWrite() } = {}) {
  const wanted = String(name ?? "").trim().toLowerCase();
  if (!wanted) return { ok: false, error: "which model? pass a name from `bantam models`" };

  let entries;
  try { entries = readRegistryFile(file); }
  catch (err) { return { ok: false, error: `could not read ${file}: ${err.message}` }; }

  const at = entries.findIndex((e) => String(e.name ?? "").toLowerCase() === wanted
    || String(e.label ?? "").toLowerCase() === wanted);
  if (at === -1) return { ok: false, error: `"${name}" is not registered — see \`bantam models\`` };

  const [removed] = entries.splice(at, 1);
  writeRegistryFile(file, entries);
  return { ok: true, removed, file };
}
