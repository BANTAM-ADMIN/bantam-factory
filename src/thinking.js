// Optional thinking mode.
//
// Most turns ride the fast no-think rail: the model emits one grammar-constrained
// JSON action directly. But at genuine problem-solving moments a ~27B model is far
// stronger when it can reason first. Thinking mode does two-phase generation:
//
//   Phase 1 (reason): prompt ends with an OPEN <think> block, NO grammar, stop at
//                     </think> — the model reasons freely.
//   Phase 2 (act):    the reasoning is sealed into a closed <think>…</think> block
//                     and the grammar-constrained action is generated as usual.
//
// The action is still structurally guaranteed valid; the reasoning just informs it.
// Thinking is spent only when it earns its latency (see shouldThink).

const DEFAULT_THINK_MARKERS = Object.freeze({ open: "<think>\n", close: "</think>" });

// Derive the open/close think prefills from a profile's assistant prefill.
// The marker pair comes from the profile's template, so a family whose
// reasoning channel is spelled differently rides the same rail:
//   qwen  prefill: "<|im_start|>assistant\n<think>\n</think>\n\n"
//   gemma prefill: "<|turn>model\n<|channel>thought\n<channel|>"
// Both are an empty CLOSED reasoning block; splitting on the pair yields the
// open form (phase 1) and a sealer for the reasoning text (phase 2).
export function deriveThinkPrefills(assistantPrefill = "", markers = DEFAULT_THINK_MARKERS) {
  const openMarker = markers?.open ?? DEFAULT_THINK_MARKERS.open;
  const closeMarker = markers?.close ?? DEFAULT_THINK_MARKERS.close;
  const openIdx = assistantPrefill.indexOf(openMarker);
  const closeIdx = assistantPrefill.indexOf(closeMarker);
  if (openIdx === -1 || closeIdx === -1) {
    return { canThink: false, openThink: null, closeThink: null, stop: [], cleanReasoning: (r) => r };
  }
  const openThink = assistantPrefill.slice(0, openIdx + openMarker.length);  // "…<think>\n"
  const tail = assistantPrefill.slice(closeIdx);                             // "</think>\n\n"
  return {
    canThink: true,
    openThink,
    closeThink: (reasoning) => `${openThink}${String(reasoning).trim()}\n${tail}`,
    // Phase 1 runs ungrammared, so it needs an explicit stop at the reasoning
    // terminator. Callers add the turn terminator too, in case the model closes
    // the whole turn instead of just the channel.
    stop: [closeMarker],
    // Defensive: phase 1 hands the model an already-open block, but if it ever
    // re-emits the opener that echo must not get sealed into the closed block.
    cleanReasoning: (reasoning) => {
      const text = String(reasoning ?? "");
      const trimmed = text.trimStart();
      return (trimmed.startsWith(openMarker) ? trimmed.slice(openMarker.length) : text).trim();
    },
  };
}

/**
 * Keep the two-phase action request focused without discarding the full private
 * reasoning from the run artifact. The head retains the plan and the tail keeps
 * the final decision; repetitive middle simulation is the least authoritative
 * portion and the largest avoidable action-prompt/cache-miss payload.
 */
export function compactActionReasoning(reasoning, maxChars = 0) {
  const text = String(reasoning ?? "").trim();
  const limit = Number(maxChars);
  if (!Number.isInteger(limit) || limit < 200 || text.length <= limit) return text;
  const marker = `\n...[decision capsule omitted ${text.length - limit} reasoning chars]...\n`;
  const available = Math.max(1, limit - marker.length);
  const head = Math.max(1, Math.floor(available * 0.35));
  const tail = Math.max(1, available - head);
  // Prefer a semantic boundary for the tail. Keeping the start of the last
  // paragraph preserves labels such as "Decision"/"Next action" that would be
  // severed by a blind character slice.
  const rawTailStart = Math.max(head, text.length - tail);
  const paragraphStart = text.lastIndexOf("\n", rawTailStart);
  const tailStart = paragraphStart >= head ? paragraphStart + 1 : rawTailStart;
  let tailText = text.slice(tailStart).trimStart();
  if (tailText.length > tail) {
    const label = /^([^\n:]{1,80}:)/.exec(tailText)?.[1] ?? "";
    const separator = label ? "..." : "";
    tailText = `${label}${separator}${tailText.slice(-(tail - label.length - separator.length))}`;
  }
  return `${text.slice(0, head).trimEnd()}${marker}${tailText}`;
}

// Signals that the last observation was a failure worth reasoning about.
const FAILURE_RE = /(^|\n)\s*(ERROR|Traceback|FAIL|AssertionError)|escapes workspace|refusing to write|exit [1-9]/i;
const COMPLETION_AUDIT_RE = /\[completion-audit\]/;
// A whole-document read puts the exact assignment beside the current draft.
// That is the document equivalent of a green-suite phase boundary: reason
// about any remaining semantic mismatch before editing or declaring done.
const DOCUMENT_REVIEW_RE = /Document review context:/;
// The harness just corrected the model's move (redirected a read, masked a
// verb, reverted an edit, rewrote a command). A correction means the plan was
// wrong, not just the action — reason before the next one instead of firing
// off the next reflex.
const STEER_RE = /\[(open_files|paging|reverted|pipe-guard|api-check|regression-guard|repetition|test-runner)\]/;
// A phase boundary: the suite just came back green. This is where a multi-part
// task turns to its NEXT obligation — the moment the self-hosting runs sailed
// past, finishing code and never starting the docs.
const GREEN_RE = /^#\s*fail\s+0\s*$/m;

/**
 * Decide whether to spend a thinking phase on this attempt.
 * @param {"off"|"auto"|"always"} mode
 * @param {{turnIndex:number, lastObservation:?string, lastWasInvalid:boolean, preEditSynthesis?:boolean}} ctx
 */
export function shouldThink(mode, ctx = {}) {
  if (mode === "always") return true;
  if (mode !== "auto") return false;
  // LEAN gate (BANTAM_THINK_LEAN=1): fire only on problem-solving moments that carry a signal the
  // reasoning is needed — a repair, a harness correction, an audit, or a failed/erroring action.
  // A measured 8-task spread (2026-07-20) showed the turn-0 and clean-green thinks — the two that
  // fire on well-specified tasks that never go wrong — cost 35% of output and 27% of wall time for
  // ZERO correctness change (identical 7/8, same task failed). Dropping them keeps reasoning exactly
  // where hard-tier repair loops need it while making a clean run think-free. Guarded so the default
  // auto behavior is unchanged until the wider A/B clears.
  // Two dial settings, both measured (2026-07-20, easy + hard spreads):
  //   lean  — drop BOTH turn-0 and clean-green think. Free on well-specified tasks (-37% output, same
  //           correctness) but cost a PLANNING task on the hard spread (plan-cache 6/6 -> 5/6): turn-0
  //           reasoning is load-bearing where the opening move must be planned.
  //   trim  — keep the turn-0 plan, drop only the clean-green "what's next after tests pass" think
  //           (which fires repeatedly on near-done easy runs and is the wasteful one). The safe middle.
  const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
  const env = ctx.env ?? process.env;
  const lean = typeof ctx.lean === "boolean" ? ctx.lean : flag(env.BANTAM_THINK_LEAN);
  const trim = typeof ctx.trim === "boolean" ? ctx.trim : flag(env.BANTAM_THINK_TRIM);
  if (ctx.lastWasInvalid) return true;                  // a repair attempt — reason about the miss
  if (ctx.preEditSynthesis) return true;                // source is now present; synthesize before first mutation
  if (ctx.lastObservation && COMPLETION_AUDIT_RE.test(ctx.lastObservation)) return true;
  if (ctx.lastObservation && DOCUMENT_REVIEW_RE.test(ctx.lastObservation)) return true;
  if (ctx.lastObservation && FAILURE_RE.test(ctx.lastObservation)) return true; // an action failed/erred
  if (ctx.lastObservation && STEER_RE.test(ctx.lastObservation)) return true;   // the harness corrected the plan
  if (lean) return false;                               // lean: no turn-0, no clean-green think
  if (ctx.turnIndex === 0) return true;                 // plan the opening move (trim keeps this)
  if (trim) return false;                               // trim stops here: turn-0 yes, clean-green no
  if (ctx.lastObservation && GREEN_RE.test(ctx.lastObservation)) return true;   // phase boundary: what is the next obligation?
  return false;
}

export const THINK_MODES = new Set(["off", "auto", "always"]);
export function normalizeThinkMode(m) {
  const v = String(m ?? "off").toLowerCase();
  return THINK_MODES.has(v) ? v : "off";
}
