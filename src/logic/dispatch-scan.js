// dispatch-scan.js — where does a CLI entrypoint dispatch its commands, and at
// which line does each branch start? Shared by the code KB's `flow` verb and
// the KB-backed `map arch`, so both name the same branches at the same lines.

const DISPATCH = /\b(?:cmd|command|argv\[2\]|subcommand|action)\b[^\n]{0,40}?===?\s*["'`]([\w:-]+)["'`]|^\s*case\s+["'`]([\w:-]+)["'`]\s*:/;

/** @returns {{ name: string, line: number }[]} in source order */
export function dispatchBranches(source) {
  const branches = [];
  const lines = String(source ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = DISPATCH.exec(lines[i]);
    if (m) branches.push({ name: m[1] ?? m[2], line: i + 1 });
  }
  return branches;
}

/** One line: `<file> dispatches N command(s): a (L12), b (L40), … +k more.` */
export function formatDispatch(file, branches, { max = 40 } = {}) {
  const shown = branches.slice(0, max).map((b) => `${b.name} (L${b.line})`).join(", ");
  const more = branches.length > max ? `, … +${branches.length - max} more` : "";
  return `${file} dispatches ${branches.length} command(s): ${shown}${more}.`;
}
