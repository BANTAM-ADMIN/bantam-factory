// The room: messages with per-agent read cursors, acknowledgments, a
// long-poll wait, and a task board whose transitions are enforced in code.
// All state is derived from the RoomStore log, so a restart replays it.
import { ToolError } from "./protocol.js";

export const MESSAGE_KINDS = Object.freeze(["note", "question", "finding", "blocker", "review_request", "handoff", "event"]);
export const TASK_STATES = Object.freeze(["ready", "claimed", "working", "review", "verified", "done", "blocked"]);
export const MAX_TEXT = 16 * 1024;
export const MAX_WAIT_MS = 600_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

// [from, to, who]: who may make the move. "owner" = the task's owner,
// "other" = anyone but the owner (independent verification), "any" = anyone.
// The operator (the human) may make any listed move.
const MOVES = [
  ["claimed", "working", "owner"], ["claimed", "review", "owner"], ["claimed", "ready", "owner"], ["claimed", "blocked", "owner"],
  ["working", "review", "owner"], ["working", "blocked", "owner"], ["working", "ready", "owner"],
  ["review", "verified", "other"], ["review", "working", "any"], ["review", "blocked", "any"],
  ["verified", "done", "any"], ["verified", "working", "any"],
  ["blocked", "working", "owner"], ["blocked", "ready", "owner"],
];

export class Room {
  constructor(store) {
    this.store = store;
    this.messages = [];
    this.cursors = new Map();
    this.acks = new Map();
    this.tasks = new Map();
    for (const record of store.records()) this.apply(record);
    store.onAppend((record) => this.apply(record));
  }

  apply(record) {
    if (record.type === "message") this.messages.push(record);
    else if (record.type === "cursor") this.cursors.set(record.agent, Math.max(this.cursors.get(record.agent) ?? 0, record.upTo));
    else if (record.type === "ack") {
      const by = this.acks.get(record.message) ?? new Set();
      by.add(record.by);
      this.acks.set(record.message, by);
    } else if (record.type === "task") this.tasks.set(record.task.id, record.task);
  }

  post(from, { to, kind = "note", text, task = null, replyTo = null, artifacts = [] }) {
    const recipients = [].concat(to ?? []);
    if (!recipients.length) throw new ToolError("to needs at least one recipient (an agent name, or \"all\")");
    const bad = recipients.find((name) => name !== "all" && !NAME.test(name));
    if (bad !== undefined) throw new ToolError(`not an agent name: ${JSON.stringify(bad)}`);
    if (!MESSAGE_KINDS.includes(kind)) throw new ToolError(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
    if (typeof text !== "string" || !text.trim()) throw new ToolError("text must not be empty");
    if (Buffer.byteLength(text) > MAX_TEXT) throw new ToolError(`text exceeds ${MAX_TEXT} bytes; put long material in a file and list it in artifacts`);
    if (artifacts.length > 16) throw new ToolError("at most 16 artifacts per message");
    if (replyTo && !this.messages.some((m) => m.id === replyTo)) throw new ToolError(`no message ${replyTo} to reply to`);
    if (task && !this.tasks.has(task)) throw new ToolError(`no task ${task}`);
    const seq = this.store.lastSeq + 1;
    const record = this.store.append({ type: "message", id: `m${seq}`, from, to: [...new Set(recipients)], kind, text,
      ...(task ? { task } : {}), ...(replyTo ? { replyTo } : {}), ...(artifacts.length ? { artifacts } : {}) });
    return { id: record.id, seq: record.seq };
  }

  addressedTo(agent, message) {
    return message.from !== agent && (message.to.includes(agent) || message.to.includes("all"));
  }

  unread(agent) {
    const cursor = this.cursors.get(agent) ?? 0;
    return this.messages.filter((m) => m.seq > cursor && this.addressedTo(agent, m));
  }

  inbox(agent, { limit = 50 } = {}) {
    const all = this.unread(agent);
    const messages = all.slice(0, Math.max(1, Math.min(limit, 50)));
    if (messages.length) this.store.append({ type: "cursor", agent, upTo: messages.at(-1).seq });
    return { messages: messages.map(view), remaining: all.length - messages.length };
  }

  /** Resolve with unread messages as soon as there are any, or empty on timeout. */
  wait(agent, { timeoutMs = 240_000, signal = null } = {}) {
    if (this.unread(agent).length) return Promise.resolve({ ...this.inbox(agent), timedOut: false });
    const limit = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
    return new Promise((resolve) => {
      let timer = null, stop = null;
      const finish = (value) => {
        clearTimeout(timer);
        stop?.();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      // Released without taking anything: the messages stay unread for the next call.
      const onAbort = () => finish({ messages: [], remaining: this.unread(agent).length, timedOut: false, aborted: true });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      stop = this.store.onAppend((record) => {
        if (record.type !== "message" || !this.addressedTo(agent, record)) return;
        // Let the append finish (other listeners) before reading the cursor forward.
        // A second wait by the same agent may have taken it already; keep waiting then.
        queueMicrotask(() => { if (!signal?.aborted && this.unread(agent).length) finish({ ...this.inbox(agent), timedOut: false }); });
      });
      timer = setTimeout(() => finish({ messages: [], remaining: 0, timedOut: true }), limit);
    });
  }

  ack(agent, id) {
    const message = this.messages.find((m) => m.id === id);
    if (!message) throw new ToolError(`no message ${id}`);
    if (!this.addressedTo(agent, message)) throw new ToolError(`${id} was not addressed to ${agent}`);
    this.store.append({ type: "ack", by: agent, message: id });
    return { acknowledged: id };
  }

  history({ sinceSeq = 0, limit = 100 } = {}) {
    const rows = this.messages.filter((m) => m.seq > sinceSeq).slice(0, Math.min(limit, 200));
    return { messages: rows.map((m) => ({ ...view(m), ackedBy: [...(this.acks.get(m.id) ?? [])] })), lastSeq: this.store.lastSeq };
  }

  createTask(by, { title, detail = "" }) {
    if (typeof title !== "string" || !title.trim()) throw new ToolError("title must not be empty");
    const id = `t${this.tasks.size + 1}`;
    const now = new Date().toISOString();
    const task = { id, title: title.trim(), detail, state: "ready", owner: null, createdBy: by, updatedBy: by, note: null, createdAt: now, updatedAt: now };
    this.store.append({ type: "task", task });
    return task;
  }

  requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new ToolError(`no task ${id}`);
    return task;
  }

  claimTask(by, id) {
    const task = this.requireTask(id);
    if (task.state !== "ready") throw new ToolError(`${id} is ${task.state}${task.owner ? ` (owner ${task.owner})` : ""}; only a ready task can be claimed`);
    return this.writeTask(task, by, { state: "claimed", owner: by, note: null });
  }

  updateTask(by, id, state, note = null) {
    const task = this.requireTask(id);
    const move = MOVES.find(([from, to]) => from === task.state && to === state);
    if (!move) {
      const allowed = MOVES.filter(([from]) => from === task.state).map(([, to]) => to);
      throw new ToolError(`${id} cannot move ${task.state} → ${state}${allowed.length ? `; from ${task.state} it can go to ${allowed.join(", ")}` : ` (${task.state} is final)`}`);
    }
    const who = move[2];
    if (by !== "operator") {
      if (who === "owner" && by !== task.owner) throw new ToolError(`only ${task.owner} (the owner) can move ${id} to ${state}`);
      if (who === "other" && by === task.owner) throw new ToolError(`${id} must be verified by someone other than its owner ${task.owner}`);
    }
    return this.writeTask(task, by, { state, note, ...(state === "ready" ? { owner: null } : {}) });
  }

  writeTask(task, by, change) {
    const next = { ...task, ...change, updatedBy: by, updatedAt: new Date().toISOString() };
    this.store.append({ type: "task", task: next });
    return next;
  }

  listTasks({ state = null } = {}) {
    return { tasks: [...this.tasks.values()].filter((t) => !state || t.state === state) };
  }
}

function view(m) {
  return { id: m.id, seq: m.seq, at: m.at, from: m.from, to: m.to, kind: m.kind, text: m.text,
    ...(m.task ? { task: m.task } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.artifacts ? { artifacts: m.artifacts } : {}) };
}
