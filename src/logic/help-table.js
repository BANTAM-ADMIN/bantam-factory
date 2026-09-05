// help-table.js — a two-column command table that stays aligned and never
// wraps at column 0.
//
// `:help` padded every command to a fixed 20 columns. Any command longer than
// that (`:context [rebuild|immutable|extension]` is 39) got two spaces, so the
// description column jumped around the screen; and descriptions were painted
// before anyone measured them, so on an 80-column terminal they folded back to
// column 0 under the command. Pure over plain strings: measure and lay out
// here, paint in the caller.

/** Greedy word wrap of PLAIN text. A word longer than `width` stands alone. */
export function wrapWords(text, width) {
  const w = Math.max(8, Math.floor(width));
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += " " + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Lay out rows of { cmd, desc } (plain strings).
 *
 *   cols    terminal width
 *   indent  left margin of the table
 *   gap     spaces between the longest fitting command and the description
 *   cap     commands longer than this go on their own line, description below —
 *           one 39-character command must not push every description to the edge
 *
 * Returns { column, lines } where `column` is the description offset relative to
 * the indent and each line is { cmd, desc } with cmd "" on continuation lines.
 * The caller paints and pads: every description starts at exactly `column`.
 */
export function layoutHelpRows(rows, { cols = 100, indent = 4, gap = 2, cap = 24 } = {}) {
  const width = Number.isFinite(cols) && cols > 0 ? cols : 100;
  const fitting = rows.map((r) => r.cmd.length).filter((n) => n <= cap);
  const column = (fitting.length ? Math.max(...fitting) : 0) + gap;
  const descWidth = Math.max(16, width - indent - column);
  const lines = [];
  for (const { cmd, desc } of rows) {
    const wrapped = wrapWords(desc, descWidth);
    if (cmd.length > cap) {
      lines.push({ cmd, desc: "" });
      for (const l of wrapped) lines.push({ cmd: "", desc: l });
    } else {
      lines.push({ cmd, desc: wrapped[0] ?? "" });
      for (const l of wrapped.slice(1)) lines.push({ cmd: "", desc: l });
    }
  }
  return { column, lines };
}

/** Render laid-out lines with painters. `paintCmd` / `paintDesc` wrap text in
 *  colour AFTER padding is computed from the plain lengths. */
export function renderHelpRows(rows, { cols, indent = 4, gap, cap, paintCmd = (s) => s, paintDesc = (s) => s } = {}) {
  const { column, lines } = layoutHelpRows(rows, { cols, indent, gap, cap });
  const pad = " ".repeat(indent);
  return lines.map(({ cmd, desc }) => {
    const fill = " ".repeat(Math.max(0, column - cmd.length));
    return pad + (cmd ? paintCmd(cmd) : "") + fill + (desc ? paintDesc(desc) : "");
  });
}

/** A bulleted line wrapped with a hanging indent under the bullet. */
export function renderBullet(text, { cols = 100, indent = 4, bullet = "· ", paint = (s) => s } = {}) {
  const width = Number.isFinite(cols) && cols > 0 ? cols : 100;
  const lines = wrapWords(text, Math.max(16, width - indent - bullet.length));
  const pad = " ".repeat(indent);
  return lines.map((l, i) => pad + (i === 0 ? bullet : " ".repeat(bullet.length)) + paint(l));
}
