// The commit-to-deliverable gauge — a jig against exploration that never lands.
//
// TB2 gpt2-codegolf, 2026-08-20: once the prefix-cache fix removed the speed
// throttle, a run took 227 fast actions compiling-and-rerunning a throwaway
// `inspect.c` probe and NEVER created `/app/gpt2.c`, the file the task asks for.
// Investigation is only worth anything if it becomes the solution; a run that
// ends with probes and no deliverable scores zero. The cache fix did not cause
// this — it revealed it, because the old slowness masked everything past ~90
// actions.
//
// The trigger is domain-blind: the task text NAMES its deliverable ("Call your
// program /app/gpt2.c"), and filtering to SOURCE-CODE extensions naturally
// excludes the input data files the task also names (.ckpt, .bpe, .csv) — so we
// never nudge the model to re-create an input. If no named deliverable exists in
// the workspace after N actions, steer it to stop probing and write the real
// thing.

const DELIVERABLE_EXT = "c|cc|cpp|cxx|h|hpp|py|js|mjs|cjs|ts|tsx|go|rs|java|rb|sh|lua|php";
// A path token with a source extension, optionally absolute or ./-relative.
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'` + "`" + String.raw`(=])((?:\/|\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:${DELIVERABLE_EXT}))\b`,
  "gi",
);

/**
 * Source-code file paths the task text names — the "write me a program X"
 * deliverable(s). Data/input files (.ckpt, .bpe, .txt, .csv…) lack a code
 * extension and are excluded by construction.
 */
export function namedDeliverables(taskText) {
  const text = String(taskText ?? "");
  const out = new Set();
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) out.add(m[1]);
  return [...out];
}

export const DELIVERABLE_STALL_DEFAULTS = Object.freeze({
  // Legitimate runs write the deliverable early (gpt2 baseline: by ~action 35).
  // An over-explorer is still probing well past that. Nudge, then re-nudge every
  // `after` actions while still stalled — one reminder is easy to ignore.
  after: 40,
});

/** Fresh per-run state. */
export function createDeliverableState() {
  return { lastSteerAtTurn: -1 };
}

/**
 * Decide whether to steer. `exists(path)` must report whether a named deliverable
 * is present in the workspace (absolute paths as-is, relative resolved against
 * the workspace by the caller). Returns { steer:boolean, target?, message? }.
 *
 * Edge-friendly: fires the first time the stall threshold is crossed, then again
 * every `after` turns while still stalled, and goes quiet the moment any named
 * deliverable exists.
 */
export function assessDeliverable(turnCount, deliverables, exists, state, opts = {}) {
  const cfg = { ...DELIVERABLE_STALL_DEFAULTS, ...opts };
  if (!Array.isArray(deliverables) || deliverables.length === 0) return { steer: false };
  if (turnCount < cfg.after) return { steer: false };
  // Already produced (or started) a deliverable → nothing to nag about.
  if (deliverables.some((p) => { try { return exists(p); } catch { return false; } })) {
    return { steer: false };
  }
  // Stalled. Re-nudge at most once per `after` turns.
  if (turnCount - state.lastSteerAtTurn < cfg.after) return { steer: false };
  state.lastSteerAtTurn = turnCount;
  const target = deliverables[0];
  const list = deliverables.length > 1 ? `${target} (or ${deliverables.slice(1).join(", ")})` : target;
  return {
    steer: true,
    target,
    message:
      `\n\n[deliverable] ${turnCount} actions in and ${list} — the file this task asks you to produce — `
      + `does not exist yet. Investigation only counts if it becomes the solution; a run that ends with `
      + `probes and no ${target} scores ZERO. STOP inspecting now and WRITE ${target}: commit your current `
      + `understanding to a first end-to-end version of the ACTUAL deliverable, compile/run it against the real `
      + `inputs, and iterate on that file. A rough ${target} that runs beats a perfect understanding you never wrote down.`,
  };
}
