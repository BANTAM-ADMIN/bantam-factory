// Helpers for offering saved interactive chat runs at REPL startup.
import fs from "node:fs";
import path from "node:path";

/** Return completed chat artifacts newest-first for this workspace. */
export function listSavedChatRuns(workspace, { limit = 20 } = {}) {
  const dir = path.join(path.resolve(workspace), ".bantam", "runs");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
        if (artifact.kind !== "bantam-chat-run" || !Array.isArray(artifact.turns)) return null;
        return { path: file, name, artifact };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.artifact.startedAt ?? b.name).localeCompare(String(a.artifact.startedAt ?? a.name)))
    .slice(0, Math.max(0, limit));
}

/** Compact labels suitable for a numbered interactive picker. */
export function describeSavedChatRun(run) {
  const artifact = run?.artifact ?? {};
  const request = String(artifact.request ?? "").replace(/\s+/g, " ").trim();
  const date = String(artifact.startedAt ?? "").replace("T", " ").slice(0, 16);
  const status = artifact.disposition ?? (artifact.partial ? "partial" : "saved");
  return `${date}  ${status}  ${request.slice(0, 100)}${request.length > 100 ? "…" : ""}`;
}
