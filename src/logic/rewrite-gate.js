// rewrite-gate.js — a severed plan does not license starting the file over.
//
// The advisory form of this was measured and found wanting. On write-compressor
// (2026-08-22, local) the [reasoning-budget] note was in 29 of 36 prompts and
// the model still issued full write_file rewrites of the one file it was
// editing — 5 rewrites against 5 replaces, with the failing function NAMED in
// the traceback it had just read. The 2026-07-30 poka-yoke table already
// records the general finding: the advisory form of a fact fires and is
// ignored; the gate form is acted on. This is the gate form.
//
// Deliberately narrow. It fires only when ALL of these hold:
//   - the reasoning that produced this action was severed at the budget
//   - the action is a full write_file
//   - the target already exists AND is rendered in <open_files> (so a surgical
//     replace is actually possible — refusing a rewrite with no panel to edit
//     against would strand the model)
//   - this is the FIRST such refusal for this path (a second identical rewrite
//     after the refusal is the model's considered choice; let it through)
// A new file, a file not in the panel, or an un-severed thought all pass.
// The refusal does NOT tell the model that re-issuing will be accepted: the
// first live sighting (write-compressor 2026-08-23, t25) showed the model
// re-issue the identical rewrite on the very next turn when told it could.
// The second identical rewrite still passes -- it is the model's considered
// choice -- but it is not invited.

export function rewriteGate({
  action,
  thinkSevered = false,
  panelPaths = new Set(),
  refusedOnce = new Set(),
  fileExists = () => false,
} = {}) {
  if (!thinkSevered) return null;
  if (action?.a !== "write_file") return null;
  const p = String(action.p ?? "");
  if (!p) return null;
  if (!panelPaths.has(p)) return null;
  if (!fileExists(p)) return null;
  if (refusedOnce.has(p)) return null;
  return {
    path: p,
    text: `[rejected] Not written. Your reasoning was cut off at its budget before it reached`
      + ` a conclusion, and a full rewrite of ${p} is the one move an unfinished plan must not`
      + ` license — it is how the last three attempts each threw away a working matcher to`
      + ` re-derive it. ${p} is in <open_files> right now, with line numbers. Make ONE surgical`
      + ` change with "replace": target the function the last error named, match "old" to the`
      + ` exact current text above, and run the verify command.`,
  };
}
