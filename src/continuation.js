// Session continuity — redesigned per the operator (2026-08-17): "I shouldn't
// have to say 'keep going' to have all that held... maybe even anticipating
// what I might want next. I don't want this locked to the literal words."
//
// So: the THREAD IS ALWAYS PRESENT. Every request in a session carries the
// recent asks and the agent's own last report in full useful length — the
// model decides relevance, because that is what models are for. Affirmation
// detection survives only to disambiguate bare consent ("yes", "sure", an
// empty Enter) into "do the next thing", never to gate memory.
//
// Mined grounding (benches/collab, 21GB of real sessions): 23% of user turns
// are continuation-shaped, and the specimen session is one ask plus fifteen
// continuations. Praise follows demonstrations and momentum.

// Bare consent: short, and contentless apart from agreement. "ok, open the
// server up so I can test it here" is a NEW instruction (corpus-verbatim);
// "keep going" is intransitive so trailing commentary rides along; "continue"
// takes an object, so bare "continue" consents and "continue <object>" asks.
const MAX_AFFIRMATION_LENGTH = 80;

export function isAffirmation(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;                       // an empty Enter is the minimal yes
  if (t.length > MAX_AFFIRMATION_LENGTH) return false;
  if (/^(keep going|carry on)[\s,.!]/i.test(t)) return true;
  if (/^continue(?:[,.!]|\s*$)/i.test(t)) return true;
  if (/^(keep going|go ahead|proceed|next|more|do it|keep at it|yes|yeah|yep|sure|ok(ay)?|please do|sounds good)[\s,.!]*$/i.test(t)) return true;
  return /^(yes|yeah|yep|sure|ok(ay)?)[\s,.!]+/i.test(t)
    && /(keep going|continue|proceed|go ahead|carry on|keep at it|do it|please)/i.test(t);
}

// Back-compat alias (tests and callers from the first iteration).
export const isContinuationRequest = isAffirmation;

/**
 * The agent's own proposal for what comes next, pulled from its last report.
 * Models are prompted (chat mode) to end summaries with a "Next:" line when a
 * continuation is obvious; absence means it saw nothing obvious — honest.
 */
export function extractNextStep(summary) {
  const text = String(summary ?? "");
  const m = text.match(/(?:^|\n)\s*(?:next(?: steps?| up)?)\s*[:\-–]\s*(.+?)(?:\n|$)/i);
  if (!m) return null;
  const step = m[1].trim().replace(/\s+/g, " ");
  if (step.length <= 4) return null;
  // The honest stop is not a proposal: "Next: nothing pressing — this is a
  // good stopping point" must not become a pressable Enter action.
  if (/^(nothing pressing|nothing obvious|none|no next|stop here|good stopping point)/i.test(step)) return null;
  return step.slice(0, 240);
}

/**
 * Build every session request's task text. The thread is unconditional; only
 * the FRAMING differs: bare consent becomes an explicit continue instruction,
 * anything else is presented as the new request it is.
 */
export function buildSessionTask({ request, sessionLog = [] }) {
  const req = String(request ?? "").trim();
  if (!sessionLog.length) return req;
  const recent = sessionLog.slice(-6)
    .map((s) => `- you asked: "${s.request}" → I: ${s.summary}`).join("\n");
  const last = sessionLog[sessionLog.length - 1];
  const lastReport = last.fullSummary ?? last.summary ?? "";
  const parts = [
    `Session so far (context only; the workspace already reflects this work):\n${recent}`,
    lastReport ? `Your last report, in full:\n${lastReport}` : "",
  ];
  if (isAffirmation(req)) {
    parts.push(
      `The user said: "${req || "(pressed Enter)"}" — that is consent to CONTINUE your own previous work, not a new task.`
      + ` Pick up exactly where you left off; if your last report proposed a next step, do that. Do not re-explore or re-do what is already done.`,
    );
  } else {
    parts.push(`New request: ${req}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

// Kept for compatibility with the first iteration's API; delegates to the
// uniform builder so there is exactly one composition path.
export function buildContinuationTask({ request, lastRequest, lastReport, sessionContext }) {
  return buildSessionTask({
    request,
    sessionLog: [{ request: lastRequest ?? "", summary: lastReport ?? "", fullSummary: lastReport ?? "" }],
  });
}

// The operator's status-check, mined from 100+ real sessions: "how's it
// coming" (59), "how's it going" (49), "alright how's it" (37). Typed mid-run
// it used to queue as a steer — costing a model turn to answer late. The
// harness knows the elapsed time, the current activity and the last action;
// a status question deserves an instant answer that costs nothing.
export function isStatusQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 60) return false;
  return /^(how'?s it (coming|going)( along)?|hows it (coming|going)|status|progress|where are (we|you)( at)?|what'?s happening|you (ok|okay|still there|still going)|still (working|going|alive))[\s?!.]*$/i.test(t);
}
