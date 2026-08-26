import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-file.js";

export function modelPreferencePath(root = process.cwd()) {
  return path.join(path.resolve(root), ".bantam", "model-preference.json");
}

export function loadModelPreference(root = process.cwd()) {
  try {
    const value = JSON.parse(fs.readFileSync(modelPreferencePath(root), "utf8"));
    if (!value || typeof value !== "object" || typeof value.kind !== "string") return null;
    return {
      kind: value.kind,
      name: typeof value.name === "string" ? value.name : null,
      model: typeof value.model === "string" ? value.model : null,
      effort: typeof value.effort === "string" ? value.effort : null,
      savedAt: typeof value.savedAt === "string" ? value.savedAt : null,
    };
  } catch {
    return null;
  }
}

export function saveModelPreference(preference, root = process.cwd()) {
  if (!preference || typeof preference !== "object" || typeof preference.kind !== "string") {
    throw new TypeError("model preference requires a kind");
  }
  const filePath = modelPreferencePath(root);
  writeJsonAtomic(filePath, {
    schema: 1,
    kind: preference.kind,
    name: preference.name ?? null,
    model: preference.model ?? null,
    effort: preference.effort ?? null,
    savedAt: new Date().toISOString(),
  });
  return filePath;
}

