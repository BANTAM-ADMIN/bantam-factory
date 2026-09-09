// chat-sessions.js — held-open sessions on a chat-completions bridge (codexapi).
//
// A reused codexapi session sends ONLY the newest message and the thread keeps
// its own replies: measured 2026-08-24, a warm turn costs ~1.7 s against ~3.3 s
// cold, and the client stops resending a growing transcript. BANTAM's canonical
// prompt is rebuilt every turn, so the planner decides per prompt:
//   delta      — the prompt is a byte-extension of the run's last prompt: send
//                the new user content on the run session.
//   rebase     — same head (system + task) but not an extension (the harness
//                rewrote history): a NEW session with the full transcript; the
//                old one is retired for deletion.
//   ephemeral  — a different head (an auxiliary call): no session at all, and
//                the run session is left exactly as it was.
// A server that lost the session answers 409 session_unavailable, never a
// silent fresh start; `lost()` makes the next call a full transcript again.

import { randomBytes } from "node:crypto";
import { chatMessagesFromPrompt } from "./openai-transport.js";

const START = "<|im_start|>";
const END = "<|im_end|>";

/** The prompt without its trailing OPEN assistant turn (the generation prefill). */
function withoutOpenAssistant(prompt) {
  const i = prompt.lastIndexOf(`${START}assistant`);
  if (i === -1) return prompt;
  return prompt.indexOf(END, i) === -1 ? prompt.slice(0, i) : prompt;
}

/** System + first user turn: the identity of one run's main line. */
function headOf(prompt) {
  const firstUser = prompt.indexOf(`${START}user`);
  if (firstUser === -1) return prompt;
  const close = prompt.indexOf(END, firstUser);
  return close === -1 ? prompt : prompt.slice(0, close + END.length);
}

export class ChatSessionPlanner {
  constructor({ prefix = "bantam", deleteSession = null } = {}) {
    this.prefix = prefix;
    this.deleteSession = typeof deleteSession === "function" ? deleteSession : null;
    this.run = null;            // { id, head, lastPrompt }
    this.retired = [];          // session ids to delete
    this.deletes = [];          // in-flight DELETE promises, awaited by release()
    this.pending = null;        // the plan awaiting commit
    this.stats = { full: 0, delta: 0, ephemeral: 0, rebases: 0, lost: 0 };
  }

  _newId() {
    return `${this.prefix}-${randomBytes(4).toString("hex")}`;
  }

  plan(prompt) {
    const text = String(prompt ?? "");
    if (this.run && typeof this.run.lastPrompt === "string") {
      const base = withoutOpenAssistant(this.run.lastPrompt);
      const acknowledged = this.run.lastCompletion;
      // Dropping the assistant suffix is safe only if the bridge actually
      // acknowledged those exact bytes. A rewrite or synthetic reply rebases.
      const reply = `${START}assistant\n${acknowledged}${END}\n`;
      if (typeof acknowledged === 'string' && text.startsWith(base + reply)) {
        const users = chatMessagesFromPrompt(text.slice(base.length)).filter((m) => m.role === "user" && m.content);
        if (users.length) {
          return this._pend({ sessionId: this.run.id, delta: true, kind: "delta",
            messages: [{ role: "user", content: users.map((m) => m.content).join("\n\n") }] });
        }
      }
      if (headOf(text) !== this.run.head) {
        return this._pend({ sessionId: null, delta: false, kind: "ephemeral", messages: chatMessagesFromPrompt(text) });
      }
      return this._pend({ sessionId: this._newId(), delta: false, kind: "rebase", messages: chatMessagesFromPrompt(text) });
    }
    return this._pend({ sessionId: this._newId(), delta: false, kind: "full", messages: chatMessagesFromPrompt(text) });
  }

  _pend(plan) { this.pending = plan; return plan; }

  /** The call succeeded: the session now holds this prompt's content. */
  commit(plan, prompt, completion = null) {
    if (!plan) return;
    if (plan.kind === "ephemeral") { this.stats.ephemeral += 1; return; }
    const lastCompletion = typeof completion === 'string' ? completion.trim() : null;
    if (plan.kind === "delta") { this.stats.delta += 1; this.run.lastPrompt = String(prompt); this.run.lastCompletion = lastCompletion; return; }
    if (plan.kind === "rebase") { this.stats.rebases += 1; if (this.run) this._retire(this.run.id); }
    else this.stats.full += 1;
    this.run = { id: plan.sessionId, head: headOf(String(prompt)), lastPrompt: String(prompt), lastCompletion };
  }

  /** The server reported the session gone (409 session_unavailable). */
  lost() {
    this.stats.lost += 1;
    this.run = null;
    this.pending = null;
  }

  _retire(id) {
    if (!id) return;
    this.retired.push(id);
    const result = this.deleteSession?.(id);
    if (result && typeof result.then === "function") this.deletes.push(result.catch(() => {}));
  }

  beginRun() {
    // A grammar probe is a different conversation. Do not let its head make
    // every real task turn look like an ephemeral auxiliary request.
    if (this.run) this._retire(this.run.id);
    this.run = null;
    this.pending = null;
  }

  /**
   * Run over: free the server-side thread(s). Resolves once the deletes have
   * settled — a process exiting right after a fire-and-forget DELETE loses
   * it, and with the server's TTL at 0 the session then lives forever.
   */
  async release() {
    if (this.run) this._retire(this.run.id);
    this.run = null;
    this.pending = null;
    const inflight = this.deletes.splice(0);
    await Promise.allSettled(inflight);
  }
}
