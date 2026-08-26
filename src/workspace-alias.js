// Canonicalize one conventional model-facing workspace root without weakening
// the executor's lexical or realpath containment checks.

const WORKSPACE_ALIAS = "/workspace";
const LEADING_CD = /^\s*cd\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;&|]+))\s*&&\s*/;

export function normalizeWorkspaceAction(action) {
  if (!action || typeof action !== "object") return action;

  if (action.a === "inspect" && Array.isArray(action.ops)) {
    const ops = action.ops.map(normalizeWorkspaceAction);
    return ops.some((op, i) => op !== action.ops[i]) ? { ...action, ops } : action;
  }

  if (action.a === "patch" && Array.isArray(action.edits)) {
    const edits = action.edits.map((edit) => {
      const p = normalizeWorkspacePath(edit.p);
      return p === edit.p ? edit : { ...edit, p };
    });
    return edits.some((edit, i) => edit !== action.edits[i]) ? { ...action, edits } : action;
  }

  if (action.a === "write_batch" && Array.isArray(action.files)) {
    const files = action.files.map((file) => {
      const p = normalizeWorkspacePath(file.p);
      return p === file.p ? file : { ...file, p };
    });
    return files.some((file, i) => file !== action.files[i]) ? { ...action, files } : action;
  }

  if (["read_file", "list_dir", "search", "replace", "write_file", "delete_file"].includes(action.a)) {
    const p = normalizeWorkspacePath(action.p);
    return p !== action.p ? { ...action, p } : action;
  }

  if (action.a === "move_file") {
    const from = normalizeWorkspacePath(action.from);
    const to = normalizeWorkspacePath(action.to);
    return from !== action.from || to !== action.to ? { ...action, from, to } : action;
  }

  if (action.a === "shell") {
    const c = normalizeLeadingWorkspaceCd(action.c);
    return c !== action.c ? { ...action, c } : action;
  }

  return action;
}

export function normalizeWorkspacePath(value) {
  if (typeof value !== "string") return value;
  if (value === WORKSPACE_ALIAS || value === `${WORKSPACE_ALIAS}/`) return ".";
  if (value.startsWith(`${WORKSPACE_ALIAS}/`)) return value.slice(WORKSPACE_ALIAS.length + 1);
  return value;
}

export function normalizeLeadingWorkspaceCd(command) {
  if (typeof command !== "string") return command;
  const match = LEADING_CD.exec(command);
  if (!match) return command;

  const target = match[1] ?? match[2] ?? match[3];
  if (typeof target !== "string" || /[$`\r\n]/.test(target)) return command;
  const relative = normalizeWorkspacePath(target);
  if (relative === target || relative.startsWith("/")) return command;

  const tail = command.slice(match[0].length);
  if (!tail.trim()) return command;
  if (relative === ".") return tail;
  return `cd ${shellQuote(relative)} && ${tail}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
