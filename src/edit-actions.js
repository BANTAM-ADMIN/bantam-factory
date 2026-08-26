// Shared edit semantics for agent state, guards, grounding, and evidence.

export const EDIT_ACTIONS = new Set(["write_file", "write_batch", "replace", "edit_lines", "patch", "delete_file", "move_file"]);

export function isEditAction(action) {
  return EDIT_ACTIONS.has(action?.a);
}

export function editPaths(action) {
  if (!isEditAction(action)) return [];
  if (action.a === "patch") {
    return [...new Set((action.edits ?? []).map((edit) => edit?.p).filter(Boolean))];
  }
  if (action.a === "write_batch") {
    return [...new Set((action.files ?? []).map((file) => file?.p).filter(Boolean))];
  }
  if (action.a === "move_file") return [...new Set([action.from, action.to].filter(Boolean))];
  return action.p ? [action.p] : [];
}

export function editSucceeded(action, observation) {
  // Harness/gate refusals are bracket-tagged and never reached the executor.
  // Treating them as edits poisons resume state and the EAVT log with changes
  // that did not happen. Successful executor observations are explicit prose
  // (`wrote`, `replaced`, `patched`, `deleted`, `moved`) and never begin `[`.
  return isEditAction(action) && !/^(?:ERROR:|NO_CHANGE:|\[)/.test(String(observation ?? ""));
}

/** Exact turn-level mutation provenance, with a conservative legacy fallback. */
export function turnEditApplied(turn) {
  const action = turn?.action ?? turn?.parsedAction;
  if (!isEditAction(action)) return false;
  if (typeof turn?.editApplied === "boolean") return turn.editApplied;
  return editSucceeded(action, turn?.observation);
}

export function editMadeNoChange(action, observation) {
  return isEditAction(action) && /^NO_CHANGE:/.test(String(observation ?? ""));
}

// Source extensions the build-gate cares about: code that has to be compiled/run
// before you can know it works.
const SOURCE_EXT = /\.(?:c|cc|cpp|cxx|h|hpp|py|js|mjs|cjs|ts|tsx|go|rs|java|rb|lua|php|sh)$/i;

export function isSourcePath(p) {
  return SOURCE_EXT.test(String(p ?? ""));
}

// A shell command that WRITES a source file — a redirect/append/tee/heredoc/sed-i/
// dd to a *.c-style path — is a code edit performed through the shell instead of
// the write_file action. The build-gate must count it, or a model that rewrites
// via `rm -f f.c; cat > f.c << EOF ... EOF` slips past the gate entirely: only
// edit ACTIONS were counted, so shell heredocs neither incremented nor tripped it
// (TB2 gpt2-codegolf audit 2026-08-20: 24 heredoc rewrites, 0 compiles, gate
// silent). This makes "edited without building" mechanism-independent.
const SRC = "c|cc|cpp|cxx|h|hpp|py|js|mjs|cjs|ts|tsx|go|rs|java|rb|lua|php|sh";
const SHELL_WRITE_RES = [
  // redirect / append / tee to a source path: `> f.c`, `>> f.c`, `cat > f.c`, `tee f.c`
  new RegExp(String.raw`(?:>>?|(?:^|\s)tee\b(?:\s+-a)?)\s*'?"?\S*\.(?:${SRC})\b`, "i"),
  // in-place stream edit of a source path
  new RegExp(String.raw`\bsed\s+-i\b[^\n]*\.(?:${SRC})\b`, "i"),
  // dd of= a source path
  new RegExp(String.raw`\bdd\b[^\n]*\bof=\s*\S*\.(?:${SRC})\b`, "i"),
];

export function shellWritesSourceFile(command) {
  const cmd = String(command ?? "");
  return SHELL_WRITE_RES.some((re) => re.test(cmd));
}
