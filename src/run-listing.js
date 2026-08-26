// Browse the .bantam/runs shelf.
//
// Chat evidence (src/chat-evidence.js) writes one artifact per request; headless
// --save-run adds more. The shelf is the operator's audit surface — "what was
// the model HANDED" starts with finding the right file. `bantam runs` prints
// this listing; `bantam runlens <file>` digests one artifact.

import fs from "node:fs";
import path from "node:path";

/** Rows for every artifact under <workspace>/.bantam/runs, newest first. */
export function listRunArtifacts(workspace) {
  const dir = path.join(workspace, ".bantam", "runs");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];   // no shelf yet is a normal state
  }
  return names.sort().reverse().map((name) => {
    const file = path.join(dir, name);
    try {
      const a = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        file,
        name,
        kind: a.kind ?? "bantam-run",
        partial: a.partial === true,
        truncatedBy: a.truncatedBy ?? null,
        disposition: a.disposition ?? (a.done ? "done" : null),
        turns: a.turnCount ?? (Array.isArray(a.turns) ? a.turns.length : 0),
        head: String(a.request ?? a.task ?? "").replace(/\s+/g, " ").slice(0, 80),
        summary: String(a.summary ?? "").replace(/\s+/g, " ").slice(0, 80),
      };
    } catch {
      return { file, name, unreadable: true };
    }
  });
}

export function formatRunsListing(rows) {
  if (!rows.length) return "no run artifacts here yet — chat requests and `bantam run --save-run` write them to .bantam/runs/";
  const lines = rows.map((r) => {
    if (r.unreadable) return `  ${r.name}  (unreadable)`;
    const state = r.partial ? `partial(${r.truncatedBy ?? "?"})` : (r.disposition ?? "?");
    const tail = r.summary ? ` — ${r.summary}` : "";
    return `  ${r.name}\n    ${state} · ${r.turns} turns · ${r.head}${tail}`;
  });
  return `${rows.length} run artifact${rows.length === 1 ? "" : "s"} (newest first):\n${lines.join("\n")}\n\ninspect one: bantam runlens <file>`;
}
