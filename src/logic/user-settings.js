// user-settings.js — sticky chair preferences (~/.bantam/settings.json).
//
// Session toggles like :stream died with the session, so the operator had to
// re-type them every launch (hand-test, 2026-08-19). Toggling now persists;
// environment variables still override for scripted runs, and a missing or
// corrupt file is simply "no preferences" — never an error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function settingsPath(home = os.homedir()) {
  return path.join(home, ".bantam", "settings.json");
}

export function loadUserSettings(file = settingsPath()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

export function saveUserSetting(key, value, file = settingsPath()) {
  const cur = loadUserSettings(file);
  cur[key] = value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
    return true;
  } catch { return false; }
}
