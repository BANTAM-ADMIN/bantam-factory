// The room toolset: how an MCP client talks to the operator and to BANTAM's
// workers, and shares a task board with them.
import fs from "node:fs";
import path from "node:path";
import { MAX_TEXT, MESSAGE_KINDS, TASK_STATES } from "../room.js";

const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };

export function createRoomToolset() {
  let ctx = null;
  const room = () => ctx.room;
  return {
    name: "room",
    start(context) { ctx = context; },
    stop() {},
    tools: [
      {
        name: "room_brief",
        description: "Read the room's shared brief (the operator's goal and acceptance criteria) and collaboration protocol, plus who is here and the open tasks. Call this first in a new session.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_args, { caller }) => ({
          you: caller,
          room: ctx.roomDir,
          brief: read(path.join(ctx.roomDir, ".crew", "brief.md")).trim() || "(empty: ask the operator for the goal)",
          protocol: read(path.join(ctx.roomDir, ".crew", "protocol.md")).trim(),
          participants: ["operator (the human)", "bantam (BANTAM itself: job events)",
            ...[...new Set([caller, ...room().messages.map((m) => m.from)])].filter((n) => !["operator", "bantam"].includes(n))],
          openTasks: room().listTasks().tasks.filter((t) => t.state !== "done"),
          unreadForYou: room().unread(caller).length,
          toolsets: ctx.toolsets,
          mode: ctx.mode === "jev"
            ? "jev: DiffusionGemma is loaded and awake (jev_decide, jev_generate are fast); local jobs run BANTAM with a Codex stand-in for the local model"
            : "llama: local jobs run BANTAM on the local llama.cpp model; Jev starts on demand and trades the GPU with it",
        }),
      },
      {
        name: "room_post",
        description: "Post a message to the room. Address agents by name (\"operator\" is the human; \"all\" reaches everyone). Keep it short and actionable: what changed, who needs to act, what evidence to inspect (put long material in files and list them in artifacts).",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["to", "text"],
          properties: {
            to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "Recipient names, e.g. [\"operator\"] or [\"all\"]." },
            kind: { type: "string", enum: MESSAGE_KINDS, description: "Default note." },
            text: { type: "string", maxLength: MAX_TEXT },
            task: { type: "string", description: "Task id (t<n>) this concerns." },
            reply_to: { type: "string", description: "Message id (m<seq>) this answers." },
            artifacts: { type: "array", items: { type: "string" }, maxItems: 16, description: "File paths supporting the message." },
          },
        },
        handler: async (a, { caller }) => room().post(caller, { to: a.to, kind: a.kind, text: a.text, task: a.task, replyTo: a.reply_to, artifacts: a.artifacts ?? [] }),
      },
      {
        name: "room_inbox",
        description: "Return your unread messages (oldest first) and mark them read. Returns at once, possibly empty.",
        inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
        handler: async (a, { caller }) => room().inbox(caller, { limit: a.limit ?? 50 }),
      },
      {
        name: "room_wait",
        description: "Block until a message addressed to you arrives (job completions from BANTAM, notes from the operator), then return it like room_inbox. Use this instead of polling when you are waiting on a job or a reply. Returns timedOut: true if nothing came; call it again to keep waiting.",
        inputSchema: { type: "object", additionalProperties: false, properties: { timeout_s: { type: "integer", minimum: 1, maximum: 600, description: "Default 240." } } },
        handler: async (a, { caller, signal }) => room().wait(caller, { timeoutMs: (a.timeout_s ?? 240) * 1000, signal }),
      },
      {
        name: "room_ack",
        description: "Acknowledge a message (for questions, blockers and handoffs addressed to you), so its sender knows you have it.",
        inputSchema: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } } },
        handler: async (a, { caller }) => room().ack(caller, a.message),
      },
      {
        name: "room_history",
        description: "Read the room's message history without changing what is unread. Includes who acknowledged each message.",
        inputSchema: { type: "object", additionalProperties: false, properties: { since_seq: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
        handler: async (a) => room().history({ sinceSeq: a.since_seq ?? 0, limit: a.limit ?? 100 }),
      },
      {
        name: "task_create",
        description: "Add a task to the shared board (state ready).",
        inputSchema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 200 }, detail: { type: "string", maxLength: 8000 } } },
        handler: async (a, { caller }) => room().createTask(caller, a),
      },
      {
        name: "task_claim",
        description: "Claim a ready task before working on it. Fails if someone else holds it.",
        inputSchema: { type: "object", additionalProperties: false, required: ["task"], properties: { task: { type: "string" } } },
        handler: async (a, { caller }) => room().claimTask(caller, a.task),
      },
      {
        name: "task_update",
        description: "Move a task: claimed→working→review→verified→done, or blocked / back to ready. The owner moves its own task; review→verified must be done by someone other than the owner.",
        inputSchema: { type: "object", additionalProperties: false, required: ["task", "state"], properties: { task: { type: "string" }, state: { type: "string", enum: TASK_STATES }, note: { type: "string", maxLength: 4000 } } },
        handler: async (a, { caller }) => room().updateTask(caller, a.task, a.state, a.note ?? null),
      },
      {
        name: "task_list",
        description: "List tasks on the board, optionally by state.",
        inputSchema: { type: "object", additionalProperties: false, properties: { state: { type: "string", enum: TASK_STATES } } },
        handler: async (a) => room().listTasks({ state: a.state ?? null }),
      },
    ],
  };
}
