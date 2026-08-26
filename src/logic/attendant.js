// attendant.js — the live second voice during a run (A/B-tested 2026-08-19).
//
// While the worker slot grinds a task, the operator's mid-run messages get an
// INSTANT answer from the sibling slot instead of waiting for the next turn
// boundary. The architecture is the one that won the bake-off: a mechanical
// digest for shape (O(1) size, can't bloat) plus the last few raw turns as
// the authority on current state (self-healing — the digest-only arm lost a
// point to its own author's blind spot). The user experiences one agent that
// can talk while its hands are busy; the prompt keeps the agent honest about
// which hand is which.
//
// The steer contract is unchanged: the message ALSO lands in the worker's
// injection queue exactly as before. The attendant answers from the observer
// seat and says so.

export function makeAttendantState() {
  return { turns: [], lastAction: null };
}

/** Feed run events (the same stream the logger sees). */
export function noteAttendantEvent(state, e) {
  if (!state || !e) return;
  if (e.type === "action") {
    state.lastAction = { action: e.action ?? null, reasoning: e.reasoning ?? "", observation: "" };
    state.turns.push(state.lastAction);
  } else if (e.type === "observation" && state.lastAction) {
    state.lastAction.observation = String(e.text ?? e.observation ?? "").slice(0, 800);
  } else if (e.type === "shell_output" && state.lastAction) {
    state.lastAction.observation = (state.lastAction.observation + "\n" + String(e.text ?? "")).slice(-800);
  }
}

const EDIT_VERBS = new Set(["write_file", "patch", "replace", "write_batch"]);
const ERR_RE = /Traceback|FAILED|SyntaxError|error:/i;

/** Mechanical digest: O(1) size, every negative fact defers to the tail. */
export function buildRunDigest(turns) {
  const edits = [];
  let shells = 0;
  const errTurns = [];
  turns.forEach((t, i) => {
    const a = t.action ?? {};
    if (EDIT_VERBS.has(a.a)) {
      const p = a.p ?? (Array.isArray(a.files) ? a.files.map((f) => f?.p).filter(Boolean).join(", ") : null);
      if (p && !edits.includes(p)) edits.push(p);
    }
    if (a.a === "shell") shells += 1;
    if (ERR_RE.test(t.observation ?? "")) errTurns.push(i + 1);
  });
  return [
    "STATUS DIGEST (auto-generated):",
    `- turns so far: ${turns.length}`,
    `- files edited: ${edits.join(", ") || "none yet"}`,
    `- shell commands run: ${shells}`,
    `- errors seen at turn(s): ${errTurns.join(", ") || "none"} — RECENT TURNS below are authoritative for whether anything was since RESOLVED`,
  ].join("\n");
}

function turnText(t, i) {
  const a = JSON.stringify(t.action ?? {}, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v));
  return `[turn ${i + 1}] thinking: ${(t.reasoning ?? "").slice(0, 250)}\naction: ${a.slice(0, 400)}\nresult: ${(t.observation ?? "").slice(0, 500)}`;
}

export function renderTail(turns, n = 3) {
  return turns.slice(-n).map((t, i) => turnText(t, turns.length - Math.min(n, turns.length) + i)).join("\n");
}

/** The full chat-formatted attendant prompt (Qwen template). */
export function buildAttendantPrompt({ task, turns, question, persona = null }) {
  const sys = [
    "You are BANTAM's live voice. Your sibling agent (another slot of the same local model) is executing the task below right now; you watch its event stream and answer the operator instantly.",
    "Know your own nature: you yourself ARE the second-slot live-chat capability — your reply here is proof it works. Never go hunting for evidence of your own existence.",
    "Speak first person as one agent — 'I' — and be honest about the seat: you are observing, and the operator's message has ALSO been queued for the working sibling to act on at its next turn boundary.",
    "Answer ONLY from the observed activity; where the activity does not show the answer, say plainly what you do and don't know. 2-4 sentences, concrete.",
    "Your reply is also handed to the working sibling at its next turn boundary, so write it to serve both readers: the operator now, and your sibling as a record of what was already said.",
    ...(persona ? [`YOUR VOICE (personality for this seat only — the working sibling keeps its own demeanor): ${persona}`] : []),
    `TASK IN PROGRESS: ${task}`,
  ].join("\n");
  const digest = buildRunDigest(turns);
  const tail = renderTail(turns);
  return `<|im_start|>user\n${sys}\n\n${digest}\n\nRECENT TURNS (raw, authoritative for current state):\n${tail}\n\nOPERATOR SAYS: ${question}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

/**
 * Frame one injected message for the worker's context. Strings are user
 * interjections (the historical shape); {kind:"attendant"} messages are the
 * worker's OWN live voice reporting what it already told the operator — framed
 * so the worker continues without confusion: no re-answering, no mistaking
 * its own voice for the user, correction only if the voice misspoke.
 */
export function frameInjection(m) {
  const msg = typeof m === "string" ? { kind: "user", text: m } : (m ?? { kind: "user", text: "" });
  if (msg.kind === "attendant") {
    return `[Your own live voice — the attendant on the sibling slot — already answered the operator while you worked. It speaks for you; do not answer the same question again. If it misspoke, correct the record briefly in your next respond.]: ${msg.text}`;
  }
  return `[The user interjected while you were working — take this into account and adjust course now]: ${msg.text}`;
}
