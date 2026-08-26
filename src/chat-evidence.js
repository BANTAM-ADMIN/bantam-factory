// Every chat request leaves a run artifact.
//
// Headless `bantam run --save-run` writes `.bantam/runs/<stamp>.json`; chat
// requests wrote NOTHING, so the operator's standing rule — audit what the
// model was HANDED before attributing anything to it — was impossible for
// exactly the runs a person drives by hand. The cellui head-to-head
// (2026-08-17) had to be graded by parsing a console log.
//
// Reuses RunCheckpoint: its autosave gives crash evidence mid-request
// (partial: true), and finalize() overwrites with the completed artifact.
// Deliberately NOT armed on signals — the chat REPL owns Ctrl-C semantics
// (cancel the request, keep the session), and RunCheckpoint.arm() would turn
// that into a process exit.

import fs from "node:fs";
import path from "node:path";
import { RunCheckpoint, attachModelRequestCheckpoint } from "./run-checkpoint.js";

export function beginChatEvidence({
  workspace,
  request,
  index,
  model,
  enabled = process.env.BANTAM_CHAT_RUNS !== "0",
  now = new Date(),
} = {}) {
  if (!enabled) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = path.join(workspace, ".bantam", "runs", `${stamp}-chat-r${index}.json`);
  const meta = {
    kind: "bantam-chat-run",
    request: String(request ?? ""),
    requestIndex: index,
    workspace,
    startedAt: now.toISOString(),
    // The model's identity for the audit header (runlens shows it as `model:`).
    endpoint: model?.apiMode ? (model?.apiUrl ?? null) : (model?.endpoint ?? null),
  };
  const checkpoint = new RunCheckpoint({ dest, meta });
  // Exact model request records — the prompt bytes — are the audit's subject.
  const detachModel = attachModelRequestCheckpoint(model, checkpoint);
  let finalized = false;
  return {
    dest,
    note: (event) => checkpoint.note(event),
    /** Write the completed artifact. Never throws: evidence must not break the session. */
    finalize(res = null, err = null) {
      if (finalized) return dest;
      finalized = true;
      detachModel();
      checkpoint.complete();   // disarm the partial-flush path; we write the real thing
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const body = {
          ...meta,
          schema: 2,
          partial: false,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - now.getTime(),
          // runAgent's result speaks in flags, not a single status field.
          disposition: err ? "error"
            : res?.blocked ? "blocked"
            : res?.interrupted ? "interrupted"
            : res?.responded ? "responded"
            : res?.done ? "done"
            : res ? "stopped" : null,
          verification: res?.verification ?? null,
          summary: res?.summary ?? null,
          error: err ? String(err?.message ?? err) : null,
          turns: checkpoint.turns(),
          turnCount: checkpoint.turns().length,
          rejectedOutputs: checkpoint.rejectedOutputs(),
          modelCalls: checkpoint.modelCalls(),
          events: checkpoint.events(),
        };
        const tmp = `${dest}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
        fs.renameSync(tmp, dest);
      } catch { /* an unwritable runs dir must never take down the REPL */ }
      return dest;
    },
  };
}
