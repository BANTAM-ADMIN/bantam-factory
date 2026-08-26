// Function-level outline of a JS file — the map for territory the open-files
// panel can't show. When an edited file overflows the panel's line cap, the
// tail used to collapse to "(N more lines)"; on a large file that turns every
// wiring question into another read_file page-through. The outline names the
// symbols and their line ranges instead, so the model can jump straight to
// the seam it needs.

import * as acorn from "acorn";

const MAX_ITEMS = 40;

// Best-effort: a file mid-edit is often unparseable; return null rather than
// throw so callers can fall back to the plain truncation notice.
export function outlineJs(source, { maxItems = MAX_ITEMS } = {}) {
  let ast;
  const options = { ecmaVersion: "latest", locations: true, allowHashBang: true };
  try {
    ast = acorn.parse(source, { ...options, sourceType: "module" });
  } catch {
    try {
      ast = acorn.parse(source, { ...options, sourceType: "script" });
    } catch {
      return null;
    }
  }

  const items = [];
  const push = (kind, name, node) => {
    if (!name || !node?.loc) return;
    items.push({ kind, name, start: node.loc.start.line, end: node.loc.end.line });
  };

  for (const node of ast.body) {
    const target = node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration"
      ? node.declaration ?? node
      : node;
    if (!target) continue;
    if (target.type === "FunctionDeclaration") {
      push("fn", target.id?.name, node);
    } else if (target.type === "ClassDeclaration") {
      push("class", target.id?.name, node);
      for (const member of target.body?.body ?? []) {
        if (member.type === "MethodDefinition" && member.key?.name) {
          push("  method", member.key.name, member);
        }
      }
    } else if (target.type === "VariableDeclaration") {
      for (const decl of target.declarations) {
        const init = decl.init?.type;
        if (init === "ArrowFunctionExpression" || init === "FunctionExpression") {
          push("fn", decl.id?.name, node);
        } else if (decl.id?.name && /^[A-Z0-9_]+$/.test(decl.id.name)) {
          push("const", decl.id.name, node);
        }
      }
    }
  }
  return items.slice(0, maxItems);
}

// One-line-per-symbol rendering for the open-files panel tail.
export function formatOutline(items, { fromLine = 1 } = {}) {
  if (!items?.length) return null;
  const rest = items.filter((item) => item.end >= fromLine);
  if (!rest.length) return null;
  const lines = rest.map((item) => `${item.kind} ${item.name} (L${item.start}–${item.end})`);
  return `outline of the rest:\n${lines.join("\n")}`;
}
