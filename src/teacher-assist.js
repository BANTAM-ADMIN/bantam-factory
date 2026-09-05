// Teacher-assist escalation for the stuck-test hook.
//
// The in-run stuck-test diagnosis (`diagnoseFailingTest`, agent.js) is the 27B
// diagnosing ITSELF: a focused reasoning pass on the one test that stays red. That
// path was A/B'd to a null-to-negative ceiling — up to four self-diagnosis passes on
// the same test and the model still couldn't crack it, because "the residual is model
// reasoning, not a lack of attempts" (agent.js). A logic bug whose cause the 27B can't
// articulate is not fixed by asking the same model to articulate it again.
//
// The measured lever (2026-07-20, gbnf-reach) is a STRONGER model's reasoning: hand a
// stronger "teacher" the failing test + the localized function and ask for the ROOT
// CAUSE in one or two sentences — no code. That teacher cause, fed back as a steer, took
// the 27B from 2/5 to 5/5 on the first action, where the behavioural symptom alone left
// it thrashing. This module is that escalation, wired to fire only AFTER self-diagnosis
// has already run and the test is still stuck.
//
// Honesty constraints baked in:
//  - OFF by default. Enabled only when a teacher is configured (BANTAM_TEACHER=1).
//  - The teacher returns a CAUSE, not code. We forbid code in the prompt and strip any
//    that leaks, so the 27B applies the diagnosis and does the work — no solution
//    transplant, no self-authored-test hazard.
//  - A dead/slow/empty teacher yields SILENCE, never a crash and never a false steer:
//    every failure path returns null. Saying nothing is safe; saying a wrong cause is not.
//  - Pluggable transport (`invoke`) so the teacher can be any stronger model — an external
//    CLI, a bigger local model, an API endpoint — and so tests mock it deterministically.

import { spawn } from "node:child_process";
import { testProvenanceGuidance } from "./logic/test-focus.js";

// Build the teacher prompt from the same materials the local diagnosis already has:
// the failing test's source, the implicated implementation source, and the concrete
// expected-vs-actual diff. Mirrors the by-hand prompt that produced the measured win.
export function buildTeacherPrompt({ testName, testSource, implSource, diff, task = "", testProvenance = "unknown" }) {
  const parts = [
    "You are a senior engineer diagnosing a bug for a less capable model that will apply your fix.",
    "A single test is stuck red after repeated attempts. Below are the failing test, the implicated implementation, and the concrete failure.",
    "A failing test alone does not establish whether its expectation, setup, implementation or environment is wrong.",
    "",
    "USER TASK:",
    task || "(task contract unavailable; do not invent requirements)",
    "",
    testProvenanceGuidance(testProvenance),
    "",
    `FAILING TEST (${testName || "unnamed"}):`,
    "```",
    (testSource || "(test source unavailable)").trim(),
    "```",
    "",
    "IMPLEMENTATION UNDER TEST:",
    "```",
    (implSource || "(implementation source unavailable)").trim(),
    "```",
  ];
  if (diff && String(diff).trim()) {
    parts.push("", `OBSERVED FAILURE: ${String(diff).trim()}`);
  }
  parts.push(
    "",
    "In 1-2 SENTENCES state the ROOT CAUSE supported by the evidence and exactly what must change to fix it; if a cause is not established, identify the missing evidence.",
    "Do NOT write corrected code or merely restate the symptom. Keep protected tests unchanged; for any other test, identify a specific task-supported expectation or setup defect before proposing a correction.",
  );
  return parts.join("\n");
}

// Clean a teacher reply into a usable cause, or null. We asked for prose, not code; if the
// reply is dominated by a code block we strip fenced code and keep the explanation, and if
// nothing explanatory remains we return null (a code transplant is exactly what we refuse).
export function parseTeacherCause(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text) return null;
  // Drop fenced code blocks; keep surrounding prose.
  const withoutFences = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (withoutFences.length >= 12) text = withoutFences;
  // A reply that is only a bare code line (e.g. "if (x) break;") with no prose is not a cause.
  if (!/[a-z]{3,}\s+[a-z]{3,}/i.test(text)) return null;
  // Bound the injected size so a runaway teacher can't flood the context.
  if (text.length > 900) text = text.slice(0, 900).replace(/\s+\S*$/, "") + " …";
  return text;
}

// A CLI-backed teacher: run `cmd` with the prompt on stdin, return stdout. Any nonzero
// exit, timeout, spawn error, or empty output resolves to null (silence, never throw).
export function makeCliTeacher(cmd, { timeoutMs = 120000 } = {}) {
  return (prompt, { signal } = {}) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn("/bin/sh", ["-c", cmd], { stdio: ["pipe", "pipe", "ignore"] });
      } catch { return finish(null); }
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(null); }, timeoutMs);
      const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* */ } finish(null); };
      if (signal) { if (signal.aborted) { onAbort(); } else signal.addEventListener("abort", onAbort, { once: true }); }
      let out = "";
      child.stdout.on("data", (d) => { out += d; if (out.length > 1_000_000) { try { child.kill("SIGKILL"); } catch { /* */ } } });
      child.on("error", () => { clearTimeout(timer); finish(null); });
      child.on("close", (code) => { clearTimeout(timer); finish(code === 0 && out.trim() ? out : null); });
      try { child.stdin.end(prompt); } catch { clearTimeout(timer); finish(null); }
    });
}

// The persona for the same-weights fallback teacher: the ONE thing a fresh
// context buys is freedom from the run's own assumptions, so the framing
// leans on exactly that. "If all we've got is our 27b, we strap a new persona
// on that 27b and let her rip." (operator, 2026-08-25)
export const SELF_TEACHER_PERSONA = [
  "You are the TEACHER: a senior engineer called in with completely fresh eyes.",
  "You did NOT write this code and you must distrust every assumption its author made —",
  "especially the ones that feel obviously true. Reason from the bytes shown, not from",
  "what the code was probably meant to do.",
].join("\n");

// A bridge-backed teacher: POST the prompt to an OpenAI-style chat endpoint
// (the codexapi bridge, or anything shaped like it). Any error, timeout, or
// empty reply resolves to null — silence, never a false steer.
export function makeBridgeTeacher(model, { url, key = "", timeoutMs = 120000 } = {}) {
  return async (prompt, { signal } = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    try {
      const res = await fetch(`${String(url).replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, chat_preamble: false, messages: [
          { role: "system", content: "You are a precise debugging teacher. State the root cause and the exact fix, tersely." },
          { role: "user", content: prompt },
        ] }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
      return text || null;
    } catch { return null; }
    finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
  };
}

// Resolve a teacher from the environment. OFF unless BANTAM_TEACHER=1. Ladder:
// BANTAM_TEACHER_CMD (explicit shell command, stdin prompt -> stdout cause) >
// BANTAM_TEACHER_MODEL ("self"/"local" for the same-weights persona, or a
// bridge model slug) > the default Fable 5 CLI. Returns { kind, invoke, source }
// or null; kind "self" carries invoke:null — the agent builds the persona call
// on its own model, and ALSO uses it as the fallback when an external teacher
// goes dead.
export function teacherFromEnv(env = process.env) {
  if (env.BANTAM_TEACHER !== "1") return null;
  const timeoutMs = Number(env.BANTAM_TEACHER_TIMEOUT_MS) > 0 ? Number(env.BANTAM_TEACHER_TIMEOUT_MS) : 120000;
  const cmd = env.BANTAM_TEACHER_CMD && env.BANTAM_TEACHER_CMD.trim();
  if (cmd) return { kind: "cli", invoke: makeCliTeacher(cmd, { timeoutMs }), source: cmd };
  const modelSlug = env.BANTAM_TEACHER_MODEL && env.BANTAM_TEACHER_MODEL.trim();
  if (modelSlug) {
    if (/^(self|local)$/i.test(modelSlug)) return { kind: "self", invoke: null, source: "self-persona (same weights, fresh context)" };
    const url = env.BANTAM_TEACHER_URL || env.CODEXAPI_URL || "http://127.0.0.1:8787";
    const key = env.BANTAM_TEACHER_KEY || env.CODEXAPI_KEY || "";
    return { kind: "bridge", invoke: makeBridgeTeacher(modelSlug, { url, key, timeoutMs }), source: `bridge:${modelSlug} @ ${url}` };
  }
  const fallbackCmd = "claude -p --model claude-fable-5 --output-format text --disallowedTools Bash Read Edit Write Glob Grep WebSearch WebFetch";
  return { kind: "cli", invoke: makeCliTeacher(fallbackCmd, { timeoutMs }), source: fallbackCmd };
}

// When is a test STUCK enough to warrant the teacher? The original clock
// counted verification observations (failStreak >= teacherAfter) — and card
// 7R showed a probe-heavy run performing only 3 suite runs in 111 turns, so
// the streak never crossed and the teacher stayed dark through a 100-turn
// grind. Stuckness now also accrues by TURNS: still red, and first seen red
// at least `stuckTurns` turns ago.
export function teacherDue({ streak = 0, teacherAfter = 5, firstRedTurn = null, turnIndex = 0, stuckTurns = 24 } = {}) {
  if (streak >= teacherAfter) return true;
  return Number.isInteger(firstRedTurn) && turnIndex - firstRedTurn >= stuckTurns;
}

// Ask the teacher for a cause. `invoke(prompt, {signal}) -> Promise<string|null>` is injected
// so any transport (CLI, local model, API) plugs in and tests mock it. Never throws.
export async function askTeacher({ testName, testSource, implSource, diff, task = "", testProvenance = "unknown", invoke, fallback = null, signal }) {
  if (typeof invoke !== "function" && typeof fallback !== "function") return null;
  const prompt = buildTeacherPrompt({ testName, testSource, implSource, diff, task, testProvenance });
  for (const teach of [invoke, fallback]) {
    if (typeof teach !== "function") continue;
    let raw;
    try { raw = await teach(prompt, { signal }); } catch { continue; }
    const cause = parseTeacherCause(raw);
    if (cause) return cause;
  }
  return null;
}
